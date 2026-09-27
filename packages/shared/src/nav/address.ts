// packages/shared/src/nav/address.ts
// Адрес «приложение + запись» (спека 1б §7.1, §7.2, §7.4): разбор и сборка ссылки — чистые функции
// shared, потому что адрес — идентификатор места ядра, а не деталь web-роутера: те же ссылки поймёт
// нативный клиент, а «Скопировать ссылку» и вставка адреса в тело записи должны понимать одно и то же.
//
// Таблица ссылок (§7.1; память — Э-5):
//   /                              домашняя хоста
//   /r/<id>                        запись в хосте
//   /a/<приложение>                домашняя приложения
//   /a/<приложение>/r/<id>         запись в приложении
//   /chat, /search?q=…, /settings, /settings/memory — экраны хоста
// <приложение> — ключ эталона поставки (`records`, `/a/budget` одинаков в любом графе) либо id
// записи-приложения (свои приложения). Что за приложением стоит на самом деле (выключено, архивно,
// чужое, не приложение, `host-shell` = сам хост) — решает правило открытия (задача 16), не разбор:
// разбор не знает графа и остаётся детерминированным.
//
// Старые ссылки 1а переводятся (§7.1), чтобы закладки не падали после выкатки (Фокус ревью п. 1):
//   /entity/<id>                   → запись в хосте
//   /thread/<id треда>             → `legacy-thread` (запись треда ищет web через chat.threadEntity, РП-17)
//   /browser                       → `legacy-supply` «Записи»
//   /budget, /budget/category/<id>, /a/budget, /a/budget/r/<id> → `reserved` budget (плашка «придёт со следующим срезом»)
//   /agenda                        → `reserved` agenda
//
// Модуль чистый TS: ни `window`/`location`, ни `URL` — строка разбирается руками, чтобы функция
// одинаково вела себя на сервере, в web и в тестах и не зависела от того, как рантайм нормализует URL.

import { RESERVED_APP_KEYS } from '../supply/etalons';

/** Приложение в адресе: хост или ссылка на приложение. `ref` — id записи-приложения (нижний регистр) или ключ поставки. */
export type AppRef = { kind: 'host' } | { kind: 'app'; ref: string };

/** Экраны хоста с собственным адресом. `memory` — `/settings/memory`, экран «Память AI» настроек (Э-5). */
export type HostScreen = 'chat' | 'search' | 'settings' | 'memory';

export type Address =
  | { kind: 'home'; app: AppRef } // '/' | '/a/<ref>'
  | { kind: 'record'; app: AppRef; id: string } // '/r/<id>' | '/a/<ref>/r/<id>'
  | { kind: 'host-screen'; screen: HostScreen; q?: string }; // '/chat' | '/search?q=…' | '/settings' | '/settings/memory'

/** Старые ссылки 1а, которым нужен шаг сверх разбора (поиск записи треда, плашка резерва). */
export type LegacyAddress =
  | { kind: 'legacy-thread'; threadId: string } // '/thread/<uuid>' — запись треда ищет chat.threadEntity (задача 10)
  | { kind: 'legacy-supply'; key: 'records' } // '/browser' → страница поставки «Записи»
  | { kind: 'reserved'; key: 'budget' | 'agenda' }; // '/budget…', '/a/budget…', '/agenda' — плашка «придёт со следующим срезом»

/**
 * UUID любой версии, регистронезависимо. Копия из `nav/links.ts` осознанно: `links.ts` уходит в
 * задаче 19 целиком, а адрес живёт дальше — общая константа связала бы новый модуль со снимаемым.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Ключ приложения поставки в ссылке. Строчные латиница, цифры, дефис; с буквы — так выглядят все
 * ключи `SUPPLY_KEYS` и резерв `budget`. Список ключей тут НЕ сверяется: неизвестный ключ — дело
 * правила открытия (хост + плашка), а разбор, знающий список, пришлось бы править с каждым новым
 * приложением поставки. Заглавные не принимаются: `/a/Budget` — чужой путь, а не «почти наш».
 */
const APP_KEY_RE = /^[a-z][a-z0-9-]*$/;

function isUuid(segment: string | undefined): segment is string {
  return segment !== undefined && UUID_RE.test(segment);
}

/** Сегмент приложения → `ref`: uuid нормализуется в нижний регистр (ключ кеша наравне с id из БД). */
function appRefOf(segment: string | undefined): string | null {
  if (segment === undefined) return null;
  if (UUID_RE.test(segment)) return segment.toLowerCase();
  if (APP_KEY_RE.test(segment)) return segment;
  return null;
}

