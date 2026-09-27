// Точный процент по decimal-строкам — общий помощник ядра и расширений (спека 1б §8.4: «общие
// помощники, которые ядро сегодня берёт из каталога Бюджета, переезжают в общий код»).
//
// Жил в карточке конверта (`features/budget/EnvelopeCard.tsx`), и полоса прогресса цели брала его
// оттуда: карточка Целей тянула каталог Финансов. Порог подсветки конверта (`envelopeLevel`) — дело
// Бюджета и остался там; здесь только то, чем пользуются обе стороны.

/** Decimal-строка → BigInt в масштабе scale знаков после точки (без потерь). */
export function scaledBigInt(dec: string, scale: number): bigint {
  // Знак — ASCII '-' И типографский U+2212 (formatMoney/бейджи печатают U+2212, §3.3):
  // strip-regex и neg обязаны распознавать один и тот же набор, иначе '−800' → +800.
  const neg = dec.startsWith('-') || dec.startsWith('−');
  const [int = '0', frac = ''] = dec.replace(/^[-−+]/, '').split('.');
  const digits = `${int}${frac.padEnd(scale, '0').slice(0, scale)}`;
  const v = BigInt(digits === '' ? '0' : digits);
  return neg ? -v : v;
}

/** Пара decimal-строк в общем целочисленном масштабе — для точных сравнений. */
export function scaledPair(a: string, b: string): [bigint, bigint] {
  const scale = Math.max((a.split('.')[1] ?? '').length, (b.split('.')[1] ?? '').length);
  return [scaledBigInt(a, scale), scaledBigInt(b, scale)];
}

/**
 * Целый процент part/whole (floor) — подпись полосы; вырожденное целое → 0/100. Без чисел с
 * плавающей точкой: `0.29*100` в IEEE-754 — `28.999999999999996`, то есть «28%».
 */
export function decimalPercent(part: string, whole: string): number {
  const [num, den] = scaledPair(part, whole);
  if (den <= 0n) return num > 0n || den < 0n ? 100 : 0;
  if (num <= 0n) return 0;
  return Number((num * 100n) / den);
}
