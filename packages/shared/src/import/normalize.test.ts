import { describe, expect, test } from 'bun:test';
import {
  type CanonicalRow,
  counterpartySimilarity,
  DUP_SIMILARITY_THRESHOLD,
  externalRowId,
  isProbableDuplicate,
  normalizeCounterparty,
  SERVICE_TOKENS,
} from './normalize';

describe('normalizeCounterparty (03-budget §3.4.1)', () => {
  test('пиннящая фикстура: «SBOL ПЯТЁРОЧКА 1234» → пятерочка 1234', () => {
    expect(normalizeCounterparty('«SBOL ПЯТЁРОЧКА 1234»')).toBe('пятерочка 1234');
  });

  test('без кавычек — тот же результат', () => {
    expect(normalizeCounterparty('SBOL ПЯТЁРОЧКА 1234')).toBe('пятерочка 1234');
  });

  test('ё→е после lowercase: Ё тоже покрыта', () => {
    expect(normalizeCounterparty('Ёлки-Палки')).toBe('елки палки');
  });

  test('пунктуация и символы (\\p{P}, \\p{S}) → пробелы, повторные пробелы схлопнуты', () => {
    // «OOO» — латиница (как в реальных банковских выписках): остаётся латиницей.
    expect(normalizeCounterparty('OOO "Ромашка", г.Москва — оплата $5!')).toBe(
      'ooo ромашка г москва оплата 5',
    );
  });

  test('NFKC: полноширинные символы приводятся к обычным', () => {
    expect(normalizeCounterparty('Ｃａｆｅ')).toBe('cafe');
  });

  test('ведущие SERVICE_TOKENS срезаются повторно, пока первый токен матчится', () => {
    expect(normalizeCounterparty('SBOL OPLATA CARD Пятёрочка')).toBe('пятерочка');
  });

  test('сервисный токен НЕ в начале не срезается', () => {
    expect(normalizeCounterparty('Пятёрочка CARD')).toBe('пятерочка card');
  });

  test('строка целиком из сервисных токенов → пустая строка', () => {
    expect(normalizeCounterparty('SBOL PAYMENT')).toBe('');
  });

  test('SERVICE_TOKENS — ровно список из PRD', () => {
    expect(SERVICE_TOKENS).toEqual(['sbol', 'payment', 'card', 'purchase', 'oplata']);
  });
});

describe('counterpartySimilarity (03-budget §3.4.1, три члена)', () => {
  test('фикстура PRD: ПЯТЕРОЧКА 843 vs Пятёрочка ≥ 0.85 (containment)', () => {
    expect(counterpartySimilarity('ПЯТЕРОЧКА 843', 'Пятёрочка')).toBeGreaterThanOrEqual(
      DUP_SIMILARITY_THRESHOLD,
    );
  });

  test('негативная пара: OZON vs WILDBERRIES < 0.85', () => {
    expect(counterpartySimilarity('OZON', 'WILDBERRIES')).toBeLessThan(DUP_SIMILARITY_THRESHOLD);
  });

  test('пиннящий принятый класс ложных срабатываний: OZON vs OZON TRAVEL = 1.0 (containment)', () => {
    expect(counterpartySimilarity('OZON', 'OZON TRAVEL')).toBe(1);
  });

  test('нормализованные строки равны → 1', () => {
    expect(counterpartySimilarity('«Пятёрочка»', 'пятерочка')).toBe(1);
  });

  test('ровно одна строка пустая → 0', () => {
    expect(counterpartySimilarity('', 'OZON')).toBe(0);
    expect(counterpartySimilarity('OZON', '')).toBe(0);
  });

  test('обе пустые → 1 (в т.ч. пустые после срезания сервисных токенов)', () => {
    expect(counterpartySimilarity('', '')).toBe(1);
    expect(counterpartySimilarity('SBOL', 'PAYMENT')).toBe(1);
  });

  test('порог — константа 0.85', () => {
    expect(DUP_SIMILARITY_THRESHOLD).toBe(0.85);
  });
});

const row: CanonicalRow = {
  occurredOn: '2026-07-01',
  amount: '340.00',
  direction: 'expense',
  counterparty: 'SBOL ПЯТЁРОЧКА 1234',
  raw: 'SBOL ПЯТЁРОЧКА 1234;340.00;01.07.2026',
  rowIndex: 0,
};

const candidate = {
  amount: '340.00',
  direction: 'expense',
  occurredOn: '2026-07-01',
  title: 'Пятёрочка 1234',
};

