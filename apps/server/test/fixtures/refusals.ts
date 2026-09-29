// apps/server/test/fixtures/refusals.ts
// 21 СТРОКА КАНОНИЧЕСКИХ ОТКАЗОВ (§С1-2, ревизия 4) КАК ДАННЫЕ. Мерка §С8-24: у каждой строки есть
// ПОЗИТИВ (та же форма без порчи проходит), канонический ОТКАЗ и ≥1 ПОРЧА, меняющая вердикт.
// Позитив обязателен рядом с негативом: валидатор, отвергающий всё, прошёл бы прогон 21/21.
// ДВА ЖАНРА ВХОДА: 17 строк — испорченная ДЕКЛАРАЦИЯ, 4 — ЗАПИСЬ ДАННЫХ (их бросают исполнитель и
// движок, и «испортить декларацию» для них невыразимо).
//
//  # · жанр       · код(ы)                      · дверь (где бросается отказ)
//  1 · декларация · REGISTRY_CYCLE              · assertAcyclicGraph(dependencyGraph)
//  2 · данные     · COMPUTED_WRITE              · execute entity_update → assertPropsWritable
//  3 · декларация · ACTION_NESTED/ACTION_BRANCH · assertAction: ступень 5 (шаги) / 1 (ветвление)
//  4 · декларация · EXPR_RECURSION              · assertSubscription → assertAggregatesAcyclic
//  5 · декларация · EXPR_TYPE/EXPR_NOT_TOTAL    · assertSubscription → assertExprTypes → чекер E
//  6 · декларация · QUERY_MULTI_ROLE/QUERY_JOIN · parseQueryAst → assertRelShape / parseEntityRef
//  7 · декларация · SUBSCRIPTION_RAW_REF        · assertSubscription → assertNoAspectRefs / assertNoRawValues
//  8 · декларация · VARIANT_UNMAPPED            · execute aspect_delta_set → setAspectDelta → checkClassMap
//  9 · декларация · BIND_TYPE                   · execute aspect_implements_set → assertImplements
// 10 · данные     · SLOT_AMBIGUOUS              · движок Бюджета (budget.overview) → bindingForEntity
// 11 · декларация · UNIQUE_ON_MANY              · assertRule → assertReferences (ступень 6)
// 12 · декларация · SCOPE_NOT_STATIC            · execute property_create → assertRegistryQuery → assertStaticQuery
// 13 · данные     · ROLE_SYSTEM_ONLY            · execute relation_create → assertRoleConstraints
// 14 · декларация · PATTERN_NOT_REGULAR         · execute property_create → assertPatternRegular
// 15 · декларация · SENSITIVITY_UNDERDECLARED   · assertAction: ступень 10 (факты шагов)
// 16 · декларация · SECOND_LANGUAGE             · assertSubscription: строка в E-позиции до разбора формы
// 17 · декларация · SURFACE_UNKNOWN             · assertSubscription: поверхность — первой
// 18 · декларация · BATCH_UNBOUNDED             · assertAction: ступень 6 (кап пачки)
// 19 · декларация · RULE_CONFLICT               · assertRule → assertNoConflict (ступень 9)
// 20 · декларация · DEREF_IN_CONSTRAINT         · assertRule → assertExprTypes → чекер E (derefType)
// 21 · данные     · MODULE_DISABLED             · execute entity_create → assertExtensionEnabled
//
// Таблица сверяется с данными тестом (`refusals.test.ts`, «сводная таблица докблока…»): номер, жанр и
// коды каждой строки обязаны совпасть с `REFUSAL_ROWS`. Дверь — прозой, её держат прогоны строк.
import {
  addDays,
  BUDGET_DEF,
  BUILTIN_ACTION_DEFS,
  BUILTIN_ASPECT_DEFS,
  BUILTIN_CONTRACT_DEFS,
  BUILTIN_PROPERTY_META,
  BUILTIN_RELATION_ROLE_META,
  EXPR_NOT_TOTAL,
  EXPR_RECURSION,
  EXPR_TYPE,
  type GraphId,
  PATTERN_NOT_REGULAR,
  RULE_FIXTURES,
  type RuleCarrier,
  type RuleFixture,
  SECOND_LANGUAGE,
} from '@orbis/shared';
import { OWNER_LOCALE, parseQueryAst, toParseRegistry } from '@orbis/shared/query';
import type { Db } from '../../src/db/client';
import { ExecError, type ExecErrorCode } from '../../src/errors';
import { execute } from '../../src/executor/executor';
import type { ExecuteOk, ExecuteResult } from '../../src/executor/types';
import { assertAction } from '../../src/registry/actions';
import { assertAcyclicGraph, dependencyGraph } from '../../src/registry/deps-graph';
import type { RegistrySnapshot, SubscriptionRow } from '../../src/registry/load';
import { assertRule } from '../../src/registry/rules';
import { appRouter } from '../../src/router';
import { assertSubscription } from '../../src/subscriptions/registry';
import { createCallerFactory } from '../../src/trpc';
import {
  appDb,
  type CustomAspectSpec,
  freshGraph,
  personal,
  seedCustomAspect,
  truncateAll,
} from '../helpers';
import {
  ACTION_BRANCH,
  ACTION_NESTED,
  ACTION_NESTED_BY_TOOL,
  BATCH_UNBOUNDED,
  GRANTS_AUTONOMY_UNDERDECLARED,
  P2F,
  POSTPONE,
  SENSITIVITY_UNDERDECLARED,
  SENSITIVITY_UNDERDECLARED_ATTACH,
  UNSET_BY_EXPR_UNDERDECLARED,
} from './action-seed';

export type RefusalGenre = 'declaration' | 'data';
export interface RefusalSpoil {
  name: string;
  run(): Promise<ExecErrorCode>;
}
export interface RefusalRow {
  row: number; // номер §С1-2 (18 строк §4 + три спеки)
  codes: readonly ExecErrorCode[]; // три строки §4 несут по два имени: 24 имени на 21 строку
  genre: RefusalGenre;
  positive(): Promise<void>; // та же форма без порчи; бросок = провал строки
  refuse(): Promise<ExecErrorCode>; // канонический отказ: возвращает КОД, а не бросает
  spoils: readonly RefusalSpoil[]; // мутационная проверка §С8-24
  // Поля пометки «красная строка» больше нет (задача 17: 21/21 зелены): тип, у которого не осталось
  // носителя, — приглашение вернуть пометку молча.
}

/** Мир корпуса — модульный: `positive`/`refuse` объявлены БЕЗ аргументов (§1.14). */
interface RefusalWorld {
  db: Db;
  close: () => Promise<void>;
  reg: RegistrySnapshot; // встроенные словари без строк владельца
  owner: GraphId; // строки-декларации и данные, кроме 21
  moduleOwner: GraphId; // строка 21: выключенный модуль испортил бы соседей
  moduleCategoryId: string;
  moduleNoteId: string;
  ambiguousId: string; // конверт с двумя привязками контракта конверта (строка 10)
  ambiguousCategoryId: string; // своя категория строки 10: хук привязки трат её не трогает
  monthStart: string;
  monthEnd: string;
  nextMonthStart: string;
  nextMonthEnd: string;
  envelopeId: string;
  txnId: string; // пара под системную роль (строка 13)
  taskId: string;
  projectId: string; // запись вычисляемого свойства (строка 2)
  today: string;
}
let W: RefusalWorld | undefined;
const world = (): RefusalWorld => {
  if (W === undefined) throw new Error('корпус не подготовлен: зови prepareRefusals() в beforeAll');
  return W;
};

