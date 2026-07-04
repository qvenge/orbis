// apps/server/src/executor/journal.test.ts
// Интеграционные тесты Task 11: боевой JournalSink над chat_messages (§7.8) —
// формат action (дословно + атрибуция D11), целевой тред, один audit на batch
// (PK = batchAuditMessageId), идемпотентный повтор без второго сообщения,
// конкурентная PK-гонка одинаковых batch'ей (перенесённое обязательство Task 10).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { batchAuditMessageId, globalThreadId, newId } from '@orbis/shared';
import { sql } from 'drizzle-orm';
import { adminDb, appDb, freshUserId, requireEnv, truncateAll } from '../../test/helpers';
import { ensureEntityThread } from '../chat/threads';
import { withIdentity } from '../db/with-identity';
import { execute } from './executor';
import { makeChatJournalSink } from './journal';
import type { ActionRecord, ExecuteOk, ExecuteRequest, ExecuteResult, WireEntity } from './types';

requireEnv();

const { db, client } = appDb();
const sink = makeChatJournalSink();

beforeAll(async () => {
  await truncateAll();
});

afterAll(async () => {
  await client.end();
});

function ok(r: ExecuteResult): ExecuteOk {
  if (!r.ok) throw new Error(`ожидался успех, получено: ${JSON.stringify(r.error)}`);
  return r;
}

function req(
  user: string,
  tool: string,
  input: unknown,
  over: Partial<ExecuteRequest> = {},
): ExecuteRequest {
  return {
    actorUserId: user,
    actorKind: 'owner',
    source: 'fast_path',
    operations: [{ tool, input }],
    ...over,
  };
}

function batchReq(
  user: string,
  operations: Array<{ tool: string; input: unknown }>,
  batchId: string,
): ExecuteRequest {
  return { actorUserId: user, actorKind: 'owner', source: 'chat', operations, batchId };
}

/** Первый элемент массива с внятным падением (вместо non-null assertion). */
function first<T>(items: readonly T[]): T {
  const v = items[0];
  if (v === undefined) throw new Error('ожидался хотя бы один элемент');
  return v;
}

interface MessageRow {
  id: string;
  thread_id: string;
  role: string;
  content: string;
  metadata: Record<string, unknown>;
}

/** Сообщения треда по created_at (админ-DSN — RLS обходится). */
async function messagesInThread(threadId: string): Promise<MessageRow[]> {
  const { db: admin, client: adminClient } = adminDb();
  try {
    const rows = await admin.execute(
      sql`SELECT id, thread_id, role, content, metadata FROM chat_messages
          WHERE thread_id = ${threadId} ORDER BY created_at, id`,
    );
    return [...rows] as unknown as MessageRow[];
  } finally {
    await adminClient.end();
  }
}

async function adminCount(query: ReturnType<typeof sql>): Promise<number> {
  const { db: admin, client: adminClient } = adminDb();
  try {
    const rows = await admin.execute(query);
    return rows[0]?.n as number;
  } finally {
    await adminClient.end();
  }
}

function actionsOf(msg: MessageRow): ActionRecord[] {
  return (msg.metadata as { actions?: ActionRecord[] }).actions ?? [];
}

