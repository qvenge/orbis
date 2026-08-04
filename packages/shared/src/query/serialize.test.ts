import { describe, expect, test } from 'bun:test';
import { BUILTIN_ASPECT_IDS } from '../constants';
import { aspectJsonSchema } from '../schemas/aspects';
import type { QueryAst, QueryFilter } from './grammar';
import { buildFieldCatalog, parseQuery } from './parse';
import { serializeQuery } from './serialize';

// Каталог полей — тот же рецепт, что у parse.test.ts: реальные схемы встроенных аспектов.
const catalog = buildFieldCatalog(
  BUILTIN_ASPECT_IDS.map((id) => ({ id, schema: aspectJsonSchema(id) })),
);

function astOf(q: string): QueryAst {
  const r = parseQuery(q, catalog);
  if (!r.ok) throw new Error(`не разобралось: ${q}\n  ${r.error.message} @${r.error.position}`);
  return r.ast;
}

/**
 * Два инварианта сериализатора:
 * (а) round-trip по AST — печать не меняет смысл запроса;
 * (б) идемпотентность — повторная печать байт-в-байт совпадает с первой.
 * Байт-в-байт с ИСХОДНОЙ строкой инвариантом не является: парсер нормализует
 * переносы строк, отступы и незначащие нули, и обратно их не восстановить.
 */
function expectRoundTrip(q: string): void {
  const ast = astOf(q);
  const printed = serializeQuery(ast);
  expect(astOf(printed)).toEqual(ast);
  expect(serializeQuery(astOf(printed))).toBe(printed);
}

const UUID = '019ea8b1-4778-7f3d-9a5c-6a521fa1cc24';

// Покрытие всех десяти узлов QueryFilter — набор проверяется тестом «все kind покрыты»,
// поэтому потеря кейса не пройдёт молча.
const CASES = [
  'aspect=orbis/task, status=inbox, sortBy=created_at:desc, display=list, title=Inbox',
  'aspect=orbis/task, due_date=today|overdue, status=!done&!cancelled&!waiting, excludeBlocked=true, sortBy=priority:desc|due_date:asc, display=list, title=Сегодня',
  'aspect=orbis/financial, amount=500..2000, occurred_on=2026-06-01..2026-06-30',
  'children_of=this, archived=any, limit=30',
  'search=обед, tags=work|personal, excludeTags=archive',
  'aspect=orbis/financial, amount>1000, updated_at>2026-07-02T09:00:00Z',
  `children_of=${UUID}, parents_of=${UUID}, archived=true`,
  'aspect=orbis/task, due_date<2026-07-01, sortBy=title:asc, display=table',
  'updated_at=2026-07-01T00:00:00Z..2026-08-01T00:00:00+03:00, display=compact',
  'aspect=orbis/financial, amount>-100, occurred_on=next_7d',
];

// Шесть body-блоков трёх исходных сидированных smart lists — литералами (кросс-пакетный
// импорт из apps/server запрещён), источник apps/server/src/seed/smart-lists.ts. Обёртка
// `{{query: }}` снята так же, как это делает рендерер body (bodySegments: inner + trim);
// переносы строк и 9-пробельные отступы continuation-строк сохранены — их нормализует сам
// парсер. Блоки двух горизонтов планирования — «Года» и «Жизни» (E4) — сюда НЕ скопированы
// намеренно: узлов грамматики сверх покрытых CASES они не приносят (те же aspect/tags/
// sortBy), а второй литеральный список без импорта из сида дрейфовал бы молча.
const SEEDED_BLOCKS = [
  'aspect=orbis/task, status=inbox,\n' +
    '         sortBy=created_at:desc, display=list, title=Inbox',
  'aspect=orbis/task, due_date=today|overdue, status=!done&!cancelled&!waiting,\n' +
    '         excludeBlocked=true, sortBy=priority:desc|due_date:asc,\n' +
    '         display=list, title=Сегодня',
  'aspect=orbis/task, status=waiting,\n' +
    '         sortBy=updated_at:asc, display=compact, title=Ожидание',
  'aspect=orbis/task, due_date=next_7d, status=!done&!cancelled,\n' +
    '         sortBy=due_date:asc|priority:desc, display=list, title=Ближайшие 7 дней',
  'aspect=orbis/task, due_date=after_7d, status=!done&!cancelled,\n' +
    '         sortBy=due_date:asc, limit=30, display=compact, title=Позже',
  'aspect=orbis/task, status=!done&!cancelled,\n' +
    '         sortBy=updated_at:desc, display=list, title=Все незакрытые задачи',
];

