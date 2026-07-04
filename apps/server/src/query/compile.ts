// apps/server/src/query/compile.ts
// SQL-компилятор query-грамматики (PRD 01 §6.1) → PostgreSQL, единственный бэкенд (§6.2).
//
// Инварианты:
// - owner-фильтр НЕ добавляется: изоляцию даёт RLS (§4.10) — исполнение компилята
//   допустимо ТОЛЬКО под withIdentity;
// - все пользовательские значения — строго параметрами ${}; sql.raw — только для
//   значений из каталога/реестра (id аспектов, имена полей, enum-значения) и констант кода;
// - `today` (YYYY-MM-DD в таймзоне пользователя) и `timezone` инжектируются вызывающим —
//   компиляция детерминирована (Global Constraints).
import {
  buildFieldCatalog,
  CORE_FIELDS,
  type FieldCatalog,
  type FieldType,
  type QueryAst,
  type QueryComparisonFilter,
  type QueryDateToken,
  type QueryEntityRef,
  type QueryFieldValue,
  type QueryFilter,
  type QueryRangeFilter,
  type QuerySortField,
} from '@orbis/shared';
import { type SQL, sql } from 'drizzle-orm';
import type { Tx } from '../db/with-identity';

export interface CompileContext {
  catalog: FieldCatalog;
  /** Сущность-хозяин query-блока (для `this`); NULL — запрос вне контекста сущности. */
  thisEntityId: string | null;
  /** Сегодня, YYYY-MM-DD в таймзоне пользователя — инжектируется вызывающим. */
  today: string;
  /** IANA-таймзона пользователя — для date-токенов над timestamp-полями. */
  timezone: string;
}

/** Структурная ошибка компиляции (§6.4): например, `this` вне контекста сущности. */
export class QueryCompileError extends Error {
  override readonly name = 'QueryCompileError';
}

/** Дефолтный cap выдачи, когда limit= не задан (решение 11 плана); только compileQuery. */
const DEFAULT_LIMIT = 500;

/** Колонки полного SELECT по §4.1 — константа кода, не пользовательский ввод. */
const ENTITY_COLUMNS =
  'id, owner_id, title, emoji, body, body_refs, tags, meta, aspects, created_at, updated_at, archived';

/** Полный SELECT: WHERE по фильтрам + ORDER BY + LIMIT (cap 500 без limit=). */
export function compileQuery(ast: QueryAst, ctx: CompileContext): SQL {
  const aspects = aspectsInQuery(ast);
  let q = sql`SELECT ${sql.raw(ENTITY_COLUMNS)} FROM entities WHERE ${compileWhere(ast, ctx, aspects)}`;
  const order = compileOrderBy(ast, ctx, aspects);
  if (order) q = sql`${q} ORDER BY ${order}`;
  return sql`${q} LIMIT ${ast.limit ?? DEFAULT_LIMIT}`;
}

/** COUNT(*) для бейджей (02 §3.2): те же условия, но без limit/sortBy/cap. */
export function compileCount(ast: QueryAst, ctx: CompileContext): SQL {
  return sql`SELECT count(*) FROM entities WHERE ${compileWhere(ast, ctx, aspectsInQuery(ast))}`;
}

/**
 * Каталог полей из реестра (§4.10): под RLS видны builtin (owner IS NULL) + свои.
 * Кэша нет намеренно — в 1a читается на запрос, оптимизация позже (бриф Task 8).
 */
export async function loadCatalog(tx: Tx): Promise<FieldCatalog> {
  const rows = await tx.execute(sql`SELECT id, schema FROM aspect_definitions`);
  return buildFieldCatalog(
    rows as unknown as Array<{ id: string; schema: Record<string, unknown> }>,
  );
}

// ─────────────────────────── WHERE ───────────────────────────

/** `aspect=X` участвует в резолве неоднозначных полей независимо от позиции (§6.1). */
function aspectsInQuery(ast: QueryAst): Set<string> {
  const set = new Set<string>();
  for (const f of ast.filters) {
    if (f.kind === 'aspect') set.add(f.aspect);
  }
  return set;
}

