// packages/shared/src/nav/history-model.ts
// История навигации (спека 1б §7.3, Р-19, Р-21, РП-18): ОДНА модель и ДВА поведения, выбранные
// способом запуска. Модель — приложение → разделы → у каждого раздела своя стопка экранов; журнал
// переходов между приложениями не отдельная структура, а `source` у записи стопки, пришедшей из
// другого приложения (цепочка источников и есть журнал). Поведение — чистая функция
// «модель + действие + режим → модель + эффект для истории браузера», поэтому в экранах нет
// «если PWA»: web применяет эффект, модель одна.
//
// Почему модель одна, а не две: «как сайт» отличается от «как приложение» только тем, кто ведёт
// «назад» (браузер или стопка) и сколько записей в истории браузера. Место, которое видит владелец,
// в обоих режимах одинаково — две модели разошлись бы на первом же переключении раздела.
//
// Таблица §7.3:
// | действие                         | модель (оба режима)                                  | app        | site      |
// |----------------------------------|------------------------------------------------------|------------|-----------|
// | open в том же приложении         | в стопку активного раздела                           | replace    | push      |
// | open в другое приложение         | в стопку его активного раздела, `source` = откуда    | replace    | push      |
// | open из экрана хоста             | экран хоста снят; источник — раздел под ним          | replace    | push      |
// | section на активном разделе      | стопка до корня                                      | replace    | push      |
// | section / switch-app на другое   | его стопка (site показывает её верх — последнее место) | replace  | push      |
// | switch-app на текущем            | домашняя приложения: HOME_SECTION, [home]            | replace    | push      |
// | host-screen (кнопки хоста)       | поверх текущего раздела; поверх экрана хоста — вместо | replace   | push      |
// | replace (РП-21)                  | верх стопки уточнён, `source` и `view` на месте       | replace    | replace   |
// | view                             | состояние экрана в верх стопки, `null` снимает ключ   | replace    | replace   |
// | back                             | app: по стопке / в источник / в хост / выход          | none, exit | back      |
// В режиме сайта переход на то же место, что уже на экране, — `replace`, не `push`: так же поступает
// браузер с переходом на текущий URL, и «назад» не упирается в запись-двойник.
// Боковой чат на десктопе и окно ⌘K — не элементы истории: их ссылка — обычный `open` из содержимого.
//
// Функция тотальна: любое действие над любой моделью даёт модель — действие с адресом заводит
// недостающую стопку, прочие на битой модели ничего не ломают. Побочных эффектов нет: страж ухода
// (`mayLeave`, РП-33) зовёт стор web ДО `navReduce`, и «переход не состоялся» значит просто «действие
// не применено».
//
// Инварианты, которые модель держит сама: стопок-пустышек нет (опустевшая стопка удаляется), у
// активного приложения и у хоста активная стопка есть. Ключи приложений и разделов — данные
// владельца (id записей), поэтому словари читаются только по СВОИМ ключам (`Object.hasOwn`), а
// пишутся через `Object.fromEntries`: раздел по имени `constructor` или `__proto__` — обычный ключ.

import { type Address, buildAddress, type HostScreen, parseAddress, sameAddress } from './address';

export type LaunchMode = 'app' | 'site';

/**
 * Способ запуска (РП-5): установленное приложение (PWA, окно на десктопе — `display-mode: standalone`)
 * или WebView нативной обёртки (метка `OrbisApp/<версия>` в user agent) ведут себя как приложение;
 * вкладка браузера — как сайт. Чтение окружения (`matchMedia`, `navigator`) — обёртка web, не здесь.
 */
export function launchModeOf(env: { standalone: boolean; userAgent: string }): LaunchMode {
  return env.standalone || /OrbisApp\//.test(env.userAgent) ? 'app' : 'site';
}

/** 'host' | id записи-приложения. */
export type AppKey = string;
/** id записи-раздела | HOME_SECTION. */
export type SectionKey = string;

/** Хост — нулевое приложение; туда ведёт «назад» с дна любого приложения, когда журнал исчерпан. */
export const HOST_APP: AppKey = 'host';
/** Домашняя приложения; у формы «домашняя как центр» — единственная стопка. */
export const HOME_SECTION: SectionKey = 'home';

export interface Origin {
  app: AppKey;
  section: SectionKey;
}

