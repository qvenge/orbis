/**
 * Тексты запросов поиска хоста (срез 1б §6.4, §9.6, РП-29, В-2): три группы — записи без страниц и
 * приложений, страницы, приложения; строка владельца — значением канона `search` через общий
 * квотировщик печати. Каждый текст разбирается каноном §А5-3 — иначе блок получил бы отказ `SYNTAX`
 * на первом же пробеле в строке поиска.
 */
import { parseQueryAst, quoteQueryValue } from '@orbis/shared/query';
import { expect, test } from 'vitest';
import { buildQueryRegistry } from '../../lib/query-blocks/catalog';
import { BUILTIN_REGISTRY } from '../../test/registry';
import { SEARCH_GROUPS, searchBlockTexts } from './search-query';

const registry = buildQueryRegistry(BUILTIN_REGISTRY).parse;

test('«еда» — три текста групп дословно (РП-29)', () => {
  expect(searchBlockTexts('еда')).toEqual({
    records: 'search=еда, !aspect=orbis/page, !aspect=orbis/app, limit=20',
    pages: 'aspect=orbis/page, search=еда, limit=10',
    apps: 'aspect=orbis/app, search=еда, limit=10',
  });
});

test('порядок групп — записи, страницы, приложения', () => {
  expect(SEARCH_GROUPS).toEqual(['records', 'pages', 'apps']);
});

test('строка с пробелом и кавычкой — значение через quoteQueryValue', () => {
  const q = 'Мой "дом"';
  const v = quoteQueryValue(q);
  // Страж вакуумности: квотировщик и правда закавычил — иначе проверка ниже была бы про голую строку.
  expect(v).not.toBe(q);
  expect(searchBlockTexts(q)).toEqual({
    records: `search=${v}, !aspect=orbis/page, !aspect=orbis/app, limit=20`,
    pages: `aspect=orbis/page, search=${v}, limit=10`,
    apps: `aspect=orbis/app, search=${v}, limit=10`,
  });
});

test('края строки снимаются: « еда » — тот же запрос, что «еда»', () => {
  expect(searchBlockTexts('  еда \n')).toEqual(searchBlockTexts('еда'));
});

test.each(['', '   ', '\n\t'])('пустая строка %j — null (запроса нет)', (q) => {
  expect(searchBlockTexts(q)).toBeNull();
});

test.each([
  'еда',
  'Мой "дом"',
  'кофе, эклер',
  'a=b',
  '{{x}}',
  'back\\slash',
])('каждый текст %j разбирается каноном без отказа', (q) => {
  const texts = searchBlockTexts(q);
  expect(texts).not.toBeNull();
  for (const group of SEARCH_GROUPS) {
    const r = parseQueryAst(texts?.[group] ?? '', registry);
    expect(r.ok ? null : `${group}: ${r.error.code}: ${r.error.message}`).toBeNull();
  }
});
