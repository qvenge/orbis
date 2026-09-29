/**
 * Печати записей поставки и статус «как в поставке» / «изменено вами» (срез 1б §9.1 п. 1, 5; РП-6).
 *
 * Отдельный сабпат `@orbis/shared/supply/print`, НЕ реэкспорт барреля `@orbis/shared/supply` — ради
 * веса первого кадра web (задача 22): баррель (эталоны, ключи) экран записи и рамка берут ЭАГЕРНО, а
 * печати и статус нужны только ленивым частям (меню «⋯», плашка и сравнение поставки). Сборщик
 * относит модуль к чанку, из которого он достижим статически, — и через `export *` барреля тоже:
 * живи печати в `etalons.ts` или в реэкспорте барреля, их код ехал бы в эагерном чанке (+464…508 Б
 * gzip замыкания экрана записи, замер задачи 22).
 *
 * Модуль листовой, как и `etalons.ts`: только `../constants` и `./etalons` (сторож —
 * `etalons.test.ts`).
 */
import {
  APP_ASPECT,
  APP_EXTENSIONS,
  APP_HOME,
  APP_NAV,
  APP_NAV_FORM,
  APP_OPENS_OVER,
  SUPPLY_ASPECT,
  SUPPLY_KEY,
  SUPPLY_TEXT,
} from '../constants';
import { etalonOf, SUPPLY_KEYS, type SupplyEtalon, type SupplyKey } from './etalons';

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
 * а не правка владельца). Род печати — по ключу эталона (`SUPPLY_KEYS`); у ключа без эталона кода — по
 * аспекту «приложение»: так читаются и снятые с поставки (`RETIRED_SUPPLY_KEYS`, срез 1в §6.3: запись
 * Upcoming 1б), и ключ, которого этот код не знает (запись из более нового релиза).
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
