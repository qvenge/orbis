/**
 * Эталоны поставки хоста (срез 1б §9.1, §9.2, §6.5, §3.5, §9.4; РП-6).
 *
 * Всё, что приносит поставка хоста, — записи владельца с эталоном: шаблон хоста, оболочка хоста,
 * «Домой», «Записи», шесть списков. Здесь — ЭТАЛОНЫ КОДА (что приносит этот релиз), их печати и статус
 * записи «как в поставке» / «изменено вами». Отпечаток эталона (`sha256` кодовой формы) считает только
 * сервер (`apps/server/src/supply/hash.ts`): `node:crypto` в листовой модуль web не везут.
 *
 * Две формы эталона и почему (РП-6, Э-2):
 *  - КОДОВАЯ — по ключам, одинакова в любом графе: вход отпечатка. Новый релиз с правкой эталона меняет
 *    отпечаток — и только это делает запись «с обновлением»;
 *  - ПЕЧАТЬ В ГРАФЕ (`orbis/supply_text`) — с каноническим телом этого графа и id записей вместо ключей:
 *    с ней сравнивается запись («изменено вами») и к ней возвращает «Вернуть как было».
 *
 * Модуль листовой: импортирует только `../constants` (без импортов) и тела списков `./lists` (без
 * импортов). Его берёт web через сабпат `@orbis/shared/supply` из экрана записи — баррель
 * `@orbis/shared/doc` (tiptap, marked) отсюда недостижим (сторож — `etalons.test.ts`).
 *
 * Шаблон хоста — строками по строке на маркер: это ДАННЫЕ, а не разбор; сторож одной копии правил
 * (`scripts/grammar-copies.test.ts`) держит их счёт в своём списке законных мест.
 */
import {
  APP_ASPECT,
  APP_EXTENSIONS,
  APP_HOME,
  APP_NAV,
  APP_NAV_FORM,
  APP_OPENS_OVER,
  type NavForm,
  SUPPLY_ASPECT,
  SUPPLY_KEY,
  SUPPLY_TEXT,
} from '../constants';
import { SEED_SMART_LISTS } from './lists';

/** Десять ключей эталонов (РП-6) — ровно варианты `orbis/supply_key` реестра (сверка — тестом). */
export const SUPPLY_KEYS = [
  'host-template',
  'host-shell',
  'home',
  'records',
  'daily-planning',
  'upcoming',
  'all-tasks',
  'horizon-year',
  'horizon-life',
  'routines',
] as const;
export type SupplyKey = (typeof SUPPLY_KEYS)[number];

/**
 * Зарезервированные ключи приложений (спека §3.4): `/a/budget…` до 1в — хост и плашка «Бюджет придёт
 * со следующим срезом». В варианты `orbis/supply_key` не входят — эталона у них пока нет.
 */
export const RESERVED_APP_KEYS = ['budget'] as const;

export type SupplyEtalon =
  | { key: SupplyKey; kind: 'page' | 'template'; title: string; emoji: string; text: string }
  | {
      key: 'host-shell';
      kind: 'app';
      title: string;
      emoji: string;
      home: SupplyKey;
      nav: readonly SupplyKey[];
      navForm: NavForm;
    };

/**
 * Шаблон хоста (спека 1а §8.1) в форме 1б: пять строк `{{card: …}}` вкладки «Запись» заменены одной
 * `{{cards: own}}` (спека 1б §8.5, Р-23) — шаблон хоста не называет расширений. Сверку с текстом спеки
 * 1а (с этой заменой) держит web-тест задачи 17 — одно место.
 */
export const HOST_TEMPLATE_ETALON_TEXT: string = [
  '{{title}}',
  '{{tags}}',
  '{{tabs}}',
  '{{tab: Запись}}',
  '{{cards: own}}',
  '{{body}}',
  '{{/tab}}',
  '{{tab: Детали}}',
  '{{cards}}',
  '{{versions}}',
  '{{subtasks}}',
  '{{blockers}}',
  '{{backlinks}}',
  '{{/tab}}',
  '{{tab: Тред}}',
  '{{thread}}',
  '{{/tab}}',
  '{{/tabs}}',
].join('\n');

/**
 * Эталоны в порядке ключей. «Домой» — блок «Приложения» (§6.5), «Записи» — блок-экран `{{records}}`
 * (§3.5); списки — заголовки, эмодзи и тела `SEED_SMART_LISTS` (§9.4). Оболочка хоста (§6.5): домашняя —
 * «Домой», навигация — «Записи» и пять списков из прежних закреплённых («Жизни» нет — её открывают раз в
 * год), форма — «список из заголовка».
 */
