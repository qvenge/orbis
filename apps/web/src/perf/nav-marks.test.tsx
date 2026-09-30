// Метка начала перехода — в сторе навигации (спека скорости §3.1 «от нажатия на ссылку на запись или раздел»; гейт
// задачи 3, I-4): ссылка, раздел, плитка, «‹», системный «назад»; `useOpenRecord` метку сам не ставит.
import type { PerfSample } from '@orbis/shared';
import { HOST_APP } from '@orbis/shared/nav';
import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { useOpenRecord } from '../app/useOpenRecord';
import { resetNavForTests, setNavState, useNav } from '../state/navigation';
import { markScreenReady, resetMarksForTests } from './marks';

const recorded = vi.hoisted(() => [] as PerfSample[]);
const starts = vi.hoisted(() => ({ n: 0 }));
vi.mock('./collector', () => ({
  recordSample: (s: PerfSample) => recorded.push(s),
  perfBase: () => ({ device: 'desktop', appVersion: '0.5.0' }),
}));
// Настоящие метки, но со счётом вызовов начала перехода: стор и `useOpenRecord` берут тот же модуль.
vi.mock('./marks', async (importOriginal) => {
  const real = await importOriginal<typeof import('./marks')>();
  return {
    ...real,
    markNavigationStart: (t: Parameters<typeof real.markNavigationStart>[0]) => {
      starts.n += 1;
      real.markNavigationStart(t);
    },
  };
});

const transitions = () => recorded.filter((s) => s.metric === 'transition');

beforeEach(() => {
  resetNavForTests();
  resetMarksForTests();
  vi.useFakeTimers({ toFake: ['performance'] });
  markScreenReady('warm', { cached: false }); // холодный старт снят — дальше только переходы
  recorded.length = 0;
  starts.n = 0;
});
afterEach(() => {
  vi.useRealTimers();
});

describe('метка перехода в сторе навигации', () => {
  test('ссылка на запись (openRecord — путь разделов, плиток, плашек и меню): готовность этой записи — переход', () => {
    useNav.getState().openRecord('a');
    vi.advanceTimersByTime(120);
    markScreenReady('a', { cached: true });
    expect(transitions()).toEqual([
      expect.objectContaining({ screen: 'record', cached: true, durMs: 120 }),
    ]);
  });

  test('«Домой» — метка на домашнюю, её закрывает готовность экрана home', () => {
    useNav.getState().openRecord('a');
    markScreenReady('a', { cached: false });
    recorded.length = 0;
    useNav.getState().goHome();
    vi.advanceTimersByTime(50);
    markScreenReady('home-record', { cached: true, screen: 'home' });
    expect(transitions()).toEqual([expect.objectContaining({ screen: 'home', durMs: 50 })]);
  });

  test('«‹» назад в режиме приложения (по модели) — метка на прежнее место', () => {
    // В режиме сайта «‹» ведёт браузер, и место приносит `popstate` — это следующий тест.
    useNav.setState({ mode: 'app' });
    useNav.getState().openRecord('a');
    markScreenReady('a', { cached: false });
    useNav.getState().openRecord('b');
    markScreenReady('b', { cached: false });
    recorded.length = 0;
    useNav.getState().back();
    vi.advanceTimersByTime(30);
    markScreenReady('a', { cached: true });
    expect(transitions()).toEqual([expect.objectContaining({ cached: true, durMs: 30 })]);
  });

  test('системный «назад» (setNavState из popstate) на другое место — метка; то же место — метка не сдвигается', () => {
    useNav.getState().openRecord('a');
    const atA = useNav.getState().model;
    markScreenReady('a', { cached: false });
    recorded.length = 0;
    useNav.getState().openRecord('b');
    vi.advanceTimersByTime(40);
    // popstate после нашего же перехода приносит то же место — начало замера остаётся у нажатия.
    setNavState({ model: useNav.getState().model, overlay: null });
    markScreenReady('b', { cached: false });
    expect(transitions()).toEqual([expect.objectContaining({ durMs: 40 })]);
    recorded.length = 0;
    setNavState({ model: atA, overlay: null });
    vi.advanceTimersByTime(10);
    markScreenReady('a', { cached: true });
    expect(transitions()).toEqual([expect.objectContaining({ durMs: 10 })]);
  });

  test('экран хоста (чат) снимает метку: поздняя готовность записи — не переход', () => {
    useNav.getState().openRecord('a');
    useNav.getState().openHostScreen('chat');
    markScreenReady('a', { cached: false });
    expect(transitions()).toEqual([]);
  });

  test('та же запись в другой рамке (уточнение места) — не новый переход', () => {
    useNav.getState().openRecord('a');
    const n = starts.n;
    useNav.getState().replacePlace({ kind: 'record', app: { kind: 'host' }, id: 'a' }, HOST_APP);
    expect(starts.n).toBe(n);
  });

  test('useOpenRecord ставит метку ровно один раз — через стор, без своей', () => {
    const { result } = renderHook(() => useOpenRecord());
    result.current('x');
    expect(starts.n).toBe(1);
    markScreenReady('x', { cached: false });
    expect(transitions()).toHaveLength(1);
  });
});
