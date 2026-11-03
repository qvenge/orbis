import type { AppRouter } from '@orbis/server/src/router';
import { CLIENT_VERSION_HEADER, changeXidInput, READ_WATERMARK_HEADER } from '@orbis/shared';
import { type DefaultOptions, MutationCache, QueryClient } from '@tanstack/react-query';
import {
  createTRPCClient,
  httpBatchLink,
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
  return new QueryClient({
    mutationCache,
    queryCache: makeBodyQueryCache(),
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false, staleTime: 30_000, ...queries },
      mutations: { retry: false },
    },
  });
}
export const queryClient = makeQueryClient();

export function trpcHeaders(getToken: () => string | null): Record<string, string> {
  const token = getToken();
  return {
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    [CLIENT_VERSION_HEADER]: APP_VERSION,
  };
}

/** One HTTP response's evidence for the raw result, captured before cache publication. */
export type NetworkReadReceipt = Readonly<{
  epoch: number;
  watermark: string | null;
  receivedAt: number;
  startedSequence: number;
}>;
let networkOrder = 0;

/** Tab-local ordering shared by request starts and confirmed mutation ACKs. */
export function nextNetworkOrder(): number {
  return ++networkOrder;
}
const networkReadReceipts = new WeakMap<object, NetworkReadReceipt>();

export function networkReadReceiptOf(raw: unknown): NetworkReadReceipt | undefined {
  if (typeof raw === 'object' && raw !== null) return networkReadReceipts.get(raw);
}

export function inheritNetworkReadReceipt(rawParent: unknown, constituent: object): void {
  const receipt = networkReadReceiptOf(rawParent);
  if (receipt) networkReadReceipts.set(constituent, receipt);
}

const networkReadReceiptLink: TRPCLink<AppRouter> =
  () =>
  ({ op, next }) =>
    observable((observer) => {
      const epoch = undoEpoch();
      const read = op.type === 'query' || (op.type === 'mutation' && op.path === 'entity.blocks');
      const startedSequence = nextNetworkOrder();
      return next(op).subscribe({
        next(value) {
          const response = value.context?.response;
          if (read && response instanceof Response && 'data' in value.result) {
            const watermark = changeXidInput.safeParse(response.headers.get(READ_WATERMARK_HEADER));
            const receipt: NetworkReadReceipt = {
              epoch,
              watermark: watermark.success ? watermark.data : null,
              receivedAt: Date.now(),
              startedSequence,
            };
            const raw = value.result.data;
            if (typeof raw === 'object' && raw !== null) networkReadReceipts.set(raw, receipt);
            if (typeof op.context.onNetworkReadReceipt === 'function') {
              op.context.onNetworkReadReceipt(receipt);
            }
          }
          observer.next(value);
        },
        error: (error) => observer.error(error),
        complete: () => observer.complete(),
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
            if (code === 'PRECONDITION_FAILED') handlers.onOutdated();
            else if (code === 'UNAUTHORIZED' && !freshness && isUndoEpoch(epoch))
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
  const scopedBatch: TRPCLink<AppRouter> = (runtime) => {
    let activeEpoch: number | undefined;
    let batch: ReturnType<TRPCLink<AppRouter>> | undefined;
    return (operation) => {
      const epoch = undoEpoch();
      if (batch === undefined || activeEpoch !== epoch) {
        activeEpoch = epoch;
        // У каждого владельца собственная очередь: старый запрос не объединяется с новым и не получает его токен.
        batch = httpBatchLink<AppRouter>({
          url: TRPC_URL,
          headers: () => {
            if (!isUndoEpoch(epoch)) throw new Error('Сессия изменилась');
            return trpcHeaders(getToken);
          },
        })(runtime);
      }
      return batch(operation);
    };
  };
  const subscriptions = httpSubscriptionLink<AppRouter, typeof EventSource>({
    url: TRPC_URL,
    EventSource,
    eventSourceOptions({ op }) {
      const epoch = undoEpoch();
      const request = op.context.freshnessStream as FreshnessStreamRequest | undefined;
      return {
        async fetch(url, init) {
          if (!isUndoEpoch(epoch) || op.signal?.aborted) throw new Error('Сессия изменилась');
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
          return fetch(url, { ...init, headers });
        },
      };
    },
  });
  return [
    authErrorLink({ onOutdated: emitClientOutdated, onUnauthorized: emitUnauthorized }),
    networkReadReceiptLink,
    splitLink({
      condition: (op) => op.type === 'subscription',
      true: subscriptions,
      false: scopedBatch,
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
