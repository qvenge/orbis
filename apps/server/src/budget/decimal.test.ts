// apps/server/src/budget/decimal.test.ts
// Юнит-тесты decimal-арифметики формул Budget (03-budget §2.4, глобальное ограничение
// «деньги — только decimal-строки»): BigInt поверх строк, без IEEE-754; деление —
// ровно 2 знака, half-away-from-zero (бриф A6). Чистые тесты, БД не нужна.
import { describe, expect, test } from 'bun:test';
import { decAdd, decCmp, decDivBy, decMulInt, decRatio, decSub } from './decimal';

describe('decAdd/decSub: сложение и вычитание decimal-строк', () => {
  test('складывает с выравниванием масштаба; итог минимум 2 знака', () => {
    expect(decAdd('30000.00', '1200')).toBe('31200.00');
    expect(decAdd('0', '0')).toBe('0.00');
    expect(decAdd('1200', '0.5')).toBe('1200.50');
    expect(decAdd('0.005', '0.005')).toBe('0.010'); // масштаб входа сохраняется (>2)
  });

  test('отрицательный carryover урезает лимит (§2.6)', () => {
    expect(decAdd('30000.00', '-800')).toBe('29200.00');
    expect(decSub('100.00', '150.00')).toBe('-50.00');
    expect(decSub('31200.00', '2680.00')).toBe('28520.00');
  });

  test('вычитание до нуля — канонический "0.00", не "-0.00"', () => {
    expect(decSub('340.00', '340.00')).toBe('0.00');
  });
});

describe('decCmp: сравнение без float', () => {
  test('сравнивает с выравниванием масштаба', () => {
    expect(decCmp('900.00', '850')).toBe(1);
    expect(decCmp('850.0', '850.00')).toBe(0);
    expect(decCmp('-50.00', '0')).toBe(-1);
    // классическая ловушка float: 0.1 + 0.2 vs 0.3
    expect(decCmp(decAdd('0.1', '0.2'), '0.3')).toBe(0);
  });
});

describe('decMulInt: умножение на целое (порог 85% — 20·spent vs 17·limit)', () => {
  test('умножает точно', () => {
    expect(decMulInt('850.00', 20)).toBe('17000.00');
    expect(decMulInt('1000.00', 17)).toBe('17000.00');
    expect(decCmp(decMulInt('851.00', 20), decMulInt('1000.00', 17))).toBe(1);
    expect(decCmp(decMulInt('850.00', 20), decMulInt('1000.00', 17))).toBe(0); // ровно 85% — НЕ alert
  });
});

describe('decDivBy: деление на целые дни — 2 знака, half-away-from-zero (§2.4)', () => {
  test('ровное деление', () => {
    expect(decDivBy('8400.00', 14)).toBe('600.00');
  });

  test('округление half-away-from-zero, не banker’s', () => {
    expect(decDivBy('900.50', 3)).toBe('300.17'); // 300.1666…
    expect(decDivBy('0.05', 2)).toBe('0.03'); // 0.025 → от нуля вверх
    expect(decDivBy('0.15', 2)).toBe('0.08'); // 0.075 → 0.08 (не 0.07)
    expect(decDivBy('-0.05', 2)).toBe('-0.03'); // от нуля — и в минус
  });

  test('деление на 1 нормализует к 2 знакам', () => {
    expect(decDivBy('123', 1)).toBe('123.00');
  });
});

describe('decRatio: доля для прогресс-бара цели (§11.3)', () => {
  test('делитель — decimal-строка, а не натуральное число (чего не умеет decDivBy)', () => {
    expect(decRatio('150000.00', '300000.00')).toBeCloseTo(0.5, 9);
    expect(decRatio('80.5', '100')).toBeCloseTo(0.805, 9);
    // Почему не decDivBy: он по построению требует натуральный делитель
    expect(() => decDivBy('150000.00', 300000.5)).toThrow(RangeError);
  });

  test('точность не теряется на длинных decimal-строках (float появляется один раз)', () => {
    // 0.1 + 0.2 в IEEE-754 дало бы 0.30000000000000004; здесь делятся точные BigInt
    expect(decRatio('0.30', '0.10')).toBe(3);
    expect(decRatio('999999999.99', '999999999.99')).toBe(1);
  });

  test('перевыполнение и пустой прогресс', () => {
    expect(decRatio('450000.00', '300000.00')).toBeCloseTo(1.5, 9);
    expect(decRatio('0', '300000.00')).toBe(0);
  });

  test('округление half-away-from-zero на масштабе 1e-6, знак — один раз', () => {
    expect(decRatio('2', '3')).toBeCloseTo(0.666667, 9); // 0.6666665 → вверх
    expect(decRatio('-1', '3')).toBeCloseTo(-0.333333, 9);
    expect(decRatio('1', '-3')).toBeCloseTo(-0.333333, 9);
  });

  test('ноль в делителе — RangeError, а не Infinity', () => {
    expect(() => decRatio('10', '0')).toThrow(RangeError);
    expect(() => decRatio('10', '0.00')).toThrow(RangeError);
  });

  test('не decimal-строка — RangeError, а не тихий NaN', () => {
    expect(() => decRatio('не число', '10')).toThrow(RangeError);
  });
});
