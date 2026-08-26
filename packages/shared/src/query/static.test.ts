/**
 * Статическое подмножество Q-AST (§А6-1 для `ref.target`, §А2-1 для `scope`): цель ссылки
 * и область свойства обязаны быть множеством, вычислимым БЕЗ «сегодня» и без «этой
 * сущности» — иначе ссылка, валидная в понедельник, стала бы битой во вторник.
 */
import { expect, test } from 'bun:test';
import { AST_FIXTURES } from './ast-fixtures';
import { assertStaticQuery, SCOPE_NOT_STATIC, ScopeNotStaticError } from './static';

function reject(ast: Parameters<typeof assertStaticQuery>[0]): string {
  try {
    assertStaticQuery(ast);
  } catch (e) {
    expect(e).toBeInstanceOf(ScopeNotStaticError);
    return (e as ScopeNotStaticError).code;
  }
  throw new Error(`ожидался отказ ${SCOPE_NOT_STATIC}, запрос принят`);
}

test('assertStaticQuery: относительное время, поиск, this и проекция — вне статики', () => {
  expect(reject({ filter: { prop: 'orbis/due_date', op: 'eq', value: { token: 'today' } } })).toBe(
    SCOPE_NOT_STATIC,
  );
  expect(
    reject({ filter: { prop: 'orbis/due_date', op: 'range', value: { to: { token: 'today' } } } }),
  ).toBe(SCOPE_NOT_STATIC);
  expect(reject({ filter: { search: 'кофе' } })).toBe(SCOPE_NOT_STATIC);
  expect(reject({ filter: { rel: { kind: 'children_of', of: 'this' } } })).toBe(SCOPE_NOT_STATIC);
  expect(reject({ filter: { archived: 'any' } })).toBe(SCOPE_NOT_STATIC);
  expect(reject({ filter: null, limit: 10 })).toBe(SCOPE_NOT_STATIC);
  expect(reject({ filter: null, sortBy: [{ field: 'orbis/priority', dir: 'asc' }] })).toBe(
    SCOPE_NOT_STATIC,
  );
  expect(reject({ filter: null, display: 'table' })).toBe(SCOPE_NOT_STATIC);
  expect(reject({ filter: null, title: 'Категории' })).toBe(SCOPE_NOT_STATIC);
  // Запрет ныряет внутрь дерева, а не смотрит только на корень.
  expect(reject({ filter: { and: [{ aspect: 'orbis/task' }, { not: { search: 'кофе' } }] } })).toBe(
    SCOPE_NOT_STATIC,
  );
});

test('assertStaticQuery: aspect, tag и абсолютные значения — статика (v1 scope §А2-1)', () => {
  expect(() => assertStaticQuery({ filter: { aspect: 'orbis/category' } })).not.toThrow();
  expect(() => assertStaticQuery({ filter: { tag: 'дом' } })).not.toThrow();
  expect(() =>
    assertStaticQuery({
      filter: {
        and: [{ aspect: 'orbis/category' }, { not: { tag: 'скрытая' } }],
      },
    }),
  ).not.toThrow();
  expect(() =>
    assertStaticQuery({
      filter: { prop: 'orbis/due_date', op: 'range', value: { from: '2026-01-01' } },
    }),
  ).not.toThrow();
  expect(() =>
    assertStaticQuery({
      filter: { rel: { kind: 'children_of', of: '019d48ea-4188-765d-8e96-93a0ad9c262a' } },
    }),
  ).not.toThrow();
});

test('фикстуры, помеченные статическими, проходят гейт; остальные — нет', () => {
  for (const fixture of AST_FIXTURES) {
    if (fixture.static) expect(() => assertStaticQuery(fixture.ast), fixture.name).not.toThrow();
    else expect(() => assertStaticQuery(fixture.ast), fixture.name).toThrow(ScopeNotStaticError);
  }
  expect(AST_FIXTURES.filter((f) => f.static).length).toBeGreaterThanOrEqual(2);
  expect(AST_FIXTURES.filter((f) => !f.static).length).toBeGreaterThanOrEqual(5);
});
