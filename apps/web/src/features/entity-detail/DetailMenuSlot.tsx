import { LazyMenuSlot } from '../../ui/LazyMenuSlot';
import type { DetailMenuProps } from './DetailMenu';
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

/** Загрузчик содержимого слота — модульная константа: одна ссылка на функцию на всё приложение. */
const loadDetailMenu = () => loadMenu().then((m) => m.DetailMenu);

/**
 * Кнопка меню ⋮ экрана записи: тонкая обёртка над общей механикой ленивого меню
 * (`ui/LazyMenuSlot`, форма РП-13). Кнопка — один узел от первого кадра, «открыто» держит слот,
 * ленивый чанк несёт только всплывающий список с пунктами и диалогами (`DetailMenu`). Прогрев,
 * клавиши открытия и отказ загрузки — там же, в механике.
 */
export function DetailMenuSlot(props: DetailMenuProps) {
  return (
    <LazyMenuSlot
      load={loadDetailMenu}
      menuProps={props}
      renderTrigger={(t) => <MenuTrigger {...t} />}
    />
  );
}
