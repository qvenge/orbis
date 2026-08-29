/**
 * Канонический Q-AST — решение §А5-7 спеки «Реформа свойств».
 *
 * Что здесь нового против сегодняшнего `grammar.ts`: фильтр стал ДЕРЕВОМ `and/or/not`
 * произвольной вложенности (сегодня — плоский массив, где OR живёт только внутри значения
 * одного поля, а отрицание выражено тремя частными узлами: `noneOf`, `excludeTags`,
 * `excludeBlocked`). Параметры проекции (`sortBy`, `limit`, `display`, `title`) остались
 * отдельными полями корня — §А5-1 требует именно структурного отделения предикатов от
 * проекции, и в старом AST оно уже было.
 *
 * Почему НЕТ операторов `gte`/`lte` (находка 8 ревью плана): набор операторов §А5-7 закрыт
 * семью именами, и граница «не позже» кодируется ВКЛЮЧАЮЩИМ `range` — `x<=v` → `{to: v}`,
 * `x>=v` → `{from: v}`. Два способа сказать одно и то же разъехались бы в компиляторе:
 * `<=` пишется в SQL как `<=`, а `range` — как `BETWEEN`, и одна из веток неизбежно
 * получила бы другую границу включения.
 *
 * Файл — ЛИСТ пакета: он не импортирует ни реестр, ни парсер. Это важно, потому что
 * `registry/types.ts` и `registry/property-type.ts` сужают им `ref.target` и `scope`
 * (§А6-1, §А2-1), и обратное ребро замкнуло бы инициализацию zod-схем в цикл.
 *
 * Старый `grammar.ts`/`parse.ts`/`serialize.ts` живут рядом до Задачи 21 (РП-11): канон
 * заводится РЯДОМ, а не вместо — компилятор переключила Задача 9b.
 *
 * АДРЕСА ВИДА `compile.ts:NNN` НИЖЕ — В СНЯТОМ ФАЙЛЕ: старый серверный компилятор
 * `apps/server/src/query/compile.ts` удалён Задачей 9b вместе с последним потребителем, и
 * ссылки на него читаются по git-истории этого пути. Оставлены они потому, что называют
 * ПОВЕДЕНИЕ, которое реформа обязалась не менять, — без адреса проверить это негде.
 */
import { z } from 'zod';

/**
 * Относительное время запроса. Ровно четыре токена — те же, что у сегодняшней грамматики
 * (`grammar.ts:18`): их разворачивает компилятор по таймзоне владельца, и потому запрос
 * с токеном НЕ статичен (см. `static.ts`).
 */
export const QUERY_DATE_TOKENS = ['today', 'overdue', 'next_7d', 'after_7d'] as const;
export type QueryDateToken = (typeof QUERY_DATE_TOKENS)[number];

/** Операторы предиката свойства — закрытый набор §А5-7. */
export const QUERY_PROP_OPS = ['eq', 'ne', 'gt', 'lt', 'range', 'in', 'contains'] as const;
export type QueryPropOp = (typeof QUERY_PROP_OPS)[number];

/**
 * Реляционные предикаты §А5-7 — все по ОДНОЙ роли. Обход по нескольким ролям сразу за
 * границей Q (паспорт Q), поэтому `descendants_of`/`ancestors_of` без `via` — отказ
 * `QUERY_MULTI_ROLE`, а не «пойдём по всем».
 */
export const QUERY_REL_KINDS = [
  'children_of',
  'parents_of',
  'has_relation',
  'has_children',
  'descendants_of',
  'ancestors_of',
] as const;
export type QueryRelKind = (typeof QUERY_REL_KINDS)[number];

export const QUERY_DISPLAY_MODES = ['compact', 'list', 'table'] as const;
export type QueryDisplayMode = (typeof QUERY_DISPLAY_MODES)[number];

