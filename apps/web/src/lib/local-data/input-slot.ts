import type { BodyDoc } from '@orbis/shared/doc';

export type InputScope = Readonly<{
  accountId: string;
  graphId: string;
  generation: string | number;
}>;

export type InputDraftToken = InputScope &
  Readonly<{
    entityId: string;
    /** Unique to an editing stream; a stream never reuses or resets its sequence. */
    writerId: string;
    nonce: string;
    sequence: number;
    basis: { readonly revision: number } | { readonly updatedAt: string };
  }>;

export type InputDraftSnapshot = Readonly<{
  token: InputDraftToken;
  doc: BodyDoc;
  savedAt: string;
  rejected: boolean;
  acknowledged?: true;
}>;

export type InputSlot = {
  key: [graphId: string, entityId: string, writerId: string];
  /** High-water token within this one writer stream, including retired or expired edits. */
  latest: InputDraftToken;
  snapshot?: InputDraftSnapshot;
};

const TTL_MS = 30 * 24 * 60 * 60 * 1000;

export const inputSlotKey = (token: InputDraftToken): InputSlot['key'] => [
  token.graphId,
  token.entityId,
  token.writerId,
];

function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function nonnegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function validInputScope(scope: Record<keyof InputScope, unknown>): boolean {
  return (
    nonempty(scope.accountId) &&
    nonempty(scope.graphId) &&
    (nonempty(scope.generation) || nonnegativeInteger(scope.generation))
  );
}

export function inputTokenMatchesScope(token: InputDraftToken, scope: InputScope): boolean {
  return token.accountId === scope.accountId && token.graphId === scope.graphId;
}

export function validInputToken(value: unknown): value is InputDraftToken {
  const token = object(value);
  if (!token) return false;
  const { accountId, graphId, generation } = token;
  if (!validInputScope({ accountId, graphId, generation })) return false;
  const basis = object(token.basis);
  return (
    nonempty(token.entityId) &&
    nonempty(token.writerId) &&
    nonempty(token.nonce) &&
    nonnegativeInteger(token.sequence) &&
    basis !== undefined &&
    ((nonnegativeInteger(basis.revision) && basis.updatedAt === undefined) ||
      (nonempty(basis.updatedAt) && basis.revision === undefined))
  );
}

function sameLineage(a: InputDraftToken, b: InputDraftToken): boolean {
  return inputTokenMatchesScope(a, b) && a.entityId === b.entityId && a.writerId === b.writerId;
}

export function sameInputToken(a: InputDraftToken, b: InputDraftToken): boolean {
  return (
    sameLineage(a, b) &&
    a.generation === b.generation &&
    a.sequence === b.sequence &&
    a.nonce === b.nonce &&
    ('revision' in a.basis && a.basis.revision !== undefined
      ? 'revision' in b.basis && a.basis.revision === b.basis.revision
      : 'updatedAt' in a.basis && 'updatedAt' in b.basis && a.basis.updatedAt === b.basis.updatedAt)
  );
}

export function validInputSnapshot(value: unknown): value is InputDraftSnapshot {
  const snapshot = object(value);
  if (!snapshot || !validInputToken(snapshot.token)) return false;
  const doc = object(snapshot.doc);
  return (
    doc !== undefined &&
    nonnegativeInteger(doc.v) &&
    object(doc.doc) !== undefined &&
    typeof snapshot.savedAt === 'string' &&
    typeof snapshot.rejected === 'boolean' &&
    (snapshot.acknowledged === undefined || snapshot.acknowledged === true)
  );
}

export function validInputSlot(value: unknown, scope: InputScope): value is InputSlot {
  const row = object(value);
  if (!row || !validInputToken(row.latest) || !inputTokenMatchesScope(row.latest, scope))
    return false;
  const key = row.key;
  if (!Array.isArray(key) || key.length !== 3) return false;
  if (!inputSlotKey(row.latest).every((part, index) => part === key[index])) return false;
  return (
    row.snapshot === undefined ||
    (validInputSnapshot(row.snapshot) &&
      sameLineage(row.snapshot.token, row.latest) &&
      (row.snapshot.token.sequence < row.latest.sequence ||
        sameInputToken(row.snapshot.token, row.latest)))
  );
}

function inputExpired(snapshot: InputDraftSnapshot, now: number): boolean {
  const saved = Date.parse(snapshot.savedAt);
  return Number.isFinite(saved) && now - saved > TTL_MS;
}

export function checkpointInput(
  previous: InputSlot | undefined,
  draft: InputDraftSnapshot,
  now: number,
): InputSlot | undefined {
  const { token } = draft;
  if (inputExpired(draft, now)) return undefined;
  if (!previous) return { key: inputSlotKey(token), latest: token, snapshot: draft };
  if (!sameLineage(previous.latest, token) || token.sequence < previous.latest.sequence)
    return undefined;
  if (token.sequence > previous.latest.sequence) {
    return { key: previous.key, latest: token, snapshot: draft };
  }

  // A repeated checkpoint may record an outcome for the same text, but cannot change its body,
  // extend its TTL or recreate content after it was retired.
  const current = previous.snapshot;
  if (!current || !sameInputToken(current.token, token) || inputExpired(current, now))
    return undefined;
  const rejected = current.rejected || draft.rejected;
  const acknowledged = current.acknowledged || draft.acknowledged;
  if (rejected === current.rejected && acknowledged === current.acknowledged) return previous;
  return { ...previous, snapshot: { ...current, rejected, ...(acknowledged && { acknowledged }) } };
}

export function retireInput(
  previous: InputSlot | undefined,
  token: InputDraftToken,
): InputSlot | undefined {
  if (!previous) return { key: inputSlotKey(token), latest: token };
  if (!sameLineage(previous.latest, token)) return undefined;
  if (previous.snapshot && sameInputToken(previous.snapshot.token, token)) {
    return { key: previous.key, latest: previous.latest };
  }
  if (token.sequence > previous.latest.sequence) {
    // An ACK may precede its checkpoint. Fence that late checkpoint without deleting a
    // different durable copy. The caller owns any separate supersession proof for that copy.
    return { ...previous, latest: token };
  }
  return undefined;
}

export function visibleInput(
  slot: InputSlot | undefined,
  now: number,
): InputDraftSnapshot | undefined {
  const snapshot = slot?.snapshot;
  return snapshot && !inputExpired(snapshot, now) ? snapshot : undefined;
}
