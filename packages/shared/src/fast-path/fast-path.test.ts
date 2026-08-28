import { describe, expect, test } from 'bun:test';
import { type FastPathRule, parseFastPath } from './index';

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
    // Новая форма (§А1-1): значения — плоским `props` по id свойства, аспект — списком.
    expect(r.create.props).toEqual({
      'orbis/amount': '340.00',
      'orbis/direction': 'expense',
      'orbis/currency': 'RUB',
      'orbis/occurred_on': '2026-07-05',
      'orbis/finance_category': 'cat-food',
    });
    expect(r.create.aspects).toEqual(['orbis/financial']);
    // Старой карты в выдаче нет вовсе — иначе перевод остался бы наполовину.
    expect((r.create as Record<string, unknown>).meta).toBeUndefined();
    expect(r.create.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/i); // UUIDv7
  });

  test('"+150000 зарплата" → income', () => {
    const r = parseFastPath('+150000 зарплата', ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.create.props).toMatchObject({
      'orbis/amount': '150000.00',
      'orbis/direction': 'income',
      'orbis/finance_category': 'cat-salary',
    });
  });

  test('"кофе 127.50" → 127.50', () => {
    const r = parseFastPath('кофе 127.50', ctx);
    expect(r.ok && r.create.props?.['orbis/amount']).toBe('127.50');
  });

  test('"кофе 99,90" → 99.90 (запятая как разделитель)', () => {
    const r = parseFastPath('кофе 99,90', ctx);
    expect(r.ok && r.create.props?.['orbis/amount']).toBe('99.90');
  });

  test('"кофе 4 usd" → currency USD', () => {
    const r = parseFastPath('кофе 4 usd', ctx);
    expect(r.ok && r.create.props?.['orbis/currency']).toBe('USD');
  });

  test('"обед 340 $" → currency USD (символ)', () => {
    const r = parseFastPath('обед 340 $', ctx);
    expect(r.ok && r.create.props?.['orbis/currency']).toBe('USD');
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

/**
 * `orbis/finance_category` разобранной строки или undefined, если парсер уступил. Правило задаётся
 * либо голым заголовком (время правки не важно), либо парой {title, updatedAt} — там,
 * где проверяется приоритет свежего правила.
 */
function refOf(text: string, rules?: Array<string | FastPathRule>): string | undefined {
  const asRules = rules?.map((r) => (typeof r === 'string' ? { title: r, updatedAt: '' } : r));
  const r = parseFastPath(text, asRules === undefined ? ctx : { ...ctx, rules: asRules });
  if (!r.ok) return undefined;
  const ref = r.create.props?.['orbis/finance_category'];
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

  // Конфликт «один паттерн — разные категории» достижим штатным потоком §7.8: эскалация
  // подавляет предложение по ПАРЕ категорий и по правилу с тем же паттерном И той же
  // категорией, поэтому исправление «кофе» из Развлечений обратно в Еду рождает ВТОРОЕ
  // правило рядом с первым. По алфавиту побеждало бы «кофе → Развлечения» — то самое
  // правило, которое пользователь только что отменил своей рукой.
  test('при равной длине паттернов побеждает СВЕЖЕЕ правило, а не алфавит', () => {
    const older: FastPathRule = { title: 'кофе → Развлечения', updatedAt: '2026-07-01T10:00:00Z' };
    const newer: FastPathRule = { title: 'кофе → Транспорт', updatedAt: '2026-07-20T10:00:00Z' };
    expect(refOf('кофе 300', [older, newer])).toBe('cat-transport');
    expect(refOf('кофе 300', [newer, older])).toBe('cat-transport');
  });

  test('при равных времени и длине паттернов порядок детерминирован (по заголовку)', () => {
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

  // Достижимый вход: правило, созданное руками на экране «Память AI». «card» —
  // служебный токен §3.4.1, normalizeCounterparty срезает его целиком, и паттерн
  // становится пустым. Без гейта пустого паттерна такое правило матчило бы ЛЮБУЮ
  // строку (haystack.includes('') === true) и уводило бы весь ввод в свою категорию.
  test('правило с пустым после нормализации паттерном («card → …») игнорируется', () => {
    expect(refOf('кофе 300', ['card → Развлечения'])).toBe('cat-food');
  });

  // Уборочная фаза, решение 3. Сопоставление подстрокой ловило чужие слова: канонический
  // пример спеки «бар → Развлечения» (01-arch §7.5) перехватывал «барбершоп», то есть
  // правило АКТИВНО порождало неверную категоризацию вместо улучшения. Соседняя ступень
  // той же категоризации (резолв по алиасам) всегда работала по целому слову.
  test('паттерн ловится по границе токена: «бар» не перехватывает «барбершоп»', () => {
    expect(refOf('барбершоп 1500', ['бар → Развлечения'])).toBeUndefined();
    expect(refOf('бар 1500', ['бар → Развлечения'])).toBe('cat-fun');
    // и в конце строки, и в середине — граница считается одинаково
    expect(refOf('вечером бар 1500', ['бар → Развлечения'])).toBe('cat-fun');
  });

  test('многословный паттерн ловится как НЕПРЕРЫВНАЯ последовательность токенов', () => {
    expect(refOf('кофе хауз 300', ['кофе хауз → Транспорт'])).toBe('cat-transport');
    // те же токены, но не подряд — правило не сработало, резолв упал на алиасы («кофе» → Еда)
    expect(refOf('кофе большой хауз 300', ['кофе хауз → Транспорт'])).toBe('cat-food');
  });

  // Клавиатурный суррогат разделителя (решение 1) обязан работать у ОБОИХ потребителей
  // applyMemoryRules — здесь fast-path, на сервере тот же код резолвит строки выписки.
  test('правило, написанное руками через «->», работает', () => {
    expect(refOf('кофе 300', ['кофе -> Развлечения'])).toBe('cat-fun');
  });
});
