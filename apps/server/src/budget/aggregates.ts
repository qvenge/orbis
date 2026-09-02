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

import {
  addDays,
  type BudgetOverview,
  type BudgetStatusResult,
  batchAuditMessageId,
  type CategoryTrendPoint,
  type EnvelopeStatus,
  ROLE_CATEGORY_PARENT,
  ROLE_ENVELOPE_BINDING,
  ROLE_INSTANCE_OF,
  type RolloverInput,
  type RolloverPreview,
  type RolloverResult,
} from '@orbis/shared';
import { type AnyColumn, and, eq, type SQL, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { entities, userSettings } from '../db/schema';
import { type Tx, withIdentity } from '../db/with-identity';
import { ExecError, type ExecErrorCode } from '../errors';
import { execute } from '../executor/executor';
import { makeChatJournalSink } from '../executor/journal';
import type { ExecuteRequest, WireEntity } from '../executor/types';
import { DEFAULT_TIMEZONE, isValidTimeZone } from '../query/context';
import { materializeInstances } from '../recurring/materialize';
import { postDueInstances } from '../recurring/post-due';
import { toWireEntity } from '../wire';
import { defaultCurrencyOf, selectEnvelope } from './binding';
import { decAdd, decCmp, decDivBy, decMulInt, decSub } from './decimal';

// «Конверт-родитель» в агрегатах — РОВНО роль `envelope-binding`, и с 0017 это относится ко
// всем её читателям сразу: к хуку привязки (`budgetParentsOfMany`), к обоим агрегатам здесь
// (`spentByEnvelope` и unbudgeted) и к карточке импорта (`unbudgetedOf`).
//
// До 0017 множество было ШИРЕ одной роли (`legacyParentRolesSql()`, интервал 7a→0017, §13.7):
// уникальность `rel_uniq` стояла на ПРОЕКЦИИ роли в снятую колонку `relation_type`, поэтому
// рядом со связью роли владельца (`subitem` от конверта к транзакции) хук не мог поставить
// свою `envelope-binding` — и, не считай агрегат такую связь расходом, владелец увидел бы
// трату в списке, но не в карточке конверта. С уникальностью по `(source, target, role)`
// такого запрета больше нет: привязка ставится своей ролью всегда, и расширенное множество
// стало бы вторым мнением о том, что уже сказано ролью (урок C1 Задачи 7a — расхождение
// множества у двух читателей стоило владельцу двойного счёта денег).
//
// Фильтр архива у читателей по-прежнему РАЗНЫЙ (здесь `NOT e.archived` на цели у
// `spentByEnvelope` и `NOT p.archived` на конверте у unbudgeted, у хука — никакого): это
// до-реформенное расхождение, запаркованное осознанно (отчёт Задачи 7b §6), и сужение
// множества ролей его не трогает.

type EntityRow = typeof entities.$inferSelect;

/**
 * Значения строки (§А1-1) — но ТОЛЬКО если аспект-носитель приложен.
 *
 * Признак аспекта здесь не перестраховка, а точный перевод старой формы. Старая карта
 * складывала значение ПОД аспект, поэтому снятие аспекта уносило его из неё целиком; в
 * `props` значение при снятии ОСТАЁТСЯ (Р9: аспект — не владелец поля). Читатель без этого
 * признака считал бы деньги на записи, которая транзакцией быть перестала, — путь живой,
 * его исполняет `unbindOps` (detach `orbis/financial`).
 *
 * Та же оговорка стоит в SQL этого файла: там признак пишется как
 * `'<аспект>' = ANY(<алиас>.aspects)` в WHERE.
 */
function propsOf(row: EntityRow, aspectId: string): Record<string, unknown> {
  return row.aspects.includes(aspectId) ? (row.props as Record<string, unknown>) : {};
}

/**
 * SQL-условие «сущность НЕ шаблон повторения» (§2.8).
 *
 * Помощник, а не строка по месту, потому что в новой форме это уже не одна проверка на
 * NULL, а ПАРА «аспект приложен И свойство задано»: потерять вторую половину при переписи —
 * ровно один невнимательный copy-paste, а цена — шаблон, посчитанный вместе со своими
 * инстансами, то есть двойной расход у владельца. В этом файле условие пишет только он —
 * все ПЯТЬ мест (spent конверта, баланс, Unbudgeted, planned, траты превью rollover) зовут
 * его. Шестое место того же условия — `rebindForEnvelope` в `binding.ts`; общего дома у них
 * нет, потому что `aggregates.ts` импортирует `binding.ts`, а не наоборот.
 *
 * Аргументы — выражения колонок, а не имя алиаса: половина мест это сырой SQL с алиасом
 * (`e.aspects`), половина — drizzle-условия над `entities`, и строкой обе формы не выразить.
 */
function notRecurringTemplateSql(aspectsCol: SQL | AnyColumn, propsCol: SQL | AnyColumn): SQL {
  return sql`NOT ('orbis/schedule' = ANY(${aspectsCol}) AND ${propsCol}->'orbis/recurrence' IS NOT NULL)`;
}

/** Горизонт Coming up и материализации — 14 дней (01-arch §5.4). */
const HORIZON_DAYS = 14;

// ---------------------------------------------------------------------------
// «Сегодня» пользователя — локальная дата в user_settings.timezone (03-budget §2.3;
// глобальное ограничение: финансовые формулы НЕ считают «сегодня» по UTC).
// ---------------------------------------------------------------------------

/**
 * Источник «сейчас» (Task A1) — подменяется в тестах границ дат; в проде системные
 * часы. Идёт последним НЕОБЯЗАТЕЛЬНЫМ параметром: форма прод-вызовов не меняется.
 */
export type Clock = () => Date;
const SYSTEM_CLOCK: Clock = () => new Date();

export async function localTodayTx(
  tx: Tx,
  ownerId: string,
  clock: Clock = SYSTEM_CLOCK,
): Promise<string> {
  const rows = await tx
    .select({ timezone: userSettings.timezone })
    .from(userSettings)
    .where(eq(userSettings.ownerId, ownerId));
  const stored = rows[0]?.timezone ?? DEFAULT_TIMEZONE;
  // мусорная зона из БД деградирует до дефолта, не роняя запрос (как queryContext)
  const timezone = isValidTimeZone(stored) ? stored : DEFAULT_TIMEZONE;
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(clock());
}

export async function localToday(
  db: Db,
  ownerId: string,
  clock: Clock = SYSTEM_CLOCK,
): Promise<string> {
  return withIdentity(db, ownerId, (tx) => localTodayTx(tx, ownerId, clock));
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
 * могут быть в разных валютах; чужая валюта в spent не входит, §5). Шаблоны recurring
 * (orbis/recurrence) — не операции (§2.8): висящая parent-связь на шаблон
 * (легаси-данные, ручной relation_create) не должна давать двойной счёт с инстансами.
 *
 * У источника (`env`) признак «это конверт» НЕ проверяется — как и до перевода: набор
 * `envelopeIds` вызывающий уже отобрал по аспекту бюджета, и вторая проверка была бы
 * тавтологией. С 0017 она стала тавтологией и по второму основанию: роль
 * `envelope-binding` системная (`created_by: 'system'`), и ставит её только бюджет-хук —
 * от конверта.
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
           coalesce(sum((e.props->>'orbis/amount')::numeric), 0)::text AS spent
    FROM relations r
    JOIN entities env ON env.id = r.source_id
    JOIN entities e   ON e.id = r.target_id
    WHERE r.role = ${ROLE_ENVELOPE_BINDING}
      AND r.source_id IN (${ids})
      AND e.owner_id = ${ownerId} AND NOT e.archived
      AND 'orbis/financial' = ANY(e.aspects)
      AND ${notRecurringTemplateSql(sql.raw('e.aspects'), sql.raw('e.props'))}
      AND e.props->>'orbis/direction' = 'expense'
      AND coalesce((e.props->>'orbis/planned')::boolean, false) = false
      AND (e.props->>'orbis/occurred_on') <= ${today}
      AND coalesce(e.props->>'orbis/currency', ${defaultCurrency})
          = coalesce(env.props->>'orbis/currency', ${defaultCurrency})
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
    SELECT id, title, props, ('orbis/category' = ANY(aspects)) AS is_category FROM entities
    WHERE id IN (${list})
  `)) as unknown as Array<{
    id: string;
    title: string;
    props: Record<string, unknown>;
    is_category: boolean;
  }>;
  return new Map(
    rows.map((r) => {
      // Не категория — карточка пустая: ровно то, что давала старая карта без своего ключа.
      const c = r.is_category ? r.props : {};
      const spendClass = c['orbis/spend_class'];
      return [
        r.id,
        {
          id: r.id,
          title: r.title,
          icon: typeof c['orbis/icon'] === 'string' ? c['orbis/icon'] : null,
          color: typeof c['orbis/color'] === 'string' ? c['orbis/color'] : null,
          spendClass: spendClass === 'fixed' || spendClass === 'discretionary' ? spendClass : null,
        },
      ];
    }),
  );
}

function categoryOr(map: Map<string, CategoryInfo>, id: string): CategoryInfo {
  return map.get(id) ?? { id, title: '', icon: null, color: null, spendClass: null };
}

/**
 * Рёбра дерева категорий (§2.10) — связи роли `category-parent` между category-сущностями.
 *
 * ЗДЕСЬ РОЛЬ СУЖАЕТ, и это названная перемена, а не перевод один-в-один. До реформы дерево
 * категорий собирала любая связь, проецирующаяся в старый `parent`: «часть внутри целого»
 * между двумя категориями считалась деревом наравне с настоящим родством. Реформа завела
 * роли ровно затем, чтобы эти смыслы не путались (§А4-3), и дерево категорий теперь ровно
 * одно — то, которое владелец назвал деревом. Связь `subitem` между категориями остаётся
 * связью, но агрегат родительской карточки её не собирает.
 */
async function categoryEdges(tx: Tx, ownerId: string): Promise<Map<string, string[]>> {
  const rows = (await tx.execute(sql`
    SELECT r.source_id, r.target_id FROM relations r
    JOIN entities s ON s.id = r.source_id
    JOIN entities t ON t.id = r.target_id
    WHERE r.role = ${ROLE_CATEGORY_PARENT}
      AND s.owner_id = ${ownerId}
      AND 'orbis/category' = ANY(s.aspects) AND 'orbis/category' = ANY(t.aspects)
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
  /** Свойства конверта (§А1-1) — источник limit для тренда и превью rollover. */
  props: Record<string, unknown>;
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
  const props = propsOf(row, 'orbis/budget');
  const categoryRef = props['orbis/finance_category'];
  const periodStart = props['orbis/period_start'];
  const periodEnd = props['orbis/period_end'];
  const limit = props['orbis/limit'];
  if (
    typeof categoryRef !== 'string' ||
    typeof periodStart !== 'string' ||
    typeof periodEnd !== 'string' ||
    typeof limit !== 'string'
  ) {
    return null; // структурно битый конверт не роняет Overview (валидность держит executor)
  }
  const carryover = props['orbis/carryover'];
  const currency = props['orbis/currency'];
  return {
    row,
    props,
    categoryRef,
    periodStart,
    periodEnd,
    currency: typeof currency === 'string' ? currency : defaultCurrency,
    spent: decAdd(spentMap.get(row.id) ?? '0', '0'), // нормализация к канону "0.00"
    effectiveLimit: decAdd(limit, typeof carryover === 'string' ? carryover : '0'),
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

/**
 * Порог бейджа §6.1: spent >= 85% × effectiveLimit ⇔ 20·spent >= 17·effectiveLimit.
 * Граница ВКЛЮЧИТЕЛЬНО (sign-off владельца 2026-07-23): совпадает с ⚠-порогом
 * карточки конверта (§3.1) — ровно-85% конверт и оранжевый, и в бейдже.
 */
function isAlert(spent: string, effectiveLimit: string): boolean {
  return decCmp(decMulInt(spent, 20), decMulInt(effectiveLimit, 17)) >= 0;
}

/**
 * Бейдж §6.1: конверты spent >= 85% × effectiveLimit — по СЫРЫМ значениям конверта
 * (бейдж считает конверты, а не карточки-агрегаты §2.10); в фазе upcoming пороги
 * не применяются (§2.9а). Единственное место формулы порога для overview и alertCount.
 */
function countAlerts(raws: RawEnvelope[], today: string): number {
  return raws.filter(
    (raw) => phaseOf(raw, today) !== 'upcoming' && isAlert(raw.spent, raw.effectiveLimit),
  ).length;
}

/** Сырые конверты, пересекающие месяц (месячные + произвольные §2.9), со spent §2.2. */
async function rawEnvelopesOfMonth(
  tx: Tx,
  ownerId: string,
  month: string,
  today: string,
  defCur: string,
): Promise<RawEnvelope[]> {
  const { start, end } = monthRange(month);
  const envRows = await tx
    .select()
    .from(entities)
    .where(
      and(
        eq(entities.ownerId, ownerId),
        eq(entities.archived, false),
        sql`'orbis/budget' = ANY(${entities.aspects})`,
        sql`${entities.props}->>'orbis/period_start' <= ${end}`,
        sql`${entities.props}->>'orbis/period_end' >= ${start}`,
      ),
    );
  const spentMap = await spentByEnvelope(
    tx,
    ownerId,
    envRows.map((r) => r.id),
    today,
    defCur,
  );
  return envRows
    .map((row) => rawEnvelopeOf(row, spentMap, defCur))
    .filter((r): r is RawEnvelope => r !== null);
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
  const raws = await rawEnvelopesOfMonth(tx, ownerId, month, today, defCur);

  // Баланс периода (§2.5): факты в [start;end] и ≤ сегодня, валюта периода = дефолтная;
  // шаблоны recurring (свойство orbis/recurrence) — не операции, исключены
  const balanceRows = (await tx.execute(sql`
    SELECT e.props->>'orbis/direction' AS direction,
           coalesce(sum((e.props->>'orbis/amount')::numeric), 0)::text AS total
    FROM entities e
    WHERE e.owner_id = ${ownerId} AND NOT e.archived
      AND 'orbis/financial' = ANY(e.aspects)
      AND ${notRecurringTemplateSql(sql.raw('e.aspects'), sql.raw('e.props'))}
      AND coalesce((e.props->>'orbis/planned')::boolean, false) = false
      AND e.props->>'orbis/occurred_on' >= ${start}
      AND e.props->>'orbis/occurred_on' <= ${end}
      AND e.props->>'orbis/occurred_on' <= ${today}
      AND coalesce(e.props->>'orbis/currency', ${defCur}) = ${defCur}
    GROUP BY 1
  `)) as unknown as Array<{ direction: string; total: string }>;
  const income = decAdd(balanceRows.find((r) => r.direction === 'income')?.total ?? '0', '0');
  const expense = decAdd(balanceRows.find((r) => r.direction === 'expense')?.total ?? '0', '0');

  // Unbudgeted (§2.3 шаг 5, §3.1): фактические расходы периода БЕЗ budget-parent,
  // группировка по category_ref; чужая валюта в агрегат не входит (§5)
  const unbudgetedRows = (await tx.execute(sql`
    SELECT e.props->>'orbis/finance_category' AS category_id,
           sum((e.props->>'orbis/amount')::numeric)::text AS total
    FROM entities e
    WHERE e.owner_id = ${ownerId} AND NOT e.archived
      AND 'orbis/financial' = ANY(e.aspects)
      AND ${notRecurringTemplateSql(sql.raw('e.aspects'), sql.raw('e.props'))}
      AND e.props->>'orbis/direction' = 'expense'
      AND coalesce((e.props->>'orbis/planned')::boolean, false) = false
      AND e.props->>'orbis/occurred_on' >= ${start}
      AND e.props->>'orbis/occurred_on' <= ${end}
      AND e.props->>'orbis/occurred_on' <= ${today}
      AND coalesce(e.props->>'orbis/currency', ${defCur}) = ${defCur}
      AND NOT EXISTS (
        SELECT 1 FROM relations r
        JOIN entities p ON p.id = r.source_id
        WHERE r.target_id = e.id AND r.role = ${ROLE_ENVELOPE_BINDING}
          AND 'orbis/budget' = ANY(p.aspects) AND NOT p.archived
      )
    GROUP BY 1
    ORDER BY 1
  `)) as unknown as Array<{ category_id: string; total: string }>;

  // Coming up (§2.8): материализованные recurring-инстансы (роль `instance-of` — дискриминатор)
  // с planned=true на 14 дней; due-инстансы сегодняшнего дня уже переведены postDue
  const comingRows = await tx
    .select()
    .from(entities)
    .where(
      and(
        eq(entities.ownerId, ownerId),
        eq(entities.archived, false),
        sql`'orbis/financial' = ANY(${entities.aspects})`,
        sql`coalesce((${entities.props}->>'orbis/planned')::boolean, false)`,
        sql`${entities.props}->>'orbis/occurred_on' >= ${today}`,
        sql`${entities.props}->>'orbis/occurred_on' <= ${horizon}`,
        sql`EXISTS (SELECT 1 FROM relations r
                    WHERE r.target_id = ${entities.id} AND r.role = ${ROLE_INSTANCE_OF})`,
      ),
    );

  // Planned (§2.7): ручные запланированные покупки — planned=true БЕЗ связи `instance-of`
  // (и не шаблоны); окном месяца не режутся — это список намерений, не агрегат периода
  const plannedRows = await tx
    .select()
    .from(entities)
    .where(
      and(
        eq(entities.ownerId, ownerId),
        eq(entities.archived, false),
        sql`'orbis/financial' = ANY(${entities.aspects})`,
        sql`coalesce((${entities.props}->>'orbis/planned')::boolean, false)`,
        sql`${entities.props}->>'orbis/direction' = 'expense'`,
        notRecurringTemplateSql(entities.aspects, entities.props),
        sql`NOT EXISTS (SELECT 1 FROM relations r
                        WHERE r.target_id = ${entities.id} AND r.role = ${ROLE_INSTANCE_OF})`,
      ),
    );

  // Карточки категорий одним запросом: конверты + planned + unbudgeted
  const categoryIds = new Set<string>();
  for (const raw of raws) categoryIds.add(raw.categoryRef);
  for (const row of plannedRows) {
    const ref = propsOf(row, 'orbis/financial')['orbis/finance_category'];
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

  // Бейдж §6.1 — общий countAlerts (единая формула с budget.alertCount)
  const alertCount = countAlerts(raws, today);

  const finOf = (row: EntityRow) => propsOf(row, 'orbis/financial');
  const dateIdSort = (a: EntityRow, b: EntityRow) => {
    const ka = `${String(finOf(a)['orbis/occurred_on'] ?? '')}\u0000${a.id}`;
    const kb = `${String(finOf(b)['orbis/occurred_on'] ?? '')}\u0000${b.id}`;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  };

  return {
    period: { start, end },
    balance: { income, expense, balance: decSub(income, expense) },
    envelopes: statuses,
    comingUp: [...comingRows].sort(dateIdSort).map((row) => ({
      entity: toWireEntity(row),
      occurredOn: String(finOf(row)['orbis/occurred_on'] ?? ''),
      amount: String(finOf(row)['orbis/amount'] ?? '0'),
      direction: String(finOf(row)['orbis/direction'] ?? ''),
    })),
    planned: [...plannedRows].sort(dateIdSort).map((row) => ({
      entity: toWireEntity(row),
      amount: String(finOf(row)['orbis/amount'] ?? '0'),
      categoryTitle: categoryOr(catMap, String(finOf(row)['orbis/finance_category'] ?? '')).title,
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
async function preparePeriod(db: Db, ownerId: string, clock: Clock): Promise<string> {
  const today = await localToday(db, ownerId, clock);
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
  clock: Clock = SYSTEM_CLOCK,
): Promise<BudgetOverview> {
  const today = await preparePeriod(db, ownerId, clock);
  const m = month ?? today.slice(0, 7);
  return withIdentity(db, ownerId, (tx) => computeOverview(tx, ownerId, m, today));
}

/**
 * Бейдж вкладки Budget (§6.1, Task B7): число конвертов месяца в тревоге/перерасходе
 * (spent > 85% × effectiveLimit). ЛЁГКОЕ чтение для count-запроса при инвалидации
 * кэша — БЕЗ конвейера §2.8 (postDue/материализация не запускаются): значение
 * производное и пересчитывается часто, тяжёлый конвейер гоняет overview.
 */
export async function budgetAlertCount(
  db: Db,
  ownerId: string,
  month?: string,
  clock: Clock = SYSTEM_CLOCK,
): Promise<number> {
  return withIdentity(db, ownerId, async (tx) => {
    const today = await localTodayTx(tx, ownerId, clock);
    const defCur = await defaultCurrencyOf(tx, ownerId);
    const raws = await rawEnvelopesOfMonth(tx, ownerId, month ?? today.slice(0, 7), today, defCur);
    return countAlerts(raws, today);
  });
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
  clock: Clock = SYSTEM_CLOCK,
): Promise<BudgetStatusResult> {
  const today = await preparePeriod(db, ownerId, clock);
  const m = month ?? today.slice(0, 7);
  return withIdentity(db, ownerId, async (tx) => {
    const overview = await computeOverview(tx, ownerId, m, today);
    const rows = (await tx.execute(sql`
      SELECT id, title, props->>'orbis/spend_class' AS spend_class
      FROM entities
      WHERE owner_id = ${ownerId} AND NOT archived AND 'orbis/category' = ANY(aspects)
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
  clock: Clock = SYSTEM_CLOCK,
): Promise<EnvelopeStatus | null> {
  return withIdentity(db, ownerId, async (tx) => {
    const today = await localTodayTx(tx, ownerId, clock);
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
  clock: Clock = SYSTEM_CLOCK,
): Promise<CategoryTrendPoint[]> {
  return withIdentity(db, ownerId, async (tx) => {
    const today = await localTodayTx(tx, ownerId, clock);
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
          sql`'orbis/budget' = ANY(${entities.aspects})`,
          sql`${entities.props}->>'orbis/finance_category' = ${args.categoryId}`,
          sql`${entities.props}->>'orbis/period_start' >= ${`${first}-01`}`,
          sql`${entities.props}->>'orbis/period_start' <= ${monthRange(curMonth).end}`,
          // только валюта по умолчанию — см. валютную границу в docstring
          sql`coalesce(${entities.props}->>'orbis/currency', ${defCur}) = ${defCur}`,
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
            ? decAdd(String(raw.props['orbis/limit']), '0')
            : decAdd(prev.limit, String(raw.props['orbis/limit'])),
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

// ---------------------------------------------------------------------------
// Rollover (§2.6, §3.5, Task A7): превью carryover и создание конвертов
// нового периода одним batch_execute
// ---------------------------------------------------------------------------

// Синк один на модуль (как post-due.ts): состояния не хранит, audit-сообщение batch
// пишется тем же tx, что операции executor'а (§7.8).
const rolloverSink = makeChatJournalSink();

/**
 * Округление ВВЕРХ до кратного 100 — эвристика suggestedLimit для категории с тратами
 * без прошлого конверта (§3.5). BigInt на исходном масштабе, без float; вход
 * неотрицателен по построению (сумма expense-операций).
 */
function decCeilToHundred(amount: string): string {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(amount);
  if (m === null) throw new RangeError(`не неотрицательная decimal-строка: "${amount}"`);
  const [, int, frac = ''] = m as unknown as [string, string, string?];
  const scale = 10n ** BigInt((frac ?? '').length);
  const value = BigInt(`${int}${frac ?? ''}`); // amount × scale
  const unit = 100n * scale;
  const q = (value + unit - 1n) / unit; // ceil(amount / 100)
  return `${(q * 100n).toString()}.00`;
}

/**
 * Превью rollover для целевого месяца month (§3.5): что переносить из прошлого
 * календарного месяца.
 *
 * Семантика (решения A7, зафиксированы тестами rollover.test.ts):
 * - Источник — только МЕСЯЧНЫЙ конверт прошлого месяца (period_start/period_end =
 *   точные границы календарного месяца); произвольные периоды §2.9 не участвуют.
 * - Преемник-блокер — только месячный конверт целевого месяца; произвольный конверт,
 *   пересекающий целевой месяц, преемником НЕ считается (§3.5: rollover создаёт
 *   месячные конверты, разовый бюджет их не заменяет).
 * - Валютная граница (§5, как categoryTrend): и источники, и преемники — только
 *   defaultCurrency (coalesce NULL); чужая валюта — Future (multi-currency).
 * - `carryover = remaining(прошлый) = effectiveLimit − spent` (§2.6), включая
 *   отрицательный; NULL- и явная defaultCurrency-комбинации §2.1 одной категории
 *   суммируются (обе перейдут в один конверт-преемник).
 * - Когда история есть (хотя бы один месячный конверт прошлого месяца), в rows входят
 *   и категории с фактическими тратами прошлого месяца БЕЗ конверта: carryover 0,
 *   suggestedLimit = spent, округлённый вверх до 100.
 * - needsSetup — «первый месяц без истории» (§3.5): месячных конвертов прошлого месяца
 *   нет вовсе (rows пуст), но траты были — AI должен спрашивать, а не предлагать.
 */
export async function rolloverPreview(
  db: Db,
  ownerId: string,
  month: string,
  clock: Clock = SYSTEM_CLOCK,
): Promise<RolloverPreview> {
  return withIdentity(db, ownerId, async (tx) => {
    const today = await localTodayTx(tx, ownerId, clock);
    const defCur = await defaultCurrencyOf(tx, ownerId);
    const prevRange = monthRange(shiftMonth(month, -1));
    const targetRange = monthRange(month);

    // Месячные конверты прошлого календарного месяца (только defaultCurrency)
    const prevEnvs = await tx
      .select()
      .from(entities)
      .where(
        and(
          eq(entities.ownerId, ownerId),
          eq(entities.archived, false),
          sql`'orbis/budget' = ANY(${entities.aspects})`,
          sql`${entities.props}->>'orbis/period_start' = ${prevRange.start}`,
          sql`${entities.props}->>'orbis/period_end' = ${prevRange.end}`,
          sql`coalesce(${entities.props}->>'orbis/currency', ${defCur}) = ${defCur}`,
        ),
      );

    // Категории с конвертом-преемником: месячный конверт целевого месяца (defaultCurrency)
    const succRows = (await tx.execute(sql`
      SELECT DISTINCT props->>'orbis/finance_category' AS category_id
      FROM entities
      WHERE owner_id = ${ownerId} AND NOT archived
        AND 'orbis/budget' = ANY(aspects)
        AND props->>'orbis/period_start' = ${targetRange.start}
        AND props->>'orbis/period_end' = ${targetRange.end}
        AND coalesce(props->>'orbis/currency', ${defCur}) = ${defCur}
    `)) as unknown as Array<{ category_id: string }>;
    const successors = new Set(succRows.map((r) => r.category_id));

    const spentMap = await spentByEnvelope(
      tx,
      ownerId,
      prevEnvs.map((r) => r.id),
      today,
      defCur,
    );

    // Агрегация по категории: prevSpent, carryover (= remaining §2.6), limit прошлого
    interface CatAgg {
      spent: string;
      carryover: string;
      suggestedLimit: string;
    }
    const byCat = new Map<string, CatAgg>();
    for (const row of prevEnvs) {
      const raw = rawEnvelopeOf(row, spentMap, defCur);
      if (raw === null || successors.has(raw.categoryRef)) continue;
      const remaining = decSub(raw.effectiveLimit, raw.spent);
      const limit = decAdd(String(raw.props['orbis/limit']), '0'); // нормализация к канону
      const acc = byCat.get(raw.categoryRef);
      byCat.set(
        raw.categoryRef,
        acc === undefined
          ? { spent: raw.spent, carryover: remaining, suggestedLimit: limit }
          : {
              spent: decAdd(acc.spent, raw.spent),
              carryover: decAdd(acc.carryover, remaining),
              suggestedLimit: decAdd(acc.suggestedLimit, limit),
            },
      );
    }
    const hasHistory = prevEnvs.length > 0;

    // Категории с фактическими defaultCurrency-тратами прошлого месяца (§2.2: факт =
    // planned=false, ≤ сегодня; шаблоны recurring исключены) БЕЗ defaultCurrency-конверта,
    // пересекающего прошлый месяц: категория с произвольным конвертом §2.9 сюда не
    // попадает — её траты уже бюджетировались, а произвольный период в rollover не
    // участвует. Валютная граница NOT EXISTS симметрична остальным запросам (§5):
    // чужевалютный конверт RUB-траты не бюджетирует и категорию из превью не прячет.
    const spendingRows = (await tx.execute(sql`
      SELECT e.props->>'orbis/finance_category' AS category_id,
             sum((e.props->>'orbis/amount')::numeric)::text AS total
      FROM entities e
      WHERE e.owner_id = ${ownerId} AND NOT e.archived
        AND 'orbis/financial' = ANY(e.aspects)
        AND e.props->>'orbis/finance_category' IS NOT NULL
        AND ${notRecurringTemplateSql(sql.raw('e.aspects'), sql.raw('e.props'))}
        AND e.props->>'orbis/direction' = 'expense'
        AND coalesce((e.props->>'orbis/planned')::boolean, false) = false
        AND e.props->>'orbis/occurred_on' >= ${prevRange.start}
        AND e.props->>'orbis/occurred_on' <= ${prevRange.end}
        AND e.props->>'orbis/occurred_on' <= ${today}
        AND coalesce(e.props->>'orbis/currency', ${defCur}) = ${defCur}
        AND NOT EXISTS (
          SELECT 1 FROM entities env
          WHERE env.owner_id = ${ownerId} AND NOT env.archived
            AND 'orbis/budget' = ANY(env.aspects)
            AND env.props->>'orbis/finance_category' = e.props->>'orbis/finance_category'
            AND coalesce(env.props->>'orbis/currency', ${defCur}) = ${defCur}
            AND env.props->>'orbis/period_start' <= ${prevRange.end}
            AND env.props->>'orbis/period_end' >= ${prevRange.start}
        )
      GROUP BY 1
      HAVING sum((e.props->>'orbis/amount')::numeric) > 0
      ORDER BY 1
    `)) as unknown as Array<{ category_id: string; total: string }>;

    if (hasHistory) {
      for (const r of spendingRows) {
        if (successors.has(r.category_id)) continue;
        const spent = decAdd(r.total, '0');
        byCat.set(r.category_id, {
          spent,
          carryover: '0.00', // переносить нечего — прошлого effective_limit не было
          suggestedLimit: decCeilToHundred(spent),
        });
      }
    }
    const needsSetup = !hasHistory && spendingRows.length > 0;

    const catMap = await categoriesById(tx, [...byCat.keys()]);
    const rows = [...byCat.entries()]
      .map(([categoryId, agg]) => {
        const c = categoryOr(catMap, categoryId);
        return {
          categoryId,
          categoryTitle: c.title,
          categoryIcon: c.icon,
          prevSpent: agg.spent,
          carryover: agg.carryover,
          suggestedLimit: agg.suggestedLimit,
        };
      })
      // Детерминированный порядок — как карточки Overview: title → id
      .sort((a, b) => {
        const ka = `${a.categoryTitle}\u0000${a.categoryId}`;
        const kb = `${b.categoryTitle}\u0000${b.categoryId}`;
        return ka < kb ? -1 : ka > kb ? 1 : 0;
      });

    return { month, rows, needsSetup };
  });
}

/**
 * Создание конвертов нового периода — ОДИН batch_execute (§3.5): по entity_create на
 * row (период = календарный месяц month, валюта = defaultCurrency явно — §2.1 сравнивает
 * комбинацию точно, самоописываемость дешевле NULL-коалесценции). Идемпотентно по
 * batchId (§7.8): повтор возвращает сохранённый результат; Undo action = batchId
 * откатывает всю группу, включая перехват транзакций A4-хуком.
 *
 * INVARIANT всего batch (атомарность):
 * - дубль категории во входе — отклоняется до executor (внятная атрибуция; ту же пару
 *   поймал бы §2.1 по виртуальному состоянию batch);
 * - уже существующий преемник — пречек с coalesce-валютой: инвариант §2.1 сравнивает
 *   комбинацию ТОЧНО и NULL-currency-преемника не увидел бы. Пречек идёт после
 *   replay-детекта (повтор batchId обязан вернуться replay'ем, а не упасть на
 *   собственноручно созданных преемниках). Щель «NULL-преемник появился между
 *   пречеком и batch» закрыта нормализацией NULL→defaultCurrency (бэклог A7,
 *   normalizeEnvelopeCurrency): новые записи NULL не несут, точную комбинацию
 *   закрывает advisory-lock §2.1.
 */
export async function rolloverCreate(
  db: Db,
  ownerId: string,
  input: RolloverInput,
): Promise<RolloverResult> {
  const seen = new Set<string>();
  for (const row of input.rows) {
    if (seen.has(row.categoryId)) {
      throw new ExecError(
        'INVARIANT',
        'дубль категории во входе rollover — по одному конверту на категорию (§3.5)',
        { invariant: 'duplicate_rollover_category', categoryId: row.categoryId },
      );
    }
    seen.add(row.categoryId);
  }

  const { start, end } = monthRange(input.month);
  const auditId = batchAuditMessageId(ownerId, input.batchId);
  const categoryIds = input.rows.map((r) => r.categoryId);

  // Фаза чтения: replay-детект, defaultCurrency, титулы, пречек преемников
  const { defCur, catMap } = await withIdentity(db, ownerId, async (tx) => {
    const replay = (await rolloverSink.findByAuditId(tx, auditId)) !== undefined;
    const currency = await defaultCurrencyOf(tx, ownerId);
    if (!replay) {
      const list = sql.join(
        categoryIds.map((id) => sql`${id}`),
        sql`, `,
      );
      const succ = (await tx.execute(sql`
        SELECT DISTINCT props->>'orbis/finance_category' AS category_id
        FROM entities
        WHERE owner_id = ${ownerId} AND NOT archived
          AND 'orbis/budget' = ANY(aspects)
          AND props->>'orbis/finance_category' IN (${list})
          AND props->>'orbis/period_start' = ${start}
          AND props->>'orbis/period_end' = ${end}
          AND coalesce(props->>'orbis/currency', ${currency}) = ${currency}
      `)) as unknown as Array<{ category_id: string }>;
      if (succ.length > 0) {
        throw new ExecError(
          'INVARIANT',
          'конверт целевого месяца уже существует — rollover отклонён целиком (§3.5); уберите категорию из rows или правьте существующий конверт',
          {
            invariant: 'rollover_successor_exists',
            categoryIds: succ.map((s) => s.category_id).sort(),
          },
        );
      }
    }
    return { defCur: currency, catMap: await categoriesById(tx, categoryIds) };
  });

  const request: ExecuteRequest = {
    actorUserId: ownerId,
    actorKind: 'owner',
    source: 'ui', // подтверждённое действие владельца на экране Rollover (§3.5)
    // Механизм — правило каталога (§А4-4): перенос остатка пишет `orbis/carryover`, и
    // только правилу rollover это разрешено (§А2-5).
    mechanism: 'rule',
    batchId: input.batchId,
    operations: input.rows.map((row) => {
      const title = categoryOr(catMap, row.categoryId).title;
      return {
        tool: 'entity_create',
        input: {
          title: title === '' ? `Конверт ${input.month}` : `Конверт «${title}» ${input.month}`,
          tags: [],
          // Внутренняя форма §А1-1: список навешиваемых аспектов + значения по id свойства.
          aspects: ['orbis/budget'],
          props: {
            'orbis/finance_category': row.categoryId,
            'orbis/limit': row.limit,
            'orbis/carryover': row.carryover,
            'orbis/currency': defCur,
            'orbis/period_start': start,
            'orbis/period_end': end,
          },
        },
      };
    }),
  };
  const r = await execute(db, request, { sink: rolloverSink });
  if (!r.ok) {
    throw new ExecError(r.error.code as ExecErrorCode, r.error.message, r.error.details);
  }
  return {
    actionId: r.actionId,
    // results batch — только запрошенные операции (§9.2): по конверту на row
    envelopeIds: (r.results as WireEntity[]).map((e) => e.id),
    idempotentReplay: r.idempotentReplay,
  };
}