function compileWhere(ast: QueryAst, ctx: CompileContext, aspects: Set<string>): SQL {
  const conds: SQL[] = [sql`true`];
  // Нет узла archived → только неархивные (§6.1); позиция — как в псевдо-SQL §6.1.
  if (!ast.filters.some((f) => f.kind === 'archived')) conds.push(sql`NOT archived`);
  for (const f of ast.filters) {
    const c = compileFilter(f, ctx, aspects);
    if (c) conds.push(c);
  }
  if (ast.search !== undefined) conds.push(compileSearch(ast.search));
  return sql.join(conds, sql` AND `);
}

/** Одна конструкция запроса → SQL-условие; null — конструкция не даёт условия. */
function compileFilter(f: QueryFilter, ctx: CompileContext, aspects: Set<string>): SQL | null {
  switch (f.kind) {
    case 'tags':
      // OR внутри значения = пересечение массивов (§6.1).
      return sql`tags && ${textArray(f.values)}`;
    case 'excludeTags':
      return sql`NOT (tags && ${textArray(f.values)})`;
    case 'aspect':
      // Значение aspect= каталогом не проверяется — строго параметром.
      return sql`aspects ? ${f.aspect}`;
    case 'field': {
      const ref = fieldRef(f.field, ctx, aspects);
      return f.condition.kind === 'anyOf'
        ? compileAnyOf(ref, f.condition.values, ctx)
        : compileNoneOf(ref, f.condition.values, ctx);
    }
    case 'comparison':
      return compileComparison(f, ctx, aspects);
    case 'range':
      return compileRange(f, ctx, aspects);
    case 'children_of':
      // Дети X: X — родитель (source), дети — target (§6.1).
      return sql`id IN (SELECT target_id FROM relations WHERE source_id = ${entityRefId(f.of, ctx)} AND relation_type = 'parent')`;
    case 'parents_of':
      return sql`id IN (SELECT source_id FROM relations WHERE target_id = ${entityRefId(f.of, ctx)} AND relation_type = 'parent')`;
    case 'excludeBlocked':
      // Блокер без task-аспекта жив: COALESCE(...,'') NOT IN ('done','cancelled') — §6.1.
      // Подзапрос по entities b тоже под RLS — чужой блокер невидим и не блокирует.
      return sql`NOT EXISTS (SELECT 1 FROM relations r JOIN entities b ON b.id = r.source_id WHERE r.target_id = entities.id AND r.relation_type = 'blocks' AND COALESCE(b.aspects->'orbis/task'->>'status', '') NOT IN ('done', 'cancelled'))`;
    case 'archived':
      // 'true' — только архивные; 'any' — условия нет вовсе (§6.1).
      return f.value === 'true' ? sql`archived` : null;
  }
}

/** ARRAY[$1, $2]::text[] — каждый элемент параметром. */
function textArray(values: string[]): SQL {
  return sql`ARRAY[${sql.join(
    values.map((v) => sql`${v}`),
    sql`, `,
  )}]::text[]`;
}

/** `search=q`: FTS по title + body, конфигурация 'simple' (индексы §4.9). */
function compileSearch(q: string): SQL {
  return sql`(to_tsvector('simple', title) @@ plainto_tsquery('simple', ${q}) OR to_tsvector('simple', body) @@ plainto_tsquery('simple', ${q}))`;
}

// ─────────────────────────── Поля и условия по ним ───────────────────────────

/** Поле после резолва: SQL-выражение доступа, тип, признак core, порядок enum. */
interface FieldRef {
  expr: SQL;
  type: FieldType;
  core: boolean;
  enumValues?: string[];
}

/**
 * SQL-литерал ТОЛЬКО для каталожных значений (id аспекта, имя поля, enum-значение) —
 * они из реестра, не от пользователя. Пользовательские значения — параметрами ${}.
 */
function catalogLit(value: string): SQL {
  return sql.raw(`'${value.replaceAll("'", "''")}'`);
}