/** Снимок «как из БД» без строк владельца — образец `subscriptions/registry.test.ts:50-61`. */
const builtinSnapshot = (): RegistrySnapshot => ({
  properties: new Map(BUILTIN_PROPERTY_META.map((p) => [p.id, p])),
  aspects: new Map(BUILTIN_ASPECT_DEFS.map((a) => [a.id, a])),
  roles: new Map(BUILTIN_RELATION_ROLE_META.map((r) => [r.id, r])),
  contracts: new Map(BUILTIN_CONTRACT_DEFS.map((c) => [c.id, c])),
  subscriptions: new Map(),
  // Действия — посеянные (§Б6-5): `assertAction` читает словарь ради уникальности `key`, и снимок «как
  // из БД» без них разрешил бы корпусу занять ключ встроенного действия.
  actions: new Map(BUILTIN_ACTION_DEFS.map((a) => [a.id, a])),
  ownerVersion: 1,
  systemVersion: 1,
});
/** Строка подписки вокруг декларации — образец `subscriptions/registry.test.ts:70-80`. */
const subRow = (definition: unknown, over: Partial<SubscriptionRow> = {}): SubscriptionRow =>
  ({
    id: 'orbis/budget-overview',
    graphId: null,
    surface: 'finance/budget-overview',
    definition,
    module: 'finance',
    rank: 1,
    ...over,
  }) as SubscriptionRow;

/** Код синхронного броска. ОТСУТСТВИЕ отказа — поломка строки, а не «другой код». */
export function codeOfSync(fn: () => unknown): ExecErrorCode {
  try {
    fn();
  } catch (e) {
    if (e instanceof ExecError) return e.code;
    throw e;
  }
  throw new Error('ожидался отказ, его не было — строка корпуса перестала быть отказом');
}
/**
 * То же для асинхронной двери (движок Повестки, tRPC).
 *
 * Отказ ручки приезжает ЗАВЁРНУТЫМ: роутер переводит `ExecError` в `TRPCError`, оставляя исходную
 * структурированную ошибку в `cause` (`errors.ts`, `execErrorToTRPC`). Разворачивает её этот
 * помощник, а не каждая строка корпуса: строка говорит про КОД отказа, а не про транспорт,
 * которым он к ней приехал.
 */
export async function codeOfAsync(fn: () => Promise<unknown>): Promise<ExecErrorCode> {
  try {
    await fn();
  } catch (e) {
    if (e instanceof ExecError) return e.code;
    const cause = (e as { cause?: unknown } | null)?.cause;
    if (cause instanceof ExecError) return cause.code;
    throw e;
  }
  throw new Error('ожидался отказ, его не было — строка корпуса перестала быть отказом');
}
/** `ExecuteErr.error.code` объявлен `string` (`types.ts:92`) — каст ОДИН здесь, а не в каждой строке. */
export function codeOfResult(r: ExecuteResult): ExecErrorCode {
  if (r.ok) throw new Error('ожидался отказ исполнителя, операция прошла');
  return r.error.code as ExecErrorCode;
}
export function okOfResult(r: ExecuteResult): ExecuteOk {
  if (!r.ok) throw new Error(`позитив строки не прошёл: ${r.error.code} — ${r.error.message}`);
  return r;
}
/** Одна операция = один `execute`: отказ обязан называть СВОЮ операцию, а не «пачка упала». */
const run = (owner: GraphId, tool: string, input: unknown): Promise<ExecuteResult> =>
  execute(world().db, {
    identity: personal(owner),
    actorKind: 'owner',
    source: 'ui',
    operations: [{ tool, input }],
  });

// ─────────────────────── строки 1 и 6: чистые валидаторы, БД не нужна ───────────────────────

/**
 * Владелец строк-проб первой строки. Граф этой пробы живёт ТОЛЬКО в снимке в памяти и до базы не
 * доезжает: `dependencyGraph` читает словари, а не таблицы, — и минтить под пробу настоящий граф
 * значило бы обещать строку, которой нет.
 */
const OWNER_PROBE = '00000000-0000-4000-8000-00000000000c';
const P = (id: string, mergedInto: string) => ({
  id,
  graphId: OWNER_PROBE,
  key: id,
  label: { ru: id },
  description: { ru: id },
  type: { kind: 'number' },
  status: 'active',
  storage: 'props',
  scope: null,
  mergedInto,
  module: null,
  rank: 900,
  flags: {},
});
const graphOf = (properties: Array<Record<string, unknown>>) => {
  const reg = builtinSnapshot();
  for (const p of properties) reg.properties.set(p.id as string, p as never);
  return dependencyGraph(reg, { queryRefs: new Map() });
};
const ROW_1: RefusalRow = {
  row: 1,
  codes: ['REGISTRY_CYCLE'],
  genre: 'declaration',
  positive: async () => {
    assertAcyclicGraph(graphOf([])); // встроенный граф ацикличен
  },
  refuse: async () =>
    codeOfSync(() => assertAcyclicGraph(graphOf([P('user/a', 'user/b'), P('user/b', 'user/a')]))),
  spoils: [
    {
      name: 'цикл из трёх указателей — тот же отказ, а не «глубина»',
      run: async () =>
        codeOfSync(() =>
          assertAcyclicGraph(
            graphOf([P('user/c', 'user/d'), P('user/d', 'user/e'), P('user/e', 'user/c')]),
          ),
        ),
    },
    {
      name: 'самоссылка свойства',
      run: async () => codeOfSync(() => assertAcyclicGraph(graphOf([P('user/self', 'user/self')]))),
    },
  ],
};

const parseReg = () => toParseRegistry(builtinSnapshot(), OWNER_LOCALE);
/** `parseQueryAst` ВОЗВРАЩАЕТ отказ, а не бросает: код читается из результата (ОВ-0c-5). */
const parseCode = (text: string): ExecErrorCode => {
  const r = parseQueryAst(text, parseReg());
  if (r.ok) throw new Error(`ожидался отказ разбора, получен AST: ${text}`);
  return r.error.code as ExecErrorCode;
};
const ROW_6: RefusalRow = {
  row: 6,
  codes: ['QUERY_MULTI_ROLE', 'QUERY_JOIN'],
  genre: 'declaration',
  positive: async () => {
    const r = parseQueryAst('descendants_of=this via=subitem', parseReg());
    if (!r.ok) throw new Error(`позитив строки 6 не разобрался: ${r.error.code}`);
  },
  refuse: async () => parseCode('descendants_of=this'),
  spoils: [
    { name: 'ancestors_of без via', run: async () => parseCode('ancestors_of=this') },
    {
      name: 'children_of=<предикат> — соединение двух свободных сущностей',
      run: async () => parseCode('children_of=aspect=orbis/project'),
    },
    {
      name: 'parents_of=<предикат> — то же с другой стороны',
      run: async () => parseCode('parents_of=orbis/task_status=done'),
    },
  ],
};

// ───────────────── строки 4, 5, 7, 16, 17: валидатор декларации подписки ─────────────────

// Образец декларации — Бюджет: подписки Повестки с 1в нет (§6.5), и строки, которые держала её
// декларация, перевыражены на `BUDGET_DEF` с тем же смыслом порчи.
const SEED = () => ({ reg: builtinSnapshot(), systemSeed: true });
const budgetRow = (d: unknown) => subRow(d);
/** Сумма `spent` Бюджета — позиция `where`, в которую строки подкладывают предикаты. */
const SPENT = BUDGET_DEF.aggregates.spent as Extract<
  (typeof BUDGET_DEF.aggregates)[string],
  { kind: 'sum' }
>;
const spentWhere = (where: unknown) =>
  budgetWith({ aggregates: { ...BUDGET_DEF.aggregates, spent: { ...SPENT, where } } });
