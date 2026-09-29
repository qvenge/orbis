// packages/shared/src/nav/address.test.ts
// ЗАЧЕМ ЭТОТ ТЕСТ: адрес «приложение + запись» (спека 1б §7.1) — идентификатор места ядра: его
// кладут в закладки, пересылают, вставляют в тело записи, и тот же разбор будет у нативного клиента.
// Тест держит четыре инварианта (С1б-2): таблица «ссылка ⇄ адрес» в обе стороны, отказ (`null`)
// вместо догадки на чужом и битом пути, перевод старых ссылок 1а (Фокус ревью п. 1 — закладка
// `/entity/…`, `/thread/…`, `/browser`, `/budget/category/…`, `/agenda` не должна ронять старт) и
// извлечение id записи из вставленного полного адреса (§7.4, Р-20).
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  type Address,
  type AppRef,
  buildAddress,
  type LegacyAddress,
  parseAddress,
  recordIdOfUrl,
  sameAddress,
} from './address';

const ID = '0198f0a1-1111-7000-8000-000000000001';
const APP = '0198f0a1-2222-7000-8000-00000000000a';
const HOST = { kind: 'host' } as const;
const ORIGIN = 'https://orbis-64q4.onrender.com';

describe('parseAddress: таблица ссылок §7.1', () => {
  const table: [string, Address | LegacyAddress | null][] = [
    // Новые ссылки 1б.
    ['/', { kind: 'home', app: HOST }],
    [`/r/${ID}`, { kind: 'record', app: HOST, id: ID }],
    [`/a/${APP}`, { kind: 'home', app: { kind: 'app', ref: APP } }],
    [`/a/${APP}/r/${ID}`, { kind: 'record', app: { kind: 'app', ref: APP }, id: ID }],
    // uuid в любом регистре — нормализуется в нижний (id из ссылки — ключ кеша наравне с id из БД).
    [`/a/${APP.toUpperCase()}`, { kind: 'home', app: { kind: 'app', ref: APP } }],
    [
      `/a/${APP.toUpperCase()}/r/${ID.toUpperCase()}`,
      { kind: 'record', app: { kind: 'app', ref: APP }, id: ID },
    ],
    [`/r/${ID.toUpperCase()}`, { kind: 'record', app: HOST, id: ID }],
    // Ключ поставки — как есть; нормализацию `host-shell` → хост делает правило открытия (задача 16).
    ['/a/host-shell', { kind: 'home', app: { kind: 'app', ref: 'host-shell' } }],
    [`/a/records/r/${ID}`, { kind: 'record', app: { kind: 'app', ref: 'records' }, id: ID }],
    // Экраны хоста.
    ['/chat', { kind: 'host-screen', screen: 'chat' }],
    ['/settings', { kind: 'host-screen', screen: 'settings' }],
    ['/settings/memory', { kind: 'host-screen', screen: 'memory' }],
    ['/search?q=%D0%B5%D0%B4%D0%B0', { kind: 'host-screen', screen: 'search', q: 'еда' }],
    ['/search', { kind: 'host-screen', screen: 'search', q: '' }],
    ['/search?x=1', { kind: 'host-screen', screen: 'search', q: '' }],
    ['/search?', { kind: 'host-screen', screen: 'search', q: '' }],
    ['/search?x=1&q=a%20b', { kind: 'host-screen', screen: 'search', q: 'a b' }],
    // `+` — пробел формы (так пишет `URLSearchParams` и адресная строка браузера).
    ['/search?q=a+b', { kind: 'host-screen', screen: 'search', q: 'a b' }],
    ['/search?q=a%2Bb', { kind: 'host-screen', screen: 'search', q: 'a+b' }],
    // Старые ссылки 1а (§7.1 «старые ссылки переводятся»).
    [`/entity/${ID}`, { kind: 'record', app: HOST, id: ID }],
    [`/entity/${ID.toUpperCase()}`, { kind: 'record', app: HOST, id: ID }],
    [`/thread/${ID}`, { kind: 'legacy-thread', threadId: ID }],
    [`/thread/${ID.toUpperCase()}`, { kind: 'legacy-thread', threadId: ID }],
    ['/browser', { kind: 'legacy-supply', key: 'records' }],
    ['/budget', { kind: 'reserved', key: 'budget' }],
    [`/budget/category/${ID}`, { kind: 'reserved', key: 'budget' }],
    ['/a/budget', { kind: 'reserved', key: 'budget' }],
    [`/a/budget/r/${ID}`, { kind: 'reserved', key: 'budget' }],
    ['/agenda', { kind: 'legacy-supply', key: 'agenda' }],
    // Один хвостовой слэш прощается (его дописывают браузеры и почтовые клиенты).
    [`/r/${ID}/`, { kind: 'record', app: HOST, id: ID }],
    [`/a/${APP}/`, { kind: 'home', app: { kind: 'app', ref: APP } }],
    ['/chat/', { kind: 'host-screen', screen: 'chat' }],
    ['/settings/memory/', { kind: 'host-screen', screen: 'memory' }],
    ['/search/?q=x', { kind: 'host-screen', screen: 'search', q: 'x' }],
    ['/browser/', { kind: 'legacy-supply', key: 'records' }],
    ['/budget/', { kind: 'reserved', key: 'budget' }],
    ['/a/budget/', { kind: 'reserved', key: 'budget' }],
    ['/agenda/', { kind: 'legacy-supply', key: 'agenda' }],
    // Отказы: догадка хуже отказа, вызывающий сам решает, что показать.
    [`/r/${ID}//`, null],
    ['//', null],
    ['/r/не-uuid', null],
    ['/r/', null],
    ['/a/', null],
    ['/a', null],
    ['/a/x/y', null],
    [`/a/x/r/${ID}/extra`, null],
    [`/a/x/r/не-uuid`, null],
    ['/a/Budget', null],
    ['/a/1abc', null],
    ['/a/under_score', null],
    [`/a/budget/x`, null],
    ['/unknown', null],
    ['/Chat', null],
    ['/settings/other', null],
    ['/budget/other', null],
    [`/budget/category/не-uuid`, null],
    [`/entity/не-uuid`, null],
    [`/thread/не-uuid`, null],
    ['/agenda/x', null],
    ['/browser/x', null],
    ['', null],
    ['r/x', null],
    // Путь обязан начинаться со слэша: иначе первый символ съелся бы как «ведущий слэш».
    [`xr/${ID}`, null],
    [`.a/${APP}`, null],
    // Query — только у поиска (РП-28): у остальных путей хвост не «понят», а отброшен бы молча.
    [`/r/${ID}?x=1`, null],
    ['/?x=1', null],
    ['/chat?q=1', null],
    [`/a/${APP}?x=1`, null],
    [`/entity/${ID}?x=1`, null],
    // Хеш — не часть адреса: состояние экрана живёт в истории, не в ссылке (§7.1).
    [`/r/${ID}#x`, null],
    ['/search?q=x#y', null],
    ['/#', null],
    // Битая кодировка запроса — отказ, а не исключение из `decodeURIComponent`.
    ['/search?q=%E0%A4%A', null],
    ['/search?q=%', null],
  ];

  for (const [input, expected] of table) {
    test(`${JSON.stringify(input)} → ${JSON.stringify(expected)}`, () => {
      expect(parseAddress(input)).toEqual(expected);
    });
  }
});

