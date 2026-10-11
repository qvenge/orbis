// Маркер processing принадлежит разговорам: стабильный id и скрытая инфраструктурная строка.
import { afterAll, expect, test } from 'bun:test';
import { newId, processingMessageId } from '@orbis/shared';
import { eq } from 'drizzle-orm';
import { appDb, freshGraph, personal, requireEnv } from '../../test/helpers';
import { chatMessages } from '../db/schema';
import { withIdentity } from '../db/with-identity';
import { appRouter } from '../router';
import { createCallerFactory } from '../trpc';
import { clearProcessing, markProcessing, processingStartedAt } from './processing';
import { ensureGlobalThread } from './threads';

requireEnv();
const { db, client } = appDb();
afterAll(() => client.end());
test('маркер идемпотентен, хранит время, скрыт из треда и снимается повторно', async () => {
  const graph = await freshGraph();
  const replyTo = newId();
  const now = new Date('2026-10-03T00:00:00Z');
  const threadId = await withIdentity(db, personal(graph), async (tx) => {
    const threadId = await ensureGlobalThread(tx, graph);
    expect(await markProcessing(tx, { threadId, replyTo, now })).toBe(true);
    expect(await markProcessing(tx, { threadId, replyTo, now: new Date(now.getTime() + 1) })).toBe(
      false,
    );
    expect(await processingStartedAt(tx, replyTo)).toEqual(now);
    const [row] = await tx
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.id, processingMessageId(replyTo)));
    expect(row).toMatchObject({
      id: processingMessageId(replyTo),
      role: 'system',
      content: '',
      metadata: { type: 'processing', replyTo },
      createdAt: now,
    });
    return threadId;
  });
  const caller = createCallerFactory(appRouter)({
    identity: personal(graph),
    actorKind: 'owner',
    db,
    clientVersion: null,
  });
  expect(await caller.chat.listMessages({ threadId })).toEqual([]);
  await withIdentity(db, personal(graph), async (tx) => {
    await clearProcessing(tx, replyTo);
    await clearProcessing(tx, replyTo);
    expect(await processingStartedAt(tx, replyTo)).toBeUndefined();
    expect(
      await tx
        .select()
        .from(chatMessages)
        .where(eq(chatMessages.id, processingMessageId(replyTo))),
    ).toEqual([]);
  });
});
