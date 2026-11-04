import { currentEntry } from '@orbis/shared/nav';
import { onlineManager, type Query, type QueryClient } from '@tanstack/react-query';
import { getQueryKey } from '@trpc/react-query';
import { warmDetailScreen } from '../../app/detail-screen-loader';
import { detailGetInput } from '../../features/entity-detail/detail-input';
import { isUndoEpoch } from '../../features/undo/undo-epoch';
import { useNav } from '../../state/navigation';
import { type RouterInputs, type RouterOutputs, trpc } from '../../trpc';
import { freshnessRuntimeOf } from '../freshness/provenance';
import { createIntentsOf, localCreateTarget } from '../optimistic/create-intent-scope';

export type RecordIntent = 'hover' | 'focus' | 'touch' | 'selection';
export type RecordRead = (
  input: RouterInputs['entity']['get'],
  signal: AbortSignal,
) => Promise<RouterOutputs['entity']['get']>;
type Cancel = () => void;
type Interest = {
  id: string;
  runtime: NonNullable<ReturnType<typeof freshnessRuntimeOf>>;
  owners: Set<symbol>;
  timer?: ReturnType<typeof setTimeout>;
  fetch?: { query: Query; promise: Promise<unknown> };
};

const pending = new WeakMap<QueryClient, Interest>();
const noop = () => {};

function isOpen(id: string): boolean {
  const { model, overlay } = useNav.getState();
  const address = currentEntry(model).address;
  return overlay === null && address.kind === 'record' && address.id === id;
}

function stop(client: QueryClient, interest: Interest): void {
  if (pending.get(client) !== interest) return;
  pending.delete(client);
  clearTimeout(interest.timer);
  const fetch = interest.fetch;
  if (
    !fetch ||
    fetch.query.promise !== fetch.promise ||
    fetch.query.state.fetchStatus === 'idle' ||
    fetch.query.getObserversCount() > 0 ||
    isOpen(interest.id)
  )
    return;
  const invalidated = fetch.query.state.isInvalidated;
  void fetch.query.cancel({ revert: true });
  if (invalidated) fetch.query.invalidate();
}

/** The route owns this work from accepted navigation, before its lazy observer mounts. */
export function claimRecordPrefetch(client: QueryClient, id: string): void {
  const interest = pending.get(client);
  if (!interest || interest.id !== id || !isOpen(id)) return;
  stop(client, interest);
}

export function prefetchRecord(
  client: QueryClient,
  read: RecordRead,
  id: string,
  cause: RecordIntent,
): Cancel {
  const runtime = freshnessRuntimeOf(client);
  if (!runtime || localCreateTarget(createIntentsOf(client), id)) return noop;
  const previous = pending.get(client);
  if (previous && (previous.id !== id || previous.runtime !== runtime)) stop(client, previous);
  const current = pending.get(client);
  const interest = current ?? { id, runtime, owners: new Set<symbol>() };
  const scopeCurrent = () =>
    freshnessRuntimeOf(client) === interest.runtime && isUndoEpoch(interest.runtime.scope.epoch);
  const owner = Symbol();
  interest.owners.add(owner);

  function start() {
    interest.timer = undefined;
    if (
      pending.get(client) !== interest ||
      !scopeCurrent() ||
      localCreateTarget(createIntentsOf(client), id) ||
      document.visibilityState === 'hidden' ||
      !navigator.onLine ||
      !onlineManager.isOnline()
    ) {
      stop(client, interest);
      return;
    }
    warmDetailScreen();

    const input = detailGetInput(id);
    const queryKey = getQueryKey(trpc.entity.get, input, 'query');
    const query = client.getQueryCache().find({ queryKey, exact: true });
    const publication = query && interest.runtime.publicationOf(query.queryHash);
    const staleTime =
      client.getQueryDefaults(queryKey).staleTime ?? client.getDefaultOptions().queries?.staleTime;
    const maxAge = typeof staleTime === 'function' && query ? staleTime(query) : staleTime;
    const fresh =
      query &&
      publication?.source === 'network' &&
      interest.runtime.isAcceptedRead(publication) &&
      publication.receipt.epoch === interest.runtime.scope.epoch &&
      query.state.data !== undefined &&
      !query.state.isInvalidated &&
      (maxAge === 'static' ||
        (typeof maxAge === 'number' && Date.now() - publication.receipt.receivedAt < maxAge));
    if (
      isOpen(id) ||
      fresh ||
      (query && (query.getObserversCount() > 0 || query.state.fetchStatus !== 'idle'))
    ) {
      stop(client, interest);
      return;
    }

    const result = client.fetchQuery({
      queryKey,
      staleTime: 0,
      retry: false,
      networkMode: 'always',
      queryFn: async ({ signal }) => {
        const data = await read(input, signal);
        if (!scopeCurrent()) throw new Error('Предзагрузка потеряла область чтения');
        return data;
      },
    });
    const started = client.getQueryCache().find({ queryKey, exact: true });
    if (started?.promise) interest.fetch = { query: started, promise: started.promise };
    void result.catch(noop).finally(() => {
      if (pending.get(client) === interest) pending.delete(client);
    });
  }

  if (!current) {
    pending.set(client, interest);
    if (cause === 'hover') interest.timer = setTimeout(start, 100);
    else start();
  } else if (cause !== 'hover' && current.timer !== undefined) {
    clearTimeout(current.timer);
    start();
  }

  return () => {
    if (!interest.owners.delete(owner) || interest.owners.size > 0) return;
    stop(client, interest);
  };
}

type Pointer = Pick<PointerEvent, 'pointerId' | 'pointerType' | 'button' | 'clientX' | 'clientY'>;

/** Shared gesture lifetime for React anchors and anchors owned by the editor. */
export function recordLinkGestures(prepare: (id: string, cause: RecordIntent) => Cancel) {
  let hover: Cancel | undefined;
  let focus: Cancel | undefined;
  let touch:
    | {
        pointer: Pick<Pointer, 'pointerId' | 'clientX' | 'clientY'>;
        cancel: Cancel;
        release?: ReturnType<typeof setTimeout>;
      }
    | undefined;

  function leave() {
    hover?.();
    hover = undefined;
  }
  function blur() {
    focus?.();
    focus = undefined;
  }
  function releaseTouch() {
    clearTimeout(touch?.release);
    touch?.cancel();
    touch = undefined;
  }

  return {
    enter(id: string) {
      leave();
      hover = prepare(id, 'hover');
    },
    leave,
    focus(id: string) {
      if (touch) return;
      blur();
      focus = prepare(id, 'focus');
    },
    blur,
    down(id: string, event: Pointer) {
      if (event.pointerType !== 'touch' || event.button !== 0 || touch) return;
      const { pointerId, clientX, clientY } = event;
      touch = {
        pointer: { pointerId, clientX, clientY },
        cancel: prepare(id, 'touch'),
      };
    },
    move(event: Pointer) {
      const start = touch?.pointer;
      if (
        start &&
        start.pointerId === event.pointerId &&
        Math.hypot(event.clientX - start.clientX, event.clientY - start.clientY) > 8
      )
        releaseTouch();
    },
    cancel(event: Pointer) {
      if (touch?.pointer.pointerId === event.pointerId) releaseTouch();
    },
    up(event: Pointer) {
      if (!touch || touch.pointer.pointerId !== event.pointerId) return;
      // Native click follows pointerup, including the delayed click on touch devices.
      clearTimeout(touch.release);
      touch.release = setTimeout(releaseTouch, 350);
    },
    releaseTouch,
    dispose() {
      leave();
      blur();
      releaseTouch();
    },
  };
}
