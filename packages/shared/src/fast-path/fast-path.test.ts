import { describe, expect, test } from 'bun:test';
import {
  applyMemoryRules,
  type FastPathRule,
  parseFastPath,
  RESOLVE_ORDER,
  ruleAppliesTo,
} from './index';

// title обязателен для второй ступени резолва — алиасов (правило после В7 ссылается на
// категорию ПО ID, а не по названию).
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

/** Правило в форме свойств (В7): образец, ссылка на категорию, время правки. */
function rule(pattern: string, targetId: string, updatedAt = ''): FastPathRule {
  return { pattern, targetId, updatedAt };
}

/** `orbis/finance_category` разобранной строки или undefined, если парсер уступил. */
function refOf(text: string, rules?: FastPathRule[]): string | undefined {
  const r = parseFastPath(text, rules === undefined ? ctx : { ...ctx, rules });
  if (!r.ok) return undefined;
  const ref = r.create.props?.['orbis/finance_category'];
  return typeof ref === 'string' ? ref : undefined;
}

// 01-arch §7.5: «Fast-path применяет correction-правила из памяти» — правило работает в
// детерминированном пути, без LLM, и имеет приоритет над алиасами (иначе исправление,
// которое пользователь подтвердил, не работает).
describe('fast-path: memory-правила перед алиасами (§7.5, §7.8)', () => {
  test('без правил «кофе 300» → Еда по alias', () => {
    expect(refOf('кофе 300')).toBe('cat-food');
  });

  test('правило «кофе → Развлечения» перекрывает alias Еды', () => {
    expect(refOf('кофе 300', [rule('кофе', 'cat-fun')])).toBe('cat-fun');
  });

  // Приёмка Задачи 18: образец берётся из СВОЙСТВА, и ступень правил идёт раньше ступени
  // алиасов — порядок задаёт RESOLVE_ORDER, один на быстрый ввод и резолв импорта.
  test('«500 пятёрочка» резолвит категорию по rule_pattern раньше aliases (RESOLVE_ORDER)', () => {
    // без правила слово «пятёрочка» не покрыто ни одним алиасом — категории нет вовсе
    expect(parseFastPath('500 пятёрочка', ctx)).toEqual({ ok: false, reason: 'unknown_category' });
    expect(refOf('500 пятёрочка', [rule('пятерочка', 'cat-food')])).toBe('cat-food');
    // порядок ступеней — параметр, а не порядок строк в коде
    expect([...RESOLVE_ORDER]).toEqual(['rules', 'aliases']);
    // и он наблюдаем: на входе, покрытом И правилом, И алиасом, побеждает правило
    expect(refOf('кофе 300', [rule('кофе', 'cat-transport')])).toBe('cat-transport');
  });

  test('правило матчится по нормализованному тексту (регистр, ё), где алиасов нет вовсе', () => {
    expect(parseFastPath('ПЯТЁРОЧКА 843', ctx)).toEqual({ ok: false, reason: 'unknown_category' });
    expect(refOf('ПЯТЁРОЧКА 843', [rule('пятерочка', 'cat-food')])).toBe('cat-food');
  });

  test('побеждает самое специфичное правило (длиннее образец), порядок правил не важен', () => {
    const rules = [rule('кофе', 'cat-fun'), rule('кофе хауз', 'cat-transport')];
    expect(refOf('кофе хауз 300', rules)).toBe('cat-transport');
    expect(refOf('кофе хауз 300', [...rules].reverse())).toBe('cat-transport');
  });

  // Конфликт «один образец — разные категории» достижим штатным потоком §7.8: эскалация
  // подавляет предложение по ПАРЕ категорий и по правилу с тем же образцом И той же
  // категорией, поэтому исправление «кофе» из Развлечений обратно в Еду рождает ВТОРОЕ
  // правило рядом с первым. По алфавиту победило бы то самое правило, которое пользователь
  // только что отменил своей рукой.
  test('при равной длине образцов побеждает СВЕЖЕЕ правило, а не алфавит', () => {
    const older = rule('кофе', 'cat-fun', '2026-07-01T10:00:00Z');
    const newer = rule('кофе', 'cat-transport', '2026-07-20T10:00:00Z');
    expect(refOf('кофе 300', [older, newer])).toBe('cat-transport');
    expect(refOf('кофе 300', [newer, older])).toBe('cat-transport');
  });

  // Порядок обязан быть ПОЛНЫМ: web и сервер читают правила в разном порядке (ORDER BY id
  // против порядка выдачи запроса), и неполный дал бы им разные ответы на одних данных.
  // Заголовка у правила больше нет — последний ключ сортировки это id категории.
  test('при равных времени и длине образцов порядок детерминирован (по id категории)', () => {
    const rules = [rule('кофе', 'cat-transport'), rule('кофе', 'cat-fun')];
    expect(refOf('кофе 300', rules)).toBe('cat-fun'); // 'cat-fun' < 'cat-transport'
    expect(refOf('кофе 300', [...rules].reverse())).toBe('cat-fun');
  });

  test('правило с несуществующей категорией игнорируется — резолв падает на алиасы', () => {
    expect(refOf('кофе 300', [rule('кофе', 'cat-снесённая')])).toBe('cat-food');
  });

  // ЭТО И ЕСТЬ В7: правая часть правила — ССЫЛКА, а не сохранённое название. Прежде
  // переименование категории «отвязывало» правило (резолв по названию переставал её
  // находить), и владелец видел живое правило, которое молча не работает.
  test('переименование категории правило не отвязывает: цель — id, а не название', () => {
    const renamed = cats.map((c) => (c.id === 'cat-fun' ? { ...c, title: 'Досуг' } : c));
    const found = applyMemoryRules('кофе', [rule('кофе', 'cat-fun')], renamed);
    expect(found?.id).toBe('cat-fun');
    expect(found?.title).toBe('Досуг');
  });

  // Достижимый вход: правило, созданное руками на экране «Память AI». «card» —
  // служебный токен §3.4.1, normalizeCounterparty срезает его целиком, и образец
  // становится пустым. Без гейта пустого образца такое правило матчило бы ЛЮБУЮ
  // строку (haystack.includes('') === true) и уводило бы весь ввод в свою категорию.
  test('правило с пустым после нормализации образцом («card») игнорируется', () => {
    expect(refOf('кофе 300', [rule('card', 'cat-fun')])).toBe('cat-food');
  });

  // Уборочная фаза, решение 3. Сопоставление подстрокой ловило чужие слова: канонический
  // пример спеки «бар → Развлечения» (01-arch §7.5) перехватывал «барбершоп», то есть
  // правило АКТИВНО порождало неверную категоризацию вместо улучшения. Соседняя ступень
  // той же категоризации (резолв по алиасам) всегда работала по целому слову.
  test('образец ловится по границе токена: «бар» не перехватывает «барбершоп»', () => {
    expect(refOf('барбершоп 1500', [rule('бар', 'cat-fun')])).toBeUndefined();
    expect(refOf('бар 1500', [rule('бар', 'cat-fun')])).toBe('cat-fun');
    // и в конце строки, и в середине — граница считается одинаково
    expect(refOf('вечером бар 1500', [rule('бар', 'cat-fun')])).toBe('cat-fun');
  });

  test('многословный образец ловится как НЕПРЕРЫВНАЯ последовательность токенов', () => {
    expect(refOf('кофе хауз 300', [rule('кофе хауз', 'cat-transport')])).toBe('cat-transport');
    // те же токены, но не подряд — правило не сработало, резолв упал на алиасы («кофе» → Еда)
    expect(refOf('кофе большой хауз 300', [rule('кофе хауз', 'cat-transport')])).toBe('cat-food');
  });
});

// Предикат области — ОБЩАЯ сторона с сервером (`memory/select.ts` выражает его в SQL).
// Расхождение здесь означало бы правило, которое работает в импорте и молчит в быстром
// вводе; схождение сторон пиннит серверный `memory/select.test.ts` на тех же трёх случаях.
describe('ruleAppliesTo: область правила', () => {
  test('та же область — применимо; чужая — нет; области нет вовсе — применимо', () => {
    expect(ruleAppliesTo('orbis/money-movement', 'orbis/money-movement')).toBe(true);
    expect(ruleAppliesTo('orbis/progress', 'orbis/money-movement')).toBe(false);
    expect(ruleAppliesTo(undefined, 'orbis/money-movement')).toBe(true);
  });

  // `NOT props ? key` в SQL на ключе со значением null ЛОЖЕН: ключ присутствует. Вторая
  // сторона обязана отвечать так же, иначе стороны разойдутся ровно на этой строке.
  test('ключ есть, значение null — глобальным правилом НЕ считается (как в SQL)', () => {
    expect(ruleAppliesTo(null, 'orbis/money-movement')).toBe(false);
  });
});
