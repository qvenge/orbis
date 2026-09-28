import { lazy, Suspense } from 'react';
import { useSearchDialog } from '../features/search/search-dialog-store';
import { useSearchHotkey } from '../features/search/useSearchHotkey';
import { ChunkErrorBoundary } from './ChunkErrorBoundary';
import { HostButtons } from './frame/HostButtons';
import { isDesktop, useIsDesktop } from './frame/useViewport';
import { ActiveScreen } from './router';

/**
 * Окно поиска ⌘K — ленивым чанком (R-35): входной чанк входит в замыкание экрана записи, а окно
 * нужно после жеста. Монтируется только открытым.
 */
const SearchDialog = lazy(() =>
  import('../features/search/SearchDialog').then((m) => ({ default: m.SearchDialog })),
);

/**
 * Рамка телефона: содержимое экрана и кнопки хоста внизу справа — на месте прежнего нижнего ряда
 * вкладок (РП-19). Она же стоит на ширине десктопа, пока едет чанк рамки десктопа или если он не
 * приехал: элементы хоста рисуются всегда (§6.6, гейт 25 m-5) — ⌂, «⋯», 🔍, 💬, ＋ телефонной формы
 * (форму элементы берут у рамки, `DesktopFrameContext`, а не у ширины).
 */
function PhoneFrame() {
  return (
    <div className="flex h-full flex-col bg-surface">
      <ActiveScreen />
      <HostButtons />
    </div>
  );
}

const loadDesktopFrame = () => import('./frame/DesktopFrame');

/**
 * Рамка десктопа — ленивым чанком (задача 25, R-35/R-36): рейка хоста, сайдбар и боковой чат нужны
 * только ширине десктопа, телефону их код ни к чему, а входной чанк входит в замыкание экрана записи.
 * Отказ загрузки — рамка телефона, а не пустота (§6.6): с ней работает всё, кроме рейки, сайдбара и
 * бокового чата; лечение — перезагрузка (`chunk-reload.ts`).
 */
const lazyDesktopFrame = () =>
  lazy(() =>
    loadDesktopFrame().then(
      (m) => ({ default: m.DesktopFrame }),
      () => ({ default: PhoneFrame }),
    ),
  );
let DesktopFrame = lazyDesktopFrame();

// Десктоп на старте — чанк рамки в путь сразу, при загрузке модуля (гейт 25, m-5): иначе он ждал бы
// первого рендера, а экран записи внутри него — ещё и его. Отказ здесь молчит: его покажет `lazy`.
if (isDesktop()) void loadDesktopFrame().catch(() => {});

/**
 * Забыть загрузку рамки десктопа — ТОЛЬКО для тестов: `lazy` помнит и удачу, и отказ навсегда, а тест
 * медленного и отказавшего чанка обязан видеть загрузку заново.
 */
export function resetDesktopFrameLoadForTests(): void {
  DesktopFrame = lazyDesktopFrame();
}

/**
 * Каркас (спека 1б §6.2, §6.3): рамка по ширине — телефон или десктоп. Выбор — в JS
 * (`useIsDesktop`), а не CSS-классом: вторая, скрытая стилем рамка дала бы в DOM второй набор
 * элементов хоста (повторы ролей, тест двух ширин) и работала бы для экранных чтецов.
 *
 *  - телефон (`PhoneFrame`). Нижней навигации нет ни в одной форме (§6.1 правило зон): навигация —
 *    сверху, в присутствии хоста;
 *  - десктоп: рейка хоста, сайдбар навигации, основная область с капсулой кнопок хоста и боковой чат
 *    (`DesktopFrame`, ленивый; пока едет или не приехал — рамка телефона).
 *
 * Здесь же — поиск хоста на всё приложение, один раз (§6.3, §6.4): горячая клавиша ⌘K / Ctrl+K и окно
 * поиска десктопа. Окно стоит вне `<main>` и вне истории (§7.3). Граница ошибок — своя: окно не под
 * границей `<main>`, и не приехавший чанк окна иначе уронил бы корень приложения; кадр ошибки — сверху
 * с «Обновить» (лечение отказа `lazy` — только перезагрузка, см. `ChunkErrorBoundary`).
 */
export function AppShell() {
  useSearchHotkey();
  const desktop = useIsDesktop();
  const searchOpen = useSearchDialog((s) => s.open);
  return (
    <>
      {desktop ? (
        <Suspense fallback={<PhoneFrame />}>
          <DesktopFrame />
        </Suspense>
      ) : (
        <PhoneFrame />
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