/**
 * Кап глубины рекурсивного обхода `descendants_of`/`ancestors_of` (Ч9). Это КОНСТАНТА
 * КОМПИЛЯТОРА, а не поле узла: глубина — свойство исполнения, не запроса, и пользователь
 * не должен уметь заказать обход на 10 000 уровней отдельным запросом.
 */
export const QUERY_DEPTH_CAP = 32;

/**
 * Кап ВЛОЖЕННОСТИ САМОГО ДЕРЕВА запроса, в уровнях JSON. Не путать с `QUERY_DEPTH_CAP`
 * выше: тот про обход графа, этот — про форму присланного запроса.
 *
 * ЧИСЛО ВЫБРАНО СВЕРХУ — ОТ НАСТОЯЩИХ ЗАПРОСОВ, а не снизу, от чужих порогов, и это
 * единственная его опора: самое глубокое дерево нормативных наборов — 8 уровней (эталон
 * golden «Активные задачи проекта»; максимум фикстур канона — 7), то есть кап даёт
 * восьмикратный запас тому, что вообще бывает. Обе величины ПИННЯТСЯ тестами —
 * `ast.test.ts` и `compile.golden.test.ts`, — поэтому «8» здесь не оценка, а замер.
 *
 * ЧУЖИЕ ПОРОГИ ЗДЕСЬ НЕ ЧИСЛА, А ПОРЯДКИ, и это осознанно. Ниже по конвейеру ломаются
 * двое: рекурсия `z.lazy` (счёт на тысячи уровней) и парсер Postgres на цепочке
 * `NOT COALESCE(…)` (счёт на тысячи же, и он ближе). Оба зависят от версии, сборки и
 * `max_stack_depth`, то есть меняются без нашего ведома — записанное здесь точное число
 * устарело бы молча, и первая же попытка «подогнать кап поближе» вернула бы ту самую
 * полосу, где отказ приходил не от нас. Кап меньше ближайшего из них на порядок с лишним,
 * и этот запас — следствие выбора сверху, а не его причина: сдвинется чужая граница —
 * здесь не изменится ничего.
 *
 * Проверяется ЯВНЫМ обходом (`queryTreeExceedsDepth`) ДО zod и до компиляции — иначе
 * проверять было бы уже нечем: рекурсия `z.lazy` исчерпывает стек раньше любого условия,
 * которое можно поставить внутри схемы.
 */
export const QUERY_TREE_DEPTH_CAP = 64;

/**
 * Глубже ли значение, чем `cap` уровней вложенности JSON. Обход ИТЕРАТИВНЫЙ и по СЫРОМУ
 * значению: он стоит перед схемой, то есть до него вход не проверен ничем, и рекурсивная
 * реализация исчерпала бы стек ровно на том же входе, ради которого её и зовут.
 *
 * Считается вложенность JSON, а не узлов канона: до разбора формы у входа ещё нет, а
 * гарантия нужна безусловная — «в этой структуре не больше N уровней, что бы в ней ни
 * лежало». Один уровень канона стоит двух уровней JSON у ветвящихся узлов (`{or: [ … ]}` —
 * объект и массив), поэтому кап в 64 уровня JSON — это порядка 32 уровней `and`/`or`/`not`.
 */
export function queryTreeExceedsDepth(value: unknown, cap: number): boolean {
  const stack: Array<[unknown, number]> = [[value, 1]];
  while (stack.length > 0) {
    const [node, depth] = stack.pop() as [unknown, number];
    if (typeof node !== 'object' || node === null) continue;
    if (depth > cap) return true;
    for (const child of Array.isArray(node) ? node : Object.values(node)) {
      stack.push([child, depth + 1]);
    }
  }
  return false;
}