export interface StackEntry {
  address: Address;
  /** У записи, пришедшей из ДРУГОГО приложения: «назад» на ней возвращает туда. */
  source?: Origin;
  /** Состояние экрана (вкладка шаблона, «открыть через X») — в истории, не в адресе (§7.1). */
  view?: Readonly<Record<string, string>>;
}

export interface AppNav {
  activeSection: SectionKey;
  stacks: Readonly<Record<SectionKey, readonly StackEntry[]>>;
}

export interface NavModel {
  activeApp: AppKey;
  apps: Readonly<Record<AppKey, AppNav>>;
}

export type NavAction =
  | { type: 'open'; address: Address; app: AppKey; from: 'content' | 'host-screen' } // переход по ссылке
  | { type: 'section'; app: AppKey; section: SectionKey; root: Address } // нажатие на раздел / ⌂ приложения
  | { type: 'switch-app'; app: AppKey; home: Address } // рейка, «Приложения», ⌂ хоста
  | { type: 'host-screen'; address: Address } // чат (телефон), поиск, быстрый ввод, настройки
  | { type: 'replace'; address: Address } // РП-21: правило открытия уточнило место
  | { type: 'view'; patch: Readonly<Record<string, string | null>> } // экран записал своё состояние в верх стопки
  | { type: 'back' };

export type NavEffect =
  | { history: 'push' } // site: честная запись истории
  | { history: 'replace' } // app: одна запись; site: замена (РП-21)
  | { history: 'back' } // site: «‹» = history.back()
  | { history: 'none' } // app: перехваченный назад отработан моделью
  | { history: 'exit' }; // app: дно стопки корневого приложения — отпустить системный назад (Android закрывает Orbis)

export const NAV_STORAGE_KEY = 'orbis:nav:v2';

export interface NavPersisted {
  v: 2;
  activeApp: AppKey;
  apps: Record<AppKey, { activeSection: SectionKey; last: Record<SectionKey, Address> }>;
}

const HOST_HOME: Address = { kind: 'home', app: { kind: 'host' } };

// ─── словари: только свои ключи ───────────────────────────────────────────────────────────────

function own<T>(rec: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(rec, key) ? rec[key] : undefined;
}

/** Копия словаря с ключом `key` = `value` (`undefined` — ключ снят). */
function setKey<T>(
  rec: Readonly<Record<string, T>>,
  key: string,
  value: T | undefined,
): Record<string, T> {
  const entries = Object.entries(rec).filter(([k]) => k !== key);
  if (value !== undefined) entries.push([key, value]);
  return Object.fromEntries(entries);
}

// ─── чтение модели ────────────────────────────────────────────────────────────────────────────

function stackAt(
  model: NavModel,
  app: AppKey,
  section: SectionKey,
): readonly StackEntry[] | undefined {
  const nav = own(model.apps, app);
  const stack = nav ? own(nav.stacks, section) : undefined;
  return stack && stack.length > 0 ? stack : undefined;
}

function activeSectionOf(model: NavModel, app: AppKey): SectionKey {
  return own(model.apps, app)?.activeSection ?? HOME_SECTION;
}

function activeStack(model: NavModel): readonly StackEntry[] | undefined {
  return stackAt(model, model.activeApp, activeSectionOf(model, model.activeApp));
}

function topOf(model: NavModel): StackEntry | undefined {
  const stack = activeStack(model);
  return stack?.[stack.length - 1];
}

const isHostScreen = (e: StackEntry | undefined) => e?.address.kind === 'host-screen';

// ─── запись модели ────────────────────────────────────────────────────────────────────────────

/**
 * Стопка раздела приложения (пустая — удаляется: пустышка не место) и, если задан, активный раздел.
 * Приложение, которого не было, заводится.
 */
function putStack(
  model: NavModel,
  app: AppKey,
  section: SectionKey,
  stack: readonly StackEntry[],
  activeSection?: SectionKey,
): NavModel {
  const nav = own(model.apps, app);
  const next: AppNav = {
    activeSection: activeSection ?? nav?.activeSection ?? section,
    stacks: setKey(nav?.stacks ?? {}, section, stack.length > 0 ? stack : undefined),
  };
  return { ...model, apps: setKey(model.apps, app, next) };
}

function withActiveSection(model: NavModel, app: AppKey, section: SectionKey): NavModel {
  const nav = own(model.apps, app);
  if (!nav) return model;
  return { ...model, apps: setKey(model.apps, app, { ...nav, activeSection: section }) };
}

