// apps/server/src/subscriptions/budget.ts
//
// ДВИЖОК ВЕДОМОСТЕЙ BUDGET (§Б5-4) — читающая половина подписки `orbis/budget-overview`.
//
// Оракул (`budget/aggregates.ts`, `computeOverview`) живёт рядом до Б-2 (Р-К-5): «ноль расхождений»
// §С8-15 доказывается ДВУМЯ реализациями на ОДНОЙ транзакции, и снос эталона до перф-гейта задачи 12
// лишил бы сверку второго мнения. Ни одной ветки «по имени ведомости» здесь нет: `spent`,
// `period_balance` и `unbudgeted` различаются РОВНО строением своих деклараций (`bound_via` /
// `unbound_via` / ни того ни другого), и это проверяемо — мутационный тест сьюта двигает
// декларацию, а не код.
//
// ДВУХФАЗНЫЙ ПЛАН §Б5-3 (цена ошибки 6,9× — проба П2 §6):
//   1) источник С СЕЛЕКТОРОМ (`envelope`) считается отдельной ведомостью в массив id;
//   2) агрегаты по нему ограничиваются `= ANY($ids)`;
//   3) конверт другого конца ребра читается JOIN'ом из `entities`, а не из CTE набора — CTE без
//      статистики дал бы вложенный цикл на 458k пар (П2 §10.3).
// У источника `movement` селектора нет: 20 000 его id в JS были бы худшим планом, чем предикат по
// месту, поэтому `movementIds` — SQL-предикат над алиасом, а не массив (Р-К-40).
//
// ЧЕГО ЗДЕСЬ НЕТ. Конвейера §2.8 (postDue + материализация окна): §Б5-4 про ведомости, а не про
// материализацию, и он остаётся в обёртках `aggregates.ts`. Правила `rollover`: оно код (Р12), а
// декларация — носитель его параметров.
//
// ПОЛЯ ДЕКЛАРАЦИИ, КОТОРЫЕ ДВИЖОК НЕ ЧИТАЕТ, — названный остаток (правило 5 §С1-4 «почему кодом»,
// реестр остатков задачи 19). Мутация любого из них сегодня ничего не меняет, и молчать об этом
// нельзя: читатель декларации вправе думать, что она вся исполняется.
//   · `sources.envelope.binding_role` — ребро привязки движок берёт из `bound_via`/`unbound_via`
//     САМОЙ ведомости: там оно у каждой суммы своё, а поле источника называет одно на всех. Свести
//     их в одно место — Б-2, вместе с переводом хука на контракт.
//   · `sources.envelope.selector` (`match`/`tie_break`) — выбор конверта под трату исполняет
//     `budget/binding.ts` (`selectEnvelope`) по аспекту `orbis/budget` (Р-К-50): это ПИШУЩАЯ
//     половина, её обобщение по контракту — задача 11. Движок зовёт тот же `selectEnvelope`, чтобы
//     fast-path и хук не разошлись, но правило выбора читает не он.
//   · `currency_rule: 'owner_default_if_absent'` — валютное правило живёт у КАЖДОЙ суммы полем
//     `currency` (`same_as_envelope` против `owner_default_only`, П2 №2), и общее поле осталось
//     единственным допустимым значением схемы: читать его — значит выбирать из одного.
//   · `spent.alive` — «живой конверт» осмыслен только у `unbound_via` (архивен ли конверт, которого
//     у траты НЕТ); у суммы по ребру конверт задан ребром, и его архивность отсекает фаза 1.
//   · `spent.window: 'envelope_period'` — период уже сказан ребром привязки (селектор ставит её
//     только внутрь периода), и второе условие по датам было бы вторым мнением о смысле ребра.
//     Читается только ветка `'period'` (см. `sumLedgerSql`).
import {
  addDays,
  type BindingIndex,
  type BudgetOverview,
  type BudgetStatusResult,
  type BudgetSubscription,
  bindingIndexOf,
  type CategoryTrendPoint,
  type EnvelopeStatus,
  type ResolvedBinding,
} from '@orbis/shared';
// `SQL` — ЗНАЧЕНИЕМ, а не только типом: `runSum` сужает им ветку плана (`instanceof SQL`).
import type { ExprNode, ExprScalar } from '@orbis/shared/expr';
import { inArray, SQL, sql } from 'drizzle-orm';
import { defaultCurrencyOf, lockOwnerBudget, selectEnvelope } from '../budget/binding';
import { type CategoryInfo, categoriesById, ownerCategories } from '../budget/categories';
import { decAdd, decCmp, decMul, decSub } from '../budget/decimal';
import { readSpentCache, spentCacheKey, writeSpentCache } from '../budget/spent-cache';
import { entities } from '../db/schema';
import type { Tx } from '../db/with-identity';
import { ExecError } from '../errors';
import {
  compileClassMembership,
  compileContractPredicate,
  compileExprPredicate,
} from '../expr/compile';
import { type ExprEvalScope, evalExpr } from '../expr/eval';
import { CORE_COLUMN, type CompileCtx, castedExpr } from '../query/compile-ast';
import { DEFAULT_TIMEZONE } from '../query/context';
import type { RegistrySnapshot } from '../registry/load';
import { builtinSubscription } from './registry';
import { toWireEntity } from '../wire';

export const BUDGET_SUBSCRIPTION_ID = 'orbis/budget-overview';

/**
 * Горизонт Coming up и материализации — 14 дней (01-arch §5.4). ЕДИНСТВЕННЫЙ экземпляр числа:
 * движок подставляет его подписке параметром `horizon_end`, а конвейер §2.8 (`preparePeriod` в
 * `budget/aggregates.ts`) материализует ровно это окно — разъедься они, список `coming_up`
 * спрашивал бы окно, которого материализация не заполнила, и владелец увидел бы дыру в
 * предстоящих списаниях. Дом — здесь, а не в оракуле: `aggregates.ts` импортирует ЭТОТ модуль
 * (обёртки), обратный импорт замкнул бы цикл.
 */
export const HORIZON_DAYS = 14;

/** Разделитель частей ключа сортировки — U+0000, как у оракула: на любом печатном символе
 *  порядок разъехался бы на титулах с общим префиксом («Еда» и «Еда и напитки»). */
const KEY_SEP = String.fromCharCode(0);

type EntityRow = typeof entities.$inferSelect;
type SumLedger = Extract<BudgetSubscription['aggregates'][string], { kind: 'sum' }>;

export interface BudgetArgs {
  month: string;
  today: string;
}

/**
 * Аргументы ведомостей ВНУТРИ движка. Валюта по умолчанию — НЕ поле `BudgetArgs`: его форму реестр
 * закрепил как `{month, today}`, и внешние читатели зовут движок ровно так. Валюту читает
 * `budgetOverviewOf` (`defaultCurrencyOf`) и передаёт вглубь этим типом; в `CompileCtx` поля под неё
 * нет и заводить его нельзя — контекст компиляции общий с Q, а валюта владельца к разбору запроса
 * отношения не имеет.
 *
 * `defaults` — карта умолчаний ЧТЕНИЯ из реестра (Р-К-29): движок обязан передать её в ОБА
 * вычислителя декларации (`envelopeLedgers`, `runList`), иначе `planned = false` в SQL отвечал бы
 * «да», а в интерпретаторе — «нет».
 */
export interface LedgerArgs extends BudgetArgs {
  defaultCurrency: string;
  defaults: ReadonlyMap<string, ExprScalar>;
}

export interface LedgerPlan {
  sources: { movementIds: SQL; envelopeIds: SQL };
  aggregates: Map<string, SQL | ExprNode>;
}

/**
 * Карта умолчаний ЧТЕНИЯ для интерпретатора E (`ExprEvalScope.defaults`): id свойства → значение.
 * Сегодня `default` объявляют только boolean-свойства, и SQL-бэкенд подставляет его через
 * `castedExpr`; без той же карты в интерпретаторе одно выражение `planned = false` отвечало бы в
 * двух бэкендах по-разному. Считается один раз на снимок (`runLedgers`) и едет в оба вычислителя
 * декларации полем `LedgerArgs.defaults`.
 */
export function propertyDefaultsOf(
  reg: Pick<RegistrySnapshot, 'properties'>,
): ReadonlyMap<string, ExprScalar> {
  const defaults = new Map<string, ExprScalar>();
  for (const [id, def] of reg.properties) {
    if (def.type.kind === 'boolean' && def.type.default !== undefined) {
      defaults.set(id, def.type.default);
    }
  }
  return defaults;
}

