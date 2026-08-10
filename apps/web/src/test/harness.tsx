import type { AppRouter } from '@orbis/server/src/router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { type RenderResult, render } from '@testing-library/react';
import { TRPCClientError, type TRPCLink } from '@trpc/client';
import { observable } from '@trpc/server/observable';
import { type ReactNode, Suspense } from 'react';
import { trpc } from '../trpc';

export type MockHandler = (path: string, input: unknown) => unknown | Promise<unknown>;

// TRPCClientError с data.code — клиент ключуется на КОД (не cause). Второй аргумент —
// текст сообщения: cause по HTTP не сериализуется, поэтому детали инвариантов (путь цикла
// blocks, K17) доезжают до UI только в message, и тесты должны уметь его подделать.
export function trpcError(code: string, message = code): TRPCClientError<AppRouter> {
  return new TRPCClientError(message, {
    // biome-ignore lint/suspicious/noExplicitAny: конструирование сырого tRPC-error shape для тестов
    result: { error: { message, code: -32600, data: { code, httpStatus: 400 } } } as any,
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

// Заглушка Suspense в обёртке — НЕ null и намеренно отличима. Сегодня через эту границу
// не подвисает ни одно дерево сьюта; пустой fallback превратил бы будущее подвисание в тихую
// пустоту, и падение пришло бы как «Unable to find an element» — без слова о том, что дерево
// подвисло, и без подсказки, где искать. Ровно та болезнь, против которой написан
// tests/setup.ts:11-18: улика в выводе важнее краткости разметки.
const SUSPENDED = <div data-testid="harness-suspended">дерево подвисло под Suspense обёртки</div>;

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
      <QueryClientProvider client={qc}>
        {/* Suspense — страховка для тестов, которые рендерят ленивое поддерево напрямую.
            Для синхронного дерева обёртка не меняет ничего. */}
        <Suspense fallback={SUSPENDED}>{ui}</Suspense>
      </QueryClientProvider>
    </trpc.Provider>,
  );
  return Object.assign(result, { calls });
}