describe('buildAddress: сборка и круг', () => {
  const canonical: [Address, string][] = [
    [{ kind: 'home', app: HOST }, '/'],
    [{ kind: 'record', app: HOST, id: ID }, `/r/${ID}`],
    [{ kind: 'home', app: { kind: 'app', ref: APP } }, `/a/${APP}`],
    [{ kind: 'home', app: { kind: 'app', ref: 'records' } }, '/a/records'],
    [{ kind: 'record', app: { kind: 'app', ref: APP }, id: ID }, `/a/${APP}/r/${ID}`],
    [{ kind: 'record', app: { kind: 'app', ref: 'home' }, id: ID }, `/a/home/r/${ID}`],
    [{ kind: 'host-screen', screen: 'chat' }, '/chat'],
    [{ kind: 'host-screen', screen: 'settings' }, '/settings'],
    [{ kind: 'host-screen', screen: 'memory' }, '/settings/memory'],
    [{ kind: 'host-screen', screen: 'search', q: '' }, '/search'],
    [{ kind: 'host-screen', screen: 'search', q: 'еда' }, '/search?q=%D0%B5%D0%B4%D0%B0'],
    [{ kind: 'host-screen', screen: 'search', q: 'a+b &c=d#e' }, '/search?q=a%2Bb%20%26c%3Dd%23e'],
  ];

  for (const [address, path] of canonical) {
    test(`${JSON.stringify(address)} ⇄ ${path}`, () => {
      expect(buildAddress(address)).toBe(path);
      expect(parseAddress(buildAddress(address))).toEqual(address);
    });
  }

  test('одиночный суррогат в запросе не роняет сборку и сравнение: становится U+FFFD', () => {
    const broken = { kind: 'host-screen', screen: 'search', q: 'a\uD800' } as const;
    expect(buildAddress(broken)).toBe('/search?q=a%EF%BF%BD');
    expect(buildAddress({ kind: 'host-screen', screen: 'search', q: '\uDC00' })).toBe(
      '/search?q=%EF%BF%BD',
    );
    expect(sameAddress(broken, { kind: 'host-screen', screen: 'search', q: 'a\uFFFD' })).toBe(true);
    // Пара суррогатов (эмодзи) остаётся целой.
    expect(buildAddress({ kind: 'host-screen', screen: 'search', q: '😀' })).toBe(
      '/search?q=%F0%9F%98%80',
    );
  });

  test('поиск без q собирается как пустой запрос', () => {
    expect(buildAddress({ kind: 'host-screen', screen: 'search' })).toBe('/search');
  });
});

