import type { AppRouter } from '@orbis/server/src/router';
import { CLIENT_VERSION_HEADER } from '@orbis/shared';
import { type DefaultOptions, MutationCache, QueryClient } from '@tanstack/react-query';
import { createTRPCClient, httpBatchLink, TRPCClientError, type TRPCLink } from '@trpc/client';
import { createTRPCReact } from '@trpc/react-query';
import type { inferRouterInputs, inferRouterOutputs } from '@trpc/server';
import { observable } from '@trpc/server/observable';
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
            const code = err instanceof TRPCClientError ? err.data?.code : undefined;
            if (code === 'PRECONDITION_FAILED') handlers.onOutdated();
            else if (code === 'UNAUTHORIZED' && isUndoEpoch(epoch)) handlers.onUnauthorized();
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
  return [
    authErrorLink({ onOutdated: emitClientOutdated, onUnauthorized: emitUnauthorized }),
    scopedBatch,
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
