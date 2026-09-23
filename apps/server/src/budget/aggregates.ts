// apps/server/src/budget/aggregates.ts
// ОБЁРТКИ КОНВЕЙЕРА §2.8 НАД ДВИЖКОМ ПОДПИСКИ И ПЕРЕХОД §3.5; второй реализации Overview больше нет
// (Б-2, Р-32). Пять обёрток ниже (`budgetOverview`, `budgetAlertCount`, `budgetStatus`,
// `envelopeForCategory`, `categoryTrend`) считают ДВИЖКОМ ПОДПИСКИ (`subscriptions/budget.ts`) по
// декларации `orbis/budget-overview`; эталон его вывода — снимок `test/golden/budget-engine.json`
// (§С8-15 «движок == снимок»), и пересдаётся он ЯВНО, разбором расхождения.
// Переход §3.5 — правило (Р12), а не ведомость; декларация несёт лишь его параметры, и их читают
// оба читателя перехода — `rolloverCreate` и `rolloverPreview`. Величины прошлого месяца превью
// берёт у движка (`monthLedgersOf`, ведомости без агрегации дерева).
//
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
  type BudgetSubscription,
  batchAuditMessageId,
  type CategoryTrendPoint,
  type EnvelopeStatus,
  type GraphId,
  type RolloverInput,
  type RolloverPreview,
  type RolloverResult,
} from '@orbis/shared';
import { type AnyColumn, eq, type SQL, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { userSettings } from '../db/schema';
import { type Tx, withIdentity } from '../db/with-identity';
import { ExecError, type ExecErrorCode } from '../errors';
import { execute } from '../executor/executor';
import { makeChatJournalSink } from '../executor/journal';
import type {
  ActorKind,
  ExecuteRequest,
  ExecutorDeps,
  MutationSource,
  WireEntity,
} from '../executor/types';
import type { Identity } from '../identity';
import { DEFAULT_TIMEZONE, isValidTimeZone } from '../query/context';
import { materializeInstances } from '../recurring/materialize';
import { postDueInstances } from '../recurring/post-due';
import { effectiveRegistry } from '../registry/cache';
import {
  BUDGET_SUBSCRIPTION_ID,
  budgetAlertCountOf,
  budgetOverviewOf,
  budgetStatusOf,
  categoryTrendOf,
  envelopeForCategoryOf,
  HORIZON_DAYS,
  monthLedgersOf,
} from '../subscriptions/budget';
import { builtinSubscription } from '../subscriptions/registry';
import { defaultCurrencyOf } from './binding';
// Карточки категорий живут в общем доме `budget/categories.ts`: их читают движок подписки и
// переход §3.5 здесь (титулы строк превью и конвертов-преемников), и две копии разошлись бы иконкой.
// Там же `ownerCategories`: его зовёт движок подписки (`budgetStatusOf`).
import { type CategoryInfo, categoriesById } from './categories';
import { decAdd } from './decimal';

// Горизонт Coming up и материализации живёт ОДНИМ экземпляром в движке подписки
// (`subscriptions/budget.ts`, `HORIZON_DAYS`): он подставляет его декларации параметром
// `horizon_end`, конвейер ниже материализует ровно это окно, и разъедься два числа — список
// предстоящих списаний спрашивал бы окно, которого материализация не заполнила.

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
  graphId: GraphId,
  clock: Clock = SYSTEM_CLOCK,
): Promise<string> {
  const rows = await tx
    .select({ timezone: userSettings.timezone })
    .from(userSettings)
    .where(eq(userSettings.graphId, graphId));
  const stored = rows[0]?.timezone ?? DEFAULT_TIMEZONE;
  // мусорная зона из БД деградирует до дефолта, не роняя запрос (как queryContext)
  const timezone = isValidTimeZone(stored) ? stored : DEFAULT_TIMEZONE;
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(clock());
}

