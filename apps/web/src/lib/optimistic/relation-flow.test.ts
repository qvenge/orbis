import { expect, test } from 'vitest';
import type { ReadPublication } from '../freshness/provenance';
import { createOptimisticStore } from './store';

const scope = { accountId: 'owner', graphId: 'graph', epoch: 1 };
const key = { source_id: 'one', target_id: 'two', role: 'dependency' };
const edge = {
  id: 'server edge',
  sourceId: 'one',
  targetId: 'two',
  role: 'dependency',
  meta: { provenance: 'server' },
  createdAt: '2026-11-03T13:00:00Z',
  updatedAt: '2026-11-03T13:00:00Z',
};
const unrelated = { ...edge, id: 'unrelated', role: 'subitem' };

function detail(id: string, relations: unknown[] | undefined, sequence: number): ReadPublication {
  return {
    scope,
    key: [['entity', 'get'], { input: { id, include: relations ? ['relations'] : [] } }],
    queryHash: id,
    raw: { entity: { id, title: id }, ...(relations && { relations }) },
    source: 'network',
    receipt: {
      epoch: scope.epoch,
      startedSequence: sequence,
      receivedAt: sequence,
      watermark: '0',
    },
  };
}

test('projects the exact added edge at both endpoints, retaining real wire identity on an early read', () => {
  const store = createOptimisticStore(scope);
  const one = detail('one', [unrelated], 1);
  const two = detail('two', [], 1);
  const other = detail('elsewhere', [], 1);
  const bare = detail('one', undefined, 1);
  for (const base of [one, two, other]) store.acceptResponse(base);
  const token = store.beginRelation(scope, 'add', 'create', key, 2);
  const pending = expect.objectContaining({
    sourceId: 'one',
    targetId: 'two',
    role: 'dependency',
  });
  expect(store.projectResponse(one)).toMatchObject({ relations: [unrelated, pending] });
  expect(store.projectResponse(two)).toMatchObject({ relations: [pending] });
  expect(store.projectResponse(other)).toBe(other.raw);
  expect(store.projectResponse(bare)).toBe(bare.raw);

  const early = detail('two', [edge], 3);
  store.acceptResponse(early);
  expect(store.projectResponse(early)).toBe(early.raw);
  expect(
    store.settleOptimistic(token, { kind: 'confirmed', ackSequence: 4, relation: edge }),
  ).toEqual([one.key, two.key]);
  expect(store.projectResponse(one)).toMatchObject({ relations: [unrelated, edge] });

  const current = detail('one', [], 5);
  store.acceptResponse(current);
  expect(store.projectResponse(current)).toBe(current.raw);
});

test('rejection removes only the exact delete layer and does not overwrite a fresh endpoint read', () => {
  const store = createOptimisticStore(scope);
  const one = detail('one', [edge, unrelated], 1);
  const two = detail('two', [edge], 1);
  store.acceptResponse(one);
  store.acceptResponse(two);
  const pending = store.beginRelation(scope, 'remove', 'delete', key, 2);
  expect(store.projectResponse(one)).toMatchObject({ relations: [unrelated] });
  expect(store.projectResponse(two)).toMatchObject({ relations: [] });
  const newer = detail('two', [{ ...edge, sourceId: edge.sourceId, meta: { newer: true } }], 3);
  store.acceptResponse(newer);
  expect(store.projectResponse(newer)).toMatchObject({ relations: [] });
  store.settleOptimistic(pending, { kind: 'failed' });
  expect(store.projectResponse(one)).toBe(one.raw);
  expect(store.projectResponse(newer)).toBe(newer.raw);
});

test('covered relation commands shield older overlapping changes', () => {
  const store = createOptimisticStore(scope);
  const initial = detail('one', [], 1);
  store.acceptResponse(initial);
  const old = store.beginRelation(scope, 'add', 'create', key, 2);
  const later = store.beginRelation(scope, 'remove', 'delete', key, 3);
  store.settleOptimistic(later, { kind: 'confirmed', ackSequence: 4 });
  const current = detail('one', [], 5);
  store.acceptResponse(current);
  expect(store.projectResponse(current)).toBe(current.raw);
  store.settleOptimistic(old, { kind: 'failed' });
  expect(store.projectResponse(current)).toBe(current.raw);
});

test('feed reset preserves relation ordering while hard reset revokes the pending token', () => {
  const store = createOptimisticStore(scope);
  const first = detail('one', [], 1);
  store.acceptResponse(first);
  const earlier = store.beginRelation(scope, 'add', 'create', key, 2);
  const newer = store.beginRelation(scope, 'remove', 'delete', key, 3);
  store.settleOptimistic(newer, { kind: 'confirmed', ackSequence: 4 });
  store.reset(5, true);
  const after = detail('one', [], 6);
  store.acceptResponse(after);
  expect(store.projectResponse(after)).toBe(after.raw);
  expect(store.settleOptimistic(earlier, { kind: 'failed', recheck: true })).toEqual([after.key]);

  const pending = store.beginRelation(scope, 'add again', 'create', key, 7);
  expect(store.projectResponse(after)).toMatchObject({
    relations: [expect.objectContaining({ role: 'dependency' })],
  });
  store.reset(8);
  expect(store.projectResponse(after)).toBe(after.raw);
  expect(
    store.settleOptimistic(pending, { kind: 'confirmed', ackSequence: 9, relation: edge }),
  ).toEqual([]);
});
