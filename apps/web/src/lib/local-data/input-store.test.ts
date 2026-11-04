import { describe, expect, it } from 'vitest';
import {
  checkpointInput,
  type InputDraftSnapshot,
  type InputDraftToken,
  type InputSlot,
  retireInput,
  validInputSlot,
  visibleInput,
  visibleInputs,
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

  it('retains one acknowledged predecessor across a newer checkpoint and its exact cancellation', () => {
    const ack = { ...snapshot(1), acknowledged: true as const };
    const pending = snapshot(2);
    const slot = checkpoint(checkpoint(undefined, ack), pending);
    expect(visibleInputs(slot, now)).toEqual([pending, ack]);
    const cancelled = retireInput(slot, pending.token);
    expect(visibleInputs(cancelled, now)).toEqual([ack]);
    expect(checkpointInput(cancelled, pending, now)).toBeUndefined();
    expect(visibleInputs(checkpoint(cancelled, snapshot(3)), now)).toEqual([snapshot(3), ack]);
  });

  it('accepts repeat outcomes and retires acknowledged insurance by exact token only', () => {
    const ack = { ...snapshot(1, { generation: 'preserved' }), acknowledged: true as const };
    const pending = snapshot(2);
    const slot = checkpoint(checkpoint(undefined, ack), pending);
    expect(checkpointInput(slot, ack, now)).toBe(slot);
    expect(retireInput(slot, { ...ack.token, generation: scope.generation })).toBeUndefined();
    const retired = retireInput(slot, ack.token);
    expect(visibleInputs(retired, now)).toEqual([pending]);
    expect(checkpointInput(retired, ack, now)).toBeUndefined();
  });

  it('bounds acknowledged insurance and expires each exact copy independently', () => {
    const ack = { ...snapshot(1), acknowledged: true as const };
    const pending = { ...snapshot(2), savedAt: '2026-11-04T00:00:00Z' };
    const slot = checkpoint(checkpoint(undefined, ack), pending);
    const afterAckExpiry = now + 30.5 * 86_400_000;
    expect(visibleInputs(slot, afterAckExpiry)).toEqual([pending]);
    expect(visibleInputs(slot, now + 32 * 86_400_000)).toEqual([]);
    const newAck = { ...pending, acknowledged: true as const };
    expect(visibleInputs(checkpoint(slot, newAck), now)).toEqual([newAck]);
  });

  it('rejects malformed or cross-scope acknowledged insurance', () => {
    const ack = { ...snapshot(1), acknowledged: true as const };
    const slot = checkpoint(checkpoint(undefined, ack), snapshot(2));
    expect(validInputSlot(slot, scope)).toBe(true);
    for (const invalid of [
      snapshot(1),
      { ...ack, token: { ...ack.token, accountId: 'foreign' } },
      { ...ack, token: { ...ack.token, graphId: 'foreign' } },
      { ...ack, token: { ...ack.token, writerId: 'foreign' } },
      { ...ack, token: { ...ack.token, sequence: 2 } },
    ])
      expect(validInputSlot({ ...slot, acknowledgedFallback: invalid }, scope)).toBe(false);
  });

  it('records the first ACK of an older submitted request while keeping newer pending input', () => {
    const submitted = snapshot(1);
    const pending = snapshot(2);
    const first = checkpointInput(undefined, submitted, now, true);
    const latest = checkpoint(first, pending);
    const lateAck = { ...submitted, acknowledged: true as const, savedAt: '2026-11-04T00:00:00Z' };
    const updated = checkpoint(latest, lateAck);
    const insurance = { ...lateAck, savedAt: submitted.savedAt };
    expect(visibleInputs(updated, now)).toEqual([pending, insurance]);
    expect(visibleInputs(retireInput(updated, pending.token), now)).toEqual([insurance]);
    expect(visibleInputs(retireInput(updated, submitted.token), now)).toEqual([pending]);
    expect(checkpointInput(latest, lateAck, now + 30.5 * 86_400_000)).toBeUndefined();
  });

  it('does not admit late submissions or ACKs after exact retirement', () => {
    const submitted = snapshot(1);
    const pending = snapshot(2);
    const first = checkpointInput(undefined, submitted, now, true);
    const latest = checkpoint(first, pending);
    const retired = retireInput(latest, submitted.token);
    expect(visibleInputs(retired, now)).toEqual([pending]);
    expect(checkpointInput(retired, submitted, now, true)).toBeUndefined();
    expect(checkpointInput(retired, { ...submitted, acknowledged: true }, now)).toBeUndefined();
    expect(
      checkpointInput(
        latest,
        { ...submitted, acknowledged: true, token: { ...submitted.token, generation: 'other' } },
        now,
      ),
    ).toBeUndefined();
    expect(
      checkpointInput(checkpoint(undefined, pending), { ...submitted, acknowledged: true }, now),
    ).toBeUndefined();
  });

  it('records exact prior submission in the replacing checkpoint when its own write aborted', () => {
    const first = snapshot(1);
    const pending = snapshot(2);
    const hint = { token: first.token, savedAt: '2026-11-04T00:00:00Z' };
    const latest = checkpointInput(checkpoint(undefined, first), pending, now, false, hint);
    expect(latest?.submitted).toEqual({ token: first.token, savedAt: first.savedAt });
    const firstAck = { ...first, acknowledged: true as const };
    expect(visibleInputs(checkpoint(latest, firstAck), now)).toEqual([pending, firstAck]);
  });

  it('ignores carried submission hints after retirement or an unproven higher sequence', () => {
    const first = snapshot(1);
    const pending = snapshot(3);
    const hint = { token: first.token, savedAt: first.savedAt };
    for (const before of [
      retireInput(checkpoint(undefined, first), first.token),
      checkpoint(undefined, snapshot(2)),
    ]) {
      const latest = checkpointInput(before, pending, now, false, hint);
      expect(visibleInputs(latest, now)).toEqual([pending]);
      expect(latest?.submitted).toBeUndefined();
      expect(checkpointInput(latest, { ...first, acknowledged: true }, now)).toBeUndefined();
    }
  });

  it('admits a first carried submission only within its writer lease and original TTL', () => {
    const first = snapshot(1);
    const pending = snapshot(2);
    const hint = { token: first.token, savedAt: first.savedAt };
    expect(checkpointInput(undefined, pending, now, false, hint)?.submitted).toEqual(hint);
    for (const invalid of [
      { ...hint, token: { ...hint.token, generation: 'previous' } },
      { ...hint, token: { ...hint.token, accountId: 'foreign' } },
      { ...hint, token: { ...hint.token, graphId: 'foreign' } },
      { ...hint, token: { ...hint.token, writerId: 'foreign' } },
      { ...hint, token: pending.token },
      { ...hint, savedAt: '2026-10-01T00:00:00Z' },
    ]) {
      const latest = checkpointInput(undefined, pending, now, false, invalid);
      expect(visibleInputs(latest, now)).toEqual([pending]);
      expect(latest?.submitted).toBeUndefined();
    }
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