/**
 * Индекс привязок — МЕМО ПО СНИМКУ. `bindingIndexOf` пересобирает индекс с нуля (сортировка
 * аспектов, разбор каждой привязки), а движок спрашивает его на каждый слот каждой ведомости и на
 * каждую строку: на 480 конвертах это тысячи пересборок одного и того же. Ключ — сам снимок:
 * `effectiveRegistry` отдаёт кешированный объект, и новая версия реестра — это новый объект.
 */
const INDEX_BY_SNAPSHOT = new WeakMap<object, BindingIndex>();
function bindingsOf(reg: RegistrySnapshot): BindingIndex {
  const cached = INDEX_BY_SNAPSHOT.get(reg);
  if (cached !== undefined) return cached;
  const built = bindingIndexOf({ aspects: reg.aspects, contracts: reg.contracts });
  INDEX_BY_SNAPSHOT.set(reg, built);
  return built;
}

/** Копии `monthRange`/`shiftMonth` оракула, а не импорт: `aggregates.ts` зовёт ЭТОТ модуль
 *  обёртками, и обратный импорт замкнул бы цикл. Всё, что нужно обоим по СУЩЕСТВУ (карточка
 *  категории), вынесено третьим файлом (`budget/categories.ts`); календарь правилом не является —
 *  `exact_calendar_month` §3.5 живёт в `rolloverCreate` и читает свой параметр из декларации. */
