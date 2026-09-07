/**
 * JSON Schema языка E (§Б3-1): вход `expr:` тулов реестра владельца и проба провайдера
 * (D29 — прогон на Responses API при `strict:false`).
 *
 * Почему схема написана РУКАМИ, а не выведена из zod: `zod-to-json-schema` разворачивает
 * `z.lazy` в именованное определение с непредсказуемым для нас именем и добавляет
 * конструкции вне класса «простого draft-07», а эта схема поедет ЧУЖОМУ потребителю, где
 * именно такие мелочи и ломались (D29: `(?!` в паттерне вынудил `strict:false`). Совпадение
 * вердиктов zod-схемы и этой закреплено тестом `ast.test.ts` — «zod-схема E совпадает с JSON
 * Schema по вердикту».
 *
 * КОРЕНЬ — САМ УЗЕЛ, в отличие от Q-AST: у выражения нет ни проекции, ни сортировки, ни
 * лимита, поэтому у схемы нет и объемлющего объекта — только `$ref` на ветку узла.
 * Рекурсия — через `$ref: '#/$defs/node'`: `$defs` в draft-07 формально не ключевое слово,
 * но ссылка на него — обычный JSON-указатель и резолвится везде.
 */
import { EXPR_CTX, EXPR_DURATION_PATTERN, type ExprOp } from './ast';

const SCALAR = { type: ['string', 'number', 'boolean', 'null'] } as const;
const NAME = { type: 'string', minLength: 1 } as const;
const REF = { $ref: '#/$defs/node' } as const;
/** Пара аргументов у `date_add`/`date_diff`/`days_inclusive` — ровно два, не «хотя бы». */
const pair = { type: 'array', items: REF, minItems: 2, maxItems: 2 } as const;

/** Ветка узла: ровно один ключ-имя, ничего сверх — «узел с лишним ключом» отвергается. */
function node(properties: Record<string, unknown>, required: string[]): Record<string, unknown> {
  return { type: 'object', properties, required, additionalProperties: false };
}

/**
 * Ветка оператора. Арность — ЧАСТЬ ФОРМЫ (см. докблок `exprNodeSchema`), поэтому операторы
 * разложены по веткам с разными границами `args`, а не собраны в один `enum` из пятнадцати.
 */
function opNode(
  ops: readonly ExprOp[],
  minItems: number,
  maxItems?: number,
): Record<string, unknown> {
  return node(
    {
      op: { enum: [...ops] },
      args: {
        type: 'array',
        items: REF,
        minItems,
        ...(maxItems === undefined ? {} : { maxItems }),
      },
    },
    ['op', 'args'],
  );
}

export const exprJsonSchema: Record<string, unknown> = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'Orbis E-AST',
  $ref: '#/$defs/node',
  description:
    'Типизированное выражение Orbis (§Б3-5): единственный язык формул и предикатов деклараций.',
  $defs: {
    node: {
      anyOf: [
        node(
          { const: { anyOf: [SCALAR, { type: 'array', minItems: 1, items: { type: 'string' } }] } },
          ['const'],
        ),
        node({ duration: { type: 'string', pattern: EXPR_DURATION_PATTERN } }, ['duration']),
        node({ prop: NAME }, ['prop']),
        node({ slot: NAME }, ['slot']),
        node({ param: NAME }, ['param']),
        node({ ctx: { enum: [...EXPR_CTX] } }, ['ctx']),
        node({ agg: NAME }, ['agg']),
        node({ phase: NAME }, ['phase']),
        node({ agg_via: node({ role: NAME, name: NAME }, ['role', 'name']) }, ['agg_via']),
        node(
          {
            deref: {
              anyOf: [
                node({ prop: NAME, read: NAME }, ['prop', 'read']),
                node({ slot: NAME, read: NAME }, ['slot', 'read']),
              ],
            },
          },
          ['deref'],
        ),
        opNode(['=', '!=', '>', '<', '>=', '<=', '+', '-', '*', '/', 'in'], 2, 2),
        opNode(['not'], 1, 1),
        opNode(['if'], 3, 3),
        opNode(['and', 'or'], 2),
        node({ has: NAME }, ['has']),
        node(
          {
            has_relation: node(
              {
                role: NAME,
                in_set: node({ contract: NAME, set: NAME }, ['contract', 'set']),
                alive: { type: 'boolean' },
              },
              ['role'],
            ),
          },
          ['has_relation'],
        ),
        node({ class: node({ contract: NAME }, ['contract']) }, ['class']),
        node({ date_add: pair }, ['date_add']),
        node({ date_diff: pair }, ['date_diff']),
        node({ days_inclusive: pair }, ['days_inclusive']),
      ],
    },
  },
};
