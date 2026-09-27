import { useSyncExternalStore } from 'react';

/**
 * Брейкпоинт десктопа — `md` Tailwind (768 px), тот же, что у сегодняшней раскладки: рамка решает
 * «телефон или десктоп» тем же порогом, каким вёрстка решает ширину колонок (спека 1б §6.2, §6.3).
 */
export const DESKTOP_QUERY = '(min-width: 768px)';

function subscribe(onChange: () => void): () => void {
  if (typeof window.matchMedia !== 'function') return () => {};
  const mql = window.matchMedia(DESKTOP_QUERY);
  mql.addEventListener('change', onChange);
  return () => mql.removeEventListener('change', onChange);
}

// Нет `matchMedia` (jsdom, старый WebView) — телефон: у телефонной формы нет ничего, что требовало бы
// ширины, а десктопная на узком экране не поместилась бы.
const isDesktopNow = (): boolean =>
  typeof window.matchMedia === 'function' && window.matchMedia(DESKTOP_QUERY).matches;

/**
 * Десктоп ли сейчас — подпиской на `matchMedia`: поворот планшета или окно, сузившееся за порог,
 * меняют форму без перезагрузки. Первый потребитель — поиск (🔍 и ⌘K: окно или экран хоста, §6.4);
 * задача 25 рисует по нему две рамки.
 */
export function useIsDesktop(): boolean {
  return useSyncExternalStore(subscribe, isDesktopNow, () => false);
}

/** То же без подписки — для обработчиков событий вне рендера (горячая клавиша). */
export function isDesktop(): boolean {
  return isDesktopNow();
}