const budgetWith = (o: Record<string, unknown>) => ({ ...BUDGET_DEF, ...o });
const COMING_UP = BUDGET_DEF.lists.coming_up as NonNullable<typeof BUDGET_DEF.lists.coming_up>;
const COMING_WINDOW = COMING_UP.window as NonNullable<typeof COMING_UP.window>;
/** Окно списка `coming_up` с подменённой границей. */
const windowWith = (o: Record<string, unknown>) =>
  budgetWith({
    lists: { ...BUDGET_DEF.lists, coming_up: { ...COMING_UP, window: { ...COMING_WINDOW, ...o } } },
  });
const aggregatesWith = (o: Record<string, unknown>) => ({
  ...BUDGET_DEF,
  aggregates: { ...BUDGET_DEF.aggregates, ...o },
});
const CIRCLE = { kind: 'formula', scope: 'envelope', expr: { agg: 'daily_pace' } };

const ROW_4: RefusalRow = {
  row: 4,
  codes: [EXPR_RECURSION],
  genre: 'declaration',
  positive: async () => {
    assertSubscription(budgetRow(BUDGET_DEF), SEED());
  },
  // `remaining → daily_pace → remaining`: обе формулы по отдельности законны, круг собирается парой.
  refuse: async () =>
    codeOfSync(() => assertSubscription(budgetRow(aggregatesWith({ remaining: CIRCLE })), SEED())),
  spoils: [
    // Круг из ТРЁХ (`effective_limit → daily_pace → remaining → effective_limit`): обход обязан
    // быть транзитивным, а не сверкой пары. Круга длиной 1 в этой двери не бывает вовсе — область
    // формулы не видит СВОЕГО имени (`registry.ts`, `delete others[name]`), и самоссылка едет
    // честным `EXPR_TYPE` от чекера, то есть другой строкой корпуса.
    {
      name: 'круг из трёх ведомостей — тот же отказ, а не «длина цепи»',
      run: async () =>
        codeOfSync(() =>
          assertSubscription(budgetRow(aggregatesWith({ effective_limit: CIRCLE })), SEED()),
        ),
    },
  ],
};

const ROW_5: RefusalRow = {
  row: 5,
  codes: [EXPR_TYPE, EXPR_NOT_TOTAL],
  genre: 'declaration',
  positive: async () => {
    assertSubscription(subRow(BUDGET_DEF), SEED());
  },
  refuse: async () =>
    codeOfSync(() => assertSubscription(subRow(windowWith({ to: { const: true } })), SEED())),
  spoils: [
    {
      name: 'вторая граница окна булевым выражением',
      run: async () =>
        codeOfSync(() => assertSubscription(subRow(windowWith({ from: { const: true } })), SEED())),
    },
    // Арифметика над необязательным `agg_via` — EXPR_NOT_TOTAL (`expr/fixtures.ts:190-198`).
    {
      name: 'формула ведомости не тотальна',
      run: async () =>
        codeOfSync(() =>
          assertSubscription(
            budgetRow(
              aggregatesWith({
                effective_limit: {
                  kind: 'formula',
                  scope: 'envelope',
                  expr: {
                    op: '+',
                    args: [
                      { agg_via: { role: 'envelope-binding', name: 'remaining' } },
                      { const: '1' },
                    ],
                  },
                },
              }),
            ),
            SEED(),
          ),
        ),
    },
  ],
};

const ROW_7: RefusalRow = {
  row: 7,
  codes: ['SUBSCRIPTION_RAW_REF'],
  genre: 'declaration',
  // ВТОРАЯ половина утверждения §Б5-2: ссылка на аспект законна ровно в `prefer`, и позитив обязан
  // называть именно её, а не голый `BUDGET_DEF` — иначе строка молчала бы о половине правила.
  positive: async () => {
    assertSubscription(
      subRow(
        budgetWith({
          sources: {
            ...BUDGET_DEF.sources,
            movement: { ...BUDGET_DEF.sources.movement, prefer: ['orbis/financial'] },
          },
        }),
      ),
      SEED(),
    );
  },
  refuse: async () =>
    codeOfSync(() =>
      assertSubscription(
        subRow(
          spentWhere({
            op: '=',
            args: [{ const: 'orbis/financial' }, { const: 'orbis/financial' }],
          }),
        ),
        SEED(),
      ),
    ),
  spoils: [
    {
      name: 'сырой предикат по свойству вместо класса контракта',
      run: async () =>
        codeOfSync(() =>
          assertSubscription(
            subRow(
              spentWhere({
                op: 'and',
                args: [
                  SPENT.where,
                  { op: '!=', args: [{ prop: 'orbis/payment_method' }, { const: 'нал' }] },
                ],
              }),
            ),
            SEED(),
          ),
        ),
    },
    {
      name: '{has} по id свойства — та же сырая ссылка другой формой',
      run: async () =>
        codeOfSync(() =>
          assertSubscription(
            subRow(spentWhere({ op: 'and', args: [SPENT.where, { has: 'orbis/payment_method' }] })),
            SEED(),
          ),
        ),
    },
  ],
};

const ROW_16: RefusalRow = {
  row: 16,
  codes: [SECOND_LANGUAGE],
  genre: 'declaration',
  positive: async () => {
    assertSubscription(subRow(BUDGET_DEF), SEED());
  },
  refuse: async () =>
    codeOfSync(() =>
      assertSubscription(subRow(spentWhere('class(money-movement) in outflow')), SEED()),
    ),
  spoils: [
    {
      name: 'текст в границе окна — та же вторая грамматика другой позицией',
      run: async () =>
        codeOfSync(() =>
          assertSubscription(subRow(windowWith({ to: 'сегодня + 30 дней' })), SEED()),
        ),
    },
  ],
};

const ROW_17: RefusalRow = {
  row: 17,
  codes: ['SURFACE_UNKNOWN'],
  genre: 'declaration',
  positive: async () => {
    assertSubscription(subRow(BUDGET_DEF), SEED());
  },
  refuse: async () =>
    codeOfSync(() => assertSubscription(subRow(BUDGET_DEF, { surface: 'core/row' }), SEED())),
  spoils: [
    {
      name: 'опечатка имени поверхности — отказ, а не «похожая»',
      run: async () =>
        codeOfSync(() =>
          assertSubscription(subRow(BUDGET_DEF, { surface: 'finance/budget-overviews' }), SEED()),
        ),
    },
    // Снятая поверхность Повестки (1в §6.5): голова `core` законна, словарь её больше не знает.
    {
      name: 'снятая поверхность Повестки — отказ словаря, а не «ядро примет»',
      run: async () =>
        codeOfSync(() =>
          assertSubscription(subRow(BUDGET_DEF, { surface: 'core/agenda' }), SEED()),
        ),
    },
  ],
};

// ───────────────── строки 8, 9, 12, 14: декларация ЧЕРЕЗ ДВЕРЬ ЗАПИСИ ─────────────────
// §С1-2 определяет фикстуру как «декларацию, которую валидатор обязан отвергнуть ПРИ ЗАПИСИ», а
// бросающие места этих четырёх стоят внутри неэкспортированных функций `registry/ops.ts` — дверь
// одна, исполнитель.

const IN_REVIEW = { key: 'in_review', label: { ru: 'На ревью' }, rank: 45 };
const taskDelta = (delta: unknown) =>
  run(world().owner, 'aspect_delta_set', {
    aspect: 'orbis/task',
    delta,
  });
