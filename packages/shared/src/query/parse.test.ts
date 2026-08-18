import { describe, expect, test } from 'bun:test';
import { BUILTIN_ASPECT_IDS } from '../constants';
import { aspectJsonSchema } from '../schemas/aspects';
import { buildFieldCatalog, parseQuery } from './parse';

const catalog = buildFieldCatalog(
  BUILTIN_ASPECT_IDS.map((id) => ({ id, schema: aspectJsonSchema(id) })),
);
const parse = (q: string) => parseQuery(q, catalog);

describe('parseQuery: позитивные случаи §6.1', () => {
  test('Daily Planning «Сегодня» — блок из 02 §3.3 парсится целиком', () => {
    const r = parse(
      'aspect=orbis/task, due_date=today|overdue, status=!done&!cancelled&!waiting,\n' +
        '         excludeBlocked=true, sortBy=priority:desc|due_date:asc,\n' +
        '         display=list, title=Сегодня',
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.ast.filters).toEqual([
      { kind: 'aspect', aspect: 'orbis/task' },
      {
        kind: 'field',
        field: 'due_date',
        condition: {
          kind: 'anyOf',
          values: [
            { kind: 'date_token', token: 'today' },
            { kind: 'date_token', token: 'overdue' },
          ],
        },
      },
      {
        kind: 'field',
        field: 'status',
        condition: {
          kind: 'noneOf',
          values: [
            { kind: 'literal', value: 'done' },
            { kind: 'literal', value: 'cancelled' },
            { kind: 'literal', value: 'waiting' },
          ],
        },
      },
      { kind: 'excludeBlocked' },
    ]);
    expect(r.ast.sortBy).toEqual([
      { field: 'priority', direction: 'desc' },
      { field: 'due_date', direction: 'asc' },
    ]);
    expect(r.ast.display).toBe('list');
    expect(r.ast.title).toBe('Сегодня');
  });
  test('теги, исключение тегов, кавычки с запятой и экранированием', () => {
    const r = parse('tags=work|personal, excludeTags=archived-tag, title="My Tasks, \\"важное\\""');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.ast.filters[0]).toEqual({ kind: 'tags', values: ['work', 'personal'] });
    expect(r.ast.filters[1]).toEqual({ kind: 'excludeTags', values: ['archived-tag'] });
    expect(r.ast.title).toBe('My Tasks, "важное"');
  });
  test('сравнение, диапазон, timestamp-курсор агента', () => {
    const r1 = parse('aspect=orbis/financial, amount>1000');
    expect(r1.ok && r1.ast.filters[1]).toEqual({
      kind: 'comparison',
      field: 'amount',
      op: '>',
      value: { kind: 'decimal', value: '1000' },
    });
    const r2 = parse('aspect=orbis/financial, amount=500..2000');
    expect(r2.ok && r2.ast.filters[1]).toEqual({
      kind: 'range',
      field: 'amount',
      min: { kind: 'decimal', value: '500' },
      max: { kind: 'decimal', value: '2000' },
    });
    const r3 = parse('updated_at>2026-07-02T09:00:00Z');
    expect(r3.ok && r3.ast.filters[0]).toEqual({
      kind: 'comparison',
      field: 'updated_at',
      op: '>',
      value: { kind: 'timestamp', value: '2026-07-02T09:00:00Z' },
    });
  });
  test('абсолютный диапазон date-поля аспекта: occurred_on=2026-06-01..2026-06-30 (§6.1, B5)', () => {
    const r = parse('aspect=orbis/financial, occurred_on=2026-06-01..2026-06-30');
    expect(r.ok && r.ast.filters[1]).toEqual({
      kind: 'range',
      field: 'occurred_on',
      min: { kind: 'date', value: '2026-06-01' },
      max: { kind: 'date', value: '2026-06-30' },
    });
  });
  test('абсолютные сравнения date-поля аспекта: occurred_on>… / due_date<…', () => {
    const r1 = parse('aspect=orbis/financial, occurred_on>2026-06-01');
    expect(r1.ok && r1.ast.filters[1]).toEqual({
      kind: 'comparison',
      field: 'occurred_on',
      op: '>',
      value: { kind: 'date', value: '2026-06-01' },
    });
    const r2 = parse('due_date<2026-07-01');
    expect(r2.ok && r2.ast.filters[0]).toEqual({
      kind: 'comparison',
      field: 'due_date',
      op: '<',
      value: { kind: 'date', value: '2026-07-01' },
    });
  });
  test('children_of/parents_of: uuid и this', () => {
    const id = '019ea8b1-4778-7f3d-9a5c-6a521fa1cc24';
    const r = parse(`children_of=${id}, parents_of=this`);
    expect(r.ok && r.ast.filters).toEqual([
      { kind: 'children_of', of: { kind: 'id', id } },
      { kind: 'parents_of', of: { kind: 'this' } },
    ]);
  });
  test('archived, limit, search, алиас due', () => {
    const r = parse('archived=any, limit=30, search=API, due=today');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.ast.filters).toContainEqual({ kind: 'archived', value: 'any' });
    expect(r.ast.limit).toBe(30);
    expect(r.ast.search).toBe('API');
    expect(r.ast.filters).toContainEqual({
      kind: 'field',
      field: 'due_date',
      condition: { kind: 'anyOf', values: [{ kind: 'date_token', token: 'today' }] },
    });
  });
});

