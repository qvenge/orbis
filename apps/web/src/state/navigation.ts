/**
 * Стор навигации (срез 1б §7.1–§7.3, РП-18, РП-33): тонкий слой над ЧИСТОЙ моделью истории
 * `@orbis/shared/nav` (`navReduce`). Логики стопок здесь нет — её держит модель, одна на оба
 * поведения; стор только (1) спрашивает стража ухода, (2) применяет действие к модели, (3) сохраняет
 * навигацию под `orbis:nav:v2` и (4) отдаёт эффект истории браузера порту `app/history.ts`.
 *
 * Рамка на экране = `model.activeApp` (R-22): иконка, раздел ▾ и навигация рисуются по активному
 * приложению модели.
 *
 * Страж ухода (РП-33): каждый переход ПЕРВОЙ строкой зовёт `mayLeave()` — экран с неотправленной
 * правкой настройки говорит «нет», и действие просто не применяется (модель страж не зовёт — она
 * чистая). Не спрашивают стража только действия, которые не уводят с экрана: `view` (экран записал
 * своё состояние) и `replacePlace` (правило открытия уточнило место того же экрана, РП-21).
 *
 * Старое сохранение `orbis:nav:v1` (вкладки 1а) не читается и не переносится (§7.3, Фокус ревью п. 1).
 */
import {
  type Address,
  type AppKey,
  type AppRef,
  canGoBack,
  HOME_SECTION,
  HOST_APP,
  type HostScreen,
  initialModel,
  type LaunchMode,
  NAV_STORAGE_KEY,
  type NavAction,
  type NavEffect,
  type NavModel,
  navReduce,
  persistOf,
  restoreFrom,
  type SectionKey,
} from '@orbis/shared/nav';
import { create } from 'zustand';
import { mayLeave } from './leave-guard';

export type { AppKey, SectionKey };

/** Домашняя хоста — `/`: известна без данных (что на ней, решает оболочка хоста). */
export const HOST_HOME: Address = { kind: 'home', app: { kind: 'host' } };

/**
 * Экран поверх модели, у которого нет адреса «приложение + запись»: старые ссылки, которым нужен шаг
 * сверх разбора (запись треда ищет сервер, «Записи» — запись поставки), и зарезервированные ключи
 * (`/budget…`, `/agenda` — плашка до 1в, спека §7.1, §8.6). `path` — ссылка, по которой пришли: её
 * показывает адресная строка, пока экран на месте. Любой переход снимает его.
 */
export type NavOverlay =
  | { kind: 'reserved'; key: 'budget' | 'agenda'; path: string }
  | { kind: 'legacy-thread'; threadId: string; path: string }
  | { kind: 'legacy-supply'; key: 'records'; path: string };

/**
 * Порт истории браузера — его ставит `app/history.ts`. Стор эффект только передаёт: как его
 * применить (запись, замена, `history.back()`, охранная запись режима приложения), знает история.
 */
export interface NavHistoryPort {
  apply(effect: NavEffect): void;
  /** R-24: вкладку открыли по ссылке — позади в истории нет записи Orbis. */
  atFirstEntry(): boolean;
  /** Режим сайта: есть ли позади в истории вкладки запись Orbis. */
  hasOrbisBehind(): boolean;
}

let port: NavHistoryPort | null = null;

/** Подключить (или снять — `null`) порт истории. Зовёт только `app/history.ts`. */
export function connectHistoryPort(p: NavHistoryPort | null): void {
  port = p;
}

export interface NavState {
  model: NavModel;
  mode: LaunchMode;
  overlay: NavOverlay | null;
  /**
   * Ссылка на запись. `app` — приложение рамки (по умолчанию — активное), `from` — откуда: из
   * содержимого или с экрана хоста (чат, поиск — тогда экран хоста снимается, §7.3).
   */
  openRecord(id: string, opts?: { app?: AppKey; from?: 'content' | 'host-screen' }): void;
  openAddress(a: Address): void;
  /** Нажатие на раздел; повторное — на активный — его корень (§7.3). */
  openSection(app: AppKey, section: SectionKey): void;
  /** Переключатель приложений: его стопка (приложение) или последнее место (сайт). */
  switchApp(app: AppKey): void;
  /** ⌂ хоста (R-23): «Домой» хоста одним переходом из любого приложения. */
  goHome(): void;
  openHostScreen(s: HostScreen, q?: string): void;
  /** «‹» хоста. В режиме сайта на первой записи вкладки идёт по модели (R-24). */
  back(): void;
  /** Правило открытия уточнило место (РП-21): замена без нового шага. `app` — рамка места (R-22). */
  replacePlace(a: Address, app?: AppKey): void;
  /** Состояние экрана в верх стопки (вкладка шаблона, «открыть через X», §7.1); `null` снимает ключ. */
  setView(patch: Readonly<Record<string, string | null>>): void;
}