const ROW_8: RefusalRow = {
  row: 8,
  codes: ['VARIANT_UNMAPPED'],
  genre: 'declaration',
  positive: async () => {
    okOfResult(
      await taskDelta({
        selectOptions: { 'orbis/task_status': { add: [IN_REVIEW] } },
        classMap: {
          'orbis/task_status': [
            {
              contract: 'orbis/completable',
              slot: 'status',
              variant: 'in_review',
              class: 'active',
            },
          ],
        },
      }),
    );
  },
  refuse: async () =>
    codeOfResult(
      await taskDelta({
        selectOptions: {
          'orbis/task_status': {
            add: [{ key: 'blocked', label: { ru: 'Заблокирована' }, rank: 46 }],
          },
        },
      }),
    ),
  spoils: [
    {
      // Карта ЕСТЬ, но называет вариант с опечаткой: неотнесённым остаётся настоящий `in_review`.
      name: 'фантомный вариант карты — отнесён не тот, кого добавили',
      run: async () =>
        codeOfResult(
          await taskDelta({
            selectOptions: { 'orbis/task_status': { add: [IN_REVIEW] } },
            classMap: {
              'orbis/task_status': [
                {
                  contract: 'orbis/completable',
                  slot: 'status',
                  variant: 'in_reveiw',
                  class: 'active',
                },
              ],
            },
          }),
        ),
    },
  ],
};

const gigImplements = (binding: Record<string, unknown>) =>
  run(world().owner, 'aspect_implements_set', {
    aspect: 'user/gig',
    implements: [{ contract: 'orbis/when', value_map: [], ...binding }],
  });
const ROW_9: RefusalRow = {
  row: 9,
  codes: ['BIND_TYPE'],
  genre: 'declaration',
  positive: async () => {
    okOfResult(await gigImplements({ bind: { moment: 'orbis/start_at' } }));
  },
  // Слот `moment` — any_of[timestamp,date], `orbis/location` — text (§Б1-1).
  refuse: async () => codeOfResult(await gigImplements({ bind: { moment: 'orbis/location' } })),
  spoils: [
    {
      name: 'константа не того рода при верной привязке — тот же гейт другой половиной',
      run: async () =>
        codeOfResult(
          await gigImplements({ bind: { moment: 'orbis/start_at' }, fixed: { moment: 42 } }),
        ),
    },
  ],
};

const movingScope = {
  filter: {
    and: [
      { aspect: 'orbis/task' },
      { prop: 'orbis/due_date', op: 'eq', value: { token: 'today' } },
    ],
  },
};
const ROW_12: RefusalRow = {
  row: 12,
  codes: ['SCOPE_NOT_STATIC'],
  genre: 'declaration',
  positive: async () => {
    okOfResult(
      await run(world().owner, 'property_create', {
        key: 'user/corpus-static',
        label: { ru: 'Статичная область' },
        description: { ru: 'Множество не движется' },
        type: { kind: 'number' },
        status: 'active',
        scope: { filter: { aspect: 'orbis/task' } },
      }),
    );
  },
  refuse: async () =>
    codeOfResult(
      await run(world().owner, 'property_create', {
        key: 'user/corpus-moving',
        label: { ru: 'Подвижное' },
        description: { ru: 'Множество менялось бы каждый день' },
        type: { kind: 'number' },
        status: 'active',
        scope: movingScope,
      }),
    ),
  spoils: [
    {
      name: 'тот же токен внутри ref.target',
      run: async () =>
        codeOfResult(
          await run(world().owner, 'property_create', {
            key: 'user/corpus-moving-ref',
            label: { ru: 'Подвижная цель' },
            description: { ru: 'Цель ссылки менялась бы каждый день' },
            type: { kind: 'ref', target: movingScope },
            status: 'active',
          }),
        ),
    },
  ],
};

const patternProperty = (key: string, ru: string, pattern: string) =>
  run(world().owner, 'property_create', {
    key,
    label: { ru },
    description: { ru: `Текст по образцу ${pattern}` },
    type: { kind: 'text', pattern },
    status: 'active',
  });
const ROW_14: RefusalRow = {
  row: 14,
  codes: [PATTERN_NOT_REGULAR],
  genre: 'declaration',
  positive: async () => {
    okOfResult(
      await patternProperty('user/corpus-regular', 'Регулярный образец', '^[0-9]{3}-[0-9]{2}$'),
    );
  },
  refuse: async () =>
    codeOfResult(await patternProperty('user/corpus-lookahead', 'Просмотр', '^(?!0)\\d+$')),
  spoils: [
    {
      name: 'обратная ссылка — второй род конструкции вне класса RE2',
      run: async () =>
        codeOfResult(await patternProperty('user/corpus-backref', 'Обратная ссылка', '^(a)\\1$')),
    },
  ],
};

// ─────────────────────────── строки 2, 13, 21: жанр «данные» ───────────────────────────

const ROW_2: RefusalRow = {
  row: 2,
  codes: ['COMPUTED_WRITE'],
  genre: 'data',
  positive: async () => {
    okOfResult(
      await run(world().owner, 'entity_update', {
        id: world().taskId,
        props: { 'orbis/priority': 'high' },
      }),
    );
  },
  refuse: async () =>
    codeOfResult(
      await run(world().owner, 'entity_update', {
        id: world().taskId,
        props: { 'orbis/parent_project': world().projectId },
      }),
    ),
  spoils: [
    {
      // Снятие — такое же распоряжение служебным значением, как запись (§А2-5).
      name: 'снятие вычисляемого свойства — тот же гейт',
      run: async () =>
        codeOfResult(
          await run(world().owner, 'entity_update', {
            id: world().taskId,
            props: { 'orbis/root_project': null },
          }),
        ),
    },
    {
      name: 'то же свойство на создании — гейт стоит не только на правке',
      run: async () =>
        codeOfResult(
          await run(world().owner, 'entity_create', {
            title: 'Корпус: чужой предок',
            tags: [],
            props: { 'orbis/parent_project': world().projectId },
          }),
        ),
    },
  ],
};

const ROW_13: RefusalRow = {
  row: 13,
  codes: ['ROLE_SYSTEM_ONLY'],
  genre: 'data',
  // Роль `mention` объявлена `created_by:'any'` (`builtin-roles.ts:155`) — та же дверь пропускает.
  positive: async () => {
    okOfResult(
      await run(world().owner, 'relation_create', {
        source_id: world().envelopeId,
        target_id: world().taskId,
        role: 'mention',
      }),
    );
  },
  refuse: async () =>
    codeOfResult(
      await run(world().owner, 'relation_create', {
        source_id: world().envelopeId,
        target_id: world().txnId,
        role: 'envelope-binding',
      }),
    ),
  spoils: [
    {
      name: 'снятие системной связи руками — тот же гейт',
      run: async () =>
        codeOfResult(
          await run(world().owner, 'relation_delete', {
            source_id: world().envelopeId,
            target_id: world().txnId,
            role: 'envelope-binding',
          }),
        ),
    },
    {
      name: 'вторая системная роль (`run`) — правило, а не случай',
      run: async () =>
        codeOfResult(
          await run(world().owner, 'relation_create', {
            source_id: world().taskId,
            target_id: world().projectId,
            role: 'run',
          }),
        ),
    },
  ],
};

