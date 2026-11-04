import type { AppRouter } from '@orbis/server/src/router';
import { CLIENT_VERSION_HEADER, changeXidInput, READ_WATERMARK_HEADER } from '@orbis/shared';
import {
  type DefaultOptions,
  MutationCache,
  onlineManager,
  QueryClient,
} from '@tanstack/react-query';
import {
  createTRPCClient,
  httpBatchLink,
  httpLink,
  httpSubscriptionLink,
  splitLink,
  TRPCClientError,
  type TRPCLink,
} from '@trpc/client';
import { createTRPCReact } from '@trpc/react-query';
import type { inferRouterInputs, inferRouterOutputs } from '@trpc/server';
import { observable } from '@trpc/server/observable';
import { EventSource } from 'eventsource';
import { APP_VERSION } from './app/version';
import { emitClientOutdated, emitUnauthorized } from './auth/events';
import { makeBodyQueryCache } from './features/undo/body-provenance';
import { journalRefOf } from './features/undo/journal-ref';
import { currentMutationEpoch, guardMutationEpoch } from './features/undo/mutation-epoch';
import { isUndoEpoch, undoEpoch } from './features/undo/undo-epoch';
import { pushUndoable } from './features/undo/undo-stack';
import {
  freshnessRuntimeOf,
  type NetworkReadReceipt,
  nextNetworkOrder,
  recordNetworkReadReceipt,
  recordReadErrorReceipt,
} from './lib/freshness/provenance';
import { responseQueryOptions } from './lib/local-data/query-responses';

export {
  inheritNetworkReadReceipt,
  type NetworkReadReceipt,
  networkReadReceiptOf,
  nextNetworkOrder,
} from './lib/freshness/provenance';

export const trpc = createTRPCReact<AppRouter>();

export type RouterInputs = inferRouterInputs<AppRouter>;
export type RouterOutputs = inferRouterOutputs<AppRouter>;

export function makeQueryClient(queries?: DefaultOptions['queries']): QueryClient {
  const mutationCache = new MutationCache({
    onSuccess: (data, _vars, _context, mutation) => {
      if (!currentMutationEpoch(mutation) || mutation.meta?.undoStack !== undefined) return;
      const ref = journalRefOf(data);
      if (ref) pushUndoable({ actionId: ref.actionId, title: 'действие' });
    },
  });
  guardMutationEpoch(mutationCache);
  const client: QueryClient = new QueryClient({
    mutationCache,
    queryCache: makeBodyQueryCache(() => client),
    defaultOptions: {
      queries: {
        retry: false,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
        staleTime: 30_000,
        ...queries,
      },
      mutations: { retry: false, networkMode: 'always' },
    },
  });
  return client;
}
class NetworkTransportError extends Error {}

async function fetchWithNetworkStatus(url: RequestInfo | URL, init?: RequestInit) {
  if (navigator.onLine === false) throw new NetworkTransportError('Нет сети');
  try {
    return await fetch(url, init);
  } catch (error) {
    if (error instanceof TypeError)
      throw new NetworkTransportError('Сервер недоступен', { cause: error });
    throw error;
  }
}

function retryNetworkRead(failureCount: number, error: unknown): boolean {
  let cause = error;
  while (cause instanceof Error) {
    if (cause instanceof TRPCClientError && (cause.data || cause.meta?.response)) return false;
    if (cause instanceof NetworkTransportError)
      return !onlineManager.isOnline() || failureCount < 3;
    cause = cause.cause;
  }
  return false;
}

export const queryClient = makeQueryClient({ ...responseQueryOptions, retry: retryNetworkRead });

type ProductTransportLease = { signal: AbortSignal; isCurrent(): boolean };
let readProductLease: (() => ProductTransportLease | undefined) | undefined;

export function configureProductTransport(read?: () => ProductTransportLease | undefined): void {
  readProductLease = read;
}

const leaseCurrent = (lease: ProductTransportLease | undefined) =>
  readProductLease === undefined || !!lease?.isCurrent();

function productToken(getToken: () => string | null) {
  const token = getToken();
  if (readProductLease && !token) throw new NetworkTransportError('Сеанс доступен только из кеша');
  return token;
}

function scopedSignal(lease: ProductTransportLease | undefined, signal?: AbortSignal | null) {
  if (!lease) return signal;
  return signal ? AbortSignal.any([lease.signal, signal]) : lease.signal;
}

export function trpcHeaders(getToken: () => string | null): Record<string, string> {
  const token = getToken();
  return {
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    [CLIENT_VERSION_HEADER]: APP_VERSION,
  };
}