describe('parseQuery: ошибки §6.4 (message + position)', () => {
  const fail = (q: string) => {
    const r = parse(q);
    expect(r.ok).toBe(false);
    return r.ok ? { message: '', position: -1 } : r.error;
  };
  test('смешивание | и & в одном значении', () => {
    expect(fail('status=a|b&!c').message).toMatch(/смешивание/i);
  });
  test('неизвестное поле — с позицией', () => {
    const e = fail('aspect=orbis/task, statuss=done');
    expect(e.message).toMatch(/неизвестное поле/i);
    expect(e.position).toBe('aspect=orbis/task, '.length);
  });
  test('неоднозначное поле без aspect=', () => {
    // category_ref есть и в orbis/financial, и в orbis/budget
    expect(fail('category_ref=019d48ea-2e00-7a52-876a-c301529b0456').message).toMatch(
      /неоднозначн/i,
    );
  });
  test('date-токен на нечисловом/недатовом поле', () => {
    expect(fail('aspect=orbis/task, status=today').message).toMatch(/date-токен|дат/i);
  });
  test('title в позиции фильтра занят параметром — отбор по заголовку только search=', () => {
    const r = parse('title=My');
    expect(r.ok && r.ast.title).toBe('My'); // это параметр заголовка, не фильтр
  });
  test('date-поле аспекта: не-дата в диапазоне/сравнении — ошибка, календарная валидность обеих границ', () => {
    // Значение обязано быть YYYY-MM-DD: ISO-timestamp и мусор для date-поля отклоняются
    expect(fail('aspect=orbis/financial, occurred_on>abc').message).toMatch(/YYYY-MM-DD|дат/i);
    expect(fail('aspect=orbis/financial, occurred_on>2026-06-01T00:00:00Z').message).toMatch(
      /YYYY-MM-DD|дат/i,
    );
    // Календарно-невалидные даты — ошибка парсинга, не тихий SQL-морок (§6.4)
    expect(fail('aspect=orbis/financial, occurred_on=2026-02-30..2026-03-01').message).toMatch(
      /календарно/i,
    );
    expect(fail('aspect=orbis/financial, occurred_on=2026-06-01..2026-13-01').message).toMatch(
      /календарно/i,
    );
  });
  test('строковые и timestamp-поля аспектов операторами/диапазоном не сравниваются (без расширения лишнего)', () => {
    expect(fail('aspect=orbis/task, status>done').message).toMatch(/тип 'string'/i);
    // start_at — timestamp-поле аспекта: расширение B5 покрывает только date-поля
    expect(fail('start_at>2026-06-01').message).toMatch(/тип 'timestamp'/i);
    expect(fail('start_at=2026-06-01..2026-06-30').message).toMatch(/тип 'timestamp'/i);
  });
  test('незакрытая кавычка, нулевой limit, кривой display', () => {
    expect(fail('title="oops').message).toMatch(/кавычк/i);
    expect(fail('limit=0').message).toMatch(/limit/i);
    expect(fail('display=grid').message).toMatch(/display/i);
  });
});

