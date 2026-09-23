// apps/server/src/memory/rules.test.ts
// Правило памяти в свойствах (В7, §А8): подпись, образец из заголовка транзакции и
// fail-closed формы. Всё чистое — базы здесь нет; запись правила через исполнителя
// проверяет `executor/executor.test.ts`, отбор — `memory/select.test.ts`.
import { describe, expect, test } from 'bun:test';
import { formatRuleLabel, patternFromTransactionTitle } from './rules';

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
