// apps/server/src/budget/decimal.test.ts
// Юнит-тесты decimal-арифметики формул Budget (03-budget §2.4, глобальное ограничение
// «деньги — только decimal-строки»): BigInt поверх строк, без IEEE-754; деление —
// ровно 2 знака, half-away-from-zero (бриф A6). Чистые тесты, БД не нужна.
import { describe, expect, test } from 'bun:test';
import { decAdd, decCmp, decDiv, decDivBy, decMul, decMulInt, decRatio, decSub } from './decimal';

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

describe('decMul: умножение decimal×decimal — точно, без округления', () => {
  test('масштаб результата = сумма масштабов (но канонический минимум — 2 знака)', () => {
    expect(decMul('100.02', '0.85')).toBe('85.0170'); // 2+2 знака: масштаб точный, не канонический
    expect(decMul('850.00', '20')).toBe('17000.00');
    expect(decMul('3', '4')).toBe('12.00'); // 0+0 знаков → канон «минимум два»
    expect(decMul('-2.5', '4')).toBe('-10.00');
    expect(decMul('-0.5', '0')).toBe('0.00'); // "-0.00" схлопывается, как у decAdd/decSub
  });

  test('на целом множителе совпадает с decMulInt — порог §6.1 переписывается без сдвига', () => {
    for (const a of ['0.00', '850.00', '1000.00', '999999999.99', '-50.00']) {
      expect(`${a}: ${decMul(a, '20')}`).toBe(`${a}: ${decMulInt(a, 20)}`);
      expect(`${a}: ${decMul(a, '17')}`).toBe(`${a}: ${decMulInt(a, 17)}`);
    }
  });

  test('порог 0.85 ВКЛЮЧИТЕЛЬНО: decCmp(spent, decMul(limit, "0.85")) ≥ 0 ≡ isAlert (aggregates.ts:390-392)', () => {
    // Декларация §Б5-4 пишет порог литералом {const:"0.85"} (ревизия 3: decimal — строкой), то
    // есть через ЭТО умножение. Округли decMul до двух знаков — и конверт с копеечным лимитом
    // сменил бы вердикт: 0.85 · 100.04 = 85.034, округлённое — 85.03, и spent = 85.03 стал бы
    // «тревогой» (у оракула 20·85.03 = 1700.60 < 17·100.04 = 1700.68 — не тревога).
    const oldWay = (s: string, l: string) => decCmp(decMulInt(s, 20), decMulInt(l, 17)) >= 0;
    const newWay = (s: string, l: string) => decCmp(s, decMul(l, '0.85')) >= 0;
    const cases: Array<[string, string]> = [
      ['850.00', '1000.00'], // ровно 85 % — alert (sign-off владельца 2026-07-23)
      ['849.99', '1000.00'],
      ['85.03', '100.04'], // округление ВНИЗ: точный порог 85.034, округлённый — 85.03
      ['85.01', '100.01'],
      ['85.00', '100.01'],
      ['0.00', '0.00'], // нулевой лимит: 0 ≥ 0 у обеих формул
      ['0.00', '100.00'],
      ['150.00', '100.00'],
    ];
    for (const [s, l] of cases) {
      expect(`${s}/${l}: ${newWay(s, l)}`).toBe(`${s}/${l}: ${oldWay(s, l)}`);
    }
  });
});

describe('decDiv: деление decimal÷decimal — заданный масштаб, half-away-from-zero', () => {
  test('умолчание — 2 знака; дробь округляется от нуля в обе стороны', () => {
    expect(decDiv('1', '3')).toBe('0.33');
    expect(decDiv('2', '3')).toBe('0.67');
    expect(decDiv('900.50', '3')).toBe('300.17');
    expect(decDiv('0.05', '2')).toBe('0.03');
    expect(decDiv('-0.05', '2')).toBe('-0.03');
  });

  test('масштаб — параметр: 0 знаков даёт целую строку, 6 — долю', () => {
    expect(decDiv('10', '4', 0)).toBe('3'); // 2.5 → от нуля вверх
    expect(decDiv('1', '3', 6)).toBe('0.333333');
    expect(decDiv('2', '3', 6)).toBe('0.666667');
  });

  test('на натуральном делителе совпадает с decDivBy — daily_pace не сдвигается', () => {
    for (const a of ['8400.00', '900.50', '0.05', '-0.05', '123', '28520.00']) {
      for (const n of [1, 2, 3, 14, 31]) {
        expect(`${a}/${n}: ${decDiv(a, String(n))}`).toBe(`${a}/${n}: ${decDivBy(a, n)}`);
      }
    }
  });

  test('ноль в делителе — RangeError, а не Infinity (как у decRatio)', () => {
    expect(() => decDiv('10', '0')).toThrow(RangeError);
    expect(() => decDiv('10', '0.00')).toThrow(RangeError);
  });

  test('масштаб — целое ≥ 0; не decimal-строка — RangeError, а не тихий NaN', () => {
    expect(() => decDiv('10', '3', -1)).toThrow(RangeError);
    expect(() => decDiv('10', '3', 1.5)).toThrow(RangeError);
    expect(() => decDiv('не число', '3')).toThrow(RangeError);
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

  test('доля, не влезающая во float, — RangeError, а не Infinity', () => {
    // Длину decimal-строки ничто не ограничивает; Infinity уехал бы на клиент как
    // JSON `null` в поле типа number — контракт соврал бы вместо честного отказа.
    const huge = `1${'0'.repeat(400)}`;
    expect(() => decRatio(huge, '1')).toThrow(RangeError);
    expect(() => decRatio(`-${huge}`, '1')).toThrow(RangeError);
    // Граница нормальности: 1e9 / 1 — обычное число, отказа быть не должно
    expect(decRatio('1000000000', '1')).toBe(1e9);
  });
});