/** Литерал значения свойства: текст, число, флаг. Decimal едет СТРОКОЙ (хвост копеек). */
export type QueryScalar = string | number | boolean;
/** Относительное время вместо литерала — только у date/timestamp-свойств. */
export interface QueryTokenValue {
  token: QueryDateToken;
}
export type QueryBound = QueryScalar | QueryTokenValue;
/** Границы `range` ВКЛЮЧАЮЩИЕ с обеих сторон; хотя бы одна обязана присутствовать. */
export interface QueryRangeValue {
  from?: QueryBound;
  to?: QueryBound;
}
export type QueryPropValue = QueryScalar | QueryTokenValue | QueryScalar[] | QueryRangeValue;

/**
 * Реляционный предикат §А5-7. Форма СВЯЗАНА с `kind`, и связь эта нормативная, а не
 * косметическая: `descendants_of` без `via` — обход сразу по нескольким ролям, то есть
 * запрос ЗА ГРАНИЦЕЙ языка (§А5-1, отказ `QUERY_MULTI_ROLE`), а `children_of` без `of` —
 * предикат без второго конца. Текстовый путь такое отвергает всегда; но вход `ast:` тула
 * `entity_query` (§А5-4) идёт МИМО парсера, и без связи в самой схеме гарантия §С8-3
 * («невыразимое — ошибка, а не пустота») обходилась бы через тул.
 *
 * `of` — uuid сущности либо `this` («сущность, в теле которой лежит запрос»).
 * `via` — id роли ребра (§А4-3); у `children_of`/`parents_of`/`has_children` он
 * необязателен: без него предикат идёт по СЕМЕЙСТВУ иерархии (`HIERARCHICAL_ROLE_IDS`,
 * §А4-2), и это ровно одна роль на строку графа, а не обход по нескольким.
 */
export type QueryRelPredicate =
  | { kind: 'children_of' | 'parents_of'; via?: string; of: string }
  | { kind: 'descendants_of' | 'ancestors_of'; via: string; of: string }
  | { kind: 'has_relation'; via: string; of?: undefined; sourceNotIn?: QueryRelSourceNotIn }
  | { kind: 'has_children'; via?: string; of?: undefined };

/**
 * Состояние ВТОРОГО конца ребра у `has_relation` — «ребро считается, только если у его
 * ИСТОЧНИКА свойство `prop` не имеет ни одного из значений `values` (в том числе когда
 * значения нет вовсе)».
 *
 * ЭТО НЕ НОВОЕ ИЗОБРЕТЕНИЕ, А КОНКРЕТИЗАЦИЯ УЖЕ ПРИНЯТОГО РАСШИРЕНИЯ Е-1 (рулинг Р-9a-5).
 * Спека, §Е-1: «`has_relation(role[, in_set])` — предикат наличия ребра роли у `$self`
 * (заимствован из Q; стоимость — один индексный пробник `(target_id, role)`; вариант с
 * `in_set` проверяет набор завершаемости другого конца — та же форма, что `excludeBlocked`)».
 * То есть параметр, проверяющий набор на ДАЛЬНЕМ конце ребра, спекой предусмотрен; здесь он
 * назван `sourceNotIn`, потому что в срезе А контрактов ещё нет и «набор завершаемости»
 * выражается прямой проверкой свойства вместо класса контракта.
 *
 * ДАТА СМЕРТИ ПОЛЯ — срез Б-1, и это проверяемое утверждение, а не обещание: там же, в §Е-1,
 * форма названа `in_set`, а таблица спеки определяет `excludeBlocked` как
 * `has_relation(dependency) ∧ class(completable) ∉ closed`. Приедут контракты — поле
 * заменяется на `in_set`/`class(completable)` ЦЕЛИКОМ, а не дополняется. Признак, по которому
 * следующий читатель поймёт, что момент настал: в реестре появился контракт `orbis/completable`
 * и узел `{class}` перестал отвечать `CLASS_NOT_AVAILABLE`.
 *
 * ПОЧЕМУ ВЫБРОСИТЬ УСЛОВИЕ БЫЛО НЕЛЬЗЯ. Старый компилятор смотрел на статус блокера
 * (`compile.ts:272`), и без этого условия «отпущенный» блокер (задача в `done`) начал бы
 * прятать работу — то есть реформа поменяла бы то, что владелец видит в блоке «Сегодня».
 *
 * Почему поле, а не «условие статуса на все узлы `has_relation`»: узел
 * `{not:{rel:{has_relation, via:'dependency'}}}` порождается И сахаром `excludeBlocked=true`,
 * И пользовательским `!has_relation=dependency`. Это РАЗНЫЕ намерения («не заблокировано
 * живой работой» и «нет входящих рёбер этой роли»), и различить их можно только в самом
 * дереве.
 *
 * Почему НЕ общий `where: QueryFilterNode` (форма, к которой канон придёт в Б-1): общее
 * условие на дальний конец — это полноценный второй компилятор в подзапросе (свои алиасы
 * строки, свои вложенные рёбра, свой `search`), и заводить его ради одного интервального
 * случая значило бы отдать наружу схему, которую компилятор среза А поддерживает наполовину.
 * Это поле — УЖЕ форма §Е-1 с точностью до способа сказать «closed».
 *
 * Поле НЕОБЯЗАТЕЛЬНОЕ, и его отсутствие компилируется ровно как раньше — голым
 * `EXISTS (… WHERE r.target_id = e.id AND r.role = …)`, без соединения с `entities`
 * (условие рулинга «в»; пиннится эталоном `has_relation=dependency` в golden рядом с
 * эталоном сахара).
 */