// Эвристика типов каталога подогнана под ФАКТИЧЕСКИЙ вывод zod-to-json-schema
// (см. оговорку Task 7): тип берётся из реального паттерна реестра, не из догадки.
describe('buildFieldCatalog: эвристика propType по фактическому выводу zod-to-json-schema', () => {
  test('due_date → date (паттерн ISO-даты)', () => {
    expect(catalog.fields.due_date).toEqual([{ aspect: 'orbis/task', type: 'date' }]);
  });
  test('amount → decimal (строго положительный decimal-паттерн §3.3)', () => {
    expect(catalog.fields.amount).toEqual([{ aspect: 'orbis/financial', type: 'decimal' }]);
  });
  test('start_at → timestamp (паттерн ISO 8601)', () => {
    expect(catalog.fields.start_at).toEqual([{ aspect: 'orbis/schedule', type: 'timestamp' }]);
  });
  test('status → string + enumValues в порядке объявления схемы', () => {
    expect(catalog.fields.status).toEqual([
      {
        aspect: 'orbis/task',
        type: 'string',
        enumValues: ['inbox', 'planned', 'in_progress', 'waiting', 'done', 'cancelled'],
      },
    ]);
  });
  test('остальные decimal-паттерны §3.3: limit (неотрицательный) и carryover (знаковый) → decimal', () => {
    expect(catalog.fields.limit).toEqual([{ aspect: 'orbis/budget', type: 'decimal' }]);
    expect(catalog.fields.carryover).toEqual([{ aspect: 'orbis/budget', type: 'decimal' }]);
  });
  test('category_ref живёт в двух аспектах — основа теста неоднозначности', () => {
    expect(catalog.fields.category_ref?.map((i) => i.aspect).sort()).toEqual([
      'orbis/budget',
      'orbis/financial',
    ]);
  });
  test('поле-массив получает тип array, а не string', () => {
    expect(catalog.fields.aliases?.[0]?.type).toBe('array');
  });
  test('поле-объект и union — unfilterable', () => {
    // recurrence — JSON Schema `type: object`, progress_source — `anyOf` (дискриминированный union)
    expect(catalog.fields.recurrence?.[0]?.type).toBe('unfilterable');
    expect(catalog.fields.progress_source?.[0]?.type).toBe('unfilterable');
  });
  test('не-скаляры реестра исчерпываются этими десятью полями', () => {
    const odd = Object.entries(catalog.fields)
      .filter(([, infos]) => infos.some((i) => i.type === 'array' || i.type === 'unfilterable'))
      .map(([name]) => name)
      .sort();
    // checkpoint/reply/steps/usage приехали с orbis/agent-run (ADE-срез 1): объекты и массив
    // объектов. Фильтра грамматики для них нет — прогон отбирают по outcome и step_count,
    // а не по вложенным структурам; список пересчитан осознанно, а не подогнан под падение.
    // days/allowed_tools (массивы orbis/routine) и proposal (объект orbis/agent-run) — V1:
    // рутину отбирают по stage/mode, а предложение — по outcome прогона.
    expect(odd).toEqual([
      'aliases',
      'allowed_tools',
      'checkpoint',
      'days',
      'progress_source',
      'proposal',
      'recurrence',
      'reply',
      'steps',
      'usage',
    ]);
  });
});

