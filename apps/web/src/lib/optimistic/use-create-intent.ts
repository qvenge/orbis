import { hashKey, type QueryClient, type QueryKey, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import { journalRefOf } from '../../features/undo/journal-ref';
import { isUndoEpoch, undoEpoch } from '../../features/undo/undo-epoch';
import { offerUndoLazy } from '../../features/undo/undo-lazy';
import { startAction } from '../../perf/marks';
import { placeKeyOf, useNav } from '../../state/navigation';
import { trpc } from '../../trpc';
import { useToast } from '../../ui/toast-store';
import { captureCommandScope, freshnessRuntimeOf } from '../freshness/provenance';
import { GRAPH_OFFLINE, graphFailure, graphOnline } from '../graph-command';
import {
  type CreateAttempt,
  type CreateIntent,
  type CreateOutcome,
  type CreateRequest,
  createCreateIntentRegistry,
} from './create-intents';

const local = new WeakMap<
  QueryClient,
  { epoch: number; registry: ReturnType<typeof createCreateIntentRegistry> }
>();

export function createIntentsOf(client: QueryClient) {
  const runtime = freshnessRuntimeOf(client);
  if (runtime) return runtime.createIntents;
  // Isolated mounts without a freshness runtime have no graph identity or feed.
  const epoch = undoEpoch();
  const previous = local.get(client);
  if (previous?.epoch === epoch) return previous.registry;
  const scope = { accountId: '', graphId: '', epoch };
  const registry = createCreateIntentRegistry(scope, () =>
    isUndoEpoch(epoch) && !freshnessRuntimeOf(client) ? scope : undefined,
  );
  local.set(client, { epoch, registry });
  return registry;
}

export function useCreateIntents() {
  const registry = createIntentsOf(useQueryClient());
  const intents = useSyncExternalStore(registry.subscribe, registry.getSnapshot);
  return { registry, intents };
}

function undoTitle(attempt: CreateAttempt) {
  if (attempt.command.input.props?.['orbis/task_status'] === 'planned') return 'Задача добавлена';
  return attempt.command.input.body !== undefined
    ? 'Сохранено во входящие'
    : `Создано: «${attempt.command.input.title}»`;
}

export function useCreateIntent(id: string | null) {
  const registry = createIntentsOf(useQueryClient());
  const snapshot = useCallback(
    () => (id === null ? undefined : registry.lookup(id)),
    [id, registry],
  );
  return useSyncExternalStore(registry.subscribe, snapshot);
}

export function useCreateSurface(name: string, slot = '') {
  const place = useNav((state) => placeKeyOf(state.model));
  return JSON.stringify([name, place, slot]);
}

export function useCreateAwareOpen(openRecord: (id: string) => void) {
  const registry = createIntentsOf(useQueryClient());
  return (id: string) => {
    if (registry.isUnconfirmedCreate(id)) useNav.getState().openPendingCreate(id);
    else openRecord(id);
  };
}

export type CreatePlacement = {
  key: QueryKey;
  ids: readonly string[];
  rawContains?: (raw: unknown, id: string) => boolean;
};

/** The local ACK row hands over only to this surface's actual server answer. */
export function useCreatePlacement(origin: string, placement?: CreatePlacement) {
  const client = useQueryClient();
  const runtime = freshnessRuntimeOf(client);
  const { registry, intents } = useCreateIntents();
  const hash = placement ? hashKey(placement.key) : undefined;
  const subscribe = useCallback(
    (listener: () => void) =>
      hash && runtime ? runtime.subscribePublication(hash, listener) : () => {},
    [hash, runtime],
  );
  const snapshot = useCallback(
    () => (hash && runtime ? runtime.publicationOf(hash) : undefined),
    [hash, runtime],
  );
  const read = useSyncExternalStore(subscribe, snapshot);
  const requested = useRef(new Set<string>());
  useEffect(() => {
    if (!runtime || !placement || !hash) return;
    const needed = new Set<string>();
    for (const view of intents) {
      if (view.origin !== origin || view.status !== 'ack') continue;
      if (
        read?.source === 'network' &&
        runtime.isAcceptedRead(read) &&
        ((placement.ids.includes(view.id) &&
          (placement.rawContains?.(read.raw, view.id) ?? true)) ||
          read.receipt.startedSequence > view.ackSequence)
      ) {
        registry.release(view.id);
        continue;
      }
      const request = JSON.stringify([view.id, hash]);
      needed.add(request);
      if (!requested.current.has(request)) runtime.requestRead(placement.key);
    }
    requested.current = needed;
  }, [hash, intents, origin, placement, read, registry, runtime]);
  return {
    hiddenCanonical: new Set(
      intents
        .filter(
          (view) =>
            view.origin === origin && (view.status === 'pending' || view.status === 'unknown'),
        )
        .map((view) => view.id),
    ),
  };
}

export function useCreateDispatch() {
  const { client } = trpc.useUtils();
  const { show } = useToast();
  const queryClient = useQueryClient();
  const registry = createIntentsOf(queryClient);

  async function send(attempt: CreateAttempt): Promise<CreateIntent | undefined> {
    const epoch = undoEpoch();
    const isCurrent = captureCommandScope(queryClient);
    const mark = startAction('create');
    let outcome: CreateOutcome;
    try {
      outcome = { kind: 'ack', result: await client.entity.create.mutate(attempt.command) };
    } catch (error) {
      outcome = graphFailure(error);
    }
    if (!isUndoEpoch(epoch) || !isCurrent()) return;
    const view = registry.settle(attempt, outcome);
    if (view?.status === 'ack') {
      mark.confirmed();
      const ref = journalRefOf(view.result);
      if (ref) offerUndoLazy({ title: undoTitle(attempt), actionId: ref.actionId, entityIds: [] });
    }
    return view;
  }

  return {
    submit(request: CreateRequest) {
      if (!graphOnline()) {
        show(GRAPH_OFFLINE, 'danger');
        return;
      }
      const attempt = registry.begin(request);
      if (attempt) {
        void send(attempt);
        return attempt.id;
      }
    },
    retry(id: string) {
      if (!graphOnline()) {
        show(GRAPH_OFFLINE, 'danger');
        return;
      }
      const attempt = registry.retry(id);
      if (attempt) return send(attempt);
    },
  };
}

type CaptureDraft = {
  owner: ReturnType<typeof createIntentsOf>;
  formScope: string;
  origin: string;
  text: string;
  intentId?: string;
  recoveryIds: readonly string[];
};

function unknownDraftAt(intents: readonly CreateIntent[], origin: string, text: string) {
  const input = text.trim();
  return intents
    .filter(
      (view) =>
        view.origin === origin && view.status === 'unknown' && (view.body ?? view.title) === input,
    )
    .at(-1);
}

/** Restores submitted input after a remount. ACK consumes only the draft bound to that UUID. */
export function useCreateCapture(origin: string, placement?: CreatePlacement, formScope = origin) {
  const instance = useId();
  const activeOrigin = useRef(origin);
  activeOrigin.current = origin;
  const revision = useRef(0);
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<CaptureDraft>();
  const { registry, intents } = useCreateIntents();
  const { submit, retry } = useCreateDispatch();
  const localDraft =
    draft?.owner === registry && draft.formScope === formScope && registry.isCurrent()
      ? draft
      : undefined;
  const atOrigin = intents.filter((view) => view.origin === origin);
  const rows = atOrigin.filter(
    (view) =>
      view.status !== 'rejected' && (view.status !== 'ack' || !placement?.ids.includes(view.id)),
  );
  const rejected = atOrigin.filter((view) => view.status === 'rejected').at(-1);
  const unresolvedRows = rows.filter(
    (view) => view.status === 'pending' || view.status === 'unknown',
  );
  const tracked = (localDraft?.recoveryIds ?? []).filter(registry.isUnconfirmedCreate);
  const unknownAtOrigin = unresolvedRows.filter((view) => view.status === 'unknown');
  // Recovery can follow the mounted form across dates. Only the selected placement locks submit.
  const unresolved =
    unknownAtOrigin.find((view) => view.id === localDraft?.intentId) ??
    unknownAtOrigin.at(-1) ??
    intents.filter((view) => view.status === 'unknown' && tracked.includes(view.id)).at(-1);

  function track(id: string) {
    return tracked.includes(id) ? tracked : [...tracked, id];
  }
  const retained = atOrigin.filter((view) => view.status !== 'ack').at(-1);
  const text = localDraft?.text ?? retained?.draftText ?? '';

  // Read the settlement before a placement can release its ACK bridge. A retry can also
  // settle from the pending screen while this form stays mounted underneath.
  useEffect(
    () =>
      registry.subscribe(() => {
        const published = registry.getSnapshot();
        const active = registry.isCurrent();
        const displayedAt = activeOrigin.current;
        setDraft((current) => {
          if (current?.owner !== registry) return current;
          if (!active) return undefined;
          if (current.intentId) {
            if (!published.some((view) => view.id === current.intentId && view.status === 'ack'))
              return current;
            return {
              ...current,
              intentId: undefined,
              text: current.origin === displayedAt ? '' : current.text,
            };
          }
          const matching = unknownDraftAt(published, current.origin, current.text);
          return matching ? { ...current, intentId: matching.id } : current;
        });
      }),
    [registry],
  );

  return {
    rows,
    unresolved,
    busyAtOrigin: unresolvedRows.length > 0,
    rejected,
    text,
    canSubmit(title: string, body?: string) {
      return !rows.some(
        (view) =>
          view.status === 'pending' ||
          (view.status === 'unknown' && view.title === title && view.body === body),
      );
    },
    edit(value: string) {
      revision.current++;
      const owner = createIntentsOf(queryClient);
      const matching = unknownDraftAt(owner.getSnapshot(), origin, value);
      setDraft({
        owner,
        formScope,
        origin,
        text: value,
        intentId: matching?.id,
        recoveryIds: owner === registry ? tracked : [],
      });
      if (owner === registry && rejected) registry.release(rejected.id);
    },
    submit(command: CreateRequest['command']) {
      const id = submit({
        origin,
        draftIdentity: `${instance}:${revision.current}`,
        draftText: text,
        command,
      });
      if (!id) return;
      setDraft({ owner: registry, formScope, origin, text, intentId: id, recoveryIds: track(id) });
      if (rejected) registry.release(rejected.id);
      if (!placement) {
        // A standalone capture has no canonical list to take over its last confirmation.
        for (const row of rows)
          if (row.status === 'ack' && useNav.getState().pendingCreate !== row.id)
            registry.release(row.id);
      }
    },
    retry(id: string) {
      const target = registry.lookup(id);
      if (!retry(id)) return;
      const matching = target?.origin === origin && (target.body ?? target.title) === text.trim();
      setDraft({
        owner: registry,
        formScope,
        origin: matching ? origin : (localDraft?.origin ?? origin),
        text,
        intentId: matching ? id : localDraft?.intentId,
        recoveryIds: track(id),
      });
    },
  };
}
