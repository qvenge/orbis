import type { AppRouter } from '@orbis/server/src/router';
import { CLIENT_VERSION_HEADER } from '@orbis/shared';
import { QueryClient } from '@tanstack/react-query';
import { httpBatchLink, type TRPCLink } from '@trpc/client';
import { createTRPCReact } from '@trpc/react-query';
import type { inferRouterInputs, inferRouterOutputs } from '@trpc/server';
import { APP_VERSION } from './app/version';

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

// links? — точка инъекции мок-линка в тестах; в проде дефолт (httpBatchLink на /trpc).
export function makeTrpcClient(getToken: () => string | null, links?: TRPCLink<AppRouter>[]) {
  return trpc.createClient({
    links: links ?? [httpBatchLink({ url: '/trpc', headers: () => trpcHeaders(getToken) })],
  });
}
