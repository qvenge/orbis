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
 * Проверка полей на каждый вид экрана. КАРТА, а не `switch` с `default`, и это не стиль:
 * `Record<ScreenRef['kind'], …>` заставляет компилятор потребовать строку для КАЖДОГО
 * нового вида. У `switch (kind: unknown)` такого сторожа нет — девятый вид `ScreenRef`
 * добавился бы молча, его записи истории отбрасывались бы валидацией, и вернулись бы
 * ровно те мёртвые нажатия «назад», которые чинил круг правок B2.
 */
const SCREEN_REF_GUARDS: Record<ScreenRef['kind'], (v: Record<string, unknown>) => boolean> = {
  entity: (v) => typeof v.id === 'string' && v.id.length > 0,
  'budget-category': (v) => typeof v.id === 'string' && v.id.length > 0,
  thread: (v) => typeof v.threadId === 'string' && v.threadId.length > 0,
  'budget-transactions': () => true,
  'budget-rollover': () => true,
  'budget-import': () => true,
  memory: () => true,
  settings: () => true,
};

/**
 * Форма `ScreenRef` из чужой записи — на веру не берётся. В `history.state` может лежать
 * что угодно (запись другого приложения на том же origin, ручной `pushState`, прежний
 * формат), а неизвестный `kind` доехал бы до `renderScreen` в router.tsx.
 */
function isScreenRef(value: unknown): value is ScreenRef {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  const kind = record.kind;
  // `hasOwn` обязателен: без него `{kind:'toString'}` достал бы метод прототипа, и чужая
  // запись прикинулась бы нашей.
  if (typeof kind !== 'string' || !Object.hasOwn(SCREEN_REF_GUARDS, kind)) return false;
  return SCREEN_REF_GUARDS[kind as ScreenRef['kind']](record);
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
 * Входящий адрес — и только если это вход СНАРУЖИ. Снимок обязан сниматься ДО
 * `installHistorySync`: установка канонизирует и путь, и `history.state`, и прочитанное
 * после неё уже описывает нас самих.
 *
 * Наша запись в `history.state` означает, что страницу открыли не по чужой ссылке:
 * это перезагрузка или возврат в уже открытое приложение (state записи браузеры хранят
 * между перезагрузками). Позицию там восстанавливает persist (§1.4), и считать такой
 * адрес внешней ссылкой значило бы срезать восстановленный стек до одного экрана
 * на КАЖДОЙ перезагрузке: §1.3 — про ссылки со стороны, а не про наши же адреса.
 */
export function externalEntryPath(): string | null {
  if (isNavHistoryState(window.history.state)) return null;
  return window.location.pathname;
}

/**
 * Вход снаружи: путь из адресной строки → позиция навигации (§1.3).
 *
 * Неразобранный путь (`/`, чужой путь, битый id) — `false` и НИ ОДНОГО изменения стора:
 * восстановленный из persist стек (§1.4) — лучшая догадка о том, где был пользователь,
 * чем корень чата, и терять его из-за незнакомого адреса не за что.
 *
 * Целевая вкладка сворачивается до корня и получает целевой экран сверху: прежний стек
 * ЭТОЙ вкладки ссылкой не сохраняется (§1.3). Стеки остальных вкладок не трогаются —
 * они приехали из persist и обязаны пережить вход по ссылке (§1.4).
 *
 * Двумя шагами, а не одним, и это главное здесь. У пришедшего по ссылке ровно один жест
 * «назад», и вести он обязан на корень ЦЕЛЕВОЙ вкладки: стек приложения не пуст, уводить
 * с сайта нечестно. Отдельный шаг «корень вкладки» подписка синхронизации превращает
 * в запись истории ПОД записью целевого экрана. Промежуточная позиция тут не артефакт
 * (ср. `closeToBudgetOverview`, где её сознательно избегают) — она и есть то, что должен
 * показать первый «назад». Без установленной синхронизации оба шага просто складываются
 * в одну позицию стора.
 *
 * ЭТО ВХОД СНАРУЖИ И ТОЛЬКО ОН. Функция сбрасывает стек целевой вкладки и переключает
 * вкладку — семантика §1.3 для чужой ссылки. Внутренней навигации по ссылке (клик по
 * `[[entity:<id>]]` в теле сущности, фаза C) нужна ДРУГАЯ семантика: push поверх текущего
 * стека ТЕКУЩЕЙ вкладки, без сброса и без переключения. Такого пути пока нет — собирать
 * его надо отдельно (`parseAppPath` + `appScreenToScreenRef` + `push` активной вкладки),
 * а не звать эту функцию: клик по ссылке в теле затирал бы стек Browser.
 *
 * Вызывается ОДИН раз при старте, ДО `installHistorySync`: записи истории стартовой
 * позиции расставляет `seedHistory`, а не подписка стора. Проверки «мы уже в целевой
 * позиции — делать нечего» здесь сознательно нет: позиция стора совпадает с целью ссылки
 * в самом обычном случае (ту же ссылку открыли второй раз, persist держит эту сущность
 * наверху), и ранний выход тогда экономил бы ровно ничего, а разбираться, почему при этом
 * не появился корень вкладки под экраном, пришлось бы долго.
 */
export function openDeepLink(path: string): boolean {
  const screen = parseAppPath(path);
  if (!screen) return false;

  const tab = tabOfScreen(screen);
  const ref = appScreenToScreenRef(screen);
  useNav.setState((s) => ({ activeTab: tab, stacks: { ...s.stacks, [tab]: ref ? [ref] : [] } }));
  return true;
}

/**
 * Расстановка записей истории под текущий стек активной вкладки — ровно один раз, при
 * входе в приложение (§1.4 + D18). Вызывать ДО `installHistorySync`: стор тут не меняется,
 * подписки ещё нет, и никакой встречной записи не возникает.
 *
 * Зачем вообще. `installHistorySync` пишет ОДНУ запись — текущую позицию, какой бы глубины
 * ни был восстановленный стек. Пользователь ушёл из приложения на detail-экране, вернулся
 * новой сессией (перезапуск PWA с иконки, новая вкладка) — стек из persist поднялся, а
 * записей под ним нет: «Назад» в шапке ведёт через `history.back()` и в standalone-PWA
 * не делает НИЧЕГО, а во вкладке браузера уводит с сайта. Стек восстановлен, а
 * разворачивать его нечем.
 *
 * Что пишем: корень активной вкладки `replaceState`'ом (текущая запись описывает позицию,
 * которой пользователь не видел, — адрес ссылки или канонизированный верх стека, и
 * оставлять её призраком под корнем незачем), затем по одной записи на каждый экран
 * стека. Последняя запись выходит той же позицией, что вернёт `position()`, поэтому
 * `installHistorySync` следом канонизирует её сам в себя, и внутреннее `last` подписки
 * оказывается верным без всякой договорённости между функциями.
 *
 * Стеки НЕактивных вкладок в историю не попадают — и не должны: запись истории описывает
 * ВИДИМУЮ позицию, а стеки других вкладок живут в persist и приезжают при переключении.
 */
export function seedHistory(): void {
  const { activeTab, stacks } = useNav.getState();
  const root: NavHistoryState = { tab: activeTab, depth: 0, screen: null };
  window.history.replaceState(root, '', buildAppPath({ kind: 'tab-root', tab: activeTab }));

  const stack = stacks[activeTab];
  for (const [i, screen] of stack.entries()) {
    const state: NavHistoryState = { tab: activeTab, depth: i + 1, screen };
    window.history.pushState(state, '', buildAppPath(screenRefToAppScreen(screen, activeTab)));
  }
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
