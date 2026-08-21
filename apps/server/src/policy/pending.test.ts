// Интеграционные тесты pending-подтверждений §7.10 (Task 6): живая БД, без моков.
// Семантика: explicit-confirmation → immutable payload в карточке-запросе, до
// подтверждения НИЧЕГО не записано ни в граф, ни в журнал; approve исполняет
// СОХРАНЁННЫЙ payload полным конвейером executor'а (ревалидация текущего состояния)
// без обращения к LLM; идемпотентность approve — по PK детерминированного
// audit-сообщения (batch-механика §7.8, batch_id = pendingId).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  answerMessageId,
  batchAuditMessageId,
  globalThreadId,
  newId,
  questionStaleMessageId,
  rejectMessageId,
} from '@orbis/shared';
import { eq, inArray, sql } from 'drizzle-orm';
import { adminDb, appDb, freshUserId, requireEnv, truncateAll } from '../../test/helpers';
import { appendMessageIdempotent } from '../chat/messages';
import { ensureEntityThread } from '../chat/threads';
import { chatMessages, entities } from '../db/schema';
import { withIdentity } from '../db/with-identity';
import { ExecError } from '../errors';
import { execute } from '../executor/executor';
import type { ActionRecord, ExecuteResult, WireEntity } from '../executor/types';
import { dispatchTool, type ToolCallCtx } from '../tools/dispatch';
import {
  acquirePendingLock,
  answerPendingQuestion,
  approvePending,
  askDedupeKey,
  createPending,
  deferDedupeKey,
  listRunUnits,
  type RunUnit,
  rejectedReason,
  rejectPending,
  rejectPendingTx,
  stalePendingQuestion,
  unitHash,
} from './pending';

requireEnv();

const { db, client } = appDb();
const userA = freshUserId();
const userB = freshUserId();
const T0 = new Date('2026-07-04T12:00:00.000Z');
const clock = () => T0;

function ctxFor(over: Partial<ToolCallCtx> = {}): ToolCallCtx {
  return {
    db,
    actorUserId: userA,
    actorKind: 'ai',
    source: 'chat',
    explicitCommand: false,
    clock,
    ...over,
  };
}

/** Сид-сущность через executor без синка — без audit-шума в тредах. */
async function seedEntity(owner: string, input: Record<string, unknown>): Promise<WireEntity> {
  const r = await execute(db, {
    actorUserId: owner,
    actorKind: 'owner',
    source: 'ui',
    operations: [{ tool: 'entity_create', input }],
  });
  if (!r.ok) throw new Error(`seedEntity: ${r.error.code} ${r.error.message}`);
  return r.results[0] as WireEntity;
}

async function messagesIn(owner: string, threadId: string) {
  return withIdentity(db, owner, (tx) =>
    tx
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.threadId, threadId))
      .orderBy(chatMessages.createdAt, chatMessages.id),
  );
}

async function messageById(owner: string, id: string) {
  const rows = await withIdentity(db, owner, (tx) =>
    tx.select().from(chatMessages).where(eq(chatMessages.id, id)),
  );
  return rows[0];
}

async function archivedOf(owner: string, id: string): Promise<boolean | undefined> {
  const rows = await withIdentity(db, owner, (tx) =>
    tx.select({ archived: entities.archived }).from(entities).where(eq(entities.id, id)),
  );
  return rows[0]?.archived;
}

/** Pending архивации инициативой AI (ряд archives → explicit-confirmation, §7.10). */
async function pendingArchive(
  threadId: string | undefined,
  over: Partial<ToolCallCtx> = {},
): Promise<{ target: WireEntity; pendingId: string }> {
  const target = await seedEntity(userA, { title: 'Кандидат на архив', tags: [] });
  const r = await dispatchTool(ctxFor({ threadId, ...over }), 'entity_update', {
    id: target.id,
    archived: true,
  });
  if (r.status !== 'pending_confirmation') {
    throw new Error(`ожидался pending_confirmation, получено ${r.status}`);
  }
  return { target, pendingId: r.pendingId };
}

function expectExecError(r: ExecuteResult, code: string): void {
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error.code).toBe(code);
}

beforeAll(async () => {
  await truncateAll();
});

afterAll(async () => {
  await client.end();
});

describe('createPending через dispatch: explicit-уровень §7.10', () => {
  test('карточка-запрос записана с immutable payload; ни граф, ни журнал не тронуты', async () => {
    const host = await seedEntity(userA, { title: 'Хост-тред pending', tags: [] });
    const threadId = await withIdentity(db, userA, (tx) => ensureEntityThread(tx, userA, host.id));
    const target = await seedEntity(userA, { title: 'Цель архивации', tags: [] });

    const r = await dispatchTool(ctxFor({ threadId }), 'entity_update', {
      id: target.id,
      archived: true,
    });
    expect(r.status).toBe('pending_confirmation');
    if (r.status !== 'pending_confirmation') return;
    expect(r.card).toEqual({
      kind: 'confirmation_card',
      mode: 'explicit',
      pendingId: r.pendingId,
      summary: 'entity_update',
    });

    // §7.10: до подтверждения ничего не записано — ни в граф, ни в журнал
    expect(await archivedOf(userA, target.id)).toBe(false);
    const msgs = await messagesIn(userA, threadId);
    expect(msgs.length).toBe(1); // только карточка-запрос
    const msg = msgs[0];
    expect(msg?.id).toBe(r.pendingId); // id сообщения = pendingId (прямая адресация)
    expect(msg?.role).toBe('system');
    const md = msg?.metadata as {
      pending?: Record<string, unknown>;
      cards?: unknown[];
      actions?: unknown;
    };
    // immutable payload — ровно envelope-валидированный input (§7.10)
    expect(md.pending).toEqual({
      id: r.pendingId,
      tool: 'entity_update',
      input: { id: target.id, archived: true },
      actor_kind: 'ai',
      source: 'chat',
      created_at: T0.toISOString(),
    });
    expect(md.cards).toEqual([r.card]);
    expect(md.actions).toBeUndefined(); // журнал §7.8 пуст — pending не несёт action
  });

  test('без threadId карточка-запрос ложится в глобальный тред владельца', async () => {
    const { pendingId } = await pendingArchive(undefined);
    const msg = await messageById(userA, pendingId);
    expect(msg?.threadId).toBe(globalThreadId(userA));
  });
});

