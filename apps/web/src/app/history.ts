// Синхронизация навигации с историей браузера (02-core-os §1.3, решение D18).
//
// У навигации два носителя: стор `useNav` (что рисуем) и сессионная история браузера
// (куда ведёт системный жест «назад» и что показывает адресная строка). Модуль держит
// их в согласии и, главное, следит, чтобы инициатива в каждый момент была РОВНО ОДНА:
// пока мы применяем `popstate` к стору, подписчик стора в историю не пишет — иначе
// каждый «назад» тут же порождал бы новую запись, и петля push↔popstate съела бы жест.
//
// Запись истории хранит не путь, а позицию целиком: вкладку, глубину её стека и САМ
// верхний экран. Пути мало по двум причинам сразу. Во-первых, пять экранов
// (`budget-transactions`, `budget-rollover`, `budget-import`, `memory`, `settings`)
// собственного маршрута не имеют и дают тот же `/budget`|`/chat`, что и корень вкладки, —
// по пути их не отличить ни от корня, ни друг от друга. Во-вторых, экран, снятый со
// стека, из пути тогда не восстановить: «назад» на такую запись не менял бы ничего,
// и пользователь получал бы мёртвые нажатия. Экран в записи снимает оба случая.
// Класть его туда законно: `history.state` структурно клонируется, а все восемь вариантов
// `ScreenRef` — простые JSON-совместимые объекты без функций.
import { type AppScreen, buildAppPath, parseAppPath, tabOfScreen } from '@orbis/shared';
import { type ScreenRef, type Tab, useNav } from '../state/navigation';

/** Что лежит в `history.state`: вкладка, глубина её стека и верхний экран (корень — null). */
export type NavHistoryState = { tab: Tab; depth: number; screen: ScreenRef | null };

const TABS: readonly Tab[] = ['chat', 'browser', 'agenda', 'budget'];

/**
 * Форма `ScreenRef` из чужой записи — на веру не берётся. В `history.state` может лежать
 * что угодно (запись другого приложения на том же origin, ручной `pushState`, прежний
 * формат), а неизвестный `kind` доехал бы до `renderScreen` в router.tsx.
 */
function isScreenRef(value: unknown): value is ScreenRef {
  if (typeof value !== 'object' || value === null) return false;
  const { kind, id, threadId } = value as { kind?: unknown; id?: unknown; threadId?: unknown };
  switch (kind) {
    case 'entity':
    case 'budget-category':
      return typeof id === 'string' && id.length > 0;
    case 'thread':
      return typeof threadId === 'string' && threadId.length > 0;
    case 'budget-transactions':
    case 'budget-rollover':
    case 'budget-import':
    case 'memory':
    case 'settings':
      return true;
    default:
      return false;
  }
}

/** Запись целиком: либо она наша и полная, либо не наша — половинчатой не бывает. */
function isNavHistoryState(value: unknown): value is NavHistoryState {
  if (typeof value !== 'object' || value === null) return false;
  const { tab, depth, screen } = value as { tab?: unknown; depth?: unknown; screen?: unknown };
  if (!TABS.includes(tab as Tab)) return false;
  if (!Number.isInteger(depth) || (depth as number) < 0) return false;
  return screen === null || isScreenRef(screen);
}

/**
 * Экран стора → экран контракта B1: это про ПУТЬ, а не про восстановление. Пятёрка
 * экранов без собственного маршрута отображается в корень своей вкладки — внешней ссылки
 * у них нет, и адресная строка честно показывает вкладку. Восстанавливаются они не отсюда,
 * а из поля `screen` записи.
 */
function screenRefToAppScreen(ref: ScreenRef, tab: Tab): AppScreen {
  switch (ref.kind) {
    case 'entity':
      return { kind: 'entity', id: ref.id };
    case 'thread':
      return { kind: 'thread', threadId: ref.threadId };
    case 'budget-category':
      return { kind: 'budget-category', id: ref.id };
    case 'budget-transactions':
    case 'budget-rollover':
    case 'budget-import':
    case 'memory':
    case 'settings':
      return { kind: 'tab-root', tab };
  }
}

/** Обратное преобразование — только для маршрутизируемых экранов (нужно фолбэку по пути). */
function appScreenToScreenRef(screen: AppScreen): ScreenRef | null {
  switch (screen.kind) {
    case 'entity':
      return { kind: 'entity', id: screen.id };
    case 'thread':
      return { kind: 'thread', threadId: screen.threadId };
    case 'budget-category':
      return { kind: 'budget-category', id: screen.id };
    case 'tab-root':
      return null;
  }
}

type Position = { state: NavHistoryState; path: string };

/** Текущая видимая позиция: что писать в `history.state` и какой показывать путь. */
function position(): Position {
  const { activeTab, stacks } = useNav.getState();
  const stack = stacks[activeTab];
  const top = stack.at(-1);
  const screen: AppScreen = top
    ? screenRefToAppScreen(top, activeTab)
    : { kind: 'tab-root', tab: activeTab };
  return {
    state: { tab: activeTab, depth: stack.length, screen: top ?? null },
    path: buildAppPath(screen),
  };
}

