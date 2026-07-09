import { useSyncExternalStore } from 'react';

/**
 * Управление темой light/dark. Дефолт — 'system' (следует за ОС).
 * Разрешённая тема ставится атрибутом `data-theme='dark'` на <html>; светлая —
 * отсутствие атрибута (консистентно с pre-paint скриптом в index.html).
 * Значение хранится плоской строкой в localStorage['orbis:theme'].
 */
export type ThemePref = 'system' | 'light' | 'dark';

const STORAGE_KEY = 'orbis:theme';
const THEME_COLOR = { light: '#fbfbfa', dark: '#161616' } as const;

function isPref(v: unknown): v is ThemePref {
  return v === 'system' || v === 'light' || v === 'dark';
}

export function getThemePref(): ThemePref {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (isPref(raw)) return raw;
  } catch {
    // localStorage недоступен (SSR/приватный режим) — падаем на 'system'.
  }
  return 'system';
}

function prefersDark(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches;
}

/** Резолвит текущий pref в конкретную тему и применяет к <html> и meta theme-color. */
export function applyTheme(pref: ThemePref = getThemePref()): void {
  const dark = pref === 'dark' || (pref === 'system' && prefersDark());
  const root = document.documentElement;
  if (dark) root.setAttribute('data-theme', 'dark');
  else root.removeAttribute('data-theme');

  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', dark ? THEME_COLOR.dark : THEME_COLOR.light);
}

const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

export function setThemePref(pref: ThemePref): void {
  try {
    localStorage.setItem(STORAGE_KEY, pref);
  } catch {
    // localStorage недоступен — тему всё равно применяем на текущую сессию.
  }
  applyTheme(pref);
  emit();
}

/** Применяет тему и подписывается на смену системной темы (реагирует только при pref='system'). */
export function initTheme(): void {
  applyTheme();
  if (typeof matchMedia === 'function') {
    const mql = matchMedia('(prefers-color-scheme: dark)');
    mql.addEventListener('change', () => {
      if (getThemePref() === 'system') applyTheme('system');
    });
  }
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Хук для переключателя темы в настройках. */
export function useThemePref(): [ThemePref, (p: ThemePref) => void] {
  const pref = useSyncExternalStore(subscribe, getThemePref, () => 'system' as ThemePref);
  return [pref, setThemePref];
}
