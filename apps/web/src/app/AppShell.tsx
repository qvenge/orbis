import { lazy, Suspense } from 'react';
import { useSearchDialog } from '../features/search/search-dialog-store';
import { useSearchHotkey } from '../features/search/useSearchHotkey';
import { ChunkErrorBoundary } from './ChunkErrorBoundary';
import { HostButtons } from './frame/HostButtons';
import { useIsDesktop } from './frame/useViewport';
import { ActiveScreen } from './router';

/**
 * Окно поиска ⌘K — ленивым чанком (R-35): входной чанк входит в замыкание экрана записи, а окно
 * нужно после жеста. Монтируется только открытым.
 */
const SearchDialog = lazy(() =>
  import('../features/search/SearchDialog').then((m) => ({ default: m.SearchDialog })),
);

/**
 * Рамка десктопа — ленивым чанком (задача 25, R-35/R-36): рейка хоста, сайдбар и боковой чат нужны
 * только ширине десктопа, телефону их код ни к чему, а входной чанк входит в замыкание экрана записи.
 */
const DesktopFrame = lazy(() =>
  import('./frame/DesktopFrame').then((m) => ({ default: m.DesktopFrame })),
);

/**
 * Пока едет чанк рамки десктопа — её силуэт (тёмная рейка, светлый сайдбар, пустая основная
 * область), а не телефонная форма: та смонтировала бы экран, который тут же перемонтировался бы
 * в рамке десктопа, и мигнула бы другой раскладкой.
 */
function DesktopFrameFallback() {
  return (
    <div className="flex h-full bg-surface">
      <div className="w-14 shrink-0 bg-host" />
      <div className="w-60 shrink-0 border-r border-line" />
    </div>
  );
}

/**
 * Каркас (спека 1б §6.2, §6.3): рамка по ширине — телефон или десктоп. Выбор — в JS
 * (`useIsDesktop`), а не CSS-классом: вторая, скрытая стилем рамка дала бы в DOM второй набор
 * элементов хоста (повторы ролей, тест двух ширин) и работала бы для экранных чтецов.
 *
 *  - телефон: содержимое экрана и кнопки хоста внизу справа — на месте прежнего нижнего ряда вкладок
 *    (РП-19). Нижней навигации нет ни в одной форме (§6.1 правило зон): навигация — сверху, в
 *    присутствии хоста;
 *  - десктоп: рейка хоста, сайдбар навигации, основная область с капсулой кнопок хоста и боковой чат
 *    (`DesktopFrame`, ленивый).
 *
 * Здесь же — поиск хоста на всё приложение, один раз (§6.3, §6.4): горячая клавиша ⌘K / Ctrl+K и окно
 * поиска десктопа. Окно стоит вне `<main>` и вне истории (§7.3). Граница ошибок — своя: окно не под
 * границей `<main>`, и не приехавший чанк окна иначе уронил бы корень приложения; кадр ошибки — сверху
 * с «Обновить» (лечение отказа `lazy` — только перезагрузка, см. `ChunkErrorBoundary`). Та же граница
 * — у рамки десктопа.
 */
export function AppShell() {
  useSearchHotkey();
  const desktop = useIsDesktop();
  const searchOpen = useSearchDialog((s) => s.open);
  return (
    <>
      {desktop ? (
        <ChunkErrorBoundary resetKey="desktop-frame">
          <Suspense fallback={<DesktopFrameFallback />}>
            <DesktopFrame />
          </Suspense>
        </ChunkErrorBoundary>
      ) : (
        <div className="flex h-full flex-col bg-surface">
          <ActiveScreen />
          <HostButtons />
        </div>
      )}
      {searchOpen && (
        <div className="fixed inset-x-0 top-0 z-50 bg-surface empty:hidden">
          <ChunkErrorBoundary resetKey="search-dialog">
            <Suspense fallback={null}>
              <SearchDialog />
            </Suspense>
          </ChunkErrorBoundary>
        </div>
      )}
    </>
  );
}
