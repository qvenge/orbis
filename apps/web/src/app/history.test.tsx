/**
 * История браузера под моделью навигации (срез 1б §7.3, С1б-3): одна модель — два поведения.
 * Сайт — честные записи со снимком модели, «назад» браузера восстанавливает место из снимка;
 * приложение — одна запись и охранная над ней, системный «назад» работает как «‹».
 *
 * jsdom держит ОДНУ сессионную историю на файл — длину меряем дельтой, адресную строку перед тестом
 * ставим `replaceState`.
 */
import { waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { registerLeaveGuard } from '../state/leave-guard';
import { resetNavForTests, useNav } from '../state/navigation';
import { recordAddress, topAddress } from '../test/nav';
import { stubLaunchMode, unstubLaunchMode } from './frame/frame-fixtures';
import { installHistory, startNavigation } from './history';

const A = '00000000-0000-4000-8000-00000000b001';
const B = '00000000-0000-4000-8000-00000000b002';
const C = '00000000-0000-4000-8000-00000000b003';

let uninstall: () => void = () => {};

function start(path: string, mode: 'app' | 'site' = 'site') {
  stubLaunchMode(mode);
  window.history.replaceState(null, '', path);
  startNavigation();
  uninstall = installHistory();
}

beforeEach(() => {
  localStorage.clear();
  resetNavForTests();
});

afterEach(() => {
  uninstall();
  unstubLaunchMode();
  vi.restoreAllMocks();
  resetNavForTests();
  localStorage.clear();
  window.history.replaceState(null, '', '/');
});

const path = () => window.location.pathname + window.location.search;

test('сайт: переход — запись истории со снимком; «назад» браузера восстанавливает прежнее место', async () => {
  start('/');
  const before = window.history.length;
  useNav.getState().openRecord(A);
  useNav.getState().openRecord(B);
  expect(window.history.length).toBe(before + 2);
  expect(path()).toBe(`/r/${B}`);

  window.history.back();
  await waitFor(() => expect(topAddress()).toEqual(recordAddress(A)));
  expect(path()).toBe(`/r/${A}`);
  // Применение `popstate` новых записей не порождает.
  expect(window.history.length).toBe(before + 2);
});

test('сайт: «вперёд» возвращает снятое место из снимка записи', async () => {
  start('/');
  useNav.getState().openRecord(A);
  useNav.getState().openRecord(B);
  window.history.back();
  await waitFor(() => expect(topAddress()).toEqual(recordAddress(A)));
  window.history.forward();
  await waitFor(() => expect(topAddress()).toEqual(recordAddress(B)));
});

test('сайт: прыжок через две записи — модель и адрес той записи, согласованно', async () => {
  start('/');
  useNav.getState().openRecord(A);
  useNav.getState().openRecord(B);
  useNav.getState().openRecord(C);
  window.history.go(-2);
  await waitFor(() => expect(topAddress()).toEqual(recordAddress(A)));
  expect(path()).toBe(`/r/${A}`);
  expect(useNav.getState().model.apps.host?.stacks.home).toHaveLength(2);
});

test('чужая запись истории (форма 1а) не ломает стор: место — по адресной строке', async () => {
  start('/');
  useNav.getState().openRecord(A);
  // Запись вкладки 1а после выкатки: `{tab, depth, screen}` и старый путь.
  window.history.pushState(
    { tab: 'browser', depth: 1, screen: { kind: 'entity', id: B } },
    '',
    `/entity/${B}`,
  );
  window.history.pushState({ junk: true }, '', '/');
  window.history.back();
  await waitFor(() => expect(topAddress()).toEqual(recordAddress(B)));
  // Адрес канонизирован под модель.
  expect(path()).toBe(`/r/${B}`);
});

test('повторная установка (StrictMode) не плодит слушателей: один «назад» — один шаг', async () => {
  start('/');
  installHistory();
  uninstall = installHistory();
  useNav.getState().openRecord(A);
  useNav.getState().openRecord(B);
  window.history.back();
  await waitFor(() => expect(topAddress()).toEqual(recordAddress(A)));
  // Второй слушатель снял бы ещё шаг — на домашнюю.
  await new Promise((r) => setTimeout(r, 20));
  expect(topAddress()).toEqual(recordAddress(A));
});

test('кнопка «‹» и браузерный «назад» дают одно и то же место', async () => {
  start('/');
  useNav.getState().openRecord(A);
  useNav.getState().openRecord(B);
  useNav.getState().back();
  await waitFor(() => expect(topAddress()).toEqual(recordAddress(A)));
  const byButton = { model: useNav.getState().model, path: path() };

  useNav.getState().openRecord(B);
  window.history.back();
  await waitFor(() => expect(topAddress()).toEqual(recordAddress(A)));
  expect({ model: useNav.getState().model, path: path() }).toEqual(byButton);
});

test('сайт, первая запись вкладки (вход по ссылке): «‹» идёт по модели честной записью, не прочь с Orbis (R-24)', () => {
  start(`/r/${A}`);
  const back = vi.spyOn(window.history, 'back');
  const push = vi.spyOn(window.history, 'pushState');
  useNav.getState().back();
  expect(back).not.toHaveBeenCalled();
  expect(push).toHaveBeenCalledTimes(1);
  expect(topAddress()).toEqual({ kind: 'home', app: { kind: 'host' } });
  expect(path()).toBe('/');
});

test('приложение: «‹» — по модели, новых записей нет, адрес обновлён (эффект none → replaceState)', () => {
  start('/', 'app');
  useNav.getState().openRecord(A);
  useNav.getState().openRecord(B);
  const push = vi.spyOn(window.history, 'pushState');
  const before = window.history.length;
  useNav.getState().back();
  expect(topAddress()).toEqual(recordAddress(A));
  expect(path()).toBe(`/r/${A}`);
  expect(push).not.toHaveBeenCalled();
  expect(window.history.length).toBe(before);
});

test.each([
  'site',
  'app',
] as const)('страж ухода сказал «нет» (%s) — системный «назад» не уходит: место прежнее, запись возвращена', async (mode) => {
  start('/', mode);
  useNav.getState().openRecord(A);
  useNav.getState().openRecord(B);
  const model = useNav.getState().model;
  const unregister = registerLeaveGuard(() => false);
  try {
    const popped = new Promise<void>((resolve) =>
      window.addEventListener('popstate', () => resolve(), { once: true }),
    );
    window.history.back();
    await popped;
    expect(useNav.getState().model).toBe(model);
    expect(path()).toBe(`/r/${B}`);
    expect((window.history.state as { model?: unknown }).model).toEqual(model);
  } finally {
    unregister();
  }
});

test('перезагрузка: место и глубина — из снимка записи истории, новых записей нет', () => {
  start('/');
  useNav.getState().openRecord(A);
  useNav.getState().openRecord(B);
  const model = useNav.getState().model;
  const before = window.history.length;
  resetNavForTests();
  startNavigation();
  expect(useNav.getState().model).toEqual(model);
  expect(window.history.length).toBe(before);
});
