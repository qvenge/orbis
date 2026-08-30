// apps/server/src/memory/rules.test.ts
// Правило памяти в свойствах (В7, §А8): подпись, образец из заголовка транзакции и
// fail-closed формы. Всё чистое — базы здесь нет; запись правила через исполнителя
// проверяет `executor/executor.test.ts`, отбор — `memory/select.test.ts`.
import { describe, expect, test } from 'bun:test';
import { formatRuleLabel, patternFromTransactionTitle, ruleViolations } from './rules';

describe('formatRuleLabel: генерируемая подпись правила', () => {
  test('«образец → категория», стрелка U+2192 с пробелами вокруг', () => {
    expect(formatRuleLabel('кофе', 'Развлечения')).toBe('кофе → Развлечения');
  });

  test('края обрезаются с обеих сторон', () => {
    expect(formatRuleLabel('  кофе ', ' Развлечения  ')).toBe('кофе → Развлечения');
  });

  // Подпись — не хранилище: обратной функции нет, и неполная подпись ничего не теряет.
  // Глобальное правило законно живёт без цели, и стрелка «в никуда» была бы враньём.
  test('без цели — один образец, без висячей стрелки', () => {
    expect(formatRuleLabel('кофе', '')).toBe('кофе');
    expect(formatRuleLabel('кофе', '   ')).toBe('кофе');
  });
});

describe('patternFromTransactionTitle: образец из заголовка ТРАНЗАКЦИИ', () => {
  test('служебные префиксы и числовые токены снимаются', () => {
    expect(patternFromTransactionTitle('SBOL ПЯТЁРОЧКА 843')).toBe('пятерочка');
    expect(patternFromTransactionTitle('ЯНДЕКС.ТАКСИ 450')).toBe('яндекс такси');
    expect(patternFromTransactionTitle('OPLATA КОФЕЙНЯ, 12')).toBe('кофейня');
  });

  test('нечего оставить — пустая строка (правилом такое стать не может)', () => {
    expect(patternFromTransactionTitle('450')).toBe('');
    expect(patternFromTransactionTitle('SBOL 1234 5678')).toBe('');
    expect(patternFromTransactionTitle('')).toBe('');
  });

  // Неподвижная точка: служебный токен становится ПЕРВЫМ только после снятия числовых.
  // Без второго прогона нормализации «1234 CARD ПЯТЁРОЧКА» давало «card пятерочка», и гейт
  // «эквивалентное правило уже есть» не находил уже созданного правила.
  test('результат — неподвижная точка нормализации', () => {
    expect(patternFromTransactionTitle('1234 CARD ПЯТЁРОЧКА')).toBe('пятерочка');
    for (const title of ['SBOL ПЯТЁРОЧКА 843', '1234 CARD ПЯТЁРОЧКА', 'ЯНДЕКС.ТАКСИ 450']) {
      const p = patternFromTransactionTitle(title);
      expect(patternFromTransactionTitle(p)).toBe(p);
    }
  });
});

describe('ruleViolations: fail-closed формы правила (§А8)', () => {
  const rule = (props: Record<string, unknown>) => ruleViolations({ props, aspects: [] });

  test('факт не проверяется вовсе — образца у факта не бывает', () => {
    expect(rule({ 'orbis/memory_kind': 'fact' })).toEqual([]);
    expect(rule({})).toEqual([]);
  });

  test('правило без образца — RULE_WITHOUT_PATTERN', () => {
    expect(rule({ 'orbis/memory_kind': 'rule' })).toEqual([{ code: 'RULE_WITHOUT_PATTERN' }]);
  });

  // Пробел образцом не является: пустой после trim образец совпал бы с чем угодно —
  // ровно тот случай, ради которого гейт и заведён.
  test('образец из одних пробелов образцом не считается', () => {
    expect(rule({ 'orbis/memory_kind': 'rule', 'orbis/rule_pattern': '   ' })).toEqual([
      { code: 'RULE_WITHOUT_PATTERN' },
    ]);
  });

  test('денежное правило без цели — RULE_WITHOUT_TARGET (подставлять нечего)', () => {
    expect(
      rule({
        'orbis/memory_kind': 'rule',
        'orbis/rule_pattern': 'пятерочка',
        'orbis/rule_scope': 'orbis/money-movement',
      }),
    ).toEqual([{ code: 'RULE_WITHOUT_TARGET', scope: 'orbis/money-movement' }]);
  });

  test('глобальное правило без цели законно: его читает только память промпта', () => {
    expect(rule({ 'orbis/memory_kind': 'rule', 'orbis/rule_pattern': 'пятерочка' })).toEqual([]);
  });

  test('полное денежное правило нарушений не даёт', () => {
    expect(
      rule({
        'orbis/memory_kind': 'rule',
        'orbis/rule_pattern': 'пятерочка',
        'orbis/rule_scope': 'orbis/money-movement',
        'orbis/rule_target': '00000000-0000-7000-8000-000000000000',
      }),
    ).toEqual([]);
  });

  // Р9: снятие аспекта памяти НЕ уносит значения из `props`, поэтому признак «это правило»
  // берётся из `props`, а не из списка аспектов. Иначе detach аспекта открывал бы дверь
  // для записи правила без образца — той самой формы, которую задача и закрывает.
  test('признак берётся из props, а не из списка аспектов (Р9)', () => {
    expect(ruleViolations({ props: { 'orbis/memory_kind': 'rule' }, aspects: [] })).toEqual([
      { code: 'RULE_WITHOUT_PATTERN' },
    ]);
    expect(ruleViolations({ props: {}, aspects: ['orbis/memory'] })).toEqual([]);
  });
});
