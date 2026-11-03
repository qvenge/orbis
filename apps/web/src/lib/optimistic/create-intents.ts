import { newId } from '@orbis/shared';
import type { RouterInputs, RouterOutputs } from '../../trpc';
import { nextNetworkOrder, sameFreshnessScope } from '../freshness/provenance';
import type { FreshnessScope } from '../freshness/transport';

type CreateInput = RouterInputs['entity']['create'];
type CreateCommand = Omit<CreateInput, 'input'> & {
  input: CreateInput['input'] & { id: string };
};
type CreateResult = RouterOutputs['entity']['create'];

export type CreateAttempt = Readonly<{ id: string; command: CreateCommand }>;
export type CreateOrigin = Readonly<{
  /** Identifies the explicit placement, such as a capture surface and its day or parent. */
  origin: string;
  /** Identifies the originating form revision for the synchronous submit latch. */
  draftIdentity: string;
}>;
export type CreateRequest = CreateOrigin & {
  draftText?: string;
  command: Omit<CreateInput, 'input'> & { input: Omit<CreateInput['input'], 'id'> };
};
type CreatePreview = CreateOrigin &
  Readonly<{ id: string; title: string; body?: string; draftText: string }>;

export type CreateOutcome =
  | { kind: 'ack'; result: CreateResult }
  | { kind: 'unknown' | 'rejected'; message: string };

export type CreateIntent = CreatePreview &
  Readonly<
    | { status: 'pending' }
    | { status: 'unknown' | 'rejected'; message: string }
    | { status: 'ack'; result: CreateResult; ackSequence: number }
  >;

type Entry = {
  command: CreateCommand;
  view: CreateIntent;
  activeAttempt?: CreateAttempt;
};

const empty: readonly CreateIntent[] = Object.freeze([]);
const unconfirmed = (intent: CreateIntent | undefined) =>
  intent?.status === 'pending' || intent?.status === 'unknown';

function freezeWireValue(value: unknown): void {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return;
  Object.freeze(value);
  for (const member of Object.values(value)) freezeWireValue(member);
}

function wireSnapshot<T>(value: T): T {
  const copy = structuredClone(value);
  // The RPC still accepts its normal DTO type. Freeze its nested wire values at runtime.
  freezeWireValue(copy);
  return copy;
}

/** A scoped registry of explicit create gestures. The caller owns transport and reconciliation. */
export function createCreateIntentRegistry(
  scope: FreshnessScope,
  currentScope: () => FreshnessScope | null | undefined,
) {
  const owner = { ...scope };
  const entries = new Map<string, Entry>();
  const listeners = new Set<() => void>();
  let snapshot = empty;

  function isCurrent() {
    const current = currentScope();
    return current !== null && current !== undefined && sameFreshnessScope(owner, current);
  }

  function publish() {
    snapshot = entries.size ? Object.freeze([...entries.values()].map(({ view }) => view)) : empty;
    for (const listener of listeners) listener();
  }

  function lookup(id: string): CreateIntent | undefined {
    return isCurrent() ? entries.get(id.toLowerCase())?.view : undefined;
  }

  function startAttempt(entry: Entry): CreateAttempt {
    const { id, origin, draftIdentity, title, body, draftText } = entry.view;
    const attempt = Object.freeze({ id, command: entry.command });
    entry.activeAttempt = attempt;
    entry.view = Object.freeze({
      id,
      origin,
      draftIdentity,
      title,
      body,
      draftText,
      status: 'pending',
    });
    publish();
    return attempt;
  }

  return {
    begin(request: CreateRequest): CreateAttempt | undefined {
      if (
        !isCurrent() ||
        snapshot.some(
          (intent) =>
            intent.origin === request.origin &&
            intent.draftIdentity === request.draftIdentity &&
            unconfirmed(intent),
        )
      )
        return;

      const id = newId();
      const { command } = request;
      const payload = wireSnapshot({
        ...command,
        input: { ...command.input, id },
        ...(command.link && {
          link: { ...command.link, parentId: command.link.parentId.toLowerCase() },
        }),
      });
      const entry: Entry = {
        command: payload,
        view: {
          id,
          origin: request.origin,
          draftIdentity: request.draftIdentity,
          title: payload.input.title,
          body: payload.input.body,
          draftText: request.draftText ?? payload.input.body ?? payload.input.title,
          status: 'pending',
        },
      };
      entries.set(id, entry);
      return startAttempt(entry);
    },

    retry(id: string): CreateAttempt | undefined {
      if (!isCurrent()) return;
      const entry = entries.get(id.toLowerCase());
      if (entry?.view.status === 'unknown') return startAttempt(entry);
    },

    settle(attempt: CreateAttempt, outcome: CreateOutcome): CreateIntent | undefined {
      if (!isCurrent()) return;
      const entry = entries.get(attempt.id);
      if (entry?.activeAttempt !== attempt) return;

      const { id, origin, draftIdentity, title, body, draftText } = entry.view;
      const preview = { id, origin, draftIdentity, title, body, draftText };
      let view: CreateIntent;
      if (outcome.kind !== 'ack') {
        view = { ...preview, status: outcome.kind, message: outcome.message };
      } else if (
        outcome.result?.id !== id ||
        (owner.graphId && outcome.result.graphId !== owner.graphId)
      ) {
        view = {
          ...preview,
          status: 'unknown',
          message: 'Не удалось подтвердить сохранение',
        };
      } else {
        view = {
          ...preview,
          status: 'ack',
          result: wireSnapshot(outcome.result),
          ackSequence: nextNetworkOrder(),
        };
      }
      delete entry.activeAttempt;
      entry.view = Object.freeze(view);
      publish();
      return entry.view;
    },

    isCurrent,
    lookup,
    isUnconfirmedCreate: (id: string) => unconfirmed(lookup(id)),
    getSnapshot: () => (isCurrent() ? snapshot : empty),
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    /** Drop a terminal view after its placement or refusal is consumed. */
    release(id: string): boolean {
      const view = lookup(id);
      if (!view || unconfirmed(view)) return false;
      entries.delete(view.id);
      publish();
      return true;
    },

    releaseAction(actionId: string) {
      if (!isCurrent()) return;
      for (const [id, { view }] of entries) {
        if (view.status === 'ack' && view.result.actionId === actionId) {
          entries.delete(id);
          publish();
          return;
        }
      }
    },

    /** For a hard lifecycle reset. A feed reset does not settle or discard create attempts. */
    reset() {
      entries.clear();
      publish();
    },
  };
}
