// Интеграционные тесты pending-подтверждений §7.10 (Task 6): живая БД, без моков.
// Семантика: explicit-confirmation → immutable payload в карточке-запросе, до
// подтверждения НИЧЕГО не записано ни в граф, ни в журнал; approve исполняет
// СОХРАНЁННЫЙ payload полным конвейером executor'а (ревалидация текущего состояния)
// без обращения к LLM; идемпотентность approve — по PK детерминированного
// audit-сообщения (batch-механика §7.8, batch_id = pendingId).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { batchAuditMessageId, globalThreadId, newId, rejectMessageId } from '@orbis/shared';
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
  approvePending,
  createPending,
  rejectedReason,
  rejectPending,
  rejectPendingTx,
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
