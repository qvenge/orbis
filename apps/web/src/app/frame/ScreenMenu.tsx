import { EllipsisVertical, LayoutGrid, Puzzle, Settings } from 'lucide-react';
import {
  type ComponentType,
  createContext,
  type ReactElement,
  type ReactNode,
  useContext,
  useMemo,
} from 'react';
import { useNav } from '../../state/navigation';
import type { DropdownMenuItem } from '../../ui/DropdownMenu';
import { type LazyMenuControl, LazyMenuSlot } from '../../ui/LazyMenuSlot';

/**
 * Что получает ленивое содержимое меню «⋯» (спека 1б §6.4): управление слота и пункты раздела
 * «Хост». Содержимое рисует ОДНО меню с двумя разделами — «Этот экран» (свои пункты) и «Хост».
 */
export type ScreenMenuContentProps = LazyMenuControl & {
  hostItems: readonly DropdownMenuItem[];
};

interface ScreenMenuSource {
  // biome-ignore lint/suspicious/noExplicitAny: пропсы содержимого знает экран, слот их лишь передаёт
  load: () => Promise<ComponentType<any>>;
  props: object;
}

const ScreenMenuContext = createContext<ScreenMenuSource | null>(null);

/**
 * Экран отдаёт пункты раздела «Этот экран» (спека 1б §6.4, РП-19): ЗАГРУЗЧИК ленивого содержимого
 * (модульная константа экрана — одна ссылка на приложение) и его пропсы. Кнопка «⋯» — в присутствии
 * хоста, эагерная; содержимое, Radix и пункты — в ленивом чанке экрана (для записи — `DetailMenu`,
 * сторож `LAZY_DETAIL_MODULES`). Экран без провайдера получает меню с одним разделом «Хост».
 */
export function ScreenMenuProvider<P extends object>({
  items,
  props,
  children,
}: {
  items: () => Promise<ComponentType<P & ScreenMenuContentProps>>;
  props: P;
  children: ReactNode;
}): ReactElement {
  const value = useMemo(() => ({ load: items, props }), [items, props]);
  return <ScreenMenuContext.Provider value={value}>{children}</ScreenMenuContext.Provider>;
}

/** Меню экрана без своих пунктов — только раздел «Хост». Одна ссылка на загрузчик на приложение. */
const loadHostMenu = () => import('./HostMenu').then((m) => m.HostMenu);

/** Номер загрузчика — ключ слота: другой экран — другое содержимое, и слот встаёт заново. */
const loaderIds = new WeakMap<object, number>();
let nextLoaderId = 0;
function loaderKey(load: object): number {
  let id = loaderIds.get(load);
  if (id === undefined) {
    id = nextLoaderId++;
    loaderIds.set(load, id);
  }
  return id;
}

/**
 * Одно меню «⋯» экрана (спека 1б §6.4): отдельной иконки настроек в шапке больше нет. Кнопка —
 * стабильный триггер общей механики (`ui/LazyMenuSlot`, задача 1): один узел от первого кадра,
 * открывается с первого нажатия и при медленном чанке пунктов.
 *
 * Раздел «Хост»: «Все приложения» (задача 20 наполнит переключателем; пока — «Домой» хоста, где
 * будет блок «Приложения»), «Приложения и расширения» и «Настройки» — экран настроек.
 */
export function ScreenMenu(): ReactElement {
  const source = useContext(ScreenMenuContext);
  const hostItems = useMemo<DropdownMenuItem[]>(
    () => [
      {
        label: 'Все приложения',
        icon: <LayoutGrid size={16} aria-hidden />,
        onSelect: () => useNav.getState().goHome(),
      },
      {
        label: 'Приложения и расширения',
        icon: <Puzzle size={16} aria-hidden />,
        onSelect: () => useNav.getState().openHostScreen('settings'),
      },
      {
        label: 'Настройки',
        icon: <Settings size={16} aria-hidden />,
        onSelect: () => useNav.getState().openHostScreen('settings'),
      },
    ],
    [],
  );
  const load = source?.load ?? loadHostMenu;
  const menuProps = useMemo(
    () => ({ ...(source?.props ?? {}), hostItems }),
    [source?.props, hostItems],
  );
  return (
    <LazyMenuSlot
      key={loaderKey(load)}
      load={load}
      menuProps={menuProps}
      renderTrigger={(t) => (
        <button
          type="button"
          aria-label="Меню"
          title="Меню"
          data-testid="screen-menu"
          {...t}
          className={HOST_CONTROL}
        >
          <EllipsisVertical size={18} aria-hidden />
        </button>
      )}
    />
  );
}

/**
 * Кнопка присутствия хоста: тёмная сплошная (токены `host`, контраст ≥ 4.5:1 в обеих темах —
 * `styles/tokens.css`), мишень касания 44 px. Приложение нарисовать такую не может — это доверие
 * (спека §6.2 п. 5).
 */
export const HOST_CONTROL =
  'inline-flex size-11 shrink-0 cursor-pointer items-center justify-center rounded-full bg-host text-host-foreground transition hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60';