export const SUPPLY_ETALONS: readonly SupplyEtalon[] = [
  {
    key: 'host-template',
    kind: 'template',
    title: 'Шаблон хоста',
    emoji: '📄',
    text: HOST_TEMPLATE_ETALON_TEXT,
  },
  {
    key: 'host-shell',
    kind: 'app',
    title: 'Orbis',
    emoji: '🪐',
    home: 'home',
    nav: ['records', 'daily-planning', 'upcoming', 'all-tasks', 'horizon-year', 'routines'],
    navForm: 'header-list',
  },
  { key: 'home', kind: 'page', title: 'Домой', emoji: '🏠', text: '{{apps}}' },
  { key: 'records', kind: 'page', title: 'Записи', emoji: '🗂️', text: '{{records}}' },
  ...SEED_SMART_LISTS.map(
    (l): SupplyEtalon => ({
      key: l.slug,
      kind: 'page',
      title: l.title,
      emoji: l.emoji,
      text: l.body,
    }),
  ),
];

export function etalonOf(key: SupplyKey): SupplyEtalon {
  const found = SUPPLY_ETALONS.find((e) => e.key === key);
  // Недостижимо: у каждого ключа эталон есть (тест). Молча отдать `undefined` значило бы уронить
  // вызывающего дальше по стеку с непонятным сообщением.
  if (found === undefined) throw new Error(`эталона поставки с ключом «${key}» нет`);
  return found;
}

/**
 * Прежние эталоны (до 1б) — ТОЛЬКО для перевода данных задачи 13 (РП-35, В-9): тело прод-списка,
 * совпавшее с прежним эталоном, — «как в поставке» старой версии, и новый эталон приходит ему
 * предложением. Литералы — дословный перенос тел «Года» и «Жизни» до правки словарём 1б.
 */
export const LEGACY_ETALON_TEXTS: Readonly<Partial<Record<SupplyKey, string>>> = {
  'horizon-year': `Горизонт «год»: цели. Годовой срок задачи грамматика не выражает, поэтому длинный горизонт держится целями — сущностями с аспектом orbis/goal, прогресс которых считает сервер. Недавно тронутые сверху.

Лестница горизонтов целиком: день — список «Daily Planning», неделя и месяц — список «Upcoming», год — этот список, жизнь — список «Жизнь». «Жизнь» не закреплена в сайдбаре: её находит Browser по тегу smart-list.

{{query:aspect=orbis/goal, sortBy=orbis/updated_at:desc, display=list, title=Цели}}`,
  'horizon-life': `Горизонт «жизнь»: не список задач, а вопросы ревизии. Перечитывать раз в год.

- **Ценности** — что должно остаться правдой про меня через десять лет?
- **Зоны ответственности** — что я обязан держать в порядке: здоровье, семья, деньги, работа, дом?
- **Отказы** — от чего отказываюсь в этом году, чтобы освободить место остальному?

Ответы держите отдельными сущностями и вешайте на них тег life — блок ниже соберёт их. Пока такого тега нет ни на одной сущности, блок честно покажет «ничего не найдено».

{{query:tags=life, sortBy=orbis/updated_at:desc, display=list, title="Ценности и зоны ответственности"}}`,
};

/**
 * Свойства записи-приложения, из которых состоит её печать: то, что описывает место. «Выключено»
 * (`orbis/app_disabled`) — не содержимое, а состояние, и пишет его только `app-toggle`: войди оно в печать,
 * «Вернуть как было» не смогло бы его вернуть (правка механизмом `user` получила бы отказ `writer`).
 * Свойства поставки (ключ, отпечаток, текст, отказ) — не содержимое записи, а её эталон.
 */
export const APP_PRINT_PROPS: readonly string[] = [
  APP_HOME,
  APP_NAV,
  APP_NAV_FORM,
  APP_EXTENSIONS,
  APP_OPENS_OVER,
];

/** Значение с ключами объектов по алфавиту на любой глубине; массивы — в своём порядке (порядок разделов — смысл). */
function sortedDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedDeep);
  if (typeof value === 'object' && value !== null) {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(src).sort()) {
      if (src[k] !== undefined) out[k] = sortedDeep(src[k]);
    }
    return out;
  }
  return value;
}

