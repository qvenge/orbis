import { describe, expect, test } from 'bun:test';
import { parseFastPath } from './index';

const cats = [
  { id: 'cat-food', aliases: ['обед', 'еда', 'кофе'], spendClass: 'variable' },
  { id: 'cat-salary', aliases: ['зарплата'], spendClass: 'income' },
];
const ctx = { categories: cats, defaultCurrency: 'RUB', today: '2026-07-05' };

describe('fast-path parseFastPath (§7.5)', () => {
  test('"обед 340" → financial expense, amount 340.00, категория по alias', () => {
    const r = parseFastPath('обед 340', ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.create.title).toBe('обед');
    expect(r.create.aspects?.['orbis/financial']).toMatchObject({
      amount: '340.00',
      direction: 'expense',
      currency: 'RUB',
      occurred_on: '2026-07-05',
      category_ref: 'cat-food',
    });
    expect(r.create.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/i); // UUIDv7
  });

  test('"+150000 зарплата" → income', () => {
    const r = parseFastPath('+150000 зарплата', ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.create.aspects?.['orbis/financial']).toMatchObject({
      amount: '150000.00',
      direction: 'income',
      category_ref: 'cat-salary',
    });
  });

  test('"кофе 127.50" → 127.50', () => {
    const r = parseFastPath('кофе 127.50', ctx);
    expect(r.ok && r.create.aspects?.['orbis/financial']?.amount).toBe('127.50');
  });

  test('"кофе 99,90" → 99.90 (запятая как разделитель)', () => {
    const r = parseFastPath('кофе 99,90', ctx);
    expect(r.ok && r.create.aspects?.['orbis/financial']?.amount).toBe('99.90');
  });

  test('"кофе 4 usd" → currency USD', () => {
    const r = parseFastPath('кофе 4 usd', ctx);
    expect(r.ok && r.create.aspects?.['orbis/financial']?.currency).toBe('USD');
  });

  test('"обед 340 $" → currency USD (символ)', () => {
    const r = parseFastPath('обед 340 $', ctx);
    expect(r.ok && r.create.aspects?.['orbis/financial']?.currency).toBe('USD');
  });

  test('неизвестная категория → уступает LLM', () => {
    expect(parseFastPath('квакозябра 500', ctx)).toEqual({ ok: false, reason: 'unknown_category' });
  });

  test('несколько сумм → ambiguous', () => {
    expect(parseFastPath('перевод 100 и 200', ctx)).toEqual({ ok: false, reason: 'ambiguous' });
  });

  test('вопросительная форма → question', () => {
    expect(parseFastPath('сколько я потратил на еду?', ctx)).toEqual({
      ok: false,
      reason: 'question',
    });
  });

  test('нет числа → no_match', () => {
    expect(parseFastPath('просто заметка', ctx)).toEqual({ ok: false, reason: 'no_match' });
  });
});
