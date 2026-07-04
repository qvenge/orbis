// Интеграционные тесты pending-подтверждений §7.10 (Task 6): живая БД, без моков.
// Семантика: explicit-confirmation → immutable payload в карточке-запросе, до
// подтверждения НИЧЕГО не записано ни в граф, ни в журнал; approve исполняет
// СОХРАНЁННЫЙ payload полным конвейером executor'а (ревалидация текущего состояния)
// без обращения к LLM; идемпотентность approve — по PK детерминированного
// audit-сообщения (batch-механика §7.8, batch_id = pendingId).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { batchAuditMessageId, globalThreadId, newId } from '@orbis/shared';
import { eq, inArray } from 'drizzle-orm';
import { adminDb, appDb, freshUserId, requireEnv, truncateAll } from '../../test/helpers';
import { ensureEntityThread } from '../chat/threads';
import { chatMessages, entities } from '../db/schema';
import { withIdentity } from '../db/with-identity';
import { execute } from '../executor/executor';
import type { ActionRecord, ExecuteResult, WireEntity } from '../executor/types';
import { dispatchTool, type ToolCallCtx } from '../tools/dispatch';
import { approvePending, rejectPending } from './pending';

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
    expect(reject?.role).toBe('system');
    expect(reject?.metadata).toEqual({ type: 'confirmation_rejected', rejects: pendingId });
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