describe('serializeQuery: round-trip по всей грамматике §6.1', () => {
  test.each(CASES)('round-trip: %s', (q) => {
    expectRoundTrip(q);
  });

  test('набор кейсов покрывает все десять узлов QueryFilter', () => {
    const seen = new Set<QueryFilter['kind']>();
    for (const q of CASES) for (const f of astOf(q).filters) seen.add(f.kind);
    expect([...seen].sort()).toEqual([
      'archived',
      'aspect',
      'children_of',
      'comparison',
      'excludeBlocked',
      'excludeTags',
      'field',
      'parents_of',
      'range',
      'tags',
    ]);
  });

  test.each(SEEDED_BLOCKS)('round-trip сидированного smart-list: %s', (block) => {
    expectRoundTrip(block);
  });

  test('многострочный сидированный блок печатается одной строкой без обёртки', () => {
    const printed = serializeQuery(astOf(SEEDED_BLOCKS[0] as string));
    expect(printed).toBe(
      'aspect=orbis/task, status=inbox, sortBy=created_at:desc, display=list, title=Inbox',
    );
  });

  test('алиас due печатается каноническим именем due_date', () => {
    expect(serializeQuery(astOf('due=today'))).toBe('due_date=today');
  });

  test('порядок печати: фильтры в порядке массива, затем sortBy, search, limit, display, title', () => {
    const q =
      'title=T, display=list, limit=5, search=s, sortBy=created_at:asc, tags=a, aspect=orbis/task';
    expect(serializeQuery(astOf(q))).toBe(
      'tags=a, aspect=orbis/task, sortBy=created_at:asc, search=s, limit=5, display=list, title=T',
    );
  });
});

describe('serializeQuery: квотирование значений', () => {
  test('значения с запятой и кавычками экранируются', () => {
    expect(serializeQuery(astOf('search="обед, ужин"'))).toBe('search="обед, ужин"');
    expect(serializeQuery(astOf('title="My Tasks, \\"важное\\""'))).toBe(
      'title="My Tasks, \\"важное\\""',
    );
    expectRoundTrip('title="My Tasks, \\"важное\\""');
  });

  test('бэкслеш экранируется (симметрично unquote парсера)', () => {
    expect(serializeQuery(astOf('search="кофе, эклер\\\\"'))).toBe('search="кофе, эклер\\\\"');
    expectRoundTrip('search="a\\\\b \\"quoted\\" c\\\\"');
  });

  test('значение с .. квотируется: без кавычек парсер увидел бы диапазон', () => {
    const q = 'aspect=orbis/task, status="a..b"';
    expect(serializeQuery(astOf(q))).toBe(q);
    expectRoundTrip(q);
    // Контрольный выстрел: без кавычек это ошибка парсинга, а не тот же AST.
    expect(parseQuery('aspect=orbis/task, status=a..b', catalog).ok).toBe(false);
  });

  test('ведущий ! квотируется: без кавычек anyOf молча стал бы noneOf', () => {
    const q = 'aspect=orbis/task, status="!foo"';
    expect(serializeQuery(astOf(q))).toBe(q);
    expectRoundTrip(q);
    // Контрольный выстрел: без кавычек парсер молча отдаёт noneOf вместо anyOf.
    const naive = astOf('aspect=orbis/task, status=!foo');
    expect(naive.filters[1]).toEqual({
      kind: 'field',
      field: 'status',
      condition: { kind: 'noneOf', values: [{ kind: 'literal', value: 'foo' }] },
    } satisfies QueryFilter);
    expect(naive.filters[1]).not.toEqual(astOf(q).filters[1] as QueryFilter);
  });

  test('пустое значение печатается как "": без кавычек парсер падает', () => {
    expect(serializeQuery(astOf('search=""'))).toBe('search=""');
    expect(serializeQuery(astOf('title=""'))).toBe('title=""');
    expect(serializeQuery(astOf('tags=""'))).toBe('tags=""');
    expectRoundTrip('search="", title="", tags=""');
    expect(parseQuery('search=', catalog).ok).toBe(false);
  });

  test('краевые пробелы квотируются — парсер обрезает края конструкции', () => {
    expect(serializeQuery(astOf('search=" пробелы "'))).toBe('search=" пробелы "');
    expectRoundTrip('search=" пробелы "');
  });

  test('разделители грамматики внутри значения: , = | & > <', () => {
    for (const ch of [',', '=', '|', '&', '>', '<']) {
      const q = `search="a${ch}b"`;
      expect(serializeQuery(astOf(q))).toBe(q);
      expectRoundTrip(q);
    }
  });

  test('элементы списков и отрицаний квотируются поэлементно', () => {
    expectRoundTrip('tags="a,b"|"c|d", excludeTags="x&y"');
    expectRoundTrip('aspect=orbis/task, status=!"a,b"&!"c|d"');
    expect(serializeQuery(astOf('aspect=orbis/task, status=!"a,b"&!done'))).toBe(
      'aspect=orbis/task, status=!"a,b"&!done',
    );
  });

  test('имена полей и sortBy не квотируются — кавычки там ломают резолв', () => {
    expect(serializeQuery(astOf('sortBy=title:asc|updated_at:desc'))).toBe(
      'sortBy=title:asc|updated_at:desc',
    );
    expect(parseQuery('sortBy="title":asc', catalog).ok).toBe(false);
  });

  test('обычные значения кавычек не получают — сидированные блоки остаются читаемыми', () => {
    expect(serializeQuery(astOf('aspect=orbis/task, title=Ближайшие 7 дней'))).toBe(
      'aspect=orbis/task, title=Ближайшие 7 дней',
    );
  });
});

