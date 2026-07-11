// apps/server/src/budget/aggregates.ts
// Агрегаты Budget (Task A6, 03-budget §2, §3.1) — вычисления НА ЛЕТУ поверх графа:
// spent не хранится (§2.2, глобальное ограничение «никаких материализованных
// агрегатов»), суммы наборов считает SQL (::numeric — точный decimal PG), формулы
// §2.4 — decimal-строки без float (budget/decimal.ts). Потребители: tRPC-роутер
// budget (routers/budget.ts) и LLM/MCP-тул budget_status (tools/dispatch.ts).
//
// Конвейер overview (§2.8 «при первом открытии или финансовом запросе»):
// postDueInstances (переход planned→fact due-инстансов, A5) + materializeInstances
// [today; today+14] (A3) — ОБА исполняют executor в собственных tx, поэтому зовутся
// ДО withIdentity-tx агрегатов (вложение истощало бы пул соединений — тот же принцип,
// что recurring/with-materialization.ts).
import type {
  BudgetOverview,
  BudgetStatusResult,
  CategoryTrendPoint,
  EnvelopeStatus,
} from '@orbis/shared';
import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { entities, userSettings } from '../db/schema';
import { type Tx, withIdentity } from '../db/with-identity';
import { DEFAULT_TIMEZONE, isValidTimeZone } from '../query/context';
import { addDays, materializeInstances } from '../recurring/materialize';
import { postDueInstances } from '../recurring/post-due';
import { toWireEntity } from '../wire';
import { defaultCurrencyOf, selectEnvelope } from './binding';
import { decAdd, decCmp, decDivBy, decMulInt, decSub } from './decimal';

type EntityRow = typeof entities.$inferSelect;
type AspectsMap = Record<string, Record<string, unknown>>;

/** Горизонт Coming up и материализации — 14 дней (01-arch §5.4). */
const HORIZON_DAYS = 14;

// ---------------------------------------------------------------------------
// «Сегодня» пользователя — локальная дата в user_settings.timezone (03-budget §2.3;
// глобальное ограничение: финансовые формулы НЕ считают «сегодня» по UTC).
// ---------------------------------------------------------------------------

export async function localTodayTx(tx: Tx, ownerId: string): Promise<string> {
  const rows = await tx
    .select({ timezone: userSettings.timezone })
    .from(userSettings)
    .where(eq(userSettings.ownerId, ownerId));
  const stored = rows[0]?.timezone ?? DEFAULT_TIMEZONE;
  // мусорная зона из БД деградирует до дефолта, не роняя запрос (как queryContext)
  const timezone = isValidTimeZone(stored) ? stored : DEFAULT_TIMEZONE;
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date());
}

export async function localToday(db: Db, ownerId: string): Promise<string> {
  return withIdentity(db, ownerId, (tx) => localTodayTx(tx, ownerId));
}

// ---------------------------------------------------------------------------
// Календарные хелперы (строки ISO, лексикографическое сравнение = хронологическое)
// ---------------------------------------------------------------------------

function monthRange(month: string): { start: string; end: string } {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return {
    start: `${month}-01`,
    end: new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10),
  };
}

function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const total = y * 12 + (m - 1) + delta;
  const yy = String(Math.floor(total / 12)).padStart(4, '0');
  const mm = String((total % 12) + 1).padStart(2, '0');
  return `${yy}-${mm}`;
}

/** Дней от from до to включительно (§2.4: дни до конца периода); минимум 1. */
function daysInclusive(from: string, to: string): number {
  const [fy, fm, fd] = from.split('-').map(Number) as [number, number, number];
  const [ty, tm, td] = to.split('-').map(Number) as [number, number, number];
  const days = Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86400000) + 1;
  return Math.max(1, days);
}

// ---------------------------------------------------------------------------
// SQL-блоки агрегатов
// ---------------------------------------------------------------------------

