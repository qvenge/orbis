// apps/server/src/routers/entity.test.ts
// Интеграционные тесты Task 12: роутеры entity/relation через createCallerFactory
// против живой БД. Роутеры — только трансляция: вход → executor/компилятор,
// результат → wire, ошибки executor'а → TRPCError (§9.1, §5.2, §6.4).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { entitySchema, entityThreadId, globalThreadId } from '@orbis/shared';
import { TRPCError } from '@trpc/server';
import { sql } from 'drizzle-orm';
import { adminDb, appDb, freshUserId, requireEnv, truncateAll } from '../../test/helpers';
import type { ActionRecord } from '../executor/types';
import { appRouter } from '../router';
import { createCallerFactory } from '../trpc';

requireEnv();

const { db, client } = appDb();
const createCaller = createCallerFactory(appRouter);

/** Caller от лица владельца: ctx как в бою — actorUserId + db (§9.1). */
function callerFor(user: string) {
  return createCaller({ actorUserId: user, actorKind: 'owner', db, clientVersion: null });
}

beforeAll(async () => {
  await truncateAll();
});

afterAll(async () => {
  await client.end();
});

/** Ошибка вызова процедуры — TRPCError с внятным падением при успехе. */
async function trpcError(p: Promise<unknown>): Promise<TRPCError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof TRPCError) return e;
    throw e;
  }
  throw new Error('ожидался TRPCError, вызов успешен');
}

describe('entity.create / entity.get (§9.2)', () => {
  test('create→get круговой: аспекты сохранены, wire-форма проходит entitySchema', async () => {
    const user = freshUserId();
    const caller = callerFor(user);
    const created = await caller.entity.create({
      input: {
        title: 'Разобрать входящие',
        tags: ['Task', 'task'],
        body: 'Текст задачи',
        aspects: { 'orbis/task': { status: 'inbox' } },
      },
      source: 'fast_path',
    });
    expect(() => entitySchema.parse(created)).not.toThrow();
    expect(created.ownerId).toBe(user);
    expect(created.tags).toEqual(['task']); // нормализация executor'а, не роутера
    expect(created.createdAt.endsWith('Z')).toBe(true);
    // actionId — аддитивное поле поверх wire-сущности (Undo из UI-форм, 03-budget §3.6)
    const { actionId, ...createdEntity } = created;
    expect(typeof actionId).toBe('string');

    const got = await caller.entity.get({ id: created.id });
    expect(got.entity).toEqual(createdEntity);
    expect(got.entity.aspects['orbis/task']).toEqual({ status: 'inbox' });
    // include default — body+relations; backlinks/thread не запрошены (§9.2)
    expect(got.relations).toEqual([]);
    expect(got.backlinks).toBeUndefined();
    expect(got.thread).toBeUndefined();
  });

  test('невалидный source create отклоняется на входе (zod роутера) → BAD_REQUEST', async () => {
    const caller = callerFor(freshUserId());
    const e = await trpcError(
      caller.entity.create({
        input: { title: 'X', tags: [] },
        // @ts-expect-error: 'chat' не входит в enum клиентских источников create
        source: 'chat',
      }),
    );
    expect(e.code).toBe('BAD_REQUEST');
  });

  test('create с client-UUID, занятым чужой сущностью → CONFLICT (409), id_conflict в cause', async () => {
    // Единый wire-контракт id_conflict (финальное ревью): entity_create маппится
    // на тот же CONFLICT/409, что и chat.appendMessage — 1b MCP и 1c retry-буфер
    // ключуются на кодах, а не на текстах.
    const owner = callerFor(freshUserId());
    const created = await owner.entity.create({
      input: { title: 'Своя', tags: [] },
      source: 'fast_path',
    });
    const e = await trpcError(
      callerFor(freshUserId()).entity.create({
        input: { id: created.id, title: 'Чужая', tags: [] },
        source: 'fast_path',
      }),
    );
    expect(e.code).toBe('CONFLICT');
    const cause = e.cause as unknown as { code: string; details?: { reason?: string } };
    expect(cause.code).toBe('CONFLICT');
    expect(cause.details?.reason).toBe('id_conflict');
  });

  test('actionId из create пригоден для ai.undo; идемпотентный replay actionId не отдаёт (03 §3.6)', async () => {
    const caller = callerFor(freshUserId());
    const id = crypto.randomUUID();
    const created = await caller.entity.create({
      input: { id, title: 'Обед 340', tags: [] },
      source: 'quick_capture',
    });
    expect(typeof created.actionId).toBe('string');

    // Повтор того же client-UUID владельцем — идемпотентный replay (§5.3): журнал
    // не писался, actionId под этим запросом не существует → поле отсутствует.
    const replayed = await caller.entity.create({
      input: { id, title: 'Обед 340', tags: [] },
      source: 'quick_capture',
    });
    expect(replayed.id).toBe(id);
    expect(replayed.actionId).toBeUndefined();

    // Undo по actionId откатывает создание (инверсия — архивация, §7.8)
    const r = await caller.ai.undo({ actionId: created.actionId as string });
    expect(r.ok).toBe(true);
    const got = await caller.entity.get({ id });
    expect(got.entity.archived).toBe(true);
  });

  test('get несуществующей (или чужой под RLS) сущности → NOT_FOUND', async () => {
    const caller = callerFor(freshUserId());
    const e = await trpcError(caller.entity.get({ id: crypto.randomUUID() }));
    expect(e.code).toBe('NOT_FOUND');
  });

  test('get include=backlinks: WHERE body_refs @> ARRAY[id]', async () => {
    const user = freshUserId();
    const caller = callerFor(user);
    const target = await caller.entity.create({
      input: { title: 'Цель ссылки', tags: [] },
      source: 'fast_path',
    });
    const referrer = await caller.entity.create({
      input: { title: 'Ссылающаяся', tags: [], body: `см. [[entity:${target.id}]]` },
      source: 'fast_path',
    });
    const got = await caller.entity.get({ id: target.id, include: ['backlinks'] });
    expect(got.backlinks?.map((b) => b.id)).toEqual([referrer.id]);
    expect(got.relations).toBeUndefined(); // include явный — relations не запрошены
  });

  test('get include=thread: детерминированный entityThreadId, лениво НЕ создаёт', async () => {
    const user = freshUserId();
    const caller = callerFor(user);
    const e = await caller.entity.create({
      input: { title: 'С тредом', tags: [] },
      source: 'quick_capture',
    });
    const got = await caller.entity.get({ id: e.id, include: ['thread'] });
    expect(got.thread).toEqual({ threadId: entityThreadId(user, e.id), messages: [] });

    // тред НЕ создан (лениво): в chat_threads строки нет
    const { db: admin, client: adminClient } = adminDb();
    try {
      const rows = await admin.execute(
        sql`SELECT count(*)::int AS n FROM chat_threads WHERE id = ${entityThreadId(user, e.id)}`,
      );
      expect(rows[0]?.n).toBe(0);
    } finally {
      await adminClient.end();
    }
  });
});

