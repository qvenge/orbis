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
  fieldTypeLabel,
  type QueryAst,
  type QueryComparisonFilter,
  type QueryDateToken,
  type QueryEntityRef,
  type QueryFieldValue,
  type QueryFilter,
  type QueryRangeFilter,
  type QuerySortField,
  SERVICE_ASPECT_IDS,
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
  override readonly name: string = 'QueryCompileError';
}

/**
 * Ошибка резолва ПОЛЯ агрегата (compileSum/compileLatest), а не самого запроса: нет
 * такого поля в каталоге, неоднозначно без `aspect=` или тип не числовой. Подкласс, а не
 * самостоятельный тип: все существующие `instanceof QueryCompileError` (роутер entity,
 * диспатч тулов) ловят её ровно как раньше, но вызывающему, которому нужно отличить
 * «сломано поле» от «сломан запрос» (прогресс цели §11.3 — разные честные отказы),
 * различие теперь доступно.
 */
export class QueryFieldError extends QueryCompileError {
  override readonly name = 'QueryFieldError';
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

/** Числовые типы каталога, допустимые в sum и latest (decimal-строки §3.3 и явные числа). */
const SUMMABLE_TYPES: ReadonlySet<FieldType> = new Set(['decimal', 'number', 'integer']);

/**
 * Агрегация `user_query` (§9.2, решение 7 плана 1b) и `aggregate: "sum"` целей (§11.3):
 * count(*) + sum(поле) одним SELECT по той же WHERE-выборке, что compileQuery,
 * но БЕЗ limit — агрегат по всей выборке.
 * Поле резолвится каталогом тем же путём, что фильтры (fieldRef, с учётом `aspect=`
 * из запроса); допустимы только числовые типы. Сумма считается через ::numeric и
 * отдаётся текстом — точность decimal-строк не теряется во float (§3.3).
 */
export function compileSum(ast: QueryAst, ctx: CompileContext, field: string): SQL {
  const aspects = aspectsInQuery(ast);
  const ref = numericFieldRef(field, ctx, aspects, 'sum');
  return sql`SELECT count(*) AS count, sum(${numericExpr(ref)})::text AS sum FROM entities WHERE ${compileWhere(ast, ctx, aspects)}`;
}

/**
 * `latest` целей (01 §11.3, задача E2): значение числового поля у ПОСЛЕДНЕЙ сущности
 * той же выборки, что дал бы список.
 *
 * «Последняя» однозначно = максимум `updated_at` (единственный индексированный
 * core-порядок, миграция 0001); ничья снимается `id DESC` — детерминизм ответа важнее
 * «настоящего» порядка одинаковых меток. Строки, где поле не заполнено, в кандидаты не
 * попадают: правка соседней сущности без этого поля не должна обнулять «последнее
 * измерение» цели. Значение отдаётся `::numeric::text` — канонической decimal-строкой
 * (§3.3), во float оно не превращается ни здесь, ни у вызывающего.
 */
export function compileLatest(ast: QueryAst, ctx: CompileContext, field: string): SQL {
  const aspects = aspectsInQuery(ast);
  const ref = numericFieldRef(field, ctx, aspects, 'latest');
  return sql`SELECT ${numericExpr(ref)}::text AS value FROM entities WHERE ${compileWhere(ast, ctx, aspects)} AND ${ref.expr} IS NOT NULL ORDER BY updated_at DESC, id DESC LIMIT 1`;
}

/**
 * Резолв поля агрегата: тот же путь каталога, что у фильтров (fieldRef с учётом
 * `aspect=`), но допустимы только числовые типы. В отличие от фильтров, поле сюда
 * приходит из input тула или из аспекта цели, а не из разобранного запроса — нерезолв
 * каталогом штатен, поэтому текст «рассинхрон с парсером» был бы ложью, а класс ошибки
 * отделяет «сломано поле» от «сломан запрос».
 */
function numericFieldRef(
  field: string,
  ctx: CompileContext,
  aspects: Set<string>,
  op: 'sum' | 'latest',
): FieldRef {
  let ref: FieldRef;
  try {
    ref = fieldRef(field, ctx, aspects);
  } catch (e) {
    if (e instanceof QueryCompileError) {
      throw new QueryFieldError(
        `поле '${field}' не разрешилось каталогом: нет такого поля или неоднозначно без aspect=`,
      );
    }
    throw e;
  }
  if (ref.core || !SUMMABLE_TYPES.has(ref.type)) {
    // Имя типа — человеческое (fieldTypeLabel): сюда доходят и 'array', и 'unfilterable'
    // (поле агрегата приходит из input тула или из аспекта цели, парсер его не смотрел),
    // а «тип 'unfilterable'» — внутренний токен ветвления, пользователю он ничего не значит.
    throw new QueryFieldError(
      `${op} по полю '${field}' невозможен: тип ${fieldTypeLabel(ref.type)} не числовой`,
    );
  }
  return ref;
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

/** Поле, по которому фильтрует узел; null — узел без поля (теги, связи, архивность). */
function filterFieldName(f: QueryFilter): string | null {
  switch (f.kind) {
    case 'field':
    case 'comparison':
    case 'range':
      return f.field;
    default:
      return null;
  }
}

/**
 * Служебный аспект «назван» запросом, если он стоит в `aspect=` ИЛИ в него резолвится поле
 * хотя бы одного фильтра: спросить `outcome=running` — то же намерение, что
 * `aspect=orbis/agent-run`. Без второго правила такой запрос компилировался бы в
 * противоречие (исключение аспекта AND условие по его полю) и молча отдавал бы ноль строк —
 * худший из отказов, потому что выглядит как «ничего нет» (§6.4: отказ обязан быть честным).
 *
 * sortBy НЕ считается намеренно: сортировка описывает порядок выдачи, а не её цель, и
 * `sortBy=step_count:desc` поверх обычного списка не должен внезапно втягивать в него прогоны.
 *
 * Резолв — тем же `fieldRef`, что и у самих условий (второй копии логики каталога нет), и
 * ровно с тем же множеством `aspects`: неоднозначные поля (`grant_id` — и в assignment, и в
 * agent-run) сигналом не становятся — их и парсер без `aspect=` не пропускает.
 */
function namesServiceAspect(ast: QueryAst, ctx: CompileContext, aspects: Set<string>): boolean {
  const service: readonly string[] = SERVICE_ASPECT_IDS;
  if (service.some((id) => aspects.has(id))) return true;
  return ast.filters.some((f) => {
    const name = filterFieldName(f);
    if (name === null) return false;
    const { aspect } = fieldRef(name, ctx, aspects);
    return aspect !== undefined && service.includes(aspect);
  });
}

function compileWhere(ast: QueryAst, ctx: CompileContext, aspects: Set<string>): SQL {
  const conds: SQL[] = [sql`true`];
  // Нет узла archived → только неархивные (§6.1); позиция — как в псевдо-SQL §6.1.
  if (!ast.filters.some((f) => f.kind === 'archived')) conds.push(sql`NOT archived`);
  // Служебные аспекты (02-core-os §3.9): прогоны исполнителя поднимались бы в топ «свежего» на
  // каждый orbis_run_step (С5). Прячем неявно — пока запрос сам не назвал такой аспект.
  // Условие индексом не ускоряется (GIN отрицание не покрывает): это построчный фильтр
  // поверх остальной выборки — дёшево, одна проверка наличия ключа в jsonb.
  if (!namesServiceAspect(ast, ctx, aspects)) {
    conds.push(sql`NOT (aspects ?| ${textArray([...SERVICE_ASPECT_IDS])})`);
  }
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
  /** Для полей аспектов: id аспекта и имя поля — containment строит путь заново, а не поверх expr. */
  aspect?: string;
  fieldName?: string;
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
    aspect: info.aspect,
    fieldName: name,
  };
}

/**
 * Числовой литерал в форме, которую JSON точно отдаст обратно тем же числом: base-10 без
 * экспоненты и без ведущего `+` (та же форма, что DECIMAL_LITERAL_RE парсера). Экспоненту
 * не берём намеренно — `::numeric` от `1e100000` падает переполнением уже в рантайме.
 *
 * Длины ограничены ровно областью определения `numeric` (проверено на живой базе: 131072
 * знака до точки и 16383 после проходят, на один больше — `value overflows numeric
 * format`). Это не «разумный потолок на глаз», а точная граница между «может совпасть» и
 * «совпасть не может»: числа jsonb ХРАНЯТСЯ как numeric, поэтому литерал вне numeric не
 * равен ни одному хранимому значению — числовая ветка для него всё равно нашла бы ноль.
 * Потому отсечение здесь не теряет ни одной находки, а любой потолок теснее (скажем,
 * 15 знаков) молча терял бы обычные значения: 8 знаков после точки у крипто-сумм,
 * 16 у эпохи в микросекундах, 19 у int64-идентификатора. Без ограничения же длинный
 * литерал давал бы ошибку исполнения там, где до этой задачи была честная пустая выдача.
 * Расход на длину этим не растёт: текстовая ветка везёт литерал целиком в любом случае.
 */
const NUMERIC_LITERAL_RE = /^-?\d{1,131072}(\.\d{1,16383})?$/;

/**
 * Одна кодировка искомого элемента: `aspects @> {аспект: {поле: [элемент]}}`.
 *
 * Путь строится ЗАНОВО от корня `aspects`, а не поверх `ref.expr`: индексируется только
 * containment по самой колонке. Подпутевые формы (`aspects->'A'->'f' ? $1` и
 * `aspects->'A'->'f' @> '[…]'`) GIN-индексом entities_aspects_gin не покрываются —
 * проверено EXPLAIN на живой базе: Seq Scan обеих даже при enable_seqscan=off, тогда как
 * `aspects @> jsonb_build_object(…)` даёт Bitmap Index Scan (и с параметрами тоже).
 *
 * Все три части — параметрами, включая id аспекта и имя поля: инвариант файла разрешает
 * им быть литералами (они из реестра), но параметр строже, а jsonb_build_object ключи
 * параметрами принимает. Касты `::text` обязательны: аргументы объявлены `VARIADIC "any"`,
 * и без каста Postgres отвечает «could not determine data type of parameter $1».
 */
function containsEncoded(aspect: string, field: string, element: SQL): SQL {
  return sql`aspects @> jsonb_build_object(${aspect}::text, jsonb_build_object(${field}::text, jsonb_build_array(${element})))`;
}

/**
 * «Массив внутри аспекта содержит значение» — предикат фильтра по полю-массиву.
 *
 * Containment в jsonb строго типизирован: `@> '["5"]'` НЕ найдёт `[5]`. Тип элемента
 * каталог не несёт (там лишь «массив скаляров»), а литерал грамматики всегда строка —
 * поэтому числовой на вид литерал ищется в ОБЕИХ кодировках через OR. Ложных срабатываний
 * это не даёт: лишняя ветка не совпадает никогда (проверено на живой базе — `["5"]` не
 * находит `[5]`, `[5]` не находит `["5"]`), а обе ветки остаются индексными (BitmapOr из
 * двух Bitmap Index Scan). Цена — один лишний дизъюнкт и только когда литерал похож на
 * число; `aliases=такси` компилируется ровно как раньше.
 */
function arrayContains(ref: FieldRef, value: string): SQL {
  const { aspect, fieldName } = ref;
  if (aspect === undefined || fieldName === undefined) {
    // Тип 'array' носят только поля аспектов — у core-полей массивов нет.
    throw new QueryCompileError('поле-массив без пути аспекта — рассинхрон резолва');
  }
  const asText = containsEncoded(aspect, fieldName, sql`${value}::text`);
  if (!NUMERIC_LITERAL_RE.test(value)) return asText;
  return sql`(${asText} OR ${containsEncoded(aspect, fieldName, sql`${value}::numeric`)})`;
}

/**
 * Литералы фильтра по полю-массиву. Date-токены парсер к массиву не пускает
 * (`aliases=today` — отказ с позицией), поэтому пустой список означает рассинхрон, а не
 * «условия нет»: молча вернуть здесь `true` значило бы отдать всю таблицу.
 */
function arrayLiterals(values: QueryFieldValue[]): string[] {
  const literals = values.filter((v) => v.kind === 'literal').map((v) => v.value);
  if (literals.length === 0) {
    throw new QueryCompileError(
      'фильтр по полю-массиву без литеральных значений — рассинхрон с парсером',
    );
  }
  return literals;
}

/**
 * Как фильтр обходится с полем этого типа — ЕДИНСТВЕННЫЙ разбор `FieldType` в фильтрах,
 * общий для anyOf и noneOf, и исчерпывающий.
 *
 * Скаляры перечислены поимённо, а не собраны в `default`, именно потому, что `default`
 * и породил дефект этой ветки: массив приезжал сюда под видом строки, попадал в ветку
 * `->>` IN и давал тихий ноль на равенстве и всю таблицу на отрицании — ни типизация,
 * ни тест об этом не сказали. Теперь следующий член `FieldType` обязан назвать свою
 * форму здесь, иначе не соберётся.
 */
function filterShape(type: FieldType): 'scalar' | 'array' {
  switch (type) {
    case 'string':
    case 'number':
    case 'integer':
    case 'decimal':
    case 'date':
    case 'timestamp':
    case 'boolean':
      return 'scalar';
    case 'array':
      return 'array';
    case 'unfilterable':
      // Парсер такое поле не пропускает (parse.ts, ensureFilterable) — сюда можно попасть
      // только рассинхроном, и молчать нельзя: ветка скаляра сравнила бы текст сериализации.
      throw new QueryCompileError(
        `фильтр по полю типа ${fieldTypeLabel(type)} — рассинхрон с парсером`,
      );
    default: {
      const unhandled: never = type;
      throw new QueryCompileError(
        `фильтр по полю типа '${String(unhandled)}' — тип добавлен без ветки в компиляторе`,
      );
    }
  }
}

/**
 * anyOf: литералы одним IN, date-токены — сравнениями; несколько условий — OR по скобкам
 * (§6.1). Поле-массив — отдельная ветка: сравнивать со значением там нечего, «равенство»
 * для него означает «массив содержит» (arrayContains).
 */
function compileAnyOf(ref: FieldRef, values: QueryFieldValue[], ctx: CompileContext): SQL {
  if (filterShape(ref.type) === 'array') {
    const found = arrayLiterals(values).map((v) => arrayContains(ref, v));
    const only = found[0] as SQL;
    return found.length === 1 ? only : sql`(${sql.join(found, sql` OR `)})`;
  }
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
  if (filterShape(ref.type) === 'array') {
    // Правило «NULL проходит» (решение 10) выполняется само: NOT (@>) истинно и для
    // сущностей, у которых этого аспекта нет вовсе, — отдельная ветка IS NULL не нужна.
    // Цена — NOT снимает индекс, отрицание по массиву остаётся seq-scan'ом; это сознательно:
    // отрицание редко и обычно стоит рядом с сужающим условием.
    const missing = arrayLiterals(values).map((v) => sql`NOT (${arrayContains(ref, v)})`);
    const only = missing[0] as SQL;
    return missing.length === 1 ? only : sql`(${sql.join(missing, sql` AND `)})`;
  }
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

/**
 * `f>v` / `f<v`: numeric для числовых полей аспектов, timestamptz для core-колонок (§6.1);
 * date-поля аспектов (kind 'date', B5) — лексикографическое сравнение ISO-дат как текста
 * (= хронологическое для YYYY-MM-DD; прецедент binding.ts/post-due.ts, без каста —
 * парсер гарантировал календарно-валидную дату).
 */
function compileComparison(
  f: QueryComparisonFilter,
  ctx: CompileContext,
  aspects: Set<string>,
): SQL {
  const ref = fieldRef(f.field, ctx, aspects);
  const op = sql.raw(f.op); // '>' | '<' — закрытый union из AST, не пользовательская строка
  if (f.value.kind === 'timestamp') return sql`${ref.expr} ${op} ${f.value.value}::timestamptz`;
  if (f.value.kind === 'date') return sql`${ref.expr} ${op} ${f.value.value}`;
  return sql`${numericExpr(ref)} ${op} ${f.value.value}::numeric`;
}

/** `f=a..b`: BETWEEN, границы включительно (§6.1); date-поля — лексикографически ISO (B5). */
function compileRange(f: QueryRangeFilter, ctx: CompileContext, aspects: Set<string>): SQL {
  const ref = fieldRef(f.field, ctx, aspects);
  if (f.min.kind === 'timestamp') {
    return sql`${ref.expr} BETWEEN ${f.min.value}::timestamptz AND ${f.max.value}::timestamptz`;
  }
  if (f.min.kind === 'date') {
    return sql`${ref.expr} BETWEEN ${f.min.value} AND ${f.max.value}`;
  }
  return sql`${numericExpr(ref)} BETWEEN ${f.min.value}::numeric AND ${f.max.value}::numeric`;
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

/**
 * Сортировочный каст поля аспекта: date/numeric — по §6.1; timestamp — момент, не строка.
 *
 * `switch` исчерпывающий: `string`/`boolean` названы поимённо, а `default` держит
 * `never`-гард. Прежний `default: return sql`(${expr})`` был тем самым молчанием, из-за
 * которого дефект ветки прожил незаметно, — он же утащил бы в сортировку по тексту JSON
 * и любой СЛЕДУЮЩИЙ член `FieldType`, не уронив ни типизацию, ни тест. Текстовый порядок
 * — осознанный выбор ровно для двух типов, поэтому он записан для них, а не для «всего
 * остального».
 */
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
    case 'string':
    case 'boolean':
      // Текстовая проекция `->>` и есть порядок: у строк лексикографический, у булевых
      // 'false' < 'true'. Enum сортируется не здесь — sortItem подставляет CASE раньше.
      return sql`(${ref.expr})`;
    case 'array':
    case 'unfilterable':
      // Парсер такую сортировку отсекает (parse.ts, parseSortBy) — сюда попасть можно
      // только рассинхроном, и тогда молчать нельзя: порядок по тексту JSON правдоподобен
      // и бессмыслен, то есть неотличим от рабочего.
      throw new QueryCompileError(
        `сортировка по полю типа ${fieldTypeLabel(ref.type)} — рассинхрон с парсером`,
      );
    default: {
      const unhandled: never = ref.type;
      throw new QueryCompileError(
        `сортировка по полю типа '${String(unhandled)}' — тип добавлен без ветки в sortCast`,
      );
    }
  }
}