export interface QueryRelSourceNotIn {
  /** id свойства ИСТОЧНИКА ребра (§А5-7: в дереве лежат id, не подписи). */
  prop: string;
  /** Значения, при которых ребро НЕ считается; пустой список бессмыслен и запрещён схемой. */
  values: QueryScalar[];
}

/**
 * Каким КОНЦОМ ребра стоит сама сущность в каждом реляционном предикате — норматив для
 * компилятора (Задача 9a), а не подсказка. Старый компилятор кодировал то же самое
 * тремя разными местами (`compile.ts:248` — `children_of` через `target_id`, `:250` —
 * `parents_of` через `source_id`, `:254` — «заблокирована» через входящее ребро), и именно
 * из-за трёх мест направление легко перепутать при переписывании.
 *
 * `has_relation` — ВХОДЯЩЕЕ ребро (рулинг координатора при предразборе Задачи 8): сущность
 * стоит целью, `role = via`. Основания рулинга: несущий индекс `(target_id, role)` (Р-5
 * плана), и сохранение поведения `excludeBlocked` — при «обоих направлениях» отрицание
 * вычёркивало бы ещё и сами блокирующие работы, чего старый компилятор не делал
 * (`compile.ts:262`).
 */
export const QUERY_REL_ANCHOR: Readonly<Record<QueryRelKind, 'source' | 'target'>> = {
  // сущность — ребёнок: ребро идёт от `of` (родителя) к ней
  children_of: 'target',
  // сущность — родитель: ребро идёт от неё к `of`
  parents_of: 'source',
  descendants_of: 'target',
  ancestors_of: 'source',
  // «на сущность ссылаются ролью»: она ЦЕЛЬ ребра
  has_relation: 'target',
  // «у сущности есть дети»: она ИСТОЧНИК ребра
  has_children: 'source',
};

/** Узел фильтра §А5-7. Форма каждого узла — один ключ-имя: разбор union'а по ключу. */
export type QueryFilterNode =
  | { and: QueryFilterNode[] }
  | { or: QueryFilterNode[] }
  | { not: QueryFilterNode }
  | { prop: string; op: QueryPropOp; value: QueryPropValue }
  | { has: string }
  | { aspect: string }
  | { tag: string }
  | { search: string }
  | { rel: QueryRelPredicate }
  | { archived: 'true' | 'any' }
  | { class: { contract: string; set: string } };

export interface QuerySortField {
  /** id свойства (§А5-7) — доменного или core-проекции §А1-3 (`orbis/updated_at`). */
  field: string;
  dir: 'asc' | 'desc';
}