/** Ссылка на приложение в адресе. */
export function appRefOf(app: AppKey): AppRef {
  return app === HOST_APP ? { kind: 'host' } : { kind: 'app', ref: app };
}

/** Приложение модели по ссылке адреса. */
export function appKeyOf(ref: AppRef): AppKey {
  return ref.kind === 'host' ? HOST_APP : ref.ref;
}

/** Корень раздела: домашняя приложения или запись-раздел в его рамке. */
export function sectionRoot(app: AppKey, section: SectionKey): Address {
  return section === HOME_SECTION
    ? { kind: 'home', app: appRefOf(app) }
    : { kind: 'record', app: appRefOf(app), id: section };
}

export function readPersistedNav(): NavModel | null {
  try {
    const raw = localStorage.getItem(NAV_STORAGE_KEY);
    return raw === null ? null : restoreFrom(JSON.parse(raw));
  } catch {
    // Битый JSON, запрещённое хранилище (приватный режим) — старт с домашней, а не падение.
    return null;
  }
}

function persist(model: NavModel): void {
  try {
    localStorage.setItem(NAV_STORAGE_KEY, JSON.stringify(persistOf(model)));
  } catch {
    // Хранилище недоступно или переполнено: навигация живёт и без сохранения, теряется только
    // «где остановились» после перезапуска.
  }
}

/** Действие → модель и эффект; стража спрашивает вызывающий. */
function run(action: NavAction): void {
  const s = useNav.getState();
  const r = navReduce(s.model, action, s.mode);
  useNav.setState({ model: r.model, overlay: null });
  persist(r.model);
  port?.apply(r.effect);
}

/** Переход: страж ухода первой строкой (РП-33). */
function go(action: NavAction): void {
  if (!mayLeave()) return;
  run(action);
}

export const useNav = create<NavState>()((set, get) => ({
  model: initialModel(HOST_HOME),
  mode: 'site',
  overlay: null,
  openRecord: (id, opts = {}) => {
    const app = opts.app ?? get().model.activeApp;
    go({
      type: 'open',
      address: { kind: 'record', app: appRefOf(app), id },
      app,
      from: opts.from ?? 'content',
    });
  },
  openAddress: (a) => {
    if (a.kind === 'host-screen') return go({ type: 'host-screen', address: a });
    const app = appKeyOf(a.app);
    if (a.kind === 'home') return go({ type: 'switch-app', app, home: a, toHome: true });
    go({ type: 'open', address: a, app, from: 'content' });
  },
  openSection: (app, section) =>
    go({ type: 'section', app, section, root: sectionRoot(app, section) }),
  switchApp: (app) => go({ type: 'switch-app', app, home: { kind: 'home', app: appRefOf(app) } }),
  goHome: () => go({ type: 'switch-app', app: HOST_APP, home: HOST_HOME, toHome: true }),
  openHostScreen: (screen, q) =>
    go({
      type: 'host-screen',
      address:
        q === undefined ? { kind: 'host-screen', screen } : { kind: 'host-screen', screen, q },
    }),
  back: () => {
    if (!mayLeave()) return;
    if (get().overlay !== null) {
      // Экран поверх модели (плашка, старая ссылка) снимается: под ним — место модели.
      set({ overlay: null });
      port?.apply({ history: 'replace' });
      return;
    }
    run({ type: 'back', atFirstEntry: port?.atFirstEntry() ?? false });
  },
  replacePlace: (a, app) =>
    run(app === undefined ? { type: 'replace', address: a } : { type: 'replace', address: a, app }),
  setView: (patch) => run({ type: 'view', patch }),
}));

/**
 * Показывать ли «‹» (carry задачи 19): в режиме приложения — `canGoBack` модели; в режиме сайта —
 * есть ли позади запись Orbis в истории вкладки ИЛИ куда идти по модели (первая запись вкладки,
 * R-24). Экран поверх модели — всегда есть куда: под ним место модели.
 */
export function useShowBack(): boolean {
  const model = useNav((s) => s.model);
  const mode = useNav((s) => s.mode);
  const overlay = useNav((s) => s.overlay);
  if (overlay !== null) return true;
  if (mode === 'app') return canGoBack(model);
  return (port?.hasOrbisBehind() ?? false) || canGoBack(model);
}

/**
 * Поставить модель без перехода — старт навигации и восстановление из истории браузера
 * (`app/history.ts`). Не действие: эффекта нет, стража нет, сохранение — да.
 */
export function setNavState(next: {
  model: NavModel;
  overlay: NavOverlay | null;
  mode?: LaunchMode;
}): void {
  useNav.setState({
    model: next.model,
    overlay: next.overlay,
    ...(next.mode !== undefined && { mode: next.mode }),
  });
  persist(next.model);
}

/** Модель как у только что открытой вкладки — ТОЛЬКО для тестов (стор живёт модулем). */
export function resetNavForTests(): void {
  useNav.setState({ model: initialModel(HOST_HOME), mode: 'site', overlay: null });
}
