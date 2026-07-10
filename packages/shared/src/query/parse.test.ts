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
  test('хвост после закрывающей кавычки — ошибка', () => {
    expect(fail('title="a"x').message).toMatch(/кавычк/i);
  });
});