describe('serializeQuery: неоднозначные поля', () => {
  test('печать сохраняет aspect=, которым резолвится неоднозначное имя', () => {
    // category_ref живёт и в orbis/financial, и в orbis/budget: потеря aspect= при
    // печати сделала бы строку неразбираемой.
    const q = `aspect=orbis/financial, category_ref=${UUID}`;
    expect(serializeQuery(astOf(q))).toBe(q);
    expectRoundTrip(q);
    expect(parseQuery(`category_ref=${UUID}`, catalog).ok).toBe(false);
  });
});

// AST, собранный формой (а не парсером), может оказаться непечатаемым: строка либо
// не разберётся, либо ТИХО даст другой смысл. Контракт — Error, а не молчаливая порча.
describe('serializeQuery: непечатаемый AST — исключение, а не тихая порча', () => {
  const anyOf = (field: string, value: string): QueryFilter => ({
    kind: 'field',
    field,
    condition: { kind: 'anyOf', values: [{ kind: 'literal', value }] },
  });

  // Список ключей грамматики §6.1. Третья копия набора (парсер / сериализатор / тест)
  // — сознательная: тест пришпиливает обе рабочие копии к одному явному списку.
  const RESERVED = [
    'tags',
    'excludeTags',
    'aspect',
    'children_of',
    'parents_of',
    'excludeBlocked',
    'archived',
    'sortBy',
    'search',
    'limit',
    'display',
    'title',
  ];

  test('набор зарезервированных ключей сериализатора совпадает с набором парсера', () => {
    for (const key of RESERVED) {
      // (а) парсер действительно считает ключ зарезервированным…
      const r = parseQuery(`${key}>1`, catalog);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.message).toMatch(/неприменим к ключу/);
      // (б) …и сериализатор отказывается печатать поле с этим именем.
      expect(() => serializeQuery({ filters: [anyOf(key, 'x')] })).toThrow(
        /занято ключом грамматики/,
      );
    }
    // Контроль: обычное поле каталога ни там, ни там не зарезервировано.
    expect(parseQuery('aspect=orbis/financial, amount>1', catalog).ok).toBe(true);
    expect(() => serializeQuery({ filters: [anyOf('status', 'x')] })).not.toThrow();
  });

  test('имя поля, занятое ключом грамматики: фильтр иначе исчез бы молча', () => {
    // limit — реальное свойство orbis/budget, форма редактора возьмёт его из каталога.
    expect(catalog.fields.limit?.map((i) => i.aspect)).toEqual(['orbis/budget']);
    expect(() => serializeQuery({ filters: [anyOf('limit', '100')] })).toThrow(/limit/);
    // Именно то, что случилось бы без guard: фильтр исчезает, ошибки нет.
    expect(parseQuery('limit=100', catalog)).toEqual({
      ok: true,
      ast: { filters: [], limit: 100 },
    });
    // Тот же ключ в comparison и range.
    expect(() =>
      serializeQuery({
        filters: [
          { kind: 'comparison', field: 'limit', op: '>', value: { kind: 'decimal', value: '1' } },
        ],
      }),
    ).toThrow(/занято ключом грамматики/);
    expect(() =>
      serializeQuery({
        filters: [
          {
            kind: 'range',
            field: 'limit',
            min: { kind: 'decimal', value: '1' },
            max: { kind: 'decimal', value: '2' },
          },
        ],
      }),
    ).toThrow(/занято ключом грамматики/);
  });

  test('guard не перебарщивает: тот же ключ внутри sortBy легален', () => {
    // resolveField внутри sortBy резолвит limit как обычное поле orbis/budget.
    expect(serializeQuery({ filters: [], sortBy: [{ field: 'limit', direction: 'asc' }] })).toBe(
      'sortBy=limit:asc',
    );
    expectRoundTrip('sortBy=limit:asc');
  });

  test('пустой список значений: строка не разобралась бы', () => {
    expect(() => serializeQuery({ filters: [{ kind: 'tags', values: [] }] })).toThrow(
      /пустой список значений/,
    );
    expect(() => serializeQuery({ filters: [{ kind: 'excludeTags', values: [] }] })).toThrow(
      /пустой список значений/,
    );
    expect(() =>
      serializeQuery({
        filters: [{ kind: 'field', field: 'status', condition: { kind: 'anyOf', values: [] } }],
      }),
    ).toThrow(/пустой список значений/);
    expect(() =>
      serializeQuery({
        filters: [{ kind: 'field', field: 'status', condition: { kind: 'noneOf', values: [] } }],
      }),
    ).toThrow(/пустой список значений/);
    // Ровно то, что напечаталось бы без guard, парсер отвергает.
    expect(parseQuery('tags=', catalog).ok).toBe(false);
  });

  test('пустой sortBy — тоже исключение, а не молчаливое отбрасывание', () => {
    expect(() => serializeQuery({ filters: [], sortBy: [] })).toThrow(/пустой список значений/);
    expect(parseQuery('sortBy=', catalog).ok).toBe(false);
  });

  test('limit вне контракта parseLimit: целое больше нуля', () => {
    for (const limit of [0, -3, 1.5, Number.NaN]) {
      expect(() => serializeQuery({ filters: [], limit })).toThrow(/limit должен быть целым/);
      expect(parseQuery(`limit=${limit}`, catalog).ok).toBe(false);
    }
    expect(serializeQuery({ filters: [], limit: 30 })).toBe('limit=30');
  });

  test("'}}' в значении закрыл бы обёртку {{query: … }} раньше времени", () => {
    expect(() => serializeQuery({ filters: [], title: 'a}}b' })).toThrow(/закроет обёртку/);
    expect(() => serializeQuery({ filters: [], search: 'a}}b' })).toThrow(/закроет обёртку/);
    expect(() => serializeQuery({ filters: [{ kind: 'tags', values: ['a}}b'] }] })).toThrow(
      /закроет обёртку/,
    );
    // Одиночная скобка безобидна и должна печататься как обычно.
    expect(serializeQuery({ filters: [], title: 'a}b' })).toBe('title=a}b');
    expectRoundTrip('title=a}b');
    // Две скобки в РАЗНЫХ конструкциях не слипаются — разделитель между ними.
    expectRoundTrip('search=a}, title=}b');
  });

  test('свойства, которые guard ломать не должен', () => {
    // Поэлементное квотирование в списках и в !-форме.
    expect(serializeQuery(astOf('tags="a,b"|c, excludeTags="x&y"'))).toBe(
      'tags="a,b"|c, excludeTags="x&y"',
    );
    expect(serializeQuery(astOf('aspect=orbis/task, status=!"a,b"&!done'))).toBe(
      'aspect=orbis/task, status=!"a,b"&!done',
    );
    // Печать параметров по !== undefined: пустая строка выживает как "" и не пропадает.
    expect(serializeQuery({ filters: [], search: '', title: '' })).toBe('search="", title=""');
    expectRoundTrip('search="", title=""');
  });
});