/**
 * spent ВСЕХ конвертов набора одним запросом (§2.2, бриф A6 — без N+1): факт-расходы
 * (planned=false) детей по relation parent, occurred_on ≤ сегодня, валюта транзакции
 * (coalesce с defaultCurrency) = валюте СВОЕГО конверта (join env — конверты набора
 * могут быть в разных валютах; чужая валюта в spent не входит, §5).
 */
async function spentByEnvelope(
  tx: Tx,
  ownerId: string,
  envelopeIds: string[],
  today: string,
  defaultCurrency: string,
): Promise<Map<string, string>> {
  if (envelopeIds.length === 0) return new Map();
  const ids = sql.join(
    envelopeIds.map((id) => sql`${id}`),
    sql`, `,
  );
  const rows = (await tx.execute(sql`
    SELECT r.source_id AS envelope_id,
           coalesce(sum((e.aspects->'orbis/financial'->>'amount')::numeric), 0)::text AS spent
    FROM relations r
    JOIN entities env ON env.id = r.source_id
    JOIN entities e   ON e.id = r.target_id
    WHERE r.relation_type = 'parent'
      AND r.source_id IN (${ids})
      AND e.owner_id = ${ownerId} AND NOT e.archived
      AND e.aspects->'orbis/financial'->>'direction' = 'expense'
      AND coalesce((e.aspects->'orbis/financial'->>'planned')::boolean, false) = false
      AND (e.aspects->'orbis/financial'->>'occurred_on') <= ${today}
      AND coalesce(e.aspects->'orbis/financial'->>'currency', ${defaultCurrency})
          = coalesce(env.aspects->'orbis/budget'->>'currency', ${defaultCurrency})
    GROUP BY r.source_id
  `)) as unknown as Array<{ envelope_id: string; spent: string }>;
  return new Map(rows.map((r) => [r.envelope_id, r.spent]));
}

interface CategoryInfo {
  id: string;
  title: string;
  icon: string | null;
  color: string | null;
  spendClass: 'fixed' | 'discretionary' | null;
}

/** Карточки категорий по id (включая архивные — конверт переживает архивацию категории). */
async function categoriesById(tx: Tx, ids: string[]): Promise<Map<string, CategoryInfo>> {
  if (ids.length === 0) return new Map();
  const list = sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  );
  const rows = (await tx.execute(sql`
    SELECT id, title, aspects->'orbis/category' AS category FROM entities
    WHERE id IN (${list})
  `)) as unknown as Array<{ id: string; title: string; category: Record<string, unknown> | null }>;
  return new Map(
    rows.map((r) => {
      const c = r.category ?? {};
      return [
        r.id,
        {
          id: r.id,
          title: r.title,
          icon: typeof c.icon === 'string' ? c.icon : null,
          color: typeof c.color === 'string' ? c.color : null,
          spendClass:
            c.spend_class === 'fixed' || c.spend_class === 'discretionary' ? c.spend_class : null,
        },
      ];
    }),
  );
}

function categoryOr(map: Map<string, CategoryInfo>, id: string): CategoryInfo {
  return map.get(id) ?? { id, title: '', icon: null, color: null, spendClass: null };
}

/** Рёбра дерева категорий (§2.10): parent-связи между category-сущностями владельца. */
async function categoryEdges(tx: Tx, ownerId: string): Promise<Map<string, string[]>> {
  const rows = (await tx.execute(sql`
    SELECT r.source_id, r.target_id FROM relations r
    JOIN entities s ON s.id = r.source_id
    JOIN entities t ON t.id = r.target_id
    WHERE r.relation_type = 'parent'
      AND s.owner_id = ${ownerId}
      AND s.aspects ? 'orbis/category' AND t.aspects ? 'orbis/category'
  `)) as unknown as Array<{ source_id: string; target_id: string }>;
  const children = new Map<string, string[]>();
  for (const r of rows) {
    const list = children.get(r.source_id) ?? [];
    list.push(r.target_id);
    children.set(r.source_id, list);
  }
  return children;
}