function monthRangeOf(month: string): { start: string; end: string } {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return { start: `${month}-01`, end: new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10) };
}
function shiftMonthOf(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const total = y * 12 + (m - 1) + delta;
  return `${String(Math.floor(total / 12)).padStart(4, '0')}-${String((total % 12) + 1).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Фаза 1 и компиляция ведомостей
// ---------------------------------------------------------------------------

/**
 * Значение слота контракта у строки: COALESCE по привязкам, каждая — под своим аспектом.
 * Предикатный компилятор отдаёт УСЛОВИЕ, а ведомости нужна ВЕЛИЧИНА (сумма, ключ группировки,
 * валюта), поэтому приём свой, но каст — общий: `castedExpr` того же реестра, что у Q (второй
 * экземпляр каста разошёлся бы с Q на первой правке типа). Порядок привязок — из `byContract`
 * (ранг аспекта): он уезжает в SQL, значит обязан быть одним и тем же в каждом процессе.
 */
function slotExpr(slot: string, contract: string, cctx: CompileCtx, row: SQL): SQL {
  const parts: SQL[] = [];
  for (const b of bindingsOf(cctx.reg).byContract(contract)) {
    const propertyId = b.bind[slot];
    const type = propertyId === undefined ? undefined : cctx.reg.properties.get(propertyId)?.type;
    const fixed = b.fixed[slot];
    const value =
      propertyId !== undefined && type !== undefined
        ? castedExpr(sql`${row}.props->>${propertyId}`, type)
        : fixed !== undefined
          ? sql`${String(fixed)}`
          : undefined;
    // §Б2-3: привязка без этого слота просто не участвует — это законная частичная привязка.
    if (value !== undefined) {
      parts.push(sql`CASE WHEN ${row}.aspects @> ARRAY[${b.aspectId}]::text[] THEN ${value} END`);
    }
  }
  // Слот не связан НИ ОДНОЙ привязкой — значения нет, и это NULL, а не отказ: на этом стоит гейт
  // §С8-18 (у аспекта гейта нет ни `currency`, ни `planned`).
  if (parts.length === 0) return sql`NULL`;
  return parts.length === 1 ? (parts[0] as SQL) : sql`COALESCE(${sql.join(parts, sql`, `)})`;
}

/** `ARRAY[$1, $2, …]::uuid[]` — сырое `= ANY($1::uuid[])` с JS-массивом драйвер роняет
 *  «malformed array literal». */
function uuidArray(ids: readonly string[]): SQL {
  if (ids.length === 0) return sql`ARRAY[]::uuid[]`;
  return sql`ARRAY[${sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  )}]::uuid[]`;
}

/**
 * Ведомость `kind:'sum'` фазы 2. Три формы, все три — из декларации: `bound_via` → JOIN по ребру
 * привязки; `unbound_via` → NOT EXISTS того же ребра; ни того, ни другого → прямая сумма периода.
 *
 * `window: 'envelope_period'` при `bound_via` второго условия по датам НЕ добавляет: период уже
 * сказан ребром (селектор §2.3 ставит привязку только внутрь периода конверта), и второй экземпляр
 * того же условия был бы вторым мнением о смысле ребра — ровно урок C1 задачи 7a (расхождение
 * множеств у двух читателей стоило владельцу двойного счёта).
 */
function sumLedgerSql(
  agg: SumLedger,
  def: BudgetSubscription,
  cctx: CompileCtx,
  args: LedgerArgs,
  movement: SQL,
  envelopeIds: readonly string[],
): SQL {
  const e = sql.raw('e');
  const mv = def.sources.movement.contract;
  const env = def.sources.envelope.contract;
  const cur = (row: SQL, contract: string) =>
    sql`coalesce(${slotExpr('currency', contract, cctx, row)}, ${args.defaultCurrency})`;
  const value = sql`(${slotExpr(agg.of.slot, mv, cctx, e)})::numeric`;
  const where: SQL[] = [sql`e.owner_id = ${cctx.ownerId}`, sql`NOT e.archived`, movement];
  if (agg.where !== undefined) {
    where.push(compileExprPredicate(agg.where, { cctx, contract: mv, row: e }));
  }
  if (agg.window === 'period') {
    // Верхняя граница «не позже сегодня» тут НЕ повторяется: она уже сказана набором `facts`
    // (`date <= $today`), и второй экземпляр того же условия был бы вторым мнением о том, что
    // такое факт, — ровно урок C1 задачи 7a.
    const { start, end } = monthRangeOf(args.month);
    const date = slotExpr('date', mv, cctx, e);
    where.push(sql`${date} >= ${start}`, sql`${date} <= ${end}`);
  }
  if (agg.currency === 'owner_default_only')
    where.push(sql`${cur(e, mv)} = ${args.defaultCurrency}`);
  if (agg.bound_via !== undefined) {
    return sql`SELECT r.source_id AS key, coalesce(sum(${value}), 0)::text AS total
      FROM relations r JOIN entities env ON env.id = r.source_id JOIN entities e ON e.id = r.target_id
      WHERE r.role = ${agg.bound_via} AND r.source_id = ANY(${uuidArray(envelopeIds)})
        AND ${sql.join(where, sql` AND `)}
        AND ${cur(e, mv)} = ${cur(sql.raw('env'), env)}
      GROUP BY r.source_id`;
  }
  if (agg.unbound_via !== undefined) {
    // §Б5-4 №5 «живой конверт» — из `alive` декларации, не из кода. Конверт узнаётся КОНТРАКТОМ
    // (аспект + обязательные слоты), а не голым аспектом, как у оракула: структурно битый конверт
    // перестаёт прятать трату от Unbudgeted. Перемена названа вслух; на фикстуре и в проде не
    // наблюдаема — валидность конверта держит исполнитель.
    where.push(sql`NOT EXISTS (SELECT 1 FROM relations rb JOIN entities p ON p.id = rb.source_id
      WHERE rb.target_id = e.id AND rb.role = ${agg.unbound_via}
        AND ${compileContractPredicate(env, { const: true }, cctx, sql.raw('p'))}
        ${agg.alive ? sql` AND NOT p.archived` : sql``})`);
  }
  const key = agg.group_by === undefined ? sql`''` : slotExpr(agg.group_by.slot, mv, cctx, e);
  return sql`SELECT ${key} AS key, coalesce(sum(${value}), 0)::text AS total FROM entities e
             WHERE ${sql.join(where, sql` AND `)} GROUP BY 1 ORDER BY 1`;
}

/**
 * Фаза 1 (`sources.envelopeIds`) и компиляция всех ведомостей.
 *
 * `envelopeIds` — ЧЕТВЁРТЫЙ параметр, а не поле плана: фаза 2 обязана знать id, полученные фазой 1,
 * а drizzle не умеет подставлять placeholder в готовый `SQL` задним числом. Вызывающий планирует
 * ДВАЖДЫ (планирование — чистая сборка SQL, без запросов): первый раз ради `sources.envelopeIds`,
 * второй — с ответом фазы 1. Умолчание `[]` даёт `= ANY(ARRAY[]::uuid[])`, то есть честно пустую
 * ведомость, а не «все конверты».
 *
 * Окно периода строится ЗДЕСЬ, а не в декларации: параметры `period_start`/`period_end` объявлены
 * подпиской, но ни одна E-позиция их не читает (Ф-Б1-26) — отбор конвертов и есть эта фаза.
 * Предикат пишется `compileContractPredicate`, а не `compileExprPredicate`: он разворачивает
 * условие по ВСЕМ привязкам контракта (у `compileExprPredicate` привязки на руках нет, и `{slot}`
 * в нём незаконен) и заодно требует обязательные слоты — то же, что оракул делает разбором
 * `rawEnvelopeOf` («структурно битый конверт не роняет Overview»).
 */
export function planLedgers(
  def: BudgetSubscription,
  cctx: CompileCtx,
  args: LedgerArgs,
  envelopeIds: readonly string[] = [],
  envelopeFilter?: ExprNode,
): LedgerPlan {
  const { start, end } = monthRangeOf(args.month);
  const e = sql.raw('e');
  const env = def.sources.envelope.contract;
  const mv = def.sources.movement.contract;
  const window: ExprNode[] = [
    { op: '<=', args: [{ slot: 'period_start' }, { const: end }] },
    { op: '>=', args: [{ slot: 'period_end' }, { const: start }] },
  ];
  // Сужение читателя (Ф-Б1-39) — ТЕМ ЖЕ предикатом контракта, а не вторым запросом рядом: экран
  // категории и fast-path обязаны видеть ровно то подмножество конвертов, которое видит карточка.
  if (envelopeFilter !== undefined) window.push(envelopeFilter);
  const intersectsMonth: ExprNode = { op: 'and', args: window };
  const envelopes = sql`SELECT e.id FROM entities e
    WHERE e.owner_id = ${cctx.ownerId} AND NOT e.archived
      AND ${compileContractPredicate(env, intersectsMonth, cctx, e)}`;
  const movementIds = sql`${compileContractPredicate(mv, { const: true }, cctx, e)}
      AND ${compileClassMembership(mv, def.sources.movement.counted_set, cctx, e)}`;
  const aggregates = new Map<string, SQL | ExprNode>();
  for (const [name, agg] of Object.entries(def.aggregates)) {
    aggregates.set(
      name,
      agg.kind === 'formula'
        ? agg.expr
        : sumLedgerSql(agg, def, cctx, args, movementIds, envelopeIds),
    );
  }
  return { sources: { movementIds, envelopeIds: envelopes }, aggregates };
}

/**
 * Ключ ведомости: у СТАТУС-слота — КЛАСС контракта, у прочих слотов — сырое значение.
 * Почему: `expense` у `orbis/financial` и `out` у аспекта владельца — один класс `outflow`, и
 * группировка по сырому значению рассыпала бы баланс по аспектам. Это и есть гейт §С8-18.
 */
function classKeyOf(
  cctx: CompileCtx,
  contract: string,
  slot: string | undefined,
  raw: string | null,
): string {
  if (raw === null) return '';
  if (slot === undefined) return raw;
  const def = cctx.reg.contracts.get(contract);
  const isStatus = def?.kind === 'slots' && def.slots.some((s) => s.name === slot && s.status);
  if (!isStatus) return raw; // `category` — `ref`: ключ остаётся сырым id
  for (const b of bindingsOf(cctx.reg).byContract(contract)) {
    const cls = b.classOfVariant.get(slot)?.get(raw);
    if (cls !== undefined) return cls;
  }
  // Вариант без класса ловит `VARIANT_UNMAPPED` НА ЗАПИСИ (§С1-2); в чтении он остаётся собой, а
  // не схлопывается молча в чужой класс.
  return raw;
}

/**
 * Исполнение одной ведомости-суммы: ключи сведены, суммы нормализованы к канону «0.00».
 * План ведомости строится ЗДЕСЬ, по переданным id конвертов, — так один вход считает и всю фазу 2
 * (`runLedgers` отдаёт все id), и только промахи кэша (`runSumCached` задачи 11 отдаёт их
 * подмножество); второго способа получить ведомость по подмножеству конвертов в движке нет.
 * `planLedgers` — чистая компиляция без обращения к БД, её повторный вызов на ведомость ничего не
 * стоит.
 */
async function runSum(
  tx: Tx,
  cctx: CompileCtx,
  def: BudgetSubscription,
  la: LedgerArgs,
  name: string,
  envIds: readonly string[],
): Promise<Map<string, string>> {
  const agg = def.aggregates[name];
  const slot = agg?.kind === 'sum' ? agg.group_by?.slot : undefined;
  const query = planLedgers(def, cctx, la, envIds).aggregates.get(name);
  // Формулы лежат в плане `ExprNode`'ом и считаются интерпретатором (`envelopeLedgers`); сумма без
  // SQL — ошибка построения плана, а не «пустой ответ».
  if (!(query instanceof SQL)) {
    throw new ExecError('INVARIANT', `ведомость «${name}» не является SQL-суммой`, {
      subscription: BUDGET_SUBSCRIPTION_ID,
      aggregate: name,
    });
  }
  const rows = (await tx.execute(query)) as unknown as Array<{
    key: string | null;
    total: string;
  }>;
  const out = new Map<string, string>();
  for (const r of rows) {
    const key = classKeyOf(cctx, def.sources.movement.contract, slot, r.key);
    // Два варианта ОДНОГО класса приезжают двумя строками (`expense` встроенного аспекта и `out`
    // аспекта владельца), и на сведении их надо СКЛАДЫВАТЬ: перезапись потеряла бы половину
    // баланса месяца ровно у того владельца, ради которого §С8-18 и затевался.
    out.set(key, decAdd(out.get(key) ?? '0', r.total));
  }
  return out;
}

/**
 * Материализуемые ведомости: декларация ВЕЛИТ (`materialize: true`) И аспект-конверт
 * ПУБЛИКУЕТ величину (`aggregations[name].published`, §4.3 PRD). Два условия, потому что
 * это два разных утверждения: «её дорого считать» — свойство ведомости, «её видно снаружи»
 * — свойство аспекта. Кэшировать непубличную величину значило бы держать строку, которую
 * никто не спросит, а материализовать публичную без разрешения декларации — включить
 * кэш кодом там, где спека дала декларацию.
 *
 * `scope: 'envelope'` — третье условие и оно же граница возможного: строка кэша ключуется
 * конвертом, а ведомость периода (`period_balance`, `unbudgeted`) группируется по значению
 * слота, и класть её в ту же таблицу было бы подменой ключа.
 */
export function materializedAggregatesOf(
  def: BudgetSubscription,
  reg: RegistrySnapshot,
): ReadonlySet<string> {
  const published = new Set<string>();
  for (const binding of bindingsOf(reg).byContract(def.sources.envelope.contract)) {
    const aspect = reg.aspects.get(binding.aspectId);
    for (const [name, decl] of Object.entries(aspect?.aggregations ?? {})) {
      if (decl.published) published.add(name);
    }
  }
  const out = new Set<string>();
  for (const [name, agg] of Object.entries(def.aggregates)) {
    if (agg.kind === 'sum' && agg.materialize && agg.scope === 'envelope' && published.has(name)) {
      out.add(name);
    }
  }
  return out;
}

/**
 * Ведомость-сумма ЧЕРЕЗ КЭШ (§Б5-5, приёмка §С8-16) — НАДСТРОЙКА над `runSum`, а не его
 * замена: попадания берутся строками `(envelope_id, as_of)`, промахи считает ТОТ ЖЕ SQL
 * ведомости. Второго счёта денег не появляется по построению — в кэш попадает ровно то
 * число, которое вернул бы движок без него.
 *
 * Ключ дня — `cctx.today`: набор `facts` отбирает движения условием `date <= $today`, то
 * есть значение ведомости зависит ровно от пары (конверт, сегодня), а не от месяца запроса.
 *
 * ЗАМОК КОНТУРА БЕРЁТСЯ ТОЛЬКО НА ПРОМАХЕ, и он здесь не перестраховка. Без него возможен
 * порядок: читатель посчитал 100 → писатель закоммитил +50 и попытался инкрементировать
 * строку, которой ещё нет (ноль задетых строк) → читатель вставил 100. Кэш остался бы
 * враньём на 50 до следующей инвалидации, а это деньги на экране владельца. Писатели держат
 * этот же замок всю свою транзакцию (`lockBudgetContour`, `executor.ts`), поэтому захват
 * ДО пересчёта выстраивает обе стороны в одну очередь. На прогретом кэше замок не берётся
 * вовсе — то есть массовое чтение писателям не мешает.
 */
async function runSumCached(
  tx: Tx,
  ownerId: string,
  cctx: CompileCtx,
  def: BudgetSubscription,
  la: LedgerArgs,
  name: string,
  envIds: readonly string[],
): Promise<Map<string, string>> {
  if (!materializedAggregatesOf(def, cctx.reg).has(name))
    return runSum(tx, cctx, def, la, name, envIds);
  // Версии берутся ИЗ СНИМКА транзакции, а не отдельным SELECT'ом: снимок и есть тот
  // реестр, по которому скомпилирован план, и спрашивать версию второй раз значило бы
  // допустить пару «план по одной версии, ключ по другой».
  const versions = { ownerVersion: cctx.reg.ownerVersion, systemVersion: cctx.reg.systemVersion };
  const asOf = cctx.today;
  const cached = await readSpentCache(
    tx,
    ownerId,
    envIds.map((envelopeId) => ({ envelopeId, asOf })),
    versions,
  );
  const out = new Map<string, string>();
  const misses: string[] = [];
  for (const id of envIds) {
    const hit = cached.get(spentCacheKey({ envelopeId: id, asOf }));
    if (hit === undefined) misses.push(id);
    else out.set(id, hit);
  }
  if (misses.length === 0) return out;

  await lockOwnerBudget(tx, ownerId);
  const computed = await runSum(tx, cctx, def, la, name, misses);
  // Нули пишутся ТОЖЕ: конверт без трат — такой же ответ, и без строки он промахивался бы
  // при каждом чтении, то есть кэш не работал бы ровно на пустом месяце.
  //
  // Нуль пишется КАНОНОМ `'0.00'`, а не `'0'`, и это не косметика. Без кэша конверт без трат
  // не приезжает в карту `runSum` вовсе, и канон ему подставляет ЧИТАТЕЛЬ (`runLedgers`:
  // `?? '0.00'`). Кэш отвечает за КАЖДЫЙ конверт, читатель до его подстановки не доходит, и
  // «0» уехало бы в карточку владельца вместо «0.00» — то есть кэш изменил бы видимый ответ.
  // `numeric` масштаб сохраняет (`'0.00'::numeric::text` = `0.00`), поэтому канон переживает
  // и запись, и инкремент.
  await writeSpentCache(
    tx,
    ownerId,
    misses.map((envelopeId) => ({ envelopeId, asOf, spent: computed.get(envelopeId) ?? '0.00' })),
    versions,
  );
  for (const id of misses) out.set(id, computed.get(id) ?? '0.00');
  return out;
}

// ---------------------------------------------------------------------------
// Формулы, фазы, порог
// ---------------------------------------------------------------------------

/**
 * Привязка конверта — ЕГО аспектом. Два аспекта одного владельца, реализующих контракт конверта, —
 * `SLOT_AMBIGUOUS` (§С8-21): молчаливый выбор первого дал бы владельцу лимит из аспекта, о котором
 * он не думал.
 */
function bindingForEntity(
  cctx: CompileCtx,
  contract: string,
  aspects: readonly string[],
): ResolvedBinding | undefined {
  const found = bindingsOf(cctx.reg)
    .byContract(contract)
    .filter((b) => aspects.includes(b.aspectId));
  if (found.length > 1) {
    throw new ExecError('SLOT_AMBIGUOUS', `у записи два аспекта, реализующих «${contract}»`, {
      subscription: BUDGET_SUBSCRIPTION_ID,
      contract,
      aspects: found.map((b) => b.aspectId),
    });
  }
  return found[0];
}

/**
 * Значения строки для интерпретатора: ключ — id свойства, core-поля лежат ЗДЕСЬ ЖЕ под своими id
 * (договор `ExprEvalScope.props`). Таймстампы приводятся к ISO-строке: интерпретатор работает над
 * скалярами E, а `Date` в его области был бы третьим родом значения.
 */
function propsForEval(row: EntityRow): Record<string, unknown> {
  const core: Record<string, unknown> = {
    'orbis/title': row.title,
    'orbis/archived': row.archived,
    'orbis/created_at': row.createdAt.toISOString(),
    'orbis/updated_at': row.updatedAt.toISOString(),
  };
  for (const id of Object.keys(core)) {
    if (CORE_COLUMN[id] === undefined) delete core[id]; // сторож против расхождения с картой Q
  }
  return { ...(row.props as Record<string, unknown>), ...core };
}

/** Значение слота у записи — через привязку ЕЁ аспекта: `bind` (свойство), затем `fixed`. */
function slotValueOf(
  binding: ResolvedBinding | undefined,
  props: Record<string, unknown>,
  slot: string,
): unknown {
  if (binding === undefined) return undefined;
  const prop = binding.bind[slot];
  return prop !== undefined ? props[prop] : binding.fixed[slot];
}

/** Ключ остатка §Б5-4: `active` — то, что не отобрали прочие фазы (валидатор требует его наличия). */
const REMAINDER_PHASE = 'active';

/**
 * Фаза конверта — ПРАВИЛО Ф-Б1-37, а не проход по ключам.
 *
 * Колонка `definition` объявлена `jsonb`, а jsonb ПЕРЕУПОРЯДОЧИВАЕТ ключи объекта (длина, затем
 * байты): «порядок ключей = порядок вычисления» §Б5-3 до движка не доезжает вовсе. Из базы
 * `active` («остаток», `{const:true}`) приходит ПЕРВЫМ, и наивный проход объявил бы активным
 * каждый конверт, включая закрытые и будущие, — то есть показал бы владельцу темп трат по
 * периодам, которых нет.
 *
 * Отсюда два правила. (1) `active` — объявленный ОСТАТОК и проверяется последним; выражение его
 * при этом всё равно вычисляется — остаток про ПОРЯДОК, а не про право декларации сказать здесь
 * что-то своё. (2) Прочие фазы ОБЯЗАНЫ быть взаимоисключающими, и это проверяется на каждом
 * конверте: две истинные — ОТКАЗ с их именами, а не «короткая первой». Молчаливый выбор по длине
 * ключа означал бы, что смысл декларации владельца зависит от того, как он назвал фазу.
 *
 * Отказ — `VALIDATION` с причиной, а не `INVARIANT`: перекрытие пишет владелец дельтой, и он же
 * его чинит. Соседний `INVARIANT` ниже — про другое: он недостижим, пока валидатор требует ключ
 * `active` (`SUBSCRIPTION_PHASE_ACTIVE_MISSING`), и остаётся сторожем самого движка.
 */
function phaseOf(def: BudgetSubscription, scope: ExprEvalScope): string {
  const hit: string[] = [];
  for (const [key, expr] of Object.entries(def.phases)) {
    if (key === REMAINDER_PHASE) continue;
    if (evalExpr(expr, scope) === true) hit.push(key);
  }
  if (hit.length > 1) {
    // Имена сортируются: порядок ключей из jsonb непредсказуем, а сообщение об отказе обязано быть
    // одним и тем же на двух прогонах — иначе владелец сравнивает несравнимое.
    throw new ExecError(
      'VALIDATION',
      `фазы декларации перекрываются на конверте: ${[...hit].sort().join(', ')}`,
      {
        reason: 'SUBSCRIPTION_PHASES_OVERLAP',
        subscription: BUDGET_SUBSCRIPTION_ID,
        phases: [...hit].sort(),
      },
    );
  }
  if (hit.length === 1) return hit[0] as string;
  const remainder = def.phases[REMAINDER_PHASE];
  if (remainder !== undefined && evalExpr(remainder, scope) === true) return REMAINDER_PHASE;
  throw new ExecError(
    'INVARIANT',
    'фазы декларации не покрыли конверт — ключ active обязан быть остатком',
    { subscription: BUDGET_SUBSCRIPTION_ID },
  );
}

/** Имена величин, которые читает выражение: узлы `{agg}` где угодно в дереве. */
function aggRefsOf(node: unknown, out: Set<string>): void {
  if (Array.isArray(node)) {
    for (const child of node) aggRefsOf(child, out);
    return;
  }
  if (typeof node !== 'object' || node === null) return;
  const record = node as Record<string, unknown>;
  if (typeof record.agg === 'string') out.add(record.agg);
  for (const child of Object.values(record)) aggRefsOf(child, out);
}

/**
 * Порядок вычисления формул — ПО ИХ ССЫЛКАМ ДРУГ НА ДРУГА, а не по порядку ключей декларации.
 * Причина та же, что у `phaseOf`: `jsonb` переупорядочивает ключи, и `remaining` приезжает из базы
 * РАНЬШЕ `effective_limit`, на который ссылается. Порядок ключей — свойство текста декларации, а
 * движок читает её из колонки; единственное, что переживает хранение, — сами ссылки.
 *
 * Цикл сюда доехать не должен (тайп-чекер ловит его при сохранении, `EXPR_RECURSION`), но остаётся
 * INVARIANT'ом, а не молчаливым пропуском: недосчитанная величина ушла бы в провод как `null`.
 */
function formulaOrderOf(def: BudgetSubscription, seeded: ReadonlySet<string>): string[] {
  // Посеянное считать не надо: `spent` пришёл суммой, а после rollup посеяны и величины
  // `applies_to` — их значение дерева ОКОНЧАТЕЛЬНО и пересчёту не подлежит.
  const pending = Object.entries(def.aggregates).filter(
    ([name, a]) => a.kind === 'formula' && !seeded.has(name),
  );
  const deps = new Map<string, Set<string>>();
  for (const [name, agg] of pending) {
    const refs = new Set<string>();
    if (agg.kind === 'formula') aggRefsOf(agg.expr, refs);
    // Ссылки на уже посчитанное (суммы и посеянный rollup) порядка не задают.
    deps.set(name, new Set([...refs].filter((r) => !seeded.has(r) && r !== name)));
  }
  const order: string[] = [];
  const done = new Set<string>(seeded);
  while (order.length < pending.length) {
    const next = pending.find(
      ([name]) => !done.has(name) && [...(deps.get(name) ?? [])].every((d) => done.has(d)),
    );
    if (next === undefined) {
      throw new ExecError(
        'INVARIANT',
        'формулы ведомостей ссылаются по кругу либо на неизвестную величину',
        {
          subscription: BUDGET_SUBSCRIPTION_ID,
          pending: pending.map(([n]) => n).filter((n) => !done.has(n)),
        },
      );
    }
    order.push(next[0]);
    done.add(next[0]);
  }
  return order;
}

/**
 * Формулы считаются в порядке СВОИХ ССЫЛОК (`formulaOrderOf`): `remaining` читает
 * `{agg:'effective_limit'}` и `{agg:'spent'}`, `daily_pace` — `{agg:'remaining'}`.
 *
 * Уже посеянное — ОКОНЧАТЕЛЬНО: так rollup кладёт сумму дерева в `effective_limit`, и
 * `remaining`/`daily_pace` считаются от НЕЁ, а не от своего конверта (ровно то, что делает оракул,
 * пересобирая `statusOf` на агрегированных величинах).
 *
 * Фаза — ЗНАЧЕНИЕ ведомости под служебным ключом `__phase`: поле `phase` строки провода читает его,
 * а узел `{phase:'active'}` внутри `daily_pace` — `scope.phase`. Одно вычисление, два читателя.
 * Двойное подчёркивание с именем декларации не столкнётся: ключи ведомостей проходят `SLOT_KEY_RE`,
 * а он подчёркивание в начале не пускает.
 */
const PHASE_KEY = '__phase';

function envelopeLedgers(
  def: BudgetSubscription,
  binding: ResolvedBinding | undefined,
  props: Record<string, unknown>,
  seed: Record<string, ExprScalar>,
  args: LedgerArgs,
): Record<string, ExprScalar> {
  const { start, end } = monthRangeOf(args.month);
  const scope: ExprEvalScope = {
    params: {
      period_start: start,
      period_end: end,
      horizon_end: addDays(args.today, HORIZON_DAYS),
    },
    aggs: { ...seed },
    phase: null,
    props,
    binding,
    today: args.today,
    defaults: args.defaults,
  };
  scope.phase = phaseOf(def, scope);
  scope.aggs[PHASE_KEY] = scope.phase;
  for (const name of formulaOrderOf(def, new Set(Object.keys(scope.aggs)))) {
    const agg = def.aggregates[name];
    if (agg?.kind === 'formula') scope.aggs[name] = evalExpr(agg.expr, scope) as ExprScalar;
  }
  return scope.aggs;
}

/** Порог §6.1 из декларации: spent ≥ warn_at × effective_limit; граница — по `inclusive`. */
function isAlert(def: BudgetSubscription, spent: string, limit: string): boolean {
  const cmp = decCmp(spent, decMul(limit, def.alerts.warn_at)); // 17/20 = 0.85 точно: decMul без float
  return def.alerts.inclusive ? cmp >= 0 : cmp > 0;
}

/**
 * ЧТО с чем сравнивает порог, §Б5-4 не говорит: `alerts` несёт долю, но не операнды. Движок берёт
 * единственную ведомость-сумму конверта (`scope:'envelope'` + `bound_via`) числителем и ту из
 * `rollup.applies_to`, которая не она, — знаменателем: обе величины уже названы декларацией.
 *
 * Выбор здесь ОДНОЗНАЧЕН не по удаче, а потому что неоднозначность отклоняется НА ЗАПИСИ
 * (Ф-Б1-38, `assertAlertOperands` в `subscriptions/registry.ts`): вторая сумма конверта с
 * `bound_via` и `rollup.applies_to` без числителя либо длиннее двух — отказ валидатора. Отказ
 * ниже остаётся сторожем самого движка на случай декларации, приехавшей мимо валидатора.
 *
 * Явное поле `alerts.of/against` — ОВ-Б1-4 (вопрос владельцу: ассет спеки несёт `alerts.when`,
 * схема §1.6 — нет); задача 16 либо Б-2. Тела правил это не тронет.
 */
function alertOperands(def: BudgetSubscription): { spent: string; limit: string } {
  const spent = Object.entries(def.aggregates).find(
    ([, a]) => a.kind === 'sum' && a.scope === 'envelope' && a.bound_via !== undefined,
  )?.[0];
  const limit = def.rollup.applies_to.find((n) => n !== spent);
  if (spent === undefined || limit === undefined) {
    throw new ExecError('INVARIANT', 'декларация Budget не называет операнды порога §6.1', {
      subscription: BUDGET_SUBSCRIPTION_ID,
    });
  }
  return { spent, limit };
}

/** Имена двух ведомостей периода — по СТРОЕНИЮ (`unbound_via`), а не по имени в декларации. */
function periodLedgerNames(def: BudgetSubscription): { balance: string; unbudgeted: string } {
  const period = Object.entries(def.aggregates).filter(
    (entry): entry is [string, SumLedger] => entry[1].kind === 'sum' && entry[1].scope === 'period',
  );
  const balance = period.find(([, a]) => a.unbound_via === undefined)?.[0];
  const unbudgeted = period.find(([, a]) => a.unbound_via !== undefined)?.[0];
  if (balance === undefined || unbudgeted === undefined) {
    throw new ExecError('INVARIANT', 'декларация Budget обязана нести обе ведомости периода', {
      subscription: BUDGET_SUBSCRIPTION_ID,
    });
  }
  return { balance, unbudgeted };
}

// ---------------------------------------------------------------------------
// Дерево категорий и порядок карточек
// ---------------------------------------------------------------------------

/**
 * Дерево `rollup.role` — РОВНО эта роль (`subitem` между категориями агрегат не наполняет). Гейт
 * оракула «оба конца — `orbis/category`» НЕ повторяется: это второе мнение о роли, а роли §А4-3 и
 * заведены, чтобы смыслы не путались; выразить его подпиской нечем — контракта «категория» в Б-1
 * нет. Наблюдаемая разница: чтобы ребро от НЕ-категории повлияло на карточку, владельцу надо ещё и
 * направить на неё конверт слотом `category`.
 */
async function rollupEdges(tx: Tx, ownerId: string, role: string): Promise<Map<string, string[]>> {
  const rows = (await tx.execute(sql`
    SELECT r.source_id, r.target_id FROM relations r
    JOIN entities s ON s.id = r.source_id
    WHERE r.role = ${role} AND s.owner_id = ${ownerId}`)) as unknown as Array<{
    source_id: string;
    target_id: string;
  }>;
  const children = new Map<string, string[]>();
  for (const r of rows)
    children.set(r.source_id, [...(children.get(r.source_id) ?? []), r.target_id]);
  return children;
}

/** Все потомки (рекурсивно); visited-set страхует от цикла в данных — как `descendantsOf` оракула. */
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

interface RawEnvelope {
  row: EntityRow;
  props: Record<string, unknown>;
  binding: ResolvedBinding | undefined;
  categoryRef: string;
  currency: string;
  phase: string;
  /** Суммы ЭТОГО конверта — семена обоих вычислений (свои величины и величины карточки). */
  sums: Record<string, ExprScalar>;
  /** Ведомости СВОЕГО конверта — на них считает порог (`on_raw`). */
  raw: Record<string, ExprScalar>;
  /** Ведомости карточки — после rollup дерева (§2.10). */
  card: Record<string, ExprScalar>;
}

/** Ключ порядка карточек из `cards.order_by`. */
function cardKey(def: BudgetSubscription, e: RawEnvelope, cats: Map<string, CategoryInfo>): string {
  return def.cards.order_by
    .map((part) => {
      if ('deref' in part) {
        const ref = slotValueOf(e.binding, e.props, part.deref.slot);
        // Один шаг и только core-заголовок (§Б3-3): цепочка ссылок здесь невыразима намеренно.
        if (part.deref.read !== 'orbis/title') {
          throw new ExecError('VALIDATION', 'deref порядка карточек читает только core-заголовок', {
            reason: 'EXPR_BACKEND_UNSUPPORTED',
            subscription: BUDGET_SUBSCRIPTION_ID,
            read: part.deref.read,
          });
        }
        return typeof ref === 'string' ? (cats.get(ref)?.title ?? '') : '';
      }
      if ('slot' in part) return String(slotValueOf(e.binding, e.props, part.slot) ?? '');
      return e.row.id;
    })
    .join(KEY_SEP);
}

// ---------------------------------------------------------------------------
// Провод
// ---------------------------------------------------------------------------

/**
 * Имена ведомостей → поля провода. §Б5-4 провод НЕ переименовывает: имена ведомостей — язык
 * подписки, имена полей — контракт `budgetOverviewSchema`, который читают три клиента и golden.
 * Карта одна и названа вслух, чтобы переименование ведомости не уехало в провод молча.
 */
const WIRE_FIELDS = {
  spent: 'spent',
  effective_limit: 'effectiveLimit',
  remaining: 'remaining',
  daily_pace: 'dailyPace',
} as const;

/**
 * Класс контракта денег → слово провода. Один словарь на два места: поле баланса §2.5 и
 * `direction` строки Coming up. Провод старше реформы и говорит вариантами `orbis/direction`
 * (enum `income|expense`), поэтому перевод КЛАССА в слово провода — здесь, в движке: так трата
 * аспекта владельца (`direction: 'out'` → класс `outflow`) попадает в провод правильным словом, а
 * не своим сырым вариантом. Перевод самого провода на классы — Б-2.
 */
const BALANCE_FIELDS: Record<string, 'income' | 'expense'> = {
  inflow: 'income',
  outflow: 'expense',
};

/** Строка карточки конверта: ведомости КАРТОЧКИ (после rollup) → поля провода. */
function wireEnvelope(e: RawEnvelope, cats: Map<string, CategoryInfo>): EnvelopeStatus {
  const c = cats.get(e.categoryRef);
  // Провод собирается ПО КАРТЕ имён, а не четырьмя литералами: переименуй кто-нибудь ведомость —
  // упадёт типизация карты, а не тихо занулится поле карточки.
  const wire = Object.fromEntries(
    Object.entries(WIRE_FIELDS).map(([ledger, field]) => {
      const v = e.card[ledger];
      return [field, v === undefined || v === null ? null : String(v)];
    }),
  ) as { spent: string; effectiveLimit: string; remaining: string; dailyPace: string | null };
  return {
    envelope: toWireEntity(e.row),
    category: {
      id: c?.id ?? e.categoryRef,
      title: c?.title ?? '',
      icon: c?.icon ?? null,
      color: c?.color ?? null,
    },
    ...wire,
    phase: e.phase as EnvelopeStatus['phase'],
  };
}

/** Величины строки списка — из СЛОТОВ контракта; `direction` переводится в слово провода классом. */
function wireMovement(cctx: CompileCtx, def: BudgetSubscription, row: EntityRow) {
  const mv = def.sources.movement.contract;
  const b = bindingForEntity(cctx, mv, row.aspects);
  const props = row.props as Record<string, unknown>;
  const slot = (n: string, fallback = '') => String(slotValueOf(b, props, n) ?? fallback);
  const cls = classKeyOf(cctx, mv, 'direction', slot('direction') || null);
  return {
    entity: toWireEntity(row),
    occurredOn: slot('date'),
    amount: slot('amount', '0'),
    direction: BALANCE_FIELDS[cls] ?? 'expense',
  };
}

function wirePlanned(
  cctx: CompileCtx,
  def: BudgetSubscription,
  row: EntityRow,
  cats: Map<string, CategoryInfo>,
) {
  const mv = def.sources.movement.contract;
  const b = bindingForEntity(cctx, mv, row.aspects);
  const props = row.props as Record<string, unknown>;
  const ref = String(slotValueOf(b, props, 'category') ?? '');
  return {
    entity: toWireEntity(row),
    amount: String(slotValueOf(b, props, 'amount') ?? '0'),
    categoryTitle: cats.get(ref)?.title ?? '',
  };
}

/** Бейдж §6.1 — ЕДИНСТВЕННОЕ место порога: карточка и счётчик обязаны говорить одно (§3.1 vs §6.1). */
function countAlerts(def: BudgetSubscription, raws: readonly RawEnvelope[]): number {
  const { spent, limit } = alertOperands(def);
  return raws.filter(
    (e) =>
      !def.alerts.skip_phases.includes(e.phase) &&
      isAlert(def, String(e.raw[spent] ?? '0'), String(e.raw[limit] ?? '0')),
  ).length;
}

// ---------------------------------------------------------------------------
// Исполнение: обе фазы, списки, пять читателей
// ---------------------------------------------------------------------------

interface LedgerRun {
  cctx: CompileCtx;
  la: LedgerArgs;
  raws: RawEnvelope[];
  sums: Map<string, Map<string, string>>;
}

/**
 * СУЖЕНИЕ ЧТЕНИЯ (Ф-Б1-39). Посылка брифа «цикл по месяцам дешевле одного запроса» опровергнута
 * измерением на корпусе 20k: `categoryTrendOf(12)` считал 4,4 с, потому что каждый виток гонял
 * ведомости периода (баланс и Unbudgeted по ВСЕМУ месяцу) и дерево категорий ради одной категории.
 *
 * Сужение говорит движку, ЧТО читателю нужно, а не КАК считать: подмножество конвертов (одна
 * категория, один конверт) и нужны ли ведомости периода и дерево. Ветка по имени читателя здесь не
 * появляется — все четверо зовут один `runLedgers`, и «ноль расхождений» остаётся сверкой одного
 * кода с оракулом, а не четырёх.
 *
 * Суммы КОНВЕРТА считаются всегда: их читают формулы декларации, и пропуск любой из них означал бы
 * `0.00` в позиции, где формула ждёт величину. Ведомости ПЕРИОДА пропускать безопасно — формула
 * конверта на них ссылаться не вправе (отказ валидатора, Ф-Б1-40г).
 */
interface LedgerNarrowing {
  /** Только конверты этой категории (тренд §3.2 и fast-path §4.1). */
  category?: string;
  /** Только этот конверт (fast-path §4.1 читает ровно его). */
  envelope?: string;
  /** Считать ли ведомости периода — баланс §2.5 и Unbudgeted. Умолчание — да. */
  period?: boolean;
  /** Агрегировать ли дерево категорий §2.10. Умолчание — да. */
  rollup?: boolean;
}

/**
 * Обе фазы плана и ведомости конвертов — ОДИН вход на все пять читателей (§Б5-4: карточка, бейдж,
 * тул, fast-path, тренд). Разными путями они разошлись бы на первой правке декларации, а
 * расхождение бейджа с карточкой владелец видит как враньё интерфейса (§6.1 vs §3.1 — ровно та
 * коллизия, которую владелец разбирал 2026-07-23).
 * `narrow` — сужение читателя (см. `LedgerNarrowing`): подмножество конвертов и отказ от ведомостей
 * периода и дерева там, где читателю они не нужны.
 */
async function runLedgers(
  tx: Tx,
  ownerId: string,
  args: BudgetArgs,
  def: BudgetSubscription,
  reg: RegistrySnapshot,
  narrow: LedgerNarrowing = {},
): Promise<LedgerRun> {
  const cctx: CompileCtx = {
    ownerId,
    today: args.today,
    timeZone: DEFAULT_TIMEZONE,
    reg,
    thisEntityId: null,
  };
  const la: LedgerArgs = {
    ...args,
    defaultCurrency: await defaultCurrencyOf(tx, ownerId),
    defaults: propertyDefaultsOf(reg),
  };
  const envContract = def.sources.envelope.contract;

  // ФАЗА 1 — источник с селектором: только id, дальше строки читает drizzle (тот же читатель и тот
  // же проектор, что у оракула, значит расхождение по типам колонок исключено построением).
  // Сужение по категории уходит В ЗАПРОС, а не в фильтр по ответу: на корпусе 20k это разница
  // между сорока конвертами месяца и одним-двумя.
  const filter: ExprNode | undefined =
    narrow.category === undefined
      ? undefined
      : { op: '=', args: [{ slot: 'category' }, { const: narrow.category }] };
  const all = (
    (await tx.execute(
      planLedgers(def, cctx, la, [], filter).sources.envelopeIds,
    )) as unknown as Array<{
      id: string;
    }>
  ).map((r) => r.id);
  const ids = narrow.envelope === undefined ? all : all.filter((id) => id === narrow.envelope);
  const rows =
    ids.length === 0 ? [] : await tx.select().from(entities).where(inArray(entities.id, ids));

  // ФАЗА 2 — ведомости-суммы по этим id (план каждой строит сам `runSum`, см. его докблок).
  // Суммы КОНВЕРТА считаются всегда (их читают формулы), ведомости ПЕРИОДА — по сужению.
  const sums = new Map<string, Map<string, string>>();
  for (const [name, agg] of Object.entries(def.aggregates)) {
    if (agg.kind !== 'sum') continue;
    if (agg.scope === 'period' && narrow.period === false) continue;
    // Ведомости КОНВЕРТА идут через кэш (§Б5-5): у него ключ `(конверт, сегодня)`, и
    // материализуемость решает декларация (`runSumCached` сам вернётся к `runSum`, если
    // клапан снят). Ведомости ПЕРИОДА кэш не обслуживает — у них ключ не конверт, а
    // значение слота, и класть их в ту же таблицу было бы подменой ключа.
    sums.set(
      name,
      agg.scope === 'envelope'
        ? await runSumCached(tx, ownerId, cctx, def, la, name, ids)
        : await runSum(tx, cctx, def, la, name, ids),
    );
  }

  // Ведомости конверта: сначала СВОИ (на них порог, `on_raw`), затем rollup дерева.
  const raws: RawEnvelope[] = rows.map((row) => {
    const props = propsForEval(row);
    const binding = bindingForEntity(cctx, envContract, row.aspects);
    const seed: Record<string, ExprScalar> = {};
    for (const [name, agg] of Object.entries(def.aggregates)) {
      if (agg.kind === 'sum' && agg.scope === 'envelope') {
        seed[name] = sums.get(name)?.get(row.id) ?? '0.00';
      }
    }
    const own = envelopeLedgers(def, binding, props, seed, la);
    const currency = String(slotValueOf(binding, props, 'currency') ?? la.defaultCurrency);
    return {
      row,
      props,
      binding,
      currency,
      sums: seed,
      raw: own,
      card: own,
      phase: String(own[PHASE_KEY] ?? ''),
      categoryRef: String(slotValueOf(binding, props, 'category') ?? ''),
    };
  });
  if (narrow.rollup === false) return { cctx, la, raws, sums };
  const edges = await rollupEdges(tx, ownerId, def.rollup.role);
  for (const e of raws) {
    const kin = descendantsOf(edges, e.categoryRef);
    if (kin.size === 0) continue;
    const overrides: Record<string, ExprScalar> = {};
    for (const name of def.rollup.applies_to) {
      let total = String(e.raw[name] ?? '0');
      // `mode: 'same_currency_only'` (§5): RUB и USD без конверсии не складываются.
      for (const other of raws) {
        if (other !== e && kin.has(other.categoryRef) && other.currency === e.currency) {
          total = decAdd(total, String(other.raw[name] ?? '0'));
        }
      }
      overrides[name] = total;
    }
    // Семена карточки — СВОИ суммы конверта ⊕ величины дерева, а не одни `applies_to`: формула,
    // читающая сумму конверта вне этого списка (законная декларация — вторая сумма конверта без
    // `bound_via`), иначе не нашла бы её и уронила бы Overview `INVARIANT`'ом. Величины дерева
    // кладутся ПОСЛЕ и потому окончательны.
    e.card = envelopeLedgers(def, e.binding, e.props, { ...e.sums, ...overrides }, la);
  }
  return { cctx, la, raws, sums };
}

/**
 * Список §Б5-4: тот же предикат движений, что у ведомостей, плюс конструкции языка списка — «есть
 * ребро роли» / «нет ребра роли» (П2 №3), окно по границам E и свой `where`. Ни одной ветки по
 * ИМЕНИ списка: `coming_up` и `planned` различаются РОВНО декларацией, и это проверяемо —
 * мутационный тест сьюта двигает декларацию, а не код.
 */
async function runList(
  tx: Tx,
  cctx: CompileCtx,
  def: BudgetSubscription,
  name: string,
  args: LedgerArgs,
): Promise<EntityRow[]> {
  const list = def.lists[name];
  if (list === undefined) {
    throw new ExecError('NOT_FOUND', `в декларации подписки нет списка «${name}»`, {
      subscription: BUDGET_SUBSCRIPTION_ID,
      list: name,
    });
  }
  const e = sql.raw('e');
  const mv = def.sources.movement.contract;
  const { start, end } = monthRangeOf(args.month);
  const params = {
    period_start: start,
    period_end: end,
    horizon_end: addDays(args.today, HORIZON_DAYS),
  };
  const where: SQL[] = [
    sql`e.owner_id = ${cctx.ownerId}`,
    sql`NOT e.archived`,
    compileContractPredicate(mv, { const: true }, cctx, e),
    compileClassMembership(mv, list.counted_set, cctx, e),
  ];
  const edge = (rel: { role: string; side: 'source' | 'target' }, negate: boolean): SQL => {
    const col = rel.side === 'target' ? sql.raw('rl.target_id') : sql.raw('rl.source_id');
    const exists = sql`EXISTS (SELECT 1 FROM relations rl WHERE ${col} = e.id AND rl.role = ${rel.role})`;
    return negate ? sql`NOT ${exists}` : exists;
  };
  if (list.requires_relation !== undefined) where.push(edge(list.requires_relation, false));
  if (list.excludes_relation !== undefined) where.push(edge(list.excludes_relation, true));
  if (list.window !== undefined) {
    // Границы окна считает интерпретатор E над `params` — и только он: условие по дате ВНУТРИ
    // предиката невидимо окну материализации (Р-К-12), поэтому окно живёт отдельным полем.
    const scope: ExprEvalScope = {
      params,
      aggs: {},
      phase: null,
      props: {},
      today: args.today,
      defaults: args.defaults,
    };
    const date = slotExpr('date', mv, cctx, e);
    where.push(
      sql`${date} >= ${String(evalExpr(list.window.from, scope))}`,
      sql`${date} <= ${String(evalExpr(list.window.to, scope))}`,
    );
  }
  if (list.where !== undefined) {
    where.push(compileExprPredicate(list.where, { cctx, contract: mv, row: e }));
  }
  const ids = (
    (await tx.execute(sql`SELECT e.id FROM entities e
    WHERE ${sql.join(where, sql` AND `)}`)) as unknown as Array<{ id: string }>
  ).map((r) => r.id);
  const rows =
    ids.length === 0 ? [] : await tx.select().from(entities).where(inArray(entities.id, ids));
  // Порядок — из `order_by` декларации; склейка та же, что у карточек.
  const keys = new Map(
    rows.map((row) => [
      row.id,
      list.order_by
        .map((part) =>
          'core' in part
            ? part.core === 'id'
              ? row.id
              : row.title
            : String(
                slotValueOf(
                  bindingForEntity(cctx, mv, row.aspects),
                  row.props as Record<string, unknown>,
                  part.slot,
                ) ?? '',
              ),
        )
        .join(KEY_SEP),
    ]),
  );
  return [...rows].sort((a, b) => {
    const ka = keys.get(a.id) ?? '';
    const kb = keys.get(b.id) ?? '';
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}

export async function budgetOverviewOf(
  tx: Tx,
  ownerId: string,
  args: BudgetArgs,
  def: BudgetSubscription,
  reg: RegistrySnapshot,
): Promise<BudgetOverview> {
  const { cctx, la, raws, sums } = await runLedgers(tx, ownerId, args, def, reg);
  const { start, end } = monthRangeOf(args.month);
  const { balance: balanceName, unbudgeted: unbudgetedName } = periodLedgerNames(def);

  const catIds = new Set<string>(raws.map((e) => e.categoryRef));
  const unbudgetedRows = [...(sums.get(unbudgetedName) ?? new Map<string, string>())];
  for (const [categoryId] of unbudgetedRows) catIds.add(categoryId);
  const lists = {
    comingUp: await runList(tx, cctx, def, 'coming_up', la),
    planned: await runList(tx, cctx, def, 'planned', la),
  };
  for (const row of lists.planned) {
    const ref = slotValueOf(
      bindingForEntity(cctx, def.sources.movement.contract, row.aspects),
      row.props as Record<string, unknown>,
      'category',
    );
    if (typeof ref === 'string') catIds.add(ref);
  }
  const cats = await categoriesById(tx, [...catIds]);

  const statuses = raws
    .map((e) => ({ e, key: cardKey(def, e, cats) }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map(({ e }) => wireEnvelope(e, cats));

  const balance = sums.get(balanceName) ?? new Map<string, string>();
  const totals = { income: '0.00', expense: '0.00' };
  for (const [cls, field] of Object.entries(BALANCE_FIELDS)) {
    totals[field] = balance.get(cls) ?? '0.00';
  }
  const { income, expense } = totals;
  return {
    period: { start, end },
    balance: { income, expense, balance: decSub(income, expense) },
    envelopes: statuses,
    comingUp: lists.comingUp.map((row) => wireMovement(cctx, def, row)),
    planned: lists.planned.map((row) => wirePlanned(cctx, def, row, cats)),
    unbudgeted: unbudgetedRows.map(([categoryId, total]) => {
      const c = cats.get(categoryId);
      return {
        category: { id: c?.id ?? categoryId, title: c?.title ?? '', icon: c?.icon ?? null },
        total,
      };
    }),
    alertCount: countAlerts(def, raws),
  };
}

/**
 * Бейдж §6.1: ЛЁГКОЕ чтение — суммы конвертов месяца и порог, больше ничего.
 *
 * Ни списков, ни карточек категорий, ни ведомостей ПЕРИОДА, ни дерева (Ф-Б1-39): порог считает
 * `on_raw`, то есть СЫРЫЕ величины конверта до агрегации дерева, — значит rollup для бейджа не
 * просто лишний, а не участвует в ответе по построению. Бейдж инвалидируется на каждой записи
 * денег, и лишний скан месяца здесь стоил владельцу задержки на каждом вводе траты.
 */
export async function budgetAlertCountOf(
  tx: Tx,
  ownerId: string,
  args: BudgetArgs,
  def: BudgetSubscription,
  reg: RegistrySnapshot,
): Promise<number> {
  const run = await runLedgers(tx, ownerId, args, def, reg, { period: false, rollup: false });
  return countAlerts(def, run.raws);
}

/** Тул `budget_status` (§4.3): Overview + классификация ВСЕХ категорий владельца. */
export async function budgetStatusOf(
  tx: Tx,
  ownerId: string,
  args: BudgetArgs,
  def: BudgetSubscription,
  reg: RegistrySnapshot,
): Promise<BudgetStatusResult> {
  const overview = await budgetOverviewOf(tx, ownerId, args, def, reg);
  // Список категорий — НЕ ведомость подписки: контракта «категория» в Б-1 нет (В-2), запрос живёт
  // в `budget/categories.ts` рядом с карточками.
  return { ...overview, categories: await ownerCategories(tx, ownerId) };
}

/**
 * Fast-path «осталось N ₽» (§4.1): селектор §2.3 — ТОТ ЖЕ `selectEnvelope`, что у хука привязки.
 * Ведомости считаются на ОДНОМ конверте (`only`), поэтому rollup дерева не применяется — как и у
 * оракула: экран быстрой траты показывает СВОЙ конверт, а не сумму поддерева (§4.1 vs §2.10).
 */
export async function envelopeForCategoryOf(
  tx: Tx,
  ownerId: string,
  args: { categoryId: string; date: string; today: string },
  def: BudgetSubscription,
  reg: RegistrySnapshot,
): Promise<EnvelopeStatus | null> {
  const defCur = await defaultCurrencyOf(tx, ownerId);
  const envelopeId = await selectEnvelope(tx, {
    ownerId,
    categoryRef: args.categoryId,
    currency: defCur,
    occurredOn: args.date,
    defaultCurrency: defCur,
  });
  if (envelopeId === null) return null;
  // Месяц берётся у САМОЙ даты, а не у «сегодня»: при историческом вводе (§7.1) фаза 1 месяца
  // «сегодня» этот конверт не вернула бы, и fast-path соврал бы «конверта нет».
  // Сужение (Ф-Б1-39): конверты ОДНОЙ категории, ни ведомостей периода, ни дерева — экран быстрой
  // траты показывает СВОЙ конверт (§4.1 против §2.10), и остальное в его ответ не входит.
  const { raws } = await runLedgers(
    tx,
    ownerId,
    { month: args.date.slice(0, 7), today: args.today },
    def,
    reg,
    { category: args.categoryId, envelope: envelopeId, period: false, rollup: false },
  );
  const e = raws[0];
  if (e === undefined) return null;
  return wireEnvelope(e, await categoriesById(tx, [e.categoryRef]));
}

/**
 * Мини-тренд (§3.2): бакет — месяц `period_start` конверта, штриховая линия — сумма СЛОТА `limit`
 * (без carryover), валюта — только по умолчанию (§5: RUB и USD без конверсии не складываются).
 *
 * Цикл по месяцам остаётся, но каждый виток сужен ДО КАТЕГОРИИ (Ф-Б1-39): экран читает две
 * величины одной категории, а до фикса каждый виток считал сорок конвертов месяца, обе ведомости
 * периода и дерево — 4,4 с на корпусе 20k за двенадцать точек графика. Ведомости периода и дерево
 * в ответ тренда не входят вовсе: точка — это `spent` и сумма слота `limit` своих конвертов.
 */
export async function categoryTrendOf(
  tx: Tx,
  ownerId: string,
  args: { categoryId: string; months: number; today: string },
  def: BudgetSubscription,
  reg: RegistrySnapshot,
): Promise<CategoryTrendPoint[]> {
  const cur = args.today.slice(0, 7);
  const { spent: spentName } = alertOperands(def);
  const out: CategoryTrendPoint[] = [];
  for (let i = 0; i < args.months; i += 1) {
    const period = shiftMonthOf(cur, i - (args.months - 1));
    const { raws, la } = await runLedgers(
      tx,
      ownerId,
      { month: period, today: args.today },
      def,
      reg,
      { category: args.categoryId, period: false, rollup: false },
    );
    const mine = raws.filter(
      (e) =>
        e.currency === la.defaultCurrency &&
        String(slotValueOf(e.binding, e.props, 'period_start') ?? '').slice(0, 7) === period,
    );
    if (mine.length === 0) {
      out.push({ period, spent: '0.00', limit: null });
      continue;
    }
    let spent = '0.00';
    let limit = '0.00';
    for (const e of mine) {
      spent = decAdd(spent, String(e.raw[spentName] ?? '0'));
      limit = decAdd(limit, String(slotValueOf(e.binding, e.props, 'limit') ?? '0'));
    }
    out.push({ period, spent, limit });
  }
  return out;
}