describe('isProbableDuplicate (03-budget §3.4.1)', () => {
  test('точное совпадение всех критериев → дубль', () => {
    expect(isProbableDuplicate(row, candidate)).toBe(true);
  });

  test('разница дат ровно 1 день → дубль, 2 дня → нет', () => {
    expect(isProbableDuplicate(row, { ...candidate, occurredOn: '2026-07-02' })).toBe(true);
    expect(isProbableDuplicate(row, { ...candidate, occurredOn: '2026-06-30' })).toBe(true);
    expect(isProbableDuplicate(row, { ...candidate, occurredOn: '2026-07-03' })).toBe(false);
    expect(isProbableDuplicate(row, { ...candidate, occurredOn: '2026-06-29' })).toBe(false);
  });

  test('сумма — decimal-строки: "340" и "340.0" равны "340.00"', () => {
    expect(isProbableDuplicate(row, { ...candidate, amount: '340' })).toBe(true);
    expect(isProbableDuplicate(row, { ...candidate, amount: '340.0' })).toBe(true);
    expect(isProbableDuplicate(row, { ...candidate, amount: '340.01' })).toBe(false);
    expect(isProbableDuplicate(row, { ...candidate, amount: '34.00' })).toBe(false);
  });

  test('направление — точно: income против expense → нет', () => {
    expect(isProbableDuplicate(row, { ...candidate, direction: 'income' })).toBe(false);
  });

  test('candidate.counterparty приоритетнее title; при отсутствии — title', () => {
    expect(
      isProbableDuplicate(row, {
        ...candidate,
        title: 'непохожий текст',
        counterparty: 'Пятёрочка',
      }),
    ).toBe(true);
    expect(isProbableDuplicate(row, { ...candidate, title: 'непохожий текст' })).toBe(false);
  });

  test('bankTxnId: оба непустые и равны → дубль независимо от текста', () => {
    expect(
      isProbableDuplicate(
        { ...row, bankTxnId: 'txn-1', counterparty: 'совсем другой мерчант' },
        { ...candidate, title: 'непохожий текст', bankTxnId: 'txn-1' },
      ),
    ).toBe(true);
  });

  test('bankTxnId разные — не дисквалификация: похожий текст всё ещё даёт дубль', () => {
    expect(
      isProbableDuplicate({ ...row, bankTxnId: 'txn-1' }, { ...candidate, bankTxnId: 'txn-2' }),
    ).toBe(true);
    expect(
      isProbableDuplicate(
        { ...row, bankTxnId: 'txn-1' },
        { ...candidate, title: 'непохожий текст', bankTxnId: 'txn-2' },
      ),
    ).toBe(false);
  });

  test('пустые bankTxnId ("" с обеих сторон) не считаются совпадением', () => {
    expect(
      isProbableDuplicate(
        { ...row, bankTxnId: '', counterparty: 'совсем другой мерчант' },
        { ...candidate, title: 'непохожий текст', bankTxnId: '' },
      ),
    ).toBe(false);
  });
});

describe('externalRowId (03-budget §3.4.1)', () => {
  const fileHash = 'ab'.repeat(32);

  test('детерминирован: фикстура с точным hex', async () => {
    // sha256hex('ab'.repeat(32) + ':0:' +
    //   '["2026-07-01","340.00","expense","пятерочка 1234",null]')
    expect(await externalRowId(fileHash, row)).toBe(
      '00eb2612e8fe1555fd19f4d21d2ea5f7af3eb88f46ce85c80945e417394f2c8c',
    );
  });

  test('меняется от rowIndex', async () => {
    const id0 = await externalRowId(fileHash, row);
    const id1 = await externalRowId(fileHash, { ...row, rowIndex: 1 });
    expect(id1).not.toBe(id0);
    expect(id1).toMatch(/^[0-9a-f]{64}$/);
  });

  test('raw не входит в hash, bankTxnId входит (undefined → null)', async () => {
    const id0 = await externalRowId(fileHash, row);
    expect(await externalRowId(fileHash, { ...row, raw: 'другое сырьё' })).toBe(id0);
    expect(await externalRowId(fileHash, { ...row, bankTxnId: 'txn-1' })).not.toBe(id0);
  });

  test('amount берётся как есть: "340.0" и "340.00" дают разные id', async () => {
    const id0 = await externalRowId(fileHash, row);
    expect(await externalRowId(fileHash, { ...row, amount: '340.0' })).not.toBe(id0);
  });
});
