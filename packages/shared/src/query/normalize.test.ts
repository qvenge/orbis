// packages/shared/src/query/normalize.test.ts
// Нормализация имён в дереве Q-AST (§А5-2): key → id для четырёх модель-фейсинговых входов,
// которые идут МИМО разбора текста. Без БД — на фикстурном реестре, где у своего свойства
// key ≠ id (`FIXTURE_USER_PROPERTY_ID`).
import { expect, test } from 'bun:test';
import type { QueryAst } from './ast';
import {
  FIXTURE_USER_CONTRACT_ID,
  FIXTURE_USER_LIST_ID,
  FIXTURE_USER_PROPERTY_ID,
  FIXTURE_PARSE_REGISTRY as REG,
} from './ast-fixtures';
import { normalizeQueryAst } from './normalize';

test('key своего свойства в `prop` становится id — тем самым, который знает компилятор', () => {
  // Ровно то, что обещает модели промпт v5 («в дереве стоят те же key свойств и аспектов»)
  // и чего компилятор не умел: у своего свойства id — uuid, key — `user/…`, и дерево с key
  // отвечало `UNKNOWN_FIELD: такого id нет в реестре владельца`.
  const ast: QueryAst = { filter: { prop: 'user/effort_points', op: 'gt', value: 3 } };
  expect(normalizeQueryAst(ast, REG)).toEqual({
    filter: { prop: FIXTURE_USER_PROPERTY_ID, op: 'gt', value: 3 },
  });
});

test('`has` и `sortBy.field` — две точки записи имени СВОЙСТВА', () => {
  const ast: QueryAst = {
    filter: {
      and: [
        { has: 'user/effort_points' },
        { not: { prop: 'user/labels', op: 'contains', value: 'дом' } },
      ],
    },
    sortBy: [{ field: 'user/labels', dir: 'desc' }],
  };
  expect(normalizeQueryAst(ast, REG)).toEqual({
    filter: {
      and: [
        { has: FIXTURE_USER_PROPERTY_ID },
        { not: { prop: FIXTURE_USER_LIST_ID, op: 'contains', value: 'дом' } },
      ],
    },
    sortBy: [{ field: FIXTURE_USER_LIST_ID, dir: 'desc' }],
  });
});

test('`class.contract` и `rel.sourceNotIn.contract` — две точки записи имени КОНТРАКТА', () => {
  // Обе приезжают МИМО разбора текста (вход `ast:` тула, атрибут query-блока), и без резолва
  // компилятор ответил бы UNKNOWN_CONTRACT на key своего контракта — тот самый тихий отказ,
  // ради которого нормализация и заведена.
  const ast: QueryAst = {
    filter: {
      and: [
        { class: { contract: 'user/reviewable', set: 'live' } },
        {
          rel: {
            kind: 'has_relation',
            via: 'dependency',
            sourceNotIn: { contract: 'user/reviewable', set: 'live' },
          },
        },
      ],
    },
  };
  expect(normalizeQueryAst(ast, REG)).toEqual({
    filter: {
      and: [
        { class: { contract: FIXTURE_USER_CONTRACT_ID, set: 'live' } },
        {
          rel: {
            kind: 'has_relation',
            via: 'dependency',
            sourceNotIn: { contract: FIXTURE_USER_CONTRACT_ID, set: 'live' },
          },
        },
      ],
    },
  });

  // Имя НАБОРА не резолвится: второй оси адресации у него нет — отказ на неизвестном наборе
  // принадлежит парсеру и компилятору, а не второму мнению здесь.
  expect(
    normalizeQueryAst(
      { filter: { class: { contract: 'user/reviewable', set: 'нет-такого' } } },
      REG,
    ),
  ).toEqual({ filter: { class: { contract: FIXTURE_USER_CONTRACT_ID, set: 'нет-такого' } } });
});

test('дерево по id остаётся собой — расширение, а не подмена', () => {
  const ast: QueryAst = {
    filter: {
      or: [
        { prop: FIXTURE_USER_PROPERTY_ID, op: 'eq', value: 5 },
        { aspect: 'orbis/task' },
        { tag: 'дом' },
        { archived: 'any' },
      ],
    },
    limit: 10,
    title: 'Проба',
  };
  expect(normalizeQueryAst(ast, REG)).toEqual(ast);
});

test('НЕИЗВЕСТНОЕ имя остаётся как есть: отказ называет компилятор, а не нормализация', () => {
  const ast: QueryAst = { filter: { prop: 'user/нет-такого', op: 'eq', value: 1 } };
  expect(normalizeQueryAst(ast, REG)).toEqual(ast);
});

test('вход не мутируется: то же дерево может лежать в конверте соседней операции пачки', () => {
  const ast: QueryAst = { filter: { prop: 'user/effort_points', op: 'eq', value: 1 } };
  const snapshot = JSON.stringify(ast);
  normalizeQueryAst(ast, REG);
  expect(JSON.stringify(ast)).toBe(snapshot);
});

test('дерево глубже капа возвращается КАК ЕСТЬ — отказ принадлежит гейту глубины', () => {
  // Стек здесь исчерпался бы раньше гейта: нормализация переписывает дерево рекурсией,
  // а вход недоверенный (`ast:` тула). Проба на 5000 уровнях — заведомо за капом.
  let node: Record<string, unknown> = { prop: 'user/effort_points', op: 'eq', value: 1 };
  for (let i = 0; i < 5000; i += 1) node = { not: node };
  const deep = { filter: node } as unknown as QueryAst;
  expect(normalizeQueryAst(deep, REG)).toBe(deep);
});