/** Корень стопки: прежняя корневая запись, если это то же место (с её `view`), иначе — новая. */
function rootEntry(stack: readonly StackEntry[] | undefined, root: Address): StackEntry {
  const first = stack?.[0];
  if (!first || !sameAddress(first.address, root)) return { address: root };
  // Корень — не переход по ссылке: источник у него не держится.
  return first.view ? { address: first.address, view: first.view } : { address: first.address };
}

// ─── действия ─────────────────────────────────────────────────────────────────────────────────

function applyOpen(model: NavModel, a: Extract<NavAction, { type: 'open' }>): NavModel {
  const curApp = model.activeApp;
  const curSection = activeSectionOf(model, curApp);
  const stack = activeStack(model) ?? [];
  // Ссылка из экрана хоста (чат на телефоне, поиск) уводит с него: экран снимается, «‹» потом ведёт в
  // раздел под ним, а не обратно в чат. Ссылка из содержимого (в том числе бокового чата и ⌘K) —
  // обычный переход: боковые окна не элементы истории.
  const base =
    a.from === 'host-screen' && isHostScreen(stack[stack.length - 1]) ? stack.slice(0, -1) : stack;

  if (a.app === curApp) {
    const top = base[base.length - 1];
    const next =
      top && sameAddress(top.address, a.address) ? base : [...base, { address: a.address }];
    return putStack(model, curApp, curSection, next);
  }

  // Другое приложение: запись несёт источник — раздел, откуда ушли (под снятым экраном хоста).
  // Если снятие экрана оставило бы раздел пустым (экран был единственным — так бывает только после
  // восстановления), экран остаётся: источник не может указывать в пустоту.
  let m = model;
  let source: Origin | undefined;
  if (stack.length > 0) {
    source = { app: curApp, section: curSection };
    m = putStack(m, curApp, curSection, base.length > 0 ? base : stack);
  }
  const targetSection = activeSectionOf(m, a.app);
  const targetStack = stackAt(m, a.app, targetSection) ?? [];
  const entry: StackEntry = source ? { address: a.address, source } : { address: a.address };
  m = putStack(m, a.app, targetSection, [...targetStack, entry], targetSection);
  return { ...m, activeApp: a.app };
}

function applySection(model: NavModel, a: Extract<NavAction, { type: 'section' }>): NavModel {
  const existing = stackAt(model, a.app, a.section);
  const isCurrent = a.app === model.activeApp && activeSectionOf(model, a.app) === a.section;
  // Повторное нажатие на текущий раздел — его корень; другой раздел — его стопка как есть (app
  // продолжит «назад» по ней, site покажет её верх — последнее место); нет стопки — заводится от root.
  const stack = isCurrent || !existing ? [rootEntry(existing, a.root)] : existing;
  return { ...putStack(model, a.app, a.section, stack, a.section), activeApp: a.app };
}

function applySwitchApp(model: NavModel, a: Extract<NavAction, { type: 'switch-app' }>): NavModel {
  const nav = own(model.apps, a.app);
  const restorable = nav && a.app !== model.activeApp && stackAt(model, a.app, nav.activeSection);
  if (restorable) return { ...model, activeApp: a.app };
  // Иконка текущего приложения (или приложение без стопки) — его домашняя; стопки разделов не трогаются.
  const home = rootEntry(stackAt(model, a.app, HOME_SECTION), a.home);
  return { ...putStack(model, a.app, HOME_SECTION, [home], HOME_SECTION), activeApp: a.app };
}

function applyHostScreen(model: NavModel, address: Address): NavModel {
  const stack = activeStack(model) ?? [];
  const top = stack[stack.length - 1];
  if (top && sameAddress(top.address, address)) return model;
  // Экран хоста поверх экрана хоста — вместо него: «‹» с экрана хоста всегда ведёт в раздел (§7.3).
  const base = isHostScreen(top) ? stack.slice(0, -1) : stack;
  return putStack(model, model.activeApp, activeSectionOf(model, model.activeApp), [
    ...base,
    { address },
  ]);
}

