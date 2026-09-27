/**
 * Эталоны поставки хоста (срез 1б §9.1, §9.2, §6.5, §3.5, §9.4; РП-6, РП-35): десять ключей, тексты,
 * печати записи и статус «как в поставке» / «изменено вами».
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  APP_ASPECT,
  APP_HOME,
  APP_NAV,
  APP_NAV_FORM,
  PAGE_ASPECT,
  SUPPLY_ASPECT,
  SUPPLY_KEY,
  SUPPLY_TEXT,
} from '../constants';
import { parsePageText } from '../doc/page-grammar';
import { bodyIssues } from '../doc/placement';
import { toParseRegistry } from '../query/parse-ast';
import { BUILTIN_ASPECT_DEFS } from '../registry/builtin-aspects';
import { BUILTIN_CONTRACT_DEFS } from '../registry/builtin-contracts';
import { BUILTIN_PROPERTY_META } from '../registry/builtin-properties';
import { BUILTIN_RELATION_ROLE_META } from '../registry/builtin-roles';
import {
  etalonOf,
  HOST_TEMPLATE_ETALON_TEXT,
  HOST_TEMPLATE_KEY,
  isHostTemplateRecord,
  LEGACY_ETALON_TEXTS,
  parseAppPrint,
  parsePagePrint,
  printAppEtalon,
  printAppProps,
  printPageRecord,
  RESERVED_APP_KEYS,
  SUPPLY_ETALONS,
  SUPPLY_KEYS,
  type SupplyEtalon,
  supplyStatusOf,
} from './etalons';
import { SEED_SMART_LISTS } from './lists';

/** Реестр разбора из встроенных определений: блоки данных эталонов обязаны разбираться им. */
const REG = toParseRegistry(
  {
    properties: new Map(BUILTIN_PROPERTY_META.map((p) => [p.id, p])),
    aspects: new Map(BUILTIN_ASPECT_DEFS.map((a) => [a.id, a])),
    roles: new Map(BUILTIN_RELATION_ROLE_META.map((r) => [r.id, r])),
    contracts: new Map(BUILTIN_CONTRACT_DEFS.map((c) => [c.id, c])),
  },
  'ru',
);

const pageEtalons = SUPPLY_ETALONS.filter(
  (e): e is Extract<SupplyEtalon, { kind: 'page' | 'template' }> => e.kind !== 'app',
);

describe('шаблон хоста (спека 1б §8.5, §9.2)', () => {
  test('ровно одна строка {{cards: own}} и ни одной {{card: …}}', () => {
    const lines = HOST_TEMPLATE_ETALON_TEXT.split('\n');
    expect(lines.filter((l) => l === '{{cards: own}}')).toHaveLength(1);
    expect(lines.filter((l) => l.startsWith('{{card:'))).toEqual([]);
    // Сверку с текстом §8.1 спеки 1а делает web-тест задачи 17 — одно место; здесь — только форма 1б.
    expect(etalonOf('host-template')).toMatchObject({
      kind: 'template',
      title: 'Шаблон хоста',
      emoji: '📄',
      text: HOST_TEMPLATE_ETALON_TEXT,
    });
  });

  test('isHostTemplateRecord — по ключу эталона «host-template», и только по нему', () => {
    expect(HOST_TEMPLATE_KEY).toBe('host-template');
    expect(isHostTemplateRecord({ props: { [SUPPLY_KEY]: 'host-template' } })).toBe(true);
    expect(isHostTemplateRecord({ props: { [SUPPLY_KEY]: 'home' } })).toBe(false);
    expect(isHostTemplateRecord({ props: {} })).toBe(false);
  });
});

