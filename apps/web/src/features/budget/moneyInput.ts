// Ввод денежных сумм (03-budget §3.5/§3.6): общая валидация и нормализация
// decimal-строк для QuickAddBar и RolloverScreen — деньги никогда не проходят
// через float (Global Constraints).

/**
 * Сумма: целые/десятичные до 2 знаков, запятая = точка. Строгая граница —
 * «12.345» невалиден, а не молча обрезается до «12.34» (тихая потеря копеек запрещена).
 */
export const AMOUNT_RE = /^\d+([.,]\d{1,2})?$/;

/** "340" → "340.00", "12,5" → "12.50" — decimal-строка с двумя знаками (как fast-path §7.5). */
export function toDecimal2(raw: string): string {
  const [i, f = ''] = raw.replace(',', '.').split('.');
  return `${i}.${`${f}00`.slice(0, 2)}`;
}
