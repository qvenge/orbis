// Task C4a (03-budget §3.4 шаг 1): локальный парсинг CSV-выписки — файл целиком не
// покидает браузер. Тесты покрывают: декодирование UTF-8/win-1251 (байтовые фикстуры),
// выбор разделителя по согласованности колонок, RFC 4180-кавычки, нормализацию дат
// по позициям (без new Date) и денег как decimal-строк (без parseFloat), раздельные
// дебет/кредит и sha256-хэш байтов файла.
//
// Байтовые фикстуры и sha256-эталоны посчитаны НЕЗАВИСИМО от реализации:
// python3 hashlib / str.encode('cp1251') (см. комментарии у фикстур).
import type { CanonicalRow, CsvMapping } from '@orbis/shared';
import { expect, test } from 'vitest';
import {
  decodeCsvBytes,
  detectDelimiter,
  fileHashHex,
  parseCsv,
  toCanonicalRows,
} from './csv-parse';

/** ArrayBuffer из списка байтов — фикстуры задаются массивом байт, не строкой. */
function buf(...bytes: number[]): ArrayBuffer {
  return new Uint8Array(bytes).buffer;
}

/** ArrayBuffer из UTF-8 строки (для фикстур, где кодировка — заведомо UTF-8). */
function utf8(s: string): ArrayBuffer {
  const encoded = new TextEncoder().encode(s);
  return encoded.buffer.slice(0, encoded.byteLength) as ArrayBuffer;
}

/** Строгий доступ к строке результата: тест падает с внятной причиной, а не на undefined. */
function at(rows: CanonicalRow[], i: number): CanonicalRow {
  const row = rows[i];
  if (row === undefined) throw new Error(`в результате нет строки с индексом ${i}`);
  return row;
}

const signMapping: CsvMapping = {
  date: 0,
  counterparty: 1,
  direction: 'sign',
  amount: 2,
  dateFormat: 'DD.MM.YYYY',
};

// --- decodeCsvBytes ----------------------------------------------------------

test('decodeCsvBytes: валидный UTF-8 с кириллицей остаётся UTF-8 и не искажается', () => {
  const source = 'Дата;Контрагент;Сумма\n01.02.2026;Пятёрочка;-1 890,00';
  expect(decodeCsvBytes(utf8(source))).toEqual({ text: source, encoding: 'utf-8' });
});

test('decodeCsvBytes: BOM отрезается, кодировка — UTF-8', () => {
  const body = [...new TextEncoder().encode('Дата;Сумма')];
  const { text, encoding } = decodeCsvBytes(buf(0xef, 0xbb, 0xbf, ...body));
  expect(encoding).toBe('utf-8');
  expect(text).toBe('Дата;Сумма');
});

test('decodeCsvBytes: BOM побеждает даже при битых байтах — фолбэка в win-1251 нет', () => {
  // 0xC4 0xE0 после BOM — невалидный UTF-8: BOM делает файл заведомо UTF-8,
  // поэтому в тексте U+FFFD, а не перекодировка в win-1251.
  const { text, encoding } = decodeCsvBytes(buf(0xef, 0xbb, 0xbf, 0xc4, 0xe0));
  expect(encoding).toBe('utf-8');
  expect(text).toContain('�');
});

test('decodeCsvBytes: win-1251 байты (фикстура массивом байт) → windows-1251', () => {
  // python3: 'Дата;Сумма'.encode('cp1251')
  const bytes = buf(0xc4, 0xe0, 0xf2, 0xe0, 0x3b, 0xd1, 0xf3, 0xec, 0xec, 0xe0);
  expect(decodeCsvBytes(bytes)).toEqual({ text: 'Дата;Сумма', encoding: 'windows-1251' });
});

// --- detectDelimiter ---------------------------------------------------------

test('detectDelimiter: файл с запятыми → «,»', () => {
  expect(detectDelimiter('a,b,c\nd,e,f')).toBe(',');
});

test('detectDelimiter: «;»-файл с запятыми внутри закавыченных полей → «;»', () => {
  const text = [
    'Дата;Контрагент;Сумма',
    '01.02.2026;"Кафе, у дома";1 890,00',
    '02.02.2026;"ООО ""Ромашка, и точка""";-57,00',
  ].join('\n');
  expect(detectDelimiter(text)).toBe(';');
});

test('detectDelimiter: табуляция', () => {
  expect(detectDelimiter('Дата\tСумма\n01.02.2026\t100')).toBe('\t');
});

test('detectDelimiter: одна колонка без разделителей → «,» по умолчанию', () => {
  expect(detectDelimiter('строка один\nстрока два')).toBe(',');
});

