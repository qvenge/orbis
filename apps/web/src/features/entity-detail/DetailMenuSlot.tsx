import { useCallback, useEffect, useRef, useState } from 'react';
import type { DetailMenu, DetailMenuProps } from './DetailMenu';
import { MenuTrigger } from './MenuTrigger';

/**
 * Меню ⋮ живёт в своём чанке (рычаг веса РП-11 задачи 14 страниц 1а: чанк экрана записи вырос
 * шаблоном хоста за порог +15 %, а Radix-меню — самый крупный кусок, которому в первом кадре
 * делать нечего). Промис загрузки один на приложение: прогрев и загрузка ведут к тому же модулю.
 *
 * Отказ загрузки промис НЕ запоминает: отвергнутый промис в кеше делал бы кнопку мёртвой до
 * перезагрузки страницы, и следующий жест даже не попытался бы снова.
 */
let menuModule: Promise<typeof import('./DetailMenu')> | null = null;
const loadMenu = () => {
  menuModule ??= import('./DetailMenu').catch((error: unknown) => {
    menuModule = null;
    throw error;
  });
  return menuModule;
};

/** Прогрев (наведение, фокус, простой) молчит об отказе: о нём скажет жест, если он будет. */
const warmMenu = () => {
  loadMenu().catch(() => {});
};

/**
 * Забыть загруженный модуль — ТОЛЬКО для тестов: без этого все тесты файла, кроме первого, шли бы
 * с уже загруженным меню, и «жест до загрузки чанка» не проверялся бы вовсе.
 */
export function resetDetailMenuModuleForTests(): void {
  menuModule = null;
}

/** Жесты, которыми Radix открывает меню с клавиатуры (`DropdownMenu.Trigger`). */
const OPEN_KEYS = new Set(['Enter', ' ', 'ArrowDown']);

interface Mounted {
  Menu: typeof DetailMenu;
  open: boolean;
  focusTrigger: boolean;
}

/**
 * Кнопка меню ⋮, эагерная: видна и нажимаема с первого кадра, а само меню подгружается.
 *
 * Узел кнопки меняется на настоящий триггер Radix ровно в двух случаях — в простое браузера и по
 * жесту (click, клавиши открытия). На наведение и фокус — только прогрев модуля, БЕЗ смены узла:
 * заглушка, сменённая под пальцем (iOS шлёт pointerenter прямо перед касанием) или под фокусом,
 * теряла бы касание и фокус клавиатуры. Если узел всё же сменился в простое, пока фокус на
 * заглушке, — фокус возвращается новому триггеру (`focusTrigger`).
 *
 * Жест до загрузки чанка не теряется: меню встаёт уже открытым (`defaultOpen`). Своего `Suspense`
 * нет: меню монтируется загруженным модулем, так что заглушка не мигает запасным кадром.
 */
export function DetailMenuSlot(props: DetailMenuProps) {
  const [mounted, setMounted] = useState<Mounted | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  // Жест, пришедший до загрузки: меню, загрузившееся после него, обязано встать открытым — даже
  // если загрузку начал простой, а не сам жест.
  const wantOpenRef = useRef(false);
  /**
   * Отказ загрузки на ЖЕСТ — бросается из рендера к границе ошибок экрана (`ChunkErrorBoundary`):
   * там кадр «Не удалось открыть экран» с перезагрузкой, тот же, что давал `React.lazy` до
   * задачи 14. Кнопка, молча не делающая ничего, была бы хуже: человек не узнал бы, что меню нет.
   */
  const [loadError, setLoadError] = useState<{ error: unknown } | null>(null);
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const mount = useCallback((byGesture: boolean) => {
    loadMenu().then(
      (m) => {
        if (!aliveRef.current) return;
        setMounted(
          (prev) =>
            prev ?? {
              Menu: m.DetailMenu,
              open: wantOpenRef.current,
              focusTrigger: document.activeElement === buttonRef.current,
            },
        );
      },
      (error: unknown) => {
        // Отказ в простое — молча: человек ничего не нажимал, а кнопка жива, и жест повторит
        // загрузку. Отказ на жест — видимый (см. `loadError`).
        if (byGesture && aliveRef.current) setLoadError({ error });
      },
    );
  }, []);

  useEffect(() => {
    // Простоя в окружении может не быть (Safari, jsdom) — тогда меню ждёт жеста.
    if (typeof window.requestIdleCallback !== 'function') return;
    const id = window.requestIdleCallback(() => mount(false));
    return () => window.cancelIdleCallback?.(id);
  }, [mount]);

  if (loadError !== null) throw loadError.error;
  if (mounted !== null) {
    const { Menu } = mounted;
    return <Menu {...props} defaultOpen={mounted.open} focusTrigger={mounted.focusTrigger} />;
  }
  const open = () => {
    wantOpenRef.current = true;
    mount(true);
  };
  return (
    <MenuTrigger
      ref={buttonRef}
      onPointerEnter={warmMenu}
      onFocus={warmMenu}
      onClick={open}
      onKeyDown={(e) => {
        if (!OPEN_KEYS.has(e.key)) return;
        e.preventDefault();
        open();
      }}
    />
  );
}
