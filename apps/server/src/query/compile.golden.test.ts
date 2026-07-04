// apps/server/src/query/compile.golden.test.ts
// Golden-тесты «запрос §6.1 → SQL+params» (§6.2). Фикстуры — НЕ «что вышло»,
// а проверенный вручную эталон: каждый снятый {sql, params} сверен с нормативной
// таблицей семантики Task 8 и псевдо-SQL PRD 01 §6.1 (чеклист — в отчёте задачи).
import { describe, expect, test } from 'bun:test';
import { aspectJsonSchema, BUILTIN_ASPECT_IDS, buildFieldCatalog, parseQuery } from '@orbis/shared';
import { PgDialect } from 'drizzle-orm/pg-core';
import goldens from '../../test/golden/query-sql.json';
import { compileCount, compileQuery, QueryCompileError } from './compile';

const dialect = new PgDialect();
const catalog = buildFieldCatalog(
  BUILTIN_ASPECT_IDS.map((id) => ({ id, schema: aspectJsonSchema(id) })),
);
const CTX = {
  catalog,
  thisEntityId: '00000000-0000-7000-8000-0000000000f1',
  today: '2026-07-03',
  timezone: 'Europe/Moscow',
} as const;

interface Golden {
  name: string;
  query: string;
  sql: string;
  params: unknown[];
  /** Опционально: эталон compileCount для той же строки запроса (бейджи 02 §3.2). */
  countSql?: string;
  countParams?: unknown[];
}

describe('golden: грамматика → SQL (§6.2)', () => {
  for (const g of goldens as Golden[]) {
    test(g.name, () => {
      const parsed = parseQuery(g.query, catalog);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      const q = dialect.sqlToQuery(compileQuery(parsed.ast, CTX));
      expect(q.sql.replaceAll(/\s+/g, ' ').trim()).toBe(g.sql);
      expect(q.params).toEqual(g.params);
    });
  }
});

describe('golden: compileCount — COUNT(*) без limit/sortBy/cap (02 §3.2)', () => {
  const withCount = (goldens as Golden[]).filter(
    (x): x is Golden & { countSql: string; countParams: unknown[] } => x.countSql !== undefined,
  );
  for (const g of withCount) {
    test(g.name, () => {
      const parsed = parseQuery(g.query, catalog);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      const q = dialect.sqlToQuery(compileCount(parsed.ast, CTX));
      expect(q.sql.replaceAll(/\s+/g, ' ').trim()).toBe(g.countSql);
      expect(q.params).toEqual(g.countParams);
    });
  }
});

describe('this вне контекста сущности — структурная ошибка компиляции', () => {
  const noThis = { ...CTX, thisEntityId: null };
  test('children_of=this при thisEntityId=null', () => {
    const parsed = parseQuery('children_of=this', catalog);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(() => compileQuery(parsed.ast, noThis)).toThrow(QueryCompileError);
    expect(() => compileQuery(parsed.ast, noThis)).toThrow(/this вне контекста сущности/);
  });
  test('parents_of=this при thisEntityId=null — и в compileCount тоже', () => {
    const parsed = parseQuery('parents_of=this', catalog);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(() => compileCount(parsed.ast, noThis)).toThrow(/this вне контекста сущности/);
  });
});
