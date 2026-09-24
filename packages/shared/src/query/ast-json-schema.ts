/**
 * JSON Schema канонического Q-AST (§А5-4): вход тула `entity_query` в AST-форме и проба
 * провайдера (D29 — прогон на Responses API при `strict:false`).
 *
 * Почему схема написана РУКАМИ, а не выведена из zod: `zod-to-json-schema` разворачивает
 * `z.lazy` в именованное определение с непредсказуемым для нас именем и добавляет
 * конструкции вне класса «простого draft-07», а эта схема поедет ЧУЖОМУ потребителю
 * (валидатор провайдера), где именно такие мелочи и ломались (D29: `(?!` в паттерне
 * вынудил `strict:false`). Совпадение вердиктов zod-схемы и этой закреплено тестом
 * `ast.test.ts` — «zod-схема канона совпадает с JSON Schema по вердикту».
 *
 * Рекурсия — через `$ref: '#/$defs/node'`. `$defs` в draft-07 формально не ключевое слово,
 * но ссылка на него — обычный JSON-указатель и резолвится везде; имя выбрано по §А5-4.
 */
import { QUERY_DATE_TOKENS, QUERY_DISPLAY_MODES, REL_TARGET_PATTERN } from './ast';

const SCALAR = { type: ['string', 'number', 'boolean'] } as const;
const TOKEN = {
  type: 'object',
  properties: { token: { enum: [...QUERY_DATE_TOKENS] } },
  required: ['token'],
  additionalProperties: false,
} as const;
const BOUND = { anyOf: [SCALAR, TOKEN] } as const;

/** Ветка узла: ровно один ключ-имя, ничего сверх — «узел с лишним ключом» отвергается. */
function node(properties: Record<string, unknown>, required: string[]): Record<string, unknown> {
  return { type: 'object', properties, required, additionalProperties: false };
}

const PROP_ID = { type: 'string', minLength: 1 } as const;
/** `of?: uuid|"this"` §А5-7 — паттерн один на zod и на эту схему (см. `REL_TARGET_PATTERN`). */
const REL_TARGET = { type: 'string', pattern: REL_TARGET_PATTERN } as const;

/** «`display` задан и равен `mode`» — посылка правил проекции ниже. */
function displayIs(mode: string): Record<string, unknown> {
  return { properties: { display: { const: mode } }, required: ['display'] };
}

/**
 * Согласованность проекции блока данных (§5.4) — та же тройка, что `superRefine` у
 * `queryAstSchema` (там же довод, почему правило в схеме, а не только в разборе).
 *
 * Форма выбрана под ДВА валидатора сразу. Строгий ajv записи значения (`validate-props.ts`,
 * `strict: true`) требует, чтобы каждое имя в `required` было объявлено в `properties` ТОЙ
 * ЖЕ подсхемы (`strictRequired`): голое `{required: ['aggregate']}` внутри `anyOf`/`not`
 * роняет компиляцию схемы `orbis/progress_source`. Поэтому «aggregate ⇒ tile» и «columns ⇒
 * table» — `dependencies` (ключевое слово draft-07 ровно для «если есть ключ»), а «tile ⇒
 * aggregate» — импликация `anyOf: [не A, B]`, где у `required` рядом стоит пустое
 * объявление свойства. `if/then` не взят: его `then` упирается в тот же `strictRequired`.
 */
const PROJECTION_DEPENDENCIES = { aggregate: displayIs('tile'), columns: displayIs('table') };
const TILE_NEEDS_AGGREGATE = [
  { not: displayIs('tile') },
  { properties: { aggregate: {} }, required: ['aggregate'] },
];

