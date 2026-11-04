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
  recovery?: true;
}>;

export type InputSubmission = Pick<InputDraftSnapshot, 'token' | 'savedAt'>;

export type InputSlot = {
  key: [graphId: string, entityId: string, writerId: string];
  /** High-water token within this one writer stream, including retired or expired edits. */
  latest: InputDraftToken;
  snapshot?: InputDraftSnapshot;
  /** One confirmed safety copy retained while newer, unconfirmed input is checkpointed. */
  acknowledgedFallback?: InputDraftSnapshot;
  /** Exact request provenance for admitting its first ACK after a newer local checkpoint. */
  submitted?: InputSubmission;
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
    (snapshot.acknowledged === undefined || snapshot.acknowledged === true) &&
    (snapshot.recovery === undefined || snapshot.recovery === true)
  );
}

export function validInputSlot(value: unknown, scope: InputScope): value is InputSlot {
  const row = object(value);
  if (!row || !validInputToken(row.latest) || !inputTokenMatchesScope(row.latest, scope))
    return false;
  const key = row.key;
  if (!Array.isArray(key) || key.length !== 3) return false;
  if (!inputSlotKey(row.latest).every((part, index) => part === key[index])) return false;
  const { snapshot, acknowledgedFallback, latest } = row;
  if (
    snapshot !== undefined &&
    (!validInputSnapshot(snapshot) ||
      !sameLineage(snapshot.token, latest) ||
      (snapshot.token.sequence >= latest.sequence && !sameInputToken(snapshot.token, latest)))
  )
    return false;
  const submitted = object(row.submitted);
  if (
    row.submitted !== undefined &&
    (!submitted ||
      typeof submitted.savedAt !== 'string' ||
      !validInputToken(submitted.token) ||
      !sameLineage(submitted.token, latest) ||
      (submitted.token.sequence >= latest.sequence && !sameInputToken(submitted.token, latest)))
  )
    return false;
  return (
    acknowledgedFallback === undefined ||
    (validInputSnapshot(acknowledgedFallback) &&
      acknowledgedFallback.acknowledged === true &&
      sameLineage(acknowledgedFallback.token, latest) &&
      acknowledgedFallback.token.sequence < (snapshot?.token.sequence ?? latest.sequence) &&
      snapshot?.acknowledged !== true)
  );
}

export function inputExpired(snapshot: Pick<InputDraftSnapshot, 'savedAt'>, now: number): boolean {
  const saved = Date.parse(snapshot.savedAt);
  return Number.isFinite(saved) && now - saved > TTL_MS;
}

function carriedSubmission(
  previous: InputSlot | undefined,
  next: InputDraftToken,
  hint: InputSubmission | undefined,
  now: number,
): InputSubmission | undefined {
  const recorded = previous?.submitted;
  if (
    !hint ||
    !validInputToken(hint.token) ||
    typeof hint.savedAt !== 'string' ||
    !sameLineage(hint.token, next) ||
    hint.token.generation !== next.generation ||
    hint.token.sequence >= next.sequence ||
    (recorded && recorded.token.sequence >= hint.token.sequence)
  )
    return recorded;
  const current = previous?.snapshot;
  const exact = current && !current.acknowledged && sameInputToken(current.token, hint.token);
  // A later row or an exact tombstone cannot grant fresh authority to this request.
  if (previous && previous.latest.sequence >= hint.token.sequence && !exact) return recorded;
  const submission = exact ? { token: hint.token, savedAt: current.savedAt } : hint;
  return inputExpired(submission, now) ? recorded : submission;
}