describe('sameAddress', () => {
  test('одно место — равны, в том числе поиск без q и с пустым q', () => {
    expect(sameAddress({ kind: 'home', app: HOST }, { kind: 'home', app: HOST })).toBe(true);
    expect(
      sameAddress(
        { kind: 'record', app: { kind: 'app', ref: APP }, id: ID },
        { kind: 'record', app: { kind: 'app', ref: APP }, id: ID },
      ),
    ).toBe(true);
    expect(
      sameAddress(
        { kind: 'host-screen', screen: 'search' },
        { kind: 'host-screen', screen: 'search', q: '' },
      ),
    ).toBe(true);
  });

  test('разные места — не равны: приложение, запись, экран, запрос поиска', () => {
    const rec = (app: AppRef, id: string): Address => ({ kind: 'record', app, id });
    expect(sameAddress(rec(HOST, ID), rec({ kind: 'app', ref: APP }, ID))).toBe(false);
    expect(sameAddress(rec(HOST, ID), rec(HOST, APP))).toBe(false);
    expect(sameAddress(rec(HOST, ID), { kind: 'home', app: HOST })).toBe(false);
    expect(
      sameAddress(
        { kind: 'host-screen', screen: 'settings' },
        { kind: 'host-screen', screen: 'memory' },
      ),
    ).toBe(false);
    expect(
      sameAddress(
        { kind: 'host-screen', screen: 'search', q: 'a' },
        { kind: 'host-screen', screen: 'search', q: 'b' },
      ),
    ).toBe(false);
    expect(
      sameAddress({ kind: 'home', app: HOST }, { kind: 'home', app: { kind: 'app', ref: 'home' } }),
    ).toBe(false);
  });
});

describe('recordIdOfUrl: вставленный адрес → id записи (§7.4, Р-20)', () => {
  const table: [string, string | null][] = [
    [`${ORIGIN}/a/x/r/${ID}`, ID],
    [`${ORIGIN}/r/${ID}`, ID],
    [`${ORIGIN}/r/${ID.toUpperCase()}`, ID],
    [`${ORIGIN}/a/${APP}/r/${ID}`, ID],
    // Старая ссылка на запись — тоже запись.
    [`${ORIGIN}/entity/${ID}`, ID],
    // Ссылка на запись-приложение открывает приложение (Р-20): домашняя своего приложения — это его запись.
    [`${ORIGIN}/a/${APP}`, APP],
    [`${ORIGIN}/a/${APP.toUpperCase()}/`, APP],
    // Регистр схемы и хоста в URL не значим.
    [`HTTPS://ORBIS-64Q4.ONRENDER.COM/r/${ID}`, ID],
    // Не записи: домашняя по ключу поставки, экраны хоста, старые экраны, резерв.
    [`${ORIGIN}/a/host-shell`, null],
    [`${ORIGIN}/a/records`, null],
    [`${ORIGIN}/`, null],
    [ORIGIN, null],
    [`${ORIGIN}/chat`, null],
    [`${ORIGIN}/search?q=x`, null],
    [`${ORIGIN}/settings/memory`, null],
    [`${ORIGIN}/thread/${ID}`, null],
    [`${ORIGIN}/browser`, null],
    [`${ORIGIN}/a/budget/r/${ID}`, null],
    [`${ORIGIN}/budget/category/${ID}`, null],
    // Чужой origin — не наш адрес, даже с нашей формой пути.
    [`https://example.com/r/${ID}`, null],
    [`http://orbis-64q4.onrender.com/r/${ID}`, null],
    [`${ORIGIN}.evil.com/r/${ID}`, null],
    [`${ORIGIN}:8443/r/${ID}`, null],
    // Хост-двойник, у которого за нашим origin идёт один символ и затем наш путь.
    [`${ORIGIN}.r/${ID}`, null],
    [`${ORIGIN}x/a/${APP}`, null],
    // Относительный путь — не «полный адрес Orbis».
    [`/r/${ID}`, null],
    // Битые формы.
    [`${ORIGIN}/r/${ID}?x=1`, null],
    [`${ORIGIN}/r/${ID}#x`, null],
    [`${ORIGIN}/r/не-uuid`, null],
    ['', null],
  ];

  for (const [url, expected] of table) {
    test(`${JSON.stringify(url)} → ${JSON.stringify(expected)}`, () => {
      expect(recordIdOfUrl(url, ORIGIN)).toBe(expected);
    });
  }

  test('origin с хвостовым слэшем понимается так же', () => {
    expect(recordIdOfUrl(`${ORIGIN}/r/${ID}`, `${ORIGIN}/`)).toBe(ID);
  });

  test('origin без схемы (непрозрачный `null`, голое слово) — не наш адрес', () => {
    expect(recordIdOfUrl(`null/r/${ID}`, 'null')).toBe(null);
    expect(recordIdOfUrl(`x/r/${ID}`, 'x')).toBe(null);
    expect(recordIdOfUrl(`/r/${ID}`, '')).toBe(null);
  });

  test('локальный origin с портом', () => {
    expect(recordIdOfUrl(`http://localhost:5173/r/${ID}`, 'http://localhost:5173')).toBe(ID);
    expect(recordIdOfUrl(`http://localhost:5174/r/${ID}`, 'http://localhost:5173')).toBe(null);
  });
});

