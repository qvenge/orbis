import type { AppRouter } from '@orbis/server/src/router';
import { CLIENT_VERSION_HEADER } from '@orbis/shared';
import { QueryClient } from '@tanstack/react-query';
import { createTRPCClient, httpBatchLink, TRPCClientError, type TRPCLink } from '@trpc/client';
import { createTRPCReact } from '@trpc/react-query';
import type { inferRouterInputs, inferRouterOutputs } from '@trpc/server';
import { observable } from '@trpc/server/observable';
import { APP_VERSION } from './app/version';
import { emitClientOutdated, emitUnauthorized } from './auth/events';

export const trpc = createTRPCReact<AppRouter>();

export type RouterInputs = inferRouterInputs<AppRouter>;
export type RouterOutputs = inferRouterOutputs<AppRouter>;

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: false, refetchOnWindowFocus: false, staleTime: 30_000 },
    mutations: { retry: false },
  },
});

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
      observable((observer) =>
        next(op).subscribe({
          next: (v) => observer.next(v),
          complete: () => observer.complete(),
          error: (err) => {
            const code = err instanceof TRPCClientError ? err.data?.code : undefined;
            if (code === 'PRECONDITION_FAILED') handlers.onOutdated();
            else if (code === 'UNAUTHORIZED') handlers.onUnauthorized();
            observer.error(err);
          },
        }),
      );
}

// URL tRPC: по умолчанию относительный `/trpc` (Вариант A — same-origin, сервер сам
// раздаёт web-dist, CORS не нужен). VITE_API_URL — опц. fallback для режима B (раздельные
// origins): если задан, префиксует абсолютным base; пусто/не задан → прежнее поведение.
const apiBase = import.meta.env.VITE_API_URL ?? '';
export const TRPC_URL = `${apiBase}/trpc`;

export function orbisLinks(getToken: () => string | null): TRPCLink<AppRouter>[] {
  return [
    authErrorLink({ onOutdated: emitClientOutdated, onUnauthorized: emitUnauthorized }),
    httpBatchLink({ url: TRPC_URL, headers: () => trpcHeaders(getToken) }),
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
