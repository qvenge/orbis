// Task C4a (03-budget §3.4 шаг 1): локальный парсинг CSV-выписки. Файл целиком не
// покидает браузер — байты декодируются, разбираются и нормализуются здесь, на сервер
// уходят только канонические строки и sha256 байтов файла.
//
// Модуль чистый и DOM-независимый: никакого React/fetch/tRPC/FileReader — на входе
// уже ArrayBuffer (чтение File — задача ImportFlow, C4b), поэтому он тестируется без
// браузера. Деньги на всём пути — только decimal-строки (никаких parseFloat/Number),
// даты разбираются по позициям формата (никаких new Date(str)/Date.parse: V8 молча
// превращает 2026-02-30 во 2 марта — грабля 01-phase0-findings).
import { type CanonicalRow, type CsvMapping, canonicalRowSchema } from '@orbis/shared';

/**
 * Декодирование байтов файла в текст. Кандидатов ровно два (UTF-8 и windows-1251),
 * поэтому порог «доли U+FFFD» не нужен и вреден: валидный UTF-8 не даёт U+FFFD вовсе,
 * а банковская выписка не содержит литеральный символ замены — при двух кандидатах
 * любой порог выше нуля был бы только способом ошибиться.
 *
 * Платформенные API получают Uint8Array-view, а не голый ArrayBuffer: спека принимает
 * любой BufferSource, но в тестовом окружении (vitest jsdom + Bun) ArrayBuffer из
 * чужого realm не проходит brand-check нативных реализаций — view проходит всегда.
 */
export function decodeCsvBytes(bytes: ArrayBuffer): {
  text: string;
  encoding: 'utf-8' | 'windows-1251';
} {
  const u8 = new Uint8Array(bytes);
  // BOM EF BB BF → файл заведомо UTF-8, независимо от валидности остальных байтов
  if (u8.length >= 3 && u8[0] === 0xef && u8[1] === 0xbb && u8[2] === 0xbf) {
    return { text: new TextDecoder('utf-8').decode(u8.subarray(3)), encoding: 'utf-8' };
  }
  const utf8Text = new TextDecoder('utf-8').decode(u8);
  if (utf8Text.includes('�')) {
    return { text: new TextDecoder('windows-1251').decode(u8), encoding: 'windows-1251' };
  }
  return { text: utf8Text, encoding: 'utf-8' };
}

const DELIMITER_CANDIDATES: ReadonlyArray<',' | ';' | '\t'> = [',', ';', '\t'];

/**
 * Выбор разделителя по до-5 первым непустым строкам. Оценка кандидата — МИНИМУМ числа
 * полей по выборке: у настоящего разделителя число колонок стабильно, а случайные
 * запятые в суммах дают много полей в одной строке и одно — в другой. Поля считаются
 * тем же parseCsv, а не split: разделитель внутри кавычек не должен портить счёт.
 * Побеждает максимальная оценка; при равенстве — более ранний кандидат; если у всех
 * оценка ≤ 1 (разделителя нет вовсе) — «,».
 */
