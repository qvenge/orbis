// Дедуп-критерий CSV-импорта и external_id — byte-точный контракт 03-budget §3.4.1.
// Изоморфный модуль: детерминированные чистые функции + WebCrypto (Bun и браузер),
// без файловой системы, сети и платформенных API. Сервер (ревью импорта) и web
// (вычисление external_id) обязаны получать одинаковые байты.

import { epochDays, toParts } from '../date';

export const DUP_SIMILARITY_THRESHOLD = 0.85;
export const SERVICE_TOKENS = ['sbol', 'payment', 'card', 'purchase', 'oplata'] as const;

/** Каноническая строка выписки после маппинга колонок. */
export interface CanonicalRow {
  occurredOn: string;
  amount: string;
  direction: 'income' | 'expense';
  counterparty: string;
  bankTxnId?: string;
  raw: string;
  rowIndex: number;
}

/**
 * NFKC → lowercase → ё→е → пунктуация/символы (\p{P}, \p{S}) → пробелы → схлопнуть
 * пробелы → срезать ведущие SERVICE_TOKENS (повторно, пока первый токен матчится).
 * Пиннящая фикстура: «SBOL ПЯТЁРОЧКА 1234» → «пятерочка 1234».
 */
export function normalizeCounterparty(s: string): string {
  const cleaned = s
    .normalize('NFKC')
    .toLowerCase()
    .replaceAll('ё', 'е')
    .replace(/[\p{P}\p{S}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const tokens = cleaned === '' ? [] : cleaned.split(' ');
  while (tokens.length > 0 && (SERVICE_TOKENS as readonly string[]).includes(tokens[0] ?? '')) {
    tokens.shift();
  }
  return tokens.join(' ');
}

/** Левенштейн O(n·m) на двух строках буфера — строки counterparty короткие. */
function levenshtein(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  let curr = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min((curr[j - 1] ?? 0) + 1, (prev[j] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length] ?? 0;
}

/**
 * max(1 − levenshtein/maxLen, tokenJaccard, tokenContainment) на нормализованных строках,
 * где tokenContainment = |A∩B| / min(|A|,|B|). Третий член добавлен sign-off'ом владельца
 * 2026-07-25: без него банковский шум в имени мерчанта («ПЯТЕРОЧКА 843» против ручного
 * «Пятёрочка») даёт 0.69/0.50 — ниже порога, и фикстура §3.4.1 не выполнялась. Известный
 * класс ложных срабатываний (имя-подмножество: «OZON» ↔ «OZON TRAVEL») принят: ограничен
 * точной суммой + направлением + датой ±1 день и переключаем пользователем в ревью.
 */
export function counterpartySimilarity(a: string, b: string): number {
  const na = normalizeCounterparty(a);
  const nb = normalizeCounterparty(b);
  if (na === nb) return 1; // включая обе пустые
  if (na === '' || nb === '') return 0;

  const lev = 1 - levenshtein(na, nb) / Math.max(na.length, nb.length);

  const ta = new Set(na.split(' '));
  const tb = new Set(nb.split(' '));
  const intersection = [...ta].filter((t) => tb.has(t)).length;
  const union = new Set([...ta, ...tb]).size;
  const jaccard = union === 0 ? 0 : intersection / union;
  const minSize = Math.min(ta.size, tb.size);
  const containment = minSize === 0 ? 0 : intersection / minSize;

  return Math.max(lev, jaccard, containment);
}

/**
 * Равенство decimal-строк БЕЗ parseFloat/Number (деньги — только строки): целая часть
 * без ведущих нулей + дробная часть, добитая нулями до общей длины.
 * "340", "340.0", "340.00" — одно значение.
 */
function sameDecimal(a: string, b: string): boolean {
  const [intA = '', fracA = ''] = a.split('.');
  const [intB = '', fracB = ''] = b.split('.');
  const normInt = (s: string): string => s.replace(/^0+(?=\d)/, '');
  const width = Math.max(fracA.length, fracB.length);
  return normInt(intA) === normInt(intB) && fracA.padEnd(width, '0') === fracB.padEnd(width, '0');
}

/**
 * Вероятный дубль по §3.4.1: amount+direction точно; |occurred_on разница| ≤ 1 день;
 * counterparty-similarity ≥ порога ИЛИ совпал bankTxnId (оба непустые и равны —
 * положительное перекрытие; разные bankTxnId НЕ дисквалифицируют — падаем на текст).
 * Валюта в критерий не входит: у CanonicalRow поля currency нет.
 */
export function isProbableDuplicate(
  row: CanonicalRow,
  candidate: {
    amount: string;
    direction: string;
    occurredOn: string;
    title: string;
    counterparty?: string;
    bankTxnId?: string;
  },
): boolean {
  if (!sameDecimal(row.amount, candidate.amount)) return false;
  if (row.direction !== candidate.direction) return false;
  const dayDiff = Math.abs(
    epochDays(toParts(row.occurredOn)) - epochDays(toParts(candidate.occurredOn)),
  );
  if (dayDiff > 1) return false;

  const bankIdMatch =
    row.bankTxnId !== undefined &&
    row.bankTxnId !== '' &&
    candidate.bankTxnId !== undefined &&
    candidate.bankTxnId !== '' &&
    row.bankTxnId === candidate.bankTxnId;
  if (bankIdMatch) return true;

  const candidateText = candidate.counterparty ?? candidate.title;
  return counterpartySimilarity(row.counterparty, candidateText) >= DUP_SIMILARITY_THRESHOLD;
}

/** Нижний hex sha256 через WebCrypto (есть и в Bun, и в браузере). */
async function sha256hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * external_id = sha256hex(fileHashHex + ":" + rowIndex + ":" + normalizedRow), где
 * normalizedRow = JSON.stringify([occurredOn, amount, direction,
 * normalizeCounterparty(counterparty), bankTxnId ?? null]). fileHashHex — sha256hex
 * байтов файла (считает клиент). amount берётся КАК ЕСТЬ (без decimal-канонизации):
 * повтор byte-identical файла обязан дать те же id (§3.4.1). rowIndex — zero-based.
 */
export async function externalRowId(fileHashHex: string, row: CanonicalRow): Promise<string> {
  const normalizedRow = JSON.stringify([
    row.occurredOn,
    row.amount,
    row.direction,
    normalizeCounterparty(row.counterparty),
    row.bankTxnId ?? null,
  ]);
  return sha256hex(`${fileHashHex}:${row.rowIndex}:${normalizedRow}`);
}
