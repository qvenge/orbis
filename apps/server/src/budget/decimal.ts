// apps/server/src/budget/decimal.ts
// Точная decimal-арифметика формул Budget (03-budget §2.4) поверх строк:
// BigInt на выровненном масштабе, никакого parseFloat/IEEE-754 (глобальное
// ограничение «деньги — только decimal-строки», 01-arch §3.3). Суммы НАБОРОВ
// считает SQL (::numeric) — здесь только формулы поверх готовых строк:
// effectiveLimit/remaining (add/sub), пороги (cmp/mulInt), dailyPace (divBy:
// ровно 2 знака, half-away-from-zero — бриф A6).

const DEC_RE = /^(-?)(\d+)(?:\.(\d+))?$/;

interface Dec {
  v: bigint; // значение со знаком на масштабе s
  s: number; // знаков после точки
}

function parseDec(input: string): Dec {
  const m = DEC_RE.exec(input);
  if (m === null) {
    throw new RangeError(`не decimal-строка: "${input}"`);
  }
  const [, sign, int, frac = ''] = m as unknown as [string, string, string, string?];
  const digits = `${int}${frac ?? ''}`;
  const v = BigInt(digits) * (sign === '-' ? -1n : 1n);
  return { v, s: (frac ?? '').length };
}

/** Выравнивание двух значений на общий масштаб (максимум, но не меньше 2). */
function align(a: Dec, b: Dec): { av: bigint; bv: bigint; s: number } {
  const s = Math.max(a.s, b.s, 2);
  return { av: rescale(a, s), bv: rescale(b, s), s };
}

function rescale(d: Dec, s: number): bigint {
  return d.v * 10n ** BigInt(s - d.s);
}

/** Каноническая строка: минимум 2 знака; "-0.00" схлопывается в "0.00". */
function format(v: bigint, s: number): string {
  const neg = v < 0n;
  const abs = (neg ? -v : v).toString().padStart(s + 1, '0');
  const int = abs.slice(0, abs.length - s);
  const frac = abs.slice(abs.length - s);
  const body = s > 0 ? `${int}.${frac}` : int;
  return neg && v !== 0n ? `-${body}` : body;
}

export function decAdd(a: string, b: string): string {
  const { av, bv, s } = align(parseDec(a), parseDec(b));
  return format(av + bv, s);
}

export function decSub(a: string, b: string): string {
  const { av, bv, s } = align(parseDec(a), parseDec(b));
  return format(av - bv, s);
}

export function decCmp(a: string, b: string): -1 | 0 | 1 {
  const { av, bv } = align(parseDec(a), parseDec(b));
  if (av < bv) return -1;
  if (av > bv) return 1;
  return 0;
}

/** Умножение на целое (пороги: spent > 85% × limit ⇔ 20·spent > 17·limit). */
export function decMulInt(a: string, n: number): string {
  if (!Number.isSafeInteger(n)) throw new RangeError(`не целое: ${n}`);
  const d = parseDec(a);
  const s = Math.max(d.s, 2);
  return format(rescale(d, s) * BigInt(n), s);
}

/**
 * Деление на положительное целое (дни до конца периода, §2.4): результат —
 * РОВНО 2 знака, округление half-away-from-zero (бриф A6).
 */
export function decDivBy(a: string, n: number): string {
  if (!Number.isSafeInteger(n) || n <= 0) throw new RangeError(`делитель не натуральное: ${n}`);
  const d = parseDec(a);
  // r = round(v / (10^s · n) · 100) на BigInt: num/den + half-away-from-zero по остатку
  const num = d.v * 100n;
  const den = 10n ** BigInt(d.s) * BigInt(n);
  let q = num / den;
  const r = num % den;
  const rAbs = r < 0n ? -r : r;
  if (rAbs * 2n >= den) q += num < 0n ? -1n : 1n;
  return format(q, 2);
}
