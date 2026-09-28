/**
 * Токены дат и два края (спека 1в §3.4): таблица краёв всех восьми токенов, подписи словаря,
 * какой край читает форма и перечень форм с токеном-границей для переписи до выкатки.
 *
 * «Сегодня» — среда `2026-07-15`, как у таблицы случаев «когда» (`when.dataset.test.ts`).
 */
import { describe, expect, test } from 'bun:test';
import { QUERY_DATE_TOKENS, type QueryDateToken } from './ast';
import {
  edgeOf,
  QUERY_DATE_TOKEN_LABELS,
  TOKEN_EDGE_MESSAGE,
  type TokenEdges,
  tokenBoundaryForms,
  tokenEdgeMissing,
  tokenEdges,
} from './tokens';

const TODAY = '2026-07-15';

describe('края токенов — таблица спеки §3.4 (сегодня — среда 2026-07-15)', () => {
  const cases: ReadonlyArray<[QueryDateToken, TokenEdges]> = [
    ['today', { start: '2026-07-15', end: '2026-07-15' }],
    ['overdue', { start: null, end: '2026-07-14' }],
    ['next_7d', { start: '2026-07-15', end: '2026-07-22' }],
    ['next_14d', { start: '2026-07-15', end: '2026-07-29' }],
    ['after_7d', { start: '2026-07-23', end: null }],
    ['this_week', { start: '2026-07-13', end: '2026-07-19' }],
    ['this_month', { start: '2026-07-01', end: '2026-07-31' }],
    ['last_month', { start: '2026-06-01', end: '2026-06-30' }],
  ];
  test.each(cases)('%s', (token, edges) => {
    expect(tokenEdges(token, TODAY, 'monday')).toEqual(edges);
  });

  test('таблица покрывает все восемь токенов языка', () => {
    expect(cases.map(([t]) => t).sort()).toEqual([...QUERY_DATE_TOKENS].sort());
  });

  test('неделя с воскресенья (В-1): this_week — [вс; сб]', () => {
    expect(tokenEdges('this_week', TODAY, 'sunday')).toEqual({
      start: '2026-07-12',
      end: '2026-07-18',
    });
    // Сегодня — само воскресенье: неделя начинается сегодня, а с понедельника — вчера кончилась.
    expect(tokenEdges('this_week', '2026-07-19', 'sunday')).toEqual({
      start: '2026-07-19',
      end: '2026-07-25',
    });
    expect(tokenEdges('this_week', '2026-07-19', 'monday')).toEqual({
      start: '2026-07-13',
      end: '2026-07-19',
    });
    // Прочие токены от начала недели не зависят.
    for (const token of QUERY_DATE_TOKENS.filter((t) => t !== 'this_week')) {
      expect(tokenEdges(token, TODAY, 'sunday'), token).toEqual(tokenEdges(token, TODAY, 'monday'));
    }
  });

  test('неделя на стыке месяцев и лет', () => {
    // Среда 2026-07-01: понедельник — 29 июня.
    expect(tokenEdges('this_week', '2026-07-01', 'monday')).toEqual({
      start: '2026-06-29',
      end: '2026-07-05',
    });
    // Четверг 2027-01-01: понедельник — 28 декабря 2026-го.
    expect(tokenEdges('this_week', '2027-01-01', 'monday')).toEqual({
      start: '2026-12-28',
      end: '2027-01-03',
    });
  });

  test('края месяца: короткий февраль, високосный год, январь', () => {
    expect(tokenEdges('last_month', '2026-03-31', 'monday')).toEqual({
      start: '2026-02-01',
      end: '2026-02-28',
    });
    expect(tokenEdges('this_month', '2028-02-29', 'monday')).toEqual({
      start: '2028-02-01',
      end: '2028-02-29',
    });
    expect(tokenEdges('last_month', '2026-01-10', 'monday')).toEqual({
      start: '2025-12-01',
      end: '2025-12-31',
    });
    // Переход через границу месяца у сдвигов: next_14d с 20 декабря — в январе.
    expect(tokenEdges('next_14d', '2026-12-20', 'monday')).toEqual({
      start: '2026-12-20',
      end: '2027-01-03',
    });
  });
});