const networkReadReceiptLink: TRPCLink<AppRouter> =
  () =>
  ({ op, next }) =>
    observable((observer) => {
      const epoch = undoEpoch();
      const lease = readProductLease?.();
      if (!leaseCurrent(lease)) {
        observer.error(TRPCClientError.from(new Error('Сессия изменилась')));
        return;
      }
      const read = op.type === 'query' || (op.type === 'mutation' && op.path === 'entity.blocks');
      const startedSequence = nextNetworkOrder();
      const startedAt = Date.now();
      return next(op).subscribe({
        next(value) {
          if (!isUndoEpoch(epoch) || !leaseCurrent(lease)) {
            observer.error(TRPCClientError.from(new Error('Сессия изменилась')));
            return;
          }
          const response = value.context?.response;
          if (read && response instanceof Response && 'data' in value.result) {
            const watermark = changeXidInput.safeParse(response.headers.get(READ_WATERMARK_HEADER));
            const receipt: NetworkReadReceipt = {
              epoch,
              watermark: watermark.success ? watermark.data : null,
              receivedAt: Date.now(),
              startedAt,
              startedSequence,
            };
            const raw = value.result.data;
            recordNetworkReadReceipt(raw, receipt);
            if (typeof op.context.onNetworkReadReceipt === 'function') {
              op.context.onNetworkReadReceipt(receipt, raw);
            }
          }
          observer.next(value);
        },
        error: (error) => {
          if (read && isUndoEpoch(epoch) && leaseCurrent(lease))
            recordReadErrorReceipt(error, { epoch, startedSequence });
          observer.error(error);
        },
        complete: () => observer.complete(),
      });
    });

// Includes direct vanilla writes and rejected/uncertain outcomes. These procedures
// use POST without being graph commands.
const readPosts = new Set(['entity.blocks', 'import.analyze', 'import.review', 'perf.report']);

const graphMutationLink: TRPCLink<AppRouter> =
  () =>
  ({ op, next }) =>
    observable((observer) => {
      const active = freshnessRuntimeOf(queryClient);
      const isWrite =
        op.type === 'mutation' && !readPosts.has(op.path) && !op.path.startsWith('oauth.');
      let notified = false;
      const settled = () => {
        if (notified) return;
        notified = true;
        if (isWrite && active === freshnessRuntimeOf(queryClient)) active?.mutationSettled();
      };
      return next(op).subscribe({
        next: (value) => {
          // Unary callers unsubscribe from the observable on next.
          settled();
          observer.next(value);
        },
        complete: () => observer.complete(),
        error: (error) => {
          settled();
          observer.error(error);
        },
      });
    });

export type FreshnessStreamRequest = {
  token: string;
  beforeFetch: () => string;
};

export function trpcErrorCode(error: unknown): string | undefined {
  if (!(error instanceof TRPCClientError)) return undefined;
  const cause = error.cause;
  const status = cause && 'code' in cause ? cause.code : undefined;
  return (
    error.data?.code ??
    (status === 401 ? 'UNAUTHORIZED' : status === 412 ? 'PRECONDITION_FAILED' : undefined)
  );
}

// Линк-перехватчик: ключуется на КОД ошибки (cause по HTTP не сериализуется).
// PRECONDITION_FAILED → CLIENT_OUTDATED (412), UNAUTHORIZED → login (401).
export function authErrorLink(handlers: {
  onOutdated: () => void;
  onUnauthorized: () => void;
}): TRPCLink<AppRouter> {
  return () =>
    ({ op, next }) =>
      observable((observer) => {
        const epoch = undoEpoch();
        const lease = readProductLease?.();
        return next(op).subscribe({
          next: (v) => observer.next(v),
          complete: () => observer.complete(),
          error: (err) => {
            const freshness = op.type === 'subscription' || op.path === 'changes.reconcile';
            const code = freshness
              ? trpcErrorCode(err)
              : err instanceof TRPCClientError
                ? err.data?.code
                : undefined;
            if (code === 'PRECONDITION_FAILED' && isUndoEpoch(epoch) && leaseCurrent(lease))
              handlers.onOutdated();
            else if (
              code === 'UNAUTHORIZED' &&
              !freshness &&
              isUndoEpoch(epoch) &&
              leaseCurrent(lease)
            )
              handlers.onUnauthorized();
            observer.error(err);
          },
        });
      });
}

