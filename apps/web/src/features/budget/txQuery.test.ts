// Task B5 (03-budget §3.3): buildTxQuery — чистый билдер строки грамматики §6.1
// для экрана «Транзакции». Тесты на состав клауз И на кавычки/экранирование
// (урок бэклога об экранировании тегов: значения с ,/|/& — в кавычки).
import { parseQueryAst } from '@orbis/shared/query';
import { expect, test } from 'vitest';
import { buildQueryRegistry } from '../../lib/query-blocks/catalog';
import { BUILTIN_REGISTRY } from '../../test/registry';
import { buildTxQuery, monthRange, TX_PAGE_SIZE } from './txQuery';

// Разбор — каноном (§А5-3), и это единственный разбор, какой есть: мост старой формы снят
// Задачей 21b. Доказательство перевода в том, что текст билдера разбирается каноном, а не в
// том, что экран открылся (пока мост был жив, он принял бы и
// непереведённую строку, и тест зеленел бы при невыполненной работе).
const registry = buildQueryRegistry(BUILTIN_REGISTRY).parse;

test('monthRange: полный календарный месяц, включая февраль и високосный год', () => {
  expect(monthRange('2026-06')).toEqual({ start: '2026-06-01', end: '2026-06-30' });
  expect(monthRange('2026-07')).toEqual({ start: '2026-07-01', end: '2026-07-31' });
  expect(monthRange('2026-02')).toEqual({ start: '2026-02-01', end: '2026-02-28' });
  expect(monthRange('2028-02')).toEqual({ start: '2028-02-01', end: '2028-02-29' });
});

test('минимальный запрос: только месяц — aspect + диапазон даты + сортировка + limit', () => {
  expect(buildTxQuery({ month: '2026-06' })).toBe(
    'aspect=orbis/financial, orbis/occurred_on=2026-06-01..2026-06-30, sortBy=orbis/occurred_on:desc, limit=200',
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
    'aspect=orbis/financial, orbis/occurred_on=2026-06-01..2026-06-30, ' +
      'orbis/finance_category=019d48ea-4188-765d-8e96-93a0ad9c262a, orbis/direction=expense, ' +
      'orbis/planned=!true, orbis/amount=500..2000, search=кофе, ' +
      'sortBy=orbis/occurred_on:desc, limit=200',
  );
});

// Финал B (Important 1): quick-add/fast-path/LLM ключ planned НЕ пишут (его ставят только
// post-due и confirmPurchase) — `planned=false` компилировался бы в `IN ('false')` и скрывал
// бы рукописные транзакции. Фильтр «Факт» обязан быть noneOf `!true`: NULL проходит
// (решение 10 компилятора), семантика совпадает с серверными агрегатами coalesce(...,false).
test('фильтр «Факт»: planned=false → отрицание true, записи без ключа planned не отсеиваются', () => {
  const q = buildTxQuery({ month: '2026-06', planned: false });
  expect(q).toContain('orbis/planned=!true');
  expect(q).not.toContain('orbis/planned=false');
  // round-trip: строка разбирается каноном, и узел — именно ОТРИЦАНИЕ равенства `true`,
  // а не равенство `false` (§А5-7: `not(eq true)` пропускает отсутствие ключа).
  const r = parseQueryAst(q, registry);
  expect(r.ok).toBe(true);
  if (r.ok && r.ast.filter !== null && 'and' in r.ast.filter) {
    expect(r.ast.filter.and).toContainEqual({
      not: { prop: 'orbis/planned', op: 'eq', value: true },
    });
  }
});

// Task C6: пагинация растущим окном — limit = TX_PAGE_SIZE * page уходит клаузой limit=;
// без явного limit билдер сохраняет прежнее поведение первой страницы (200).
test('limit (C6): по умолчанию TX_PAGE_SIZE=200, явное окно уходит клаузой limit=', () => {
  expect(TX_PAGE_SIZE).toBe(200);
  expect(buildTxQuery({ month: '2026-06' })).toContain('limit=200');
  const q = buildTxQuery({ month: '2026-06', limit: TX_PAGE_SIZE * 2 });
  expect(q).toContain('limit=400');
  expect(q).not.toContain('limit=200');
  // Строка с нестандартным окном остаётся валидной для канона §А5-3
  const r = parseQueryAst(q, registry);
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.ast.limit).toBe(400);
});

test('одна граница суммы — строгое сравнение >/< (билдер включающих границ не строит)', () => {
  expect(buildTxQuery({ month: '2026-06', amountFrom: '500' })).toContain('orbis/amount>500');
  expect(buildTxQuery({ month: '2026-06', amountTo: '2000' })).toContain('orbis/amount<2000');
  expect(buildTxQuery({ month: '2026-06', amountFrom: '500' })).not.toContain('orbis/amount=');
});

test('planned=true и направление income', () => {
  const q = buildTxQuery({ month: '2026-06', direction: 'income', planned: true });
  expect(q).toContain('orbis/direction=income');
  expect(q).toContain('orbis/planned=true');
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
  // Бэкслеш квотируется и сам по себе: вне кавычек он экранирует следующий символ, и
  // `search=кофе\` съел бы разделитель перед `sortBy` (прежняя `quoteValue` его пропускала).
  expect(buildTxQuery({ month: '2026-06', search: 'кофе\\' })).toContain(
    String.raw`search="кофе\\"`,
  );
});

test('round-trip: строка билдера с «опасным» поиском парсится грамматикой без ошибок', () => {
  const nasty = [
    'кофе, круассан',
    'a|b&c',
    'кав"ычка',
    'orbis/due_date=today, archived=any', // текст, ПОХОЖИЙ на запрос, — тоже значение поиска
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
    const r = parseQueryAst(q, registry);
    expect(r.ok, `не распарсилось: ${q}`).toBe(true);
    // Инъекция невозможна: поиск остался ЗНАЧЕНИЕМ узла `{search}`, а не конструкцией.
    if (r.ok && r.ast.filter !== null && 'and' in r.ast.filter) {
      expect(r.ast.filter.and).toContainEqual({ search });
    }
  }
});
