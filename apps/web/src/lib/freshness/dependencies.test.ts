import type { ReadDependencies } from '@orbis/shared';
import { expect, test } from 'vitest';
import { cacheDependencyOf } from './dependencies';

const deps: ReadDependencies = {
  entityIds: ['a'],
  graph: false,
  bodyOrStamp: true,
  threadIds: [],
  registry: true,
  settings: false,
  expiresAt: null,
};
const trpcKey = (path: string, input?: unknown) => [path.split('.'), { input, type: 'query' }];

test('query metadata is consumed intact and an unknown key is distinguishable from explicit none', () => {
  expect(cacheDependencyOf(trpcKey('entity.query'), { rows: [], freshness: deps })).toEqual({
    dependencies: deps,
    persistence: 'response',
    ownerMidnight: false,
  });
  expect(cacheDependencyOf(trpcKey('entity.suggest'))?.dependencies.graph).toBe(false);
  expect(cacheDependencyOf(trpcKey('entity.suggest'))?.persistence).toBe('none');
  expect(cacheDependencyOf(trpcKey('missing.route'))).toBeUndefined();
});

test('ref resolution depends on missing and archived requested targets', () => {
  const rule = cacheDependencyOf(
    trpcKey('entity.resolveRefs', { ids: ['missing', 'archived'] }),
    [],
  );
  expect(rule?.dependencies).toMatchObject({
    entityIds: ['missing', 'archived'],
    registry: true,
    graph: false,
  });
  expect(rule?.persistence).toBe('response');
});

test('custom badges use successful metadata and stay body-dependent before a response', () => {
  const key = ['query-block', 'badge', 'a'];
  expect(cacheDependencyOf(key, { ok: true, kind: 'none', freshness: deps })?.dependencies).toEqual(
    deps,
  );
  expect(cacheDependencyOf(key)?.dependencies).toMatchObject({
    entityIds: ['a'],
    bodyOrStamp: true,
  });
});

test('chat history, export, and pending operations have explicit disk policies', () => {
  expect(cacheDependencyOf(['chatThread', 'thread'])?.persistence).toBe('thread-tail');
  expect(
    cacheDependencyOf(trpcKey('chat.listMessages', { threadId: 'thread', before: 'old' })),
  ).toMatchObject({ persistence: 'none', dependencies: { threadIds: ['thread'] } });
  expect(cacheDependencyOf(trpcKey('user.exportData'))?.persistence).toBe('none');
  expect(cacheDependencyOf(trpcKey('routine.proposal'))?.persistence).toBe('none');
});

test('budget expiry explicitly uses the owner settings deadline, routine uses its server deadline', () => {
  const deadline = '2030-01-02T08:00:00.000Z';
  const money = cacheDependencyOf(trpcKey('budget.envelopeForCategory'), null, deadline);
  expect(money).toMatchObject({
    ownerMidnight: true,
    dependencies: { settings: true, expiresAt: deadline },
  });
  expect(
    cacheDependencyOf(trpcKey('routine.overview'), { nextBucketAt: deadline })?.dependencies
      .expiresAt,
  ).toBe(deadline);
});

test('settings track shell creation and deletion in addition to settings edits', () => {
  const key = trpcKey('user.getSettings');
  for (const graphEstablished of [false, true]) {
    expect(
      cacheDependencyOf(key, {
        graphEstablished,
        nextMidnightAt: '2030-01-02T08:00:00.000Z',
      })?.dependencies,
    ).toMatchObject({
      graph: true,
      settings: true,
      expiresAt: '2030-01-02T08:00:00.000Z',
    });
  }
});
