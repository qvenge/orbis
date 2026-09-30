// Сборщик полевых замеров (спека скорости §3.2): пачка раз в 30 с и при уходе страницы в фон, `fetch keepalive`.
import type { PerfSample } from '@orbis/shared';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { recordSample, resetCollectorForTests, startCollector } from './collector';

// Поднимается над импортами (vitest): сборщик читает токен через этот модуль в момент отправки.
const tokenRef = vi.hoisted(() => ({ value: 't' as string | null }));
vi.mock('../auth/AuthProvider', () => ({ getCurrentToken: () => tokenRef.value }));

const S: PerfSample = { metric: 'inp', durMs: 42, device: 'desktop', appVersion: '0.5.0' };
const fetchMock = vi.fn(
  async (_url: string, _init?: RequestInit) =>
    new Response(JSON.stringify({ result: { data: { accepted: 0, dropped: 0 } } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
);
const bodyOf = (i: number) =>
  JSON.parse(String(fetchMock.mock.calls[i]?.[1]?.body)) as { samples: PerfSample[] };

let visibility: DocumentVisibilityState = 'visible';

beforeEach(() => {
  tokenRef.value = 't';
  visibility = 'visible';
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
  vi.useFakeTimers();
});

afterEach(() => {
  resetCollectorForTests();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('perf/collector', () => {
  test('раз в 30 с — одна пачка на perf.report: keepalive, авторизация, тело из буфера', async () => {
    recordSample(S);
    recordSample({ ...S, durMs: 43 });
    recordSample({ ...S, durMs: 44 });
    startCollector();
    vi.advanceTimersByTime(29_999);
    expect(fetchMock).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toMatch(/\/trpc\/perf\.report$/);
    expect(init?.keepalive).toBe(true);
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer t');
    expect(bodyOf(0).samples.map((s) => s.durMs)).toEqual([42, 43, 44]);
  });

  test('уход страницы в фон — пачка уходит сразу', async () => {
    startCollector();
    recordSample(S);
    visibility = 'hidden';
    document.dispatchEvent(new Event('visibilitychange', { bubbles: true }));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(bodyOf(0).samples).toHaveLength(1);
  });

  test('видимая страница на visibilitychange пачку не шлёт', async () => {
    startCollector();
    recordSample(S);
    document.dispatchEvent(new Event('visibilitychange', { bubbles: true }));
    await Promise.resolve();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('pagehide — тоже', async () => {
    startCollector();
    recordSample(S);
    window.dispatchEvent(new Event('pagehide'));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  });

  test('без токена — ни одного fetch, буфер цел до входа', async () => {
    tokenRef.value = null;
    startCollector();
    recordSample(S);
    vi.advanceTimersByTime(30_000);
    await Promise.resolve();
    expect(fetchMock).not.toHaveBeenCalled();
    tokenRef.value = 't';
    vi.advanceTimersByTime(30_000);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(bodyOf(0).samples).toHaveLength(1);
  });

  test('250 замеров — пачки по 100', async () => {
    startCollector();
    for (let i = 0; i < 250; i++) recordSample({ ...S, durMs: i });
    for (let k = 0; k < 3; k++) vi.advanceTimersByTime(30_000);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect([0, 1, 2].map((i) => bodyOf(i).samples.length)).toEqual([100, 100, 50]);
  });
});
