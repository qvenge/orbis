import type { AppKey } from '@orbis/shared/nav';
import { lazy, Suspense } from 'react';

/**
 * Точки лени приложений в web (срез 1б §6.2 п. 2–3; РП-25) — эагерный файл без веса: только `lazy`.
 * Статический импорт блока или плиток вернул бы их в первый кадр каждой записи (сторож —
 * `scripts/check-lazy-chunks.ts`, порог замыкания экрана записи). Пока чанк едет — ничего: список
 * приложений и разделы приходят своими запросами, раскладке нечего держать.
 *
 * - `AppsBlockSlot` — блок «Приложения» (`{{apps}}`): рендерер страниц эагерен в каждом открытии
 *   записи, а плитки нужны «Домой» и редкой странице. Чанк `AppsBlock` — общий с листом «Все
 *   приложения», как у блока «Записи» (`RecordsBlockSlot`).
 * - `NavTilesSlot` — плитки разделов «домашней как центр»: редкая форма навигации, их грузит только
 *   её домашняя.
 */
const AppsBlock = lazy(() => import('./AppsBlock').then((m) => ({ default: m.AppsBlock })));
const NavTiles = lazy(() => import('./NavTiles').then((m) => ({ default: m.NavTiles })));

export function AppsBlockSlot() {
  return (
    <Suspense fallback={null}>
      <AppsBlock />
    </Suspense>
  );
}

export function NavTilesSlot({ app }: { app: AppKey }) {
  return (
    <Suspense fallback={null}>
      <NavTiles app={app} />
    </Suspense>
  );
}
