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
 * Логические записи файла: перевод строки ВНУТРИ закавыченного поля границей записи не
 * считается (уборочная фаза, E10). Раньше выборка для detectDelimiter резалась по
 * физическим строкам, и назначение платежа с переносом строки — обычное дело в выгрузках —
 * могло быть обрезано посередине, оставив в образце незакрытую кавычку. Состояние кавычек
 * ровно то же, что у parseCsv: удвоенная «""» — экран, кавычка не в начале поля обычная.
 * Пустые записи пропускаются (как и раньше). limit ограничивает работу на больших файлах.
 */
function logicalRecords(text: string, limit: number): string[] {
  const out: string[] = [];
  let start = 0;
  let inQuotes = false;
  let fieldStart = true; // курсор стоит в начале поля — только здесь кавычка открывает режим
  const push = (end: number): void => {
    const rec = text.slice(start, end);
    if (rec.trim() !== '') out.push(rec);
  };
  let i = 0;
  while (i < text.length && out.length < limit) {
    const ch = text.charAt(i);
    if (inQuotes) {
      if (ch === '"') {
        if (text.charAt(i + 1) === '"') {
          i += 2;
          continue;
        }
        inQuotes = false;
      }
      i += 1;
      continue;
    }
    if (ch === '"' && fieldStart) {
      inQuotes = true;
      fieldStart = false;
      i += 1;
      continue;
    }
    if (ch === '\n' || ch === '\r') {
      push(i);
      i += ch === '\r' && text.charAt(i + 1) === '\n' ? 2 : 1;
      start = i;
      fieldStart = true;
      continue;
    }
    fieldStart = DELIMITER_CANDIDATES.includes(ch as ',' | ';' | '\t');
    i += 1;
  }
  if (out.length < limit) push(text.length);
  return out;
}

/** Число полей записи при данном кандидате (тем же parseCsv, а не split). */
function fieldCount(record: string, candidate: string): number {
  return parseCsv(record, candidate)[0]?.length ?? 1;
}

/**
 * Выбор разделителя по до-5 первым записям таблицы. Оценка кандидата — МИНИМУМ числа
 * полей по выборке: у настоящего разделителя число колонок стабильно, а случайные
 * запятые в суммах дают много полей в одной строке и одно — в другой. Поля считаются
 * тем же parseCsv, а не split: разделитель внутри кавычек не должен портить счёт.
 * Побеждает максимальная оценка; при равенстве — более ранний кандидат; если у всех
 * оценка ≤ 1 (разделителя нет вовсе) — «,».
 *
 * Записи БЕЗ единого кандидата-разделителя вне кавычек в выборку не входят (E10):
 * это преамбула выписки («Выписка по счёту 40817…») или итоговая строка, а не таблица.
 * Раньше такая строка давала МИНИМУМ 1 любому кандидату и обнуляла оценку целиком —
 * побеждал дефолт «,», и «;»-файл разбирался в одну колонку. Условие «одно поле при
 * ЛЮБОМ кандидате» намеренно узкое: настоящая шапка «Дата;Контрагент;Сумма» даёт одно
 * поле только для «,» и обязана продолжать топить этот кандидат.
 */
export function detectDelimiter(text: string): ',' | ';' | '\t' {
  // Записей берём с запасом: часть отсеется как преамбула, а выборка обязана остаться
  // представительной (5 строк таблицы — исходный контракт).
  const records = logicalRecords(text, 12).filter((rec) =>
    DELIMITER_CANDIDATES.some((c) => fieldCount(rec, c) > 1),
  );
  const sample = records.slice(0, 5);
  let best: ',' | ';' | '\t' = ',';
  let bestScore = 1;
  for (const candidate of DELIMITER_CANDIDATES) {
    if (sample.length === 0) break;
    let score = Number.POSITIVE_INFINITY;
    for (const rec of sample) score = Math.min(score, fieldCount(rec, candidate));
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

/**
 * Инкремент неотрицательного целого, записанного строкой цифр (ручной перенос):
 * '999' → '1000'. Никакого Number — 01-arch §3.3 запрещает IEEE-754 на суммах, а
 * длинная выписка может нести числа за пределами безопасного целого.
 */
function incrementDigits(digits: string): string {
  const out = digits.split('');
  let i = out.length - 1;
  while (i >= 0) {
    const d = (out[i] as string).charCodeAt(0) - 48;
    if (d < 9) {
      out[i] = String.fromCharCode(48 + d + 1);
      return out.join('');
    }
    out[i] = '0';
    i -= 1;
  }
  return `1${out.join('')}`;
}

/**
 * Округление до 2 знаков half-away-from-zero (01-arch §3.3 — предписано ИМЕННО на
 * границе ввода/импорта, а она здесь) строковой арифметикой: третий знак ≥ 5 →
 * инкремент двух первых с переносом в целую часть. `1.235` → `1.24`, `9.999` → `10.00`.
 * Знак живёт отдельно (direction), поэтому away-from-zero = «вверх» по модулю.
 */
function roundTo2(intPart: string, fracPart: string): { int: string; frac: string } {
  if (fracPart.length <= 2) return { int: intPart, frac: `${fracPart}00`.slice(0, 2) };
  const head = fracPart.slice(0, 2);
  if (fracPart.charCodeAt(2) - 48 < 5) return { int: intPart, frac: head };
  const bumped = incrementDigits(`${intPart}${head}`);
  return { int: bumped.slice(0, bumped.length - 2), frac: bumped.slice(-2) };
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
 * Дробная часть приводится к ровно 2 знакам: короткая добивается нулями, длинная
 * ОКРУГЛЯЕТСЯ half-away-from-zero (roundTo2, §3.3), а не усекается. null — не сумма.
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
  const normalizedInt = (intPart === '' ? '0' : intPart).replace(/^0+(?=\d)/, '');
  // третий знак не отбрасывается, а округляется half-away-from-zero (§3.3)
  const { int, frac } = roundTo2(normalizedInt, fracPart);
  const abs = `${int.replace(/^0+(?=\d)/, '')}.${frac}`;
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
  delimiter = ';',
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
      // raw — только для отображения, в external_id не входит (проверено C1); склейка —
      // фактическим разделителем файла (дефолт ';' сохраняет прежние вызовы без него)
      raw: cells.join(delimiter),
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
