import { observable } from '@trpc/server/observable';
import { expect, test, vi } from 'vitest';
import { trpcError } from './test/harness';
import { authErrorLink } from './trpc';

function runLinkWithError(
  link: ReturnType<typeof authErrorLink>,
  err: unknown,
  operation: { type: 'query' | 'subscription'; path: string } = { type: 'query', path: 'x' },
) {
  // biome-ignore lint/suspicious/noExplicitAny: минимальный фейковый runtime для линка
  const runtime = {} as any;
  const chain = link(runtime)({
    // biome-ignore lint/suspicious/noExplicitAny: минимальный фейковый op для линка
    op: { id: 1, ...operation, input: undefined, context: {}, signal: null } as any,
    next: () =>
      observable((o) => {
        o.error(err as never);
        return () => {};
      }),
  });
  return new Promise<void>((resolve) => {
    chain.subscribe({ next: () => {}, error: () => resolve(), complete: () => resolve() });
  });
}

test('PRECONDITION_FAILED → onOutdated, не onUnauthorized', async () => {
  const onOutdated = vi.fn();
  const onUnauthorized = vi.fn();
  await runLinkWithError(
    authErrorLink({ onOutdated, onUnauthorized }),
    trpcError('PRECONDITION_FAILED'),
  );
  expect(onOutdated).toHaveBeenCalledTimes(1);
  expect(onUnauthorized).not.toHaveBeenCalled();
});

test('UNAUTHORIZED → onUnauthorized, не onOutdated', async () => {
  const onOutdated = vi.fn();
  const onUnauthorized = vi.fn();
  await runLinkWithError(authErrorLink({ onOutdated, onUnauthorized }), trpcError('UNAUTHORIZED'));
  expect(onUnauthorized).toHaveBeenCalledTimes(1);
  expect(onOutdated).not.toHaveBeenCalled();
});

test('прочий код (CONFLICT) не триггерит ни один хендлер', async () => {
  const onOutdated = vi.fn();
  const onUnauthorized = vi.fn();
  await runLinkWithError(authErrorLink({ onOutdated, onUnauthorized }), trpcError('CONFLICT'));
  expect(onOutdated).not.toHaveBeenCalled();
  expect(onUnauthorized).not.toHaveBeenCalled();
});

test.each([
  ['subscription', 'changes.watch'],
  ['query', 'changes.reconcile'],
] as const)('freshness 401 (%s %s) reaches the refresh controller', async (type, path) => {
  const onUnauthorized = vi.fn();
  await runLinkWithError(
    authErrorLink({ onOutdated: vi.fn(), onUnauthorized }),
    trpcError('UNAUTHORIZED'),
    { type, path },
  );
  expect(onUnauthorized).not.toHaveBeenCalled();
});