/** Канонический JSON: ключи по алфавиту, по строке на значение — сравнение «Обновлений» идёт построчно. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(sortedDeep(value), null, 2);
}

/** Кодовая форма эталона оболочки — по КЛЮЧАМ (одинакова в любом графе): вход отпечатка. */
export function printAppEtalon(e: Extract<SupplyEtalon, { kind: 'app' }>): string {
  return canonicalJson({
    key: e.key,
    kind: e.kind,
    title: e.title,
    emoji: e.emoji,
    home: e.home,
    nav: [...e.nav],
    navForm: e.navForm,
  });
}

/** Каноническая печать записи-приложения в графе — по id (канонический JSON с отсортированными ключами). */
export function printAppProps(r: {
  title: string;
  emoji: string | null;
  props: Record<string, unknown>;
}): string {
  const props: Record<string, unknown> = {};
  for (const id of APP_PRINT_PROPS) {
    if (r.props[id] !== undefined) props[id] = r.props[id];
  }
  return canonicalJson({ title: r.title, emoji: r.emoji, props });
}

export function parseAppPrint(text: string): {
  title: string;
  emoji: string | null;
  props: Record<string, unknown>;
} {
  const v = JSON.parse(text) as unknown;
  if (typeof v !== 'object' || v === null) throw new Error('печать приложения — не объект');
  const o = v as Record<string, unknown>;
  const { title, emoji, props } = o;
  if (typeof title !== 'string') throw new Error('печать приложения без заголовка');
  if (emoji !== null && typeof emoji !== 'string') throw new Error('эмодзи печати — не строка');
  if (typeof props !== 'object' || props === null || Array.isArray(props)) {
    throw new Error('свойства печати — не объект');
  }
  return { title, emoji, props: props as Record<string, unknown> };
}

/**
 * Каноническая печать записи-страницы: первая строка — заголовок и эмодзи каноническим JSON (в нём не
 * бывает перевода строки), пустая строка, дальше тело как есть. Как у приложения, в печать входят
 * заголовок и эмодзи: переименование — тоже «изменено вами».
 */
export function printPageRecord(r: { title: string; emoji: string | null; body: string }): string {
  return `${JSON.stringify(sortedDeep({ title: r.title, emoji: r.emoji }))}\n\n${r.body}`;
}

export function parsePagePrint(text: string): {
  title: string;
  emoji: string | null;
  body: string;
} {
  const nl = text.indexOf('\n');
  if (nl < 0 || text[nl + 1] !== '\n') throw new Error('печать страницы без шапки');
  const head = JSON.parse(text.slice(0, nl)) as { title?: unknown; emoji?: unknown };
  if (typeof head.title !== 'string') throw new Error('печать страницы без заголовка');
  if (head.emoji !== null && typeof head.emoji !== 'string') {
    throw new Error('эмодзи печати — не строка');
  }
  return { title: head.title, emoji: head.emoji, body: text.slice(nl + 2) };
}

function isSupplyKey(v: unknown): v is SupplyKey {
  return typeof v === 'string' && (SUPPLY_KEYS as readonly string[]).includes(v);
}

/**
 * «как в поставке» | «изменено вами» | не запись поставки (§9.1 п. 5).
 *
 * Сравнение — с печатью эталона В ЗАПИСИ (`orbis/supply_text`), а не с эталоном кода: запись, пришедшая
 * с прежним эталоном и не правленая, — «как в поставке», даже когда в коде эталон новее (это обновление,
 * а не правка владельца). Род печати — по ключу эталона; ключ, которого этот код не знает (запись из
 * более нового релиза), — по аспекту «приложение».
 */
export function supplyStatusOf(r: {
  aspects: readonly string[];
  body: string | null;
  title: string;
  emoji: string | null;
  props: Record<string, unknown>;
}): 'etalon' | 'edited' | null {
  if (!r.aspects.includes(SUPPLY_ASPECT)) return null;
  const text = r.props[SUPPLY_TEXT];
  // Эталона в записи нет — сказать «как в поставке» нечем; «изменено вами» честнее: такую запись
  // «Принять все» не тронет без явного взгляда владельца.
  if (typeof text !== 'string') return 'edited';
  const key = r.props[SUPPLY_KEY];
  const isApp = isSupplyKey(key) ? etalonOf(key).kind === 'app' : r.aspects.includes(APP_ASPECT);
  const print = isApp
    ? printAppProps({ title: r.title, emoji: r.emoji, props: r.props })
    : printPageRecord({ title: r.title, emoji: r.emoji, body: r.body ?? '' });
  return print === text ? 'etalon' : 'edited';
}
