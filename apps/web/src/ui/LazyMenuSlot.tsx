import {
  type ComponentType,
  type KeyboardEvent,
  type ReactElement,
  type RefObject,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';

/**
 * Управление, которое слот отдаёт ленивому содержимому: меню не держит своего «открыто» —
 * хозяин состояния один, слот, и жест, пришедший до приезда чанка, не теряется.
 */
export interface LazyMenuControl {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Стабильная кнопка слота: якорь всплывающего списка и адресат возврата фокуса. */
  anchorRef: RefObject<HTMLButtonElement | null>;
  /**
   * id кнопки слота — имя списка (`aria-labelledby`) — и id самого списка (`aria-controls` кнопки).
   * Radix связал бы список со СВОИМ триггером, а он здесь — невидимый двойник без имени: меню
   * читалось бы без названия. Связь держит слот, хозяин кнопки.
   */
  triggerId: string;
  contentId: string;
}

/** Пропсы кнопки слота: всё, что делает её триггером меню с первого кадра. */
export interface LazyMenuTriggerProps {
  ref: RefObject<HTMLButtonElement | null>;
  id: string;
  'aria-haspopup': 'menu';
  /** Только пока список на экране: ссылка на отсутствующий узел читалке ни к чему. */
  'aria-controls': string | undefined;
  'aria-expanded': boolean;
  'data-state': 'open' | 'closed';
  onPointerDown: () => void;
  onClick: () => void;
  onKeyDown: (e: KeyboardEvent<HTMLButtonElement>) => void;
}

/**
 * Клавиши открытия — те же, что у `DropdownMenu.Trigger` Radix. Их `keydown` гасится: у кнопки
 * Enter и пробел дали бы ещё и click, а click переключает меню — открытое клавишей тут же
 * закрылось бы им.
 */
const OPEN_KEYS = new Set(['Enter', ' ', 'ArrowDown']);

/**
 * Ленивое меню: кнопка эагерная, видна и нажимаема с первого кадра, а содержимое (Radix-меню с
 * пунктами — самый крупный кусок, которому в первом кадре делать нечего) грузится НАЖАТИЕМ.
 *
 * Форма РП-13 «стабильный триггер + ленивое содержимое» (Л-1 живой приёмки 1а: «⋯» открывалось
 * со второго нажатия). Кнопка — ОДИН узел от первого кадра до размонтирования: слот рисует её
 * всегда на одном месте дерева, а содержимое после загрузки встаёт рядом, вторым ребёнком. Прежняя
 * форма подменяла заглушку настоящим триггером меню при приезде чанка — узел под пальцем и под
 * фокусом менялся, и жест мог пропасть. «Открыто» — состояние слота, а не меню: нажатие до приезда
 * чанка ставит его сразу (`aria-expanded` честен с первого жеста), приехавшее меню встаёт уже в нём,
 * и с теми пропсами, что есть в момент приезда, а не в момент нажатия.
 *
 * Прогрева нет — ни в простое, ни по наведению, ни по фокусу, и это не упущение: фоновый
 * `import()` запрещён правилом `app/chunk-reload.ts` (докблок «ОСТОРОЖНО с фоновой догрузкой»).
 * Vite шлёт `vite:preloadError` на ЛЮБОЙ провал `import()`, и `chunk-reload` перезагружает страницу
 * — человеку, который ничего не нажимал, вместе с недописанным текстом. Цена — один запрос при
 * первом открытии меню за сессию. Фора — с `pointerdown` (до click).
 *
 * Отказ загрузки на нажатие — из рендера к ближайшей границе ошибок (`ChunkErrorBoundary`: кадр
 * «Не удалось открыть экран» с перезагрузкой, как давал `React.lazy`); следующий жест (после
 * возврата на экран) грузит заново.
 *
 * Модуль эагерный: ни `./DropdownMenu`, ни `radix-ui` сюда не импортируются (только типы) — иначе
 * Radix уехал бы в чанк экрана, ради веса которого меню и ленивое.
 */
export function LazyMenuSlot<P extends object>({
  load,
  menuProps,
  renderTrigger,
}: {
  /** Загрузчик ленивого содержимого; ОДНА ссылка на функцию на всё приложение (модульная константа). */
  load: () => Promise<ComponentType<P & LazyMenuControl>>;
  menuProps: P;
  renderTrigger: (trigger: LazyMenuTriggerProps) => ReactElement;
}): ReactElement {
  // В обёртке: сам компонент — функция, и голую функцию `useState` принял бы за обновитель.
  const [loaded, setLoaded] = useState<{ Menu: ComponentType<P & LazyMenuControl> } | null>(null);
  const [loadError, setLoadError] = useState<{ error: unknown } | null>(null);
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  const triggerId = useId();
  const contentId = useId();
  // Загрузка в полёте (или удавшаяся): фора с pointerdown и click следом делят один запрос.
  // Отказ сбрасывает её — отвергнутый промис здесь делал бы кнопку мёртвой до ухода с экрана.
  const pendingRef = useRef<Promise<ComponentType<P & LazyMenuControl>> | null>(null);
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const start = () => {
    if (pendingRef.current === null) {
      const pending = load();
      pendingRef.current = pending;
      pending.catch(() => {
        if (pendingRef.current === pending) pendingRef.current = null;
      });
    }
    return pendingRef.current;
  };

  /** Жест открытия: содержимое встанет, когда модуль готов; до этого «открыто» ждёт его. */
  const ensure = () => {
    if (loaded !== null) return;
    start().then(
      (Menu) => {
        if (aliveRef.current) setLoaded((prev) => prev ?? { Menu });
      },
      (error: unknown) => {
        if (aliveRef.current) setLoadError({ error });
      },
    );
  };

  if (loadError !== null) throw loadError.error;
  return (
    <span className="relative inline-flex">
      {renderTrigger({
        ref: anchorRef,
        id: triggerId,
        'aria-haspopup': 'menu',
        'aria-controls': open && loaded !== null ? contentId : undefined,
        'aria-expanded': open,
        'data-state': open ? 'open' : 'closed',
        // Фора загрузке — с первого касания. Её отказ молчит: click следом повторит загрузку и,
        // откажи она снова, скажет об этом сам.
        onPointerDown: () => {
          if (loaded === null) start().catch(() => {});
        },
        onClick: () => {
          setOpen((o) => !o);
          ensure();
        },
        onKeyDown: (e) => {
          if (!OPEN_KEYS.has(e.key)) return;
          e.preventDefault();
          setOpen(true);
          ensure();
        },
      })}
      {loaded !== null && (
        <loaded.Menu
          {...menuProps}
          open={open}
          onOpenChange={setOpen}
          anchorRef={anchorRef}
          triggerId={triggerId}
          contentId={contentId}
        />
      )}
    </span>
  );
}