// Каталог выдавал массивы и объекты за строки, и грамматика молча их принимала:
// `aliases=такси` давал тихий ноль (`->>'aliases'` — текст всего массива), `aliases=!такси`
// возвращал ВСЕ категории. Массив стал фильтруемым типом, объект/union — честным отказом.
describe('parseQuery: массивы фильтруются, объекты и union отклоняются', () => {
  const fail = (q: string) => {
    const r = parse(q);
    expect(r.ok).toBe(false);
    return r.ok ? { message: '', position: -1 } : r.error;
  };
  test('фильтр по unfilterable-полю — честный отказ с позицией, а не тихий ноль', () => {
    const r = parse('aspect=orbis/schedule, recurrence=weekly');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.message).toMatch(/не поддерживается/);
      expect(r.error.position).toBe('aspect=orbis/schedule, '.length);
    }
    // Отрицание и диапазон по объекту отклоняются той же проверкой
    expect(fail('aspect=orbis/goal, progress_source=!manual').message).toMatch(/не поддерживается/);
    expect(fail('aspect=orbis/schedule, recurrence=a..b').message).toMatch(/не поддерживается/);
  });
  test('равенство, диапазон и >/< по unfilterable объясняются ОДИНАКОВО и с той же позицией', () => {
    // Путь >/< резолвит поле отдельно от равенства: без общей проверки он объяснял бы
    // отказ типом значения («имеет тип unfilterable»), то есть другой причиной.
    const prefix = 'aspect=orbis/schedule, ';
    const errs = [`${prefix}recurrence=weekly`, `${prefix}recurrence=a..b`, `${prefix}recurrence>1`]
      .map(fail)
      .map((e) => `${e.message}@${e.position}`);
    expect(new Set(errs).size).toBe(1);
    expect(errs[0]).toBe(
      `фильтрация по полю 'recurrence' не поддерживается: это не скаляр и не массив скаляров@${prefix.length}`,
    );
  });
  test('внутренние имена типов array/unfilterable наружу не выпускаются', () => {
    const messages = [
      fail('aspect=orbis/category, aliases>1').message,
      fail('aspect=orbis/category, aliases=today').message,
      fail('aspect=orbis/category, sortBy=aliases:asc').message,
      fail('aspect=orbis/schedule, recurrence=weekly').message,
      fail('aspect=orbis/schedule, sortBy=recurrence:asc').message,
    ];
    for (const m of messages) expect(m).not.toMatch(/array|unfilterable/);
    // …при этом слова типов из §6.1 печатаются как есть — подменяются только два
    // внутренних имени, а форма (кавычки) одна на все типы и оба слоя, см. fieldTypeLabel.
    expect(fail('aspect=orbis/task, status>done').message).toMatch(/тип 'string'/);
  });
  test('фильтр по полю-массиву разбирается как обычный anyOf', () => {
    const r = parse('aspect=orbis/category, aliases=такси');
    expect(r.ok).toBe(true);
    expect(r.ok && r.ast.filters[1]).toEqual({
      kind: 'field',
      field: 'aliases',
      condition: { kind: 'anyOf', values: [{ kind: 'literal', value: 'такси' }] },
    });
    // Отрицание и OR-список — те же формы §6.1, семантику даёт компилятор
    expect(parse('aspect=orbis/category, aliases=!такси').ok).toBe(true);
    expect(parse('aspect=orbis/category, aliases=такси|метро').ok).toBe(true);
  });
  test('sortBy по массиву и по unfilterable — отказ', () => {
    for (const q of [
      'aspect=orbis/category, sortBy=aliases:asc',
      'aspect=orbis/schedule, sortBy=recurrence:asc',
    ]) {
      const r = parse(q);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.message).toMatch(/sortBy/);
    }
  });
  test('операторы >/< по массиву неприменимы (тип не числовой)', () => {
    expect(fail('aspect=orbis/category, aliases>1').message).toMatch(/тип 'массив'/);
  });
});

