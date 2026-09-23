// apps/server/test/fixtures/refusals.ts
// 21 СТРОКА КАНОНИЧЕСКИХ ОТКАЗОВ (§С1-2, ревизия 4) КАК ДАННЫЕ. Мерка §С8-24: у каждой строки есть
// ПОЗИТИВ (та же форма без порчи проходит), канонический ОТКАЗ и ≥1 ПОРЧА, меняющая вердикт.
// Позитив обязателен рядом с негативом: валидатор, отвергающий всё, прошёл бы прогон 21/21.
// ДВА ЖАНРА ВХОДА: 17 строк — испорченная ДЕКЛАРАЦИЯ, 4 — ЗАПИСЬ ДАННЫХ (их бросают исполнитель и
// движок, и «испортить декларацию» для них невыразимо).
//
//  # · код(ы)                    · дверь                                       · жанр
//  1 · REGISTRY_CYCLE            · assertAcyclicGraph(dependencyGraph)         · декларация
//  2 · COMPUTED_WRITE            · execute entity_update                       · данные
//  3 · ACTION_NESTED/BRANCH      · assertAction (задача 6)                     · декларация
//  4 · EXPR_RECURSION            · assertSubscription                          · декларация
//  5 · EXPR_TYPE/EXPR_NOT_TOTAL  · assertSubscription                          · декларация
//  6 · QUERY_MULTI_ROLE/JOIN     · parseQueryAst                               · декларация
//  7 · SUBSCRIPTION_RAW_REF      · assertSubscription                          · декларация
//  8 · VARIANT_UNMAPPED          · execute aspect_delta_set                    · декларация
//  9 · BIND_TYPE                 · execute aspect_implements_set               · декларация
// 10 · SLOT_AMBIGUOUS            · движок Agenda → resolveSlotOnEntity         · данные
// 11 · UNIQUE_ON_MANY            · assertRule                                  · декларация
// 12 · SCOPE_NOT_STATIC          · execute property_create                     · декларация
// 13 · ROLE_SYSTEM_ONLY          · execute relation_create                     · данные
// 14 · PATTERN_NOT_REGULAR       · execute property_create                     · декларация
// 15 · SENSITIVITY_UNDERDECLARED · assertAction (задача 6)                     · декларация
// 16 · SECOND_LANGUAGE           · assertSubscription                          · декларация
// 17 · SURFACE_UNKNOWN           · assertSubscription                          · декларация
// 18 · BATCH_UNBOUNDED           · assertAction (задача 6)                     · декларация
// 19 · RULE_CONFLICT             · assertRule                                  · декларация
// 20 · DEREF_IN_CONSTRAINT       · assertRule → чекер E                        · декларация
// 21 · MODULE_DISABLED           · execute entity_create                       · данные
import {
  AGENDA_DEF,
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
import { appDb, freshGraph, personal, seedCustomAspect, truncateAll } from '../helpers';
import {
  ACTION_BRANCH,
  ACTION_NESTED,
  ACTION_NESTED_BY_TOOL,
  BATCH_UNBOUNDED,
  P2F,
  POSTPONE,
  SENSITIVITY_UNDERDECLARED,
  SENSITIVITY_UNDERDECLARED_ATTACH,
} from './action-seed';
import { GATE_PLAIN_ASPECT, GATE_PLAIN_KEY, GATE_PROPS } from './gate-aspects';

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
  red?: true; // валидатора строки ещё нет
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
  ambiguousId: string; // две привязки слота `moment` (строка 10)
  envelopeId: string;
  txnId: string; // пара под системную роль (строка 13)
  taskId: string;
  projectId: string; // запись вычисляемого свойства (строка 2)
  today: string;
  tomorrowAt: string;
  yesterdayAt: string;
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
    id: 'orbis/agenda',
    graphId: null,
    surface: 'planner/agenda',
    definition,
    module: null,
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

const SEED = () => ({ reg: builtinSnapshot(), systemSeed: true });
const agendaWith = (o: Record<string, unknown>) => ({ ...AGENDA_DEF, ...o });
const overdueWith = (o: Record<string, unknown>) =>
  agendaWith({ overdue: { ...AGENDA_DEF.overdue, ...o } });
const budgetRow = (d: unknown) => subRow(d, { surface: 'finance/budget-overview' });
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
    assertSubscription(subRow(AGENDA_DEF), SEED());
  },
  refuse: async () =>
    codeOfSync(() =>
      assertSubscription(
        subRow(
          agendaWith({
            show: {
              ...AGENDA_DEF.show,
              window: { ...AGENDA_DEF.show.window, to: { const: true } },
            },
          }),
        ),
        SEED(),
      ),
    ),
  spoils: [
    {
      name: 'вторая граница окна булевым выражением',
      run: async () =>
        codeOfSync(() =>
          assertSubscription(
            subRow(
              agendaWith({
                show: {
                  ...AGENDA_DEF.show,
                  window: { ...AGENDA_DEF.show.window, from: { const: true } },
                },
              }),
            ),
            SEED(),
          ),
        ),
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
  // называть именно её, а не голый `AGENDA_DEF` — иначе строка молчала бы о половине правила.
  positive: async () => {
    assertSubscription(
      subRow(agendaWith({ show: { ...AGENDA_DEF.show, prefer: ['orbis/schedule'] } })),
      SEED(),
    );
  },
  refuse: async () =>
    codeOfSync(() =>
      assertSubscription(
        subRow(
          overdueWith({
            where: { op: '=', args: [{ const: 'orbis/task' }, { const: 'orbis/task' }] },
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
              overdueWith({
                where: {
                  op: 'and',
                  args: [
                    {
                      op: 'in',
                      args: [{ class: { contract: 'orbis/completable' } }, { const: ['active'] }],
                    },
                    { op: '!=', args: [{ prop: 'orbis/task_status' }, { const: 'waiting' }] },
                  ],
                },
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
            subRow(
              overdueWith({
                where: {
                  op: 'and',
                  args: [AGENDA_DEF.overdue.where, { has: 'orbis/task_status' }],
                },
              }),
            ),
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
    assertSubscription(subRow(AGENDA_DEF), SEED());
  },
  refuse: async () =>
    codeOfSync(() =>
      assertSubscription(subRow(overdueWith({ where: 'class(completable) in open' })), SEED()),
    ),
  spoils: [
    {
      name: 'текст в границе окна — та же вторая грамматика другой позицией',
      run: async () =>
        codeOfSync(() =>
          assertSubscription(
            subRow(
              agendaWith({
                show: {
                  ...AGENDA_DEF.show,
                  window: { ...AGENDA_DEF.show.window, to: 'сегодня + 8 дней' },
                },
              }),
            ),
            SEED(),
          ),
        ),
    },
  ],
};

const ROW_17: RefusalRow = {
  row: 17,
  codes: ['SURFACE_UNKNOWN'],
  genre: 'declaration',
  positive: async () => {
    assertSubscription(subRow(AGENDA_DEF), SEED());
  },
  refuse: async () =>
    codeOfSync(() => assertSubscription(subRow(AGENDA_DEF, { surface: 'core/row' }), SEED())),
  spoils: [
    {
      name: 'опечатка имени поверхности — отказ, а не «похожая»',
      run: async () =>
        codeOfSync(() =>
          assertSubscription(subRow(AGENDA_DEF, { surface: 'planner/agendas' }), SEED()),
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
  ],
};

// ───────────────────── строка 10: SLOT_AMBIGUOUS движком Повестки ─────────────────────
// Конфликт слота живёт У СУЩНОСТИ, а не в декларации (докблок `subscriptions/registry.ts:742-755`):
// `GATE_PLAIN_ASPECT` реализует `orbis/when.moment` через свой момент, `orbis/schedule` — через
// `orbis/start_at`; обе на одной записи ВНУТРИ окна дают отказ движка.

const agendaOf = (owner: GraphId) =>
  createCallerFactory(appRouter)({
    identity: personal(owner),
    actorKind: 'owner',
    db: world().db,
    clientVersion: null,
  }).agenda.list({ days: 8 });
const ROW_10: RefusalRow = {
  row: 10,
  codes: ['SLOT_AMBIGUOUS'],
  genre: 'data',
  positive: async () => {
    await agendaOf(world().owner); // конфликтная запись ещё ЗА окном
  },
  refuse: async () => {
    await run(world().owner, 'entity_update', {
      id: world().ambiguousId,
      props: { [GATE_PROPS.plainAt]: world().tomorrowAt },
    });
    return codeOfAsync(async () => {
      await agendaOf(world().owner);
    });
  },
  spoils: [
    {
      name: 'конфликт в секции просроченного — тот же отказ другой секцией',
      run: async () => {
        await run(world().owner, 'entity_update', {
          id: world().ambiguousId,
          props: {
            [GATE_PROPS.plainAt]: world().yesterdayAt,
            'orbis/start_at': world().yesterdayAt,
          },
        });
        return codeOfAsync(async () => {
          await agendaOf(world().owner);
        });
      },
    },
  ],
};

// ───────── строки 3/15/18 (валидатор действий, задача 6) и строки 11/19/20 (валидатор правил, задача 1) ─────────

const ruleScope = (kind: 'aspect' | 'property' | 'role', id: string) => ({
  reg: world().reg,
  carrier: { kind, id },
  systemSeed: true,
});
/**
 * Область валидатора действий: снимок мира корпуса (встроенные словари + посеянные действия) и
 * системный сид — корпус меряет сидовые декларации модулей (`finance/…`, `planner/…`), и namespace
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

/** Строка 11: правило `unique_among` над свойствами — локальная фабрика (перенос из задачи 12, Ф-Б2-14). */
const uniqueAmongFixture = (properties: readonly string[]) => ({
  id: 'r11',
  template: 'unique_among',
  params: { properties: [...properties] },
});
/** Снимок мира корпуса и аспект-носитель правила — `assertRule` синхронен, снимок уже собран. */
const aspectScope = (id: string) => ({
  reg: world().reg,
  carrier: { kind: 'aspect' as const, id },
  systemSeed: false,
});
const ROW_11: RefusalRow = {
  row: 11,
  codes: ['UNIQUE_ON_MANY'],
  genre: 'declaration',
  // Позитив и порча идут через ТОТ ЖЕ `assertRule`, что и боевая запись строки реестра:
  // корпус проверяет валидатор, а не свою копию его правил.
  positive: async () => {
    assertRule(uniqueAmongFixture(['orbis/period_start']), aspectScope('orbis/budget'));
  },
  refuse: async () =>
    codeOfSync(() =>
      assertRule(uniqueAmongFixture(['orbis/aliases']), aspectScope('orbis/category')),
    ),
  spoils: [
    {
      name: 'списочное свойство вторым в наборе',
      run: async () =>
        codeOfSync(() =>
          assertRule(
            uniqueAmongFixture(['orbis/title', 'orbis/aliases']),
            aspectScope('orbis/category'),
          ),
        ),
    },
    {
      name: 'набор из одного списочного свойства',
      run: async () =>
        codeOfSync(() =>
          assertRule(uniqueAmongFixture(['orbis/aliases']), aspectScope('orbis/category')),
        ),
    },
    {
      // Порча 0c (Ф-Б2-8): второго `many`-свойства на `orbis/category` в словаре нет, поэтому пара
      // берётся у `orbis/routine` — отказ про РОД свойства (`select` many тоже список), а не про
      // одно имя `orbis/aliases`.
      name: 'второе many-свойство в том же списке — отказ про род, а не про первое имя',
      run: async () =>
        codeOfSync(() =>
          assertRule(
            uniqueAmongFixture(['orbis/routine_days', 'orbis/allowed_tools']),
            aspectScope('orbis/routine'),
          ),
        ),
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

const enterDone = {
  id: 'corpus_task_completed_at',
  template: 'on_enter_class',
  params: {
    enter: { contract: 'orbis/completable', slot: 'status', in: ['done'] },
    set: { property: 'orbis/completed_at', value: { prop: 'orbis/updated_at' } },
  },
};
const defaultCurrency = (id: string) => ({
  id,
  template: 'default',
  params: { property: 'orbis/currency', value: { param: 'default_currency' } },
});
/**
 * Снимок-проба с ЧУЖИМИ правилами на носителе: `RULE_CONFLICT` — свойство ПАРЫ, и одного правила
 * на входе валидатору мало. Поле `rules` приезжает к строкам задачей 2, поэтому проба ставит его
 * структурно (`rulesFieldOf`, Р-К-52) — так же, как его читает валидатор (`rulesOf`).
 */
const regWithRules = (aspectId: string, rules: readonly unknown[]): RegistrySnapshot => {
  const reg = builtinSnapshot();
  const carrier = reg.aspects.get(aspectId);
  if (carrier === undefined) throw new Error(`носителя ${aspectId} нет в словаре`);
  reg.aspects.set(aspectId, { ...carrier, rules: [...rules] } as never);
  return reg;
};
const conflictScope = (aspectId: string, rules: readonly unknown[]) => ({
  reg: regWithRules(aspectId, rules),
  carrier: { kind: 'aspect' as const, id: aspectId },
  systemSeed: true,
});
const ROW_19: RefusalRow = {
  row: 19,
  codes: ['RULE_CONFLICT'],
  genre: 'declaration',
  positive: async () => {
    assertRule(enterDone, conflictScope('orbis/task', [enterDone]));
  },
  refuse: async () => {
    const other = { ...enterDone, id: 'corpus_task_completed_at_twin' };
    return codeOfSync(() => assertRule(other, conflictScope('orbis/task', [enterDone, other])));
  },
  spoils: [
    {
      // Пара `default`+`default` на одном свойстве — тот же ключ события (`create|<свойство>`):
      // конфликт про ПАРУ писателей, а не про шаблон `on_enter_class`.
      name: 'второй писатель — default на то же свойство',
      run: async () => {
        const first = defaultCurrency('corpus_currency_first');
        const second = defaultCurrency('corpus_currency_second');
        return codeOfSync(() => assertRule(second, conflictScope('orbis/budget', [first, second])));
      },
    },
  ],
};

const DEREF_CATEGORY_TITLE = {
  op: '=',
  args: [{ deref: { prop: 'orbis/finance_category', read: 'orbis/title' } }, { const: 'Еда' }],
};
const ROW_20: RefusalRow = {
  row: 20,
  codes: ['DEREF_IN_CONSTRAINT'],
  genre: 'declaration',
  positive: async () => {
    assertRule(
      {
        id: 'corpus_requires_occurred_on',
        template: 'requires_when',
        when: {
          op: 'not',
          args: [{ op: '=', args: [{ prop: 'orbis/recurring' }, { const: true }] }],
        },
        params: { property: 'orbis/occurred_on' },
      },
      ruleScope('aspect', 'orbis/financial'),
    );
  },
  refuse: async () =>
    codeOfSync(() =>
      assertRule(
        {
          id: 'corpus_deref_when',
          template: 'requires_when',
          when: DEREF_CATEGORY_TITLE,
          params: { property: 'orbis/occurred_on' },
        },
        ruleScope('aspect', 'orbis/financial'),
      ),
    ),
  spoils: [
    {
      name: 'тот же deref в значении T-правила — область C, а не позиция `when`',
      run: async () =>
        codeOfSync(() =>
          assertRule(
            {
              id: 'corpus_deref_value',
              template: 'default',
              params: { property: 'orbis/currency', value: DEREF_CATEGORY_TITLE },
            },
            ruleScope('aspect', 'orbis/financial'),
          ),
        ),
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

/** Момент с фиксированным смещением Europe/Moscow (дефолт `user_settings.timezone`). */
const at = (day: string, time: string) => `${day}T${time}:00+03:00`;

export async function prepareRefusals(): Promise<void> {
  await truncateAll();
  const { db, client } = appDb();
  // Личности заводятся ПОСЛЕ зачистки: `truncateAll` сносит графы, не заминченные процессом.
  const owner = await freshGraph();
  const moduleOwner = await freshGraph();
  await seedCustomAspect(owner, GATE_PLAIN_ASPECT);

  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(new Date());
  const month = today.slice(0, 7);
  const [y, m] = month.split('-').map(Number) as [number, number];
  const periodEnd = `${month}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
  const far = addDays(today, 30);

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
  // §С8-21: два `moment` на одной записи — своя привязка гейта и `orbis/schedule`. Момент за
  // окном (сегодня + 30) НАМЕРЕННО: позитив строки 10 обязан пройти ДО того, как `refuse`
  // втянет запись в окно правкой.
  const ambiguousId = await entity(owner, {
    title: 'Дело корпуса и событие',
    aspects: [GATE_PLAIN_KEY, 'orbis/schedule'],
    props: {
      [GATE_PROPS.plainState]: 'open',
      [GATE_PROPS.plainAt]: at(far, '09:00'),
      'orbis/start_at': at(far, '09:00'),
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
    envelopeId,
    txnId,
    taskId,
    projectId,
    today,
    tomorrowAt: at(addDays(today, 1), '10:00'),
    yesterdayAt: at(addDays(today, -1), '10:00'),
  };
}
export async function closeRefusals(): Promise<void> {
  await W?.close();
  W = undefined;
}