describe('entity.update: optimistic-check §5.2 (перенесённый контракт optimistic-check)', () => {
  test('stale expectedUpdatedAt → CONFLICT; повтор со свежим — успех; tags — LWW без проверки', async () => {
    const user = freshUserId();
    const caller = callerFor(user);
    const created = await caller.entity.create({
      input: { title: 'Документ', tags: [], body: 'v1' },
      source: 'fast_path',
    });

    // Конкурентная правка body сдвигает updated_at
    const fresh = await caller.entity.update({
      id: created.id,
      body: 'v2',
      expectedUpdatedAt: created.updatedAt,
    });
    expect(fresh.body).toBe('v2');

    // Правка с устаревшей версией — 409 CONFLICT, исходная ошибка в cause
    const e = await trpcError(
      caller.entity.update({ id: created.id, body: 'v3', expectedUpdatedAt: created.updatedAt }),
    );
    expect(e.code).toBe('CONFLICT');
    expect((e.cause as unknown as { code: string }).code).toBe('STALE_VERSION');

    // Повтор со свежим updated_at — успех
    const v3 = await caller.entity.update({
      id: created.id,
      body: 'v3',
      expectedUpdatedAt: fresh.updatedAt,
    });
    expect(v3.body).toBe('v3');

    // tags — LWW: без expectedUpdatedAt применяется поверх любых версий
    const tagged = await caller.entity.update({ id: created.id, tags: ['Приоритет'] });
    expect(tagged.tags).toEqual(['приоритет']);
    expect(tagged.body).toBe('v3'); // body не тронут

    // body без expectedUpdatedAt — VALIDATION → BAD_REQUEST (§5.2)
    const noCheck = await trpcError(caller.entity.update({ id: created.id, body: 'v4' }));
    expect(noCheck.code).toBe('BAD_REQUEST');
  });

  test('audit-сообщение update атрибутировано source=ui (прямое действие владельца в UI, не fast_path)', async () => {
    const user = freshUserId();
    const caller = callerFor(user);
    const created = await caller.entity.create({
      input: { title: 'Атрибуция', tags: [] },
      source: 'fast_path',
    });
    await caller.entity.update({ id: created.id, title: 'Атрибуция 2' });

    // audit обоих действий — в глобальном треде владельца (роутер не шлёт threadId, §7.8)
    const { db: admin, client: adminClient } = adminDb();
    try {
      const rows = await admin.execute(
        sql`SELECT metadata FROM chat_messages
            WHERE thread_id = ${globalThreadId(user)} ORDER BY created_at, id`,
      );
      const actionOf = (r: (typeof rows)[number]) =>
        (r.metadata as { actions?: ActionRecord[] }).actions?.[0];
      const updateMsg = [...rows].find((r) => actionOf(r)?.type === 'entity_updated');
      const action = updateMsg ? actionOf(updateMsg) : undefined;
      expect(action?.source).toBe('ui');
      // create по-прежнему несёт клиентский source (fast_path), не 'ui'
      const createMsg = [...rows].find((r) => actionOf(r)?.type === 'entity_created');
      expect((createMsg ? actionOf(createMsg) : undefined)?.source).toBe('fast_path');
    } finally {
      await adminClient.end();
    }
  });
});