/** Верх активной стопки, переписанный `f`; нет стопки — модель как есть. */
function mapTop(model: NavModel, f: (top: StackEntry) => StackEntry): NavModel {
  const stack = activeStack(model);
  if (!stack) return model;
  const top = stack[stack.length - 1] as StackEntry;
  return putStack(model, model.activeApp, activeSectionOf(model, model.activeApp), [
    ...stack.slice(0, -1),
    f(top),
  ]);
}

function patchView(top: StackEntry, patch: Readonly<Record<string, string | null>>): StackEntry {
  const entries = Object.entries(top.view ?? {}).filter(([k]) => !Object.hasOwn(patch, k));
  for (const [k, v] of Object.entries(patch)) if (v !== null) entries.push([k, v]);
  const { view: _old, ...rest } = top;
  // Пустое состояние — без поля: запись без состояния одна, а не две формы.
  return entries.length > 0 ? { ...rest, view: Object.fromEntries(entries) } : rest;
}

/** «Назад» приложения (app): по стопке, в источник, с дна — в хост, с дна хоста — выход. */
function backInApp(model: NavModel): { model: NavModel; effect: NavEffect } {
  const app = model.activeApp;
  const section = activeSectionOf(model, app);
  const stack = activeStack(model) ?? [];
  const top = stack[stack.length - 1];
  const source = top?.source;
  if (source && stackAt(model, source.app, source.section)) {
    const m = withActiveSection(
      putStack(model, app, section, stack.slice(0, -1)),
      source.app,
      source.section,
    );
    return { model: { ...m, activeApp: source.app }, effect: { history: 'none' } };
  }
  if (stack.length > 1)
    return {
      model: putStack(model, app, section, stack.slice(0, -1)),
      effect: { history: 'none' },
    };
  // Дно стопки без источника: журнал межприложенческих переходов исчерпан.
  if (app !== HOST_APP && stackAt(model, HOST_APP, activeSectionOf(model, HOST_APP))) {
    return { model: { ...model, activeApp: HOST_APP }, effect: { history: 'none' } };
  }
  return { model, effect: { history: 'exit' } };
}

/** Эффект перехода: app — одна запись истории (замена URL), site — честная запись, если место сменилось. */
function moveEffect(before: NavModel, after: NavModel, mode: LaunchMode): NavEffect {
  if (mode === 'app') return { history: 'replace' };
  const a = topOf(before);
  const b = topOf(after);
  return a && b && sameAddress(a.address, b.address) ? { history: 'replace' } : { history: 'push' };
}

export function navReduce(
  model: NavModel,
  action: NavAction,
  mode: LaunchMode,
): { model: NavModel; effect: NavEffect } {
  const move = (next: NavModel) => ({ model: next, effect: moveEffect(model, next, mode) });
  switch (action.type) {
    case 'open':
      return move(applyOpen(model, action));
    case 'section':
      return move(applySection(model, action));
    case 'switch-app':
      return move(applySwitchApp(model, action));
    case 'host-screen':
      return move(applyHostScreen(model, action.address));
    case 'replace':
      return {
        model: mapTop(model, (top) => ({ ...top, address: action.address })),
        effect: { history: 'replace' },
      };
    case 'view':
      return {
        model: mapTop(model, (top) => patchView(top, action.patch)),
        effect: { history: 'replace' },
      };
    case 'back':
      // Сайт: «назад» ведёт браузер; web на `popstate` восстановит модель из `history.state`.
      return mode === 'site' ? { model, effect: { history: 'back' } } : backInApp(model);
  }
}

/**
 * Верх активной стопки. На модели без активной стопки (такой navReduce и restoreFrom не отдают) —
 * верх стопки хоста, затем домашняя хоста: экран не остаётся пустым и не падает.
 */
export function currentEntry(model: NavModel): StackEntry {
  return topOf(model) ?? topOf({ ...model, activeApp: HOST_APP }) ?? { address: HOST_HOME };
}

/** Есть ли куда «‹» в режиме приложения — ровно тогда, когда «назад» приложения не выход. */
export function canGoBack(model: NavModel): boolean {
  return backInApp(model).effect.history === 'none';
}

export function initialModel(home: Address): NavModel {
  return {
    activeApp: HOST_APP,
    apps: {
      [HOST_APP]: { activeSection: HOME_SECTION, stacks: { [HOME_SECTION]: [{ address: home }] } },
    },
  };
}

// ─── сохранение orbis:nav:v2 ──────────────────────────────────────────────────────────────────