describe('боевой JournalSink: audit-сообщение в chat_messages (§7.8)', () => {
  test('1. execute(entity_create, fast_path) без threadId → системное сообщение в глобальном треде; формат action дословно §7.8 + атрибуция', async () => {
    const user = freshUserId();
    const r = ok(
      await execute(db, req(user, 'entity_create', { title: 'Кофе', tags: ['Кофе'] }), { sink }),
    );
    const e = r.results[0] as WireEntity;

    const msgs = await messagesInThread(globalThreadId(user));
    expect(msgs.length).toBe(1); // глобальный тред создан тем же tx, сообщение — в нём
    const msg = first(msgs);
    expect(msg.role).toBe('system');

    const actions = actionsOf(msg);
    expect(actions.length).toBe(1);
    const action = first(actions);
    // все поля формата — и ничего сверх формата
    expect(Object.keys(action).sort()).toEqual([
      'actor_kind',
      'actor_user_id',
      'entity_id',
      'id',
      'inverse',
      'operations',
      'source',
      'type',
    ]);
    expect(action.id).toBe(r.actionId);
    expect(action.type).toBe('entity_created');
    expect(action.entity_id).toBe(e.id);
    expect(action.actor_user_id).toBe(user);
    expect(action.actor_kind).toBe('owner');
    expect(action.source).toBe('fast_path');
    expect(action.operations).toEqual([
      {
        op: 'entity_create',
        payload: {
          id: e.id,
          title: 'Кофе',
          emoji: null,
          body: '',
          tags: ['кофе'],
          meta: {},
          aspects: {},
        },
      },
    ]);
    // §7.8: создание → архивация
    expect(action.inverse).toEqual([
      { op: 'entity_update', payload: { id: e.id, archived: true } },
    ]);
    // карточка действия
    expect((msg.metadata as { cards?: unknown[] }).cards).toEqual([
      { tool: 'entity_create', entity_id: e.id, title: 'Кофе' },
    ]);
  });

  test('2. явный req.threadId: audit-сообщение попадает в указанный тред, не в глобальный', async () => {
    const user = freshUserId();
    const created = ok(
      await execute(db, req(user, 'entity_create', { title: 'Носитель', tags: [] }), { sink }),
    );
    const e = created.results[0] as WireEntity;
    const tid = await withIdentity(db, user, (tx) => ensureEntityThread(tx, user, e.id));

    ok(
      await execute(
        db,
        req(user, 'entity_update', { id: e.id, title: 'Новее' }, { threadId: tid }),
        {
          sink,
        },
      ),
    );

    const inEntityThread = await messagesInThread(tid);
    expect(inEntityThread.length).toBe(1);
    expect(first(actionsOf(first(inEntityThread))).type).toBe('entity_updated');
    // в глобальном — только audit создания
    const inGlobal = await messagesInThread(globalThreadId(user));
    expect(inGlobal.length).toBe(1);
    expect(first(actionsOf(first(inGlobal))).type).toBe('entity_created');
  });

  test('3. batch: ровно одно сообщение с PK = batchAuditMessageId, action.id = batch_id, results сохранены; повтор — idempotentReplay без второго сообщения', async () => {
    const user = freshUserId();
    const batchId = newId();
    const ops = [
      { tool: 'entity_create', input: { title: 'Раз', tags: [] } },
      { tool: 'entity_create', input: { title: 'Два', tags: [] } },
    ];
    const r = ok(await execute(db, batchReq(user, ops, batchId), { sink }));
    expect(r.idempotentReplay).toBe(false);

    const msgs = await messagesInThread(globalThreadId(user));
    expect(msgs.length).toBe(1); // один action на весь batch (§7.8)
    const msg = first(msgs);
    expect(msg.id).toBe(batchAuditMessageId(user, batchId)); // детерминированный PK
    const action = first(actionsOf(msg));
    expect(action.id).toBe(batchId);
    expect(action.type).toBe('batch');
    expect(action.operations.length).toBe(2);
    // results — источник ответа идемпотентного повтора
    expect((msg.metadata as { results?: unknown[] }).results).toEqual(r.results as unknown[]);

    // последовательный повтор того же batch_id: ничего не применяется, сообщение одно
    const replay = ok(await execute(db, batchReq(user, ops, batchId), { sink }));
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.actionId).toBe(batchId);
    expect(replay.results).toEqual(r.results);
    expect((await messagesInThread(globalThreadId(user))).length).toBe(1);
    const n = await adminCount(
      sql`SELECT count(*)::int AS n FROM entities WHERE owner_id = ${user}`,
    );
    expect(n).toBe(2); // данные не задвоены
  });

  test('4. идемпотентный replay одиночного entity_create по client-UUID не пишет второго сообщения (§5.3)', async () => {
    const user = freshUserId();
    const id = newId();
    const input = { id, title: 'Идемпотент', tags: [] };
    ok(await execute(db, req(user, 'entity_create', input), { sink }));
    const again = ok(await execute(db, req(user, 'entity_create', input), { sink }));
    expect(again.idempotentReplay).toBe(true);
    expect((await messagesInThread(globalThreadId(user))).length).toBe(1);
  });

  test('5. КОНКУРЕНТНАЯ гонка одинаковых batch: PK chat_messages — арбитр; один applied, другой idempotentReplay, эффекты одни', async () => {
    const user = freshUserId();
    const batchId = newId();
    // Операции БЕЗ явных id: каждый вызов генерирует свои id сущностей, поэтому
    // единственная точка конфликта конкурентов — PK audit-сообщения
    // (batchAuditMessageId). Гонку разрешает сама БД (23505 → AuditIdConflictError →
    // сохранённый результат), а не тайминг теста: при любом интерливинге вставить
    // audit-строку может ровно одна транзакция.
    const ops = [
      { tool: 'entity_create', input: { title: 'Гонка-А', tags: [] } },
      { tool: 'entity_create', input: { title: 'Гонка-Б', tags: [] } },
    ];
    const [r1, r2] = await Promise.all([
      execute(db, batchReq(user, ops, batchId), { sink }),
      execute(db, batchReq(user, ops, batchId), { sink }),
    ]);
    const o1 = ok(r1);
    const o2 = ok(r2);

    // ровно один applied, другой — idempotentReplay (оба applied невозможны по PK)
    expect([o1.idempotentReplay, o2.idempotentReplay].sort()).toEqual([false, true]);
    expect(o1.actionId).toBe(batchId);
    expect(o2.actionId).toBe(batchId);
    // оба вызова получили консистентный (один и тот же сохранённый) результат
    expect(o1.results).toEqual(o2.results);

    // ровно одно audit-сообщение
    const audits = await adminCount(
      sql`SELECT count(*)::int AS n FROM chat_messages WHERE id = ${batchAuditMessageId(user, batchId)}`,
    );
    expect(audits).toBe(1);
    // ровно один набор эффектов: по одной сущности каждого титула, всего две
    const total = await adminCount(
      sql`SELECT count(*)::int AS n FROM entities WHERE owner_id = ${user}`,
    );
    expect(total).toBe(2);
    for (const title of ['Гонка-А', 'Гонка-Б']) {
      const n = await adminCount(
        sql`SELECT count(*)::int AS n FROM entities WHERE owner_id = ${user} AND title = ${title}`,
      );
      expect(n).toBe(1);
    }
  });
});
