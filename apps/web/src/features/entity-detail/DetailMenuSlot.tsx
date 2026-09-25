import { useCallback, useEffect, useRef, useState } from 'react';
import type { DetailMenu, DetailMenuProps } from './DetailMenu';
import { MenuTrigger } from './MenuTrigger';

/**
 * Меню ⋮ живёт в своём чанке (рычаг веса РП-11 задачи 14 страниц 1а: чанк экрана записи вырос
 * шаблоном хоста за порог +15 %, а Radix-меню — самый крупный кусок, которому в первом кадре
 * делать нечего). Промис загрузки один на приложение: прогрев и загрузка ведут к тому же модулю.
 */
let menuModule: Promise<typeof import('./DetailMenu')> | null = null;
const loadMenu = () => {
  menuModule ??= import('./DetailMenu');
  return menuModule;
};

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
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const mount = useCallback(() => {
    void loadMenu().then((m) => {
      if (!aliveRef.current) return;
      setMounted(
        (prev) =>
          prev ?? {
            Menu: m.DetailMenu,
            open: wantOpenRef.current,
            focusTrigger: document.activeElement === buttonRef.current,
          },
      );
    });
  }, []);

  useEffect(() => {
    // Простоя в окружении может не быть (Safari, jsdom) — тогда меню ждёт жеста.
    if (typeof window.requestIdleCallback !== 'function') return;
    const id = window.requestIdleCallback(mount);
    return () => window.cancelIdleCallback?.(id);
  }, [mount]);

  if (mounted !== null) {
    const { Menu } = mounted;
    return <Menu {...props} defaultOpen={mounted.open} focusTrigger={mounted.focusTrigger} />;
  }
  const open = () => {
    wantOpenRef.current = true;
    mount();
  };
  return (
    <MenuTrigger
      ref={buttonRef}
      onPointerEnter={() => void loadMenu()}
      onFocus={() => void loadMenu()}
      onClick={open}
      onKeyDown={(e) => {
        if (!OPEN_KEYS.has(e.key)) return;
        e.preventDefault();
        open();
      }}
    />
  );
}