/**
 * Резолв поля зеркально парсеру (§6.1): core-поля → колонки; поля аспектов → путь
 * `aspects->'A'->>'f'`; неоднозначность снята `aspect=` из запроса. Ошибки резолва
 * недостижимы — их отсёк парсер; проверки здесь — страховка от рассинхрона.
 */
function fieldRef(name: string, ctx: CompileContext, aspects: Set<string>): FieldRef {
  if (name === 'created_at' || name === 'updated_at') {
    return { expr: sql.raw(name), type: CORE_FIELDS[name], core: true };
  }
  // core-`title` достижим только из sortBy (в фильтре ключ занят параметром заголовка).
  if (name === 'title') return { expr: sql.raw('title'), type: 'string', core: true };
  let infos = ctx.catalog.fields[name] ?? [];
  if (infos.length > 1) infos = infos.filter((i) => aspects.has(i.aspect));
  const info = infos[0];
  if (!info || infos.length > 1) {
    throw new QueryCompileError(`поле '${name}' не разрешилось каталогом — рассинхрон с парсером`);
  }
  return {
    // Имя поля — ключ каталога (резолв выше подтвердил), id аспекта — из реестра.
    expr: sql`aspects->${catalogLit(info.aspect)}->>${catalogLit(name)}`,
    type: info.type,
    core: false,
    enumValues: info.enumValues,
  };
}

/** anyOf: литералы одним IN, date-токены — сравнениями; несколько условий — OR по скобкам (§6.1). */
function compileAnyOf(ref: FieldRef, values: QueryFieldValue[], ctx: CompileContext): SQL {
  const conds: SQL[] = [];
  const literals = values.filter((v) => v.kind === 'literal').map((v) => v.value);
  if (literals.length > 0) {
    conds.push(
      sql`${ref.expr} IN (${sql.join(
        literals.map((v) => sql`${v}`),
        sql`, `,
      )})`,
    );
  }
  for (const v of values) {
    if (v.kind === 'date_token') conds.push(dateTokenCond(ref, v.token, ctx));
  }
  const first = conds[0] as SQL;
  return conds.length === 1 ? first : sql`(${sql.join(conds, sql` OR `)})`;
}

/**
 * noneOf: NULL проходит (решение 10) — `(expr IS NULL OR expr NOT IN (…))`;
 * date-токены в noneOf — отрицание их сравнений внутри той же скобки.
 */
function compileNoneOf(ref: FieldRef, values: QueryFieldValue[], ctx: CompileContext): SQL {
  const parts: SQL[] = [];
  const literals = values.filter((v) => v.kind === 'literal').map((v) => v.value);
  if (literals.length > 0) {
    parts.push(
      sql`${ref.expr} NOT IN (${sql.join(
        literals.map((v) => sql`${v}`),
        sql`, `,
      )})`,
    );
  }
  for (const v of values) {
    if (v.kind === 'date_token') parts.push(sql`NOT (${dateTokenCond(ref, v.token, ctx)})`);
  }
  return sql`(${ref.expr} IS NULL OR ${sql.join(parts, sql` AND `)})`;
}

/**
 * Выражение «календарная дата поля» для date-токенов (§6.1):
 * date-поле — прямой ::date; timestamp — момент в таймзоне пользователя → дата
 * (core-колонка уже timestamptz, полю аспекта нужен каст из текста).
 */
function dateExpr(ref: FieldRef, ctx: CompileContext): SQL {
  if (ref.type === 'date') return sql`(${ref.expr})::date`;
  if (ref.core) return sql`(${ref.expr} AT TIME ZONE ${ctx.timezone})::date`;
  return sql`((${ref.expr})::timestamptz AT TIME ZONE ${ctx.timezone})::date`;
}