test('detectDelimiter: при равном счёте побеждает более ранний кандидат («,»)', () => {
  expect(detectDelimiter('a,b;c\nd,e;f')).toBe(',');
});

test('detectDelimiter: оценка — минимум по строкам: непостоянные запятые проигрывают табам', () => {
  // в первой строке запятых больше, чем табов, но во второй их нет вовсе —
  // у настоящего разделителя число колонок стабильно
  expect(detectDelimiter('1 890,00\t2 340,50\nабв\tгде')).toBe('\t');
});

// --- parseCsv ----------------------------------------------------------------

test('parseCsv: базовый «;»-файл, пробелы вокруг значений сохраняются', () => {
  expect(parseCsv('a; b ;c\nd;e;f', ';')).toEqual([
    ['a', ' b ', 'c'],
    ['d', 'e', 'f'],
  ]);
});

test('parseCsv: поле в кавычках с разделителем И переводом строки внутри', () => {
  expect(parseCsv('"a;b\nc";d', ';')).toEqual([['a;b\nc', 'd']]);
});

test('parseCsv: удвоенная кавычка "" внутри кавычек — экран', () => {
  expect(parseCsv('"скажи ""привет""";x', ';')).toEqual([['скажи "привет"', 'x']]);
});

test('parseCsv: \\r\\n и одиночный \\r завершают строку; хвостовой перевод не даёт пустой строки', () => {
  expect(parseCsv('a,b\r\nc,d\re,f\n', ',')).toEqual([
    ['a', 'b'],
    ['c', 'd'],
    ['e', 'f'],
  ]);
});

test('parseCsv: кавычка НЕ в начале поля — обычный символ, а не ошибка', () => {
  expect(parseCsv('ООО "Ромашка";100', ';')).toEqual([['ООО "Ромашка"', '100']]);
});

test('parseCsv: пустые поля и пустые строки файла', () => {
  expect(parseCsv('a;;b', ';')).toEqual([['a', '', 'b']]);
  // пустая строка файла не порождает строку-запись
  expect(parseCsv('a\n\nb\n', ',')).toEqual([['a'], ['b']]);
});

// --- toCanonicalRows: direction='sign' ----------------------------------------

test('toCanonicalRows: DD.MM.YYYY → ISO, знак → direction, counterparty и raw как есть', () => {
  const { rows, errors } = toCanonicalRows(
    [
      ['01.02.2026', 'Пятёрочка', '1 890,00'],
      ['02.02.2026', ' ООО "Ромашка" ', '-420'],
    ],
    signMapping,
  );
  expect(errors).toEqual([]);
  expect(rows).toEqual([
    {
      occurredOn: '2026-02-01',
      amount: '1890.00',
      direction: 'income',
      counterparty: 'Пятёрочка',
      raw: '01.02.2026;Пятёрочка;1 890,00',
      rowIndex: 0,
    },
    {
      occurredOn: '2026-02-02',
      amount: '420.00',
      direction: 'expense',
      counterparty: ' ООО "Ромашка" ', // без нормализации — она задача дедупа, не парсера
      raw: '02.02.2026; ООО "Ромашка" ;-420',
      rowIndex: 1,
    },
  ]);
});

test('toCanonicalRows: raw склеен фактическим разделителем файла («,»), а не константой «;»', () => {
  const { rows, errors } = toCanonicalRows(
    [['01.02.2026', 'Пятёрочка', '-1890,00']],
    signMapping,
    ',',
  );
  expect(errors).toEqual([]);
  expect(at(rows, 0).raw).toBe('01.02.2026,Пятёрочка,-1890,00');
  // без третьего аргумента сохраняется прежнее поведение — «;» (обратная совместимость)
  const legacy = toCanonicalRows([['01.02.2026', 'Пятёрочка', '-1890,00']], signMapping);
  expect(at(legacy.rows, 0).raw).toBe('01.02.2026;Пятёрочка;-1890,00');
});