// Каталог строится и из ПОЛЬЗОВАТЕЛЬСКИХ определений аспектов (loadCatalog читает
// aspect_definitions), где встречаются формы, которых во встроенном реестре нет.
// Правило «нет скалярного type → unfilterable» отбирало бы фильтр у nullable-полей и
// enum'ов без type — а они фильтровались правильно и раньше. Схемы тут синтетические
// намеренно: реестр ради проверки классификации трогать незачем.
describe('propType: формы за пределами встроенного реестра', () => {
  const typeOf = (prop: Record<string, unknown>) =>
    buildFieldCatalog([{ id: 'x/custom', schema: { properties: { f: prop } } }]).fields.f?.[0]
      ?.type;
  // Обычные строки, а не String.raw: транспилер bun портит не-ASCII в raw-шаблонах,
  // и в этом файле уже принято писать паттерны так.
  const DATE_PATTERN = '^\\d{4}-\\d{2}-\\d{2}$';

  test('nullable-формы разворачиваются в свой скалярный тип', () => {
    expect(typeOf({ type: ['string', 'null'] })).toBe('string');
    expect(typeOf({ anyOf: [{ type: 'string' }, { type: 'null' }] })).toBe('string');
    expect(typeOf({ oneOf: [{ type: 'number' }, { type: 'null' }] })).toBe('number');
    // pattern переживает разворачивание: nullable-дата остаётся date, а не строкой
    expect(typeOf({ type: ['string', 'null'], pattern: DATE_PATTERN })).toBe('date');
    expect(typeOf({ anyOf: [{ type: 'string', pattern: DATE_PATTERN }, { type: 'null' }] })).toBe(
      'date',
    );
  });
  test('enum без type — тип по значениям', () => {
    expect(typeOf({ enum: ['a', 'b'] })).toBe('string');
    expect(typeOf({ enum: [1, 2] })).toBe('integer');
    expect(typeOf({ enum: [1.5] })).toBe('number');
    expect(typeOf({ enum: [true, false] })).toBe('boolean');
  });
  test('массив nullable-скаляров и массив enum-строк — всё ещё массив скаляров', () => {
    expect(typeOf({ type: 'array', items: { type: ['string', 'null'] } })).toBe('array');
    expect(typeOf({ type: 'array', items: { enum: ['a', 'b'] } })).toBe('array');
  });
  test('настоящие не-скаляры остаются unfilterable', () => {
    expect(typeOf({ type: 'object', properties: {} })).toBe('unfilterable');
    expect(typeOf({ anyOf: [{ type: 'string' }, { type: 'number' }] })).toBe('unfilterable');
    expect(typeOf({ type: ['string', 'number'] })).toBe('unfilterable');
    expect(typeOf({ type: 'array', items: { type: 'object' } })).toBe('unfilterable');
    expect(typeOf({ type: 'array' })).toBe('unfilterable'); // массив без items — что внутри, неизвестно
    expect(typeOf({})).toBe('unfilterable');
  });
  test('enumValues всегда строки — иначе сортировка по enum падала бы TypeError', () => {
    // Порядок enum сравнивается с ТЕКСТОВОЙ проекцией `aspects->'A'->>'f'` (§6.1,
    // compile.ts sortItem), поэтому числа и булевы обязаны приехать сюда строками;
    // раньше сюда шёл голый `prop.enum as string[]`, и `.replaceAll` падал на числе.
    const enumsOf = (prop: Record<string, unknown>) =>
      buildFieldCatalog([{ id: 'x/custom', schema: { properties: { f: prop } } }]).fields.f?.[0]
        ?.enumValues;
    expect(enumsOf({ type: 'integer', enum: [3, 1, 2] })).toEqual(['3', '1', '2']);
    expect(enumsOf({ type: 'boolean', enum: [true, false] })).toEqual(['true', 'false']);
    expect(enumsOf({ type: 'string', enum: ['b', 'a'] })).toEqual(['b', 'a']);
    // Не-скаляр текстовой проекции не имеет — порядка объявления для такого поля нет;
    // пустой enum давал бы `CASE expr END` (синтаксическая ошибка SQL).
    expect(enumsOf({ enum: [{ a: 1 }] })).toBeUndefined();
    expect(enumsOf({ type: 'string', enum: ['a', null] })).toBeUndefined();
    expect(enumsOf({ type: 'string', enum: [] })).toBeUndefined();
    expect(enumsOf({ type: 'string' })).toBeUndefined();
  });
  test('фильтр по nullable-строке пользовательского аспекта разбирается, а не отклоняется', () => {
    const custom = buildFieldCatalog([
      { id: 'x/custom', schema: { properties: { vendor: { type: ['string', 'null'] } } } },
    ]);
    expect(parseQuery('aspect=x/custom, vendor=ACME', custom).ok).toBe(true);
    expect(parseQuery('aspect=x/custom, sortBy=vendor:asc', custom).ok).toBe(true);
  });
});

// Разрешение неоднозначности per §6.1: запрос с aspect=X, где поле есть в X, резолвится в X —
// независимо от порядка конструкций (aspect= может стоять и после поля).
describe('parseQuery: резолв неоднозначного поля через aspect=', () => {
  const uuid = '019d48ea-2e00-7a52-876a-c301529b0456';
  test('aspect= до поля', () => {
    const r = parse(`aspect=orbis/financial, category_ref=${uuid}`);
    expect(r.ok && r.ast.filters[1]).toEqual({
      kind: 'field',
      field: 'category_ref',
      condition: { kind: 'anyOf', values: [{ kind: 'literal', value: uuid }] },
    });
  });
  test('aspect= после поля — «запрос содержит», порядок не важен', () => {
    const r = parse(`category_ref=${uuid}, aspect=orbis/budget`);
    expect(r.ok).toBe(true);
  });
  test('два aspect=, оба содержат поле — всё ещё неоднозначно', () => {
    const r = parse(`aspect=orbis/financial, aspect=orbis/budget, category_ref=${uuid}`);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toMatch(/неоднозначн/i);
  });
});

