import { expect, test } from 'bun:test';
import {
  BUILTIN_ASPECT_DEFS,
  BUILTIN_CONTRACT_DEFS,
  BUILTIN_PROPERTY_META,
  BUILTIN_RELATION_ROLE_META,
} from '@orbis/shared';
import { parseGraphId } from '../identity';
import { compileCountAst, compileLatestAst, compileQueryAst } from './compile-ast';
import { nextMidnightInTimeZone } from './context';
import { observeQuery } from './dependencies';
import { substituteParams } from './params';
import { parseQueryText } from './parse-text';

const context = {
  graphId: parseGraphId('00000000-0000-7000-8000-0000000000a1'),
  today: '2026-03-08',
  timeZone: 'America/New_York',
  nextMidnightAt: () => '2026-03-09T04:00:00.000Z',
  ownerCurrency: 'RUB',
  weekStart: 'monday' as const,
  reg: {
    properties: new Map(BUILTIN_PROPERTY_META.map((p) => [p.id, p])),
    aspects: new Map(BUILTIN_ASPECT_DEFS.map((a) => [a.id, a])),
    roles: new Map(BUILTIN_RELATION_ROLE_META.map((r) => [r.id, r])),
    contracts: new Map(BUILTIN_CONTRACT_DEFS.map((c) => [c.id, c])),
    subscriptions: new Map(),
    actions: new Map(),
    ownerVersion: 0,
    systemVersion: 1,
  },
};

test('compiler observes nested text, resolved date bindings and substituted periods', () => {
  const { ctx, freshness } = observeQuery(context);
  const ast = parseQueryText('orbis/due_date=$period', ctx, { place: 'page' });
  const period = substituteParams(ast, { period: 'next_7d' }).filter;
  if (period === null) throw new Error('expected a period filter');
  compileCountAst(
    {
      filter: {
        not: {
          or: [{ search: 'word' }, { and: [period] }],
        },
      },
    },
    ctx,
  );
  expect(freshness()).toMatchObject({
    graph: true,
    bodyOrStamp: true,
    registry: true,
    settings: true,
    expiresAt: '2026-03-09T04:00:00.000Z',
  });
});

test('contract predicate observes today even when Q-AST contains no date token', () => {
  const { ctx, freshness } = observeQuery(context);
  compileCountAst(parseQueryText('class=orbis/money-movement:facts', ctx), ctx);
  expect(freshness().expiresAt).toBe('2026-03-09T04:00:00.000Z');
});

test('row projection and effective sort decide body-only dependencies', () => {
  const plain = observeQuery(context);
  compileQueryAst({ filter: null }, plain.ctx);
  expect(plain.freshness()).toMatchObject({ bodyOrStamp: false, expiresAt: null });

  for (const fields of ['start', 'full'] as const) {
    const projected = observeQuery(context);
    compileQueryAst({ filter: null }, projected.ctx, { fields });
    expect(projected.freshness().bodyOrStamp).toBe(true);
  }

  const ast = parseQueryText('sortBy=orbis/updated_at:desc', context);
  const count = observeQuery(context);
  compileCountAst(ast, count.ctx);
  expect(count.freshness().bodyOrStamp).toBe(false);

  const rows = observeQuery(context);
  compileQueryAst(ast, rows.ctx);
  expect(rows.freshness().bodyOrStamp).toBe(true);

  const latest = observeQuery(context);
  compileLatestAst({ filter: null }, 'orbis/amount', latest.ctx);
  expect(latest.freshness().bodyOrStamp).toBe(true);
});

test('owner midnight uses DST offsets and the owner calendar date', () => {
  expect(nextMidnightInTimeZone('America/New_York', new Date('2026-03-08T05:00:00Z'))).toBe(
    '2026-03-09T04:00:00.000Z',
  );
  expect(nextMidnightInTimeZone('America/New_York', new Date('2026-11-01T04:00:00Z'))).toBe(
    '2026-11-02T05:00:00.000Z',
  );
  expect(nextMidnightInTimeZone('Pacific/Kiritimati', new Date('2026-11-01T12:00:00Z'))).toBe(
    '2026-11-02T10:00:00.000Z',
  );
});