export interface QueryAst {
  filter: QueryFilterNode | null;
  sortBy?: QuerySortField[];
  limit?: number;
  display?: QueryDisplayMode;
  title?: string;
}

// ─────────────────────────── zod-схема канона ───────────────────────────

const idSchema = z.string().min(1);

/**
 * `of` — «uuid | this» ДОСЛОВНО по §А5-7, и сужение живёт в схеме, а не только в парсере:
 * вход `ast:` тула (§А5-4) идёт мимо разбора, и `of: 'banana'` доехал бы до компилятора,
 * где Postgres ответил бы ошибкой каста `22P02` вместо структурного отказа с именем поля.
 * Класс регулярки — RE2 (без просмотров и обратных ссылок): та же схема поедет чужому
 * потребителю (§А5-4, проба провайдера).
 */
const REL_TARGET_RE =
  /^(this|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/;
export const REL_TARGET_PATTERN = REL_TARGET_RE.source;
const relTargetSchema = z.string().regex(REL_TARGET_RE, 'ожидается UUID или this');

const scalarSchema = z.union([z.string(), z.number(), z.boolean()]);
const tokenSchema = z.object({ token: z.enum(QUERY_DATE_TOKENS) }).strict();
const boundSchema = z.union([scalarSchema, tokenSchema]);
const rangeSchema = z
  .object({ from: boundSchema.optional(), to: boundSchema.optional() })
  .strict()
  .refine(
    (v) => v.from !== undefined || v.to !== undefined,
    'range без границ: нужна хотя бы одна из from/to',
  );

/**
 * Предикат свойства разбирается ПО ОПЕРАТОРУ, а не одной формой с `value: unknown`:
 * иначе `{op:'in', value:'done'}` и `{op:'eq', value:['a','b']}` проехали бы схему молча,
 * и разошлись бы уже в компиляторе — там, где чинить дороже всего.
 */
const propNodeSchema = z.union([
  z.object({ prop: idSchema, op: z.enum(['eq', 'ne', 'gt', 'lt']), value: boundSchema }).strict(),
  z.object({ prop: idSchema, op: z.literal('in'), value: z.array(scalarSchema).min(1) }).strict(),
  z.object({ prop: idSchema, op: z.literal('contains'), value: scalarSchema }).strict(),
  z.object({ prop: idSchema, op: z.literal('range'), value: rangeSchema }).strict(),
]);

/**
 * Разбор по `kind`: каждая ветка называет, что обязательно, а что запрещено (см. докблок
 * `QueryRelPredicate`). Дискриминируемый союз, а не один объект с `.superRefine`, — чтобы
 * отказ приходил с именем ветки, а не общим «Invalid input».
 */
const relSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.enum(['children_of', 'parents_of']),
      via: idSchema.optional(),
      of: relTargetSchema,
    })
    .strict(),
  z
    .object({
      kind: z.enum(['descendants_of', 'ancestors_of']),
      via: idSchema,
      of: relTargetSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('has_relation'),
      via: idSchema,
      sourceNotIn: z
        .object({ prop: idSchema, values: z.array(scalarSchema).min(1) })
        .strict()
        .optional(),
    })
    .strict(),
  z.object({ kind: z.literal('has_children'), via: idSchema.optional() }).strict(),
]);