const ROW_21: RefusalRow = {
  row: 21,
  codes: ['MODULE_DISABLED'],
  genre: 'data',
  // Запись ЯДРА при выключенном модуле законна (§С8-22): гаснет модуль, а не весь граф.
  positive: async () => {
    okOfResult(
      await run(world().moduleOwner, 'entity_create', { title: 'Корпус: ядро', tags: [] }),
    );
  },
  refuse: async () =>
    codeOfResult(
      await run(world().moduleOwner, 'entity_create', {
        title: 'Корпус: трата при выключенных финансах',
        tags: [],
        aspects: ['orbis/financial'],
        props: {
          'orbis/amount': '340.00',
          'orbis/direction': 'expense',
          'orbis/finance_category': world().moduleCategoryId,
          'orbis/occurred_on': world().today,
        },
      }),
    ),
  spoils: [
    {
      name: 'навешивание аспекта модуля через attach_* — второй путь появления',
      run: async () =>
        codeOfResult(
          await run(world().moduleOwner, 'attach_orbis_category', {
            entity_id: world().moduleNoteId,
            data: { 'orbis/icon': '🍏' },
          }),
        ),
    },
    {
      name: 'тот же аспект полем aspects.attach — третий путь',
      run: async () =>
        codeOfResult(
          await run(world().moduleOwner, 'entity_update', {
            id: world().moduleNoteId,
            aspects: { attach: ['orbis/category'] },
          }),
        ),
    },
    {
      // ПОРЯДОК ДВЕРЕЙ после переезда инвариантов в правила (задача 17, шаг 6): гейт модуля стоит ДО
      // C-правил (Р-И-14, стадия 4). Трата без даты операции нарушает ещё и системное
      // `financial_requires_occurred_on` — сместись дверь, отказ пришёл бы `INVARIANT` правила. При
      // включённых финансах тот же вход — `INVARIANT` (контроль — `gate-b2.test.ts`, «контроль: инвариант держится»).
      name: 'трата без даты операции — гейт модуля раньше C-правила о дате',
      run: async () =>
        codeOfResult(
          await run(world().moduleOwner, 'entity_create', {
            title: 'Корпус: трата без даты при выключенных финансах',
            tags: [],
            aspects: ['orbis/financial'],
            props: {
              'orbis/amount': '340.00',
              'orbis/direction': 'expense',
              'orbis/finance_category': world().moduleCategoryId,
            },
          }),
        ),
    },
  ],
};

// ───────────────────── строка 10: SLOT_AMBIGUOUS движком Бюджета ─────────────────────
// Конфликт привязки живёт У ЗАПИСИ, а не в декларации: два аспекта записи, реализующих один контракт,
// законны по отдельности, а движок без `prefer` не вправе выбрать молча (§С8-21, `bindingForEntity`).
// До 1в строку держал движок Повестки (`orbis/when.moment`); он снят (§6.5), и та же проверка идёт
// дверью Бюджета: конверт с `orbis/budget` и двойником-конвертом владельца ВНУТРИ месяца обзора даёт
// отказ карточки, движение с `orbis/financial` и двойником-движением в плане — отказ строки списка.

/** Двойники встроенных аспектов — тот же контракт теми же свойствами (`carries`), ранг ниже встроенного. */
const TWIN_ENVELOPE_KEY = 'user/twin-envelope';
const TWIN_MONEY_KEY = 'user/twin-money';
const TWIN_ENVELOPE: CustomAspectSpec = {
  key: TWIN_ENVELOPE_KEY,
  label: { ru: 'Конверт-двойник' },
  module: 'finance',
  rank: 900,
  properties: [],
  carries: ['orbis/finance_category', 'orbis/limit', 'orbis/period_start', 'orbis/period_end'],
  implements: [
    {
      contract: 'orbis/envelope',
      bind: {
        category: 'orbis/finance_category',
        limit: 'orbis/limit',
        period_start: 'orbis/period_start',
        period_end: 'orbis/period_end',
      },
      value_map: [],
      fixed: {},
    },
  ],
};
const TWIN_MONEY: CustomAspectSpec = {
  key: TWIN_MONEY_KEY,
  label: { ru: 'Движение-двойник' },
  module: 'finance',
  rank: 900,
  properties: [],
  carries: ['orbis/amount', 'orbis/direction', 'orbis/finance_category', 'orbis/occurred_on'],
  implements: [
    {
      contract: 'orbis/money-movement',
      bind: {
        amount: 'orbis/amount',
        direction: 'orbis/direction',
        category: 'orbis/finance_category',
        date: 'orbis/occurred_on',
      },
      value_map: [
        { slot: 'direction', variant: 'expense', class: 'outflow' },
        { slot: 'direction', variant: 'income', class: 'inflow' },
      ],
      fixed: {},
    },
  ],
};

/** Обзор бюджета текущего месяца — тем же путём, что экран Финансов (ручка `budget.overview`). */
const budgetOf = (owner: GraphId) =>
  createCallerFactory(appRouter)({
    identity: personal(owner),
    actorKind: 'owner',
    db: world().db,
    clientVersion: null,
  }).budget.overview({ month: world().monthStart.slice(0, 7) });
/** Период конверта-двойника: в месяце обзора (`inside`) или за ним (следующий месяц). */
const moveAmbiguous = (inside: boolean) =>
  run(world().owner, 'entity_update', {
    id: world().ambiguousId,
    props: inside
      ? { 'orbis/period_start': world().monthStart, 'orbis/period_end': world().monthEnd }
      : { 'orbis/period_start': world().nextMonthStart, 'orbis/period_end': world().nextMonthEnd },
  });
const ROW_10: RefusalRow = {
  row: 10,
  codes: ['SLOT_AMBIGUOUS'],
  genre: 'data',
  positive: async () => {
    await budgetOf(world().owner); // конфликтный конверт ещё ЗА месяцем обзора
  },
  refuse: async () => {
    okOfResult(await moveAmbiguous(true));
    return codeOfAsync(async () => {
      await budgetOf(world().owner);
    });
  },
  spoils: [
    {
      name: 'конфликт у движения в плане — тот же отказ другой половиной (строка списка)',
      run: async () => {
        // Конверт уходит из месяца: отказ обязан прийти от движения, а не остаться от карточки.
        okOfResult(await moveAmbiguous(false));
        okOfResult(
          await run(world().owner, 'entity_create', {
            title: 'План-двойник корпуса',
            tags: [],
            aspects: ['orbis/financial', TWIN_MONEY_KEY],
            props: {
              'orbis/amount': '120.00',
              'orbis/direction': 'expense',
              'orbis/finance_category': world().ambiguousCategoryId,
              'orbis/occurred_on': addDays(world().today, 3),
              'orbis/planned': true,
            },
          }),
        );
        return codeOfAsync(async () => {
          await budgetOf(world().owner);
        });
      },
    },
  ],
};

/**
 * Строка 10 — ПОЛНАЯ форма отказа (§1.1, шаг 6 задачи 17): код один не отличил бы «движок отказал» от
 * «движок отказал, не назвав привязок», а без `aspects` владельцу нечем выбрать `prefer`, без
 * `subscription` — нечего править, без `entityId` — не найти запись. Имени слота у Бюджета нет по
 * построению: привязка выбирается на контракт целиком (`bindingForEntity`). Зовётся ПОСЛЕ строк:
 * конверт возвращается в месяц обзора — карточка считается раньше списков, и отказ приходит от неё.
 * Возвращает details отказа и то, что обязано в них лежать: вердикт объявлен здесь же, данными.
 */
export async function slotAmbiguityDetails(): Promise<{ got: unknown; want: unknown }> {
  // Правка проверяется: молча не прошедшая, она оставила бы конверт за месяцем от порчи строки 10, и
  // отказ пришёл бы от движения — пин позеленел бы не на той половине, что обещает докблок.
  okOfResult(await moveAmbiguous(true));
  let got: unknown;
  try {
    await budgetOf(world().owner);
  } catch (e) {
    const err = e instanceof ExecError ? e : (e as { cause?: unknown } | null)?.cause;
    if (!(err instanceof ExecError) || err.code !== 'SLOT_AMBIGUOUS') throw e;
    got = err.details;
  }
  if (got === undefined)
    throw new Error('отказа Бюджета не было — конверт строки 10 вышел из конфликта');
  return {
    got,
    want: {
      subscription: 'orbis/budget-overview',
      contract: 'orbis/envelope',
      entityId: world().ambiguousId,
      aspects: ['orbis/budget', TWIN_ENVELOPE_KEY],
    },
  };
}