test('подписи — ровно словарь спеки §3.4, по одной на токен', () => {
  expect(QUERY_DATE_TOKEN_LABELS).toEqual({
    today: 'сегодня',
    overdue: 'просрочено',
    next_7d: '7 дней',
    next_14d: '14 дней',
    after_7d: 'позже 7 дней',
    this_week: 'эта неделя',
    this_month: 'этот месяц',
    last_month: 'прошлый месяц',
  });
  // Порядок ключей — порядок языка: список подписей в web строится по словарю.
  expect(Object.keys(QUERY_DATE_TOKEN_LABELS)).toEqual([...QUERY_DATE_TOKENS]);
});

test('какой край читает форма: `=` — оба, `<`/`>=` — начало, `>`/`<=` — конец', () => {
  expect(edgeOf('eq')).toBe('both');
  expect(edgeOf('lt')).toBe('start');
  expect(edgeOf('gte')).toBe('start');
  expect(edgeOf('gt')).toBe('end');
  expect(edgeOf('lte')).toBe('end');
});

test('несуществующий край — у overdue нет начала, у after_7d нет конца; `=` годится всегда', () => {
  const missing = QUERY_DATE_TOKENS.flatMap((token) =>
    (['eq', 'lt', 'gte', 'gt', 'lte'] as const).flatMap((form) =>
      tokenEdgeMissing(token, form) ? [`${form}${token}`] : [],
    ),
  );
  expect(missing.sort()).toEqual(['gtafter_7d', 'gteoverdue', 'lteafter_7d', 'ltoverdue']);
  expect(TOKEN_EDGE_MESSAGE('overdue', 'lt')).toStartWith('у токена overdue нет начала — ');
  expect(TOKEN_EDGE_MESSAGE('after_7d', 'gt')).toStartWith('у токена after_7d нет конца — ');
  // Подсказка называет форму и то, что годится вместо неё.
  expect(TOKEN_EDGE_MESSAGE('overdue', 'gte')).toContain("'>='");
  expect(TOKEN_EDGE_MESSAGE('after_7d', 'lte')).toContain("'<='");
});

test('перечень несуществующих краёв согласован с таблицей краёв — на любой день и любую неделю', () => {
  for (const today of ['2026-07-15', '2026-01-01', '2028-02-29', '2026-12-31']) {
    for (const weekStart of ['monday', 'sunday'] as const) {
      for (const token of QUERY_DATE_TOKENS) {
        const edges = tokenEdges(token, today, weekStart);
        for (const form of ['lt', 'gte', 'gt', 'lte'] as const) {
          const edge = edgeOf(form) as 'start' | 'end';
          expect(tokenEdgeMissing(token, form), `${token} ${form} ${today}`).toBe(
            edges[edge] === null,
          );
        }
      }
    }
  }
});