// Разделитель — ПРОБЕЛ: его не бывает ни в имени вкладки, ни в числе, ни в пути, ни в
// `kind` экрана, так что соседние поля не склеятся. Печатный символ выбран сознательно —
// управляющий байт 0x00 в исходнике однажды уже сделал этот файл бинарным для git.
const keyOf = (p: Position) =>
  `${p.state.tab} ${p.state.depth} ${p.path} ${p.state.screen?.kind ?? ''}`;

/**
 * История → стор. Пишем через `setState`, а НЕ через действия стора: у действий свои
 * правила (§1.1 — `switchTab` по уже активной вкладке сворачивает её стек), и применять
 * ими чужое состояние — верный способ разъехаться с историей.
 *
 * Верх стека берётся ИЗ ЗАПИСИ, глубина решает, сколько стека остаётся под ним. Путь тут
 * не участвует вовсе — он остаётся тем, что видит пользователь в адресной строке.
 * Исключение одно: записи без нашего состояния (чужие, битые, вход по прямой ссылке)
 * читаются по пути через `parseAppPath` — это же место понадобится B3.
 */
function applyState(state: NavHistoryState | null, path: string): void {
  let resolved = state;
  if (!resolved) {
    const parsed = parseAppPath(path);
    if (!parsed) return; // ни записи, ни разбираемого пути — трогать стор не за что
    const ref = appScreenToScreenRef(parsed);
    resolved = { tab: tabOfScreen(parsed), depth: ref ? 1 : 0, screen: ref };
  }

  const { tab, depth, screen } = resolved;
  useNav.setState((s) => {
    const stack = s.stacks[tab];
    const next =
      depth > 0 && screen ? [...stack.slice(0, depth - 1), screen] : stack.slice(0, depth);
    return { activeTab: tab, stacks: { ...s.stacks, [tab]: next } };
  });
}

// Инициатива у истории: пока флаг поднят, подписчик стора в историю НЕ пишет.
let applyingHistory = false;
// Активная установка. Повторная установка снимает предыдущую сама: в StrictMode эффект
// ставится дважды, и две живые подписки писали бы по две записи на одно перемещение.
let activeUninstall: (() => void) | null = null;

export function installHistorySync(): () => void {
  activeUninstall?.();

  // Стартовая запись канонизирует адрес: `replaceState` новых записей не добавляет,
  // поэтому переустановка безопасна. Позиция берётся из стора уже после гидрации
  // persist (§1.4) — она синхронна и происходит при импорте модуля стора.
  let last = position();
  window.history.replaceState(last.state, '', last.path);

  const unsubscribe = useNav.subscribe(() => {
    const next = position();
    if (applyingHistory) {
      // Позицию всё равно запоминаем: иначе следующий приход ровно в неё сочтётся
      // «без изменений» и запись истории потеряется.
      last = next;
      return;
    }
    // Пишем только при смене ВИДИМОЙ позиции. `push` в неактивную вкладку меняет stacks,
    // но не то, что видит пользователь; записи-двойники сделали бы «назад» залипающим —
    // один жест, ноль изменений на экране.
    if (keyOf(next) === keyOf(last)) return;
    last = next;
    window.history.pushState(next.state, '', next.path);
  });

  const onPop = (event: PopStateEvent) => {
    applyingHistory = true;
    try {
      applyState(isNavHistoryState(event.state) ? event.state : null, window.location.pathname);
      // Самоизлечение записи. Прыжок по истории больше чем на шаг (выпадающий список
      // браузера, долгий тап по «назад») просит глубину, которой в стеке уже нет:
      // экраны под верхним остались в пропущенных записях, и взять их неоткуда. Стек
      // тогда честно короче запрошенного — но запись обязана описывать то, что РЕАЛЬНО
      // в сторе, иначе следующий «назад» соберёт стек не из тех экранов. `replaceState`
      // новых записей не создаёт, петли это не даёт.
      last = position();
      window.history.replaceState(last.state, '', last.path);
    } finally {
      applyingHistory = false;
    }
  };
  window.addEventListener('popstate', onPop);

  const uninstall = () => {
    // Идемпотентно: отписка, которую уже вытеснила повторная установка, ничего не делает.
    if (activeUninstall !== uninstall) return;
    activeUninstall = null;
    unsubscribe();
    window.removeEventListener('popstate', onPop);
  };
  activeUninstall = uninstall;
  return uninstall;
}

/**
 * Единственная точка «назад» для UI: и кнопка шапки, и системный жест ведут через историю.
 * Прямой `pop` по стору при живой подписке породил бы НОВУЮ запись истории вместо отката —
 * кнопка «Назад» уводила бы вперёд.
 *
 * Асинхронно по природе: браузер доставит `popstate` следующим тиком.
 */
export function goBack(): void {
  window.history.back();
}
