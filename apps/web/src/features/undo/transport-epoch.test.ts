import { CLIENT_VERSION_HEADER } from '@orbis/shared';
import { afterEach, expect, test, vi } from 'vitest';
import { APP_VERSION } from '../../app/version';
import { mockLink, trpcError } from '../../test/harness';
import { authErrorLink, makeTrpcClient, makeVanillaClient } from '../../trpc';
import { resetUndoSession } from './undo-epoch';

afterEach(() => vi.unstubAllGlobals());
function fetchProbe() {
  const sent: Array<{ headers: Headers; body: string }> = [];
  const fetch = vi.fn(async (_url: unknown, init: RequestInit) => {
    const body = String(init.body);
    sent.push({ headers: new Headers(init.headers), body });
    const count = Object.keys(JSON.parse(body)).length;
    return new Response(
      JSON.stringify(
        Array.from({ length: count }, (_, index) => ({
          result: { data: { actionId: `settings-${index}`, consequences: false } },
        })),
      ),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  });
  vi.stubGlobal('fetch', fetch);
  return { fetch, sent };
}
test('queued httpBatchLink старой settings правки отменяется до HTTP', async () => {
  let token = 'old';
  const { fetch } = fetchProbe();
  const client = makeVanillaClient(() => token);
  const request = client.user.updateSettings.mutate({ timezone: 'old' });
  token = 'new';
  resetUndoSession();
  await expect(request).rejects.toThrow('Сессия изменилась');
  expect(fetch).not.toHaveBeenCalled();
});
test('old+new в одном tick: новая очередь отправляет только новый payload и новый Bearer', async () => {
  let token = 'old';
  const { fetch, sent } = fetchProbe();
  const client = makeVanillaClient(() => token);
  const old = client.user.updateSettings.mutate({ timezone: 'old' });
  token = 'new';
  resetUndoSession();
  const current = client.user.updateSettings.mutate({ timezone: 'new' });
  const result = await Promise.allSettled([old, current]);
  expect(result[0]?.status).toBe('rejected');
  expect(result[1]?.status).toBe('fulfilled');
  expect(fetch).toHaveBeenCalledOnce();
  expect(sent[0]?.headers.get('authorization')).toBe('Bearer new');
  expect(sent[0]?.headers.get(CLIENT_VERSION_HEADER)).toBe(APP_VERSION);
  expect(JSON.parse(sent[0]?.body ?? '')).toEqual({ '0': { timezone: 'new' } });
});
test('React factory сохраняет batching одной сессии и обновление токена того же владельца', async () => {
  let token = 'before-refresh';
  const { fetch, sent } = fetchProbe();
  const client = makeTrpcClient(() => token);
  const a = client.user.updateSettings.mutate({ timezone: 'UTC' });
  const b = client.user.updateSettings.mutate({ defaultCurrency: 'RUB' });
  token = 'refreshed';
  await Promise.all([a, b]);
  expect(fetch).toHaveBeenCalledOnce();
  expect(sent[0]?.headers.get('authorization')).toBe('Bearer refreshed');
  expect(sent[0]?.headers.get(CLIENT_VERSION_HEADER)).toBe(APP_VERSION);
  expect(JSON.parse(sent[0]?.body ?? '')).toEqual({
    '0': { timezone: 'UTC' },
    '1': { defaultCurrency: 'RUB' },
  });
});
test('старые 401/412 доставляются caller; только 412 поднимает глобальный compatibility event', async () => {
  const unauthorized = vi.fn();
  const outdated = vi.fn();
  let fail!: (error: unknown) => void;
  const client = makeTrpcClient(
    () => null,
    [
      authErrorLink({ onUnauthorized: unauthorized, onOutdated: outdated }),
      mockLink(
        () =>
          new Promise((_resolve, reject) => {
            fail = reject;
          }),
      ),
    ],
  );
  const old401 = client.user.updateSettings.mutate({ timezone: 'UTC' });
  resetUndoSession();
  fail(trpcError('UNAUTHORIZED'));
  await expect(old401).rejects.toBeDefined();
  expect(unauthorized).not.toHaveBeenCalled();
  const old412 = client.user.updateSettings.mutate({ timezone: 'UTC' });
  resetUndoSession();
  fail(trpcError('PRECONDITION_FAILED'));
  await expect(old412).rejects.toBeDefined();
  expect(outdated).toHaveBeenCalledOnce();
  const current401 = client.user.updateSettings.mutate({ timezone: 'UTC' });
  fail(trpcError('UNAUTHORIZED'));
  await expect(current401).rejects.toBeDefined();
  expect(unauthorized).toHaveBeenCalledOnce();
});