describe('approvePending: исполнение сохранённого payload без LLM (§7.10)', () => {
  test('approve исполняет payload: сущность заархивирована, audit с детерминированным id и атрибуцией исходного актора', async () => {
    const host = await seedEntity(userA, { title: 'Хост approve', tags: [] });
    const threadId = await withIdentity(db, userA, (tx) => ensureEntityThread(tx, userA, host.id));
    const { target, pendingId } = await pendingArchive(threadId);

    const r = await approvePending(db, { ownerId: userA, pendingId, clock });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.actionId).toBe(pendingId);
    expect(r.idempotentReplay).toBe(false);
    expect((r.results[0] as WireEntity).archived).toBe(true);
    expect(await archivedOf(userA, target.id)).toBe(true);

    // audit-сообщение §7.8: детерминированный PK (batch-механика, batch_id = pendingId),
    // тот же тред, что у карточки-запроса; атрибуция — исходный актор (ai/chat)
    const audit = await messageById(userA, batchAuditMessageId(userA, pendingId));
    expect(audit).toBeDefined();
    expect(audit?.threadId).toBe(threadId);
    const md = audit?.metadata as { actions?: ActionRecord[] };
    const action = md.actions?.[0];
    expect(action?.id).toBe(pendingId);
    expect(action?.type).toBe('batch');
    expect(action?.actor_kind).toBe('ai');
    expect(action?.source).toBe('chat');
  });

  test('повторный approve → идемпотентный replay из сохранённого audit, НЕ второй эффект', async () => {
    const { target, pendingId } = await pendingArchive(undefined);
    const first = await approvePending(db, { ownerId: userA, pendingId, clock });
    expect(first.ok).toBe(true);

    // Владелец разархивировал сущность прямым действием — повторный approve НЕ должен
    // заархивировать её снова (иначе это было бы повторное исполнение, не replay)
    const unarchive = await execute(db, {
      actorUserId: userA,
      actorKind: 'owner',
      source: 'ui',
      operations: [{ tool: 'entity_update', input: { id: target.id, archived: false } }],
    });
    expect(unarchive.ok).toBe(true);

    const again = await approvePending(db, { ownerId: userA, pendingId, clock });
    expect(again.ok).toBe(true);
    if (!again.ok || !first.ok) return;
    expect(again.idempotentReplay).toBe(true);
    expect(again.actionId).toBe(pendingId);
    expect(again.results).toEqual(first.results); // сохранённый результат, не новый прогон
    expect(await archivedOf(userA, target.id)).toBe(false); // второго эффекта нет
  });

  test('approve после reject → VALIDATION «отклонено», payload не исполнен', async () => {
    const { target, pendingId } = await pendingArchive(undefined);
    const rejected = await rejectPending(db, { ownerId: userA, pendingId });
    expect(rejected.ok).toBe(true);

    const r = await approvePending(db, { ownerId: userA, pendingId, clock });
    expectExecError(r, 'VALIDATION');
    if (!r.ok) expect(r.error.message).toContain('отклонено');
    expect(await archivedOf(userA, target.id)).toBe(false);
    // audit-сообщения нет — исполнение не начиналось
    expect(await messageById(userA, batchAuditMessageId(userA, pendingId))).toBeUndefined();
  });

  test('чужой pendingId (userB) → NOT_FOUND: RLS скоупит журнал владельцем', async () => {
    const { pendingId } = await pendingArchive(undefined);
    const r = await approvePending(db, { ownerId: userB, pendingId, clock });
    expectExecError(r, 'NOT_FOUND');
    // и несуществующий id неразличим с чужим
    const missing = await approvePending(db, { ownerId: userA, pendingId: newId(), clock });
    expectExecError(missing, 'NOT_FOUND');
  });

  test('ревалидация текущего состояния: сущность из payload удалена → структурная ошибка, audit не записан', async () => {
    const { target, pendingId } = await pendingArchive(undefined);
    // Жёсткое удаление админом моделирует «состояние изменилось за время ожидания»
    const { db: admin, client: adminClient } = adminDb();
    try {
      await admin.delete(entities).where(eq(entities.id, target.id));
    } finally {
      await adminClient.end();
    }

    const r = await approvePending(db, { ownerId: userA, pendingId, clock });
    expectExecError(r, 'NOT_FOUND'); // стадия 3 конвейера: load state не нашёл сущность
    expect(await messageById(userA, batchAuditMessageId(userA, pendingId))).toBeUndefined();
  });

  test('batch-payload: собственная структура с batch_id = pendingId; approve исполняет все операции, повтор — replay', async () => {
    const originalBatchId = newId();
    const ids = Array.from({ length: 11 }, () => newId());
    const r = await dispatchTool(ctxFor(), 'batch_execute', {
      batch_id: originalBatchId,
      operations: ids.map((id, i) => ({
        tool: 'entity_create',
        input: { id, title: `Массовая-${i}`, tags: ['pend-batch'] },
      })),
    });
    expect(r.status).toBe('pending_confirmation'); // ряд масштаба >10 → explicit
    if (r.status !== 'pending_confirmation') return;
    expect(r.card.kind).toBe('confirmation_card');
    if (r.card.kind === 'confirmation_card') expect(r.card.summary).toBe('11 операций');

    const approved = await approvePending(db, { ownerId: userA, pendingId: r.pendingId, clock });
    expect(approved.ok).toBe(true);
    if (!approved.ok) return;
    expect(approved.results.length).toBe(11);
    const rows = await withIdentity(db, userA, (tx) =>
      tx.select({ id: entities.id }).from(entities).where(inArray(entities.id, ids)),
    );
    expect(rows.length).toBe(11);

    // Идемпотентность ключуется pendingId, НЕ исходным batch_id модели (перезапись §7.8)
    expect(await messageById(userA, batchAuditMessageId(userA, r.pendingId))).toBeDefined();
    expect(await messageById(userA, batchAuditMessageId(userA, originalBatchId))).toBeUndefined();

    const again = await approvePending(db, { ownerId: userA, pendingId: r.pendingId, clock });
    expect(again.ok).toBe(true);
    if (again.ok) expect(again.idempotentReplay).toBe(true);
  });

  test('ревалидация batch: несовместимое изменение валит ВЕСЬ batch до первой записи', async () => {
    const targets: WireEntity[] = [];
    for (let i = 0; i < 11; i++) {
      targets.push(await seedEntity(userA, { title: `Арх-batch-${i}`, tags: ['pend-reval'] }));
    }
    const r = await dispatchTool(ctxFor(), 'batch_execute', {
      batch_id: newId(),
      operations: targets.map((t) => ({
        tool: 'entity_update',
        input: { id: t.id, archived: true },
      })),
    });
    expect(r.status).toBe('pending_confirmation');
    if (r.status !== 'pending_confirmation') return;

    // Одна из сущностей исчезла за время ожидания → весь batch отклоняется атомарно
    const victim = targets[5];
    if (!victim) throw new Error('нет цели для удаления');
    const { db: admin, client: adminClient } = adminDb();
    try {
      await admin.delete(entities).where(eq(entities.id, victim.id));
    } finally {
      await adminClient.end();
    }

    const approved = await approvePending(db, { ownerId: userA, pendingId: r.pendingId, clock });
    expectExecError(approved, 'NOT_FOUND');
    const rows = await withIdentity(db, userA, (tx) =>
      tx
        .select({ archived: entities.archived })
        .from(entities)
        .where(
          inArray(
            entities.id,
            targets.filter((t) => t.id !== victim.id).map((t) => t.id),
          ),
        ),
    );
    expect(rows.length).toBe(10);
    expect(rows.every((row) => row.archived === false)).toBe(true); // ни одной частичной записи
  });

  test('pending внешнего агента (mcp): атрибуция actor_kind=agent/source=mcp сохраняется в audit', async () => {
    const { pendingId } = await pendingArchive(undefined, { actorKind: 'agent', source: 'mcp' });
    const r = await approvePending(db, { ownerId: userA, pendingId, clock });
    expect(r.ok).toBe(true);
    const audit = await messageById(userA, batchAuditMessageId(userA, pendingId));
    const md = audit?.metadata as { actions?: ActionRecord[] };
    expect(md.actions?.[0]?.actor_kind).toBe('agent');
    expect(md.actions?.[0]?.source).toBe('mcp');
  });
});

describe('сериализация approve ∥ reject (fix round: write-skew закрыт advisory-lock’ом)', () => {
  test('гонка approve ∥ reject на свежих pending: ровно один выигрывает, никогда оба ok', async () => {
    // До фикса (проба ревьюера): оба tx проходили свои проверки до чужого коммита →
    // сущность заархивирована И «отклонение принято» одновременно (write-skew между
    // tx проверок approve и tx reject'а; окно длиной в конвейер executor'а).
    // После фикса оба пути сериализованы pg_advisory_xact_lock(hashtextextended(pendingId)):
    // и reject, и approve (через beforeStages audit-tx executor'а) берут замок ДО ПЕРВОГО
    // ЧТЕНИЯ СОСТОЯНИЯ своего tx, а approve ещё и перепроверяет «не отклонён» под ним.
    // «До первого чтения», а не «первым statement'ом»: два первых statement'а ставит сам
    // withIdentity (set_config + SET LOCAL ROLE) — см. док acquirePendingLock.
    const iterations = 25;
    let bothOk = 0;
    for (let i = 0; i < iterations; i++) {
      const { target, pendingId } = await pendingArchive(undefined);
      const [a, r] = await Promise.all([
        approvePending(db, { ownerId: userA, pendingId, clock }),
        rejectPending(db, { ownerId: userA, pendingId }),
      ]);
      if (a.ok && r.ok) {
        bothOk++; // несогласованный исход — считаем все итерации, отчёт в assert ниже
        continue;
      }
      const archived = await archivedOf(userA, target.id);
      if (a.ok) {
        // выиграл approve: эффект есть, reject честно отказал «уже исполнено»
        expect(archived).toBe(true);
        if (!r.ok) {
          expect(r.error.code).toBe('VALIDATION');
          expect(r.error.message).toContain('исполнено');
        }
      } else {
        // выиграл reject: эффекта нет, approve честно отказал «отклонено»
        expect(r.ok).toBe(true);
        expect(archived).toBe(false);
        expect(a.error.code).toBe('VALIDATION');
        expect(a.error.message).toContain('отклонено');
      }
    }
    expect(bothOk).toBe(0); // write-skew: ни одной итерации с двумя ok
  });
});