// ─────────────────────── строки 3/15/18: валидатор действий ───────────────────────

/**
 * Область валидатора действий: снимок мира корпуса (встроенные словари + посеянные действия) и
 * системный сид — корпус меряет сидовые декларации расширений и ядра (`finance/…`, `core/…`), и namespace
 * `user/` своего действия здесь был бы другой проверкой (ступень 4), а не проверкой строки.
 */
const actionScope = () => ({ reg: world().reg, systemSeed: true });

// Позитив, отказ и порчи идут через ТОТ ЖЕ `assertAction`, что и боевая запись строки реестра, и
// берут декларации корпуса действий (`action-seed.ts`): позитив — сама сидовая декларация, порча —
// одна правка её же. До задачи 6 здесь стояли формы «на вырост» (`over: {query: …}`, шаг без `$expr`),
// которых схема §Б6-1 не принимает, — позитив на них падал бы формой, а не валидатором строки.
const ROW_3: RefusalRow = {
  row: 3,
  codes: ['ACTION_NESTED', 'ACTION_BRANCH'],
  genre: 'declaration',
  positive: async () => {
    assertAction(P2F, actionScope());
  },
  refuse: async () => codeOfSync(() => assertAction(ACTION_NESTED, actionScope())),
  spoils: [
    {
      // ОДНА правка позитива: у шага сидовой декларации сменён только `tool`, вход шага прежний. Отказ
      // обязан прийти по ИМЕНИ тула — валидатор, узнающий вложенность по форме входа (`{action}`),
      // здесь промолчал бы. Ключ меняется вместе с порчей: занятость `key` — другая проверка.
      name: 'шагу entity_update подменён tool на run_action — вход шага прежний',
      run: async () =>
        codeOfSync(() =>
          assertAction(
            {
              ...P2F,
              key: 'finance/nested-swap',
              id: 'finance/nested-swap',
              steps: [{ ...P2F.steps[0], tool: 'run_action' }],
            },
            actionScope(),
          ),
        ),
    },
    {
      name: 'ветвление на уровне шага — второе имя строки',
      run: async () => codeOfSync(() => assertAction(ACTION_BRANCH, actionScope())),
    },
    {
      // Рулинг 6-1: вложенность узнаётся по ФОРМЕ имени тула действия, а не только по `run_action`.
      name: 'шаг зовёт тул действия action_<ключ> — та же вложенность',
      run: async () => codeOfSync(() => assertAction(ACTION_NESTED_BY_TOOL, actionScope())),
    },
  ],
};

// ─── строки 11, 19, 20: валидатор правил. «Законная форма» — из RULE_FIXTURES (§С8-25) ───
// Позитив и канонический отказ объявлены ОДИН раз и одинаково для валидатора (`rules.test.ts`) и для
// корпуса: своя копия рядом разъехалась бы со словарём на первой же правке схемы правила.

/** Фикстура правила по имени; её отсутствие — расхождение словаря с корпусом, а не ветка пробы. */
const ruleFixture = (name: string): RuleFixture => {
  const f = RULE_FIXTURES.find((x) => x.name === name);
  if (f === undefined) {
    throw new Error(`фикстуры правила «${name}» нет — RULE_FIXTURES разъехались с корпусом`);
  }
  return f;
};
/** Правило фикстуры как запись: у правила-пары (`RULE_CONFLICT`) `rule` — массив, здесь — одно. */
const ruleOf = (f: RuleFixture): Record<string, unknown> => f.rule as Record<string, unknown>;
interface PlacedRules {
  carrier: RuleCarrier;
  rules: readonly unknown[];
}
/**
 * Снимок-проба: встроенные словари, где у каждого названного носителя лежат РОВНО эти правила — как их
 * увидит читатель ПОСЛЕ записи (приём `probe` из `rules.test.ts` и `probeSnapshot` записи реестра).
 * Встроенные правила носителя заменяются: корпус меряет свою декларацию, а не её встречу с сидом.
 */
const ruleProbe = (placed: readonly PlacedRules[]): RegistrySnapshot => {
  const reg = builtinSnapshot();
  const byCarrier = new Map<string, { carrier: RuleCarrier; rules: unknown[] }>();
  for (const p of placed) {
    const key = `${p.carrier.kind}:${p.carrier.id}`;
    const cell = byCarrier.get(key) ?? { carrier: p.carrier, rules: [] };
    cell.rules.push(...p.rules);
    byCarrier.set(key, cell);
  }
  for (const { carrier, rules } of byCarrier.values()) {
    const dict =
      carrier.kind === 'aspect'
        ? reg.aspects
        : carrier.kind === 'property'
          ? reg.properties
          : reg.roles;
    const base = dict.get(carrier.id);
    if (base === undefined) throw new Error(`носителя ${carrier.id} нет в словаре`);
    dict.set(carrier.id, { ...base, rules } as never);
  }
  return reg;
};
/**
 * Проверить `rule` на `carrier` в пробе, где рядом лежат `others`. Правило кладётся ПОСЛЕДНИМ: отказ
 * пары обязан приходить второму писателю — в том порядке, в каком его встречает запись реестра.
 */
const ruleCheck = (carrier: RuleCarrier, rule: unknown, others: readonly PlacedRules[] = []) =>
  assertRule(rule, {
    reg: ruleProbe([...others, { carrier, rules: [rule] }]),
    carrier,
    // Флаг гейтит только ступень 10 (граница C-6 — `has_relation` в правиле владельца), а ни один вход
    // строк 11/19/20 его не читает: владелец идёт тем же `assertRule` с `false` и получает тот же вердикт.
    systemSeed: true,
  });
const ruleCheckOf = (f: RuleFixture) => ruleCheck(f.carrier, f.rule);

const UNIQUE_OK = 'unique_among: конверт уникален четвёркой «категория, валюта, период»';
const UNIQUE_ON_MANY_FX =
  'unique_among: свойство-список — «уникальность» множества значений неопределена';
/** Позитив строки 11 с ОДНИМ дописанным в набор свойством — порча называет только его. */
const uniqueWith = (extra: string) => {
  const f = ruleFixture(UNIQUE_OK);
  const rule = ruleOf(f) as { params: { properties: readonly string[] } };
  return ruleCheck(f.carrier, {
    ...rule,
    params: { ...rule.params, properties: [...rule.params.properties, extra] },
  });
};
const ROW_11: RefusalRow = {
  row: 11,
  codes: ['UNIQUE_ON_MANY'],
  genre: 'declaration',
  // Позитив и порчи идут через ТОТ ЖЕ `assertRule`, что и боевая запись строки реестра:
  // корпус проверяет валидатор, а не свою копию его правил.
  positive: async () => {
    ruleCheckOf(ruleFixture(UNIQUE_OK));
  },
  refuse: async () => codeOfSync(() => ruleCheckOf(ruleFixture(UNIQUE_ON_MANY_FX))),
  spoils: [
    {
      name: 'в набор позитива дописано списочное свойство (orbis/aliases, cardinality: many)',
      run: async () => codeOfSync(() => uniqueWith('orbis/aliases')),
    },
    {
      // Ф-Б2-8: отказ про РОД свойства, а не про одно имя `orbis/aliases` — `select` many тоже список.
      name: 'дописан список другого рода (orbis/routine_days, select many) — отказ про род, не про имя',
      run: async () => codeOfSync(() => uniqueWith('orbis/routine_days')),
    },
  ],
};