// Fix round (ревью Task 7): календарная валидация ISO-timestamp (§6.4 — ошибка на парсинге,
// а не неструктурный каст ::timestamptz в SQL) и явная ошибка OR в aspect=.
describe('parseQuery: пограничная лексика (fix round)', () => {
  const fail = (q: string) => {
    const r = parse(q);
    expect(r.ok).toBe(false);
    return r.ok ? { message: '', position: -1 } : r.error;
  };
  test('календарно-невалидный timestamp в comparison — структурная ошибка', () => {
    expect(fail('updated_at>2026-13-99T99:00:00Z').message).toMatch(/timestamp/i);
    // Date.parse перекатил бы 30 февраля на 2 марта без NaN — проверка компонент, не Date.
    expect(fail('updated_at>2026-02-30T10:00:00Z').message).toMatch(/timestamp/i);
  });
  test('календарно-невалидный timestamp в диапазоне — проверяются обе границы', () => {
    expect(fail('updated_at=2026-02-30T10:00:00Z..2026-03-01T00:00:00Z').message).toMatch(
      /timestamp/i,
    );
    expect(fail('updated_at=2026-03-01T00:00:00Z..2026-13-01T00:00:00Z').message).toMatch(
      /timestamp/i,
    );
  });
  test('валидные timestamps: конец месяца и 29 февраля високосного года', () => {
    expect(parse('updated_at>2026-02-28T23:59:59Z').ok).toBe(true);
    expect(parse('updated_at>2028-02-29T12:00:00+03:00').ok).toBe(true);
  });
  test('offset-часы за пределом Postgres (MAX_TZDISP_HOUR=15): ±16:00 — ошибка, +14:00 — ок', () => {
    // Postgres принимает смещение только до ±15:59; +23:00 прошёл бы парсер
    // и упал бы кастом ::timestamptz уже в SQL — ловим на парсинге (§6.4).
    expect(fail('updated_at>2026-07-01T10:00:00+16:00').message).toMatch(/timestamp/i);
    expect(fail('updated_at>2026-07-01T10:00:00-16:00').message).toMatch(/timestamp/i);
    expect(parse('updated_at>2026-07-01T10:00:00+14:00').ok).toBe(true);
  });
  test('aspect= принимает одно значение: | — ошибка с позицией, а не литерал с тихой пустотой', () => {
    const e = fail('aspect=orbis/task|orbis/note');
    expect(e.message).toMatch(/aspect/i);
    expect(e.position).toBe('aspect=orbis/task'.length);
  });
  test('повтор параметра — ошибка, а не молчаливая перезапись', () => {
    expect(fail('limit=5, limit=6').message).toMatch(/повторн/i);
  });
  test('экранирование бэкслеша в кавычках (fix round B5): \\\\ → \\, хвостовой \\ выразим', () => {
    // Обычные литералы, НЕ String.raw: bun-транспилер переизлучает не-ASCII источник
    // raw-шаблонов как \uXXXX-эскейпы и портит содержимое (локальная причуда транспилера).
    // Значение с хвостовым бэкслешем: без \\-экранирования `\"` съедал бы закрывающую кавычку
    const r1 = parse('search="кофе, эклер\\\\"');
    expect(r1.ok && r1.ast.search).toBe('кофе, эклер\\');
    // Комбинация \\ и \" в одном значении
    const r2 = parse('search="a\\\\b \\"quoted\\" c\\\\"');
    expect(r2.ok && r2.ast.search).toBe('a\\b "quoted" c\\');
    // Одиночный \ перед обычным символом — литерал (обратная совместимость §6.1)
    const r3 = parse('search="a\\b"');
    expect(r3.ok && r3.ast.search).toBe('a\\b');
  });
  test('хвост после закрывающей кавычки — ошибка', () => {
    expect(fail('title="a"x').message).toMatch(/кавычк/i);
  });
});