describe('rejectPending: отклонение карточки-запроса', () => {
  test('reject пишет системное сообщение {type: confirmation_rejected, rejects}; повторный reject идемпотентен', async () => {
    const host = await seedEntity(userA, { title: 'Хост reject', tags: [] });
    const threadId = await withIdentity(db, userA, (tx) => ensureEntityThread(tx, userA, host.id));
    const { target, pendingId } = await pendingArchive(threadId);

    const r = await rejectPending(db, { ownerId: userA, pendingId });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.alreadyRejected).toBe(false);

    const msgs = await messagesIn(userA, threadId);
    expect(msgs.length).toBe(2); // карточка-запрос + reject-сообщение
    const reject = msgs[1];
    expect(reject?.id).toBe(rejectMessageId(userA, pendingId)); // детерминированный PK (fix round)
    expect(reject?.role).toBe('system');
    // reason — причина отказа (V1.8): у кнопки владельца она всегда 'owner'
    expect(reject?.metadata).toEqual({
      type: 'confirmation_rejected',
      rejects: pendingId,
      reason: 'owner',
    });
    expect(await archivedOf(userA, target.id)).toBe(false);

    // Повторный reject — идемпотентен: второго сообщения нет
    const again = await rejectPending(db, { ownerId: userA, pendingId });
    expect(again.ok).toBe(true);
    if (again.ok) expect(again.alreadyRejected).toBe(true);
    expect((await messagesIn(userA, threadId)).length).toBe(2);
  });

  test('чужой и несуществующий pendingId → NOT_FOUND', async () => {
    const { pendingId } = await pendingArchive(undefined);
    const foreign = await rejectPending(db, { ownerId: userB, pendingId });
    expect(foreign.ok).toBe(false);
    if (!foreign.ok) expect(foreign.error.code).toBe('NOT_FOUND');
    const missing = await rejectPending(db, { ownerId: userA, pendingId: newId() });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe('NOT_FOUND');
  });

  test('reject уже исполненного pending → VALIDATION «уже исполнено»', async () => {
    const { pendingId } = await pendingArchive(undefined);
    const approved = await approvePending(db, { ownerId: userA, pendingId, clock });
    expect(approved.ok).toBe(true);

    const r = await rejectPending(db, { ownerId: userA, pendingId });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('VALIDATION');
      expect(r.error.message).toContain('исполнено');
    }
  });
});

// Ш1.5, шаг 1 лестницы правки: правка предложения гасит P1 и создаёт P2, и обе записи
// обязаны лечь ОДНОЙ транзакцией — иначе крэш между ними оставляет сироту. Вложить
// транзакцию нельзя (postgres-js берёт под неё другую коннекцию и самоблокируется на
// advisory-замке), поэтому гашение существует и tx-вариантом.
describe('rejectPendingTx: гашение в ЧУЖОЙ транзакции (Ш1.5, шаг 1 лестницы)', () => {
  test('пишет reject-сообщение транзакцией вызывателя: искусственный rollback снаружи откатывает и гашение', async () => {
    const { pendingId } = await pendingArchive(undefined);
    const rejectId = rejectMessageId(userA, pendingId);

    await expect(
      withIdentity(db, userA, async (tx) => {
        const r = await rejectPendingTx(tx, { ownerId: userA, pendingId });
        expect(r.alreadyRejected).toBe(false);
        // Сообщение видно ИЗНУТРИ этой транзакции до её коммита — значит писала его она,
        // а не собственный tx гашения (тот был бы уже закоммичен и пережил бы откат)
        const inTx = await tx
          .select({ id: chatMessages.id })
          .from(chatMessages)
          .where(eq(chatMessages.id, rejectId));
        expect(inTx.length).toBe(1);
        throw new Error('искусственный откат лестницы');
      }),
    ).rejects.toThrow('искусственный откат лестницы');

    // Снаружи не осталось ничего: гашение откатилось вместе с транзакцией вызывателя —
    // это и есть атомарность шага 1 (P1 гасится и P2 создаётся либо обе, либо ни одной)
    expect(await messageById(userA, rejectId)).toBeUndefined();

    // Предложение живо и гасится начисто; ok-ветка обёртки несёт тред карточки
    const after = await rejectPending(db, { ownerId: userA, pendingId });
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(after.alreadyRejected).toBe(false);
    expect(after.threadId).toBe(globalThreadId(userA));
  });

  test('повторный захват замка того же pendingId в той же tx не блокирует (advisory xact-замок re-entrant)', async () => {
    const { pendingId } = await pendingArchive(undefined);
    // Замок берёт вызыватель (лестница читает состояние P1 под ним), а следом ещё раз —
    // сам rejectPendingTx. Не будь повтор no-op'ом, второй захват ждал бы конца этой же
    // транзакции, то есть самого себя, до statement_timeout: тест проходит ровно потому,
    // что этого не происходит, и флага «замок уже взят» контракту не требуется.
    const advisoryLocks = await withIdentity(db, userA, async (tx) => {
      await acquirePendingLock(tx, pendingId);
      const r = await rejectPendingTx(tx, { ownerId: userA, pendingId });
      expect(r.alreadyRejected).toBe(false);
      const rows = await tx.execute(
        sql`SELECT count(*)::int AS n FROM pg_locks
            WHERE locktype = 'advisory' AND pid = pg_backend_pid()`,
      );
      return (rows[0] as { n: number }).n;
    });
    expect(advisoryLocks).toBe(1); // два захвата — одна запись в pg_locks
  });

  test('возвращает threadId треда карточки-запроса — P2 лестницы ляжет в тред рутины, а не в глобальный', async () => {
    const host = await seedEntity(userA, { title: 'Хост tx-гашения', tags: [] });
    const threadId = await withIdentity(db, userA, (tx) => ensureEntityThread(tx, userA, host.id));
    const { pendingId } = await pendingArchive(threadId);

    const r = await withIdentity(db, userA, (tx) =>
      rejectPendingTx(tx, { ownerId: userA, pendingId, reason: 'superseded' }),
    );
    expect(r).toEqual({ pendingId, alreadyRejected: false, reason: 'superseded', threadId });

    // Внешняя транзакция закоммитилась — запись на месте, в том же треде и с тем же
    // текстом, что у обёртки: тело гашения не раздвоилось
    const msg = await messageById(userA, rejectMessageId(userA, pendingId));
    expect(msg?.threadId).toBe(threadId);
    expect(msg?.content).toBe('Предложение заменено новым прогоном');
  });

  test('бросает ExecError, а не возвращает {ok:false}: отказ обязан откатить транзакцию вызывателя', async () => {
    const err = await withIdentity(db, userA, (tx) =>
      rejectPendingTx(tx, { ownerId: userA, pendingId: newId() }),
    ).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ExecError);
    expect((err as ExecError).code).toBe('NOT_FOUND');
  });
});

// V1.5/V1.6/V1.8: pending предложения рутины несёт источник 'routine' и прогон, а отказ —
// причину: «заменено новым прогоном» обязано быть отличимо от «владелец отказался».
describe('атрибуция рутины: source routine, run_id и причина отказа', () => {
  test('pending с source=routine и run_id: approve исполняет с runId → action журнала несёт run_id и source routine', async () => {
    const target = await seedEntity(userA, { title: 'Цель предложения рутины', tags: [] });
    const runId = newId();
    const { pendingId } = await withIdentity(db, userA, (tx) =>
      createPending(tx, {
        actor: { userId: userA, kind: 'ai', source: 'routine', runId },
        tool: 'batch_execute',
        input: {
          batch_id: newId(),
          operations: [{ tool: 'entity_update', input: { id: target.id, archived: true } }],
        },
        level: 'explicit-confirmation',
        clock,
      }),
    );

    const r = await approvePending(db, { ownerId: userA, pendingId, clock });
    expect(r.ok).toBe(true);
    expect(await archivedOf(userA, target.id)).toBe(true);

    // Атрибуция доживает до журнала: подтвердил владелец, но правку сделала рутина
    // в конкретном прогоне — по run_id откат прогона (rollback.ts) найдёт это действие
    const audit = await messageById(userA, batchAuditMessageId(userA, pendingId));
    const action = (audit?.metadata as { actions?: ActionRecord[] }).actions?.[0];
    expect(action?.actor_kind).toBe('ai');
    expect(action?.source).toBe('routine');
    expect(action?.run_id).toBe(runId);
  });

  test('rejectPending с reason superseded → текст «заменено» и metadata.reason; повтор → alreadyRejected с ИСХОДНОЙ причиной', async () => {
    const { pendingId } = await pendingArchive(undefined);

    const r = await rejectPending(db, { ownerId: userA, pendingId, reason: 'superseded' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.alreadyRejected).toBe(false);
    expect(r.reason).toBe('superseded');

    const msg = await messageById(userA, rejectMessageId(userA, pendingId));
    expect(msg?.content).toBe('Предложение заменено новым прогоном');
    expect(msg?.metadata).toEqual({
      type: 'confirmation_rejected',
      rejects: pendingId,
      reason: 'superseded',
    });

    // Журнал append-only (§4.6): второй вызов с ДРУГОЙ причиной сообщение не переписывает
    // и возвращает ту причину, что записана — иначе владельцу показали бы не тот повод
    const again = await rejectPending(db, { ownerId: userA, pendingId, reason: 'stale' });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.alreadyRejected).toBe(true);
    expect(again.reason).toBe('superseded');
    expect(msg?.content).toBe('Предложение заменено новым прогоном');
  });

  test('reason по умолчанию — owner; reject-сообщение старой формы (без reason) читается как owner', async () => {
    const { pendingId } = await pendingArchive(undefined);
    const r = await rejectPending(db, { ownerId: userA, pendingId });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.reason).toBe('owner');
    const msg = await messageById(userA, rejectMessageId(userA, pendingId));
    expect(msg?.content).toBe('Подтверждение отклонено');

    // Сообщения, написанные ДО появления причины, ключа reason не несут (metadata
    // неизменяема) — читаются как отказ владельца, а не как «причина неизвестна»
    const legacy = await pendingArchive(undefined);
    await withIdentity(db, userA, (tx) =>
      appendMessageIdempotent(tx, {
        id: rejectMessageId(userA, legacy.pendingId),
        threadId: globalThreadId(userA),
        role: 'system',
        content: 'Подтверждение отклонено',
        metadata: { type: 'confirmation_rejected', rejects: legacy.pendingId },
      }),
    );
    const old = await rejectPending(db, {
      ownerId: userA,
      pendingId: legacy.pendingId,
      reason: 'stale',
    });
    expect(old.ok).toBe(true);
    if (!old.ok) return;
    expect(old.alreadyRejected).toBe(true);
    expect(old.reason).toBe('owner');
  });
});

