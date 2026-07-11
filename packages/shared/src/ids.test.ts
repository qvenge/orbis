import { describe, expect, test } from 'bun:test';
import {
  batchAuditMessageId,
  entityThreadId,
  globalThreadId,
  materializeBatchId,
  newId,
  ORBIS_NAMESPACE,
  postFinancialBatchId,
  processingMessageId,
  recurringInstanceId,
  rejectMessageId,
} from './ids';

describe('детерминированные ID (01 §5.4, §4.5, §7.8)', () => {
  test('пример из PRD §5.4 воспроизводится байт-точно', () => {
    expect(recurringInstanceId('019ded47-d100-717a-8307-a5b7a5be722f', '2026-07-01')).toBe(
      'e7d0bfa4-f62a-59c1-b560-1c17cb32e89f',
    );
  });
  test('lowercase-нормализация входа', () => {
    expect(recurringInstanceId('019DED47-D100-717A-8307-A5B7A5BE722F', '2026-07-01')).toBe(
      'e7d0bfa4-f62a-59c1-b560-1c17cb32e89f',
    );
  });
  test('materializeBatchId (A3): детерминирован окном, lowercase-нормализован, не пересекается с instance-id', () => {
    const tpl = '019DED47-D100-717A-8307-A5B7A5BE722F';
    const a = materializeBatchId(tpl, '2026-07-01', '2026-07-15');
    expect(a).toBe(materializeBatchId(tpl.toLowerCase(), '2026-07-01', '2026-07-15'));
    expect(a).not.toBe(materializeBatchId(tpl, '2026-07-01', '2026-07-14')); // другое окно — другой batch
    expect(a).not.toBe(recurringInstanceId(tpl, '2026-07-01'));
  });

  test('postFinancialBatchId (A5): формула §3.3 «post-financial:<instance_id>» байт-точно, lowercase, без пересечений', () => {
    // Инстанс из примера §5.4 → batch перехода planned→fact; литерал фиксирует формулу
    const inst = 'e7d0bfa4-f62a-59c1-b560-1c17cb32e89f';
    expect(postFinancialBatchId(inst)).toBe('6f6322c7-60d1-57f1-aa30-9b74f19a1149');
    expect(postFinancialBatchId(inst.toUpperCase())).toBe(postFinancialBatchId(inst));
    expect(postFinancialBatchId(inst)).not.toBe(inst);
    expect(postFinancialBatchId(inst)).not.toBe(recurringInstanceId(inst, '2026-07-01'));
  });

  test('формулы тредов детерминированы и различны', () => {
    const owner = '00000000-0000-4000-8000-00000000000a';
    const entity = '00000000-0000-7000-8000-0000000000a1';
    expect(globalThreadId(owner)).toBe(globalThreadId(owner));
    expect(entityThreadId(owner, entity)).toBe(entityThreadId(owner, entity));
    expect(globalThreadId(owner)).not.toBe(entityThreadId(owner, entity));
    expect(batchAuditMessageId(owner, entity)).not.toBe(entityThreadId(owner, entity));
  });
  test('rejectMessageId (§7.10) детерминирован, lowercase-нормализован и не пересекается с batch-audit', () => {
    const owner = '00000000-0000-4000-8000-00000000000a';
    const pending = '00000000-0000-7000-8000-0000000000b2';
    expect(rejectMessageId(owner, pending)).toBe(rejectMessageId(owner.toUpperCase(), pending));
    expect(rejectMessageId(owner, pending)).not.toBe(batchAuditMessageId(owner, pending));
  });
  test('processingMessageId детерминирован, lowercase-нормализован, отличен от исходного id', () => {
    const userMsg = '00000000-0000-7000-8000-0000000000c3';
    expect(processingMessageId(userMsg)).toBe(processingMessageId(userMsg.toUpperCase()));
    expect(processingMessageId(userMsg)).not.toBe(userMsg);
    expect(processingMessageId(userMsg)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
  test('newId — валидный UUIDv7, монотонный по времени в префиксе', () => {
    const a = newId();
    const b = newId();
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a < b || a.slice(0, 13) === b.slice(0, 13)).toBe(true);
  });
  test('константа namespace дословно из PRD', () => {
    expect(ORBIS_NAMESPACE).toBe('cb339e97-82d7-4d16-91c6-942d42df7054');
  });
});
