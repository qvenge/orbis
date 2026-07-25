import { describe, expect, test } from 'bun:test';
import { parseFastPath } from './index';

// title обязателен для memory-правил: правило ссылается на категорию НАЗВАНИЕМ (D3a).
const cats = [
  { id: 'cat-food', title: 'Еда', aliases: ['обед', 'еда', 'кофе'], spendClass: 'variable' },
  { id: 'cat-salary', title: 'Зарплата', aliases: ['зарплата'], spendClass: 'income' },
  { id: 'cat-fun', title: 'Развлечения', aliases: ['развлечения'], spendClass: 'variable' },
  { id: 'cat-transport', title: 'Транспорт', aliases: ['такси'], spendClass: 'variable' },
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

/** category_ref разобранной строки или undefined, если парсер уступил. */
function refOf(text: string, rules?: string[]): string | undefined {
  const r = parseFastPath(text, rules === undefined ? ctx : { ...ctx, rules });
  if (!r.ok) return undefined;
  const ref = r.create.aspects?.['orbis/financial']?.category_ref;
  return typeof ref === 'string' ? ref : undefined;
}

// 01-arch §7.5: «Fast-path применяет correction-правила из памяти (orbis/memory, kind=rule,
// scope=orbis/financial)» — правило работает в детерминированном пути, без LLM, и имеет
// приоритет над алиасами (иначе исправление, которое пользователь подтвердил, не работает).
describe('fast-path: memory-правила перед алиасами (§7.5, §7.8)', () => {
  test('без правил «кофе 300» → Еда по alias', () => {
    expect(refOf('кофе 300')).toBe('cat-food');
  });

  test('правило «кофе → Развлечения» перекрывает alias Еды', () => {
    expect(refOf('кофе 300', ['кофе → Развлечения'])).toBe('cat-fun');
  });

  test('правило матчится по нормализованному тексту (регистр, ё), где алиасов нет вовсе', () => {
    expect(parseFastPath('ПЯТЁРОЧКА 843', ctx)).toEqual({ ok: false, reason: 'unknown_category' });
    expect(refOf('ПЯТЁРОЧКА 843', ['пятерочка → Еда'])).toBe('cat-food');
  });

  test('побеждает самое специфичное правило (длиннее паттерн), порядок правил не важен', () => {
    const rules = ['кофе → Развлечения', 'кофе хауз → Транспорт'];
    expect(refOf('кофе хауз 300', rules)).toBe('cat-transport');
    expect(refOf('кофе хауз 300', [...rules].reverse())).toBe('cat-transport');
  });

  test('при равной длине паттернов порядок детерминирован (по заголовку правила)', () => {
    const rules = ['кофе → Транспорт', 'кофе → Развлечения'];
    expect(refOf('кофе 300', rules)).toBe('cat-fun'); // «…Развлечения» < «…Транспорт»
    expect(refOf('кофе 300', [...rules].reverse())).toBe('cat-fun');
  });

  test('правило с несуществующей категорией игнорируется — резолв падает на алиасы', () => {
    expect(refOf('кофе 300', ['кофе → Квакозябра'])).toBe('cat-food');
  });

  test('заголовок без стрелки правилом не считается', () => {
    expect(refOf('кофе 300', ['кофе Развлечения'])).toBe('cat-food');
  });
});