/**
 * Рекурсия через `z.lazy`. Вход помечен `unknown`, а не `QueryFilterNode`: схема — гейт
 * недоверенного входа (jsonb реестра, аргумент тула), и обещать типизированный вход было
 * бы ложью.
 *
 * ЧЕГО ЭТОТ ГЕЙТ НЕ ДЕЛАЕТ — он про ФОРМУ, а не про ГЛУБИНУ. Капа здесь нет и быть не
 * может: `z.lazy` спускается рекурсивно, и достаточно глубокий вход исчерпывает стек
 * РАНЬШЕ любого условия, которое можно поставить внутри схемы. Поэтому глубину стережёт
 * `queryTreeExceedsDepth` (кап `QUERY_TREE_DEPTH_CAP`) — явным обходом и ДО zod.
 *
 * ВХОДОВ У ДЕРЕВА СНАРУЖИ ТРИ, и гейт стоит перед ДВУМЯ — вот они все и с причиной.
 *
 *  1. `ast:` тула `entity_query` (`tools/dispatch.ts`): гейт `assertQueryTreeDepth` первым
 *     действием, до схемы;
 *  2. `ast:` роутера `entity.query`/`entity.count` (`routers/entity.ts`, `querySignature`
 *     через `z.preprocess` — единственное место конвейера tRPC, работающее раньше схемы).
 *     Вход завела Задача 13c ради пикера ссылочных свойств: цель `ref` объявлена деревом
 *     (§А6-1), а плоский текст §А5-3 дерева не выражает. Предикат у 1 и 2 ОДИН
 *     (`queryTreeExceedsDepth`), отличаются только обёртки отказа: `ExecError` у тула,
 *     `TRPCError` у роутера;
 *  3. jsonb РЕЕСТРА — `ref.target` и `scope` строки `property_definitions`, которые
 *     `registry/load.ts` разбирает `propertyDefinitionSchema`, а та тянет эту же схему.
 *     ГЕЙТА ГЛУБИНЫ ЗДЕСЬ НЕТ, и это не забывчивость: снаружи в реестр сегодня не пишет
 *     НИКТО — строки кладут сид и админский DSN, а операции реестра (Задача 15) ещё не
 *     заведены. Признак, по которому следующий читатель поймёт, что момент настал:
 *     появился путь, кладущий строку реестра по запросу владельца или модели; в тот же день
 *     дерево `target`/`scope` обязано пройти `queryTreeExceedsDepth` ДО записи — глубина,
 *     принятая в базу, разворачивается потом на КАЖДОМ чтении реестра, то есть дороже
 *     любого из двух входов выше.
 */
export const queryFilterNodeSchema: z.ZodType<QueryFilterNode, z.ZodTypeDef, unknown> = z.lazy(
  () =>
    z.union([
      z.object({ and: z.array(queryFilterNodeSchema).min(1) }).strict(),
      z.object({ or: z.array(queryFilterNodeSchema).min(1) }).strict(),
      z.object({ not: queryFilterNodeSchema }).strict(),
      propNodeSchema,
      z.object({ has: idSchema }).strict(),
      z.object({ aspect: idSchema }).strict(),
      z.object({ tag: z.string().min(1) }).strict(),
      z.object({ search: z.string().min(1) }).strict(),
      z.object({ rel: relSchema }).strict(),
      z.object({ archived: z.enum(['true', 'any']) }).strict(),
      // Часть Б: узел в схеме есть, парсер и компилятор среза А отвергают его с кодом
      // CLASS_NOT_AVAILABLE — контрактов ещё нет, а форму хранения менять миграцией дороже.
      z.object({ class: z.object({ contract: idSchema, set: idSchema }).strict() }).strict(),
    ]) as unknown as z.ZodType<QueryFilterNode, z.ZodTypeDef, unknown>,
);

export const querySortFieldSchema = z
  .object({ field: idSchema, dir: z.enum(['asc', 'desc']) })
  .strict();

export const queryAstSchema: z.ZodType<QueryAst, z.ZodTypeDef, unknown> = z
  .object({
    // `filter` ОБЯЗАТЕЛЕН и nullable, а не optional: «фильтра нет» — это решение автора
    // запроса (весь корпус), и оно должно быть записано, а не выведено из отсутствия ключа.
    filter: queryFilterNodeSchema.nullable(),
    sortBy: z.array(querySortFieldSchema).min(1).optional(),
    limit: z.number().int().min(1).optional(),
    display: z.enum(QUERY_DISPLAY_MODES).optional(),
    title: z.string().min(1).optional(),
  })
  .strict();
