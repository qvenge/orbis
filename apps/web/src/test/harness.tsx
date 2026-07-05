import type { AppRouter } from '@orbis/server/src/router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { type RenderResult, render } from '@testing-library/react';
import { TRPCClientError, type TRPCLink } from '@trpc/client';
import { observable } from '@trpc/server/observable';
import type { ReactNode } from 'react';
import { trpc } from '../trpc';

export type MockHandler = (path: string, input: unknown) => unknown | Promise<unknown>;

// TRPCClientError с data.code — клиент ключуется на КОД (не cause).
export function trpcError(code: string): TRPCClientError<AppRouter> {
  return new TRPCClientError(code, {
    // biome-ignore lint/suspicious/noExplicitAny: конструирование сырого tRPC-error shape для тестов
    result: { error: { message: code, code: -32600, data: { code, httpStatus: 400 } } } as any,
  });
}

export function mockLink(handler: MockHandler): TRPCLink<AppRouter> {
  return () =>
    ({ op }) =>
      observable((observer) => {
        Promise.resolve(handler(op.path, op.input))
          .then((data) => {
            observer.next({ result: { type: 'data', data } });
            observer.complete();
          })
          .catch((err) =>
            observer.error(err instanceof TRPCClientError ? err : TRPCClientError.from(err)),
          );
        return () => {};
      });
}

export function renderWithProviders(
  ui: ReactNode,
  handler: MockHandler = () => ({}),
): RenderResult & { calls: { path: string; input: unknown }[] } {
  const calls: { path: string; input: unknown }[] = [];
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const client = trpc.createClient({
    links: [
      mockLink((path, input) => {
        calls.push({ path, input });
        return handler(path, input);
      }),
    ],
  });
  const result = render(
    <trpc.Provider client={client} queryClient={qc}>
      <QueryClientProvider client={qc}>{ui}</QueryClientProvider>
    </trpc.Provider>,
  );
  return Object.assign(result, { calls });
}