describe('ключи и эталоны (РП-6)', () => {
  test('десять ключей в порядке РП-6, у каждого ровно один эталон', () => {
    expect([...SUPPLY_KEYS]).toEqual([
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
    ]);
    expect(SUPPLY_ETALONS.map((e) => e.key)).toEqual([...SUPPLY_KEYS]);
    for (const key of SUPPLY_KEYS) expect(etalonOf(key).key).toBe(key);
  });

  test('SUPPLY_KEYS == варианты orbis/supply_key реестра; budget зарезервирован и в варианты не входит', () => {
    const def = BUILTIN_PROPERTY_META.find((p) => p.id === SUPPLY_KEY);
    if (def?.type.kind !== 'select') throw new Error('orbis/supply_key — не select');
    expect(def.type.options.map((o) => o.key)).toEqual([...SUPPLY_KEYS]);
    expect([...RESERVED_APP_KEYS]).toEqual(['budget']);
    for (const k of RESERVED_APP_KEYS) expect(SUPPLY_KEYS as readonly string[]).not.toContain(k);
  });

  test('«Домой», «Записи», оболочка хоста — §6.5, §3.5', () => {
    expect(etalonOf('home')).toEqual({
      key: 'home',
      kind: 'page',
      title: 'Домой',
      emoji: '🏠',
      text: '{{apps}}',
    });
    expect(etalonOf('records')).toEqual({
      key: 'records',
      kind: 'page',
      title: 'Записи',
      emoji: '🗂️',
      text: '{{records}}',
    });
    expect(etalonOf('host-shell')).toEqual({
      key: 'host-shell',
      kind: 'app',
      title: 'Orbis',
      emoji: '🪐',
      home: 'home',
      nav: ['records', 'daily-planning', 'upcoming', 'all-tasks', 'horizon-year', 'routines'],
      navForm: 'header-list',
    });
  });

  test('шесть списков — заголовки, эмодзи и тела SEED_SMART_LISTS (§9.4)', () => {
    for (const list of SEED_SMART_LISTS) {
      expect(etalonOf(list.slug)).toEqual({
        key: list.slug,
        kind: 'page',
        title: list.title,
        emoji: list.emoji,
        text: list.body,
      });
    }
  });

  test('тела страниц без проблем мест; шаблон — в роде «шаблон»', () => {
    for (const e of pageEtalons) {
      const kind = e.kind === 'template' ? 'template' : 'page';
      expect([e.key, bodyIssues(parsePageText(e.text), kind, REG)]).toEqual([e.key, []]);
    }
  });
});

describe('словарь 1б в эталонах (спека §1, РП-35)', () => {
  // Слова, которые срез снимает: ни в одном тексте и заголовке эталона их нет (регистр не важен).
  const GONE = [
    'сущност',
    'smart-list',
    'смарт-лист',
    'сайдбар',
    'browser',
    'закреп',
    'views',
    'модуль',
  ];

  test('ни одного снятого слова в заголовках и текстах эталонов', () => {
    const found: string[] = [];
    for (const e of SUPPLY_ETALONS) {
      const texts = e.kind === 'app' ? [e.title] : [e.title, e.text];
      for (const t of texts) {
        const low = t.toLowerCase();
        for (const w of GONE) if (low.includes(w)) found.push(`${e.key}: «${w}»`);
      }
    }
    expect(found).toEqual([]);
  });

  test('«Год» и «Жизнь» сохранили смысл: лестница горизонтов и вопросы ревизии', () => {
    const year = etalonOf('horizon-year');
    const life = etalonOf('horizon-life');
    if (year.kind === 'app' || life.kind === 'app') throw new Error('горизонт — не страница');
    const ladder = year.text.split('\n').find((l) => l.startsWith('Лестница горизонтов'));
    for (const title of ['«Daily Planning»', '«Upcoming»', '«Жизнь»'])
      expect(ladder).toContain(title);
    for (const q of ['**Ценности**', '**Зоны ответственности**', '**Отказы**']) {
      expect(life.text).toContain(q);
    }
  });
});

