// packages/shared/src/query/normalize.test.ts
// Нормализация имён в дереве Q-AST (§А5-2): key → id для четырёх модель-фейсинговых входов,
// которые идут МИМО разбора текста. Без БД — на фикстурном реестре, где у своего свойства
// key ≠ id (`FIXTURE_USER_PROPERTY_ID`).
import { expect, test } from 'bun:test';
import type { QueryAst } from './ast';
import {
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

test('`has`, `sortBy.field` и `rel.sourceNotIn.prop` — те же три точки записи имени в дерево', () => {
  const ast: QueryAst = {
    filter: {
      and: [
        { has: 'user/effort_points' },
        { not: { prop: 'user/labels', op: 'contains', value: 'дом' } },
        {
          rel: {
            kind: 'has_relation',
            via: 'dependency',
            sourceNotIn: { prop: 'user/effort_points', values: [1] },
          },
        },
      ],
    },
    sortBy: [{ field: 'user/labels', dir: 'desc' }],
  };
  expect(normalizeQueryAst(ast, REG)).toEqual({
    filter: {
      and: [
        { has: FIXTURE_USER_PROPERTY_ID },
        { not: { prop: FIXTURE_USER_LIST_ID, op: 'contains', value: 'дом' } },
        {
          rel: {
            kind: 'has_relation',
            via: 'dependency',
            sourceNotIn: { prop: FIXTURE_USER_PROPERTY_ID, values: [1] },
          },
        },
      ],
    },
    sortBy: [{ field: FIXTURE_USER_LIST_ID, dir: 'desc' }],
  });
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