export const queryAstJsonSchema: Record<string, unknown> = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'Orbis Q-AST',
  description:
    'Канонический разобранный запрос Orbis (§А5-7): дерево and/or/not над предикатами и отдельные поля проекции.',
  type: 'object',
  properties: {
    filter: { anyOf: [{ $ref: '#/$defs/node' }, { type: 'null' }] },
    sortBy: {
      type: 'array',
      minItems: 1,
      items: node({ field: PROP_ID, dir: { enum: ['asc', 'desc'] } }, ['field', 'dir']),
    },
    limit: { type: 'integer', minimum: 1 },
    display: { enum: [...QUERY_DISPLAY_MODES] },
    title: { type: 'string', minLength: 1 },
    // Агрегат плитки — по ветке на `fn`, как у zod (дискриминированный союз).
    aggregate: {
      anyOf: [
        node({ fn: { const: 'count' } }, ['fn']),
        node({ fn: { enum: ['sum', 'latest'] }, field: PROP_ID }, ['fn', 'field']),
      ],
    },
    columns: { type: 'array', minItems: 1, items: node({ field: PROP_ID }, ['field']) },
    hideEmpty: { const: true },
  },
  required: ['filter'],
  additionalProperties: false,
  dependencies: PROJECTION_DEPENDENCIES,
  anyOf: TILE_NEEDS_AGGREGATE,
  $defs: {
    node: {
      anyOf: [
        node({ and: { type: 'array', minItems: 1, items: { $ref: '#/$defs/node' } } }, ['and']),
        node({ or: { type: 'array', minItems: 1, items: { $ref: '#/$defs/node' } } }, ['or']),
        node({ not: { $ref: '#/$defs/node' } }, ['not']),
        // Предикат свойства — по ветке на форму значения (см. докблок propNodeSchema).
        node({ prop: PROP_ID, op: { enum: ['eq', 'ne', 'gt', 'lt'] }, value: BOUND }, [
          'prop',
          'op',
          'value',
        ]),
        node(
          {
            prop: PROP_ID,
            op: { const: 'in' },
            value: { type: 'array', minItems: 1, items: SCALAR },
          },
          ['prop', 'op', 'value'],
        ),
        node({ prop: PROP_ID, op: { const: 'contains' }, value: SCALAR }, ['prop', 'op', 'value']),
        node(
          {
            prop: PROP_ID,
            op: { const: 'range' },
            value: {
              type: 'object',
              properties: { from: BOUND, to: BOUND },
              additionalProperties: false,
              // Включающие границы; пустой range — множество «всё», и записывать его
              // диапазоном значит прятать ошибку автора запроса.
              minProperties: 1,
            },
          },
          ['prop', 'op', 'value'],
        ),
        node({ has: PROP_ID }, ['has']),
        node({ aspect: PROP_ID }, ['aspect']),
        node({ tag: { type: 'string', minLength: 1 } }, ['tag']),
        node({ search: { type: 'string', minLength: 1 } }, ['search']),
        // Форма реляционного предиката СВЯЗАНА с kind (см. докблок `QueryRelPredicate`):
        // ветка на каждую комбинацию, а не один объект с необязательными via/of. Иначе
        // `{kind:'descendants_of', of:'this'}` без роли проехал бы вход `ast:` тула мимо
        // парсера — и §С8-3 «невыразимое — ошибка, а не пустота» обходилась бы через тул.
        node(
          {
            rel: {
              anyOf: [
                node(
                  {
                    kind: { enum: ['children_of', 'parents_of'] },
                    via: PROP_ID,
                    of: REL_TARGET,
                  },
                  ['kind', 'of'],
                ),
                node(
                  {
                    kind: { enum: ['descendants_of', 'ancestors_of'] },
                    via: PROP_ID,
                    of: REL_TARGET,
                  },
                  ['kind', 'of', 'via'],
                ),
                node(
                  {
                    kind: { const: 'has_relation' },
                    via: PROP_ID,
                    // Набор завершаемости дальнего конца ребра (см. `QueryRelSourceNotIn`):
                    // адрес набора — пара «контракт, имя набора», а не свойство и значения.
                    sourceNotIn: node({ contract: PROP_ID, set: PROP_ID }, ['contract', 'set']),
                  },
                  ['kind', 'via'],
                ),
                node({ kind: { const: 'has_children' }, via: PROP_ID }, ['kind']),
              ],
            },
          },
          ['rel'],
        ),
        node({ archived: { enum: ['true', 'any'] } }, ['archived']),
        node({ class: node({ contract: PROP_ID, set: PROP_ID }, ['contract', 'set']) }, ['class']),
      ],
    },
  },
};
