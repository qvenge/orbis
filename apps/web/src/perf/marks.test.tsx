// Метки ступени 0 (спека скорости §3.1): холодный старт, переход, отклик действия, готовность экрана записи.
import type { PerfSample } from '@orbis/shared';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { QUERY_BLOCK_KEY } from '../lib/query-blocks/batch';
import {
  markNavigationStart,
  markScreenReady,
  resetMarksForTests,
  SCREEN_READY_CEILING_MS,
  startAction,
  useScreenReadyMark,
} from './marks';

// Сборщик подменён копилкой: метки проверяются по тому, ЧТО записано, без сети и таймера пачек.
const recorded = vi.hoisted(() => [] as PerfSample[]);
vi.mock('./collector', () => ({
  recordSample: (s: PerfSample) => recorded.push(s),
  perfBase: () => ({ device: 'desktop', appVersion: '0.5.0' }),
}));

const metrics = () => recorded.map((s) => s.metric);

beforeEach(() => {
  recorded.length = 0;
  resetMarksForTests();
});

describe('perf/marks: метки', () => {
  test('первая готовность — холодный старт: содержимое и перепроверенные данные', () => {
    markScreenReady('a', { cached: false });
    expect(metrics()).toEqual(['cold_start_content', 'cold_start_verified']);
    expect(recorded.every((s) => s.screen === 'record' && s.cached === false)).toBe(true);
  });

  test('дальше — переход: от нажатия до готовности той же записи, с признаком кеша', () => {
    markScreenReady('warm', { cached: false });
    recorded.length = 0;
    markNavigationStart('a');
    markScreenReady('a', { cached: true, screen: 'page' });
    expect(recorded).toEqual([
      expect.objectContaining({ metric: 'transition', screen: 'page', cached: true }),
    ]);
    // Второй готовности без нового нажатия замер не даёт.
    markScreenReady('a', { cached: true });
    expect(recorded).toHaveLength(1);
  });

  test('готовность другой записи замера не даёт', () => {
    markScreenReady('warm', { cached: false });
    recorded.length = 0;
    markNavigationStart('a');
    markScreenReady('b', { cached: false });
    expect(recorded).toEqual([]);
  });

  test('действие: «видно» и «подтверждено» — по одному разу даже при двойном вызове', () => {
    const a = startAction('checkbox');
    a.visible();
    a.visible();
    a.confirmed();
    a.confirmed();
    expect(recorded.map((s) => [s.metric, s.kind])).toEqual([
      ['action_visible', 'checkbox'],
      ['action_confirmed', 'checkbox'],
    ]);
  });
});

describe('perf/marks: готовность экрана записи', () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: [
        'setTimeout',
        'clearTimeout',
        'requestAnimationFrame',
        'cancelAnimationFrame',
        'performance',
      ],
    });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function mount(queryFn: () => Promise<number>) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );
    return renderHook(
      () => {
        useQuery({ queryKey: [QUERY_BLOCK_KEY, 'q'], queryFn });
        useScreenReadyMark('a', true, 'record');
      },
      { wrapper },
    );
  }
  const advance = (ms: number) => act(() => vi.advanceTimersByTime(ms));

  test('пока идёт запрос блока — замера нет; после ответа и двух кадров — есть', async () => {
    let resolve: (v: number) => void = () => {};
    mount(
      () =>
        new Promise<number>((r) => {
          resolve = r;
        }),
    );
    advance(0); // уведомление кеша о старте запроса доходит до счётчика
    advance(100);
    expect(recorded).toEqual([]);
    await act(async () => resolve(1));
    advance(0); // счётчик запросов экрана упал до нуля
    expect(recorded).toEqual([]);
    advance(16);
    expect(recorded).toEqual([]); // один кадр — мало: блоки могли встать в очередь
    advance(16);
    expect(metrics()).toEqual(['cold_start_content', 'cold_start_verified']);
  });

  test('вечный запрос — замер ровно по потолку 3 с от прихода данных', () => {
    mount(() => new Promise<number>(() => {}));
    advance(0);
    advance(SCREEN_READY_CEILING_MS - 1);
    expect(recorded).toEqual([]);
    advance(1);
    expect(metrics()).toEqual(['cold_start_content', 'cold_start_verified']);
    expect(recorded[0]?.durMs).toBe(SCREEN_READY_CEILING_MS);
  });
});