export function checkpointInput(
  previous: InputSlot | undefined,
  draft: InputDraftSnapshot,
  now: number,
  recordSubmission = false,
  priorSubmission?: InputSubmission,
): InputSlot | undefined {
  const { token } = draft;
  if (inputExpired(draft, now)) return undefined;
  const submission =
    recordSubmission && !draft.acknowledged ? { token, savedAt: draft.savedAt } : undefined;
  if (previous && !sameLineage(previous.latest, token)) return undefined;
  if (!previous || token.sequence > previous.latest.sequence) {
    const { snapshot, acknowledgedFallback } = previous ?? {};
    const fallback = snapshot?.acknowledged ? snapshot : acknowledgedFallback;
    return {
      key: previous?.key ?? inputSlotKey(token),
      latest: token,
      snapshot: draft,
      submitted: draft.acknowledged
        ? undefined
        : (submission ?? carriedSubmission(previous, token, priorSubmission, now)),
      acknowledgedFallback:
        !draft.acknowledged && fallback && !inputExpired(fallback, now) ? fallback : undefined,
    };
  }

  // A repeated checkpoint may record an outcome for the same text, but cannot change its body,
  // extend its TTL or recreate content after it was retired.
  const fallback = previous.acknowledgedFallback;
  if (fallback && sameInputToken(fallback.token, token))
    return inputExpired(fallback, now) ? undefined : previous;
  const current = previous.snapshot;
  const recorded = previous.submitted;
  const exactSubmission = !!recorded && sameInputToken(recorded.token, token);
  if (!current || !sameInputToken(current.token, token)) {
    // The submitted text may have been replaced on disk while its request was in
    // flight. Only that exact recorded submission can create older ACK insurance.
    if (
      !draft.acknowledged ||
      !exactSubmission ||
      (current?.acknowledged && current.token.sequence >= token.sequence) ||
      (fallback && fallback.token.sequence >= token.sequence)
    )
      return undefined;
    const acknowledged = { ...draft, savedAt: recorded.savedAt };
    if (inputExpired(acknowledged, now)) return undefined;
    return current && current.token.sequence > token.sequence
      ? { ...previous, acknowledgedFallback: acknowledged, submitted: undefined }
      : {
          ...previous,
          snapshot: acknowledged,
          acknowledgedFallback: undefined,
          submitted: undefined,
        };
  }
  if (
    inputExpired(current, now) ||
    (token.sequence < previous.latest.sequence && !current.acknowledged && !draft.acknowledged)
  )
    return undefined;
  const rejected = current.rejected || draft.rejected;
  const acknowledged = current.acknowledged || draft.acknowledged;
  const recovery = current.recovery || draft.recovery;
  const submitted =
    exactSubmission && acknowledged
      ? undefined
      : submission && !acknowledged && !exactSubmission
        ? { ...submission, savedAt: current.savedAt }
        : recorded;
  if (
    rejected === current.rejected &&
    acknowledged === current.acknowledged &&
    recovery === current.recovery &&
    submitted === recorded
  )
    return previous;
  return {
    ...previous,
    acknowledgedFallback: acknowledged ? undefined : fallback,
    submitted,
    snapshot: {
      ...current,
      rejected,
      ...(acknowledged && { acknowledged }),
      ...(recovery && { recovery }),
    },
  };
}

export function retireInput(
  previous: InputSlot | undefined,
  token: InputDraftToken,
): InputSlot | undefined {
  if (!previous) return { key: inputSlotKey(token), latest: token };
  if (!sameLineage(previous.latest, token)) return undefined;
  const submitted =
    previous.submitted && sameInputToken(previous.submitted.token, token)
      ? undefined
      : previous.submitted;
  if (previous.snapshot && sameInputToken(previous.snapshot.token, token)) {
    return { ...previous, snapshot: undefined, submitted };
  }
  const fallback = previous.acknowledgedFallback;
  if (fallback && sameInputToken(fallback.token, token))
    return { ...previous, acknowledgedFallback: undefined, submitted };
  if (token.sequence > previous.latest.sequence) {
    // An ACK may precede its checkpoint. Fence that late checkpoint without deleting a
    // different durable copy. The caller owns any separate supersession proof for that copy.
    return { ...previous, latest: token };
  }
  if (submitted !== previous.submitted) return { ...previous, submitted };
  return undefined;
}

export function visibleInput(
  slot: InputSlot | undefined,
  now: number,
): InputDraftSnapshot | undefined {
  return visibleInputs(slot, now)[0];
}

export function visibleInputs(slot: InputSlot | undefined, now: number): InputDraftSnapshot[] {
  return [slot?.snapshot, slot?.acknowledgedFallback].filter(
    (snapshot): snapshot is InputDraftSnapshot => !!snapshot && !inputExpired(snapshot, now),
  );
}
