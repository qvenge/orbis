// Роутер ai: approve/reject pending-подтверждений §7.10 (Task 6).
// Две части: ownerOnly-гейт (§9.3, Task 3) на стабе БД — FORBIDDEN обязан лететь из
// middleware ДО какого-либо обращения к БД; полный цикл против живой БД через
// createCallerFactory (pending создаёт dispatchTool — как это сделает ai.sendMessage).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { newId } from '@orbis/shared';
import { TRPCError } from '@trpc/server';
import { eq } from 'drizzle-orm';
import { appDb, freshUserId, requireEnv, truncateAll } from '../../test/helpers';
import { entities } from '../db/schema';
import { withIdentity } from '../db/with-identity';
import { execute } from '../executor/executor';
import type { WireEntity } from '../executor/types';
import { appRouter } from '../router';
import { dispatchTool } from '../tools/dispatch';
import { type Context, createCallerFactory } from '../trpc';

requireEnv();

const { db, client } = appDb();
const createCaller = createCallerFactory(appRouter);
const userA = freshUserId();
const userB = freshUserId();

function callerFor(user: string) {
  return createCaller({ actorUserId: user, actorKind: 'owner', db, clientVersion: null });
}

beforeAll(async () => {
  await truncateAll();
});

afterAll(async () => {
  await client.end();
});

async function trpcError(p: Promise<unknown>): Promise<TRPCError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof TRPCError) return e;
    throw e;
  }
  throw new Error('ожидался TRPCError, вызов успешен');
}

/** Сид-сущность мимо синка + pending архивации инициативой AI (§7.10, ряд archives). */
async function seedPendingArchive(): Promise<{ target: WireEntity; pendingId: string }> {
  const r = await execute(db, {
    actorUserId: userA,
    actorKind: 'owner',
    source: 'ui',
    operations: [{ tool: 'entity_create', input: { title: 'Цель approve', tags: [] } }],
  });
  if (!r.ok) throw new Error(`seed: ${r.error.code}`);
  const target = r.results[0] as WireEntity;
  const d = await dispatchTool(
    { db, actorUserId: userA, actorKind: 'ai', source: 'chat', explicitCommand: false },
    'entity_update',
    { id: target.id, archived: true },
  );
  if (d.status !== 'pending_confirmation') {
    throw new Error(`ожидался pending_confirmation, получено ${d.status}`);
  }
  return { target, pendingId: d.pendingId };
}

async function archivedOf(id: string): Promise<boolean | undefined> {
  const rows = await withIdentity(db, userA, (tx) =>
    tx.select({ archived: entities.archived }).from(entities).where(eq(entities.id, id)),
  );
  return rows[0]?.archived;
}

describe('ai.approve / ai.reject: ownerOnly (§9.3)', () => {
  test('PAT-агент не может approve/reject: FORBIDDEN из middleware до БД', async () => {
    // db — стаб: если middleware пропустит, вызов упадёт не-FORBIDDEN ошибкой БД
    const agentCtx: Context = {
      actorUserId: freshUserId(),
      actorKind: 'agent',
      db: null as unknown as Context['db'],
      clientVersion: null,
    };
    const agent = createCaller(agentCtx);
    for (const call of [
      () => agent.ai.approve({ pendingId: newId() }),
      () => agent.ai.reject({ pendingId: newId() }),
    ]) {
      const err = await trpcError(call());
      expect(err.code).toBe('FORBIDDEN');
    }
  });
});

describe('ai.approve / ai.reject: полный цикл против живой БД (§7.10)', () => {
  test('approve исполняет сохранённый payload; повторный approve — идемпотентный replay', async () => {
    const { target, pendingId } = await seedPendingArchive();
    const caller = callerFor(userA);

    const r = await caller.ai.approve({ pendingId });
    expect(r.ok).toBe(true);
    expect(r.actionId).toBe(pendingId);
    expect(r.idempotentReplay).toBe(false);
    expect(await archivedOf(target.id)).toBe(true);

    const again = await caller.ai.approve({ pendingId });
    expect(again.idempotentReplay).toBe(true);
    expect(again.results).toEqual(r.results);
  });

  test('approve чужого pendingId (userB) → NOT_FOUND (RLS)', async () => {
    const { pendingId } = await seedPendingArchive();
    const err = await trpcError(callerFor(userB).ai.approve({ pendingId }));
    expect(err.code).toBe('NOT_FOUND');
  });

  test('reject → approve отклонён (BAD_REQUEST), payload не исполнен; повторный reject идемпотентен', async () => {
    const { target, pendingId } = await seedPendingArchive();
    const caller = callerFor(userA);

    const r = await caller.ai.reject({ pendingId });
    expect(r).toEqual({ pendingId, alreadyRejected: false });
    const err = await trpcError(caller.ai.approve({ pendingId }));
    expect(err.code).toBe('BAD_REQUEST'); // VALIDATION «отклонено» маппингом errors.ts
    expect(await archivedOf(target.id)).toBe(false);

    expect(await caller.ai.reject({ pendingId })).toEqual({ pendingId, alreadyRejected: true });
  });

  test('reject уже исполненного pending → BAD_REQUEST; reject чужого → NOT_FOUND', async () => {
    const { pendingId } = await seedPendingArchive();
    const caller = callerFor(userA);
    await caller.ai.approve({ pendingId });

    const err = await trpcError(caller.ai.reject({ pendingId }));
    expect(err.code).toBe('BAD_REQUEST');

    const foreign = await trpcError(callerFor(userB).ai.reject({ pendingId }));
    expect(foreign.code).toBe('NOT_FOUND');
  });
});