// URL tRPC: по умолчанию относительный `/trpc` (Вариант A — same-origin, сервер сам
// раздаёт web-dist, CORS не нужен). VITE_API_URL — опц. fallback для режима B (раздельные
// origins): если задан, префиксует абсолютным base; пусто/не задан → прежнее поведение.
export const API_BASE = import.meta.env.VITE_API_URL ?? '';
export const TRPC_URL = `${API_BASE}/trpc`;
// Тот же адрес, но абсолютным и целиком — его владелец копирует в команду подключения
// агента (раздел «Агенты»). Пусто → same-origin: на проде это публичный адрес сервиса,
// локально — стенд vite (прокси `/mcp` в vite.config.ts). Правда об адресе API одна
// на оба URL: своё чтение VITE_API_URL в экране развело бы их при переходе в режим B.
export const MCP_URL = `${API_BASE || window.location.origin}/mcp`;

export function orbisLinks(getToken: () => string | null): TRPCLink<AppRouter>[] {
  const scopedHttp: TRPCLink<AppRouter> = (runtime) => {
    let activeEpoch: number | undefined;
    let batch: ReturnType<TRPCLink<AppRouter>> | undefined;
    return (operation) => {
      const epoch = undoEpoch();
      const lease = readProductLease?.();
      const speculative =
        operation.op.type === 'query' &&
        operation.op.path === 'entity.get' &&
        operation.op.context.recordPrefetch === true;
      if (!speculative && batch && activeEpoch === epoch) return batch(operation);
      const options = {
        url: TRPC_URL,
        fetch: (url, init) => {
          if (!leaseCurrent(lease) || !isUndoEpoch(epoch)) throw new Error('Сессия изменилась');
          const token = productToken(getToken);
          const headers = new Headers(init?.headers);
          if (token) headers.set('authorization', `Bearer ${token}`);
          return fetchWithNetworkStatus(url, {
            ...init,
            headers,
            signal: scopedSignal(lease, init?.signal),
          });
        },
        headers: () => {
          if (!isUndoEpoch(epoch) || !leaseCurrent(lease)) throw new Error('Сессия изменилась');
          return trpcHeaders(() => productToken(getToken));
        },
      } satisfies Parameters<typeof httpBatchLink<AppRouter>>[0];
      // A speculative GET owns its HTTP signal independently of ordinary reads.
      if (speculative) return httpLink<AppRouter>(options)(runtime)(operation);
      // Each owner gets a fresh queue, fenced from the next owner's credentials.
      activeEpoch = epoch;
      batch = httpBatchLink<AppRouter>(options)(runtime);
      return batch(operation);
    };
  };
  const subscriptions = httpSubscriptionLink<AppRouter, typeof EventSource>({
    url: TRPC_URL,
    EventSource,
    eventSourceOptions({ op }) {
      const epoch = undoEpoch();
      const lease = readProductLease?.();
      const request = op.context.freshnessStream as FreshnessStreamRequest | undefined;
      return {
        async fetch(url, init) {
          if (!isUndoEpoch(epoch) || op.signal?.aborted || !leaseCurrent(lease))
            throw new Error('Сессия изменилась');
          productToken(getToken);
          const headers = new Headers(init.headers);
          for (const [name, value] of Object.entries(
            trpcHeaders(() => request?.token ?? getToken()),
          )) {
            headers.set(name, value);
          }
          if (request) {
            // The parser can observe an id before the runtime accepts the page.
            // The actual HTTP resume boundary must always come from the runtime.
            headers.set('Last-Event-ID', request.beforeFetch());
          }
          return fetch(url, { ...init, headers, signal: scopedSignal(lease, init.signal) });
        },
      };
    },
  });
  return [
    authErrorLink({ onOutdated: emitClientOutdated, onUnauthorized: emitUnauthorized }),
    graphMutationLink,
    networkReadReceiptLink,
    splitLink({
      condition: (op) => op.type === 'subscription',
      true: subscriptions,
      false: scopedHttp,
    }),
  ];
}

// links? — точка инъекции мок-линка в тестах; в проде дефолт (orbisLinks).
export function makeTrpcClient(getToken: () => string | null, links?: TRPCLink<AppRouter>[]) {
  return trpc.createClient({ links: links ?? orbisLinks(getToken) });
}

// Vanilla-клиент (без React-контекста) — для боевой проводки retry-send (state/retry-send.ts).
export function makeVanillaClient(getToken: () => string | null) {
  return createTRPCClient<AppRouter>({ links: orbisLinks(getToken) });
}
export type OrbisVanillaClient = ReturnType<typeof makeVanillaClient>;
