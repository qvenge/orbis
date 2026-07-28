// packages/shared/src/memory/rule.test.ts
// Формат memory-правила (01-arch §7.8): заголовок сущности orbis/memory —
// единственный носитель машиночитаемой части правила (решение K19.4).
import { describe, expect, test } from 'bun:test';
import { normalizeCounterparty } from '../import/normalize';
import { formatRuleTitle, parseRuleTitle, rulePatternFromTitle } from './rule';

describe('заголовок memory-правила: format/parse', () => {
  test('1. formatRuleTitle — «<паттерн> → <категория>», стрелка U+2192 с пробелами вокруг', () => {
    expect(formatRuleTitle({ pattern: 'кофе', categoryTitle: 'Развлечения' })).toBe(
      'кофе → Развлечения',
    );
  });

  test('2. round-trip format→parse возвращает исходную пару', () => {
    const args = { pattern: 'яндекс такси', categoryTitle: 'Транспорт' };
    const parsed = parseRuleTitle(formatRuleTitle(args));
    expect(parsed).toEqual(args);
  });

  test('3. заголовок без разделителя → null', () => {
    expect(parseRuleTitle('кофе это Развлечения')).toBeNull();
    expect(parseRuleTitle('')).toBeNull();
    expect(parseRuleTitle('кофе - Развлечения')).toBeNull(); // дефис — не стрелка
  });

  // Уборочная фаза, решение 1: разбор принимает клавиатурные суррогаты, запись остаётся
  // канонической. Стрелку U+2192 с клавиатуры не набрать, а правило, написанное руками
  // (inline-правка заголовка) или созданное моделью, было молча мертво в детерминированных
  // путях — при этом живо в системном промпте, то есть AI его перечислял как работающее.
  test('3b. клавиатурные суррогаты стрелки разбираются как стрелка', () => {
    for (const title of ['кофе -> Развлечения', 'кофе --> Развлечения', 'кофе => Развлечения']) {
      expect(parseRuleTitle(title)).toEqual({ pattern: 'кофе', categoryTitle: 'Развлечения' });
    }
  });

  test('3c. пишем по-прежнему ТОЛЬКО U+2192 — канон записи не размывается', () => {
    expect(formatRuleTitle({ pattern: 'кофе', categoryTitle: 'Еда' })).toBe('кофе → Еда');
  });

  test('4. лишние пробелы по краям обрезаются — и при сборке, и при разборе', () => {
    expect(formatRuleTitle({ pattern: '  кофе ', categoryTitle: ' Развлечения  ' })).toBe(
      'кофе → Развлечения',
    );
    expect(parseRuleTitle('   кофе    →    Развлечения   ')).toEqual({
      pattern: 'кофе',
      categoryTitle: 'Развлечения',
    });
    // разбор терпим к отсутствию пробелов вокруг стрелки (правило могли написать руками)
    expect(parseRuleTitle('кофе→Развлечения')).toEqual({
      pattern: 'кофе',
      categoryTitle: 'Развлечения',
    });
  });

  test('5. стрелка внутри названия категории не ломает разбор: разделитель — ПЕРВОЕ вхождение', () => {
    expect(parseRuleTitle('кофе → Еда → Кафе')).toEqual({
      pattern: 'кофе',
      categoryTitle: 'Еда → Кафе',
    });
    // «первое вхождение» — по любому из принятых разделителей, не только по U+2192
    expect(parseRuleTitle('кофе -> Еда → Кафе')).toEqual({
      pattern: 'кофе',
      categoryTitle: 'Еда → Кафе',
    });
  });

  test('6. пустая сторона разделителя → null (формат не распознан)', () => {
    expect(parseRuleTitle('→ Развлечения')).toBeNull();
    expect(parseRuleTitle('кофе →')).toBeNull();
  });
});

describe('rulePatternFromTitle: паттерн из заголовка транзакции', () => {
  test('7. числа, «ё»→«е», пунктуация и служебные токены срезаются', () => {
    expect(rulePatternFromTitle('SBOL ПЯТЁРОЧКА 843')).toBe('пятерочка');
    expect(rulePatternFromTitle('ЯНДЕКС.ТАКСИ 450')).toBe('яндекс такси');
    // служебный токен срезается только ведущий — это контракт normalizeCounterparty
    expect(rulePatternFromTitle('OPLATA КОФЕЙНЯ, 12')).toBe('кофейня');
  });

  test('8. титул из одних цифр (и служебного мусора) → пустая строка', () => {
    expect(rulePatternFromTitle('450')).toBe('');
    expect(rulePatternFromTitle('SBOL 1234 5678')).toBe('');
    expect(rulePatternFromTitle('')).toBe('');
  });

  test('9. результат пригоден как паттерн правила: format→parse его сохраняет', () => {
    const pattern = rulePatternFromTitle('SBOL ПЯТЁРОЧКА 843');
    expect(parseRuleTitle(formatRuleTitle({ pattern, categoryTitle: 'Еда' }))).toEqual({
      pattern: 'пятерочка',
      categoryTitle: 'Еда',
    });
  });

  // Уборочная фаза, решение 2. Служебный токен, оказавшийся первым только ПОСЛЕ снятия
  // числовых («1234 CARD ПЯТЁРОЧКА» → «card пятерочка»), делал паттерн неканоничным:
  // гейт «эквивалентное правило уже есть» сравнивал его с нормализованным и не находил
  // совпадения — приходило предложение уже созданного правила, а повторное «Запомнить»
  // рождало вторую одноимённую сущность. Плюс служебный мусор был виден в заголовке.
  test('10. паттерн — неподвижная точка normalizeCounterparty', () => {
    expect(rulePatternFromTitle('1234 CARD ПЯТЁРОЧКА')).toBe('пятерочка');
    for (const title of ['1234 CARD ПЯТЁРОЧКА', 'SBOL ПЯТЁРОЧКА 843', 'ЯНДЕКС.ТАКСИ 450']) {
      const p = rulePatternFromTitle(title);
      expect(normalizeCounterparty(p)).toBe(p);
    }
  });
});
