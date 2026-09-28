import { useSyncExternalStore } from 'react';

/**
 * Широкий десктоп — места хватает на рейку, сайдбар, основную область и боковой чат рядом:
 * 56 + 240 + 380 = 676 px колонок, и основной области остаётся не меньше ≈ 420 px. Уже — открытый
 * боковой чат занимает место сайдбара (гейт 25, m-4). Модуль — в ленивом чанке рамки десктопа.
 */
export const WIDE_DESKTOP_QUERY = '(min-width: 1100px)';

function subscribe(onChange: () => void): () => void {
  if (typeof window.matchMedia !== 'function') return () => {};
  const mql = window.matchMedia(WIDE_DESKTOP_QUERY);
  mql.addEventListener('change', onChange);
  return () => mql.removeEventListener('change', onChange);
}

const isWideNow = (): boolean =>
  typeof window.matchMedia === 'function' && window.matchMedia(WIDE_DESKTOP_QUERY).matches;

/** Широкий ли десктоп сейчас — подпиской на `matchMedia` (окно сузилось — раскладка следом). */
export function useIsWideDesktop(): boolean {
  return useSyncExternalStore(subscribe, isWideNow, () => true);
}
