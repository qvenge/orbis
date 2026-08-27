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
  // Пользовательская запись и текстовый сахар дают РАЗНЫЕ деревья, и оба живут в наборе
  // фикстур: у первого — голое ребро, у второго ещё и состояние блокирующей работы.
  const explicit = AST_FIXTURES.find((f) => f.keyText === '!has_relation via=dependency');
  expect(explicit?.ast.filter).toEqual({
    not: { rel: { kind: 'has_relation', via: 'dependency' } },
  });
  const sugar = AST_FIXTURES.find((f) => f.keyText === 'excludeBlocked=true');
  expect(sugar?.ast.filter).toEqual({
    not: {
      rel: {
        kind: 'has_relation',
        via: 'dependency',
        sourceNotIn: { prop: 'orbis/task_status', values: ['done', 'cancelled'] },
      },
    },
  });
});

test('рекурсивный $ref работает НА ГЛУБИНЕ: мусор внутри and/or/not отвергают обе схемы', () => {
  const validate = validator();
  const both = (filter: unknown): [boolean, boolean] => [
    queryAstSchema.safeParse({ filter }).success,
    validate({ filter }) as boolean,
  ];
  // Прежняя проверка «zod совпадает с ajv» гоняла вложенными только ВАЛИДНЫЕ пробы, и
  // порча `items` у `and` (→ `{}`) проходила весь сьют: ajv переставал спускаться внутрь,
  // zod продолжал. Расхождение всплыло бы у чужого потребителя схемы (проба провайдера
  // Задачи 9a, вход тула 9b), а не здесь. Ниже — мусор на глубине 1, 2 и 3.
  const bad: [unknown, string][] = [
    [{ and: [{ мусор: 1 }] }, 'мусор в and, глубина 1'],
    [{ or: [{ мусор: 1 }] }, 'мусор в or, глубина 1'],
    [{ not: { мусор: 1 } }, 'мусор в not, глубина 1'],
    [{ and: [{ aspect: 'orbis/task' }, { or: [{ мусор: 1 }] }] }, 'мусор в or внутри and'],
    [{ not: { and: [{ not: { мусор: 1 } }] } }, 'мусор на глубине 3'],
    [{ and: [{ or: [{ not: { prop: 'p', op: 'gte', value: 1 } }] }] }, 'op gte на глубине 3'],
    [{ and: [{ prop: 'p', op: 'eq', value: 1, extra: 2 }] }, 'лишний ключ узла на глубине 1'],
    [
      { or: [{ and: [{ rel: { kind: 'descendants_of', of: 'this' } }] }] },
      'rel без via на глубине 2',
    ],
    [{ and: [{ archived: 'yes' }] }, 'чужое значение archived на глубине 1'],
    [{ and: [] }, 'пустой and'],
    [{ or: [] }, 'пустой or'],
  ];
  for (const [filter, why] of bad) {
    const [zod, ajv] = both(filter);
    expect(zod, `zod: ${why}`).toBe(false);
    expect(ajv, `ajv: ${why}`).toBe(false);
  }
  // Валидная вложенность той же глубины принимается обеими — гард не выродился в «всё нельзя».
  const ok = { and: [{ or: [{ not: { aspect: 'orbis/task' } }, { tag: 'дом' }] }] };
  expect(both(ok)).toEqual([true, true]);
});

test('§А5-7: `of` — только uuid или this, и это знает СХЕМА, а не только парсер', () => {
  const validate = validator();
  const both = (of: string): [boolean, boolean] => {
    const filter = { rel: { kind: 'children_of', of } };
    return [queryAstSchema.safeParse({ filter }).success, validate({ filter }) as boolean];
  };
  expect(both('this')).toEqual([true, true]);
  expect(both('019d48ea-4188-765d-8e96-93a0ad9c262a')).toEqual([true, true]);
  expect(both('019D48EA-4188-765D-8E96-93A0AD9C262A')).toEqual([true, true]);
  // Вход `ast:` тула идёт мимо парсера: без сужения в схеме `banana` доехал бы до SQL и
  // вернулся ошибкой каста 22P02 вместо структурного отказа с именем поля.
  for (const bad of ['banana', 'DROP TABLE entities', '', 'this ', '019d48ea-4188-765d-8e96']) {
    expect(both(bad), bad).toEqual([false, false]);
  }
});
