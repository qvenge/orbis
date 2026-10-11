import { afterAll, expect, test } from 'bun:test';
import { pendingMessageId } from '@orbis/shared';
import { eq } from 'drizzle-orm';
import { adminDb, appDb, freshGraph, personal, requireEnv } from '../../test/helpers';
import { ensureEntityThread } from '../chat/threads';
import { chatMessages } from '../db/schema';
import { withIdentity } from '../db/with-identity';
import { threadMessages } from '../journal/thread-page';
import { createPending } from '../policy/pending';
import { appRouter } from '../router';
import { dispatchTool } from '../tools/dispatch';
import { createCallerFactory } from '../trpc';

requireEnv();
const { db, client } = appDb();
const admin = adminDb();
const createCaller = createCallerFactory(appRouter);
afterAll(async () => {
  await client.end();
  await admin.client.end();
});
async function setup() {
  const g = await freshGraph();
  const caller = createCaller({
    identity: personal(g),
    actorKind: 'owner',
    db,
    clientVersion: null,
  });
  const note = await caller.entity.create({
    input: {
      title: 'Заметка',
      tags: [],
      aspects: ['orbis/note'],
      body: '{{title}}\n\nПервая строка текста.\n\nВторая.',
    },
    source: 'ui',
  });
  const task = await caller.entity.create({
    input: {
      title: 'Задача',
      tags: [],
      aspects: ['orbis/task'],
      props: { 'orbis/task_status': 'inbox', 'orbis/due_date': '2026-10-03' },
    },
    source: 'ui',
  });
  return { g, caller, note: note.id, task: task.id };
}
test('entity.query без выбора — без body; start — первая строка; full — тело', async () => {
  const { caller, note, task } = await setup();
  const light = await caller.entity.query({ query: 'aspect=orbis/note' });
  expect(light.some((e) => e.id === note)).toBe(true);
  expect(light.every((e) => !('body' in e) && !('bodyStart' in e))).toBe(true);
  const start = await caller.entity.query({ query: 'aspect=orbis/note', fields: 'start' });
  expect(start.find((e) => e.id === note)?.bodyStart).toBe('Первая строка текста.');
  expect(start.every((e) => !('body' in e))).toBe(true);
  expect(
    (await caller.entity.query({ query: 'aspect=orbis/task', fields: 'start' })).find(
      (e) => e.id === task,
    )?.bodyStart,
  ).toBeNull();
  expect(
    (await caller.entity.query({ query: 'aspect=orbis/note', fields: 'full' })).find(
      (e) => e.id === note,
    )?.body,
  ).toContain('Вторая.');
});
test('entity.blocks: плоские строки и группы выбирают none/start/full', async () => {
  const { caller, note, task } = await setup();
  const r = await caller.entity.blocks({
    blocks: [
      { key: 'light', text: 'aspect=orbis/note' },
      { key: 'start', text: 'aspect=orbis/note', fields: 'start' },
      { key: 'full', text: 'aspect=orbis/note', fields: 'full' },
      { key: 'groups', text: 'aspect=orbis/task, group=day:orbis/due_date' },
      { key: 'groupsStart', text: 'aspect=orbis/task, group=day:orbis/due_date', fields: 'start' },
      { key: 'groupsFull', text: 'aspect=orbis/task, group=day:orbis/due_date', fields: 'full' },
    ],
  });
  const light = r.results.light;
  if (!light?.ok || light.kind !== 'rows') throw new Error('ожидались строки');
  expect(light.rows.some((e) => e.id === note)).toBe(true);
  expect(JSON.stringify(light)).not.toContain('"body"');
  const start = r.results.start;
  if (!start?.ok || start.kind !== 'rows') throw new Error('ожидались строки start');
  expect(start.rows.find((e) => e.id === note)?.bodyStart).toBe('Первая строка текста.');
  const full = r.results.full;
  if (!full?.ok || full.kind !== 'rows') throw new Error('ожидались строки full');
  expect(full.rows.find((e) => e.id === note)?.body).toContain('Вторая.');
  for (const [key, fields] of [
    ['groups', 'none'],
    ['groupsStart', 'start'],
    ['groupsFull', 'full'],
  ] as const) {
    const groups = r.results[key];
    if (!groups?.ok || groups.kind !== 'groups')
      throw new Error(`ожидались группы ${key}: ${JSON.stringify(groups)}`);
    const row = groups.groups.flatMap((g) => g.rows).find((r) => r.entity.id === task);
    expect(row?.at).toEqual({
      slot: null,
      value: '2026-10-03',
      end: null,
      allDay: true,
      untimed: true,
    });
    expect(groups.closedIds).toEqual([]);
    expect('body' in (row?.entity ?? {})).toBe(fields === 'full');
    expect('bodyStart' in (row?.entity ?? {})).toBe(fields === 'start');
    if (fields === 'start') expect(row?.entity.bodyStart).toBeNull();
  }
});
test('entity.get без include — без тела/документа, ревизия сохраняется', async () => {
  const { caller, note } = await setup();
  const bare = await caller.entity.get({ id: note });
  expect('body' in bare.entity).toBe(false);
  expect('bodyDoc' in bare.entity).toBe(false);
  expect(bare.entity.bodyRevision).toBe(1);
  expect(typeof bare.entity.bodyChangedAt).toBe('string');
  expect((await caller.entity.get({ id: note, include: ['body'] })).entity.body).toContain(
    'Первая',
  );
  const doc = (await caller.entity.get({ id: note, include: ['bodyDoc'] })).entity;
  expect('body' in doc).toBe(false);
  expect(doc.bodyDoc).toBeDefined();
});
test('MCP entity_query — лёгкий; full/start явны; entity_get сохраняет тело', async () => {
  const { g, caller, note } = await setup();
  const agent = {
    db,
    identity: personal(g),
    actorKind: 'agent' as const,
    source: 'mcp' as const,
    explicitCommand: false,
    clock: () => new Date(),
  };
  const q = await dispatchTool(agent, 'entity_query', { query: 'aspect=orbis/note' });
  expect(q.status).toBe('ok');
  expect(JSON.stringify(q.status === 'ok' ? q.result : null)).not.toContain('"body"');
  const qf = await dispatchTool(agent, 'entity_query', {
    query: 'aspect=orbis/note',
    fields: 'full',
  });
  expect(JSON.stringify(qf.status === 'ok' ? qf.result : null)).toContain('Вторая.');
  const qs = await dispatchTool(agent, 'entity_query', {
    query: 'aspect=orbis/note',
    fields: 'start',
  });
  expect(JSON.stringify(qs.status === 'ok' ? qs.result : null)).toContain('Первая строка текста.');
  const got = await dispatchTool(agent, 'entity_get', { id: note });
  expect(
    got.status === 'ok' ? (got.result as { entity: { body?: string } }).entity.body : '',
  ).toContain('Первая');
  expect((await caller.entity.get({ id: note })).entity).not.toHaveProperty('body');
});
test('pending.input уходит лишь из клиентской проекции; карточки, storage и модель сохраняются', async () => {
  const { g, caller, note } = await setup();
  const threadId = await withIdentity(db, personal(g), (tx) => ensureEntityThread(tx, g, note));
  await withIdentity(db, personal(g), (tx) =>
    createPending(tx, {
      actor: { graphId: g, kind: 'ai', source: 'chat' },
      tool: 'entity_update',
      input: { id: note, body: 'предлагаемый текст' },
      level: 'explicit-confirmation',
      threadId,
      dedupeKey: 'fields-projection',
      card: {
        kind: 'confirmation_card',
        mode: 'explicit',
        pendingId: pendingMessageId(g, 'fields-projection'),
        summary: 'Правка текста',
        diff: { body: { before: 'старый текст', after: 'предлагаемый текст' } },
      },
      clock: () => new Date(),
    }),
  );
  const isPending = (m: { metadata: Record<string, unknown> }) => m.metadata.pending !== undefined;
  const wire = (await caller.chat.listMessages({ threadId })).find(isPending);
  expect(wire).toBeDefined();
  expect(wire?.metadata.pending).not.toHaveProperty('input');
  expect(wire?.metadata.pending).toHaveProperty('tool', 'entity_update');
  const [row] = await admin.db
    .select()
    .from(chatMessages)
    .where(eq(chatMessages.id, wire?.id ?? ''));
  expect(wire?.metadata.cards).toEqual((row?.metadata as Record<string, unknown>).cards);
  expect(JSON.stringify(wire?.metadata.cards)).toContain('предлагаемый текст');
  expect(row?.metadata).toHaveProperty('pending.input.body', 'предлагаемый текст');
  const model = await withIdentity(db, personal(g), (tx) =>
    threadMessages(tx, threadId, { limit: 50 }),
  );
  expect(model.find(isPending)?.metadata.pending).toHaveProperty(
    'input.body',
    'предлагаемый текст',
  );
  const viaGet = await caller.entity.get({ id: note, include: ['thread'] });
  expect(viaGet.thread?.messages.find(isPending)?.metadata.pending).not.toHaveProperty('input');
});

test('start читает только первые восемь верхних узлов документа', async () => {
  const { caller } = await setup();
  const outside = await caller.entity.create({
    input: {
      title: 'За границей головы',
      tags: [],
      aspects: ['orbis/note'],
      body: `${'{{title}}\n\n'.repeat(8)}Девятый узел`,
    },
    source: 'ui',
  });
  const start = await caller.entity.query({ query: 'aspect=orbis/note', fields: 'start' });
  expect(start.find((e) => e.id === outside.id)?.bodyStart).toBeNull();
});
