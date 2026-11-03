import { describe, expect, it } from 'vitest';
import {
  checkpointInput,
  type InputDraftSnapshot,
  type InputDraftToken,
  type InputSlot,
  retireInput,
  visibleInput,
} from './input-slot';
import { openInputStore } from './input-store';

const now = Date.parse('2026-11-03T00:00:00Z');
const scope = { accountId: 'account', graphId: 'graph', generation: 'lease' };
const snapshot = (
  sequence: number,
  overrides: Partial<InputDraftToken> = {},
): InputDraftSnapshot => ({
  token: {
    ...scope,
    entityId: 'entity',
    writerId: 'writer',
    nonce: `draft-${sequence}`,
    sequence,
    basis: { revision: 3 },
    ...overrides,
  },
  savedAt: '2026-11-03T00:00:00Z',
  doc: { v: 3, doc: { type: 'doc', content: [{ type: 'paragraph' }] } },
  rejected: false,
});

function checkpoint(slot: InputSlot | undefined, draft: InputDraftSnapshot): InputSlot {
  const update = checkpointInput(slot, draft, now);
  if (update === undefined) throw new Error('Expected a checkpoint');
  return update;
}

describe('exact input slots', () => {
  it('rejects a late checkpoint from before a newer edit', () => {
    const newer = snapshot(2);
    const slot = checkpoint(undefined, newer);
    expect(checkpointInput(slot, snapshot(1), now)).toBeUndefined();
    expect(visibleInput(slot, now)).toEqual(newer);
  });

  it('keeps newer text when an older ACK arrives with the same document', () => {
    const newer = snapshot(2);
    const slot = checkpoint(undefined, newer);
    expect(retireInput(slot, snapshot(1).token)).toBeUndefined();
    expect(visibleInput(slot, now)).toEqual(newer);
  });

  it('requires exact nonce, generation and basis even at the same sequence', () => {
    const draft = snapshot(2);
    const slot = checkpoint(undefined, draft);
    for (const token of [
      snapshot(2, { nonce: 'another' }).token,
      snapshot(2, { generation: 'another' }).token,
      snapshot(2, { basis: { revision: 4 } }).token,
    ]) {
      expect(retireInput(slot, token)).toBeUndefined();
      expect(checkpointInput(slot, { ...draft, token }, now)).toBeUndefined();
    }
    expect(visibleInput(slot, now)).toEqual(draft);
  });

  it('keeps the exact ACK tombstone when no checkpoint has reached disk yet', () => {
    const draft = snapshot(3);
    const retired = retireInput(undefined, draft.token);
    expect(retired).toBeDefined();
    expect(checkpointInput(retired, draft, now)).toBeUndefined();
    expect(visibleInput(retired, now)).toBeUndefined();
  });

  it('does not delete a different durable token when retiring an uncheckpointed edit', () => {
    const earlier = snapshot(1);
    const later = snapshot(2);
    const retired = retireInput(checkpoint(undefined, earlier), later.token);
    expect(visibleInput(retired, now)).toEqual(earlier);
    expect(checkpointInput(retired, later, now)).toBeUndefined();
  });

  it('retiring the current token removes its content and blocks a later identical put', () => {
    const draft = snapshot(1);
    const retired = retireInput(checkpoint(undefined, draft), draft.token);
    expect(retired?.snapshot).toBeUndefined();
    expect(checkpointInput(retired, draft, now)).toBeUndefined();
    expect(visibleInput(retired, now)).toBeUndefined();
  });

  it('expires individual snapshots without using an unreadable legacy date to judge the text', () => {
    const old = { ...snapshot(1), savedAt: '2026-10-01T00:00:00Z' };
    const unparseable = { ...snapshot(1), savedAt: 'old-form' };
    expect(checkpointInput(undefined, old, now)).toBeUndefined();
    const slot = checkpoint(undefined, unparseable);
    expect(visibleInput(slot, now + 40 * 86_400_000)).toEqual(unparseable);
    const fresh = checkpoint(undefined, snapshot(1));
    expect(visibleInput(fresh, now + 31 * 86_400_000)).toBeUndefined();
  });

  it('keeps an incompatible but readable draft and its terminal rejection state', () => {
    const draft = { ...snapshot(1, { basis: { updatedAt: 'old-stamp' } }), rejected: true };
    draft.doc = { ...draft.doc, v: 70 };
    expect(visibleInput(checkpoint(undefined, draft), now)).toEqual(draft);
  });
});

it('keeps disabled storage distinguishable from an empty input database', async () => {
  const store = openInputStore(scope, { enabled: false, isCurrent: () => true });
  expect(await store.persistDraft(snapshot(1))).toBeUndefined();
  expect(await store.removeDraftIfMatch(snapshot(1).token)).toBeUndefined();
  expect(await store.list()).toBeUndefined();
  expect(await store.count()).toBeUndefined();
  store.close();
});

it('fails closed if the caller cannot verify its input lease', async () => {
  const store = openInputStore(scope, {
    isCurrent: () => {
      throw new Error('Device storage is unavailable');
    },
  });
  expect(await store.persistDraft(snapshot(1))).toBeUndefined();
  expect(await store.list()).toBeUndefined();
  store.close();
});

it('records exact rejection and ACK outcomes without replacing text or extending its TTL', () => {
  const original = snapshot(1);
  const slot = checkpoint(undefined, original);
  const result = checkpoint(slot, {
    ...original,
    savedAt: '2026-11-04T00:00:00Z',
    doc: { ...original.doc, v: 70 },
    rejected: true,
    acknowledged: true,
  });
  expect(visibleInput(result, now)).toEqual({
    ...original,
    rejected: true,
    acknowledged: true,
  });
  expect(visibleInput(checkpoint(result, original), now)).toEqual(visibleInput(result, now));
});