/**
 * Последнее место раздела — верх стопки, но не экран хоста: он лишь лежит поверх раздела, и после
 * перезапуска раздел должен открыться своим местом, а не чатом без «‹» назад.
 */
function lastPlace(stack: readonly StackEntry[]): Address | undefined {
  for (let i = stack.length - 1; i >= 0; i--) {
    const e = stack[i] as StackEntry;
    if (e.address.kind !== 'host-screen') return e.address;
  }
  return stack[stack.length - 1]?.address;
}

/**
 * Что переживает перезапуск (§7.3): активное приложение, активный раздел каждого приложения и
 * последнее место каждого раздела. Глубина стопок, источники межприложенческих переходов и
 * состояние экранов — нет.
 */
export function persistOf(model: NavModel): NavPersisted {
  const apps = Object.entries(model.apps).map(([app, nav]) => {
    const last = Object.entries(nav.stacks).flatMap(([section, stack]) => {
      const place = lastPlace(stack);
      return place ? [[section, place] as const] : [];
    });
    return [app, { activeSection: nav.activeSection, last: Object.fromEntries(last) }] as const;
  });
  return { v: 2, activeApp: model.activeApp, apps: Object.fromEntries(apps) };
}

const HOST_SCREENS: readonly HostScreen[] = ['chat', 'search', 'settings', 'memory'];

function isObj(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

/**
 * Сохранённый адрес → адрес, если он той же формы и переживает круг «собрать → разобрать» в то же
 * место. Круг отсекает то, что тип не выражает: `ref` со слэшем, резерв `budget`, не-uuid id,
 * заглавный uuid — такое наше `persistOf` не пишет, значит, сохранение чужое или битое.
 */
function addressOf(x: unknown): Address | null {
  if (!isObj(x)) return null;
  const app = x.app;
  const appRef = !isObj(app)
    ? null
    : app.kind === 'host'
      ? ({ kind: 'host' } as const)
      : app.kind === 'app' && typeof app.ref === 'string'
        ? ({ kind: 'app', ref: app.ref } as const)
        : null;
  let candidate: Address;
  if (x.kind === 'home' && appRef) candidate = { kind: 'home', app: appRef };
  else if (x.kind === 'record' && appRef && typeof x.id === 'string')
    candidate = { kind: 'record', app: appRef, id: x.id };
  else if (
    x.kind === 'host-screen' &&
    HOST_SCREENS.includes(x.screen as HostScreen) &&
    (x.q === undefined || typeof x.q === 'string')
  )
    candidate =
      x.q === undefined
        ? { kind: 'host-screen', screen: x.screen as HostScreen }
        : { kind: 'host-screen', screen: x.screen as HostScreen, q: x.q };
  else return null;
  const path = buildAddress(candidate);
  const parsed = parseAddress(path);
  if (parsed === null || parsed.kind !== candidate.kind || buildAddress(parsed as Address) !== path)
    return null;
  return parsed as Address;
}

/**
 * Сохранение → модель со стопками `[последнее место]`. Любая чужая форма — `null` (web начнёт с
 * `initialModel`): старое `orbis:nav:v1` (`{state:{activeTab,…}}`) не читается и не переносится
 * (§7.3), битое место не угадывается. Обязательны активная стопка активного приложения и хоста —
 * иначе модель нарушила бы свои инварианты.
 */
export function restoreFrom(raw: unknown): NavModel | null {
  if (!isObj(raw) || raw.v !== 2 || typeof raw.activeApp !== 'string' || !isObj(raw.apps))
    return null;
  const apps: [AppKey, AppNav][] = [];
  for (const [app, nav] of Object.entries(raw.apps)) {
    if (!isObj(nav) || typeof nav.activeSection !== 'string' || !isObj(nav.last)) return null;
    const stacks: [SectionKey, StackEntry[]][] = [];
    for (const [section, place] of Object.entries(nav.last)) {
      const address = addressOf(place);
      if (address === null) return null;
      stacks.push([section, [{ address }]]);
    }
    apps.push([app, { activeSection: nav.activeSection, stacks: Object.fromEntries(stacks) }]);
  }
  const model: NavModel = { activeApp: raw.activeApp, apps: Object.fromEntries(apps) };
  if (!activeStack(model) || !stackAt(model, HOST_APP, activeSectionOf(model, HOST_APP)))
    return null;
  return model;
}
