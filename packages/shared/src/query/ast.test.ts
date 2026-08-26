/**
 * Канон Q-AST (§А5-7) и его JSON Schema (§А5-4): схема — единственный вход тула
 * `entity_query` для AST-формы, поэтому она обязана принимать ровно эталонный набор
 * фикстур и отвергать выдумку — узел с посторонним ключом и оператор `gte`, которого
 * в каноне НЕТ (`<=`/`>=` кодируются включающим `range` — находка 8 ревью плана).
 */

import { expect, test } from 'bun:test';
import Ajv from 'ajv';
import { QUERY_REL_ANCHOR, queryAstSchema } from './ast';
import { AST_FIXTURES, FIXTURE_PARSE_REGISTRY } from './ast-fixtures';
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

test('форма rel СВЯЗАНА с kind: обе схемы отвергают невыразимое, минуя парсер', () => {
  const validate = validator();
  const both = (filter: unknown): [boolean, boolean] => [
    queryAstSchema.safeParse({ filter }).success,
    validate({ filter }) as boolean,
  ];
  // Вход `ast:` тула (§А5-4) идёт МИМО парсера — связь обязана жить в схеме, иначе
  // гарантия §С8-3 «невыразимое — ошибка, а не пустота» обходится через тул.
  const cases: [unknown, boolean, string][] = [
    [{ rel: { kind: 'descendants_of', of: 'this' } }, false, 'рекурсия без via — QUERY_MULTI_ROLE'],
    [{ rel: { kind: 'ancestors_of', of: 'this' } }, false, 'рекурсия без via'],
    [{ rel: { kind: 'descendants_of', via: 'subitem', of: 'this' } }, true, 'рекурсия с via'],
    [{ rel: { kind: 'children_of', via: 'subitem' } }, false, 'children_of без of'],
    [{ rel: { kind: 'parents_of' } }, false, 'parents_of без of'],
    [
      { rel: { kind: 'children_of', of: 'this' } },
      true,
      'children_of без via — семейство иерархии',
    ],
    [{ rel: { kind: 'has_children', of: 'this' } }, false, 'has_children не берёт вторую сущность'],
    [{ rel: { kind: 'has_relation', of: 'this', via: 'dependency' } }, false, 'has_relation тоже'],
    [{ rel: { kind: 'has_relation' } }, false, 'has_relation без роли'],
    [{ rel: { kind: 'has_relation', via: 'dependency' } }, true, 'has_relation с ролью'],
    [{ rel: { kind: 'has_children' } }, true, 'has_children без via — семейство иерархии'],
    [{ rel: { kind: 'has_children', via: 'subitem' } }, true, 'has_children с ролью'],
  ];
  for (const [filter, expected, why] of cases) {
    const [zod, ajv] = both(filter);
    expect(zod, `zod: ${why}`).toBe(expected);
    expect(ajv, `ajv: ${why}`).toBe(expected);
  }
});

test('QUERY_REL_ANCHOR: направление каждого предиката совпадает с подписями ролей реестра', () => {
  const role = (id: string) => FIXTURE_PARSE_REGISTRY.roles.get(id);
  /** Подпись того конца ребра, на котором стоит САМА сущность. */
  const anchorLabel = (roleId: string, kind: keyof typeof QUERY_REL_ANCHOR): string => {
    const def = role(roleId);
    if (!def) throw new Error(`нет роли ${roleId}`);
    const label = QUERY_REL_ANCHOR[kind] === 'target' ? def.targetLabel : def.sourceLabel;
    return label.ru ?? '';
  };
  // Рулинг координатора: `has_relation` — ВХОДЯЩЕЕ ребро. Проверка не на слово, а на
  // подписи самого реестра: у роли `dependency` цель — «Заблокированная работа», источник —
  // «Блокирующая работа». Если направление подменить на 'source', под
  // `!has_relation via=dependency` начнут попадать САМИ БЛОКИРОВЩИКИ — регресс против
  // сегодняшнего `excludeBlocked` (`compile.ts:262`).
  expect(QUERY_REL_ANCHOR.has_relation).toBe('target');
  expect(anchorLabel('dependency', 'has_relation')).toBe('Заблокированная работа');
  expect(role('dependency')?.sourceLabel.ru).toBe('Блокирующая работа');
  // Остальные пять — та же сверка с реестром, чтобы таблица не разъехалась целиком.
  expect(anchorLabel('subitem', 'children_of')).toBe('Подпункт');
  expect(anchorLabel('subitem', 'parents_of')).toBe('Родитель');
  expect(anchorLabel('subitem', 'descendants_of')).toBe('Подпункт');
  expect(anchorLabel('subitem', 'ancestors_of')).toBe('Родитель');
  expect(anchorLabel('subitem', 'has_children')).toBe('Родитель');
  // Текстовый сахар `excludeBlocked=true` обязан давать ИМЕННО этот предикат.
  const blocked = AST_FIXTURES.find((f) => f.keyText === '!has_relation via=dependency');
  expect(blocked?.ast.filter).toEqual({
    not: { rel: { kind: 'has_relation', via: 'dependency' } },
  });
});
