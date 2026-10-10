import { describe, expect, test } from 'vitest';
import {
  decimalDef,
  field,
  numberDef,
  textDef,
  textManyDef,
  timestampDef,
} from '../../features/entity-detail/properties-relations/test-fixtures';
import { parseDraftValue } from './draft-value';

test('пустое/false/0/[]/readonly json null не превращаются в unset', () => {
  expect(parseDraftValue(textDef, { kind: 'raw', raw: '' })).toEqual({ ok: true, value: '' });
  expect(parseDraftValue(textDef, { kind: 'raw', raw: '  Текст  ' })).toEqual({
    ok: true,
    value: '  Текст  ',
  });
  expect(parseDraftValue(field({ kind: 'boolean' }), { kind: 'value', value: false })).toEqual({
    ok: true,
    value: false,
  });
  expect(parseDraftValue(numberDef, { kind: 'raw', raw: '0' })).toEqual({ ok: true, value: 0 });
  expect(parseDraftValue(textManyDef, { kind: 'list', items: [] })).toEqual({
    ok: true,
    value: [],
  });
  expect(parseDraftValue(field({ kind: 'json' }), { kind: 'value', value: null })).toEqual({
    ok: true,
    value: null,
  });
  expect(parseDraftValue(textDef, { kind: 'unset' })).toEqual({ ok: true, unset: true });
});

describe('числа читаются полностью, Decimal сохраняет точность', () => {
  test.each([
    '',
    ' ',
    '-',
    '+',
    '.',
    '1e',
    '1e-',
    '12 руб',
    'Infinity',
    'NaN',
    '0x10',
    '1e309',
  ])('неполное число %s остаётся ошибкой', (raw) => {
    expect(parseDraftValue(numberDef, { kind: 'raw', raw })).toMatchObject({
      ok: false,
      message: expect.any(String),
    });
  });
  test.each([
    [' 12.5 ', 12.5],
    ['-0.25', -0.25],
    ['1e2', 100],
    ['.5', 0.5],
  ])('число %s', (raw, value) => {
    expect(parseDraftValue(numberDef, { kind: 'raw', raw })).toEqual({ ok: true, value });
  });
  test('Decimal не проходит через Number', () => {
    expect(parseDraftValue(decimalDef, { kind: 'raw', raw: '12345678901234567890,1234' })).toEqual({
      ok: true,
      value: '12345678901234567890.1234',
    });
    expect(parseDraftValue(decimalDef, { kind: 'raw', raw: ' -00012.3400 ' })).toEqual({
      ok: true,
      value: '-00012.3400',
    });
  });
  test.each(['', '1e2', '+1', '1.', '1,2,3'])('нечитаемый decimal %s', (raw) =>
    expect(parseDraftValue(decimalDef, { kind: 'raw', raw }).ok).toBe(false));
});

test('scalar list разбирает каждый элемент, запятая текста остаётся текстом', () => {
  expect(
    parseDraftValue(textManyDef, { kind: 'list', items: ['Дом, работа', '', '  Второе  '] }),
  ).toEqual({ ok: true, value: ['Дом, работа', '', '  Второе  '] });
  expect(
    parseDraftValue(field({ kind: 'number', cardinality: 'many' }), {
      kind: 'list',
      items: ['0', ' 1e2 '],
    }),
  ).toEqual({ ok: true, value: [0, 100] });
  expect(
    parseDraftValue(field({ kind: 'decimal', cardinality: 'many' }), {
      kind: 'list',
      items: ['12345678901234567890,1234'],
    }),
  ).toEqual({ ok: true, value: ['12345678901234567890.1234'] });
  expect(
    parseDraftValue(field({ kind: 'number', cardinality: 'many' }), {
      kind: 'list',
      items: ['1', ''],
    }),
  ).toMatchObject({ ok: false, message: expect.stringContaining('2') });
});

test('parser не копирует min/max/required/default server rules', () => {
  expect(
    parseDraftValue(field({ kind: 'number', min: 10, max: 20 }), { kind: 'raw', raw: '0' }),
  ).toEqual({ ok: true, value: 0 });
  expect(
    parseDraftValue(field({ kind: 'text', cardinality: 'many', minItems: 1 }), {
      kind: 'list',
      items: [],
    }),
  ).toEqual({ ok: true, value: [] });
});

test('timestamp сохраняет смещение зоны и доли секунд', () => {
  for (const raw of [
    '2026-10-11T13:05:00+07:00',
    '2026-10-11T13:05:00.123400-03:30',
    '2026-10-11T13:05:00Z',
  ])
    expect(parseDraftValue(timestampDef, { kind: 'raw', raw })).toEqual({ ok: true, value: raw });
});

test.each([
  '2026-02-30T13:05:00+07:00',
  '2026-10-11T24:00:00Z',
  '2026-10-11T13:60:00Z',
  '2026-10-11T13:05:00+16:00',
  '2026-10-11T13:05',
  '2026-10-11T13:05:00',
  '0000-01-01T00:00:00Z',
])('timestamp %s отвергается', (raw) =>
  expect(parseDraftValue(timestampDef, { kind: 'raw', raw }).ok).toBe(false));

test.each([
  '2026-02-30',
  '2026-13-01',
  '2026-10-11T00:00:00Z',
  '0000-01-01',
  '',
])('date %s отвергается', (raw) =>
  expect(parseDraftValue(field({ kind: 'date' }), { kind: 'raw', raw }).ok).toBe(false));
test('существующая дата и время без превращения в момент', () => {
  expect(parseDraftValue(field({ kind: 'date' }), { kind: 'raw', raw: '2024-02-29' })).toEqual({
    ok: true,
    value: '2024-02-29',
  });
  for (const raw of ['00:00', '23:59'])
    expect(parseDraftValue(field({ kind: 'time' }), { kind: 'raw', raw })).toEqual({
      ok: true,
      value: raw,
    });
});
test.each(['24:00', '12:60', '9:00', '12:00:01', ''])('time %s отвергается', (raw) =>
  expect(parseDraftValue(field({ kind: 'time' }), { kind: 'raw', raw }).ok).toBe(false));