test('toCanonicalRows: матрица форматов суммы — пробелы, NBSP, разряды, валюта, скобки', () => {
  const cases: Array<[cell: string, amount: string, direction: 'income' | 'expense']> = [
    ['1 890,00', '1890.00', 'income'], // обычный пробел как разряд
    ['1\u00a0890,00', '1890.00', 'income'], // NBSP
    ['1\u202f890,00', '1890.00', 'income'], // узкий пробел
    ['1,234.56', '1234.56', 'income'], // запятая — разряды, точка — десятичный
    ['1.234,56', '1234.56', 'income'], // точка — разряды, запятая — десятичный
    ['1.234.567', '1234567.00', 'income'], // один вид несколько раз → все разрядные
    ['12,5', '12.50', 'income'], // один раз → десятичный, добить до 2 знаков
    ['(1 890,00)', '1890.00', 'expense'], // банковская скобочная запись минуса
    ['-420', '420.00', 'expense'],
    ['420', '420.00', 'income'],
    ['1 890,00 ₽', '1890.00', 'income'], // символ валюты
    ['1 890,00 р.', '1890.00', 'income'], // «р.» — буква + точка не должны ломать разбор
    ['57 RUB', '57.00', 'income'],
  ];
  const { rows, errors } = toCanonicalRows(
    cases.map(([cell]) => ['01.02.2026', 'X', cell]),
    signMapping,
  );
  expect(errors).toEqual([]);
  expect(rows).toHaveLength(cases.length);
  cases.forEach(([cell, amount, direction], i) => {
    expect(at(rows, i).amount, `сумма «${cell}»`).toBe(amount);
    expect(at(rows, i).direction, `направление «${cell}»`).toBe(direction);
  });
});

test('toCanonicalRows: нулевая и неразбираемая сумма → errors, не rows', () => {
  const { rows, errors } = toCanonicalRows(
    [
      ['01.02.2026', 'X', '0,00'],
      ['02.02.2026', 'X', '0'],
      ['03.02.2026', 'X', 'не сумма'],
    ],
    signMapping,
  );
  expect(rows).toEqual([]);
  expect(errors.map((e) => e.rowIndex)).toEqual([0, 1, 2]);
  for (const e of errors) expect(e.reason).toMatch(/сумм/i);
});

test('toCanonicalRows: 31.02.2026 → ошибка строки, а не молчаливое 2 марта', () => {
  const { rows, errors } = toCanonicalRows([['31.02.2026', 'X', '100']], signMapping);
  expect(rows).toEqual([]);
  expect(errors).toHaveLength(1);
  expect(errors[0]?.rowIndex).toBe(0);
  expect(errors[0]?.reason).toMatch(/дат/i);
});

test('toCanonicalRows: мусор вместо даты и несуществующий месяц → errors', () => {
  const isoMapping: CsvMapping = { ...signMapping, dateFormat: 'YYYY-MM-DD' };
  const ok = toCanonicalRows([['2026-02-01', 'X', '100']], isoMapping);
  expect(ok.errors).toEqual([]);
  expect(at(ok.rows, 0).occurredOn).toBe('2026-02-01');

  const bad = toCanonicalRows(
    [
      ['2026-13-01', 'X', '100'],
      ['не дата', 'X', '100'],
    ],
    isoMapping,
  );
  expect(bad.rows).toEqual([]);
  expect(bad.errors.map((e) => e.rowIndex)).toEqual([0, 1]);
});

test('toCanonicalRows: MM/DD/YYYY и DD/MM/YYYY различают день и месяц по формату', () => {
  const us = toCanonicalRows([['03/04/2026', 'X', '100']], {
    ...signMapping,
    dateFormat: 'MM/DD/YYYY',
  });
  expect(at(us.rows, 0).occurredOn).toBe('2026-03-04');
  const eu = toCanonicalRows([['03/04/2026', 'X', '100']], {
    ...signMapping,
    dateFormat: 'DD/MM/YYYY',
  });
  expect(at(eu.rows, 0).occurredOn).toBe('2026-04-03');
});

test('toCanonicalRows: индекс колонки за границами строки → ошибка строки, не исключение', () => {
  const { rows, errors } = toCanonicalRows([['01.02.2026', 'X']], signMapping);
  expect(rows).toEqual([]);
  expect(errors).toHaveLength(1);
  expect(errors[0]?.reason).toMatch(/колонк/i);
});

test('toCanonicalRows: bankTxnId — непустое значение попадает (в trim), пустое не ставит ключ', () => {
  const mapping: CsvMapping = { ...signMapping, bankTxnId: 3 };
  const { rows, errors } = toCanonicalRows(
    [
      ['01.02.2026', 'X', '100', 'TX-1'],
      ['02.02.2026', 'X', '100', '   '],
      ['03.02.2026', 'X', '100', ' TX-2 '],
    ],
    mapping,
  );
  expect(errors).toEqual([]);
  expect(at(rows, 0).bankTxnId).toBe('TX-1');
  // ключа нет вовсе (bankTxnId входит в external_id — «нет значения» ≠ пустая строка)
  expect('bankTxnId' in at(rows, 1)).toBe(false);
  // случайные пробелы банка не должны менять external_id → значение хранится в trim
  expect(at(rows, 2).bankTxnId).toBe('TX-2');
});

