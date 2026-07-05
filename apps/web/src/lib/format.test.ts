import { expect, test } from 'vitest';
import { formatDate, formatMoney } from './format';

test('расход: знак минус (U+2212), тон danger, decimal-строка без float', () => {
  const r = formatMoney('340.00', 'expense');
  expect(r.tone).toBe('danger');
  expect(r.text.startsWith('−')).toBe(true);
  expect(r.text).toContain('340');
});

test('доход: знак плюс, тон positive', () => {
  const r = formatMoney('150000.00', 'income');
  expect(r.tone).toBe('positive');
  expect(r.text.startsWith('+')).toBe(true);
});

test('группировка тысяч сохраняет дробную часть как есть', () => {
  expect(formatMoney('1234567.89', 'income').text).toContain('.89');
});

test('ноль: направление всё равно определяет знак/тон', () => {
  expect(formatMoney('0.00', 'expense')).toMatchObject({ tone: 'danger' });
});

test('formatDate учитывает таймзону (Moscow = UTC+3)', () => {
  const iso = '2026-07-05T12:00:00.000Z';
  const msk = formatDate(iso, 'Europe/Moscow');
  const utc = formatDate(iso, 'UTC');
  expect(msk).toContain('15:00');
  expect(utc).toContain('12:00');
});
