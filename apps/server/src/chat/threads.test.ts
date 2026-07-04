// apps/server/src/chat/threads.test.ts
// Интеграционные тесты Task 11 (§4.5, §13.3): детерминированные ID тредов,
// идемпотентность ensure*, конкурентная сходимость к одной строке, RLS чужого треда.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { entityThreadId, globalThreadId, newId } from '@orbis/shared';
import { sql } from 'drizzle-orm';
import { adminDb, appDb, freshUserId, requireEnv, truncateAll } from '../../test/helpers';
import { entities } from '../db/schema';
import { withIdentity } from '../db/with-identity';
import { appendMessage } from './messages';
import { ensureEntityThread, ensureGlobalThread } from './threads';

requireEnv();

const { db, client } = appDb();
const userA = freshUserId();
const userB = freshUserId();

beforeAll(async () => {
  await truncateAll();
});

afterAll(async () => {
  await client.end();
});

/** Строки chat_threads по владельцу/сущности (админ-DSN — RLS обходится, видим всё). */
async function threadRows(
  ownerId: string,
  entityId: string | null,
): Promise<Array<Record<string, unknown>>> {
  const { db: admin, client: adminClient } = adminDb();
  try {
    const rows =
      entityId === null
        ? await admin.execute(
            sql`SELECT id FROM chat_threads WHERE owner_id = ${ownerId} AND entity_id IS NULL`,
          )
        : await admin.execute(
            sql`SELECT id FROM chat_threads WHERE owner_id = ${ownerId} AND entity_id = ${entityId}`,
          );
    return [...rows];
  } finally {
    await adminClient.end();
  }
}

/** Сущность-носитель треда напрямую (без executor'а — chat-модуль от него не зависит). */
async function createEntityRow(ownerId: string): Promise<string> {
  const id = newId();
  await withIdentity(db, ownerId, (tx) =>
    tx.insert(entities).values({ id, ownerId, title: 'Тред-носитель' }),
  );
  return id;
}

describe('ensureGlobalThread (§4.5)', () => {
  test('создаёт глобальный тред с детерминированным id; повторный вызов идемпотентен', async () => {
    const expected = globalThreadId(userA);
    const first = await withIdentity(db, userA, (tx) => ensureGlobalThread(tx, userA));
    const second = await withIdentity(db, userA, (tx) => ensureGlobalThread(tx, userA));
    expect(first).toBe(expected);
    expect(second).toBe(expected);
    const rows = await threadRows(userA, null);
    expect(rows.length).toBe(1); // partial unique: один глобальный тред на пользователя
    expect(rows[0]?.id).toBe(expected);
  });
});

describe('ensureEntityThread (§4.5, §13.3)', () => {
  test('конкурентные вызовы сходятся к одной строке с детерминированным id (§13.3)', async () => {
    const entityId = await createEntityRow(userA);
    const expected = entityThreadId(userA, entityId);
    // Две параллельные транзакции: обе INSERT … ON CONFLICT DO NOTHING + SELECT.
    // Инвариант «ровно одна строка» обеспечивает PK/unique БД, а не тайминг теста:
    // при любом интерливинге проигравшая вставка гасится конфликтом и читает строку.
    const [t1, t2] = await Promise.all([
      withIdentity(db, userA, (tx) => ensureEntityThread(tx, userA, entityId)),
      withIdentity(db, userA, (tx) => ensureEntityThread(tx, userA, entityId)),
    ]);
    expect(t1).toBe(expected);
    expect(t2).toBe(expected);
    const rows = await threadRows(userA, entityId);
    expect(rows.length).toBe(1); // ровно одна строка (§13.3)
    expect(rows[0]?.id).toBe(expected);
  });

  test('чужая/несуществующая сущность → NOT_FOUND (RLS делает их неразличимыми)', async () => {
    const entityId = await createEntityRow(userA);
    await expect(
      withIdentity(db, userB, (tx) => ensureEntityThread(tx, userB, entityId)),
    ).rejects.toThrow('сущность не найдена');
  });
});

describe('appendMessage (§4.6)', () => {
  test('append-only вставка возвращает wire-форму с ISO createdAt', async () => {
    const threadId = await withIdentity(db, userA, (tx) => ensureGlobalThread(tx, userA));
    const id = newId();
    const msg = await withIdentity(db, userA, (tx) =>
      appendMessage(tx, {
        id,
        threadId,
        role: 'user',
        content: 'привет',
        metadata: { foo: 'bar' },
      }),
    );
    expect(msg).toEqual({
      id,
      threadId,
      role: 'user',
      content: 'привет',
      metadata: { foo: 'bar' },
      createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
    });
  });

  test('RLS: сообщение в чужой тред под userB отклоняется политикой БД (§13, п.5)', async () => {
    const threadA = await withIdentity(db, userA, (tx) => ensureGlobalThread(tx, userA));
    await expect(
      withIdentity(db, userB, (tx) =>
        appendMessage(tx, { id: newId(), threadId: threadA, role: 'user', content: 'взлом' }),
      ),
    ).rejects.toThrow();
    // и сообщение не появилось
    const { db: admin, client: adminClient } = adminDb();
    try {
      const rows = await admin.execute(
        sql`SELECT count(*)::int AS n FROM chat_messages WHERE thread_id = ${threadA} AND content = ${'взлом'}`,
      );
      expect(rows[0]?.n).toBe(0);
    } finally {
      await adminClient.end();
    }
  });
});