function isReservedAppKey(ref: string): ref is (typeof RESERVED_APP_KEYS)[number] {
  return (RESERVED_APP_KEYS as readonly string[]).includes(ref);
}

/**
 * Значение параметра `q` из query-строки (без `?`). Нет параметра — пустой запрос. Битая кодировка —
 * `null`: `decodeURIComponent` бросает `URIError`, а ссылка из письма не должна ронять старт.
 * `+` — пробел формы (так пишут `URLSearchParams` и адресная строка браузера); сборка кодирует `+`
 * как `%2B`, так что круг «собрать → разобрать» не страдает.
 */
function searchQueryOf(query: string): string | null {
  for (const pair of query.split('&')) {
    const eq = pair.indexOf('=');
    const name = eq === -1 ? pair : pair.slice(0, eq);
    if (name !== 'q') continue;
    const raw = eq === -1 ? '' : pair.slice(eq + 1);
    try {
      return decodeURIComponent(raw.replace(/\+/g, ' '));
    } catch {
      return null;
    }
  }
  return '';
}

/**
 * Ссылка (путь с query-строкой, без origin) → адрес или старая ссылка. Неизвестный или битый путь —
 * `null`: догадка хуже отказа, вызывающий сам решает, что показать.
 *
 * Query-строка принимается ТОЛЬКО у `/search` (РП-28): запрос поиска — единственный параметр, у
 * которого есть адрес; у остальных путей хвост `?…` пришлось бы молча отбросить, делая вид, что
 * мы его поняли (параметры адреса — «позже, место оставлено», §7.1). Хеш — всегда `null`: состояние
 * экрана живёт в истории, не в ссылке.
 *
 * Поблажки к форме: ровно один завершающий слэш пути прощается (его дописывают браузеры и почтовые
 * клиенты); uuid — в любом регистре с нормализацией в нижний. Литеральные сегменты регистрозависимы.
 */
export function parseAddress(pathWithQuery: string): Address | LegacyAddress | null {
  if (pathWithQuery.includes('#')) return null;
  const qAt = pathWithQuery.indexOf('?');
  const path = qAt === -1 ? pathWithQuery : pathWithQuery.slice(0, qAt);
  const query = qAt === -1 ? null : pathWithQuery.slice(qAt + 1);
  if (!path.startsWith('/')) return null;

  // Корень проверяется ДО снятия слэша: иначе `//` стал бы домашней, а это уже два слэша, не один.
  if (path === '/') return query === null ? { kind: 'home', app: { kind: 'host' } } : null;
  const trimmed = path.endsWith('/') ? path.slice(0, -1) : path;
  const segments = trimmed.slice(1).split('/');
  const [first, second, third, fourth] = segments;
  const n = segments.length;

  if (first === 'search' && n === 1) {
    if (query === null) return { kind: 'host-screen', screen: 'search', q: '' };
    const q = searchQueryOf(query);
    return q === null ? null : { kind: 'host-screen', screen: 'search', q };
  }
  if (query !== null) return null;

  switch (first) {
    case 'r':
      return n === 2 && isUuid(second)
        ? { kind: 'record', app: { kind: 'host' }, id: second.toLowerCase() }
        : null;
    case 'a': {
      const ref = appRefOf(second);
      if (ref === null) return null;
      const isHome = n === 2;
      const isRecord = n === 4 && third === 'r' && isUuid(fourth);
      if (!isHome && !isRecord) return null;
      // Зарезервированный ключ (`budget`, спека §3.4) — не приложение, а плашка до 1в: правилу
      // открытия нечего открывать, поэтому резерв отдаётся отдельным видом уже на разборе.
      if (isReservedAppKey(ref)) return { kind: 'reserved', key: ref };
      const app: AppRef = { kind: 'app', ref };
      return isHome
        ? { kind: 'home', app }
        : { kind: 'record', app, id: (fourth as string).toLowerCase() };
    }
    case 'chat':
      return n === 1 ? { kind: 'host-screen', screen: 'chat' } : null;
    case 'settings':
      if (n === 1) return { kind: 'host-screen', screen: 'settings' };
      return n === 2 && second === 'memory' ? { kind: 'host-screen', screen: 'memory' } : null;
    // Старые ссылки 1а — ровно те формы, что строил `buildAppPath`; прочее под старыми корнями — `null`.
    case 'entity':
      return n === 2 && isUuid(second)
        ? { kind: 'record', app: { kind: 'host' }, id: second.toLowerCase() }
        : null;
    case 'thread':
      return n === 2 && isUuid(second)
        ? { kind: 'legacy-thread', threadId: second.toLowerCase() }
        : null;
    case 'browser':
      return n === 1 ? { kind: 'legacy-supply', key: 'records' } : null;
    case 'budget':
      return n === 1 || (n === 3 && second === 'category' && isUuid(third))
        ? { kind: 'reserved', key: 'budget' }
        : null;
    case 'agenda':
      return n === 1 ? { kind: 'reserved', key: 'agenda' } : null;
    default:
      return null;
  }
}

