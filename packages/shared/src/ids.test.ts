import { describe, expect, test } from 'bun:test';
import {
  answerMessageId,
  batchAuditMessageId,
  entityThreadId,
  globalThreadId,
  isManualBucket,
  manualBucket,
  materializeBatchId,
  memoryRuleDeclinedId,
  memoryRuleEntityId,
  memoryRuleSuggestionId,
  newId,
  ORBIS_NAMESPACE,
  pendingMessageId,
  postFinancialBatchId,
  processingMessageId,
  questionStaleMessageId,
  recurringInstanceId,
  rejectMessageId,
  routineRunBatchId,
  routineRunId,
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

  test('routineRunId/routineRunBatchId (V1.3): детерминированы бакетом и попыткой, lowercase, без пересечений', () => {
    const routine = '019DED47-D100-717A-8307-A5B7A5BE722F';
    const bucket = '2026-08-18T07:00';
    const id = routineRunId(routine, bucket, 1);
    expect(id).toBe(routineRunId(routine.toLowerCase(), bucket, 1));
    // Ретрай после сбоя — ДРУГОЙ прогон: без attempt в ключе вторая попытка реплеилась бы
    // в строку первой и «повтор» молча возвращал бы провалившийся прогон
    expect(id).not.toBe(routineRunId(routine, bucket, 2));
    expect(id).not.toBe(routineRunId(routine, '2026-08-18T08:00', 1));
    // Прогон и его batch_id живут в одном пространстве uuid: совпади они — audit-строка
    // batch'а конфликтовала бы PK с самой сущностью прогона
    expect(id).not.toBe(routineRunBatchId(routine, bucket, 1));
    expect(routineRunBatchId(routine, bucket, 1)).toBe(
      routineRunBatchId(routine.toLowerCase(), bucket, 1),
    );
    expect(routineRunBatchId(routine, bucket, 1)).not.toBe(routineRunBatchId(routine, bucket, 2));
    // …и с формулой инстансов серии (тот же шаблон id + дата) тоже не пересекаются
    expect(id).not.toBe(recurringInstanceId(routine, '2026-08-18'));
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
  test('answerMessageId/questionStaleMessageId (D42 ОЧ.9): детерминированы, регистр входа не значим, судьбы вопроса не пересекаются ни между собой, ни с pending/reject', () => {
    const owner = '00000000-0000-4000-8000-00000000000A';
    const pending = '019A0000-0000-7000-8000-000000000001';
    const other = '019A0000-0000-7000-8000-000000000002';
    const answer = answerMessageId(owner, pending);
    const stale = questionStaleMessageId(owner, pending);

    expect(answer).toBe(answerMessageId(owner.toLowerCase(), pending.toLowerCase()));
    expect(answer).toBe(answerMessageId(owner.toUpperCase(), pending.toUpperCase()));
    expect(stale).toBe(questionStaleMessageId(owner.toLowerCase(), pending.toLowerCase()));
    expect(answer).not.toBe(answerMessageId(owner, other));
    expect(stale).not.toBe(questionStaleMessageId(owner, other));

    // Две судьбы ОДНОГО вопроса — две разные строки: совпади PK, гашение садилось бы
    // поверх ответа и правило «первая судьба финальна» держать было бы нечем
    expect(answer).not.toBe(stale);
    // …и ни одна не садится на PK самой карточки вопроса (её id = pendingId) и на PK
    // отказа действия: пространства ключей ids.ts не пересекаются по построению (:184-188)
    expect(answer).not.toBe(pending.toLowerCase());
    expect(stale).not.toBe(pending.toLowerCase());
    expect(answer).not.toBe(pendingMessageId(owner, pending));
    expect(stale).not.toBe(pendingMessageId(owner, pending));
    expect(answer).not.toBe(rejectMessageId(owner, pending));
    expect(stale).not.toBe(rejectMessageId(owner, pending));

    expect(answer).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(stale).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
  test('manualBucket: ручной запуск отличим от слота расписания по префиксу', () => {
    expect(manualBucket('2026-08-18T09:12:00.000Z')).toBe('manual:2026-08-18T09:12:00.000Z');
    expect(isManualBucket(manualBucket('2026-08-18T09:12:00.000Z'))).toBe(true);
    expect(isManualBucket('2026-08-18T07:00')).toBe(false);
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
  test('memoryRule*Id (§7.8): детерминированы ключом, различают предложение и отказ, чувствительны к дате', () => {
    const k = {
      ownerId: '00000000-0000-4000-8000-00000000000a',
      pattern: 'пятерочка',
      fromCategoryId: '00000000-0000-7000-8000-0000000000d4',
      toCategoryId: '00000000-0000-7000-8000-0000000000d5',
      date: '2026-07-25',
    };
    expect(memoryRuleSuggestionId(k)).toBe(
      memoryRuleSuggestionId({ ...k, ownerId: k.ownerId.toUpperCase() }),
    );
    expect(memoryRuleSuggestionId(k)).not.toBe(memoryRuleDeclinedId(k));
    expect(memoryRuleSuggestionId(k)).not.toBe(
      memoryRuleSuggestionId({ ...k, date: '2026-07-26' }),
    );
    expect(memoryRuleSuggestionId(k)).not.toBe(memoryRuleSuggestionId({ ...k, pattern: 'кофе' }));
    // пара категорий направленная: обратное исправление — другое предложение
    expect(memoryRuleSuggestionId(k)).not.toBe(
      memoryRuleSuggestionId({
        ...k,
        fromCategoryId: k.toCategoryId,
        toCategoryId: k.fromCategoryId,
      }),
    );
  });
  test('memoryRuleEntityId (D3b): детерминирован сообщением+правилом, различает предложения и правила', () => {
    const k = {
      messageId: '00000000-0000-5000-8000-0000000000e6',
      pattern: 'кофе хауз',
      toCategoryId: '00000000-0000-7000-8000-0000000000d5',
    };
    // Повторный показ той же карточки (перезагрузка страницы, другое устройство) — тот же id
    expect(memoryRuleEntityId(k)).toBe(memoryRuleEntityId({ ...k }));
    expect(memoryRuleEntityId(k)).toBe(
      memoryRuleEntityId({ ...k, messageId: k.messageId.toUpperCase() }),
    );
    // Новое предложение (эскалация после архивации правила) — новый id, не replay архивного
    expect(memoryRuleEntityId(k)).not.toBe(
      memoryRuleEntityId({ ...k, messageId: '00000000-0000-5000-8000-0000000000e7' }),
    );
    // Разные правила в одном сообщении — разные сущности
    expect(memoryRuleEntityId(k)).not.toBe(memoryRuleEntityId({ ...k, pattern: 'пятерочка' }));
    expect(memoryRuleEntityId(k)).not.toBe(
      memoryRuleEntityId({ ...k, toCategoryId: '00000000-0000-7000-8000-0000000000d4' }),
    );
    expect(memoryRuleEntityId(k)).not.toBe(k.messageId);
    expect(memoryRuleEntityId(k)).toMatch(
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
