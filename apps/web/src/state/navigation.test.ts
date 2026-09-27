/**
 * Стор навигации 1б (РП-18, РП-33): тонкий слой над чистой моделью `navReduce` — страж ухода перед
 * каждым переходом, сохранение `orbis:nav:v2`, эффект — порту истории. Логику стопок стережёт модель
 * (`packages/shared/src/nav/history-model.test.ts`); здесь — только то, что добавляет стор.
 */
import { NAV_STORAGE_KEY, type NavEffect } from '@orbis/shared/nav';
import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { recordAddress, topAddress } from '../test/nav';
import { registerLeaveGuard } from './leave-guard';
import { connectHistoryPort, resetNavForTests, useNav, useShowBack } from './navigation';

const A = '00000000-0000-4000-8000-00000000a001';
const B = '00000000-0000-4000-8000-00000000a002';
const APP = '00000000-0000-4000-8000-00000000a0ff';

let effects: NavEffect[] = [];

beforeEach(() => {
  localStorage.clear();
  resetNavForTests();
  effects = [];
  connectHistoryPort({
    apply: (e) => effects.push(e),
    atFirstEntry: () => false,
    hasOrbisBehind: () => false,
  });
});

afterEach(() => {
  connectHistoryPort(null);
  resetNavForTests();
  localStorage.clear();
});

test('openRecord кладёт запись в стопку активного раздела; эффект — порту истории', () => {
  useNav.getState().openRecord(A);
  expect(topAddress()).toEqual(recordAddress(A));
  expect(effects).toEqual([{ history: 'push' }]);
});

test('openRecord в другое приложение — рамка этого приложения (R-22)', () => {
  useNav.getState().openRecord(A, { app: APP });
  expect(useNav.getState().model.activeApp).toBe(APP);
  expect(topAddress()).toEqual(recordAddress(A, { kind: 'app', ref: APP }));
});

test('каждый переход спрашивает стража ухода: «нет» — модель прежняя, эффекта нет (РП-33)', () => {
  useNav.getState().openRecord(A);
  const before = useNav.getState().model;
  effects = [];
  let asked = 0;
  const unregister = registerLeaveGuard(() => {
    asked += 1;
    return false;
  });
  try {
    const s = useNav.getState();
    s.openRecord(B);
    s.openAddress(recordAddress(B));
    s.openSection('host', B);
    s.switchApp(APP);
    s.goHome();
    s.openHostScreen('chat');
    s.back();
    expect(asked).toBe(7);
    expect(useNav.getState().model).toBe(before);
    expect(effects).toEqual([]);
  } finally {
    unregister();
  }
});

test('состояние экрана и уточнение места стража не спрашивают: с экрана не уходят', () => {
  useNav.getState().openRecord(A);
  const unregister = registerLeaveGuard(() => false);
  try {
    useNav.getState().setView({ 'tab:tabs0': '1' });
    useNav.getState().replacePlace(recordAddress(B));
    expect(topAddress()).toEqual(recordAddress(B));
  } finally {
    unregister();
  }
});

test('⌂ хоста — «Домой» хоста из любого приложения, а не последнее место хоста (R-23)', () => {
  useNav.getState().openRecord(B);
  useNav.getState().openRecord(A, { app: APP });
  useNav.getState().goHome();
  expect(useNav.getState().model.activeApp).toBe('host');
  expect(topAddress()).toEqual({ kind: 'home', app: { kind: 'host' } });
});

test('каждый переход сохраняет навигацию под orbis:nav:v2 — последнее место раздела, без глубины', () => {
  useNav.getState().openSection('host', A);
  useNav.getState().openRecord(B);
  const saved = JSON.parse(localStorage.getItem(NAV_STORAGE_KEY) ?? 'null');
  expect(saved).toEqual({
    v: 2,
    activeApp: 'host',
    apps: {
      host: {
        activeSection: A,
        last: { home: { kind: 'home', app: { kind: 'host' } }, [A]: recordAddress(B) },
      },
    },
  });
  expect(localStorage.getItem('orbis:nav:v1')).toBeNull();
});

test('экран поверх модели (плашка, старая ссылка) — «‹» снимает его, место модели прежнее', () => {
  useNav.getState().openRecord(A);
  const model = useNav.getState().model;
  useNav.setState({ overlay: { kind: 'reserved', key: 'agenda', path: '/agenda' } });
  effects = [];
  useNav.getState().back();
  expect(useNav.getState().overlay).toBeNull();
  expect(useNav.getState().model).toBe(model);
  expect(effects).toEqual([{ history: 'replace' }]);
});

test('«‹» в режиме приложения — по модели (canGoBack); на сайте — ещё и запись Orbis позади', () => {
  const read = () => renderHook(() => useShowBack()).result.current;
  useNav.setState({ mode: 'app' });
  expect(read()).toBe(false);
  useNav.getState().openRecord(A);
  expect(read()).toBe(true);

  resetNavForTests();
  useNav.setState({ mode: 'site' });
  connectHistoryPort({ apply: () => {}, atFirstEntry: () => false, hasOrbisBehind: () => true });
  expect(read()).toBe(true);
});
