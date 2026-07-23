import { expect, test } from 'vitest';
import { formatAmount, formatDate, formatMoney } from './format';

test('formatAmount: без знака, группировка, незначащие нули дроби опущены', () => {
  expect(formatAmount('7200.00')).toBe('7 200');
  expect(formatAmount('-1234567.50')).toBe('1 234 567.5');
  expect(formatAmount('0.00')).toBe('0');
  expect(formatAmount('599')).toBe('599');
});

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

test('деньги без float: сумма за пределами точности Number сохранена точно', () => {
  // Number('9999999999999999.99') === 10000000000000000 — float потерял бы и дробь, и хвост целой части.
  const r = formatMoney('9999999999999999.99', 'income');
  expect(r.text.endsWith('.99')).toBe(true);
  expect(r.text.replace(/[^\d]/g, '')).toBe('999999999999999999');
});

test('группировка тысяч: 1234567 → «1 234 567»', () => {
  expect(formatMoney('1234567.89', 'income').text).toBe('+1 234 567.89');
});

test('formatDate: битый iso не бросает, возвращает вход как есть', () => {
  expect(() => formatDate('garbage', 'UTC')).not.toThrow();
  expect(formatDate('garbage', 'UTC')).toBe('garbage');
});

test('formatDate учитывает таймзону (Moscow = UTC+3)', () => {
  const iso = '2026-07-05T12:00:00.000Z';
  const msk = formatDate(iso, 'Europe/Moscow');
  const utc = formatDate(iso, 'UTC');
  expect(msk).toContain('15:00');
  expect(utc).toContain('12:00');
});