// Строка 15: позитив — сидовое `plan-to-fact` (пишет `orbis/planned` и `orbis/occurred_on` — слоты
// `orbis/money-movement`, факт `touches_money` объявлен) и та же декларация с ЛИШНИМ объявленным фактом:
// §Б6-1 разрешает декларации факты только добавлять, и «объявил больше» обязано пройти.
const ROW_15: RefusalRow = {
  row: 15,
  codes: ['SENSITIVITY_UNDERDECLARED'],
  genre: 'declaration',
  positive: async () => {
    assertAction(P2F, actionScope());
    assertAction(
      {
        ...P2F,
        key: 'finance/loud',
        id: 'finance/loud',
        sensitivity: ['touches_money', 'external'],
      },
      actionScope(),
    );
  },
  refuse: async () => codeOfSync(() => assertAction(SENSITIVITY_UNDERDECLARED, actionScope())),
  spoils: [
    {
      name: 'объявлен ДРУГОЙ факт — набор неполон так же, как пустой',
      run: async () =>
        codeOfSync(() =>
          assertAction({ ...SENSITIVITY_UNDERDECLARED, sensitivity: ['external'] }, actionScope()),
        ),
    },
    {
      name: 'факт снят у шага attach_* — деньги в data ключами свойств',
      run: async () =>
        codeOfSync(() => assertAction(SENSITIVITY_UNDERDECLARED_ATTACH, actionScope())),
    },
    {
      // Фикс-раунд 1 (I-1): второй факт, который производит графовый шаг, — доверенность рутины.
      name: 'шаг взводит рутину, grants_autonomy не объявлен',
      run: async () => codeOfSync(() => assertAction(GRANTS_AUTONOMY_UNDERDECLARED, actionScope())),
    },
    {
      // Фикс-раунд 2 (N-1): снятие выражением на месте всего `unset` — худший случай, а не «ничего».
      name: 'весь unset выражением — снятие неизвестного, факты не объявлены',
      run: async () => codeOfSync(() => assertAction(UNSET_BY_EXPR_UNDERDECLARED, actionScope())),
    },
  ],
};

// Строка 18: кап 0 порчей строки быть не может — это отказ ФОРМЫ (`VALIDATION ACTION_MALFORMED`,
// кап — целое ≥ 1), то есть вердикт другой строки; он пиннится в `registry/actions.test.ts`.
const ROW_18: RefusalRow = {
  row: 18,
  codes: ['BATCH_UNBOUNDED'],
  genre: 'declaration',
  positive: async () => {
    assertAction(POSTPONE, actionScope());
  },
  refuse: async () => codeOfSync(() => assertAction(BATCH_UNBOUNDED, actionScope())),
  spoils: [
    {
      name: 'капа нет вовсе — молчание читается так же, как явный null',
      run: async () => {
        const { batch_cap: _cap, ...noCap } = BATCH_UNBOUNDED;
        return codeOfSync(() => assertAction(noCap, actionScope()));
      },
    },
  ],
};

// Строка 19 порчей меняет СНИМОК, а не одно правило: `RULE_CONFLICT` — свойство пары писателей, и
// каждая порча кладёт к законному правилу ВТОРОГО писателя, а `assertRule` зовётся для второго.
const ENTER_OK = 'on_enter_class: вход в класс done проставляет отметку завершения';
const ENTER_BY_VALUE_OK = 'on_enter_class по значению: уход из варианта waiting снимает вопрос';
const CONFLICT_PAIR_FX = 'код RULE_CONFLICT: два включённых on_enter_class одного ключа события';
const DEFAULT_PARAM_OK = 'default: валюта конверта — из параметра движка';
const DEFAULT_LITERAL_OK = 'default: литерал того же рода, что свойство';
/** Второй писатель: то же правило под другим id — тот же ключ события, та же цель. */
const twinOf = (f: RuleFixture) => ({ ...ruleOf(f), id: `${String(ruleOf(f).id)}_twin` });
const ROW_19: RefusalRow = {
  row: 19,
  codes: ['RULE_CONFLICT'],
  genre: 'declaration',
  // Один писатель события на носителе — законно: позитив лежит в пробе, и проверка конфликта его ВИДИТ.
  positive: async () => {
    ruleCheckOf(ruleFixture(ENTER_OK));
  },
  refuse: async () => {
    const f = ruleFixture(CONFLICT_PAIR_FX);
    const [first, second] = f.rule as readonly unknown[];
    return codeOfSync(() => ruleCheck(f.carrier, second, [{ carrier: f.carrier, rules: [first] }]));
  },
  spoils: [
    {
      // Ф-Б2-28: ключ конфликта ГЛОБАЛЕН — второй писатель на свойстве-носителе спорит с правилом
      // аспекта так же, как сосед по строке. Валидатор, ищущий пару в пределах носителя, промолчал бы.
      name: 'к снимку добавлен второй on_enter_class того же события и той же цели set — на другом носителе',
      run: async () => {
        const f = ruleFixture(ENTER_OK);
        return codeOfSync(() =>
          ruleCheck({ kind: 'property', id: 'orbis/completed_at' }, twinOf(f), [
            { carrier: f.carrier, rules: [f.rule] },
          ]),
        );
      },
    },
    {
      // Другая форма ключа (`create|<свойство>`): два ЗАКОННЫХ по отдельности позитива словаря
      // (валюта из параметра и литералом) на одном свойстве — конфликт про пару, а не про шаблон.
      name: 'второй писатель — default на то же свойство (ключ create|…)',
      run: async () => {
        const first = ruleFixture(DEFAULT_PARAM_OK);
        const second = ruleFixture(DEFAULT_LITERAL_OK);
        return codeOfSync(() =>
          ruleCheck(second.carrier, second.rule, [{ carrier: first.carrier, rules: [first.rule] }]),
        );
      },
    },
    {
      // Третья форма ключа — уход (`leave|…|<свойство>`, `on_leave.unset`): валидатор, считающий
      // писателями только `set`, пропустил бы двух уборщиков одного свойства.
      name: 'второй писатель ухода — двойник on_leave.unset по значению',
      run: async () => {
        const f = ruleFixture(ENTER_BY_VALUE_OK);
        return codeOfSync(() =>
          ruleCheck(f.carrier, twinOf(f), [{ carrier: f.carrier, rules: [f.rule] }]),
        );
      },
    },
  ],
};