function appPrefix(app: AppRef): string {
  return app.kind === 'host' ? '' : `/a/${app.ref}`;
}

/**
 * Одиночные суррогаты UTF-16 → U+FFFD. `encodeURIComponent` на них бросает `URIError`, а такой
 * запрос поиска получается, если текст обрезан по длине посреди эмодзи или вставлен битым: навигация
 * и `sameAddress` не должны ронять обработчик. Не `String.prototype.toWellFormed`: его нет в `lib`
 * ES2022 проекта (shared и web), а поведение то же — пара остаётся, одиночный становится U+FFFD.
 */
function wellFormed(s: string): string {
  return s.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]|[\uD800-\uDFFF]/g, (m) =>
    m.length === 2 ? m : '\uFFFD',
  );
}

/**
 * Адрес → ссылка (путь, у поиска — с `?q=`). Канон: поиск без запроса — `/search`.
 *
 * Предусловия, на которых держится круг `parseAddress(buildAddress(a)) = a` (тип их не выражает,
 * проверки в коде нет — адреса строятся из id БД и ключей поставки, где они выполнены):
 * `app.ref` — uuid в нижнем регистре или ключ поставки (`/^[a-z][a-z0-9-]*$/`), но не резерв
 * `budget` (он разбирается как `reserved`); `id` записи — uuid в нижнем регистре; `q` — только у
 * `search` (у прочих экранов молча не попадает в ссылку). Иначе ссылка собирается, но разбор даёт
 * другое место или `null`.
 */
export function buildAddress(a: Address): string {
  switch (a.kind) {
    case 'home':
      return appPrefix(a.app) || '/';
    case 'record':
      return `${appPrefix(a.app)}/r/${a.id}`;
    case 'host-screen':
      switch (a.screen) {
        case 'chat':
          return '/chat';
        case 'settings':
          return '/settings';
        case 'memory':
          return '/settings/memory';
        case 'search':
          return a.q ? `/search?q=${encodeURIComponent(wellFormed(a.q))}` : '/search';
      }
  }
}

/**
 * Одно ли это место. Сравнение по канонической ссылке: поиск без `q` и с пустым `q` — одно место,
 * а новое поле адреса (параметры, §7.1) не потребует помнить про эту функцию.
 */
export function sameAddress(a: Address, b: Address): boolean {
  return buildAddress(a) === buildAddress(b);
}

/**
 * §7.4: полный адрес Orbis (того же origin) → id записи; иначе null. `/entity/<id>` тоже; `/a/<uuid>`
 * (домашняя своего приложения) → id записи-приложения (Р-20: ссылка на запись-приложение открывает
 * приложение); `/a/<ключ>` → null.
 *
 * Приложение из адреса отбрасывается (Р-20): в данных — ссылка на запись по id, рамку выбирает
 * правило открытия при нажатии. Относительный путь не принимается — вставляют полный адрес
 * («Скопировать ссылку» даёт его). Схема и хост сравниваются без учёта регистра (так их понимает
 * браузер), путь — как в `parseAddress`. Старая `/thread/<id>` — null: id треда не id записи, а
 * поиск записи треда — запрос к серверу, не чистая функция.
 */
export function recordIdOfUrl(url: string, origin: string): string | null {
  const base = origin.replace(/\/+$/, '').toLowerCase();
  // Origin без схемы — непрозрачный (`'null'` у `file://`, песочницы, WebView) или не origin вовсе:
  // префиксом с ним совпал бы обычный текст вида `null/r/<id>`, а это не «полный адрес Orbis».
  if (!base.includes('://') || url.slice(0, base.length).toLowerCase() !== base) return null;
  // После origin — только путь. `https://orbis.app.evil.com/…` и чужой порт совпадают префиксом, но их
  // хвост (`.evil.com/…`, `:8443/…`) начинается не со слэша — такой путь `parseAddress` не принимает.
  const parsed = parseAddress(url.slice(base.length));
  if (parsed === null) return null;
  if (parsed.kind === 'record') return parsed.id;
  if (parsed.kind === 'home' && parsed.app.kind === 'app' && isUuid(parsed.app.ref))
    return parsed.app.ref;
  return null;
}
