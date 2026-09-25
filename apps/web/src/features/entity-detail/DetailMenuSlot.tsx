import { useCallback, useEffect, useRef, useState } from 'react';
import type { DetailMenu, DetailMenuProps } from './DetailMenu';
import { MenuTrigger } from './MenuTrigger';

/**
 * Меню ⋮ живёт в своём чанке (рычаг веса РП-11 задачи 14 страниц 1а: чанк экрана записи вырос
 * шаблоном хоста за порог +15 %, а Radix-меню — самый крупный кусок, которому в первом кадре
 * делать нечего). Промис загрузки один на приложение.
 *
 * Отказ загрузки промис НЕ запоминает: отвергнутый промис в кеше делал бы кнопку мёртвой до
 * перезагрузки страницы, и следующее нажатие даже не попыталось бы снова.
 */
let menuModule: Promise<typeof import('./DetailMenu')> | null = null;
const loadMenu = () => {
  menuModule ??= import('./DetailMenu').catch((error: unknown) => {
    menuModule = null;
    throw error;
  });
  return menuModule;
};

/**
 * Забыть загруженный модуль — ТОЛЬКО для тестов: без этого все тесты файла, кроме первого, шли бы
 * с уже загруженным меню, и «нажатие до загрузки чанка» не проверялось бы вовсе.
 */
export function resetDetailMenuModuleForTests(): void {
  menuModule = null;
}

/** Клавиши, которыми Radix открывает меню (`DropdownMenu.Trigger`); Enter и пробел — ещё и click. */
const OPEN_KEYS = new Set(['Enter', ' ', 'ArrowDown']);

/**
 * Кнопка меню ⋮, эагерная: видна и нажимаема с первого кадра, а само меню грузится НАЖАТИЕМ.
 *
 * Прогрева нет — ни в простое, ни по наведению, ни по фокусу, и это не упущение: фоновый
 * `import()` запрещён правилом `app/chunk-reload.ts` (докблок «ОСТОРОЖНО с фоновой догрузкой»).
 * Vite шлёт `vite:preloadError` на ЛЮБОЙ провал `import()`, и `chunk-reload` перезагружает страницу
 * — человеку, который ничего не нажимал, вместе с недописанным текстом. Цена — один запрос
 * (≈9 кБ gzip) при первом открытии меню за сессию.
 *
 * Загрузка начинается с `pointerdown` (фора до click) или с клавиши открытия; меню монтируется
 * открытым по click или клавише, когда модуль готов, — нажатие не теряется. До этого узел кнопки
 * не меняется: заглушка, сменённая между pointerdown и click, забрала бы click с собой, а сменённая
 * под фокусом — фокус. Открытое меню Radix уводит фокус в свои пункты и при закрытии возвращает
 * его своему триггеру.
 *
 * Отказ загрузки на нажатие — из рендера к границе ошибок экрана (`ChunkErrorBoundary`: кадр
 * «Не удалось открыть экран» с перезагрузкой, как давал `React.lazy`); следующее нажатие (после
 * возврата на экран) грузит заново.
 */
export function DetailMenuSlot(props: DetailMenuProps) {
  // В обёртке: сам компонент — функция, и голую функцию `useState` принял бы за обновитель.
  const [loaded, setLoaded] = useState<{ Menu: typeof DetailMenu } | null>(null);
  const [loadError, setLoadError] = useState<{ error: unknown } | null>(null);
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  /** Жест открытия: смонтировать меню открытым, когда модуль готов. */
  const open = useCallback(() => {
    loadMenu().then(
      (m) => {
        if (aliveRef.current) setLoaded((prev) => prev ?? { Menu: m.DetailMenu });
      },
      (error: unknown) => {
        if (aliveRef.current) setLoadError({ error });
      },
    );
  }, []);

  if (loadError !== null) throw loadError.error;
  if (loaded !== null) return <loaded.Menu {...props} defaultOpen />;
  return (
    <MenuTrigger
      // Фора загрузке — с первого касания, до click. Её отказ молчит: click следом повторит
      // загрузку и, откажи она снова, скажет об этом сам.
      onPointerDown={() => {
        loadMenu().catch(() => {});
      }}
      onClick={open}
      onKeyDown={(e) => {
        if (!OPEN_KEYS.has(e.key)) return;
        e.preventDefault();
        open();
      }}
    />
  );
}
