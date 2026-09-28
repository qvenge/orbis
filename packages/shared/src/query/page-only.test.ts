/**
 * Признаки «только для страниц» в дереве запроса (спека 1в §3.8, РП-5): `$`-ссылка и группировка.
 * Обход — по сырому дереву: его зовёт уточнение базовой схемы ДО того, как форма дерева проверена.
 */
import { expect, test } from 'bun:test';
import { pageOnlyFeatureIn, paramNamesIn } from './page-only';

const param = (name: string) => ({ param: name });
const prop = (value: unknown, op = 'eq') => ({ prop: 'orbis/due_date', op, value });

test('pageOnlyFeatureIn находит {param} в значении, в границах range, под not и в or', () => {
  expect(pageOnlyFeatureIn({ filter: prop(param('p')) })).toBe('param');
  expect(
    pageOnlyFeatureIn({ filter: prop({ from: { token: 'today' }, to: param('p') }, 'range') }),
  ).toBe('param');
  expect(pageOnlyFeatureIn({ filter: prop({ from: param('p') }, 'range') })).toBe('param');
  expect(pageOnlyFeatureIn({ filter: { not: prop(param('p'), 'lt') } })).toBe('param');
  expect(
    pageOnlyFeatureIn({ filter: { or: [{ aspect: 'orbis/task' }, { and: [prop(param('p'))] }] } }),
  ).toBe('param');
});

test('pageOnlyFeatureIn: без ссылки и группировки — null; токен и литерал — не ссылка', () => {
  expect(pageOnlyFeatureIn({ filter: null })).toBeNull();
  expect(pageOnlyFeatureIn({ filter: prop({ token: 'today' }) })).toBeNull();
  expect(pageOnlyFeatureIn({ filter: prop('$p') })).toBeNull();
  expect(pageOnlyFeatureIn({ filter: { tag: 'param' } })).toBeNull();
  // Мусор на входе — не повод падать: форму проверяет схема, этот обход только ищет признак.
  for (const junk of [null, undefined, 1, 'x', [], { filter: 'x' }, { filter: { and: 'x' } }]) {
    expect(pageOnlyFeatureIn(junk)).toBeNull();
  }
});

test('pageOnlyFeatureIn: ключ group у корня — группировка', () => {
  expect(pageOnlyFeatureIn({ filter: null, group: { by: 'day' } })).toBe('group');
});

test('paramNamesIn — множество имён ссылок в порядке первого появления', () => {
  expect(
    paramNamesIn({
      filter: {
        and: [
          prop(param('b')),
          { not: prop({ from: param('a'), to: param('b') }, 'range') },
          { or: [prop(param('c')), prop({ token: 'today' })] },
        ],
      },
    }),
  ).toEqual(['b', 'a', 'c']);
  expect(paramNamesIn({ filter: null })).toEqual([]);
  expect(paramNamesIn(null)).toEqual([]);
});
