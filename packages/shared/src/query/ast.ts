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
 * заводится РЯДОМ, а не вместо — компилятор переключает Задача 9b.
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

export interface QueryRelPredicate {
  kind: QueryRelKind;
  /** id роли ребра (§А4-3). Без него иерархические предикаты идут по семейству иерархии. */
  via?: string;
  /** uuid сущности либо `this` — «сущность, в теле которой лежит запрос». */
  of?: string;
}

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

const relSchema = z
  .object({
    kind: z.enum(QUERY_REL_KINDS),
    via: idSchema.optional(),
    of: z.string().min(1).optional(),
  })
  .strict();

/**
 * Рекурсия через `z.lazy`. Вход помечен `unknown`, а не `QueryFilterNode`: схема — гейт
 * недоверенного входа (jsonb реестра, аргумент тула), и обещать типизированный вход было
 * бы ложью.
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