describe('прежние эталоны (РП-35, В-9)', () => {
  // Перенос литералов из `apps/server/src/seed/smart-lists.ts` ДО правки задачи 11 — дословно: по ним
  // перевод данных задачи 13 узнаёт «как в поставке» прежней версии.
  const OLD_YEAR = `Горизонт «год»: цели. Годовой срок задачи грамматика не выражает, поэтому длинный горизонт держится целями — сущностями с аспектом orbis/goal, прогресс которых считает сервер. Недавно тронутые сверху.

Лестница горизонтов целиком: день — список «Daily Planning», неделя и месяц — список «Upcoming», год — этот список, жизнь — список «Жизнь». «Жизнь» не закреплена в сайдбаре: её находит Browser по тегу smart-list.

{{query:aspect=orbis/goal, sortBy=orbis/updated_at:desc, display=list, title=Цели}}`;
  const OLD_LIFE = `Горизонт «жизнь»: не список задач, а вопросы ревизии. Перечитывать раз в год.

- **Ценности** — что должно остаться правдой про меня через десять лет?
- **Зоны ответственности** — что я обязан держать в порядке: здоровье, семья, деньги, работа, дом?
- **Отказы** — от чего отказываюсь в этом году, чтобы освободить место остальному?

Ответы держите отдельными сущностями и вешайте на них тег life — блок ниже соберёт их. Пока такого тега нет ни на одной сущности, блок честно покажет «ничего не найдено».

{{query:tags=life, sortBy=orbis/updated_at:desc, display=list, title="Ценности и зоны ответственности"}}`;

  test('ровно «Год» и «Жизнь», прежние тела дословно, каждое отличается от нового эталона', () => {
    expect(Object.keys(LEGACY_ETALON_TEXTS).sort()).toEqual(['horizon-life', 'horizon-year']);
    expect(LEGACY_ETALON_TEXTS['horizon-year']).toBe(OLD_YEAR);
    expect(LEGACY_ETALON_TEXTS['horizon-life']).toBe(OLD_LIFE);
    for (const key of ['horizon-year', 'horizon-life'] as const) {
      const e = etalonOf(key);
      if (e.kind === 'app') throw new Error('горизонт — не страница');
      expect(e.text).not.toBe(LEGACY_ETALON_TEXTS[key] as string);
    }
  });
});

describe('печати записи (РП-6)', () => {
  test('printAppProps детерминирован: порядок ключей входа не важен; печатает только свойства приложения', () => {
    const a = printAppProps({
      title: 'Orbis',
      emoji: '🪐',
      props: { [APP_NAV_FORM]: 'header-list', [APP_NAV]: ['n1', 'n2'], [APP_HOME]: 'h' },
    });
    const b = printAppProps({
      title: 'Orbis',
      emoji: '🪐',
      props: {
        [APP_HOME]: 'h',
        [SUPPLY_KEY]: 'host-shell',
        [SUPPLY_TEXT]: 'что угодно',
        [APP_NAV]: ['n1', 'n2'],
        [APP_NAV_FORM]: 'header-list',
      },
    });
    expect(a).toBe(b);
    // Порядок разделов — смысл, а не шум: перестановка навигации — другая печать.
    expect(
      printAppProps({
        title: 'Orbis',
        emoji: '🪐',
        props: { [APP_NAV]: ['n2', 'n1'], [APP_HOME]: 'h' },
      }),
    ).not.toBe(
      printAppProps({
        title: 'Orbis',
        emoji: '🪐',
        props: { [APP_NAV]: ['n1', 'n2'], [APP_HOME]: 'h' },
      }),
    );
  });

  test('parseAppPrint(printAppProps(x)) ≈ x', () => {
    const x = {
      title: 'Orbis',
      emoji: '🪐',
      props: { [APP_HOME]: 'h', [APP_NAV]: ['a', 'b'], [APP_NAV_FORM]: 'home-hub' },
    };
    expect(parseAppPrint(printAppProps(x))).toEqual(x);
    expect(parseAppPrint(printAppProps({ ...x, emoji: null }))).toEqual({ ...x, emoji: null });
  });

  test('printPageRecord/parsePagePrint — туда и обратно, в том числе пустое тело и эмодзи null', () => {
    for (const x of [
      { title: 'Год', emoji: '🎯', body: 'Абзац\n\n{{query:aspect=orbis/goal}}' },
      { title: 'Пустая', emoji: null, body: '' },
      { title: 'Строки\nв заголовке', emoji: '🏠', body: '\n\nначало с пустых строк\n' },
    ]) {
      expect(parsePagePrint(printPageRecord(x))).toEqual(x);
    }
  });

  test('printAppEtalon — по ключам, детерминирован', () => {
    const shell = etalonOf('host-shell');
    if (shell.kind !== 'app') throw new Error('оболочка — не приложение');
    expect(printAppEtalon(shell)).toBe(printAppEtalon({ ...shell }));
    expect(printAppEtalon(shell)).toContain('"horizon-year"');
    expect(printAppEtalon({ ...shell, nav: [...shell.nav].reverse() })).not.toBe(
      printAppEtalon(shell),
    );
  });
});