/** Все потомки категории (рекурсивно, §2.10); visited-set страхует от циклов в данных. */
function descendantsOf(children: Map<string, string[]>, root: string): Set<string> {
  const out = new Set<string>();
  const stack = [...(children.get(root) ?? [])];
  while (stack.length > 0) {
    const id = stack.pop() as string;
    if (out.has(id)) continue;
    out.add(id);
    stack.push(...(children.get(id) ?? []));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Статус конверта (формулы §2.4, фазы §2.9)
// ---------------------------------------------------------------------------

interface RawEnvelope {
  row: EntityRow;
  budget: Record<string, unknown>;
  categoryRef: string;
  periodStart: string;
  periodEnd: string;
  currency: string; // coalesce(budget.currency, defaultCurrency) — валютная граница агрегатов (§5)
  spent: string; // сырой (без агрегации иерархии) — для alertCount §6.1
  effectiveLimit: string;
}

function rawEnvelopeOf(
  row: EntityRow,
  spentMap: Map<string, string>,
  defaultCurrency: string,
): RawEnvelope | null {
  const budget = (row.aspects as AspectsMap)['orbis/budget'];
  if (
    budget === undefined ||
    typeof budget.category_ref !== 'string' ||
    typeof budget.period_start !== 'string' ||
    typeof budget.period_end !== 'string' ||
    typeof budget.limit !== 'string'
  ) {
    return null; // структурно битый конверт не роняет Overview (валидность держит executor)
  }
  const carryover = typeof budget.carryover === 'string' ? budget.carryover : '0';
  return {
    row,
    budget,
    categoryRef: budget.category_ref,
    periodStart: budget.period_start,
    periodEnd: budget.period_end,
    currency: typeof budget.currency === 'string' ? budget.currency : defaultCurrency,
    spent: decAdd(spentMap.get(row.id) ?? '0', '0'), // нормализация к канону "0.00"
    effectiveLimit: decAdd(budget.limit, carryover),
  };
}

function phaseOf(raw: RawEnvelope, today: string): EnvelopeStatus['phase'] {
  if (today < raw.periodStart) return 'upcoming';
  if (today > raw.periodEnd) return 'closed';
  return 'active';
}

/**
 * Статус конверта из (возможно агрегированных §2.10) spent/effectiveLimit:
 * dailyPace — ТОЛЬКО в активной фазе и при remaining ≥ 0 (§2.4 «—/день», §2.9а/б).
 */
function statusOf(
  raw: RawEnvelope,
  category: CategoryInfo,
  spent: string,
  effectiveLimit: string,
  today: string,
): EnvelopeStatus {
  const remaining = decSub(effectiveLimit, spent);
  const phase = phaseOf(raw, today);
  const dailyPace =
    phase === 'active' && decCmp(remaining, '0') >= 0
      ? decDivBy(remaining, daysInclusive(today, raw.periodEnd))
      : null;
  return {
    envelope: toWireEntity(raw.row),
    category: {
      id: category.id,
      title: category.title,
      icon: category.icon,
      color: category.color,
    },
    spent,
    effectiveLimit,
    remaining,
    dailyPace,
    phase,
  };
}

/** Порог бейджа §6.1: spent > 85% × effectiveLimit ⇔ 20·spent > 17·effectiveLimit. */
function isAlert(spent: string, effectiveLimit: string): boolean {
  return decCmp(decMulInt(spent, 20), decMulInt(effectiveLimit, 17)) > 0;
}

// ---------------------------------------------------------------------------
// Overview (§3.1) — агрегаты одного withIdentity-tx
// ---------------------------------------------------------------------------

async function computeOverview(
  tx: Tx,
  ownerId: string,
  month: string,
  today: string,
): Promise<BudgetOverview> {
  const defCur = await defaultCurrencyOf(tx, ownerId);
  const { start, end } = monthRange(month);
  const horizon = addDays(today, HORIZON_DAYS);

  // Конверты, пересекающие месяц (месячные + произвольные §2.9)
  const envRows = await tx
    .select()
    .from(entities)
    .where(
      and(
        eq(entities.ownerId, ownerId),
        eq(entities.archived, false),
        sql`${entities.aspects}->'orbis/budget'->>'period_start' <= ${end}`,
        sql`${entities.aspects}->'orbis/budget'->>'period_end' >= ${start}`,
      ),
    );
  const spentMap = await spentByEnvelope(
    tx,
    ownerId,
    envRows.map((r) => r.id),
    today,
    defCur,
  );
  const raws = envRows
    .map((row) => rawEnvelopeOf(row, spentMap, defCur))
    .filter((r): r is RawEnvelope => r !== null);

  // Баланс периода (§2.5): факты в [start;end] и ≤ сегодня, валюта периода = дефолтная;
  // шаблоны recurring (orbis/schedule.recurrence) — не операции, исключены
  const balanceRows = (await tx.execute(sql`
    SELECT e.aspects->'orbis/financial'->>'direction' AS direction,
           coalesce(sum((e.aspects->'orbis/financial'->>'amount')::numeric), 0)::text AS total
    FROM entities e
    WHERE e.owner_id = ${ownerId} AND NOT e.archived
      AND e.aspects->'orbis/schedule'->'recurrence' IS NULL
      AND coalesce((e.aspects->'orbis/financial'->>'planned')::boolean, false) = false
      AND e.aspects->'orbis/financial'->>'occurred_on' >= ${start}
      AND e.aspects->'orbis/financial'->>'occurred_on' <= ${end}
      AND e.aspects->'orbis/financial'->>'occurred_on' <= ${today}
      AND coalesce(e.aspects->'orbis/financial'->>'currency', ${defCur}) = ${defCur}
    GROUP BY 1
  `)) as unknown as Array<{ direction: string; total: string }>;
  const income = decAdd(balanceRows.find((r) => r.direction === 'income')?.total ?? '0', '0');
  const expense = decAdd(balanceRows.find((r) => r.direction === 'expense')?.total ?? '0', '0');

  // Unbudgeted (§2.3 шаг 5, §3.1): фактические расходы периода БЕЗ budget-parent,
  // группировка по category_ref; чужая валюта в агрегат не входит (§5)
  const unbudgetedRows = (await tx.execute(sql`
    SELECT e.aspects->'orbis/financial'->>'category_ref' AS category_id,
           sum((e.aspects->'orbis/financial'->>'amount')::numeric)::text AS total
    FROM entities e
    WHERE e.owner_id = ${ownerId} AND NOT e.archived
      AND e.aspects->'orbis/schedule'->'recurrence' IS NULL
      AND e.aspects->'orbis/financial'->>'direction' = 'expense'
      AND coalesce((e.aspects->'orbis/financial'->>'planned')::boolean, false) = false
      AND e.aspects->'orbis/financial'->>'occurred_on' >= ${start}
      AND e.aspects->'orbis/financial'->>'occurred_on' <= ${end}
      AND e.aspects->'orbis/financial'->>'occurred_on' <= ${today}
      AND coalesce(e.aspects->'orbis/financial'->>'currency', ${defCur}) = ${defCur}
      AND NOT EXISTS (
        SELECT 1 FROM relations r
        JOIN entities p ON p.id = r.source_id
        WHERE r.target_id = e.id AND r.relation_type = 'parent'
          AND p.aspects ? 'orbis/budget' AND NOT p.archived
      )
    GROUP BY 1
    ORDER BY 1
  `)) as unknown as Array<{ category_id: string; total: string }>;

  // Coming up (§2.8): материализованные recurring-инстансы (derived_from — дискриминатор)
  // с planned=true на 14 дней; due-инстансы сегодняшнего дня уже переведены postDue
  const comingRows = await tx
    .select()
    .from(entities)
    .where(
      and(
        eq(entities.ownerId, ownerId),
        eq(entities.archived, false),
        sql`${entities.aspects}->'orbis/financial'->>'planned' = 'true'`,
        sql`${entities.aspects}->'orbis/financial'->>'occurred_on' >= ${today}`,
        sql`${entities.aspects}->'orbis/financial'->>'occurred_on' <= ${horizon}`,
        sql`EXISTS (SELECT 1 FROM relations r
                    WHERE r.target_id = ${entities.id} AND r.relation_type = 'derived_from')`,
      ),
    );

  // Planned (§2.7): ручные запланированные покупки — planned=true БЕЗ derived_from
  // (и не шаблоны); окном месяца не режутся — это список намерений, не агрегат периода
  const plannedRows = await tx
    .select()
    .from(entities)
    .where(
      and(
        eq(entities.ownerId, ownerId),
        eq(entities.archived, false),
        sql`${entities.aspects}->'orbis/financial'->>'planned' = 'true'`,
        sql`${entities.aspects}->'orbis/financial'->>'direction' = 'expense'`,
        sql`${entities.aspects}->'orbis/schedule'->'recurrence' IS NULL`,
        sql`NOT EXISTS (SELECT 1 FROM relations r
                        WHERE r.target_id = ${entities.id} AND r.relation_type = 'derived_from')`,
      ),
    );

  // Карточки категорий одним запросом: конверты + planned + unbudgeted
  const categoryIds = new Set<string>();
  for (const raw of raws) categoryIds.add(raw.categoryRef);
  for (const row of plannedRows) {
    const ref = (row.aspects as AspectsMap)['orbis/financial']?.category_ref;
    if (typeof ref === 'string') categoryIds.add(ref);
  }
  for (const r of unbudgetedRows) categoryIds.add(r.category_id);
  const catMap = await categoriesById(tx, [...categoryIds]);

  // Иерархия §2.10: карточка конверта родительской категории показывает СУММАРНЫЕ
  // spent/effectiveLimit своих конвертов и конвертов всех дочерних категорий набора.
  // Агрегация — поверх СЫРЫХ значений (потомки рекурсивно все, двойного счёта нет)
  // и ТОЛЬКО в валюте родительского конверта (fix round: чужая валюта не искажает
  // агрегаты, §5 — суммировать RUB- и USD-строки без конверсии нельзя).
  const edges = await categoryEdges(tx, ownerId);
  const statuses = raws.map((raw) => {
    let spent = raw.spent;
    let effectiveLimit = raw.effectiveLimit;
    const descendants = descendantsOf(edges, raw.categoryRef);
    if (descendants.size > 0) {
      for (const other of raws) {
        if (
          other !== raw &&
          descendants.has(other.categoryRef) &&
          other.currency === raw.currency
        ) {
          spent = decAdd(spent, other.spent);
          effectiveLimit = decAdd(effectiveLimit, other.effectiveLimit);
        }
      }
    }
    return statusOf(raw, categoryOr(catMap, raw.categoryRef), spent, effectiveLimit, today);
  });

  // Детерминированный порядок карточек: категория → период → id
  const sortKey = new Map(
    raws.map((raw) => [
      raw.row.id,
      `${categoryOr(catMap, raw.categoryRef).title}\u0000${raw.periodStart}\u0000${raw.row.id}`,
    ]),
  );
  statuses.sort((a, b) => {
    const ka = sortKey.get(a.envelope.id) ?? '';
    const kb = sortKey.get(b.envelope.id) ?? '';
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });

  // Бейдж §6.1: конверты spent > 85% × effectiveLimit — по СЫРЫМ значениям конверта
  // (бейдж считает конверты, а не карточки-агрегаты); в фазе upcoming пороги
  // не применяются (§2.9а)
  const alertCount = raws.filter(
    (raw) => phaseOf(raw, today) !== 'upcoming' && isAlert(raw.spent, raw.effectiveLimit),
  ).length;

  const finOf = (row: EntityRow) =>
    ((row.aspects as AspectsMap)['orbis/financial'] ?? {}) as Record<string, unknown>;
  const dateIdSort = (a: EntityRow, b: EntityRow) => {
    const ka = `${String(finOf(a).occurred_on ?? '')}\u0000${a.id}`;
    const kb = `${String(finOf(b).occurred_on ?? '')}\u0000${b.id}`;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  };

  return {
    period: { start, end },
    balance: { income, expense, balance: decSub(income, expense) },
    envelopes: statuses,
    comingUp: [...comingRows].sort(dateIdSort).map((row) => ({
      entity: toWireEntity(row),
      occurredOn: String(finOf(row).occurred_on ?? ''),
      amount: String(finOf(row).amount ?? '0'),
      direction: String(finOf(row).direction ?? ''),
    })),
    planned: [...plannedRows].sort(dateIdSort).map((row) => ({
      entity: toWireEntity(row),
      amount: String(finOf(row).amount ?? '0'),
      categoryTitle: categoryOr(catMap, String(finOf(row).category_ref ?? '')).title,
    })),
    unbudgeted: unbudgetedRows.map((r) => {
      const c = categoryOr(catMap, r.category_id);
      return {
        category: { id: c.id, title: c.title, icon: c.icon },
        total: decAdd(r.total, '0'),
      };
    }),
    alertCount,
  };
}

// ---------------------------------------------------------------------------
// Публичный API (роутер budget + тул budget_status)
// ---------------------------------------------------------------------------

/** Конвейер §2.8 перед агрегатами: due-переходы + материализация окна [today; +14]. */
async function preparePeriod(db: Db, ownerId: string): Promise<string> {
  const today = await localToday(db, ownerId);
  await postDueInstances({ db, ownerId, today });
  await materializeInstances({
    db,
    ownerId,
    from: today,
    to: addDays(today, HORIZON_DAYS),
    today,
  });
  return today;
}

/** BudgetOverview месяца (§3.1); month опционален — текущий месяц пользователя. */
export async function budgetOverview(
  db: Db,
  ownerId: string,
  month?: string,
): Promise<BudgetOverview> {
  const today = await preparePeriod(db, ownerId);
  const m = month ?? today.slice(0, 7);
  return withIdentity(db, ownerId, (tx) => computeOverview(tx, ownerId, m, today));
}

/**
 * Результат тула budget_status (§4.3/§4.5/§4.7): Overview + spend_class ВСЕХ категорий
 * владельца — расчёт «могу позволить?» требует классификацию, некластифицированные
 * категории модель обязана называть явно, а не включать молча.
 */
export async function budgetStatus(
  db: Db,
  ownerId: string,
  month?: string,
): Promise<BudgetStatusResult> {
  const today = await preparePeriod(db, ownerId);
  const m = month ?? today.slice(0, 7);
  return withIdentity(db, ownerId, async (tx) => {
    const overview = await computeOverview(tx, ownerId, m, today);
    const rows = (await tx.execute(sql`
      SELECT id, title, aspects->'orbis/category'->>'spend_class' AS spend_class
      FROM entities
      WHERE owner_id = ${ownerId} AND NOT archived AND aspects ? 'orbis/category'
      ORDER BY title, id
    `)) as unknown as Array<{ id: string; title: string; spend_class: string | null }>;
    return {
      ...overview,
      categories: rows.map((r) => ({
        id: r.id,
        title: r.title,
        spendClass:
          r.spend_class === 'fixed' || r.spend_class === 'discretionary' ? r.spend_class : null,
      })),
    };
  });
}

/**
 * Конверт категории на дату (fast-path-карточка «осталось N ₽» 03-budget §4.1 и
 * quick-add §3.6): селектор §2.3 в валюте по умолчанию; null — Unbudgeted.
 * Без конвейера §2.8 — лёгкое чтение сразу после записи fast-path (spent считает
 * только факты; planned-инстансы на remaining не влияют).
 */
export async function envelopeForCategory(
  db: Db,
  ownerId: string,
  args: { categoryId: string; date: string },
): Promise<EnvelopeStatus | null> {
  return withIdentity(db, ownerId, async (tx) => {
    const today = await localTodayTx(tx, ownerId);
    const defCur = await defaultCurrencyOf(tx, ownerId);
    const envelopeId = await selectEnvelope(tx, {
      ownerId,
      categoryRef: args.categoryId,
      currency: defCur,
      occurredOn: args.date,
      defaultCurrency: defCur,
    });
    if (envelopeId === null) return null;
    const rows = await tx.select().from(entities).where(eq(entities.id, envelopeId));
    const row = rows[0];
    if (row === undefined) return null;
    const spentMap = await spentByEnvelope(tx, ownerId, [envelopeId], today, defCur);
    const raw = rawEnvelopeOf(row, spentMap, defCur);
    if (raw === null) return null;
    const catMap = await categoriesById(tx, [raw.categoryRef]);
    return statusOf(raw, categoryOr(catMap, raw.categoryRef), raw.spent, raw.effectiveLimit, today);
  });
}

/**
 * Мини-тренд категории (§3.2): spent по конвертам последних months месяцев (включая
 * текущий) + суммарный limit месяца; бакет — месяц period_start конверта. Отображение,
 * не хранится; агрегация детей §2.10 тут не применяется — экран категории показывает её
 * собственные конверты («обход конвертов категории», §3.2).
 *
 * Валютная граница (fix round, §5): бакеты считаются ТОЛЬКО по конвертам валюты
 * по умолчанию — как баланс периода §2.5 («валюта периода = defaultCurrency»);
 * разновалютная пара конвертов одного месяца иначе давала бы бессмысленную сумму
 * limit/spent без конверсии. Тренд в чужой валюте — Future (multi-currency).
 */
export async function categoryTrend(
  db: Db,
  ownerId: string,
  args: { categoryId: string; months: number },
): Promise<CategoryTrendPoint[]> {
  return withIdentity(db, ownerId, async (tx) => {
    const today = await localTodayTx(tx, ownerId);
    const defCur = await defaultCurrencyOf(tx, ownerId);
    const curMonth = today.slice(0, 7);
    const monthsList = Array.from({ length: args.months }, (_, i) =>
      shiftMonth(curMonth, i - (args.months - 1)),
    );
    const first = monthsList[0] as string;
    const rows = await tx
      .select()
      .from(entities)
      .where(
        and(
          eq(entities.ownerId, ownerId),
          eq(entities.archived, false),
          sql`${entities.aspects}->'orbis/budget'->>'category_ref' = ${args.categoryId}`,
          sql`${entities.aspects}->'orbis/budget'->>'period_start' >= ${`${first}-01`}`,
          sql`${entities.aspects}->'orbis/budget'->>'period_start' <= ${monthRange(curMonth).end}`,
          // только валюта по умолчанию — см. валютную границу в docstring
          sql`coalesce(${entities.aspects}->'orbis/budget'->>'currency', ${defCur}) = ${defCur}`,
        ),
      );
    const spentMap = await spentByEnvelope(
      tx,
      ownerId,
      rows.map((r) => r.id),
      today,
      defCur,
    );
    const buckets = new Map<string, { spent: string; limit: string }>();
    for (const row of rows) {
      const raw = rawEnvelopeOf(row, spentMap, defCur);
      if (raw === null) continue;
      const key = raw.periodStart.slice(0, 7);
      const prev = buckets.get(key);
      buckets.set(key, {
        spent: prev === undefined ? raw.spent : decAdd(prev.spent, raw.spent),
        // штриховая линия limit §3.2 — сумма limit (без carryover)
        limit:
          prev === undefined
            ? decAdd(String(raw.budget.limit), '0')
            : decAdd(prev.limit, String(raw.budget.limit)),
      });
    }
    return monthsList.map((period) => {
      const bucket = buckets.get(period);
      return {
        period,
        spent: bucket?.spent ?? '0.00',
        limit: bucket?.limit ?? null,
      };
    });
  });
}