// Ш1.5: правка владельца — ЧЕТВЁРТАЯ причина отказа. Она едет одной работой сразу
// четырьмя точками (тип, zod-энам, текст ленты, статус на прогоне): забытый zod-энам —
// единственная из них без компиляторной страховки, и забытый он молча откатывает причину
// к 'owner', то есть превращает правку владельца в его же отказ.
describe('причина отказа edited: правка владельца (Ш1.5)', () => {
  test('reject reason edited: текст «Предложение заменено правкой владельца», metadata.reason=edited; читается обратно как edited, а не через fallback owner', async () => {
    const { pendingId } = await pendingArchive(undefined);

    const r = await rejectPending(db, { ownerId: userA, pendingId, reason: 'edited' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.alreadyRejected).toBe(false);
    expect(r.reason).toBe('edited');

    const msg = await messageById(userA, rejectMessageId(userA, pendingId));
    expect(msg?.content).toBe('Предложение заменено правкой владельца');
    expect(msg?.metadata).toEqual({
      type: 'confirmation_rejected',
      rejects: pendingId,
      reason: 'edited',
    });

    // Вот та самая проверка забытого zod-энама: причина ЧИТАЕТСЯ из ленты, и незнакомая
    // строка откатывается к 'owner' (rejectedReason). Гашение новым прогоном обязано
    // увидеть «правка», а не «владелец отклонил», — иначе оно перепишет чужую судьбу.
    expect(await withIdentity(db, userA, (tx) => rejectedReason(tx, pendingId))).toBe('edited');
    const again = await rejectPending(db, { ownerId: userA, pendingId, reason: 'superseded' });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.alreadyRejected).toBe(true);
    expect(again.reason).toBe('edited');
  });

  test('edited_from: правленое предложение находится контейнмент-пробой по родителю, и поле доживает до action журнала (В-1)', async () => {
    const target = await seedEntity(userA, { title: 'Цель правленого предложения', tags: [] });
    const runId = newId();
    const parentId = newId();
    const { pendingId } = await withIdentity(db, userA, (tx) =>
      createPending(tx, {
        actor: {
          userId: userA,
          kind: 'ai',
          source: 'routine',
          runId,
          // Ш1.5: это предложение рождено правкой владельца — вот кого она погасила
          editedFrom: parentId,
        },
        tool: 'batch_execute',
        input: {
          batch_id: newId(),
          operations: [{ tool: 'entity_update', input: { id: target.id, archived: true } }],
        },
        level: 'explicit-confirmation',
        clock,
      }),
    );

    // Проба по родителю — то, чем лестница ищет своё дитя в крэш-окне между шагами
    const probe = JSON.stringify({ pending: { edited_from: parentId } });
    const found = await withIdentity(db, userA, (tx) =>
      tx.execute(sql`SELECT id FROM chat_messages WHERE metadata @> ${probe}::jsonb`),
    );
    expect([...found].map((r) => (r as { id: string }).id)).toEqual([pendingId]);

    const r = await approvePending(db, { ownerId: userA, pendingId, clock });
    expect(r.ok).toBe(true);
    const audit = await messageById(userA, batchAuditMessageId(userA, pendingId));
    const action = (audit?.metadata as { actions?: ActionRecord[] }).actions?.[0];
    expect(action?.run_id).toBe(runId);
    // §7.8: журнал знает, что применено не то, что предложила рутина, а правка владельца
    expect(action?.edited_from).toBe(parentId);
  });

  test('без правки ключа edited_from нет вовсе — ни в pending-записи, ни в action (условная запись, как run_id)', async () => {
    const { pendingId } = await pendingArchive(undefined);
    const pending = await messageById(userA, pendingId);
    expect(Object.hasOwn((pending?.metadata as { pending: object }).pending, 'edited_from')).toBe(
      false,
    );

    const r = await approvePending(db, { ownerId: userA, pendingId, clock });
    expect(r.ok).toBe(true);
    const audit = await messageById(userA, batchAuditMessageId(userA, pendingId));
    const action = (audit?.metadata as { actions?: ActionRecord[] }).actions?.[0];
    expect(action !== undefined && Object.hasOwn(action, 'edited_from')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// D42 «Пачка решений» (ОЧ.2, Б5 ревью): тот же pending несёт ЕДИНИЦЫ прогона —
// отложенное действие и вопрос. Отличие единицы от сегодняшнего чатового pending и от
// предложения рутины — ЯВНЫЙ `kind`: по нему единицы находит проба пачки, по нему же
// approve/reject отказывают на вопросе («на него отвечают, а не принимают»).
// ---------------------------------------------------------------------------

/** Единица-действие пачки: pending с явным kind:'action', прогоном и defer-дедупом. */
async function deferredAction(
  runId: string,
  threadId?: string,
): Promise<{ target: WireEntity; pendingId: string }> {
  const target = await seedEntity(userA, { title: 'Цель отложенного действия', tags: [] });
  const input = { id: target.id, archived: true };
  const { pendingId } = await withIdentity(db, userA, (tx) =>
    createPending(tx, {
      threadId,
      actor: { userId: userA, kind: 'ai', source: 'routine', runId },
      kind: 'action',
      tool: 'entity_update',
      input,
      level: 'explicit-confirmation',
      dedupeKey: deferDedupeKey(runId, 'entity_update', input),
      clock,
    }),
  );
  return { target, pendingId };
}

/** Единица-вопрос пачки (ОЧ.5): pending с kind:'question' и БЕЗ tool/input. */
async function askedQuestion(
  runId: string,
  question: string,
  options?: string[],
  threadId?: string,
): Promise<string> {
  const { pendingId } = await withIdentity(db, userA, (tx) =>
    createPending(tx, {
      threadId,
      actor: { userId: userA, kind: 'ai', source: 'routine', runId },
      kind: 'question',
      question,
      options,
      level: 'explicit-confirmation',
      dedupeKey: askDedupeKey(runId, question, options),
      clock,
      content: `Вопрос рутины: ${question}`,
    }),
  );
  return pendingId;
}

/** Предложение рутины (V1.6): pending того же прогона, но БЕЗ kind — не единица (Б5). */
async function proposalOfRun(runId: string, threadId?: string): Promise<string> {
  const target = await seedEntity(userA, { title: 'Цель предложения рутины', tags: [] });
  const { pendingId } = await withIdentity(db, userA, (tx) =>
    createPending(tx, {
      threadId,
      actor: { userId: userA, kind: 'ai', source: 'routine', runId },
      tool: 'batch_execute',
      input: {
        batch_id: newId(),
        operations: [{ tool: 'entity_update', input: { id: target.id, archived: true } }],
      },
      level: 'explicit-confirmation',
      dedupeKey: `proposal:${runId}`,
      clock,
    }),
  );
  return pendingId;
}

/**
 * Сырая pending-запись в ленте — фикстура для комбинаций, которых `createPending` не даёт
 * (вопрос с тулом, действие без тула): их проверяет схема, а не вызыватель.
 */
async function craftPending(threadId: string, pending: Record<string, unknown>): Promise<string> {
  const id = pending.id as string;
  await withIdentity(db, userA, (tx) =>
    appendMessageIdempotent(tx, {
      id,
      threadId,
      role: 'system',
      content: 'сырая pending-запись (фикстура)',
      metadata: { pending },
    }),
  );
  return id;
}

/** Текст гашения вопроса — его даёт вызыватель: у гашения вопроса нет `RejectReason`. */
const STALE_TEXT = 'Вопрос снят: его задал прошлый прогон';

/**
 * Гашение МИМО процедуры — фикстура ровно для одного состояния: ответ И гашение в ленте
 * разом. Процедуры Задачи 3 его не создают (каждая под замком перечитывает чужой PK и
 * уступает первой записанной судьбе), родить его может только запись мимо них — крэш
 * чужого пути или ручная правка. Без подделки правило ОЧ.8 «ответ важнее гашения» у
 * читателя не проверить вовсе, поэтому фикстура и осталась сырой.
 */
async function craftStale(pendingId: string, threadId: string): Promise<void> {
  await withIdentity(db, userA, (tx) =>
    appendMessageIdempotent(tx, {
      id: questionStaleMessageId(userA, pendingId),
      threadId,
      role: 'system',
      content: STALE_TEXT,
      metadata: { type: 'question_stale', stales: pendingId },
    }),
  );
}

/**
 * Часы строки ленты: `created_at` пишет БД (`defaultNow`), задать его при вставке нечем, а
 * порядок пачки — часть контракта `listRunUnits`. Фикстура правит колонку админ-DSN'ом,
 * чтобы порядок был ЗАДАННЫЙ, а у двух единиц метка совпала — иначе тай-брейк по id не
 * проверить. Правится не журнал (metadata неизменяема, §4.6), а часы теста.
 */
async function backdate(marks: Array<[string, string]>): Promise<void> {
  const { db: admin, client: adminClient } = adminDb();
  try {
    for (const [id, at] of marks) {
      await admin.execute(
        sql`UPDATE chat_messages SET created_at = ${at}::timestamptz WHERE id = ${id}::uuid`,
      );
    }
  } finally {
    await adminClient.end();
  }
}

async function unitsOf(runId: string): Promise<RunUnit[]> {
  return withIdentity(db, userA, (tx) => listRunUnits(tx, userA, runId));
}

describe('pending-запись единицы: kind и условная обязательность tool/input (ОЧ.2, Б5)', () => {
  test('запись kind:question с question/options и БЕЗ tool/input — валидна; kind:question с tool — VALIDATION; kind:action без tool — VALIDATION; запись без kind с tool/input — валидна (сегодняшние чатовые)', async () => {
    const runId = newId();
    const host = await seedEntity(userA, { title: 'Хост схемы единицы', tags: [] });
    const threadId = await withIdentity(db, userA, (tx) => ensureEntityThread(tx, userA, host.id));

    // (1) Вопрос без тула — валиден: его читает проба пачки, а не executor
    const questionId = await askedQuestion(runId, 'Какой счёт списать?', ['Карта', 'Наличные']);
    const units = await unitsOf(runId);
    expect(units.map((u) => u.pendingId)).toEqual([questionId]);
    expect(units[0]?.question).toBe('Какой счёт списать?');
    expect(units[0]?.options).toEqual(['Карта', 'Наличные']);
    expect(units[0]?.tool).toBeUndefined();

    // (2) Вопрос С тулом — комбинация запрещена: fail-closed, как повреждённый payload.
    // Иначе «вопрос» проехал бы в executor и исполнил чужой план мимо решения владельца
    const questionWithTool = await craftPending(threadId, {
      id: newId(),
      kind: 'question',
      question: 'Вопрос с тулом',
      tool: 'entity_update',
      input: { id: host.id, archived: true },
      actor_kind: 'ai',
      source: 'routine',
      run_id: runId,
      created_at: T0.toISOString(),
    });
    const badQuestion = await approvePending(db, {
      ownerId: userA,
      pendingId: questionWithTool,
      clock,
    });
    expect(badQuestion.ok).toBe(false);
    if (!badQuestion.ok) {
      expect(badQuestion.error.code).toBe('VALIDATION');
      expect(badQuestion.error.message).toContain('повреждена');
    }

    // (3) Действие без тула — та же структурная ошибка: исполнять нечего
    const actionNoTool = await craftPending(threadId, {
      id: newId(),
      kind: 'action',
      actor_kind: 'ai',
      source: 'routine',
      run_id: runId,
      created_at: T0.toISOString(),
    });
    const badAction = await approvePending(db, { ownerId: userA, pendingId: actionNoTool, clock });
    expect(badAction.ok).toBe(false);
    if (!badAction.ok) {
      expect(badAction.error.code).toBe('VALIDATION');
      expect(badAction.error.message).toContain('повреждена');
    }

    // (4) Обратная совместимость: чатовый pending без kind с tool/input читается как
    // раньше (правило «нет kind = действие» — только при одиночном чтении по id)
    const { pendingId } = await pendingArchive(undefined);
    const legacy = await rejectPending(db, { ownerId: userA, pendingId });
    expect(legacy.ok).toBe(true);
  });
});

describe('unitHash и ключи дедупа единиц (ОЧ.9, приёмка 15)', () => {
  test('unitHash: перестановка ключей объекта не меняет хеш; другой input — другой хеш; формат /^[0-9a-f]{64}$/; deferDedupeKey от переставленных ключей JSON одинаков (приёмка 15)', () => {
    const input = { id: 'e1', archived: true, aspects: { 'orbis/task': { status: 'done' } } };
    const shuffled = { aspects: { 'orbis/task': { status: 'done' } }, archived: true, id: 'e1' };

    // jsonb не хранит порядок ключей: пришедший через БД payload обязан дать тот же хеш
    expect(unitHash({ tool: 'entity_update', input })).toBe(
      unitHash({ input: shuffled, tool: 'entity_update' }),
    );
    expect(unitHash({ tool: 'entity_update', input })).toMatch(/^[0-9a-f]{64}$/);
    expect(unitHash({ tool: 'entity_update', input: { id: 'e2' } })).not.toBe(
      unitHash({ tool: 'entity_update', input }),
    );

    // Регистр — не косметика: pendingMessageId лоуэркейсит ключ целиком (ids.ts), и
    // верхний регистр в хеше схлопнул бы две разные единицы в один PK
    expect(unitHash({ tool: 'x' })).toBe(unitHash({ tool: 'x' }).toLowerCase());

    const runId = newId();
    expect(deferDedupeKey(runId, 'entity_update', input)).toBe(
      deferDedupeKey(runId, 'entity_update', shuffled),
    );
    expect(deferDedupeKey(runId, 'entity_update', input)).toBe(
      `defer:${runId}:${unitHash({ tool: 'entity_update', input })}`,
    );
    // Разные прогоны — разные ключи: пачка живёт внутри своего прогона
    expect(deferDedupeKey(newId(), 'entity_update', input)).not.toBe(
      deferDedupeKey(runId, 'entity_update', input),
    );

    expect(askDedupeKey(runId, 'Куда отнести расход?')).toBe(
      `ask:${runId}:${unitHash({ question: 'Куда отнести расход?', options: [] })}`,
    );
    // «Нет вариантов» и «пустой список вариантов» — один и тот же вопрос
    expect(askDedupeKey(runId, 'Куда отнести расход?')).toBe(
      askDedupeKey(runId, 'Куда отнести расход?', []),
    );
    // А порядок вариантов значим: владелец видит кнопки в присланном порядке
    expect(askDedupeKey(runId, 'Куда?', ['Еда', 'Дом'])).not.toBe(
      askDedupeKey(runId, 'Куда?', ['Дом', 'Еда']),
    );
  });
});

describe('гейты kind: вопрос не принимают и не отклоняют (С7 ревью)', () => {
  test('approvePending на kind:question → VALIDATION структурной ошибкой, граф не тронут; rejectPending на kind:question → VALIDATION', async () => {
    const runId = newId();
    const host = await seedEntity(userA, { title: 'Хост гейтов', tags: [] });
    const threadId = await withIdentity(db, userA, (tx) => ensureEntityThread(tx, userA, host.id));
    const pendingId = await askedQuestion(runId, 'Продолжать ли перенос?', undefined, threadId);

    // Гейт стоит в policy, а не в роутере: approve/reject зовут семь мест (кнопка чата,
    // раннер, лестница правки, MCP), и «вопрос» обязан отскакивать у всех одинаково
    const approved = await approvePending(db, { ownerId: userA, pendingId, clock });
    expect(approved.ok).toBe(false);
    if (!approved.ok) {
      expect(approved.error.code).toBe('VALIDATION');
      expect(approved.error.message).toContain('вопрос');
    }
    // Ни исполнения, ни записи: audit-сообщения по детерминированному PK нет
    expect(await messageById(userA, batchAuditMessageId(userA, pendingId))).toBeUndefined();

    const rejected = await rejectPending(db, { ownerId: userA, pendingId });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.error.code).toBe('VALIDATION');
      expect(rejected.error.message).toContain('вопрос');
    }
    expect(await messageById(userA, rejectMessageId(userA, pendingId))).toBeUndefined();

    // В треде — только сама карточка вопроса: судьба не записана ни одной из попыток
    expect((await messagesIn(userA, threadId)).length).toBe(1);
    // И судьба вопроса осталась открытой — гейт не подменил её отказом
    expect((await unitsOf(runId))[0]?.fate).toBe('open');
  });
});

describe('текст отказа единицы: свой, а не «Предложение…» (С6 ревью)', () => {
  test('rejectPending с text: в ленте текст единицы, metadata.reason прежний; повтор возвращает исходную причину; без text — прежние тексты байт-в-байт', async () => {
    const runId = newId();
    const { pendingId } = await deferredAction(runId);

    const own = 'Отложенное действие снято новым прогоном';
    const r = await rejectPending(db, {
      ownerId: userA,
      pendingId,
      reason: 'superseded',
      text: own,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.reason).toBe('superseded');

    const msg = await messageById(userA, rejectMessageId(userA, pendingId));
    expect(msg?.content).toBe(own);
    // Текст — только в ленте: metadata судьбы не меняется, иначе читатели причины
    // (rejectedReason, статус прогона) пришлось бы учить второму источнику правды
    expect(msg?.metadata).toEqual({
      type: 'confirmation_rejected',
      rejects: pendingId,
      reason: 'superseded',
    });

    // Повтор с ДРУГИМ текстом и причиной ничего не переписывает (журнал append-only)
    const again = await rejectPending(db, {
      ownerId: userA,
      pendingId,
      reason: 'stale',
      text: 'Отложенное действие устарело',
    });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.alreadyRejected).toBe(true);
    expect(again.reason).toBe('superseded');
    expect((await messageById(userA, rejectMessageId(userA, pendingId)))?.content).toBe(own);

    // Без text — прежние тексты причин, байт в байт: предложения и чатовые подтверждения
    // этой работой не задеты
    const plain = await deferredAction(runId);
    await rejectPending(db, { ownerId: userA, pendingId: plain.pendingId, reason: 'stale' });
    expect((await messageById(userA, rejectMessageId(userA, plain.pendingId)))?.content).toBe(
      'Предложение устарело: состояние изменилось',
    );
    const { pendingId: chatId } = await pendingArchive(undefined);
    await rejectPending(db, { ownerId: userA, pendingId: chatId });
    expect((await messageById(userA, rejectMessageId(userA, chatId)))?.content).toBe(
      'Подтверждение отклонено',
    );
  });
});

describe('listRunUnits: единицы прогона одной пробой (Б5, ОЧ.8)', () => {
  test('прогон с вопросом, ДВУМЯ отложками и ЧУЖИМ предложением (pending без kind, дедуп proposal:<runId>) → в пачке только единицы, предложение и чужой прогон не попали (Б5, приёмка 19-предусловие); порядок created_at, id', async () => {
    const runId = newId();
    const host = await seedEntity(userA, { title: 'Хост пачки', tags: [] });
    const threadId = await withIdentity(db, userA, (tx) => ensureEntityThread(tx, userA, host.id));

    // Порядок ЗАПИСИ намеренно не совпадает с ожидаемым порядком чтения
    const first = await deferredAction(runId, threadId);
    const question = await askedQuestion(runId, 'Списывать с карты?', ['Да', 'Нет'], threadId);
    const second = await deferredAction(runId, threadId);
    const proposal = await proposalOfRun(runId, threadId);
    // Единица чужого прогона: проба обязана скоупиться прогоном, а не только kind
    const alien = await askedQuestion(newId(), 'Вопрос чужого прогона', undefined, threadId);

    // Метка вопроса — позже обеих отложек, а у отложек метки РАВНЫ: так проверяются оба
    // ключа порядка сразу (created_at, затем id)
    await backdate([
      [first.pendingId, '2026-07-04T12:00:01.000Z'],
      [second.pendingId, '2026-07-04T12:00:01.000Z'],
      [question, '2026-07-04T12:00:02.000Z'],
    ]);

    const units = await unitsOf(runId);
    // Две отложки с РАВНОЙ меткой идут первыми и упорядочены по id, вопрос — за ними:
    // порядок задан обоими ключами, а не порядком записи
    const bothActions = [first.pendingId, second.pendingId].sort();
    expect(units.map((u) => u.pendingId)).toEqual([...bothActions, question]);
    // Предложение того же прогона (без kind) и вопрос ЧУЖОГО прогона — мимо пачки
    expect(units.map((u) => u.pendingId)).not.toContain(proposal);
    expect(units.map((u) => u.pendingId)).not.toContain(alien);

    const asked = units[2];
    expect(asked).toEqual({
      pendingId: question,
      kind: 'question',
      createdAt: T0.toISOString(),
      question: 'Списывать с карты?',
      options: ['Да', 'Нет'],
      card: {
        kind: 'confirmation_card',
        mode: 'explicit',
        pendingId: question,
        summary: 'Списывать с карты?',
      },
      fate: 'open',
    });
    const deferred = units.find((u) => u.pendingId === first.pendingId);
    expect(deferred?.kind).toBe('action');
    expect(deferred?.tool).toBe('entity_update');
    expect(deferred?.input).toEqual({ id: first.target.id, archived: true });
    expect(deferred?.question).toBeUndefined();
    expect(deferred?.fate).toBe('open');
  });

  test('listRunUnits судьбы: approved по audit-PK, rejected с причиной, answered по answer-PK, stale по question-stale-PK; answered+stale одновременно → answered (ОЧ.8)', async () => {
    const runId = newId();
    const host = await seedEntity(userA, { title: 'Хост судеб пачки', tags: [] });
    const threadId = await withIdentity(db, userA, (tx) => ensureEntityThread(tx, userA, host.id));

    const applied = await deferredAction(runId, threadId);
    const dropped = await deferredAction(runId, threadId);
    const answered = await askedQuestion(runId, 'Какой счёт?', ['Карта'], threadId);
    const staled = await askedQuestion(runId, 'Ждать доставку?', undefined, threadId);
    const both = await askedQuestion(runId, 'Продолжать перенос?', undefined, threadId);
    const open = await askedQuestion(runId, 'Ещё не решённый вопрос', undefined, threadId);

    expect(
      (await approvePending(db, { ownerId: userA, pendingId: applied.pendingId, clock })).ok,
    ).toBe(true);
    expect(
      (await rejectPending(db, { ownerId: userA, pendingId: dropped.pendingId, reason: 'stale' }))
        .ok,
    ).toBe(true);
    // Судьбы вопроса пишут процедуры Задачи 3 — не фикстуры: так проверяется, что
    // читатель читает ровно ту форму, которую писатель кладёт (контракт Задач 2↔3)
    expect(
      await answerPendingQuestion(db, { ownerId: userA, pendingId: answered, answer: 'Карта' }),
    ).toEqual({ status: 'answered', pendingId: answered });
    expect(
      await stalePendingQuestion(db, { ownerId: userA, pendingId: staled, text: STALE_TEXT }),
    ).toEqual({ staled: true });
    // Обе судьбы разом — крэш между ответом и гашением следующего прогона: побеждает
    // ОТВЕТ (ОЧ.8), иначе владельцу сказали бы «снято» про то, что он уже решил.
    // Гашение здесь — сырой фикстурой: процедура отвеченный вопрос не гасит (ОЧ.8)
    await answerPendingQuestion(db, { ownerId: userA, pendingId: both, answer: 'Да, продолжай' });
    await craftStale(both, threadId);

    const units = await unitsOf(runId);
    const fateOf = (id: string) => units.find((u) => u.pendingId === id);
    expect(fateOf(applied.pendingId)?.fate).toBe('approved');
    expect(fateOf(dropped.pendingId)?.fate).toBe('rejected');
    expect(fateOf(dropped.pendingId)?.reason).toBe('stale');
    expect(fateOf(answered)?.fate).toBe('answered');
    expect(fateOf(answered)?.answer).toBe('Карта');
    expect(fateOf(staled)?.fate).toBe('stale');
    expect(fateOf(both)?.fate).toBe('answered');
    expect(fateOf(both)?.answer).toBe('Да, продолжай');
    expect(fateOf(open)?.fate).toBe('open');
    expect(fateOf(open)?.answer).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// D42 Задача 3: СУДЬБЫ ВОПРОСА (ОЧ.8, ОЧ.9). Ответ и гашение — append-only сообщения
// с детерминированными PK, обе процедуры под ОДНИМ замком pendingId, под замком
// перечитываются ОБА PK: первая записанная судьба финальна, ответ важнее гашения.
// ---------------------------------------------------------------------------

/** Пара судеб вопроса в ленте — по обоим детерминированным PK разом. */
async function fatesOf(pendingId: string) {
  return {
    answer: await messageById(userA, answerMessageId(userA, pendingId)),
    stale: await messageById(userA, questionStaleMessageId(userA, pendingId)),
  };
}

describe('answerPendingQuestion: ответ владельца — судьба вопроса (ОЧ.9, приёмка 5)', () => {
  test('ответ на открытый вопрос → append с PK answerMessageId; повторный ТОТ ЖЕ ответ → replay answered, второй записи нет (приёмка 5)', async () => {
    const runId = newId();
    const host = await seedEntity(userA, { title: 'Хост ответа', tags: [] });
    const threadId = await withIdentity(db, userA, (tx) => ensureEntityThread(tx, userA, host.id));
    const pendingId = await askedQuestion(
      runId,
      'Какой счёт списать?',
      ['Карта', 'Наличные'],
      threadId,
    );

    const r = await answerPendingQuestion(db, {
      ownerId: userA,
      pendingId,
      answer: 'Карта',
      option: 0,
    });
    expect(r).toEqual({ status: 'answered', pendingId });

    const msg = await messageById(userA, answerMessageId(userA, pendingId));
    // Автор ответа — ВЛАДЕЛЕЦ (§6/§9.5 «ответы — ui-сообщения»), а не система
    expect(msg?.role).toBe('user');
    // Ответ ложится в тред карточки-запроса, а не в глобальный тред владельца
    expect(msg?.threadId).toBe(threadId);
    expect(msg?.content).toBe('Ответ: «Карта»');
    expect(msg?.metadata).toEqual({
      type: 'question_answered',
      answers: pendingId,
      answer: 'Карта',
      option: 0, // ИНДЕКС варианта; answer при этом — его текст (клиент шлёт оба)
      source: 'ui',
    });
    // Судьба не несёт actions → в журнал §7.8 и в Undo не попадает (инвариант §9.5)
    expect(Object.hasOwn(msg?.metadata as object, 'actions')).toBe(false);
    expect((await fatesOf(pendingId)).stale).toBeUndefined();

    // Повтор ТОГО ЖЕ ответа — replay по PK: вторая запись не появляется, лента не растёт
    const before = (await messagesIn(userA, threadId)).length;
    expect(await answerPendingQuestion(db, { ownerId: userA, pendingId, answer: 'Карта' })).toEqual(
      { status: 'answered', pendingId },
    );
    expect((await messagesIn(userA, threadId)).length).toBe(before);

    const unit = (await unitsOf(runId)).find((u) => u.pendingId === pendingId);
    expect(unit?.fate).toBe('answered');
    expect(unit?.answer).toBe('Карта');
  });

  test('другой ответ после записанного → {already, answer: первый}; запись одна (С5, приёмка 5)', async () => {
    const runId = newId();
    const host = await seedEntity(userA, { title: 'Хост второго ответа', tags: [] });
    const threadId = await withIdentity(db, userA, (tx) => ensureEntityThread(tx, userA, host.id));
    const pendingId = await askedQuestion(runId, 'Какой счёт?', ['Карта', 'Наличные'], threadId);

    await answerPendingQuestion(db, { ownerId: userA, pendingId, answer: 'Карта', option: 0 });
    const before = (await messagesIn(userA, threadId)).length;

    // Молча схлопывать разные ответы запрещено (С5): владелец обязан увидеть, ЧТО
    // применилось, — иначе он уверен, что рутина пойдёт по «Наличные»
    const second = await answerPendingQuestion(db, {
      ownerId: userA,
      pendingId,
      answer: 'Наличные',
      option: 1,
    });
    expect(second).toEqual({ status: 'already', answer: 'Карта' });

    // Запись ОДНА и это первая: журнал append-only, второй ответ ничего не переписал
    expect((await messagesIn(userA, threadId)).length).toBe(before);
    const msg = await messageById(userA, answerMessageId(userA, pendingId));
    expect(msg?.content).toBe('Ответ: «Карта»');
    expect((msg?.metadata as { answer?: string; option?: number }).answer).toBe('Карта');
    expect((msg?.metadata as { answer?: string; option?: number }).option).toBe(0);
    expect((await unitsOf(runId))[0]?.answer).toBe('Карта');
  });

  test('ответ на погашенный → {stale}, записи нет (В2); гашение отвеченного → {staled:false}, ответ жив (ОЧ.8)', async () => {
    const runId = newId();
    const host = await seedEntity(userA, { title: 'Хост единственности судьбы', tags: [] });
    const threadId = await withIdentity(db, userA, (tx) => ensureEntityThread(tx, userA, host.id));

    // (а) Сначала гашение → ответ НЕ принимается (В2): карточка покажет «снят»
    const staled = await askedQuestion(runId, 'Ждать доставку?', undefined, threadId);
    expect(
      await stalePendingQuestion(db, { ownerId: userA, pendingId: staled, text: STALE_TEXT }),
    ).toEqual({ staled: true });
    const staleMsg = await messageById(userA, questionStaleMessageId(userA, staled));
    // Автор гашения — СИСТЕМА (в отличие от ответа: его автор — владелец)
    expect(staleMsg?.role).toBe('system');
    expect(staleMsg?.threadId).toBe(threadId);
    expect(staleMsg?.content).toBe(STALE_TEXT);
    expect(staleMsg?.metadata).toEqual({ type: 'question_stale', stales: staled });
    expect(Object.hasOwn(staleMsg?.metadata as object, 'actions')).toBe(false);

    expect(await answerPendingQuestion(db, { ownerId: userA, pendingId: staled, answer: 'Да' })) //
      .toEqual({ status: 'stale' });
    expect((await fatesOf(staled)).answer).toBeUndefined(); // ответ не записан вовсе

    // Повторное гашение с ДРУГИМ текстом ничего не переписывает (append-only, §4.6)
    expect(
      await stalePendingQuestion(db, {
        ownerId: userA,
        pendingId: staled,
        text: 'Другой текст гашения',
      }),
    ).toEqual({ staled: false });
    expect((await messageById(userA, questionStaleMessageId(userA, staled)))?.content).toBe(
      STALE_TEXT,
    );

    // (б) Обратный порядок: сначала ответ → гашение ПРОПУСКАЕТСЯ, ответ важнее (ОЧ.8)
    const answered = await askedQuestion(runId, 'Продолжать перенос?', undefined, threadId);
    await answerPendingQuestion(db, { ownerId: userA, pendingId: answered, answer: 'Да' });
    expect(
      await stalePendingQuestion(db, { ownerId: userA, pendingId: answered, text: STALE_TEXT }),
    ).toEqual({ staled: false });
    // Сообщения гашения НЕТ — при перевёрнутом правиле оно бы здесь лежало
    expect((await fatesOf(answered)).stale).toBeUndefined();

    const units = await unitsOf(runId);
    expect(units.find((u) => u.pendingId === staled)?.fate).toBe('stale');
    expect(units.find((u) => u.pendingId === answered)?.fate).toBe('answered');
    expect(units.find((u) => u.pendingId === answered)?.answer).toBe('Да');
  });

  test('гонка ответ vs гашение: 25 итераций Promise.all — судьба ровно одна, первая записанная финальна, обе стороны сходятся на ней (приёмка 17)', async () => {
    // Прецедент — гонка approve ∥ reject (:338-378). Здесь так же: обе процедуры берут
    // pg_advisory_xact_lock(hashtextextended(pendingId)) ДО ПЕРВОГО ЧТЕНИЯ СОСТОЯНИЯ и
    // под ним перечитывают ОБА PK судеб. Без замка обе прошли бы свои проверки до чужого
    // коммита и записали бы РАЗНЫЕ PK — вопрос оказался бы и отвеченным, и снятым.
    const iterations = 25;
    let bothWritten = 0;
    for (let i = 0; i < iterations; i++) {
      const runId = newId();
      const pendingId = await askedQuestion(runId, `Гонка ${i}: продолжать?`);
      const [a, s] = await Promise.all([
        answerPendingQuestion(db, { ownerId: userA, pendingId, answer: 'Да' }),
        stalePendingQuestion(db, { ownerId: userA, pendingId, text: STALE_TEXT }),
      ]);
      const written = await fatesOf(pendingId);
      if (written.answer !== undefined && written.stale !== undefined) {
        bothWritten++; // несогласованный исход — считаем все итерации, assert ниже
        continue;
      }
      const fate = (await unitsOf(runId))[0]?.fate;
      if (s.staled) {
        // Первым записалось гашение: ответ честно вернул stale и НИЧЕГО не записал
        expect(a).toEqual({ status: 'stale' });
        expect(written.answer).toBeUndefined();
        expect(fate).toBe('stale');
      } else {
        // Первым записался ответ: гашение пропущено, ответ владельца жив
        expect(a).toEqual({ status: 'answered', pendingId });
        expect(written.stale).toBeUndefined();
        expect(fate).toBe('answered');
      }
    }
    expect(bothWritten).toBe(0); // ни одной итерации с двумя судьбами
  });

  test('answerPendingQuestion на kind:action → VALIDATION; на чужой/несуществующий pendingId — NOT_FOUND, как у rejectPending (fail-closed)', async () => {
    const runId = newId();
    const { pendingId: actionId } = await deferredAction(runId);

    // На действие отвечать нечем — его принимают; гейт зеркален assertNotQuestion
    await expect(
      answerPendingQuestion(db, { ownerId: userA, pendingId: actionId, answer: 'Да' }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(
      stalePendingQuestion(db, { ownerId: userA, pendingId: actionId, text: STALE_TEXT }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    expect((await fatesOf(actionId)).answer).toBeUndefined();
    expect((await fatesOf(actionId)).stale).toBeUndefined();
    // Судьба действия не подменена: единица осталась открытой
    expect((await unitsOf(runId)).find((u) => u.pendingId === actionId)?.fate).toBe('open');

    // Чатовый pending без kind читается как действие — тот же отказ
    const { pendingId: chatId } = await pendingArchive(undefined);
    await expect(
      answerPendingQuestion(db, { ownerId: userA, pendingId: chatId, answer: 'Да' }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });

    // Чужой и несуществующий неразличимы: RLS скоупит журнал владельцем
    const foreign = await askedQuestion(newId(), 'Вопрос владельца A');
    await expect(
      answerPendingQuestion(db, { ownerId: userB, pendingId: foreign, answer: 'Да' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      answerPendingQuestion(db, { ownerId: userA, pendingId: newId(), answer: 'Да' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      stalePendingQuestion(db, { ownerId: userA, pendingId: newId(), text: STALE_TEXT }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  test('обе судьбы в ленте (запись мимо процедур): процедура сходится с карточкой на ОТВЕТЕ, а не на гашении (ОЧ.8)', async () => {
    const runId = newId();
    const host = await seedEntity(userA, { title: 'Хост двойной судьбы', tags: [] });
    const threadId = await withIdentity(db, userA, (tx) => ensureEntityThread(tx, userA, host.id));
    const pendingId = await askedQuestion(runId, 'Двойная судьба?', undefined, threadId);

    await answerPendingQuestion(db, { ownerId: userA, pendingId, answer: 'Да' });
    await craftStale(pendingId, threadId); // так ляжет только запись мимо процедур

    // Карточка показывает «отвечено» (ОЧ.8) — и процедура обязана говорить то же самое,
    // иначе владельцу отвечают «снят» про вопрос, который в ленте помечен решённым
    expect((await unitsOf(runId))[0]?.fate).toBe('answered');
    expect(await answerPendingQuestion(db, { ownerId: userA, pendingId, answer: 'Да' })).toEqual({
      status: 'answered',
      pendingId,
    });
    expect(await answerPendingQuestion(db, { ownerId: userA, pendingId, answer: 'Нет' })).toEqual({
      status: 'already',
      answer: 'Да',
    });
    expect(await stalePendingQuestion(db, { ownerId: userA, pendingId, text: STALE_TEXT })).toEqual(
      { staled: false },
    );
  });
});

// ---------------------------------------------------------------------------
// Три Minor из гейт-ревью Задачи 2 (рулинг Р2-1 координатора) — тот же файл.
// ---------------------------------------------------------------------------

describe('границы вопроса проверяются при ЗАПИСИ (Minor-2 ревью Задачи 2)', () => {
  test('question длиннее 4000 и больше четырёх вариантов — createPending отказывает VALIDATION до записи; пачка прогона остаётся читаемой', async () => {
    const runId = newId();
    const healthy = await askedQuestion(runId, 'Нормальный вопрос прогона');

    const outOfBounds = async (question: string, options?: string[]) =>
      withIdentity(db, userA, (tx) =>
        createPending(tx, {
          actor: { userId: userA, kind: 'ai', source: 'routine', runId },
          kind: 'question',
          question,
          options,
          level: 'explicit-confirmation',
          dedupeKey: askDedupeKey(runId, question, options),
          clock,
        }),
      );

    // Читатель fail-closed: одна запись мимо границ уронила бы ВСЮ пачку прогона —
    // вместе с гашением и сверкой undecided. Значит их стережёт и писатель
    await expect(outOfBounds('я'.repeat(4001))).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(outOfBounds('')).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(outOfBounds('Пять вариантов', ['1', '2', '3', '4', '5'])).rejects.toMatchObject({
      code: 'VALIDATION',
    });
    await expect(outOfBounds('Длинный вариант', ['ок', 'о'.repeat(201)])).rejects.toMatchObject({
      code: 'VALIDATION',
    });

    // Ни одна из четырёх записей не легла, и пачка читается
    const units = await unitsOf(runId);
    expect(units.map((u) => u.pendingId)).toEqual([healthy]);
  });
});

describe('зеркальный запрет: у действия нет полей вопроса (Minor-3 ревью Задачи 2)', () => {
  test('запись {kind:action, tool, input, question} — fail-closed при ЧТЕНИИ: одиночное чтение по id → VALIDATION «повреждена», проба пачки роняет пачку', async () => {
    const runId = newId();
    const host = await seedEntity(userA, { title: 'Хост гибрида', tags: [] });
    const threadId = await withIdentity(db, userA, (tx) => ensureEntityThread(tx, userA, host.id));
    const hybrid = await craftPending(threadId, {
      id: newId(),
      kind: 'action',
      tool: 'entity_update',
      input: { id: host.id, archived: true },
      question: 'Подпись-гибрид',
      actor_kind: 'ai',
      source: 'routine',
      run_id: runId,
      created_at: T0.toISOString(),
    });

    // Запрет стоит в схеме — значит ловит у ВСЕХ читателей, а не только в RunUnit:
    // и у одиночного чтения по id (approve/reject), и у пробы пачки
    const approved = await approvePending(db, { ownerId: userA, pendingId: hybrid, clock });
    expect(approved.ok).toBe(false);
    if (!approved.ok) {
      expect(approved.error.code).toBe('VALIDATION');
      expect(approved.error.message).toContain('повреждена');
    }
    await expect(unitsOf(runId)).rejects.toMatchObject({ code: 'VALIDATION' });
    // Граф не тронут: гибрид не исполнялся
    expect(await archivedOf(userA, host.id)).toBe(false);
  });
});

describe('listRunUnits: контракт по identity (Minor-1 ревью Задачи 2)', () => {
  test('пин к докблоку: tx одного владельца + ownerId другого → единицы возвращаются, а судьбы молча читаются как open', async () => {
    const runId = newId();
    const pendingId = await askedQuestion(runId, 'Чей это ownerId?');
    await answerPendingQuestion(db, { ownerId: userA, pendingId, answer: 'Владельца A' });
    expect((await unitsOf(runId))[0]?.fate).toBe('answered');

    // Цена рассинхрона, из-за которой докблок и написан: PK судеб считаются от
    // переданного ownerId, а строки читаются под RLS транзакции — судьба не находится,
    // и пачка выглядит навсегда нерешённой («Принять все» повторно жуёт решённое)
    const mismatched = await withIdentity(db, userA, (tx) => listRunUnits(tx, userB, runId));
    expect(mismatched.map((u) => u.pendingId)).toEqual([pendingId]);
    expect(mismatched[0]?.fate).toBe('open');
  });
});