describe('supplyStatusOf (§9.1 п. 5)', () => {
  const page = { title: 'Домой', emoji: '🏠', body: '{{apps}}' };
  const pageRecord = (over: Partial<typeof page> = {}) => {
    const r = { ...page, ...over };
    return {
      aspects: [PAGE_ASPECT, SUPPLY_ASPECT],
      title: r.title,
      emoji: r.emoji,
      body: r.body,
      props: { [SUPPLY_KEY]: 'home', [SUPPLY_TEXT]: printPageRecord(page) },
    };
  };

  test('страница: печать записи == supply_text → «etalon»; переименование, эмодзи, тело → «edited»', () => {
    expect(supplyStatusOf(pageRecord())).toBe('etalon');
    expect(supplyStatusOf(pageRecord({ title: 'Главная' }))).toBe('edited');
    expect(supplyStatusOf(pageRecord({ emoji: '🏡' }))).toBe('edited');
    expect(supplyStatusOf(pageRecord({ body: '{{apps}}\n\nСвоё' }))).toBe('edited');
  });

  test('сравнение — с supply_text записи, а не с эталоном кода', () => {
    // Запись пришла со своим (прежним) эталоном: пока она ему равна — «как в поставке», хотя эталон
    // кода уже другой. Иначе «принять все» считало бы правленой любую запись с непринятым обновлением.
    const old = { title: 'Домой', emoji: '🏠', body: 'Прежняя домашняя\n\n{{apps}}' };
    expect(
      supplyStatusOf({
        aspects: [PAGE_ASPECT, SUPPLY_ASPECT],
        ...old,
        props: { [SUPPLY_KEY]: 'home', [SUPPLY_TEXT]: printPageRecord(old) },
      }),
    ).toBe('etalon');
  });

  test('приложение — по printAppProps', () => {
    const props = { [APP_HOME]: 'h', [APP_NAV]: ['a', 'b'], [APP_NAV_FORM]: 'header-list' };
    const text = printAppProps({ title: 'Orbis', emoji: '🪐', props });
    const app = (p: Record<string, unknown>, title = 'Orbis') => ({
      aspects: [APP_ASPECT, SUPPLY_ASPECT],
      title,
      emoji: '🪐',
      body: '',
      props: { ...p, [SUPPLY_KEY]: 'host-shell', [SUPPLY_TEXT]: text },
    });
    expect(supplyStatusOf(app(props))).toBe('etalon');
    expect(supplyStatusOf(app({ ...props, [APP_NAV]: ['a', 'b', 'c'] }))).toBe('edited');
    expect(supplyStatusOf(app(props, 'Мой Orbis'))).toBe('edited');
  });

  test('запись без аспекта «поставка» → null', () => {
    expect(
      supplyStatusOf({ aspects: [PAGE_ASPECT], title: 'X', emoji: null, body: '', props: {} }),
    ).toBeNull();
  });
});

describe('листовость сабпата (вес экрана записи web)', () => {
  const read = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8');
  // Все формы, которыми модуль тянет другой (образец — `doc/placement.test.ts`).
  const SPECIFIER_RE =
    /^\s*import\b[^'"]*?(?:\bfrom\s*)?['"]([^'"]+)['"]|^\s*export\b[^;'"]*\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]?([^'")]*)|\brequire\s*\(\s*['"]?([^'")]*)/gm;
  const specifiers = (src: string) =>
    [...src.matchAll(SPECIFIER_RE)].map((m) => m[1] ?? m[2] ?? m[3] ?? m[4] ?? '');

  test('etalons.ts импортирует только ../constants и тела списков ./lists', () => {
    const found = specifiers(read('./etalons.ts'));
    expect(found).toContain('../constants');
    for (const s of found) expect(['../constants', './lists']).toContain(s);
  });

  test('lists.ts не импортирует ничего', () => {
    expect(specifiers(read('./lists.ts'))).toEqual([]);
  });

  test('index.ts отдаёт только etalons и lists', () => {
    for (const s of specifiers(read('./index.ts'))) expect(['./etalons', './lists']).toContain(s);
  });

  test('constants.ts сам листовой — сабпат не тянет барреля', () => {
    expect(specifiers(read('../constants.ts'))).toEqual([]);
  });
});