export function detectDelimiter(text: string): ',' | ';' | '\t' {
  const sample = text
    .split(/\r\n|\r|\n/)
    .filter((line) => line.trim() !== '')
    .slice(0, 5)
    .join('\n');
  let best: ',' | ';' | '\t' = ',';
  let bestScore = 1;
  for (const candidate of DELIMITER_CANDIDATES) {
    const parsed = parseCsv(sample, candidate);
    if (parsed.length === 0) continue;
    let score = Number.POSITIVE_INFINITY;
    for (const row of parsed) score = Math.min(score, row.length);
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}

/**
 * RFC 4180 с поправкой на реальность банковских выгрузок:
 * - поле в кавычках может содержать разделитель, переводы строк и удвоенную кавычку "";
 * - кавычка НЕ в начале поля — обычный символ, а не ошибка разбора;
 * - `\n`, `\r\n` и одиночный `\r` завершают строку; хвостовой перевод строки и пустые
 *   строки файла записей не порождают;
 * - ничего не тримится — нормализация значений принадлежит toCanonicalRows.
 */
export function parseCsv(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let fields: string[] = [];
  let field = '';
  let inQuotes = false;
  // отличает «в записи уже что-то было» от пустой строки файла: пустые строки записей
  // не порождают, а вот "" (одно пустое закавыченное поле) — порождает
  let recordStarted = false;

  const endField = (): void => {
    fields.push(field);
    field = '';
  };
  const endRecord = (): void => {
    endField();
    rows.push(fields);
    fields = [];
    recordStarted = false;
  };

  let i = 0;
  while (i < text.length) {
    const ch = text.charAt(i);
    if (inQuotes) {
      if (ch === '"') {
        if (text.charAt(i + 1) === '"') {
          field += '"'; // удвоенная кавычка — экран
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch; // разделители и переводы строк внутри кавычек — обычные символы
      i += 1;
      continue;
    }
    if (ch === '"' && field === '') {
      inQuotes = true; // кавычка в начале поля открывает закавыченный режим
      recordStarted = true;
      i += 1;
      continue;
    }
    if (ch === delimiter) {
      endField();
      recordStarted = true;
      i += 1;
      continue;
    }
    if (ch === '\n' || ch === '\r') {
      if (recordStarted) endRecord();
      i += ch === '\r' && text.charAt(i + 1) === '\n' ? 2 : 1;
      continue;
    }
    field += ch;
    recordStarted = true;
    i += 1;
  }
  // хвост без завершающего перевода строки; незакрытая кавычка принимается как есть
  if (recordStarted) endRecord();
  return rows;
}

interface ParsedMoney {
  /** Положительная decimal-строка с ровно двумя знаками дробной части. */
  abs: string;
  negative: boolean;
  isZero: boolean;
}

/**
 * Нормализация суммы БЕЗ float-пути: убрать пробельные (JS `\s` покрывает и NBSP
 * U+00A0, и узкий пробел U+202F), скобочную запись минуса `(1 890,00)`, символы валют
 * и буквы; десятичный разделитель:
 * - есть и `,` и `.` → десятичный тот, что ПОСЛЕДНИЙ, второй — разряды;
 * - один вид, встречается один раз → десятичный (поведение budget/moneyInput.ts);
 * - один вид, несколько раз → все разрядные;
 * - ни одного → целое.
 * Дробная часть добивается/усекается до ровно 2 знаков. null — ячейка не сумма.
 */
function parseMoney(cell: string): ParsedMoney | null {
  let s = cell.replace(/\s+/gu, '');
  if (s === '') return null;
  let negative = false;
  const parenthesized = /^\((.*)\)$/.exec(s);
  if (parenthesized) {
    negative = true;
    s = parenthesized[1] ?? '';
  }
  s = s.replace(/[\p{L}\p{Sc}]/gu, '');
  if (s.startsWith('-')) {
    negative = true;
    s = s.slice(1);
  } else if (s.startsWith('+')) {
    s = s.slice(1);
  }
  // хвостовые разделители — остаток «р.» после снятия букв или висячая точка «1890.»
  s = s.replace(/[.,]+$/, '');
  if (!/^[0-9.,]+$/.test(s) || !/[0-9]/.test(s)) return null;

  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  let intPart: string;
  let fracPart: string;
  if (lastComma !== -1 && lastDot !== -1) {
    const decimal = lastComma > lastDot ? ',' : '.';
    const grouping = decimal === ',' ? '.' : ',';
    const cleaned = s.split(grouping).join('');
    const at = cleaned.indexOf(decimal);
    if (at !== cleaned.lastIndexOf(decimal)) return null; // «1,2,3.4,5» — не сумма
    intPart = cleaned.slice(0, at);
    fracPart = cleaned.slice(at + 1);
  } else if (lastComma !== -1 || lastDot !== -1) {
    const sep = lastComma !== -1 ? ',' : '.';
    const first = s.indexOf(sep);
    if (first === s.lastIndexOf(sep)) {
      intPart = s.slice(0, first);
      fracPart = s.slice(first + 1);
    } else {
      intPart = s.split(sep).join('');
      fracPart = '';
    }
  } else {
    intPart = s;
    fracPart = '';
  }
  const int = (intPart === '' ? '0' : intPart).replace(/^0+(?=\d)/, '');
  const frac = `${fracPart}00`.slice(0, 2);
  const abs = `${int}.${frac}`;
  return { abs, negative, isZero: abs === '0.00' };
}

const DATE_FORMATS: Record<
  CsvMapping['dateFormat'],
  { re: RegExp; y: number; m: number; d: number }
> = {
  'DD.MM.YYYY': { re: /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/, d: 1, m: 2, y: 3 },
  'YYYY-MM-DD': { re: /^(\d{4})-(\d{1,2})-(\d{1,2})$/, y: 1, m: 2, d: 3 },
  'MM/DD/YYYY': { re: /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/, m: 1, d: 2, y: 3 },
  'DD/MM/YYYY': { re: /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/, d: 1, m: 2, y: 3 },
};

/**
 * Разбор даты по позициям формата → 'YYYY-MM-DD'. Календарную валидность (31.02)
 * проверяет canonicalRowSchema (refine поверх toParts) на финальной проверке строки —
 * здесь только структура и порядок день/месяц/год.
 */
function parseDateToIso(cell: string, format: CsvMapping['dateFormat']): string | null {
  const spec = DATE_FORMATS[format];
  const match = spec.re.exec(cell.trim());
  if (match === null) return null;
  const year = match[spec.y] ?? '';
  const month = (match[spec.m] ?? '').padStart(2, '0');
  const day = (match[spec.d] ?? '').padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Маппинг разобранных ячеек в CanonicalRow. Ошибочные строки (неразбираемая дата или
 * сумма, ноль, конфликт дебет/кредит, колонка за границами) попадают в errors и не
 * попадают в rows — исключений нет: пользователь должен увидеть, какие строки выпали.
 * rowIndex — ноль-базовый индекс в переданном dataRows (заголовок отрезает вызывающий),
 * он входит в контракт external_id (§3.4.1: zero_based_row_index).
 */
export function toCanonicalRows(
  dataRows: string[][],
  mapping: CsvMapping,
): { rows: CanonicalRow[]; errors: Array<{ rowIndex: number; reason: string }> } {
  const rows: CanonicalRow[] = [];
  const errors: Array<{ rowIndex: number; reason: string }> = [];

  for (const [rowIndex, cells] of dataRows.entries()) {
    const fail = (reason: string): void => {
      errors.push({ rowIndex, reason });
    };

    const usedColumns: number[] = [mapping.date, mapping.counterparty];
    if (mapping.direction === 'sign' && mapping.amount !== undefined) {
      usedColumns.push(mapping.amount);
    }
    if (mapping.direction === 'separate_columns') {
      if (mapping.debit !== undefined) usedColumns.push(mapping.debit);
      if (mapping.credit !== undefined) usedColumns.push(mapping.credit);
    }
    if (mapping.bankTxnId !== undefined) usedColumns.push(mapping.bankTxnId);
    const outOfBounds = usedColumns.filter((column) => column >= cells.length);
    if (outOfBounds.length > 0) {
      fail(`колонка ${outOfBounds.join(', ')} за границами строки из ${cells.length} ячеек`);
      continue;
    }

    const dateCell = cells[mapping.date] ?? '';
    const occurredOn = parseDateToIso(dateCell, mapping.dateFormat);
    if (occurredOn === null) {
      fail(`не разобрана дата «${dateCell}» (формат ${mapping.dateFormat})`);
      continue;
    }

    let amount: string;
    let direction: 'income' | 'expense';
    if (mapping.direction === 'sign') {
      // csvMappingSchema гарантирует amount при direction=sign; проверка — для типов
      if (mapping.amount === undefined) {
        fail('маппинг direction=sign без колонки amount');
        continue;
      }
      const cell = cells[mapping.amount] ?? '';
      const money = parseMoney(cell);
      if (money === null) {
        fail(`не разобрана сумма «${cell}»`);
        continue;
      }
      if (money.isZero) {
        fail(`нулевая сумма «${cell}»`);
        continue;
      }
      amount = money.abs; // знак живёт в direction, сумма всегда положительная (§3.3)
      direction = money.negative ? 'expense' : 'income';
    } else {
      if (mapping.debit === undefined || mapping.credit === undefined) {
        fail('маппинг direction=separate_columns без колонок debit/credit');
        continue;
      }
      const debitCell = cells[mapping.debit] ?? '';
      const creditCell = cells[mapping.credit] ?? '';
      const debit = debitCell.trim() === '' ? null : parseMoney(debitCell);
      if (debitCell.trim() !== '' && debit === null) {
        fail(`не разобрана сумма дебета «${debitCell}»`);
        continue;
      }
      const credit = creditCell.trim() === '' ? null : parseMoney(creditCell);
      if (creditCell.trim() !== '' && credit === null) {
        fail(`не разобрана сумма кредита «${creditCell}»`);
        continue;
      }
      // знак ячейки игнорируется: направление определяет сама колонка;
      // нулевое значение равносильно пустой ячейке
      const debitValue = debit !== null && !debit.isZero ? debit.abs : null;
      const creditValue = credit !== null && !credit.isZero ? credit.abs : null;
      if (debitValue !== null && creditValue !== null) {
        fail('конфликт: заполнены и дебет, и кредит');
        continue;
      }
      if (debitValue !== null) {
        amount = debitValue;
        direction = 'expense';
      } else if (creditValue !== null) {
        amount = creditValue;
        direction = 'income';
      } else {
        fail('пустые (или нулевые) дебет и кредит');
        continue;
      }
    }

    // bankTxnId входит в external_id: случайные пробелы банка не должны менять id,
    // поэтому значение хранится в trim, а пустое/пробельное не ставит ключ вовсе
    let bankTxnId: string | undefined;
    if (mapping.bankTxnId !== undefined) {
      const trimmed = (cells[mapping.bankTxnId] ?? '').trim();
      if (trimmed !== '') bankTxnId = trimmed;
    }

    const candidate: CanonicalRow = {
      occurredOn,
      amount,
      direction,
      // как есть: normalizeCounterparty — этап дедупа, здесь она сломала бы таблицу ревью
      counterparty: cells[mapping.counterparty] ?? '',
      // raw — только для отображения, в external_id не входит (проверено C1); разделитель
      // склейки поэтому — константа ';', а не фактический разделитель файла
      raw: cells.join(';'),
      rowIndex,
      ...(bankTxnId === undefined ? {} : { bankTxnId }),
    };

    // финальная граница: строка, не прошедшая canonicalRowSchema (в т.ч. календарную
    // валидность 31.02 через refine поверх toParts), уходит в errors, а не на сервер
    const checked = canonicalRowSchema.safeParse(candidate);
    if (!checked.success) {
      fail(checked.error.issues.map((issue) => issue.message).join('; '));
      continue;
    }
    rows.push(checked.data);
  }

  return { rows, errors };
}

/**
 * sha256 по БАЙТАМ файла (не по декодированному тексту: byte-identical файл обязан
 * давать тот же хэш независимо от кодировки) → нижний hex, формат fileHashSchema
 * `/^[0-9a-f]{64}$/`. Вход externalRowId (C1) и import.review/confirm (C2).
 */
export async function fileHashHex(bytes: ArrayBuffer): Promise<string> {
  // Uint8Array-view вместо голого ArrayBuffer — см. комментарий в decodeCsvBytes
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