const REQUIRES_OK = 'requires_when: дата операции обязательна, пока движение не повторяющееся';
const DEREF_FX = 'код DEREF_IN_CONSTRAINT: правило записи читает чужую запись';
/** Чтение чужой записи через ссылку — единственная форма кода `DEREF_IN_CONSTRAINT` (§Б3-3). */
const DEREF_TITLE = { deref: { prop: 'orbis/finance_category', read: 'orbis/title' } };
const ROW_20: RefusalRow = {
  row: 20,
  codes: ['DEREF_IN_CONSTRAINT'],
  genre: 'declaration',
  // Позитив — `when` без deref; канонический отказ словаря — тот же позитив, где в `when` подставлено
  // чтение категории через ссылку (одна порча, объявленная в RULE_FIXTURES).
  positive: async () => {
    ruleCheckOf(ruleFixture(REQUIRES_OK));
  },
  refuse: async () => codeOfSync(() => ruleCheckOf(ruleFixture(DEREF_FX))),
  spoils: [
    {
      // Та же область C, другая позиция: значение T-правила вычисляется на записи так же, как условие.
      name: 'тот же deref в params.value T-правила default',
      run: async () => {
        const f = ruleFixture(DEFAULT_PARAM_OK);
        const rule = ruleOf(f) as { params: Record<string, unknown> };
        return codeOfSync(() =>
          ruleCheck(f.carrier, { ...rule, params: { ...rule.params, value: DEREF_TITLE } }),
        );
      },
    },
    {
      // Чекер обходит ДЕРЕВО, а не корень: в `when` позитива на глубине двух узлов чтение своего
      // `orbis/recurring` подменено чтением его через ссылку на категорию.
      name: 'в глубине when позитива prop подменён deref через ссылку',
      run: async () => {
        const f = ruleFixture(REQUIRES_OK);
        // Правка — заменой узла в `when` ПОЗИТИВА, а не своим литералом: разъедься словарь, порча
        // упала бы громко, а не мерила бы молча другое условие.
        const own = JSON.stringify({ prop: 'orbis/recurring' });
        const when = JSON.stringify(ruleOf(f).when);
        if (!when.includes(own)) {
          throw new Error('позитив строки 20 больше не читает orbis/recurring — порча разъехалась');
        }
        const viaRef = { deref: { prop: 'orbis/finance_category', read: 'orbis/recurring' } };
        return codeOfSync(() =>
          ruleCheck(f.carrier, {
            ...ruleOf(f),
            when: JSON.parse(when.replace(own, JSON.stringify(viaRef))),
          }),
        );
      },
    },
  ],
};

export const REFUSAL_ROWS: readonly RefusalRow[] = [
  ROW_1,
  ROW_2,
  ROW_3,
  ROW_4,
  ROW_5,
  ROW_6,
  ROW_7,
  ROW_8,
  ROW_9,
  ROW_10,
  ROW_11,
  ROW_12,
  ROW_13,
  ROW_14,
  ROW_15,
  ROW_16,
  ROW_17,
  ROW_18,
  ROW_19,
  ROW_20,
  ROW_21,
];

// ─────────────────────────────── сев мира корпуса ───────────────────────────────

/** Последний день месяца `YYYY-MM`. */
const lastDayOf = (month: string): string => {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return `${month}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
};

export async function prepareRefusals(): Promise<void> {
  await truncateAll();
  const { db, client } = appDb();
  // Личности заводятся ПОСЛЕ зачистки: `truncateAll` сносит графы, не заминченные процессом.
  const owner = await freshGraph();
  const moduleOwner = await freshGraph();
  // Строка 10: двойники встроенных аспектов Финансов (Финансы у графа `freshGraph` включены).
  await seedCustomAspect(owner, TWIN_ENVELOPE);
  await seedCustomAspect(owner, TWIN_MONEY);

  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(new Date());
  const month = today.slice(0, 7);
  const periodEnd = lastDayOf(month);
  const nextMonth = addDays(periodEnd, 1).slice(0, 7);

  /** Сев идёт МИМО `world()`: мира ещё нет — его и собирает эта функция. */
  const seed = async (who: GraphId, tool: string, input: unknown): Promise<ExecuteOk> => {
    const r = await execute(db, {
      identity: personal(who),
      actorKind: 'owner',
      source: 'ui',
      operations: [{ tool, input }],
    });
    if (!r.ok) throw new Error(`сев корпуса ${tool}: ${r.error.code} — ${r.error.message}`);
    return r;
  };
  const entity = async (who: GraphId, input: Record<string, unknown>): Promise<string> =>
    ((await seed(who, 'entity_create', { tags: [], ...input })).results[0] as { id: string }).id;

  // Аспект владельца под строку 9: он обязан НОСИТЬ всё, что биндит, иначе `checkImplements`
  // ответит `UNKNOWN_PROPERTY/not_carried` вместо `BIND_TYPE` (образец `ops.test.ts:922-934`).
  await seed(owner, 'aspect_create', {
    key: 'user/gig',
    label: { ru: 'Выступление' },
    description: { ru: 'Аспект владельца под строку 9 корпуса' },
    properties: [
      { propertyId: 'orbis/start_at', required: true },
      { propertyId: 'orbis/location', required: false },
      { propertyId: 'orbis/task_status', required: false },
    ],
  });

  const categoryId = await entity(owner, {
    title: 'Категория корпуса',
    aspects: ['orbis/category'],
  });
  const envelopeId = await entity(owner, {
    title: 'Конверт корпуса',
    aspects: ['orbis/budget'],
    props: {
      'orbis/finance_category': categoryId,
      'orbis/limit': '5000.00',
      'orbis/period_start': `${month}-01`,
      'orbis/period_end': periodEnd,
    },
  });
  // Привязку `envelope-binding` ставит ХУК бюджета на создании траты, и строка 13 отказывает на
  // ВТОРОЙ, ручной попытке — то есть ровно там, где её ставил бы владелец.
  const txnId = await entity(owner, {
    title: 'Трата корпуса',
    aspects: ['orbis/financial'],
    props: {
      'orbis/amount': '340.00',
      'orbis/direction': 'expense',
      'orbis/finance_category': categoryId,
      'orbis/occurred_on': today,
    },
  });
  const projectId = await entity(owner, {
    title: 'Проект корпуса',
    aspects: ['orbis/project'],
    props: { 'orbis/project_stage': 'active' },
  });
  const taskId = await entity(owner, {
    title: 'Задача корпуса',
    aspects: ['orbis/task'],
    props: { 'orbis/task_status': 'planned' },
  });
  // §С8-21: две привязки контракта конверта на одной записи — `orbis/budget` и двойник владельца.
  // Период — СЛЕДУЮЩИЙ месяц НАМЕРЕННО: позитив строки 10 обязан пройти ДО того, как `refuse` втянет
  // конверт в месяц обзора правкой. Категория своя: хук привязки трат к ней не ходит.
  const ambiguousCategoryId = await entity(owner, {
    title: 'Категория строки 10',
    aspects: ['orbis/category'],
  });
  const ambiguousId = await entity(owner, {
    title: 'Конверт-двойник корпуса',
    aspects: ['orbis/budget', TWIN_ENVELOPE_KEY],
    props: {
      'orbis/finance_category': ambiguousCategoryId,
      'orbis/limit': '1000.00',
      'orbis/period_start': `${nextMonth}-01`,
      'orbis/period_end': lastDayOf(nextMonth),
    },
  });

  // Строка 21 идёт от СВОЕГО владельца: выключенный модуль испортил бы соседям обстановку с
  // финансами. Категория и заметка заводятся ДО выключения — иначе их нечем было бы навесить.
  const moduleCategoryId = await entity(moduleOwner, {
    title: 'Категория выключенного модуля',
    aspects: ['orbis/category'],
  });
  const moduleNoteId = await entity(moduleOwner, {
    title: 'Заметка выключенного модуля',
    aspects: ['orbis/note'],
  });
  await seed(moduleOwner, 'module_set', { module: 'finance', enabled: false });

  W = {
    db,
    close: () => client.end(),
    reg: builtinSnapshot(),
    owner,
    moduleOwner,
    moduleCategoryId,
    moduleNoteId,
    ambiguousId,
    ambiguousCategoryId,
    monthStart: `${month}-01`,
    monthEnd: periodEnd,
    nextMonthStart: `${nextMonth}-01`,
    nextMonthEnd: lastDayOf(nextMonth),
    envelopeId,
    txnId,
    taskId,
    projectId,
    today,
  };
}
export async function closeRefusals(): Promise<void> {
  await W?.close();
  W = undefined;
}
