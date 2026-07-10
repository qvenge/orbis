// apps/server/src/executor/undo.test.ts
// Интеграционные тесты Task 11: Undo §7.8 — отмена НЕ правит журнал (новое
// undo-сообщение в тот же тред), inverse через внутренний режим executor'а
// (LWW-откат body без optimistic-check, восстановление аспект-ключа целиком),
// повторная отмена, undoLast со сканом с конца, undo связей и batch.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { materializeBatchId, newId, recurringInstanceId } from '@orbis/shared';
import { sql } from 'drizzle-orm';
import { adminDb, appDb, freshUserId, requireEnv, truncateAll } from '../../test/helpers';
import { materializeInstances } from '../recurring/materialize';
import { execute } from './executor';
import { makeChatJournalSink } from './journal';
import type { ExecuteErr, ExecuteOk, ExecuteRequest, ExecuteResult, WireEntity } from './types';
import { undoAction, undoLast } from './undo';

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

function err(r: ExecuteResult): ExecuteErr {
  if (r.ok) throw new Error('ожидался структурированный отказ, получен успех');
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

async function adminRows(query: ReturnType<typeof sql>): Promise<Array<Record<string, unknown>>> {
  const { db: admin, client: adminClient } = adminDb();
  try {
    return [...(await admin.execute(query))];
  } finally {
    await adminClient.end();
  }
}

async function entityRow(id: string): Promise<Record<string, unknown>> {
  const rows = await adminRows(
    sql`SELECT title, body, aspects, tags, archived FROM entities WHERE id = ${id}`,
  );
  const row = rows[0];
  if (!row) throw new Error(`сущность ${id} не найдена`);
  return row;
}

/** Число undo-сообщений с данным action_id у владельца (по containment §7.8). */
async function undoMessageCount(user: string, actionId: string): Promise<number> {
  const probe = JSON.stringify({ type: 'undo', undoes: actionId });
  const rows = await adminRows(
    sql`SELECT count(*)::int AS n FROM chat_messages m
        JOIN chat_threads t ON t.id = m.thread_id
        WHERE t.owner_id = ${user} AND m.metadata @> ${probe}::jsonb`,
  );
  return rows[0]?.n as number;
}

/** Число сообщений владельца, содержащих action (журнал действий). */
async function actionMessageCount(user: string): Promise<number> {
  const rows = await adminRows(
    sql`SELECT count(*)::int AS n FROM chat_messages m
        JOIN chat_threads t ON t.id = m.thread_id
        WHERE t.owner_id = ${user}
          AND m.metadata @> '{"actions": []}'::jsonb
          AND jsonb_array_length(m.metadata->'actions') > 0`,
  );
  return rows[0]?.n as number;
}

async function relCount(sourceId: string, targetId: string, relationType: string): Promise<number> {
  const rows = await adminRows(
    sql`SELECT count(*)::int AS n FROM relations
        WHERE source_id = ${sourceId} AND target_id = ${targetId} AND relation_type = ${relationType}`,
  );
  return rows[0]?.n as number;
}

describe('undoAction: создание → архивация (§7.8)', () => {
  const user = freshUserId();
  let actionId = '';
  let entityId = '';

  test('undo entity_create архивирует сущность и пишет undo-сообщение; нового action не порождает', async () => {
    const r = ok(
      await execute(db, req(user, 'entity_create', { title: 'Отменяемая', tags: [] }), { sink }),
    );
    actionId = r.actionId;
    entityId = (r.results[0] as WireEntity).id;
    const actionsBefore = await actionMessageCount(user);

    const u = ok(await undoAction(db, { actorUserId: user, actionId }));
    expect(u.actionId).toBe(actionId); // вернулся id отменённого действия

    const row = await entityRow(entityId);
    expect(row.archived).toBe(true); // создание → архивация (жёсткого удаления нет)
    expect(await undoMessageCount(user, actionId)).toBe(1);
    // undo НЕ порождает нового action (undo неотменяем): журнал действий не вырос
    expect(await actionMessageCount(user)).toBe(actionsBefore);
  });

  test('повторный undo того же action → VALIDATION «уже отменено»', async () => {
    const again = err(await undoAction(db, { actorUserId: user, actionId }));
    expect(again.error.code).toBe('VALIDATION');
    expect(again.error.message).toContain('уже отменено');
    expect(await undoMessageCount(user, actionId)).toBe(1); // второго undo-сообщения нет
  });

  test('чужой action под userB → NOT_FOUND (RLS скоупит журнал владельцем)', async () => {
    const userB = freshUserId();
    const r = err(await undoAction(db, { actorUserId: userB, actionId }));
    expect(r.error.code).toBe('NOT_FOUND');
  });
});

describe('undoAction: entity_update — LWW-откат (§7.8, обязательство 2)', () => {
  test('undo возвращает прежний title, body несмотря на optimistic-check и аспект-ключ ЦЕЛИКОМ', async () => {
    const user = freshUserId();
    const created = ok(
      await execute(
        db,
        req(user, 'entity_create', {
          title: 'Старый',
          tags: [],
          body: 'v1',
          aspects: { 'orbis/task': { status: 'inbox' } },
        }),
        { sink },
      ),
    );
    const e = created.results[0] as WireEntity;

    // правка: title + body (с optimistic-check §5.2) + патч аспекта, добавляющий
    // поля (completed_at проставит сервер, due_date — патч), которых в прежнем ключе не было
    const updated = ok(
      await execute(
        db,
        req(user, 'entity_update', {
          id: e.id,
          title: 'Новый',
          body: 'v2',
          expectedUpdatedAt: e.updatedAt,
          aspects: { 'orbis/task': { status: 'done', due_date: '2026-07-10' } },
        }),
        { sink },
      ),
    );
    const undoTarget = updated.actionId;

    // ещё одна правка двигает updated_at вперёд: inverse с body (без expectedUpdatedAt)
    // упёрся бы в §5.2 — undo применяет осознанный LWW-откат через internal-режим
    ok(await execute(db, req(user, 'entity_update', { id: e.id, tags: ['later'] }), { sink }));

    const u = ok(await undoAction(db, { actorUserId: user, actionId: undoTarget }));
    expect(u.actionId).toBe(undoTarget);

    const row = await entityRow(e.id);
    expect(row.title).toBe('Старый');
    expect(row.body).toBe('v1'); // восстановлен несмотря на изменившийся updated_at
    // аспект-ключ восстановлен целиком: due_date и completed_at, добавленные
    // отменённой правкой, исчезли (shallow-merge оставил бы их)
    expect((row.aspects as Record<string, unknown>)['orbis/task']).toEqual({ status: 'inbox' });
    // поле, не затронутое отменяемым действием, не откатывается
    expect(row.tags).toEqual(['later']);
  });
});

describe('undoAction: связи и batch (§7.8)', () => {
  test('undo relation_create удаляет связь', async () => {
    const user = freshUserId();
    const s = ok(
      await execute(db, req(user, 'entity_create', { title: 'Источник', tags: [] }), { sink }),
    ).results[0] as WireEntity;
    const t = ok(
      await execute(db, req(user, 'entity_create', { title: 'Цель', tags: [] }), { sink }),
    ).results[0] as WireEntity;
    const rel = ok(
      await execute(
        db,
        req(user, 'relation_create', {
          source_id: s.id,
          target_id: t.id,
          relation_type: 'related_to',
        }),
        { sink },
      ),
    );
    expect(await relCount(s.id, t.id, 'related_to')).toBe(1);

    ok(await undoAction(db, { actorUserId: user, actionId: rel.actionId }));
    expect(await relCount(s.id, t.id, 'related_to')).toBe(0);
    expect(await undoMessageCount(user, rel.actionId)).toBe(1);
  });

  test('undo batch применяет inverse в обратном порядке одним tx: связь удалена, сущности архивированы', async () => {
    const user = freshUserId();
    const batchId = newId();
    const sId = newId();
    const tId = newId();
    const r = ok(
      await execute(
        db,
        {
          actorUserId: user,
          actorKind: 'owner',
          source: 'chat',
          batchId,
          operations: [
            { tool: 'entity_create', input: { id: sId, title: 'Пакет-А', tags: [] } },
            { tool: 'entity_create', input: { id: tId, title: 'Пакет-Б', tags: [] } },
            {
              tool: 'relation_create',
              input: { source_id: sId, target_id: tId, relation_type: 'related_to' },
            },
          ],
        },
        { sink },
      ),
    );
    expect(r.actionId).toBe(batchId);

    const u = ok(await undoAction(db, { actorUserId: user, actionId: batchId }));
    expect(u.actionId).toBe(batchId);
    expect(await relCount(sId, tId, 'related_to')).toBe(0);
    expect((await entityRow(sId)).archived).toBe(true);
    expect((await entityRow(tId)).archived).toBe(true);
    expect(await undoMessageCount(user, batchId)).toBe(1);
  });

  test('undo attach восстанавливает прежнее отсутствие аспект-ключа (null → detach)', async () => {
    const user = freshUserId();
    const e = ok(
      await execute(db, req(user, 'entity_create', { title: 'Без аспекта', tags: [] }), { sink }),
    ).results[0] as WireEntity;
    const attach = ok(
      await execute(
        db,
        req(user, 'attach_orbis_task', { entity_id: e.id, data: { status: 'inbox' } }),
        { sink },
      ),
    );
    ok(await undoAction(db, { actorUserId: user, actionId: attach.actionId }));
    const row = await entityRow(e.id);
    expect(row.aspects).toEqual({}); // аспекта не было — ключ снят целиком
  });
});

describe('undoLast: скан журнала с конца (§7.8)', () => {
  test('пропускает уже отменённое и undo-записи, применяет inverse первого неотменённого', async () => {
    const user = freshUserId();
    const r1 = ok(
      await execute(db, req(user, 'entity_create', { title: 'Первая', tags: [] }), { sink }),
    );
    const e1 = r1.results[0] as WireEntity;
    const r2 = ok(
      await execute(db, req(user, 'entity_create', { title: 'Вторая', tags: [] }), { sink }),
    );
    const e2 = r2.results[0] as WireEntity;

    // последнее действие отменяем явно — его undo-сообщение станет последним сообщением
    ok(await undoAction(db, { actorUserId: user, actionId: r2.actionId }));
    expect((await entityRow(e2.id)).archived).toBe(true);

    // undoLast: пропускает undo-запись (не action) и отменённое r2 → отменяет r1
    const u = ok(await undoLast(db, { actorUserId: user }));
    expect(u.actionId).toBe(r1.actionId);
    expect((await entityRow(e1.id)).archived).toBe(true);

    // всё отменено → структурированный отказ
    const none = err(await undoLast(db, { actorUserId: user }));
    expect(none.error.code).toBe('NOT_FOUND');
  });

  test('«отмени последнее» пропускает системные действия (source=system): откатывается fast-path, инстансы живы (fix round A3)', async () => {
    const user = freshUserId();
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(
      new Date(),
    );
    // Действие владельца: «обед 340» здесь — создание recurring-шаблона (fast_path)
    const rTpl = ok(
      await execute(
        db,
        req(user, 'entity_create', {
          title: 'Шаблон с материализацией',
          tags: [],
          aspects: {
            'orbis/schedule': {
              start_at: `${today}T09:00:00+03:00`,
              timezone: 'Europe/Moscow',
              recurrence: { freq: 'daily', interval: 1 },
            },
          },
        }),
        { sink },
      ),
    );
    const tpl = rTpl.results[0] as WireEntity;

    // Между действием владельца и его отменой случилась системная материализация
    // (§5.4) — её batch-audit стал ПОСЛЕДНИМ action'ом журнала
    const m = await materializeInstances({ db, ownerId: user, from: today, to: today, today });
    expect(m.created).toBe(1);
    const instanceId = recurringInstanceId(tpl.id, today);

    // «последнее» = последнее ВИДИМОЕ пользователю действие: системный batch
    // пропускается, откатывается создание шаблона; инстансы не архивируются молча
    const u = ok(await undoLast(db, { actorUserId: user }));
    expect(u.actionId).toBe(rTpl.actionId);
    expect((await entityRow(tpl.id)).archived).toBe(true); // отменён именно fast_path
    expect((await entityRow(instanceId)).archived).toBe(false); // инстанс жив

    // Точечный undo по action_id системного batch остаётся возможным (§2.8, путь A5):
    // id action'а batch = его детерминированный batch_id (materializeBatchId)
    ok(
      await undoAction(db, {
        actorUserId: user,
        actionId: materializeBatchId(tpl.id, today, today),
      }),
    );
    expect((await entityRow(instanceId)).archived).toBe(true);
  });
});
