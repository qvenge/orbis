import { lazy, Suspense } from 'react';
import { useSearchDialog } from '../features/search/search-dialog-store';
import { useSearchHotkey } from '../features/search/useSearchHotkey';
import { ChunkErrorBoundary } from './ChunkErrorBoundary';
import { HostButtons } from './frame/HostButtons';
import { ActiveScreen } from './router';

/**
 * Окно поиска ⌘K — ленивым чанком (R-35): входной чанк входит в замыкание экрана записи, а окно
 * нужно после жеста. Монтируется только открытым.
 */
const SearchDialog = lazy(() =>
  import('../features/search/SearchDialog').then((m) => ({ default: m.SearchDialog })),
);

/**
 * Каркас (спека 1б §6.2): содержимое экрана и кнопки хоста внизу справа — на месте прежнего нижнего
 * ряда вкладок (РП-19). Нижней навигации нет ни в одной форме (§6.1 правило зон): навигация — сверху,
 * в присутствии хоста. Десктоп в срезе 1б пока показывает ту же форму (рейка, сайдбар и боковой чат —
 * задача 25).
 *
 * Здесь же — поиск хоста на всё приложение, один раз (§6.3, §6.4): горячая клавиша ⌘K / Ctrl+K и окно
 * поиска десктопа. Окно стоит вне `<main>` и вне истории (§7.3). Граница ошибок — своя: окно не под
 * границей `<main>`, и не приехавший чанк окна иначе уронил бы корень приложения; кадр ошибки — сверху
 * с «Обновить» (лечение отказа `lazy` — только перезагрузка, см. `ChunkErrorBoundary`).
 */
export function AppShell() {
  useSearchHotkey();
  const searchOpen = useSearchDialog((s) => s.open);
  return (
    <div className="flex h-full flex-col bg-surface">
      <ActiveScreen />
      <HostButtons />
      {searchOpen && (
        <div className="fixed inset-x-0 top-0 z-50 bg-surface empty:hidden">
          <ChunkErrorBoundary resetKey="search-dialog">
            <Suspense fallback={null}>
              <SearchDialog />
            </Suspense>
          </ChunkErrorBoundary>
        </div>
      )}
    </div>
  );
}
