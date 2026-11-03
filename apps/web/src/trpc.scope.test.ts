import { afterEach, expect, test, vi } from 'vitest';
import { configureProductTransport, makeVanillaClient } from './trpc';

afterEach(() => {
  configureProductTransport();
  vi.unstubAllGlobals();
});

test('cache-only product reads and writes never reach fetch', async () => {
  const signal = new AbortController();
  configureProductTransport(() => ({ signal: signal.signal, isCurrent: () => true }));
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  const client = makeVanillaClient(() => null);
  await expect(client.user.getSettings.query()).rejects.toThrow('кеша');
  await expect(client.user.seedOnboarding.mutate()).rejects.toThrow('кеша');
  expect(fetch).not.toHaveBeenCalled();
});

test('freezing a product scope aborts in-flight HTTP even with an unexpired bearer', async () => {
  const lifetime = new AbortController();
  configureProductTransport(() => ({
    signal: lifetime.signal,
    isCurrent: () => !lifetime.signal.aborted,
  }));
  let entered!: () => void;
  const sent = new Promise<void>((resolve) => {
    entered = resolve;
  });
  vi.stubGlobal(
    'fetch',
    (_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('scope aborted')), {
          once: true,
        });
        entered();
      }),
  );
  const client = makeVanillaClient(() => 'valid-session');
  const result = client.user.getSettings.query();
  await sent;
  lifetime.abort();
  await expect(result).rejects.toThrow('scope aborted');
});