export async function localToday(
  db: Db,
  who: Identity,
  clock: Clock = SYSTEM_CLOCK,
): Promise<string> {
  return withIdentity(db, who, (tx) => localTodayTx(tx, who.graph, clock));
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

function categoryOr(map: Map<string, CategoryInfo>, id: string): CategoryInfo {
  return map.get(id) ?? { id, title: '', icon: null, color: null, spendClass: null };
}

// ---------------------------------------------------------------------------
// Публичный API (роутер budget + тул budget_status)
// ---------------------------------------------------------------------------

/** Конвейер §2.8 перед агрегатами: due-переходы + материализация окна [today; +14]. */
async function preparePeriod(db: Db, who: Identity, clock: Clock): Promise<string> {
  const today = await localToday(db, who, clock);
  await postDueInstances({ db, identity: who, today });
  await materializeInstances({
    db,
    identity: who,
    from: today,
    to: addDays(today, HORIZON_DAYS),
    today,
  });
  return today;
}

/** Снимок реестра и разобранная декларация Budget на уже открытой tx — общая половина всех пяти
 *  обёрток. Второго источника декларации у них нет: разойдись он с реестром транзакции, и бейдж
 *  считался бы по одному порогу, а карточка по другому. */
async function budgetDefOf(tx: Tx, graphId: GraphId) {
  const reg = await effectiveRegistry(tx, graphId);
  return { reg, def: builtinSubscription(reg, BUDGET_SUBSCRIPTION_ID) as BudgetSubscription };
}

/** BudgetOverview месяца (§3.1); month опционален — текущий месяц пользователя. */
export async function budgetOverview(
  db: Db,
  who: Identity,
  month?: string,
  clock: Clock = SYSTEM_CLOCK,
): Promise<BudgetOverview> {
  // Конвейер §2.8 — ВНЕ подписки: §Б5-4 про ведомости, а не про материализацию.
  const today = await preparePeriod(db, who, clock);
  const m = month ?? today.slice(0, 7);
  return withIdentity(db, who, async (tx) => {
    const { reg, def } = await budgetDefOf(tx, who.graph);
    return budgetOverviewOf(tx, who.graph, { month: m, today }, def, reg);
  });
}

/**
 * Бейдж вкладки Budget (§6.1, Task B7): число конвертов месяца в тревоге/перерасходе
 * (spent > 85% × effectiveLimit). ЛЁГКОЕ чтение для count-запроса при инвалидации
 * кэша — БЕЗ конвейера §2.8 (postDue/материализация не запускаются): значение
 * производное и пересчитывается часто, тяжёлый конвейер гоняет overview.
 */
export async function budgetAlertCount(
  db: Db,
  who: Identity,
  month?: string,
  clock: Clock = SYSTEM_CLOCK,
): Promise<number> {
  return withIdentity(db, who, async (tx) => {
    const today = await localTodayTx(tx, who.graph, clock);
    const { reg, def } = await budgetDefOf(tx, who.graph);
    return budgetAlertCountOf(
      tx,
      who.graph,
      { month: month ?? today.slice(0, 7), today },
      def,
      reg,
    );
  });
}

/**
 * Результат тула budget_status (§4.3/§4.5/§4.7): Overview + spend_class ВСЕХ категорий
 * владельца — расчёт «могу позволить?» требует классификацию, некластифицированные
 * категории модель обязана называть явно, а не включать молча.
 */
export async function budgetStatus(
  db: Db,
  who: Identity,
  month?: string,
  clock: Clock = SYSTEM_CLOCK,
): Promise<BudgetStatusResult> {
  const today = await preparePeriod(db, who, clock);
  const m = month ?? today.slice(0, 7);
  return withIdentity(db, who, async (tx) => {
    const { reg, def } = await budgetDefOf(tx, who.graph);
    return budgetStatusOf(tx, who.graph, { month: m, today }, def, reg);
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
  who: Identity,
  args: { categoryId: string; date: string },
  clock: Clock = SYSTEM_CLOCK,
): Promise<EnvelopeStatus | null> {
  return withIdentity(db, who, async (tx) => {
    const today = await localTodayTx(tx, who.graph, clock);
    const { reg, def } = await budgetDefOf(tx, who.graph);
    return envelopeForCategoryOf(tx, who.graph, { ...args, today }, def, reg);
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
  who: Identity,
  args: { categoryId: string; months: number },
  clock: Clock = SYSTEM_CLOCK,
): Promise<CategoryTrendPoint[]> {
  return withIdentity(db, who, async (tx) => {
    const today = await localTodayTx(tx, who.graph, clock);
    const { reg, def } = await budgetDefOf(tx, who.graph);
    return categoryTrendOf(tx, who.graph, { ...args, today }, def, reg);
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
 * SQL-условие «сущность НЕ шаблон повторения» (§2.8) — общий предикат, а не принадлежность второй
 * реализации Overview (снесена в Б-2, Р-32): его зовут траты превью переноса ниже
 * (`rolloverPreview`, запрос категорий с тратами без конверта — решение 4 задачи 11 Б-2).
 *
 * Помощник, а не строка по месту, потому что в новой форме это уже не одна проверка на
 * NULL, а ПАРА «аспект приложен И свойство задано»: потерять вторую половину при переписи —
 * ровно один невнимательный copy-paste, а цена — шаблон, посчитанный вместе со своими
 * инстансами, то есть двойной расход у владельца. Второе место того же условия —
 * `rebindForEnvelope` в `binding.ts`; общего дома у них нет, потому что `aggregates.ts`
 * импортирует `binding.ts`, а не наоборот.
 *
 * Аргументы — выражения колонок, а не имя алиаса: половина мест это сырой SQL с алиасом
 * (`e.aspects`), половина — drizzle-условия над `entities`, и строкой обе формы не выразить.
 */
function notRecurringTemplateSql(aspectsCol: SQL | AnyColumn, propsCol: SQL | AnyColumn): SQL {
  return sql`NOT ('orbis/schedule' = ANY(${aspectsCol}) AND ${propsCol}->'orbis/recurrence' IS NOT NULL)`;
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
 *
 * ЧИТАТЕЛЬ — ДВИЖОК ВЕДОМОСТЕЙ (задача 11 Б-2, Р-32): величины конвертов прошлого месяца
 * (`spent`, `remaining`) приходят из `monthLedgersOf` — тех же ведомостей декларации, что у
 * карточки, но БЕЗ агрегации дерева §2.10: остаток родителя по дереву переехал бы и в его
 * конверт, и в конверты детей (решение 3, Р-К-42). Запрос «категории с тратами без конверта»
 * остаётся своим (решение 4): ведомость движка `unbudgeted` считает «движение без ЖИВОГО ребра
 * привязки», а превью нужно «у категории нет конверта, пересекающего прошлый месяц» — множества
 * разные, и подмена молча изменила бы состав строк.
 */
export async function rolloverPreview(
  db: Db,
  who: Identity,
  month: string,
  clock: Clock = SYSTEM_CLOCK,
): Promise<RolloverPreview> {
  const graphId = who.graph;
  return withIdentity(db, who, async (tx) => {
    const today = await localTodayTx(tx, graphId, clock);
    const defCur = await defaultCurrencyOf(tx, graphId);
    const prev = shiftMonth(month, -1);
    const prevRange = monthRange(prev);
    const targetRange = monthRange(month);

    // ПАРАМЕТРЫ ПЕРЕХОДА — ИЗ ДЕКЛАРАЦИИ, тем же путём, что у `rolloverCreate` (Р-32, Р12). Снимок
    // читается ТУТ ЖЕ, а не приходит параметром: второй источник разошёлся бы с тем реестром, по
    // которому исполнитель проверит запись. Молчаливая деградация запрещена — невыразимый параметр
    // это отказ, а не «как раньше»: здесь она стоит владельцу денег на счёте.
    // ЗАДАЧА 13 переключит обоих читателей на `rolloverRuleOf(reg)` строки-носителя (Р-13, Р-К-9).
    const reg = await effectiveRegistry(tx, graphId);
    const def = builtinSubscription(reg, BUDGET_SUBSCRIPTION_ID) as BudgetSubscription;
    const roll = def.rollover;
    if (roll.source !== 'exact_calendar_month') {
      throw new ExecError(
        'VALIDATION',
        `правило переноса умеет только календарный месяц, а декларация просит «${roll.source}» (§3.5)`,
        { reason: 'ROLLOVER_SOURCE_UNSUPPORTED', source: roll.source },
      );
    }
    if (roll.carry.agg !== 'remaining') {
      throw new ExecError(
        'VALIDATION',
        `правило переноса переносит остаток, а декларация просит ведомость «${roll.carry.agg}» (§3.5)`,
        { reason: 'ROLLOVER_CARRY_UNSUPPORTED', agg: roll.carry.agg },
      );
    }

    // Ведомости ПРОШЛОГО месяца движком, БЕЗ агрегации дерева (решение 3).
    const ledgers = await monthLedgersOf(tx, graphId, { month: prev, today }, def, reg);
    // Источник — только МЕСЯЧНЫЙ конверт прошлого месяца: движок отдаёт все, пересекающие месяц
    // (включая произвольные §2.9), а §3.5 их не переносит. Отбор — по точным границам месяца и по
    // валюте по умолчанию (§5), как было у сырого запроса.
    const prevEnvs = ledgers.envelopes.filter((st) => {
      const p = st.envelope.props as Record<string, unknown>;
      return (
        String(p['orbis/period_start']) === prevRange.start &&
        String(p['orbis/period_end']) === prevRange.end &&
        String(p['orbis/currency'] ?? defCur) === defCur
      );
    });

    // Категории с конвертом-преемником: месячный конверт целевого месяца (defaultCurrency)
    const succRows = (await tx.execute(sql`
      SELECT DISTINCT props->>'orbis/finance_category' AS category_id
      FROM entities
      WHERE graph_id = ${graphId} AND NOT archived
        AND 'orbis/budget' = ANY(aspects)
        AND props->>'orbis/period_start' = ${targetRange.start}
        AND props->>'orbis/period_end' = ${targetRange.end}
        AND coalesce(props->>'orbis/currency', ${defCur}) = ${defCur}
    `)) as unknown as Array<{ category_id: string }>;
    const successors = new Set(succRows.map((r) => r.category_id));

    // Агрегация по категории: prevSpent, carryover (= remaining §2.6), limit прошлого
    interface CatAgg {
      spent: string;
      carryover: string;
      suggestedLimit: string;
    }
    const byCat = new Map<string, CatAgg>();
    for (const st of prevEnvs) {
      if (successors.has(st.category.id)) continue;
      // `carry.agg` = имя ведомости декларации; сегодня опубликован ровно `remaining` (проверено
      // выше), и он же поле статуса — вторая карта «имя → поле» была бы второй правдой.
      const carry = st.remaining;
      // нормализация к канону
      const limit = decAdd(
        String((st.envelope.props as Record<string, unknown>)['orbis/limit']),
        '0',
      );
      const acc = byCat.get(st.category.id);
      byCat.set(
        st.category.id,
        acc === undefined
          ? { spent: st.spent, carryover: carry, suggestedLimit: limit }
          : {
              spent: decAdd(acc.spent, st.spent),
              carryover: decAdd(acc.carryover, carry),
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
      WHERE e.graph_id = ${graphId} AND NOT e.archived
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
          WHERE env.graph_id = ${graphId} AND NOT env.archived
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
  who: Identity,
  input: RolloverInput,
  /**
   * Кто и откуда зовёт (§7.8): с задачи 10 Б-2 у переноса три вызывателя — кнопка экрана Rollover,
   * тул `budget_rollover` (рука в чате, внешний агент) и «Принять» отложенной единицы рутины. Журнал
   * обязан называть настоящего — иначе перенос, предложенный рутиной, читался бы в ленте правкой
   * владельца на экране. Умолчание — прежний путь кнопки: владелец на экране Rollover.
   */
  actor?: {
    actorKind: ActorKind;
    source: MutationSource;
    threadId?: string;
    runId?: string;
    actorGrantId?: string;
  },
  /**
   * Шов сериализации «Принять» (`approvePending`): замок единицы и перепроверка «не отклонена» —
   * В ТОЙ ЖЕ транзакции, что audit-сообщение, как у пачки (`ExecutorDeps.beforeStages`). Без него
   * конкурентные «Принять» и «Отклонить» проходили бы свои проверки до чужого коммита (write-skew).
   */
  beforeStages?: ExecutorDeps['beforeStages'],
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
  const auditId = batchAuditMessageId(who.graph, input.batchId);
  const categoryIds = input.rows.map((r) => r.categoryId);

  // Фаза чтения: replay-детект, defaultCurrency, титулы, пречек преемников
  const { defCur, catMap } = await withIdentity(db, who, async (tx) => {
    const replay = (await rolloverSink.findByAuditId(tx, auditId)) !== undefined;
    const currency = await defaultCurrencyOf(tx, who.graph);
    // Р12: правило перехода остаётся КОДОМ (§Б4-3 — это не агрегат), а декларация несёт его
    // ПАРАМЕТРЫ. Снимок читается ТУТ ЖЕ, а не приходит параметром: фаза чтения уже держит tx, и
    // второй источник декларации разошёлся бы с тем реестром, по которому исполнитель проверит
    // запись. Молчаливая деградация запрещена: невыразимый параметр — отказ, а не «как раньше»,
    // потому что здесь она стоит владельцу денег на счёте.
    const roll = (
      builtinSubscription(
        await effectiveRegistry(tx, who.graph),
        BUDGET_SUBSCRIPTION_ID,
      ) as BudgetSubscription
    ).rollover;
    if (roll.source !== 'exact_calendar_month') {
      throw new ExecError(
        'VALIDATION',
        `правило переноса умеет только календарный месяц, а декларация просит «${roll.source}» (§3.5)`,
        { reason: 'ROLLOVER_SOURCE_UNSUPPORTED', source: roll.source },
      );
    }
    if (roll.carry.agg !== 'remaining') {
      throw new ExecError(
        'VALIDATION',
        `правило переноса переносит остаток, а декларация просит ведомость «${roll.carry.agg}» (§3.5)`,
        { reason: 'ROLLOVER_CARRY_UNSUPPORTED', agg: roll.carry.agg },
      );
    }
    if (!replay) {
      const list = sql.join(
        categoryIds.map((id) => sql`${id}`),
        sql`, `,
      );
      const succ = (await tx.execute(sql`
        SELECT DISTINCT props->>'orbis/finance_category' AS category_id
        FROM entities
        WHERE graph_id = ${who.graph} AND NOT archived
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
    identity: who,
    // Умолчание — подтверждённое действие владельца на экране Rollover (§3.5).
    actorKind: actor?.actorKind ?? 'owner',
    source: actor?.source ?? 'ui',
    ...(actor?.threadId !== undefined && { threadId: actor.threadId }),
    ...(actor?.runId !== undefined && { runId: actor.runId }),
    ...(actor?.actorGrantId !== undefined && { actorGrantId: actor.actorGrantId }),
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
  const r = await execute(db, request, {
    sink: rolloverSink,
    ...(beforeStages !== undefined && { beforeStages }),
  });
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
