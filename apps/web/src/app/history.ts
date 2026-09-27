/**
 * История браузера под моделью навигации (срез 1б §7.3, РП-18): одна модель — два поведения.
 *
 * Модель (`@orbis/shared/nav`) решает, КАКОЕ место на экране и КАКОЙ эффект у перехода; здесь эффект
 * применяется к истории браузера:
 *  - «как сайт» (вкладка браузера): каждый переход — честная запись `pushState` со СНИМКОМ модели;
 *    «назад» браузера не подменяем — `popstate` восстанавливает модель из снимка записи. Снимок, а не
 *    путь: по пути не восстановить ни стопки разделов, ни источник перехода, ни состояние экрана;
 *  - «как приложение» (PWA, WebView): одна запись Orbis и над ней ОХРАННАЯ запись. Системный «назад»
 *    снимает охранную — `popstate` — и работает как «‹» по модели, после чего охранная запись
 *    ставится снова. На дне стопки хоста (эффект `exit`) запись не возвращается и «назад» уходит
 *    дальше: Android закрывает Orbis (§7.3).
 * Эффект `none` («‹» в режиме приложения) обязан обновить адресную строку (`replaceState` на адрес
 * нового верха) — иначе перезагрузка открыла бы снятое место (контракт `NavEffect`, гейт 15 M-2).
 *
 * Индекс записи в `history.state` (`idx`) ведёт эта сторона (R-24): 0 — первая запись Orbis во
 * вкладке. На ней «‹» хоста идёт по модели (позади не Orbis — `history.back()` увёл бы на чужой сайт),
 * а «‹» показывается, если есть куда по модели или позади есть запись Orbis.
 *
 * Страж ухода: «‹» спрашивает его в сторе; системный «назад» — здесь, в `popstate`, кроме того
 * `popstate`, который вызвали мы сами по «‹» (страж уже сказал «да», второй вопрос дал бы второй
 * досыл и второй тост). Сказал «нет» — место не меняется, а снятая браузером запись возвращается.
 */
import {
  type Address,
  buildAddress,
  currentEntry,
  HOST_APP,
  initialModel,
  type NavEffect,
  type NavModel,
  navReduce,
  parseAddress,
} from '@orbis/shared/nav';
import { mayLeave } from '../state/leave-guard';
import {
  appKeyOf,
  connectHistoryPort,
  HOST_HOME,
  type NavOverlay,
  readPersistedNav,
  sectionRoot,
  setNavState,
  useNav,
} from '../state/navigation';
import { readLaunchMode } from './launch-mode';

/** Что лежит в `history.state` записи Orbis. `guard` — охранная запись режима приложения. */
interface NavHistoryState {
  orbisNav: 2;
  idx: number;
  guard?: true;
  model: NavModel;
  overlay: NavOverlay | null;
}

