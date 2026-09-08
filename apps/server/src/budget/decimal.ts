// apps/server/src/budget/decimal.ts
// Точная decimal-арифметика формул Budget (03-budget §2.4) поверх строк:
// BigInt на выровненном масштабе, никакого parseFloat/IEEE-754 (глобальное
// ограничение «деньги — только decimal-строки», 01-arch §3.3). Суммы НАБОРОВ
// считает SQL (::numeric) — здесь только формулы поверх готовых строк:
// effectiveLimit/remaining (add/sub), пороги (cmp/mulInt/mul), dailyPace
// (divBy/div: масштаб задан, half-away-from-zero — бриф A6).
// Родом из Budget, но это ЕДИНСТВЕННАЯ точная decimal-арифметика сервера: прогресс
// цели (goals/progress.ts, §11.3) считает свою долю здесь же (decRatio), а не заводит
// второй разбор decimal-строк.

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
 * Умножение decimal×decimal — ТОЧНОЕ: масштаб результата равен сумме масштабов (но не меньше
 * канонических двух знаков `format`), округления нет вовсе.
 *
 * Округлять здесь нельзя, и это не вкус. Порог тревоги §6.1 — «spent ≥ 85 % лимита, граница
 * ВКЛЮЧИТЕЛЬНО» (sign-off владельца 2026-07-23), и сегодня он написан целыми: 20·spent ≥ 17·limit
 * (`aggregates.ts:390-392`). Декларация подписки §Б5-4 пишет тот же порог литералом `{const:"0.85"}`
 * (ревизия 3: decimal-литералы E — строки), то есть проходит через это умножение. Результат,
 * округлённый до двух знаков, сдвинул бы вердикт на конверте с копеечным лимитом:
 * 0.85 · 100.01 = 85.0085, а округлённое — 85.01, и spent = 85.01 из «не тревога» стал бы «тревога».
 */
export function decMul(a: string, b: string): string {
  const x = parseDec(a);
  const y = parseDec(b);
  const exact = x.s + y.s;
  const s = Math.max(exact, 2);
  return format(x.v * y.v * 10n ** BigInt(s - exact), s);
}

/** Знаков после точки, на которых считается доля decRatio: 1e-6 хватит любой полосе. */
const RATIO_SCALE = 6n;

/**
 * Доля `a / b` числом — для прогресс-бара цели (01 §11.3, E2). Оба аргумента остаются
 * decimal-строками: деление точное, на BigInt при масштабе RATIO_SCALE, и IEEE-754
 * появляется РОВНО один раз, последним шагом, из уже посчитанного частного (глобальное
 * ограничение §3.3 — `parseFloat` по деньгам запрещён). Не decDivBy: тот делит на
 * НАТУРАЛЬНОЕ ЧИСЛО и отдаёт строку, а здесь делитель — decimal-строка ('300000.00').
 *
 * Делитель обязан быть ненулевым (у цели это гарантирует positiveDecimal схемы);
 * ноль — RangeError, а не Infinity. Округление — half-away-from-zero, как у decDivBy.
 * Значения свыше ~9·10^9 теряют точность на последнем шаге (Number из BigInt) — для
 * доли, которую рисует полоса, это несущественно; а вот доля, не влезающая во float,
 * это уже RangeError, а не Infinity (см. клапан ниже).
 */
export function decRatio(a: string, b: string): number {
  const { av, bv } = align(parseDec(a), parseDec(b));
  if (bv === 0n) throw new RangeError(`деление на ноль: "${a}" / "${b}"`);
  const scale = 10n ** RATIO_SCALE;
  // Считаем по модулю, знак применяем один раз в конце: так правило округления
  // одно на оба знака, без развилок «в какую сторону от нуля».
  const negative = av < 0n !== bv < 0n;
  const num = (av < 0n ? -av : av) * scale;
  const den = bv < 0n ? -bv : bv;
  let q = num / den;
  if ((num % den) * 2n >= den) q += 1n;
  const ratio = (negative ? -Number(q) : Number(q)) / Number(scale);
  // Длина decimal-строки ничем не ограничена, поэтому BigInt может не влезть во float:
  // Infinity отдавать НЕЛЬЗЯ — в JSON его нет, и на клиент по tRPC (трансформера у нас
  // нет) уехало бы `null` в поле, объявленном как number. Пусть лучше вызывающий
  // поймает RangeError и честно скажет «не посчиталось», чем контракт соврёт.
  if (!Number.isFinite(ratio)) throw new RangeError(`доля не представима числом: "${a}" / "${b}"`);
  return ratio;
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

/**
 * Деление decimal÷decimal с ЗАДАННЫМ масштабом (по умолчанию два знака), округление
 * half-away-from-zero — то же правило, что у `decDivBy` и `decRatio`.
 *
 * Зачем рядом с `decDivBy`: тот делит на НАТУРАЛЬНОЕ ЧИСЛО, а `daily_pace` §Б5-4 пишется в языке E
 * как `remaining / days_inclusive($today, period_end)`, и бэкенд формул (`expr/eval.ts`) не знает
 * заранее, что пришло справа — число дней или decimal-величина ведомости. На натуральном делителе
 * результат СОВПАДАЕТ с `decDivBy` (пин в `decimal.test.ts`): второй семантики деления не заводится.
 */
export function decDiv(a: string, b: string, scale = 2): string {
  if (!Number.isSafeInteger(scale) || scale < 0)
    throw new RangeError(`масштаб не целое ≥ 0: ${scale}`);
  const x = parseDec(a);
  const y = parseDec(b);
  if (y.v === 0n) throw new RangeError(`деление на ноль: "${a}" / "${b}"`);
  // q = round(a/b · 10^scale) на BigInt: домножение уносит оба масштаба, дробь не появляется.
  const num = x.v * 10n ** BigInt(y.s + scale);
  const den = y.v * 10n ** BigInt(x.s);
  // Знак применяется один раз в конце — правило `decRatio` (:114-116): округление «от нуля» обязано
  // быть симметричным, иначе плюс и минус округляются по-разному.
  const negative = num < 0n !== den < 0n;
  const n = num < 0n ? -num : num;
  const d = den < 0n ? -den : den;
  let q = n / d;
  if ((n % d) * 2n >= d) q += 1n;
  return format(negative ? -q : q, scale);
}