// --- toCanonicalRows: direction='separate_columns' -----------------------------

test('toCanonicalRows: раздельные дебет/кредит — направление по заполненной колонке', () => {
  const mapping: CsvMapping = {
    date: 0,
    counterparty: 1,
    direction: 'separate_columns',
    debit: 2,
    credit: 3,
    dateFormat: 'DD.MM.YYYY',
  };
  const { rows, errors } = toCanonicalRows(
    [
      ['01.02.2026', 'Магазин', '340,00', ''], // дебет → expense
      ['02.02.2026', 'Работа', '', '15 000,00'], // кредит → income
      ['03.02.2026', 'Конфликт', '10', '20'], // обе → ошибка
      ['04.02.2026', 'Пусто', '', ''], // ни одной → ошибка
      ['05.02.2026', 'Ноль в дебете', '0,00', '250'], // нулевой дебет = пустой → income
    ],
    mapping,
  );
  expect(rows.map((r) => [r.rowIndex, r.direction, r.amount])).toEqual([
    [0, 'expense', '340.00'],
    [1, 'income', '15000.00'],
    [4, 'income', '250.00'],
  ]);
  expect(errors.map((e) => e.rowIndex)).toEqual([2, 3]);
  expect(errors[0]?.reason).toMatch(/дебет|кредит/i);
  expect(errors[1]?.reason).toMatch(/дебет|кредит/i);
});

// --- fileHashHex ---------------------------------------------------------------

test('fileHashHex: sha256 байтов "abc" — эталон FIPS 180-2, посчитан независимо', async () => {
  // python3: hashlib.sha256(b'abc').hexdigest()
  expect(await fileHashHex(buf(0x61, 0x62, 0x63))).toBe(
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  );
});

test('fileHashHex: пустой файл', async () => {
  // python3: hashlib.sha256(b'').hexdigest()
  expect(await fileHashHex(buf())).toBe(
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  );
});

test('fileHashHex: хэш считается по байтам, даже если они — не валидный UTF-8', async () => {
  // python3: hashlib.sha256(bytes([0xC4, 0xE0])).hexdigest()
  const hex = await fileHashHex(buf(0xc4, 0xe0));
  expect(hex).toBe('1265d29b499a91d1abd331c58cce35e21b23865db3810da873467ae6d2f23ac5');
  expect(hex).toMatch(/^[0-9a-f]{64}$/); // формат ожидания сервера (fileHashSchema)
});

// --- интеграция: win-1251 файл проходит весь конвейер ---------------------------

test('интеграция: win-1251 байты → декодирование → разделитель → parseCsv → CanonicalRow', () => {
  // python3: 'Дата;Контрагент;Сумма\n01.02.2026;Пятёрочка;-1 890,00'.encode('cp1251')
  const bytes = buf(
    ...[0xc4, 0xe0, 0xf2, 0xe0, 0x3b], // Дата;
    ...[0xca, 0xee, 0xed, 0xf2, 0xf0, 0xe0, 0xe3, 0xe5, 0xed, 0xf2, 0x3b], // Контрагент;
    ...[0xd1, 0xf3, 0xec, 0xec, 0xe0, 0x0a], // Сумма\n
    ...[0x30, 0x31, 0x2e, 0x30, 0x32, 0x2e, 0x32, 0x30, 0x32, 0x36, 0x3b], // 01.02.2026;
    ...[0xcf, 0xff, 0xf2, 0xb8, 0xf0, 0xee, 0xf7, 0xea, 0xe0, 0x3b], // Пятёрочка;
    ...[0x2d, 0x31, 0x20, 0x38, 0x39, 0x30, 0x2c, 0x30, 0x30], // -1 890,00
  );
  const { text, encoding } = decodeCsvBytes(bytes);
  expect(encoding).toBe('windows-1251');
  expect(text).toBe('Дата;Контрагент;Сумма\n01.02.2026;Пятёрочка;-1 890,00');

  const delimiter = detectDelimiter(text);
  expect(delimiter).toBe(';');

  const parsed = parseCsv(text, delimiter);
  expect(parsed).toEqual([
    ['Дата', 'Контрагент', 'Сумма'],
    ['01.02.2026', 'Пятёрочка', '-1 890,00'],
  ]);

  const { rows, errors } = toCanonicalRows(parsed.slice(1), signMapping);
  expect(errors).toEqual([]);
  expect(rows).toEqual([
    {
      occurredOn: '2026-02-01',
      amount: '1890.00',
      direction: 'expense',
      counterparty: 'Пятёрочка',
      raw: '01.02.2026;Пятёрочка;-1 890,00',
      rowIndex: 0,
    },
  ]);
});