/** Сравнения date-токенов (§6.1): next_7d — обе границы включительно, after_7d — строго после. */
function dateTokenCond(ref: FieldRef, token: QueryDateToken, ctx: CompileContext): SQL {
  const d = dateExpr(ref, ctx);
  switch (token) {
    case 'today':
      return sql`${d} = ${ctx.today}::date`;
    case 'overdue':
      return sql`${d} < ${ctx.today}::date`;
    case 'next_7d':
      return sql`${d} BETWEEN ${ctx.today}::date AND ${ctx.today}::date + 7`;
    case 'after_7d':
      return sql`${d} > ${ctx.today}::date + 7`;
  }
}

/** `(aspects->'A'->>'f')::numeric` — сравнение через numeric, не float (§3.3). */
function numericExpr(ref: FieldRef): SQL {
  return sql`(${ref.expr})::numeric`;
}

/** `f>v` / `f<v`: numeric для полей аспектов, timestamptz для core-колонок (§6.1). */
function compileComparison(
  f: QueryComparisonFilter,
  ctx: CompileContext,
  aspects: Set<string>,
): SQL {
  const ref = fieldRef(f.field, ctx, aspects);
  const op = sql.raw(f.op); // '>' | '<' — закрытый union из AST, не пользовательская строка
  return f.value.kind === 'timestamp'
    ? sql`${ref.expr} ${op} ${f.value.value}::timestamptz`
    : sql`${numericExpr(ref)} ${op} ${f.value.value}::numeric`;
}

/** `f=a..b`: BETWEEN, границы включительно (§6.1). */
function compileRange(f: QueryRangeFilter, ctx: CompileContext, aspects: Set<string>): SQL {
  const ref = fieldRef(f.field, ctx, aspects);
  return f.min.kind === 'timestamp'
    ? sql`${ref.expr} BETWEEN ${f.min.value}::timestamptz AND ${f.max.value}::timestamptz`
    : sql`${numericExpr(ref)} BETWEEN ${f.min.value}::numeric AND ${f.max.value}::numeric`;
}

/** UUID из `children_of=`/`parents_of=`; `this` без контекста — структурная ошибка. */
function entityRefId(of: QueryEntityRef, ctx: CompileContext): string {
  if (of.kind === 'id') return of.id;
  if (ctx.thisEntityId === null) throw new QueryCompileError('this вне контекста сущности');
  return ctx.thisEntityId;
}

// ─────────────────────────── ORDER BY ───────────────────────────

function compileOrderBy(ast: QueryAst, ctx: CompileContext, aspects: Set<string>): SQL | null {
  if (!ast.sortBy || ast.sortBy.length === 0) return null;
  return sql.join(
    ast.sortBy.map((s) => sortItem(s, ctx, aspects)),
    sql`, `,
  );
}

function sortItem(s: QuerySortField, ctx: CompileContext, aspects: Set<string>): SQL {
  const ref = fieldRef(s.field, ctx, aspects);
  const dir = sql.raw(s.direction === 'desc' ? 'DESC' : 'ASC');
  // Enum — по порядку объявления в схеме аспекта, NULL всегда в конце (§6.1).
  if (!ref.core && ref.enumValues) {
    const whens = ref.enumValues
      .map((v, i) => `WHEN '${v.replaceAll("'", "''")}' THEN ${i}`) // enum-значения — из реестра
      .join(' ');
    return sql`CASE ${ref.expr} ${sql.raw(whens)} END ${dir} NULLS LAST`;
  }
  // Core-поля — колонкой; NULLS LAST безвреден для NOT NULL-колонок и держит §6.1
  // («NULL всегда в конце») для будущих nullable core-полей.
  if (ref.core) return sql`${ref.expr} ${dir} NULLS LAST`;
  return sql`${sortCast(ref)} ${dir} NULLS LAST`;
}

/** Сортировочный каст поля аспекта: date/numeric — по §6.1; timestamp — момент, не строка. */
function sortCast(ref: FieldRef): SQL {
  switch (ref.type) {
    case 'date':
      return sql`(${ref.expr})::date`;
    case 'number':
    case 'integer':
    case 'decimal':
      return sql`(${ref.expr})::numeric`;
    case 'timestamp':
      return sql`(${ref.expr})::timestamptz`;
    default:
      return sql`(${ref.expr})`;
  }
}
