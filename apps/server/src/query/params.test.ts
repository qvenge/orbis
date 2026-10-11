// apps/server/src/query/params.test.ts
// Подстановка значений параметров страницы (спека 1в §5.1, РП-6): чистая функция над деревом,
// без БД — отказ по блоку, не по пачке.
import { describe, expect, test } from 'bun:test';
import type { QueryAst, QueryFilterNode } from '@orbis/shared/query';
import { ExecError } from '../errors';
import { substituteParams } from './params';

// Узел собирается как сырое дерево — ровно то, что приходит из разбора; тип канона не проверяет
// связь оператора со значением, поэтому узел приводится к нему явно.
const due = (op: string, value: unknown) =>
  ({ prop: 'orbis/due_date', op, value }) as unknown as QueryFilterNode;

function failure(f: () => unknown): ExecError {
  try {
    f();
  } catch (e) {
    if (e instanceof ExecError) return e;
    throw e;
  }
  throw new Error('ожидался отказ, подстановка прошла');
}

describe('substituteParams', () => {
  test('подстановка в eq, gt, границы range и под not/or; проекция — как была', () => {
    const ast = {
      filter: {
        and: [
          due('eq', { param: 'p' }),
          due('gt', { param: 'q' }),
          due('range', { from: { param: 'p' }, to: { token: 'today' } }),
          { not: { or: [due('range', { to: { param: 'q' } }), { aspect: 'orbis/task' }] } },
        ],
      },
      sortBy: [{ field: 'orbis/due_date', dir: 'asc' }],
      limit: 5,
    } as unknown as QueryAst;
    expect(substituteParams(ast, { p: 'next_14d', q: 'this_week' })).toEqual({
      filter: {
        and: [
          due('eq', { token: 'next_14d' }),
          due('gt', { token: 'this_week' }),
          due('range', { from: { token: 'next_14d' }, to: { token: 'today' } }),
          {
            not: {
              or: [due('range', { to: { token: 'this_week' } }), { aspect: 'orbis/task' }],
            },
          },
        ],
      },
      sortBy: [{ field: 'orbis/due_date', dir: 'asc' }],
      limit: 5,
    });
  });

  test('нет значения для имени — VALIDATION с reason UNKNOWN_PARAM и именем', () => {
    const ast = { filter: due('eq', { param: 'period' }) } as unknown as QueryAst;
    const e = failure(() => substituteParams(ast, { other: 'today' }));
    expect(e.code).toBe('VALIDATION');
    expect(e.message).toBe('параметр «period» не объявлен на странице');
    expect(e.details).toMatchObject({ reason: 'UNKNOWN_PARAM', name: 'period' });
  });

  test('значение — не токен даты — VALIDATION с reason PARAM_VALUE, не тихий «сегодня»', () => {
    const ast = { filter: due('eq', { param: 'period' }) } as unknown as QueryAst;
    for (const bad of ['soon', '', '2026-01-01', 'TODAY']) {
      const e = failure(() => substituteParams(ast, { period: bad }));
      expect(e.code).toBe('VALIDATION');
      expect(e.details).toMatchObject({ reason: 'PARAM_VALUE', name: 'period' });
    }
  });

  test('имя из прототипа объекта — не значение: `constructor` без значения — UNKNOWN_PARAM', () => {
    const ast = { filter: due('eq', { param: 'constructor' }) } as unknown as QueryAst;
    const e = failure(() => substituteParams(ast, {}));
    expect(e.details).toMatchObject({ reason: 'UNKNOWN_PARAM', name: 'constructor' });
  });

  test('дерево без ссылок возвращается ТЕМ ЖЕ объектом; лишние значения не мешают', () => {
    const ast = {
      filter: { and: [due('eq', { token: 'today' }), { aspect: 'orbis/task' }] },
    } as unknown as QueryAst;
    expect(substituteParams(ast, {})).toBe(ast);
    expect(substituteParams(ast, { period: 'soon' })).toBe(ast);
    const empty = { filter: null } as QueryAst;
    expect(substituteParams(empty, { p: 'today' })).toBe(empty);
  });
});
