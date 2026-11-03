import type { QueryKey } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import type { ReadPublication } from '../freshness/provenance';
import { createOptimisticStore } from './store';

const scope = { accountId: 'owner', graphId: 'graph', epoch: 2 };
const detail = [['entity', 'get'], { input: { id: 'x', include: ['bodyDoc'] }, type: 'query' }];
const list = [['entity', 'query'], { input: { query: 'all' }, type: 'query' }];
const row = { id: 'x', title: 'old', props: { one: 0, two: 0 }, aspects: [], bodyRevision: 5 };
const read = (
  queryHash: string,
  raw: unknown,
  startedSequence: number,
  watermark: string | null = null,
  key: QueryKey = detail,
): ReadPublication => ({
  scope,
  key,
  queryHash,
  raw,
  source: 'network',
  receipt: { epoch: scope.epoch, startedSequence, receivedAt: 1000, watermark },
});

describe('optimistic operation layers', () => {
  it('keeps B above old reads and A failure, then uses the new server base', () => {
    const store = createOptimisticStore(scope);
    const original = read('detail', { entity: row }, 1);
    const second = read('list', { rows: [row] }, 1, null, list);
    store.acceptResponse(original);
    store.acceptResponse(second);
    const a = store.beginOptimistic(scope, 'A', [{ id: 'x', title: 'A', props: { one: 1 } }]);
    const b = store.beginOptimistic(scope, 'B', [{ id: 'x', title: 'B', props: { two: 2 } }]);
    expect(store.projectResponse(second)).toEqual({
      rows: [{ ...row, title: 'B', props: { one: 1, two: 2 } }],
    });
    expect(store.settleOptimistic(b, { kind: 'confirmed', ackSequence: 7 })).toEqual([
      detail,
      list,
    ]);

    const beforeCommit = read('detail', { entity: { ...row, bodyRevision: 6 } }, 6);
    store.acceptResponse(beforeCommit);
    expect(store.projectResponse(beforeCommit)).toEqual({
      entity: { ...row, bodyRevision: 6, title: 'B', props: { one: 1, two: 2 } },
    });

    const afterCommit = read(
      'detail',
      {
        entity: { ...row, bodyRevision: 7, title: 'server B', props: { one: 0, two: 9 } },
      },
      8,
    );
    store.acceptResponse(afterCommit);
    expect(store.projectResponse(afterCommit)).toEqual({
      entity: { ...row, bodyRevision: 7, title: 'server B', props: { one: 1, two: 9 } },
    });
    store.settleOptimistic(a, { kind: 'failed' });
    expect(store.projectResponse(afterCommit)).toBe(afterCommit.raw);
    expect(store.projectResponse(second)).toEqual({
      rows: [{ ...row, title: 'B', props: { one: 0, two: 2 } }],
    });
  });

  it('retains a rebased B as a barrier while an older A still writes the same field', () => {
    const store = createOptimisticStore(scope);
    const original = read('detail', { entity: row }, 1);
    store.acceptResponse(original);
    const a = store.beginOptimistic(scope, 'A', [{ id: 'x', title: 'A', props: { one: 1 } }]);
    const b = store.beginOptimistic(scope, 'B', [{ id: 'x', title: 'B' }]);
    store.settleOptimistic(b, { kind: 'confirmed', ackSequence: 5 });
    const committed = read('detail', { entity: { ...row, title: 'B confirmed' } }, 6);
    store.acceptResponse(committed);
    expect(store.projectResponse(committed)).toEqual({
      entity: { ...row, title: 'B confirmed', props: { one: 1, two: 0 } },
    });
    store.settleOptimistic(a, { kind: 'failed' });
    const undone = read('detail', { entity: { ...row, title: 'B undone' } }, 7);
    store.acceptResponse(undone);
    expect(store.projectResponse(undone)).toBe(undone.raw);
  });

  it('does not request a ref refresh for a field that the ref never returned', () => {
    const store = createOptimisticStore(scope);
    const refs = [['entity', 'resolveRefs'], { input: { ids: ['x'] } }];
    store.watchResponse('refs', refs);
    const token = store.beginOptimistic(scope, 'A', [{ id: 'x', props: { one: 1 } }]);
    expect(store.settleOptimistic(token, { kind: 'confirmed', ackSequence: 7 })).toEqual([]);
    const original = read('detail', { entity: row }, 6);
    store.acceptResponse(original);
    expect(store.projectResponse(original)).toBe(original.raw);
  });

  it('requires strict xid coverage or a read started after ACK, never a disk or unaccepted response', () => {
    const store = createOptimisticStore(scope);
    const disk: ReadPublication = {
      scope,
      key: detail,
      queryHash: 'detail',
      raw: { entity: row },
      source: 'disk',
      receivedAt: 9999,
    };
    store.acceptResponse(disk);
    const token = store.beginOptimistic(scope, 'A', [{ id: 'x', title: 'A' }]);
    store.settleOptimistic(token, {
      kind: 'confirmed',
      txId: '18446744073709551614',
      ackSequence: 7,
    });
    expect(store.projectResponse(disk)).toEqual({ entity: { ...row, title: 'A' } });
    const equal = read('detail', disk.raw, 6, '18446744073709551614');
    store.acceptResponse(equal);
    expect(store.projectResponse(equal)).toEqual({ entity: { ...row, title: 'A' } });
    const greater = read(
      'detail',
      { entity: { ...row, title: 'server A' } },
      6,
      '18446744073709551615',
    );
    expect(store.projectResponse(greater)).toEqual({ entity: { ...row, title: 'A' } });
    store.acceptResponse(greater, false);
    expect(store.projectResponse(greater)).toEqual({ entity: { ...row, title: 'A' } });
    store.acceptResponse(greater);
    expect(store.projectResponse(greater)).toBe(greater.raw);
  });

  it('covers a first read already in flight and frees the layer when its response is collected', () => {
    const store = createOptimisticStore(scope);
    store.watchResponse('detail', detail);
    const a = store.beginOptimistic(scope, 'A', [{ id: 'x', title: 'A' }]);
    expect(store.settleOptimistic(a, { kind: 'confirmed', ackSequence: 7 })).toEqual([detail]);
    const old = read('detail', { entity: row }, 4);
    store.acceptResponse(old);
    expect(store.projectResponse(old)).toEqual({ entity: { ...row, title: 'A' } });
    store.forgetResponse('detail');
    expect(store.projectResponse(old)).toBe(old.raw);
  });

  it('supports repeated IDs in a batch and isolates failure, unknown outcome, epoch and reset', () => {
    const store = createOptimisticStore(scope);
    const original = read('detail', { entity: row }, 1);
    store.acceptResponse(original);
    const b = store.beginOptimistic(scope, 'batch', [
      { id: 'x', props: { one: 1 }, title: 'first' },
      { id: 'x', unset: ['one'], title: 'last' },
    ]);
    expect(
      store.beginOptimistic(scope, 'batch', [{ id: 'x', title: 'duplicate' }]),
    ).toBeUndefined();
    expect(
      store.beginOptimistic({ ...scope, graphId: 'other' }, 'new', [{ id: 'x', title: 'foreign' }]),
    ).toBeUndefined();
    expect(store.projectResponse(original)).toEqual({
      entity: { ...row, title: 'last', props: { two: 0 } },
    });
    store.settleOptimistic(b, { kind: 'unknown' });
    expect(store.projectResponse(original)).toBe(original.raw);
    const a = store.beginOptimistic(scope, 'A', [{ id: 'x', title: 'pre-reset' }]);
    store.reset();
    store.acceptResponse(original);
    const afterReset = store.beginOptimistic(scope, 'A', [{ id: 'x', title: 'post-reset' }]);
    store.settleOptimistic(a, { kind: 'failed' });
    expect(store.projectResponse(original)).toEqual({ entity: { ...row, title: 'post-reset' } });
    const foreign = { ...original, scope: { ...scope, accountId: 'other' } };
    expect(store.projectResponse(foreign)).toBe(original.raw);
    store.settleOptimistic(afterReset, { kind: 'failed' });
    expect(store.projectResponse(original)).toBe(original.raw);
  });

  it('does not let a network read from before the reset become live card evidence', () => {
    const store = createOptimisticStore(scope);
    const card = { entityId: 'x', title: 'history', aspects: [], keyFields: {} };
    store.acceptResponse(read('detail', { entity: row }, 5));
    expect(store.projectCard(card).title).toBe('old');
    store.reset(6);
    store.acceptResponse(read('detail', { entity: row }, 6));
    expect(store.projectCard(card)).toBe(card);
    store.acceptResponse(read('detail', { entity: row }, 7));
    expect(store.projectCard(card).title).toBe('old');
  });

  it('keeps accepted live card fields while a stale read is waiting for reconciliation', () => {
    const store = createOptimisticStore(scope);
    const card = { entityId: 'x', title: 'history', aspects: [], keyFields: {} };
    store.acceptResponse(read('detail', { entity: row }, 5));
    store.acceptResponse(read('detail', { entity: { ...row, title: 'stale' } }, 6), false);
    expect(store.projectCard(card).title).toBe('old');
    store.forgetResponse('detail');
    expect(store.projectCard(card)).toBe(card);
  });

  it('captures the operation before callers can edit the input again', () => {
    const store = createOptimisticStore(scope);
    const original = read('detail', { entity: row }, 1);
    store.acceptResponse(original);
    const edit = { title: 'first', props: { one: { items: ['first'] } }, id: 'x' };
    store.beginOptimistic(scope, 'A', [edit]);
    edit.title = 'second';
    edit.props.one.items[0] = 'second';
    expect(store.projectResponse(original)).toEqual({
      entity: { ...row, title: 'first', props: { one: { items: ['first'] }, two: 0 } },
    });
  });

  it('uses accepted entity evidence for a live card without using chat history as a refresh barrier', () => {
    const store = createOptimisticStore(scope);
    const card = {
      kind: 'entity_card' as const,
      entityId: 'x',
      title: 'historic',
      aspects: ['a'],
      keyFields: { one: -1, absent: -1 },
      undoActionId: 'action',
    };
    const thread = read(
      'thread',
      { pages: [[{ content: 'historic', metadata: { cards: [card] } }]] },
      1,
      null,
      ['chatThread', 'thread'],
    );
    const original = read('detail', { entity: row }, 1);
    store.acceptResponse(thread);
    store.acceptResponse(original);
    const observed: string[] = [];
    const unsubscribe = store.subscribeCard('x', () =>
      observed.push(store.projectCard(card).title),
    );
    const token = store.beginOptimistic(scope, 'A', [
      { id: 'x', title: 'typing', props: { one: 3 } },
    ]);
    expect(store.projectCard(card)).toEqual({
      ...card,
      title: 'typing',
      aspects: [],
      keyFields: { one: 3 },
    });
    expect(store.projectCard(card, true)).toBe(card);
    expect(store.projectResponse(thread)).toBe(thread.raw);
    expect(store.settleOptimistic(token, { kind: 'confirmed', ackSequence: 7 })).toEqual([detail]);
    store.acceptResponse(
      read('detail', { entity: { ...row, title: 'canonical', props: { one: 4 } } }, 8),
    );
    expect(store.projectCard(card)).toEqual({
      ...card,
      title: 'canonical',
      aspects: [],
      keyFields: { one: 4 },
    });
    store.forgetResponse('detail');
    expect(store.projectCard(card)).toBe(card);
    expect(observed).toContain('typing');
    expect(observed).toContain('canonical');
    unsubscribe();
  });
});