describe('entity.query / entity.count (§6.3–6.4)', () => {
  test('query блока Inbox (02 §3.3) находит созданную задачу', async () => {
    const user = freshUserId();
    const caller = callerFor(user);
    const created = await caller.entity.create({
      input: { title: 'Входящая задача', tags: [], aspects: { 'orbis/task': { status: 'inbox' } } },
      source: 'fast_path',
    });
    const rows = await caller.entity.query({
      query: 'aspect=orbis/task, status=inbox, sortBy=created_at:desc, display=list, title=Inbox',
    });
    expect(rows.map((r) => r.id)).toEqual([created.id]);
    expect(() => entitySchema.parse(rows[0])).not.toThrow(); // wire-форма и у query-выдачи
  });

  test('count игнорирует limit (бейджи 02 §3.2), query — нет', async () => {
    const user = freshUserId();
    const caller = callerFor(user);
    for (const title of ['Одна', 'Две', 'Три']) {
      await caller.entity.create({
        input: { title, tags: [], aspects: { 'orbis/task': { status: 'inbox' } } },
        source: 'fast_path',
      });
    }
    const q = 'aspect=orbis/task, status=inbox, limit=1';
    expect((await caller.entity.query({ query: q })).length).toBe(1);
    expect(await caller.entity.count({ query: q })).toEqual({ count: 3 });
  });

  test('невалидный запрос → BAD_REQUEST с {message, position} в cause (§6.4)', async () => {
    const caller = callerFor(freshUserId());
    const e = await trpcError(caller.entity.query({ query: 'nosuchfield=42' }));
    expect(e.code).toBe('BAD_REQUEST');
    const cause = e.cause as unknown as { message: string; position: number };
    expect(typeof cause.message).toBe('string');
    expect(cause.position).toBe(0); // неизвестное поле — позиция его начала
    // count — тот же контракт ошибок
    const e2 = await trpcError(caller.entity.count({ query: 'nosuchfield=42' }));
    expect(e2.code).toBe('BAD_REQUEST');
  });
});

describe('relation.create / relation.delete / relation.listFor (§4.2)', () => {
  test('listFor видит обе стороны; delete → { ok: true }; самосвязь → UNPROCESSABLE_CONTENT', async () => {
    const user = freshUserId();
    const caller = callerFor(user);
    const a = await caller.entity.create({ input: { title: 'A', tags: [] }, source: 'fast_path' });
    const b = await caller.entity.create({ input: { title: 'B', tags: [] }, source: 'fast_path' });
    const c = await caller.entity.create({ input: { title: 'C', tags: [] }, source: 'fast_path' });

    const ab = await caller.relation.create({
      source_id: a.id,
      target_id: b.id,
      relation_type: 'related_to',
    });
    expect(ab.sourceId).toBe(a.id);
    expect(ab.createdAt.endsWith('Z')).toBe(true);
    const ca = await caller.relation.create({
      source_id: c.id,
      target_id: a.id,
      relation_type: 'parent',
    });

    // обе стороны: A — source в ab и target в ca
    const forA = await caller.relation.listFor({ entityId: a.id });
    expect(forA.map((r) => r.id).sort()).toEqual([ab.id, ca.id].sort());
    // у get default include relations — те же обе стороны
    const got = await caller.entity.get({ id: a.id });
    expect(got.relations?.map((r) => r.id).sort()).toEqual([ab.id, ca.id].sort());

    // самосвязь — INVARIANT → UNPROCESSABLE_CONTENT
    const self = await trpcError(
      caller.relation.create({ source_id: a.id, target_id: a.id, relation_type: 'related_to' }),
    );
    expect(self.code).toBe('UNPROCESSABLE_CONTENT');
    expect((self.cause as unknown as { code: string }).code).toBe('INVARIANT');

    // удаление
    expect(
      await caller.relation.delete({
        source_id: a.id,
        target_id: b.id,
        relation_type: 'related_to',
      }),
    ).toEqual({ ok: true });
    expect((await caller.relation.listFor({ entityId: a.id })).map((r) => r.id)).toEqual([ca.id]);

    // повторное удаление — NOT_FOUND
    const gone = await trpcError(
      caller.relation.delete({ source_id: a.id, target_id: b.id, relation_type: 'related_to' }),
    );
    expect(gone.code).toBe('NOT_FOUND');
  });
});
