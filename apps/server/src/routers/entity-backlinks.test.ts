// apps/server/src/routers/entity-backlinks.test.ts
// Task D5 (02-core-os §3.5.7, sign-off владельца K1): отдельной процедуры entity.backlinks
// НЕТ — расширен существующий include:['backlinks'] в entity-read.ts. Секция объединённая:
// явные related_to обеих сторон (via 'relation') + упоминания по body_refs (via 'mention'),
// без архивных, потолок 100. Контракт readEntity общий с LLM/MCP-диспатчем (tools/dispatch),
// поэтому форма ответа пиннится здесь.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { adminDb, appDb, freshUserId, requireEnv, truncateAll } from '../../test/helpers';
import { appRouter } from '../router';
import { createCallerFactory } from '../trpc';

requireEnv();

const { db, client } = appDb();
const createCaller = createCallerFactory(appRouter);

function callerFor(user: string) {
  return createCaller({ actorUserId: user, actorKind: 'owner', db, clientVersion: null });
}

beforeAll(async () => {
  await truncateAll();
});

afterAll(async () => {
  await client.end();
});

/** id → пометка источника: порядок выдачи в утверждениях не фиксируем. */
function viaById(backlinks: { entity: { id: string }; via: string }[] | undefined) {
  return new Map((backlinks ?? []).map((b) => [b.entity.id, b.via]));
}

test('backlinks: явные related_to обеих сторон + упоминания body_refs с пометкой источника', async () => {
  const user = freshUserId();
  const caller = callerFor(user);
  const target = await caller.entity.create({
    input: { title: 'Цель', tags: [] },
    source: 'fast_path',
  });
  const asSource = await caller.entity.create({
    input: { title: 'Связь от источника', tags: [] },
    source: 'fast_path',
  });
  const asTarget = await caller.entity.create({
    input: { title: 'Связь к цели', tags: [] },
    source: 'fast_path',
  });
  const mention = await caller.entity.create({
    input: { title: 'Упоминание', tags: [], body: `см. [[entity:${target.id}]]` },
    source: 'fast_path',
  });
  // связь «в цель» и связь «из цели» — обе стороны related_to попадают в секцию
  await caller.relation.create({
    source_id: asSource.id,
    target_id: target.id,
    relation_type: 'related_to',
  });
  await caller.relation.create({
    source_id: target.id,
    target_id: asTarget.id,
    relation_type: 'related_to',
  });
  // blocks-связь backlinks'ом НЕ является: она живёт в секции «Блокировки» (§3.5.6)
  const blocker = await caller.entity.create({
    input: { title: 'Блокер', tags: [] },
    source: 'fast_path',
  });
  await caller.relation.create({
    source_id: blocker.id,
    target_id: target.id,
    relation_type: 'blocks',
  });

  const got = await caller.entity.get({ id: target.id, include: ['backlinks'] });
  const via = viaById(got.backlinks);
  expect(via.get(asSource.id)).toBe('relation');
  expect(via.get(asTarget.id)).toBe('relation');
  expect(via.get(mention.id)).toBe('mention');
  expect(via.has(blocker.id)).toBe(false);
  expect(via.size).toBe(3);
});

test('backlinks: и связь, и упоминание одной сущностью → одна строка с пометкой «связь»', async () => {
  const user = freshUserId();
  const caller = callerFor(user);
  const target = await caller.entity.create({
    input: { title: 'Цель', tags: [] },
    source: 'fast_path',
  });
  const both = await caller.entity.create({
    input: { title: 'И связь, и упоминание', tags: [], body: `[[entity:${target.id}]]` },
    source: 'fast_path',
  });
  await caller.relation.create({
    source_id: both.id,
    target_id: target.id,
    relation_type: 'related_to',
  });

  const got = await caller.entity.get({ id: target.id, include: ['backlinks'] });
  expect(got.backlinks?.map((b) => b.entity.id)).toEqual([both.id]);
  expect(got.backlinks?.[0]?.via).toBe('relation');
});

test('backlinks: архивные исключены (обе стороны — и связь, и упоминание)', async () => {
  const user = freshUserId();
  const caller = callerFor(user);
  const target = await caller.entity.create({
    input: { title: 'Цель', tags: [] },
    source: 'fast_path',
  });
  const relArchived = await caller.entity.create({
    input: { title: 'Архивная связь', tags: [] },
    source: 'fast_path',
  });
  const mentionArchived = await caller.entity.create({
    input: { title: 'Архивное упоминание', tags: [], body: `[[entity:${target.id}]]` },
    source: 'fast_path',
  });
  await caller.relation.create({
    source_id: relArchived.id,
    target_id: target.id,
    relation_type: 'related_to',
  });
  await caller.entity.update({ id: relArchived.id, archived: true });
  await caller.entity.update({ id: mentionArchived.id, archived: true });

  const got = await caller.entity.get({ id: target.id, include: ['backlinks'] });
  expect(got.backlinks).toEqual([]);
});

test('backlinks: чужая сущность недостижима (RLS)', async () => {
  const owner = freshUserId();
  const stranger = freshUserId();
  const target = await callerFor(owner).entity.create({
    input: { title: 'Моя цель', tags: [] },
    source: 'fast_path',
  });
  // Чужой владелец ссылается на мою сущность в своём body — body_refs заполнены,
  // но строка entities под RLS невидима: в моей секции её быть не должно.
  await callerFor(stranger).entity.create({
    input: { title: 'Чужая ссылающаяся', tags: [], body: `[[entity:${target.id}]]` },
    source: 'fast_path',
  });

  const got = await callerFor(owner).entity.get({ id: target.id, include: ['backlinks'] });
  expect(got.backlinks).toEqual([]);
});

test('backlinks: потолок 100 строк', async () => {
  const user = freshUserId();
  const caller = callerFor(user);
  const target = await caller.entity.create({
    input: { title: 'Популярная', tags: [] },
    source: 'fast_path',
  });
  // 105 упоминаний — сырым админ-соединением: 105 вызовов роутера тест не оправдывают
  const { db: admin, client: adminClient } = adminDb();
  try {
    await admin.execute(sql`
      INSERT INTO entities (id, owner_id, title, body, body_refs)
      SELECT gen_random_uuid(), ${user}::uuid, 'Ссылка ' || g, '', ARRAY[${target.id}]::text[]
      FROM generate_series(1, 105) AS g
    `);
  } finally {
    await adminClient.end();
  }

  const got = await caller.entity.get({ id: target.id, include: ['backlinks'] });
  expect(got.backlinks?.length).toBe(100);
});
