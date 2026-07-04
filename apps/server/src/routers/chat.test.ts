// apps/server/src/routers/chat.test.ts
// Интеграционные тесты Task 12: роутеры chat (треды §4.5, сообщения §4.6) и ai (undo §7.8)
// через createCallerFactory против живой БД. Мутации entity идут боевым синком —
// audit-сообщения видны в тредах (§7.8).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { entityThreadId, globalThreadId, newId } from '@orbis/shared';
import { TRPCError } from '@trpc/server';
import { appDb, freshUserId, requireEnv, truncateAll } from '../../test/helpers';
import type { ActionRecord } from '../executor/types';
import { appRouter } from '../router';
import { createCallerFactory } from '../trpc';

requireEnv();

const { db, client } = appDb();
const createCaller = createCallerFactory(appRouter);

function callerFor(user: string) {
  return createCaller({ actorUserId: user, db });
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

describe('chat.ensureThread (§4.5)', () => {
  test('без entityId — глобальный тред с детерминированным id; вызов идемпотентен', async () => {
    const user = freshUserId();
    const caller = callerFor(user);
    const t1 = await caller.chat.ensureThread({});
    expect(t1).toEqual({ threadId: globalThreadId(user) });
    expect(await caller.chat.ensureThread({})).toEqual(t1);
  });

  test('с entityId — тред сущности; несуществующая сущность → NOT_FOUND', async () => {
    const user = freshUserId();
    const caller = callerFor(user);
    const e = await caller.entity.create({
      input: { title: 'Носитель треда', tags: [] },
      source: 'fast_path',
    });
    expect(await caller.chat.ensureThread({ entityId: e.id })).toEqual({
      threadId: entityThreadId(user, e.id),
    });
    const err = await trpcError(caller.chat.ensureThread({ entityId: crypto.randomUUID() }));
    expect(err.code).toBe('NOT_FOUND');
  });
});

describe('chat.appendUserMessage / chat.listMessages (§4.6)', () => {
  test('append → list по created_at DESC; limit и before; wire-таймстампы UTC Z', async () => {
    const user = freshUserId();
    const caller = callerFor(user);
    const { threadId } = await caller.chat.ensureThread({});

    const m1 = await caller.chat.appendUserMessage({
      id: newId(),
      threadId,
      content: 'первое',
    });
    expect(m1.role).toBe('user');
    expect(m1.createdAt.endsWith('Z')).toBe(true);
    await Bun.sleep(10); // разводим created_at: курсор before — ms-точность wire-формы
    const m2 = await caller.chat.appendUserMessage({
      id: newId(),
      threadId,
      content: 'второе',
    });

    const all = await caller.chat.listMessages({ threadId });
    expect(all.map((m) => m.content)).toEqual(['второе', 'первое']); // created_at DESC

    expect((await caller.chat.listMessages({ threadId, limit: 1 })).map((m) => m.id)).toEqual([
      m2.id,
    ]);
    // before — курсор по createdAt (wire-форма самого старого загруженного)
    expect(
      (await caller.chat.listMessages({ threadId, before: m2.createdAt })).map((m) => m.id),
    ).toEqual([m1.id]);
  });

  test('чужой тред: append → NOT_FOUND (RLS: чужое и несуществующее неразличимы)', async () => {
    const owner = freshUserId();
    const stranger = freshUserId();
    const { threadId } = await callerFor(owner).chat.ensureThread({});
    const err = await trpcError(
      callerFor(stranger).chat.appendUserMessage({ id: newId(), threadId, content: 'взлом' }),
    );
    expect(err.code).toBe('NOT_FOUND');
    // и список чужого треда пуст — RLS скрывает сообщения
    expect(await callerFor(stranger).chat.listMessages({ threadId })).toEqual([]);
  });
});

describe('ai.undo / ai.undoLast (§7.8)', () => {
  test('undoLast гасит последний create: сущность архивирована, actionId — отменённого действия', async () => {
    const user = freshUserId();
    const caller = callerFor(user);
    const created = await caller.entity.create({
      input: { title: 'Отменяемая', tags: [] },
      source: 'fast_path',
    });

    // action попал в глобальный тред боевым синком (§7.8)
    const audit = await caller.chat.listMessages({ threadId: globalThreadId(user) });
    const actions = (audit[0]?.metadata as { actions?: ActionRecord[] }).actions ?? [];
    const action = actions[0];
    if (!action) throw new Error('ожидался action в журнале');

    const undone = await caller.ai.undoLast();
    expect(undone.ok).toBe(true);
    expect(undone.actionId).toBe(action.id);

    // inverse create — архивация (§7.8)
    const got = await caller.entity.get({ id: created.id });
    expect(got.entity.archived).toBe(true);

    // неотменённых действий больше нет (undo не порождает нового action)
    const empty = await trpcError(caller.ai.undoLast());
    expect(empty.code).toBe('NOT_FOUND');
  });

  test('undo по actionId; повторная отмена → BAD_REQUEST (уже отменено)', async () => {
    const user = freshUserId();
    const caller = callerFor(user);
    const created = await caller.entity.create({
      input: { title: 'Точечная отмена', tags: [] },
      source: 'quick_capture',
    });
    const audit = await caller.chat.listMessages({ threadId: globalThreadId(user) });
    const action = ((audit[0]?.metadata as { actions?: ActionRecord[] }).actions ?? [])[0];
    if (!action) throw new Error('ожидался action в журнале');

    const undone = await caller.ai.undo({ actionId: action.id });
    expect(undone.ok).toBe(true);
    expect((await caller.entity.get({ id: created.id })).entity.archived).toBe(true);

    const again = await trpcError(caller.ai.undo({ actionId: action.id }));
    expect(again.code).toBe('BAD_REQUEST');

    // несуществующий actionId → NOT_FOUND
    const missing = await trpcError(caller.ai.undo({ actionId: crypto.randomUUID() }));
    expect(missing.code).toBe('NOT_FOUND');
  });
});
