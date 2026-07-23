// Task B5 (03-budget §3.3): buildTxQuery — чистый билдер строки грамматики §6.1
// для экрана «Транзакции». Тесты на состав клауз И на кавычки/экранирование
// (урок бэклога об экранировании тегов: значения с ,/|/& — в кавычки).
import { aspectJsonSchema, BUILTIN_ASPECT_IDS, buildFieldCatalog, parseQuery } from '@orbis/shared';
import { expect, test } from 'vitest';
import { buildTxQuery, monthRange } from './txQuery';

const catalog = buildFieldCatalog(
  BUILTIN_ASPECT_IDS.map((id) => ({ id, schema: aspectJsonSchema(id) })),
);

test('monthRange: полный календарный месяц, включая февраль и високосный год', () => {
  expect(monthRange('2026-06')).toEqual({ start: '2026-06-01', end: '2026-06-30' });
  expect(monthRange('2026-07')).toEqual({ start: '2026-07-01', end: '2026-07-31' });
  expect(monthRange('2026-02')).toEqual({ start: '2026-02-01', end: '2026-02-28' });
  expect(monthRange('2028-02')).toEqual({ start: '2028-02-01', end: '2028-02-29' });
});

test('минимальный запрос: только месяц — aspect + occurred_on-диапазон + сортировка + limit', () => {
  expect(buildTxQuery({ month: '2026-06' })).toBe(
    'aspect=orbis/financial, occurred_on=2026-06-01..2026-06-30, sortBy=occurred_on:desc, limit=200',
  );
});

test('все фильтры §3.3: категория, направление, planned, диапазон сумм, поиск', () => {
  const q = buildTxQuery({
    month: '2026-06',
    categoryId: '019d48ea-4188-765d-8e96-93a0ad9c262a',
    direction: 'expense',
    planned: false,
    amountFrom: '500',
    amountTo: '2000',
    search: 'кофе',
  });
  expect(q).toBe(
    'aspect=orbis/financial, occurred_on=2026-06-01..2026-06-30, ' +
      'category_ref=019d48ea-4188-765d-8e96-93a0ad9c262a, direction=expense, planned=!true, ' +
      'amount=500..2000, search=кофе, sortBy=occurred_on:desc, limit=200',
  );
});

// Финал B (Important 1): quick-add/fast-path/LLM ключ planned НЕ пишут (его ставят только
// post-due и confirmPurchase) — `planned=false` компилировался бы в `IN ('false')` и скрывал
// бы рукописные транзакции. Фильтр «Факт» обязан быть noneOf `!true`: NULL проходит
// (решение 10 компилятора), семантика совпадает с серверными агрегатами coalesce(...,false).
test('фильтр «Факт»: planned=false → noneOf planned=!true, записи без ключа planned не отсеиваются', () => {
  const q = buildTxQuery({ month: '2026-06', planned: false });
  expect(q).toContain('planned=!true');
  expect(q).not.toContain('planned=false');
  // round-trip: строка парсится, условие — именно noneOf('true'), а не anyOf('false')
  const r = parseQuery(q, catalog);
  expect(r.ok).toBe(true);
  if (r.ok) {
    const f = r.ast.filters.find((x) => x.kind === 'field' && x.field === 'planned');
    expect(f && f.kind === 'field' ? f.condition : null).toEqual({
      kind: 'noneOf',
      values: [{ kind: 'literal', value: 'true' }],
    });
  }
});

test('одна граница суммы — строгое сравнение >/< (у грамматики §6.1 нет >=)', () => {
  expect(buildTxQuery({ month: '2026-06', amountFrom: '500' })).toContain('amount>500');
  expect(buildTxQuery({ month: '2026-06', amountTo: '2000' })).toContain('amount<2000');
  expect(buildTxQuery({ month: '2026-06', amountFrom: '500' })).not.toContain('amount=');
});

test('planned=true и направление income', () => {
  const q = buildTxQuery({ month: '2026-06', direction: 'income', planned: true });
  expect(q).toContain('direction=income');
  expect(q).toContain('planned=true');
});

test('экранирование поиска: запятая/|/&/кавычка/краевые пробелы — значение в кавычках', () => {
  expect(buildTxQuery({ month: '2026-06', search: 'кофе, круассан' })).toContain(
    'search="кофе, круассан"',
  );
  expect(buildTxQuery({ month: '2026-06', search: 'a|b&c' })).toContain('search="a|b&c"');
  expect(buildTxQuery({ month: '2026-06', search: 'скидка "верная"' })).toContain(
    'search="скидка \\"верная\\""',
  );
  expect(buildTxQuery({ month: '2026-06', search: ' пробел ' })).toContain('search=" пробел "');
  // Пустой/пробельный поиск клаузы не даёт
  expect(buildTxQuery({ month: '2026-06', search: '   ' })).not.toContain('search=');
});

test('экранирование бэкслеша (fix round B5): \\ в кавычках → \\\\, хвостовой \\ не ломает parse', () => {
  // Значение с запятой И хвостовым \: без экранирования `\"` съедал бы закрывающую кавычку
  expect(buildTxQuery({ month: '2026-06', search: 'кофе, эклер\\' })).toContain(
    String.raw`search="кофе, эклер\\"`,
  );
  // Бэкслеш без прочих спецсимволов — квотирования не требует, уходит как есть
  expect(buildTxQuery({ month: '2026-06', search: 'кофе\\' })).toContain('search=кофе\\');
});

test('round-trip: строка билдера с «опасным» поиском парсится грамматикой без ошибок', () => {
  const nasty = [
    'кофе, круассан',
    'a|b&c',
    'кав"ычка',
    'due=today, archived=any',
    'кофе, эклер\\', // хвостовой бэкслеш в квотируемом значении (fix round B5)
    'слэш \\ и, кавычка \\" вместе',
    'кофе\\', // бэкслеш в неквотируемом значении
  ];
  for (const search of nasty) {
    const q = buildTxQuery({
      month: '2026-06',
      categoryId: '019d48ea-4188-765d-8e96-93a0ad9c262a',
      direction: 'expense',
      planned: true,
      amountFrom: '0.10',
      amountTo: '99999.99',
      search,
    });
    const r = parseQuery(q, catalog);
    expect(r.ok, `не распарсилось: ${q}`).toBe(true);
    if (r.ok) expect(r.ast.search).toBe(search); // инъекция невозможна: поиск остался значением
  }
});