function isObj(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

/** Адрес из чужих рук: той ли он формы и переживает ли круг «собрать → разобрать». */
function isAddress(x: unknown): x is Address {
  if (!isObj(x)) return false;
  try {
    const path = buildAddress(x as Address);
    const parsed = parseAddress(path);
    return parsed !== null && parsed.kind === x.kind && buildAddress(parsed as Address) === path;
  } catch {
    return false;
  }
}

/**
 * Модель из записи истории — на веру не берётся: в `history.state` бывает что угодно (запись 1а
 * `{tab, depth, screen}` после выкатки, чужой `pushState` того же origin, прежняя форма). Проверка —
 * форма стопок и адреса каждого экрана; битая — `false`, и место читается по адресной строке.
 */
function isNavModel(x: unknown): x is NavModel {
  if (!isObj(x) || typeof x.activeApp !== 'string' || !isObj(x.apps)) return false;
  for (const nav of Object.values(x.apps)) {
    if (!isObj(nav) || typeof nav.activeSection !== 'string' || !isObj(nav.stacks)) return false;
    for (const stack of Object.values(nav.stacks)) {
      if (!Array.isArray(stack)) return false;
      for (const e of stack) {
        if (!isObj(e) || !isAddress(e.address)) return false;
        if (e.source !== undefined) {
          const src = e.source;
          if (!isObj(src) || typeof src.app !== 'string' || typeof src.section !== 'string')
            return false;
        }
        if (e.view !== undefined) {
          if (!isObj(e.view) || Object.values(e.view).some((v) => typeof v !== 'string'))
            return false;
        }
      }
    }
  }
  return true;
}

function isOverlay(x: unknown): x is NavOverlay | null {
  if (x === null) return true;
  if (!isObj(x) || typeof x.path !== 'string') return false;
  if (x.kind === 'reserved') return x.key === 'budget' || x.key === 'agenda';
  if (x.kind === 'legacy-thread') return typeof x.threadId === 'string';
  if (x.kind === 'legacy-supply') return x.key === 'records';
  return false;
}

function isNavHistoryState(x: unknown): x is NavHistoryState {
  return (
    isObj(x) &&
    x.orbisNav === 2 &&
    Number.isInteger(x.idx) &&
    (x.idx as number) >= 0 &&
    isNavModel(x.model) &&
    isOverlay(x.overlay)
  );
}

// ─── состояние стороны истории ────────────────────────────────────────────────────────────────

/** Индекс текущей записи Orbis во вкладке (сайт). */
let idx = 0;
/** `popstate`, который мы вызвали сами (`history.back()` по «‹») — страж уже спрошен. */
let expectingPop = false;
/** Режим приложения: отпустили системный «назад» (дно хоста) — дальше не перехватываем. */
let leaving = false;

function urlNow(): string {
  const { model, overlay } = useNav.getState();
  return overlay !== null ? overlay.path : buildAddress(currentEntry(model).address);
}

function snapshot(guard = false): NavHistoryState {
  const { model, overlay } = useNav.getState();
  return { orbisNav: 2, idx, model, overlay, ...(guard && { guard: true as const }) };
}

function applyEffect(effect: NavEffect): void {
  const { mode } = useNav.getState();
  if (mode === 'app') {
    if (effect.history === 'exit') {
      // «‹» на дне хоста не показывается; сюда доходит только прямой вызов. Уходим за базовую
      // запись и охранную разом.
      leaving = true;
      window.history.go(-2);
      return;
    }
    // Одна запись истории: охранная запись описывает текущее место.
    window.history.replaceState(snapshot(true), '', urlNow());
    return;
  }
  switch (effect.history) {
    case 'push':
      idx += 1;
      window.history.pushState(snapshot(), '', urlNow());
      return;
    case 'replace':
    case 'none':
      window.history.replaceState(snapshot(), '', urlNow());
      return;
    case 'back':
    case 'exit':
      expectingPop = true;
      window.history.back();
      return;
  }
}

// ─── старт ─────────────────────────────────────────────────────────────────────────────────────

/** Модель + адрес ссылки → модель на этом месте (вход снаружи). */
function enterAddress(model: NavModel, a: Address, mode: 'app' | 'site'): NavModel {
  if (a.kind === 'home' && a.app.kind === 'host') return model;
  if (a.kind === 'host-screen')
    return navReduce(model, { type: 'host-screen', address: a }, mode).model;
  const app = appKeyOf(a.app);
  if (a.kind === 'home')
    return navReduce(model, { type: 'switch-app', app, home: a, toHome: true }, mode).model;
  return navReduce(model, { type: 'open', address: a, app, from: 'content' }, mode).model;
}

/**
 * Старт навигации — ОДИН раз при монтировании приложения, до первого кадра экрана.
 *
 * Своя запись в `history.state` — перезагрузка или возврат в уже открытую вкладку: место — из
 * снимка записи (браузер хранит его между перезагрузками), ничего не пишется. Иначе — вход: модель
 * из сохранения `orbis:nav:v2` (активный раздел и последнее место каждого раздела, глубина — нет),
 * поверх — место из ссылки. `/` — ссылки нет, остаётся сохранённое место (так стартует PWA с иконки);
 * старые ссылки переводятся (§7.1), неразобранный путь — как `/`.
 */
export function startNavigation(): void {
  const mode = readLaunchMode();
  leaving = false;
  expectingPop = false;
  const own = window.history.state;
  if (isNavHistoryState(own)) {
    idx = own.idx;
    setNavState({ model: own.model, overlay: own.overlay, mode });
    // Перезагрузка в режиме приложения на базовой записи (охранную уже сняли) — вернуть охранную.
    if (mode === 'app' && own.guard !== true) {
      window.history.pushState(snapshot(true), '', urlNow());
    }
    return;
  }

  let model = readPersistedNav() ?? initialModel(HOST_HOME);
  let overlay: NavOverlay | null = null;
  const path = window.location.pathname + window.location.search;
  const parsed = parseAddress(path);
  if (parsed !== null) {
    switch (parsed.kind) {
      case 'home':
      case 'record':
      case 'host-screen':
        model = enterAddress(model, parsed, mode);
        break;
      case 'legacy-thread':
        overlay = { kind: 'legacy-thread', threadId: parsed.threadId, path };
        break;
      case 'legacy-supply':
        overlay = { kind: 'legacy-supply', key: parsed.key, path };
        break;
      case 'reserved':
        overlay = { kind: 'reserved', key: parsed.key, path };
        break;
    }
  }
  idx = 0;
  setNavState({ model, overlay, mode });
  if (mode === 'site') {
    window.history.replaceState(snapshot(), '', urlNow());
  } else {
    // База и охранная над ней: системный «назад» снимет охранную, и `popstate` его перехватит.
    window.history.replaceState(snapshot(), '', urlNow());
    window.history.pushState(snapshot(true), '', urlNow());
  }
}

/**
 * Старая ссылка разрешилась (запись треда нашлась, запись «Записей» приехала): место встаёт ВМЕСТО
 * экрана-посредника — заменой записи, а не новым шагом: «назад» с него вёл бы на пустой переход.
 */
export function settleOverlay(
  target: { kind: 'address'; address: Address } | { kind: 'section'; section: string },
): void {
  const { model, mode } = useNav.getState();
  const next =
    target.kind === 'section'
      ? navReduce(
          model,
          {
            type: 'section',
            app: HOST_APP,
            section: target.section,
            root: sectionRoot(HOST_APP, target.section),
          },
          mode,
        ).model
      : enterAddress(model, target.address, mode);
  setNavState({ model: next, overlay: null });
  window.history.replaceState(snapshot(mode === 'app'), '', urlNow());
}

// ─── popstate ──────────────────────────────────────────────────────────────────────────────────

function onPopSite(event: PopStateEvent): void {
  const ours = expectingPop;
  expectingPop = false;
  if (!ours && !mayLeave()) {
    // Браузер уже сдвинулся; вернуть запись экрана, с которого не ушли.
    window.history.pushState(snapshot(), '', urlNow());
    return;
  }
  const st: unknown = event.state;
  if (isNavHistoryState(st)) {
    idx = st.idx;
    setNavState({ model: st.model, overlay: st.overlay });
    return;
  }
  // Запись не наша (чужой pushState, запись 1а после выкатки): место — по адресной строке.
  const parsed = parseAddress(window.location.pathname + window.location.search);
  const { model, mode } = useNav.getState();
  const next =
    parsed !== null &&
    (parsed.kind === 'home' || parsed.kind === 'record' || parsed.kind === 'host-screen')
      ? enterAddress(model, parsed, mode)
      : model;
  setNavState({ model: next, overlay: null });
  window.history.replaceState(snapshot(), '', urlNow());
}

function onPopApp(event: PopStateEvent): void {
  // Шаг вперёд на охранную запись (браузерная «вперёд» в окне PWA) — не «назад».
  if (isNavHistoryState(event.state) && event.state.guard === true) return;
  if (leaving) return;
  if (!mayLeave()) {
    window.history.pushState(snapshot(true), '', urlNow());
    return;
  }
  const { model, overlay } = useNav.getState();
  if (overlay !== null) {
    setNavState({ model, overlay: null });
  } else {
    const r = navReduce(model, { type: 'back' }, 'app');
    if (r.effect.history === 'exit') {
      // Дно стопки хоста: системный «назад» отпускается — Orbis закрывается (§7.3).
      leaving = true;
      window.history.back();
      return;
    }
    setNavState({ model: r.model, overlay: null });
  }
  window.history.replaceState(snapshot(), '', urlNow());
  window.history.pushState(snapshot(true), '', urlNow());
}

let activeUninstall: (() => void) | null = null;

/**
 * Подключить историю: порт стора (эффекты переходов) и `popstate`. Повторная установка снимает
 * прежнюю сама: под StrictMode эффект ставится дважды, и два слушателя применили бы жест дважды.
 */
export function installHistory(): () => void {
  activeUninstall?.();
  connectHistoryPort({
    apply: applyEffect,
    atFirstEntry: () => useNav.getState().mode === 'site' && idx === 0,
    hasOrbisBehind: () => idx > 0,
  });
  const onPop = (event: PopStateEvent) => {
    if (useNav.getState().mode === 'app') onPopApp(event);
    else onPopSite(event);
  };
  window.addEventListener('popstate', onPop);
  const uninstall = () => {
    if (activeUninstall !== uninstall) return;
    activeUninstall = null;
    connectHistoryPort(null);
    window.removeEventListener('popstate', onPop);
  };
  activeUninstall = uninstall;
  return uninstall;
}
