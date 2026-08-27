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
  },
  required: ['filter'],
  additionalProperties: false,
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
                    // Состояние дальнего конца ребра (см. `QueryRelSourceNotIn`): в срезе А
                    // им выражен `excludeBlocked`, в Б-1 его заменяет `class`.
                    sourceNotIn: node(
                      {
                        prop: PROP_ID,
                        values: { type: 'array', minItems: 1, items: SCALAR },
                      },
                      ['prop', 'values'],
                    ),
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
