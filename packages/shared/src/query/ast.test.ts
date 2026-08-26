/**
 * Канон Q-AST (§А5-7) и его JSON Schema (§А5-4): схема — единственный вход тула
 * `entity_query` для AST-формы, поэтому она обязана принимать ровно эталонный набор
 * фикстур и отвергать выдумку — узел с посторонним ключом и оператор `gte`, которого
 * в каноне НЕТ (`<=`/`>=` кодируются включающим `range` — находка 8 ревью плана).
 */

import { expect, test } from 'bun:test';
import Ajv from 'ajv';
import { queryAstSchema } from './ast';
import { AST_FIXTURES } from './ast-fixtures';
import { queryAstJsonSchema } from './ast-json-schema';

function validator() {
  // strict:false — та же настройка, под которой схема поедет в Responses API (D29):
  // `$defs` в draft-07 формально не ключевое слово, а `$ref: '#/$defs/node'` — обычный
  // JSON-указатель, и резолвится он у любого потребителя.
  const ajv = new Ajv({ strict: false, allErrors: true });
  return ajv.compile(queryAstJsonSchema);
}

test('queryAstJsonSchema валидирует все фикстуры (ajv) и отвергает узел с неизвестным ключом и op gte', () => {
  const validate = validator();
  expect(AST_FIXTURES.length).toBeGreaterThanOrEqual(12);
  for (const fixture of AST_FIXTURES) {
    const ok = validate(fixture.ast);
    expect(ok, `${fixture.name}: ${JSON.stringify(validate.errors)}`).toBe(true);
  }

  // Узел с посторонним ключом: `additionalProperties:false` на каждой ветке.
  expect(validate({ filter: { prop: 'orbis/limit', op: 'eq', value: '1', extra: 1 } })).toBe(false);
  expect(validate({ filter: { unknown_node: 1 } })).toBe(false);
  // `gte`/`lte` в каноне НЕТ — граница кодируется включающим range.
  expect(validate({ filter: { prop: 'orbis/limit', op: 'gte', value: '1000' } })).toBe(false);
  expect(validate({ filter: { prop: 'orbis/limit', op: 'range', value: { to: '1000' } } })).toBe(
    true,
  );
  // Проекция — отдельными полями, посторонних полей у корня нет.
  expect(validate({ filter: null, limit: 20 })).toBe(true);
  expect(validate({ filter: null, filters: [] })).toBe(false);
});

test('zod-схема канона совпадает с JSON Schema по вердикту на тех же входах', () => {
  const validate = validator();
  const probes: unknown[] = [
    { filter: null },
    { filter: { and: [{ aspect: 'orbis/task' }, { not: { tag: 'дом' } }] } },
    { filter: { rel: { kind: 'descendants_of', via: 'subitem', of: 'this' } } },
    { filter: { class: { contract: 'orbis/completable', set: 'done' } } },
    { filter: { prop: 'orbis/due_date', op: 'range', value: {} } },
    { filter: { prop: 'orbis/task_status', op: 'in', value: [] } },
    { filter: { rel: { kind: 'нет-такого' } } },
    { filter: { archived: 'yes' } },
    { sortBy: [{ field: 'orbis/priority', dir: 'desc' }] },
  ];
  for (const probe of probes) {
    expect(queryAstSchema.safeParse(probe).success, JSON.stringify(probe)).toBe(
      validate(probe) as boolean,
    );
  }
});