describe('листовость сабпата @orbis/shared/nav (первый кадр web)', () => {
  // Web тянет адрес в эагерный кадр (разбор ссылки при старте): удобный импорт из барреля в
  // address.ts утяжелил бы первый кадр при зелёных тестах — `check-lazy-chunks` вес входного чанка
  // не смотрит. Образец — `supply/etalons.test.ts`, `doc/placement.test.ts`. Листовость самого
  // `supply/etalons` держит его собственный сторож.
  const read = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8');
  // Все формы, которыми модуль тянет другой: импорт, реэкспорт, динамический импорт, require.
  const SPECIFIER_RE =
    /^\s*import\b[^'"]*?(?:\bfrom\s*)?['"]([^'"]+)['"]|^\s*export\b[^;'"]*\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]?([^'")]*)|\brequire\s*\(\s*['"]?([^'")]*)/gm;
  const specifiers = (src: string) =>
    [...src.matchAll(SPECIFIER_RE)].map((m) => m[1] ?? m[2] ?? m[3] ?? m[4] ?? '');

  test('address.ts импортирует только ../supply/etalons', () => {
    const found = specifiers(read('./address.ts'));
    expect(found).toContain('../supply/etalons');
    for (const s of found) expect(['../supply/etalons']).toContain(s);
  });

  test('history-model.ts импортирует только ./address', () => {
    const found = specifiers(read('./history-model.ts'));
    expect(found).toContain('./address');
    for (const s of found) expect(['./address']).toContain(s);
  });

  test('index.ts отдаёт только ./address и ./history-model', () => {
    const found = specifiers(read('./index.ts'));
    expect(found).toContain('./address');
    expect(found).toContain('./history-model');
    for (const s of found) expect(['./address', './history-model']).toContain(s);
  });

  test('положительный контроль: регэксп видит все формы', () => {
    // Иначе зелёный сторож мог бы значить лишь сломанный регэксп.
    expect(specifiers("import { x } from '../doc';")).toEqual(['../doc']);
    expect(specifiers("import type { X } from '../index';")).toEqual(['../index']);
    expect(specifiers("import '../doc';")).toEqual(['../doc']);
    expect(specifiers("export { x } from '../doc';")).toEqual(['../doc']);
    expect(specifiers("export * from '../index'")).toEqual(['../index']);
    expect(specifiers("const m = await import ('../doc');")).toEqual(['../doc']);
    expect(specifiers("require('../doc')")).toEqual(['../doc']);
    // Корневой баррель — не листовой: сторож на нём покраснел бы.
    expect(
      specifiers(read('../index.ts')).some((s) => s !== './address' && s !== './history-model'),
    ).toBe(true);
  });

  test('сабпат @orbis/shared/nav объявлен в exports', () => {
    const pkg = JSON.parse(read('../../package.json')) as { exports: Record<string, string> };
    expect(pkg.exports['./nav']).toBe('./src/nav/index.ts');
  });
});