describe('tokenBoundaryForms — формы с токеном-границей (перепись §3.4, recon §12)', () => {
  const lt = (token: QueryDateToken) => ({
    prop: 'orbis/due_date',
    op: 'lt',
    value: { token },
  });
  const gt = (token: QueryDateToken) => ({
    prop: 'orbis/due_date',
    op: 'gt',
    value: { token },
  });
  const from = (token: QueryDateToken) => ({
    prop: 'orbis/due_date',
    op: 'range',
    value: { from: { token } },
  });
  const to = (token: QueryDateToken) => ({
    prop: 'orbis/due_date',
    op: 'range',
    value: { to: { token } },
  });
  const verdict = (node: unknown) => tokenBoundaryForms({ filter: node });

  test('смысл меняют: >overdue, <=overdue, <next_7d, >=next_7d, <after_7d, >=after_7d', () => {
    expect(verdict(gt('overdue'))).toEqual([{ token: 'overdue', form: 'gt', verdict: 'changed' }]);
    expect(verdict(to('overdue'))).toEqual([{ token: 'overdue', form: 'lte', verdict: 'changed' }]);
    expect(verdict(lt('next_7d'))).toEqual([{ token: 'next_7d', form: 'lt', verdict: 'changed' }]);
    expect(verdict(from('next_7d'))).toEqual([
      { token: 'next_7d', form: 'gte', verdict: 'changed' },
    ]);
    expect(verdict(lt('after_7d'))).toEqual([
      { token: 'after_7d', form: 'lt', verdict: 'changed' },
    ]);
    expect(verdict(from('after_7d'))).toEqual([
      { token: 'after_7d', form: 'gte', verdict: 'changed' },
    ]);
  });

  test('станут отказом: <overdue, >=overdue, >after_7d, <=after_7d', () => {
    expect(verdict(lt('overdue'))).toEqual([{ token: 'overdue', form: 'lt', verdict: 'refused' }]);
    expect(verdict(from('overdue'))).toEqual([
      { token: 'overdue', form: 'gte', verdict: 'refused' },
    ]);
    expect(verdict(gt('after_7d'))).toEqual([
      { token: 'after_7d', form: 'gt', verdict: 'refused' },
    ]);
    expect(verdict(to('after_7d'))).toEqual([
      { token: 'after_7d', form: 'lte', verdict: 'refused' },
    ]);
  });

  test('смысл прежний: today во всех формах, >next_7d, <=next_7d; новые токены — только 1в', () => {
    for (const node of [lt('today'), gt('today'), from('today'), to('today')]) {
      expect(verdict(node)[0]?.verdict).toBe('same');
    }
    expect(verdict(gt('next_7d'))[0]?.verdict).toBe('same');
    expect(verdict(to('next_7d'))[0]?.verdict).toBe('same');
    // Токенов 1в до 1в не было: сохранённого дерева со «старым» смыслом у них быть не может.
    expect(verdict(lt('this_month'))).toEqual([
      { token: 'this_month', form: 'lt', verdict: 'same' },
    ]);
  });

  test('`=`/`!=` — не граница; литерал — не токен', () => {
    expect(verdict({ prop: 'orbis/due_date', op: 'eq', value: { token: 'overdue' } })).toEqual([]);
    expect(verdict({ prop: 'orbis/due_date', op: 'ne', value: { token: 'next_7d' } })).toEqual([]);
    expect(verdict({ prop: 'orbis/due_date', op: 'lt', value: '2026-07-01' })).toEqual([]);
    expect(
      verdict({
        prop: 'orbis/due_date',
        op: 'range',
        value: { from: '2026-07-01', to: '2026-07-31' },
      }),
    ).toEqual([]);
  });

  test('range с двумя краями-токенами — две формы; обход идёт под and/or/not и в адрес', () => {
    expect(
      verdict({
        prop: 'orbis/due_date',
        op: 'range',
        value: { from: { token: 'overdue' }, to: { token: 'next_7d' } },
      }),
    ).toEqual([
      { token: 'overdue', form: 'gte', verdict: 'refused' },
      { token: 'next_7d', form: 'lte', verdict: 'same' },
    ]);
    expect(
      verdict({
        and: [
          { aspect: 'orbis/task' },
          { or: [{ not: lt('next_7d') }, { ...to('overdue'), prop: { contract: 'orbis/when' } }] },
        ],
      }),
    ).toEqual([
      { token: 'next_7d', form: 'lt', verdict: 'changed' },
      { token: 'overdue', form: 'lte', verdict: 'changed' },
    ]);
  });

  test('вход — любой JSON: атрибуты тела, узел без корня, мусор — без падения', () => {
    // Дерево из `attrs.ast` блока тела, голый узел фильтра и значение источника прогресса.
    expect(tokenBoundaryForms(lt('next_7d'))).toHaveLength(1);
    expect(
      tokenBoundaryForms({ query: { filter: gt('overdue') }, aggregate: 'count' }),
    ).toHaveLength(1);
    for (const junk of [null, undefined, 5, 'orbis/due_date<next_7d', [], {}, { op: 'lt' }]) {
      expect(tokenBoundaryForms(junk)).toEqual([]);
    }
  });
});
