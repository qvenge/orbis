// Интеграционные тесты диспатча тулов (§9.2): живая БД, executor без моков.
// Env: DATABASE_URL (orbis_app, RLS enforced) + DATABASE_URL_ADMIN (truncate/сид).
// Политика §7.10 подключена (Task 5): уровень мутации назначает classifyToolCall
// (policy/confirmation, юнит-тесты там же); здесь — поведение уровней через dispatch.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { entityThreadId, newId } from '@orbis/shared';
import { eq, inArray, sql } from 'drizzle-orm';
import { adminDb, appDb, freshUserId, requireEnv, truncateAll } from '../../test/helpers';
import { ensureEntityThread, ensureGlobalThread } from '../chat/threads';
import { aspectDefinitions, chatMessages, entities } from '../db/schema';
import { withIdentity } from '../db/with-identity';
import { execute } from '../executor/executor';
import type { ActionRecord, WireEntity } from '../executor/types';
import { issuePatGrant, verifyBearer } from '../oauth/grants';
import { dispatchTool, type ToolCallCtx } from './dispatch';

requireEnv();

const { db, client } = appDb();
const userA = freshUserId();
const userB = freshUserId();
const CATEGORY_REF = '019e4466-aaaa-7e07-b5d4-64be9721da51';
const T0 = new Date('2026-07-04T10:00:00.000Z');

function ctxFor(over: Partial<ToolCallCtx> = {}): ToolCallCtx {
  return {
    db,
    actorUserId: userA,
    actorKind: 'ai',
    source: 'chat',
    explicitCommand: false,
    clock: () => T0,
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

function expectError(r: Awaited<ReturnType<typeof dispatchTool>>, code: string): void {
  expect(r.status).toBe('error');
  if (r.status === 'error') expect(r.error.code).toBe(code);
}

beforeAll(async () => {
  await truncateAll();
  // Кастомный аспект userA с «-» в id: реестр публикует attach_user_sleep_log,
  // executor ждёт attach_user_sleep-log — тесты маппинга (одиночный и в batch)
  const { db: admin, client: adminClient } = adminDb();
  try {
    await admin.insert(aspectDefinitions).values({
      id: 'user/sleep-log',
      ownerId: userA,
      name: 'Sleep Log',
      namespace: 'user',
      schema: {
        type: 'object',
        properties: { hours: { type: 'number' } },
        required: ['hours'],
        additionalProperties: false,
      },
      aiInstructions: 'Пиши часы сна числом.',
      viewConfig: { keyFields: ['hours'] },
    });
  } finally {
    await adminClient.end();
  }
});

afterAll(async () => {
  await client.end();
});

describe('dispatchTool: резолв по реестру', () => {
  test('неизвестный тул → error/FORBIDDEN_LEVEL (§7.10 ряд «!known»: fail-closed, 403 маппингом errors.ts)', async () => {
    // Уровень определяет classifyToolCall, dispatch только мапит его в код ошибки —
    // ни модель, ни агент не обходят запрет переформулировкой имени вызова
    const r = await dispatchTool(ctxFor(), 'entity_delete', { id: newId() });
    expectError(r, 'FORBIDDEN_LEVEL');
  });

  test('невалидный envelope read-тула ({} для entity_query) → error/VALIDATION', async () => {
    const r = await dispatchTool(ctxFor(), 'entity_query', {});
    expectError(r, 'VALIDATION');
  });
});

describe('dispatchTool: мутации через executor (§9.2; уровни §7.10 подключит Task 5)', () => {
  test('entity_create: сущность создана; audit в переданный threadId с actor_kind=ai, source=chat; card entity_card', async () => {
    // Отдельный (не глобальный) тред — проверяем именно «переданный threadId»
    const host = await seedEntity(userA, { title: 'Хост-тред', tags: [] });
    const threadId = await withIdentity(db, userA, (tx) => ensureEntityThread(tx, userA, host.id));

    const r = await dispatchTool(ctxFor({ threadId }), 'entity_create', {
      title: 'Тестовая задача',
      tags: ['dispatch'],
      aspects: { 'orbis/task': { status: 'inbox' } },
    });
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    const e = r.result as WireEntity;
    expect(e.title).toBe('Тестовая задача');
    expect(e.createdAt).toBe(T0.toISOString());

    // карточка (02 §2.3): keyFields по viewConfig аспекта (status/due_date/priority → только status)
    expect(r.card).toEqual({
      kind: 'entity_card',
      entityId: e.id,
      title: 'Тестовая задача',
      aspects: ['orbis/task'],
      keyFields: { status: 'inbox' },
      undoActionId: expect.any(String),
    });

    // audit-сообщение легло в переданный тред; актор — внутренний AI
    const msgs = await messagesIn(userA, threadId);
    expect(msgs.length).toBe(1);
    const md = msgs[0]?.metadata as { actions?: ActionRecord[] };
    const action = md.actions?.[0];
    expect(action?.actor_kind).toBe('ai');
    expect(action?.source).toBe('chat');
    expect(action?.actor_user_id).toBe(userA);
    if (r.card?.kind === 'entity_card') expect(action?.id).toBe(r.card.undoActionId as string);
  });

  // V1.5: прогон — вторая половина атрибуции. Без него правка модели неотличима от
  // любой другой чатовой, и откат прогона (rollback.ts ищет действия контейнмент-пробой
  // по run_id) не нашёл бы того, что она сделала.
  test('entity_update с ctx.runId: прогон доезжает до action журнала', async () => {
    const host = await seedEntity(userA, { title: 'Хост-тред прогона', tags: [] });
    const threadId = await withIdentity(db, userA, (tx) => ensureEntityThread(tx, userA, host.id));
    const target = await seedEntity(userA, { title: 'Цель прогона', tags: [] });
    const runId = newId();

    const r = await dispatchTool(ctxFor({ threadId, source: 'chat', runId }), 'entity_update', {
      id: target.id,
      title: 'Правка в прогоне',
    });
    expect(r.status).toBe('ok');

    const msgs = await messagesIn(userA, threadId);
    expect(msgs.length).toBe(1);
    const action = (msgs[0]?.metadata as { actions?: ActionRecord[] }).actions?.[0];
    expect(action?.run_id).toBe(runId);
  });

  test('attach_orbis_task: аспект установлен; без threadId audit — в глобальный тред', async () => {
    const target = await seedEntity(userA, { title: 'Без аспекта', tags: [] });
    const globalThread = await withIdentity(db, userA, (tx) => ensureGlobalThread(tx, userA));
    const before = (await messagesIn(userA, globalThread)).length;

    const r = await dispatchTool(ctxFor(), 'attach_orbis_task', {
      entity_id: target.id,
      data: { status: 'in_progress', priority: 'high' },
    });
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    const e = r.result as WireEntity;
    expect(e.aspects['orbis/task']).toEqual({ status: 'in_progress', priority: 'high' });
    expect(r.card?.kind).toBe('entity_card');
    if (r.card?.kind === 'entity_card') {
      expect(r.card.keyFields).toEqual({ status: 'in_progress', priority: 'high' });
      expect(r.card.undoActionId).toBeDefined();
    }

    const after = await messagesIn(userA, globalThread);
    expect(after.length).toBe(before + 1);
    const md = after[after.length - 1]?.metadata as { actions?: ActionRecord[] };
    expect(md.actions?.[0]?.actor_kind).toBe('ai');
  });

  test('entity_update: card entity_card с undoActionId; ошибка executor пробрасывается структурированно', async () => {
    const target = await seedEntity(userA, { title: 'До правки', tags: [] });
    const ok = await dispatchTool(ctxFor(), 'entity_update', {
      id: target.id,
      title: 'После правки',
    });
    expect(ok.status).toBe('ok');
    if (ok.status === 'ok' && ok.card?.kind === 'entity_card') {
      expect(ok.card.title).toBe('После правки');
      expect(ok.card.undoActionId).toBeDefined();
    }

    // §5.2: правка body без expectedUpdatedAt → VALIDATION из executor'а
    const bad = await dispatchTool(ctxFor(), 'entity_update', {
      id: target.id,
      body: 'новый текст',
    });
    expectError(bad, 'VALIDATION');
  });

  test('attach_* кастомного аспекта с «-» в id: имя реестра мапится в executor-форму через aspectId', async () => {
    // Реестр: attach_user_sleep_log («-» → «_»); executor ждёт attach_user_sleep-log
    // (замена только «/») — без маппинга по aspectId вызов не резолвился бы (решение 3)
    const target = await seedEntity(userA, { title: 'Сон', tags: [] });
    const r = await dispatchTool(ctxFor(), 'attach_user_sleep_log', {
      entity_id: target.id,
      data: { hours: 7.5 },
    });
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect((r.result as WireEntity).aspects['user/sleep-log']).toEqual({ hours: 7.5 });
    if (r.card?.kind === 'entity_card') expect(r.card.keyFields).toEqual({ hours: 7.5 });
  });

  test('batch_execute: атомарная группа исполняется, results по операциям, один audit-action типа batch', async () => {
    const host = await seedEntity(userA, { title: 'Хост batch-треда', tags: [] });
    const threadId = await withIdentity(db, userA, (tx) => ensureEntityThread(tx, userA, host.id));
    const r = await dispatchTool(ctxFor({ threadId }), 'batch_execute', {
      batch_id: newId(),
      operations: [
        { tool: 'entity_create', input: { title: 'batch-1', tags: [] } },
        { tool: 'entity_create', input: { title: 'batch-2', tags: [] } },
      ],
    });
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect((r.result as unknown[]).length).toBe(2);
    const msgs = await messagesIn(userA, threadId);
    expect(msgs.length).toBe(1);
    const md = msgs[0]?.metadata as { actions?: ActionRecord[] };
    expect(md.actions?.[0]?.type).toBe('batch');
  });

  test('batch_execute: вложенный attach по ПУБЛИЧНОМУ имени реестра (дефисный кастомный аспект) → успех', async () => {
    // fix round: operations[].tool приходят в реестровых именах — dispatch обязан
    // транслировать их в executor-форму так же, как top-level вызов (через aspectId)
    const id = newId();
    const r = await dispatchTool(ctxFor(), 'batch_execute', {
      batch_id: newId(),
      operations: [
        { tool: 'entity_create', input: { id, title: 'batch + attach', tags: [] } },
        { tool: 'attach_user_sleep_log', input: { entity_id: id, data: { hours: 6 } } },
      ],
    });
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    const results = r.result as WireEntity[];
    expect(results.length).toBe(2);
    expect(results[1]?.aspects['user/sleep-log']).toEqual({ hours: 6 });
  });

  test('batch_execute: неизвестное имя операции → структурная VALIDATION с индексом элемента', async () => {
    const r = await dispatchTool(ctxFor(), 'batch_execute', {
      batch_id: newId(),
      operations: [
        { tool: 'entity_create', input: { title: 'x', tags: [] } },
        { tool: 'no_such_tool', input: {} },
      ],
    });
    expectError(r, 'VALIDATION');
    if (r.status === 'error') {
      expect((r.error.details as { index: number; tool: string }).index).toBe(1);
      expect((r.error.details as { index: number; tool: string }).tool).toBe('no_such_tool');
    }
  });
});

describe('dispatchTool: политика подтверждений §7.10 (закрывает контракт-заглушку shared/contracts/confirmation-policy)', () => {
  test('archives инициативой AI (entity_update archived:true, explicitCommand=false) → pending_confirmation; ничего не исполнено', async () => {
    // Task 6: explicit-уровень создаёт pending-карточку (policy/pending) вместо
    // временной VALIDATION Task 5; сам pending-механизм покрыт policy/pending.test.ts —
    // здесь фиксируется контракт dispatch: status + card + отсутствие следа в графе/журнале.
    const host = await seedEntity(userA, { title: 'Хост-тред политики', tags: [] });
    const threadId = await withIdentity(db, userA, (tx) => ensureEntityThread(tx, userA, host.id));
    const target = await seedEntity(userA, { title: 'Кандидат на архив', tags: [] });

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
    // §7.10: до подтверждения ничего не записано — ни в граф, ни в журнал; в тред
    // легла только карточка-запрос (без metadata.actions — это НЕ запись журнала §7.8)
    const rows = await withIdentity(db, userA, (tx) =>
      tx.select({ archived: entities.archived }).from(entities).where(eq(entities.id, target.id)),
    );
    expect(rows[0]?.archived).toBe(false);
    const msgs = await messagesIn(userA, threadId);
    expect(msgs.length).toBe(1);
    expect(msgs[0]?.id).toBe(r.pendingId);
    expect((msgs[0]?.metadata as { actions?: unknown }).actions).toBeUndefined();
  });

  test('batch из 11 архиваций → pending_confirmation (ряд archives); все сущности остались неархивированными', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 11; i++) {
      ids.push((await seedEntity(userA, { title: `Архив-${i}`, tags: ['pol-arch'] })).id);
    }
    const r = await dispatchTool(ctxFor(), 'batch_execute', {
      batch_id: newId(),
      operations: ids.map((id) => ({ tool: 'entity_update', input: { id, archived: true } })),
    });
    expect(r.status).toBe('pending_confirmation');
    if (r.status === 'pending_confirmation' && r.card.kind === 'confirmation_card') {
      expect(r.card.summary).toBe('11 операций');
    }
    const rows = await withIdentity(db, userA, (tx) =>
      tx.select({ archived: entities.archived }).from(entities).where(inArray(entities.id, ids)),
    );
    expect(rows.length).toBe(11);
    expect(rows.every((row) => row.archived === false)).toBe(true);
  });

  test('дедуп pending по batch_id: ретрай того же batch на explicit-уровне не плодит вторую карточку', async () => {
    // Minor-4 Task 6 закрыт не только протоколом pendingNote, но и БД: pendingId
    // детерминирован по batch_id (pendingMessageId) → повтор того же batch = ON CONFLICT.
    // Свежий владелец — глобальный тред пуст, поэтому счёт pending-карточек точен.
    const user = freshUserId();
    const ctx = ctxFor({ actorUserId: user });
    const target = await seedEntity(user, { title: 'Цель дедупа pending', tags: [] });
    const globalThreadId = await withIdentity(db, user, (tx) => ensureGlobalThread(tx, user));
    const call = {
      batch_id: newId(),
      operations: [{ tool: 'entity_update', input: { id: target.id, archived: true } }],
    };

    const r1 = await dispatchTool(ctx, 'batch_execute', call);
    expect(r1.status).toBe('pending_confirmation');
    const r2 = await dispatchTool(ctx, 'batch_execute', call); // ретрай ТОГО ЖЕ batch_id
    expect(r2.status).toBe('pending_confirmation');
    if (r1.status !== 'pending_confirmation' || r2.status !== 'pending_confirmation') return;

    // Детерминизм по batch_id: тот же pendingId (на старой логике — новый newId)
    expect(r2.pendingId).toBe(r1.pendingId);
    // В треде ровно одна pending-карточка — второй ретрай не создал дубль (ON CONFLICT)
    const pendings = (await messagesIn(user, globalThreadId)).filter(
      (m) => (m.metadata as { pending?: unknown }).pending !== undefined,
    );
    expect(pendings).toHaveLength(1);
    expect(pendings[0]?.id).toBe(r1.pendingId);
  });

  test('batch из 11 обычных операций → pending_confirmation (ряд масштаба > 10); ничего не создано', async () => {
    const ids = Array.from({ length: 11 }, () => newId());
    const r = await dispatchTool(ctxFor(), 'batch_execute', {
      batch_id: newId(),
      operations: ids.map((id, i) => ({
        tool: 'entity_create',
        input: { id, title: `Массовая-${i}`, tags: [] },
      })),
    });
    expect(r.status).toBe('pending_confirmation');
    const rows = await withIdentity(db, userA, (tx) =>
      tx.select({ id: entities.id }).from(entities).where(inArray(entities.id, ids)),
    );
    expect(rows.length).toBe(0);
  });

  test('batch из 5 обычных операций → preview: ИСПОЛНЕН (сущности в БД) + card confirmation_card mode=preview, summary «5 операций»', async () => {
    const ids = Array.from({ length: 5 }, () => newId());
    const r = await dispatchTool(ctxFor(), 'batch_execute', {
      batch_id: newId(),
      operations: ids.map((id, i) => ({
        tool: 'entity_create',
        input: { id, title: `Превью-${i}`, tags: [] },
      })),
    });
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect((r.result as unknown[]).length).toBe(5);
    expect(r.card).toEqual({ kind: 'confirmation_card', mode: 'preview', summary: '5 операций' });
    // §7.10: предпросмотр информационный, не блокирующий — действие уже исполнено
    const rows = await withIdentity(db, userA, (tx) =>
      tx.select({ id: entities.id }).from(entities).where(inArray(entities.id, ids)),
    );
    expect(rows.length).toBe(5);
  });

  test('одиночная не-архивирующая мутация → уровень execute: исполняется немедленно, карточка entity_card постфактум', async () => {
    const r = await dispatchTool(ctxFor(), 'entity_create', { title: 'Уровень execute', tags: [] });
    expect(r.status).toBe('ok');
    if (r.status === 'ok') expect(r.card?.kind).toBe('entity_card');
  });

  test('fix round: schema-invalid entity_update с archived:true → честная VALIDATION с issues, НЕ pending (§7.10: уровень — ПОСЛЕ структурной валидации)', async () => {
    // Без envelope-валидации до классификации модель получала бы отказ уровня вместо
    // zod-issues (терялся путь самокоррекции), а pending создавался бы из
    // невалидированного payload'а — нарушение «executor применяет тот же payload,
    // который был провалидирован в момент запроса подтверждения» (§7.10)
    const target = await seedEntity(userA, { title: 'Невалидный патч', tags: [] });
    const r = await dispatchTool(ctxFor(), 'entity_update', {
      id: target.id,
      archived: true,
      title: 123, // невалидный тип
    });
    expectError(r, 'VALIDATION');
    if (r.status === 'error') {
      const details = r.error.details as { issues?: unknown[] };
      expect(Array.isArray(details.issues)).toBe(true);
    }
  });

  test('fix round: batch архиваций с невалидным uuid операции → VALIDATION с index/issues, НЕ pending', async () => {
    const ops = Array.from({ length: 11 }, () => ({
      tool: 'entity_update',
      input: { id: newId(), archived: true },
    }));
    ops[5] = { tool: 'entity_update', input: { id: 'не-uuid', archived: true } };
    const r = await dispatchTool(ctxFor(), 'batch_execute', {
      batch_id: newId(),
      operations: ops,
    });
    expectError(r, 'VALIDATION');
    if (r.status === 'error') {
      const details = r.error.details as { index?: number; issues?: unknown[] };
      expect(details.index).toBe(5);
      expect(Array.isArray(details.issues)).toBe(true);
    }
  });
});

describe('dispatchTool: чтения без политики (§7.10, ряд «read → execute» — юнит классификатора)', () => {
  test('entity_query: список wire-сущностей + card query_result (count, entityIds, title из запроса)', async () => {
    const created = await seedEntity(userA, { title: 'Для поиска', tags: ['qtest'] });
    const r = await dispatchTool(ctxFor(), 'entity_query', {
      query: 'tags=qtest, title=Поиск',
    });
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    const list = r.result as WireEntity[];
    expect(list.map((e) => e.id)).toEqual([created.id]);
    expect(r.card).toEqual({
      kind: 'query_result',
      title: 'Поиск',
      count: 1,
      entityIds: [created.id],
    });
  });

  test('entity_query: RLS — чужие сущности не видны', async () => {
    await seedEntity(userB, { title: 'Чужая', tags: ['qtest-b'] });
    const r = await dispatchTool(ctxFor(), 'entity_query', { query: 'tags=qtest-b' });
    expect(r.status).toBe('ok');
    if (r.status === 'ok') expect(r.result as WireEntity[]).toHaveLength(0);
  });

  test('entity_query: ошибка грамматики → error/VALIDATION со структурой (§6.4)', async () => {
    const r = await dispatchTool(ctxFor(), 'entity_query', { query: 'nosuchfield=42' });
    expectError(r, 'VALIDATION');
  });

  test('entity_get: include по умолчанию body+relations; несуществующий id → NOT_FOUND', async () => {
    const created = await seedEntity(userA, { title: 'Читаемая', tags: [] });
    const r = await dispatchTool(ctxFor(), 'entity_get', { id: created.id });
    expect(r.status).toBe('ok');
    if (r.status === 'ok') {
      const out = r.result as { entity: WireEntity; relations?: unknown[]; backlinks?: unknown };
      expect(out.entity.id).toBe(created.id);
      expect(Array.isArray(out.relations)).toBe(true);
      expect(out.backlinks).toBeUndefined();
    }

    const missing = await dispatchTool(ctxFor(), 'entity_get', { id: newId() });
    expectError(missing, 'NOT_FOUND');
  });
});

describe('dispatchTool: import_csv_start — вход в импорт из чата (Task C4c, 03-budget §3.4)', () => {
  /** Число сущностей и строк entity_origins владельца — СЫРЫМ админ-соединением (мимо RLS). */
  async function rawWriteCounts(user: string): Promise<{ entities: number; origins: number }> {
    const { db: admin, client: adminClient } = adminDb();
    try {
      const rows = (await admin.execute(sql`
        SELECT
          (SELECT count(*)::int FROM entities WHERE owner_id = ${user}) AS entities,
          (SELECT count(*)::int FROM entity_origins WHERE owner_id = ${user}) AS origins
      `)) as unknown as Array<{ entities: number; origins: number }>;
      return { entities: rows[0]?.entities ?? 0, origins: rows[0]?.origins ?? 0 };
    } finally {
      await adminClient.end();
    }
  }

  test('source=chat → status ok и карточка import_review (форма — дословно web-тип ImportReviewData)', async () => {
    const r = await dispatchTool(ctxFor(), 'import_csv_start', {});
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    // Литеральная сверка формы целиком (toEqual): карточки сервера и web-типы
    // НАМЕРЕННО не общие — расхождение имени поля с ImportReviewData
    // (apps/web/src/features/chat/cards/types.ts) клиент молча не отрисует
    expect(r.card).toEqual({ kind: 'import_review' });
  });

  test('гейт §8: отказ резолвера import.csv → LIMIT, карточки нет', async () => {
    // Денайл-путь через инъецируемый шов ctx.entitlements (тот же приём, что у роутера
    // импорта после ac44b05): боевой резолвер плана dev всё разрешает, и без шва эта
    // ветка была бы непокрываемой.
    const r = await dispatchTool(
      ctxFor({
        entitlements: (_user, key) =>
          key === 'import.csv' ? { allowed: false, limit: 0 } : { allowed: true, limit: null },
      }),
      'import_csv_start',
      {},
    );
    expectError(r, 'LIMIT');
    expect('card' in r).toBe(false);
  });

  test('internalOnly fail-closed: source=mcp → структурная ошибка, карточки нет', async () => {
    const r = await dispatchTool(
      ctxFor({ actorKind: 'agent', source: 'mcp' }),
      'import_csv_start',
      {},
    );
    expectError(r, 'VALIDATION');
    expect('card' in r).toBe(false);
  });

  test('строгий пустой envelope: лишнее поле → VALIDATION', async () => {
    const r = await dispatchTool(ctxFor(), 'import_csv_start', { file: 'statement.csv' });
    expectError(r, 'VALIDATION');
  });

  test('тул ничего не пишет: число entities и строк entity_origins владельца не изменилось', async () => {
    const before = await rawWriteCounts(userA);
    const r = await dispatchTool(ctxFor(), 'import_csv_start', {});
    expect(r.status).toBe('ok');
    const after = await rawWriteCounts(userA);
    expect(after).toEqual(before);
  });
});

describe('dispatchTool: user_query — агрегация SQL-ем (решение 7, §3.3 точность)', () => {
  beforeAll(async () => {
    for (const amount of ['100.50', '200.25']) {
      await seedEntity(userA, {
        title: `Расход ${amount}`,
        tags: ['uqtest'],
        aspects: {
          'orbis/financial': {
            amount,
            direction: 'expense',
            category_ref: CATEGORY_REF,
            occurred_on: '2026-07-01',
          },
        },
      });
    }
  });

  test('sum по amount: decimal-строка без потери точности + card.aggregate', async () => {
    const r = await dispatchTool(ctxFor(), 'user_query', {
      query: 'aspect=orbis/financial, tags=uqtest',
      aggregate: 'sum',
      field: 'amount',
    });
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.result).toBe('300.75');
    expect(r.card).toEqual({
      kind: 'query_result',
      count: 2,
      entityIds: [],
      aggregate: { op: 'sum', value: '300.75' },
    });
  });

  test('limit из query игнорируется агрегацией (агрегат по всей выборке)', async () => {
    const r = await dispatchTool(ctxFor(), 'user_query', {
      query: 'aspect=orbis/financial, tags=uqtest, limit=1',
      aggregate: 'sum',
      field: 'amount',
    });
    expect(r.status).toBe('ok');
    if (r.status === 'ok') expect(r.result).toBe('300.75');
  });

  test('count: число сущностей выборки; field не требуется', async () => {
    const r = await dispatchTool(ctxFor(), 'user_query', {
      query: 'aspect=orbis/financial, tags=uqtest',
      aggregate: 'count',
    });
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.result).toBe(2);
    expect(r.card).toEqual({
      kind: 'query_result',
      count: 2,
      entityIds: [],
      aggregate: { op: 'count', value: '2' },
    });
  });

  test('count по children_of=this без контекста сущности → структурная VALIDATION, не throw (fix round)', async () => {
    // QueryCompileError count-пути обязан мапиться в error-результат, как в sum/entity_query
    const r = await dispatchTool(ctxFor(), 'user_query', {
      query: 'children_of=this',
      aggregate: 'count',
    });
    expectError(r, 'VALIDATION');
  });

  test('internalOnly fail-closed: user_query при source=mcp → структурная ошибка (fix round)', async () => {
    // Не полагаемся только на фильтрацию списка тулов в MCP-адаптере (Task 10)
    const r = await dispatchTool(ctxFor({ actorKind: 'agent', source: 'mcp' }), 'user_query', {
      query: 'aspect=orbis/financial, tags=uqtest',
      aggregate: 'count',
    });
    expectError(r, 'VALIDATION');
  });

  test('sum без field → VALIDATION; sum по нечисловому полю → VALIDATION; неизвестное поле → VALIDATION', async () => {
    const base = { query: 'aspect=orbis/financial, tags=uqtest' };
    expectError(
      await dispatchTool(ctxFor(), 'user_query', { ...base, aggregate: 'sum' }),
      'VALIDATION',
    );
    expectError(
      await dispatchTool(ctxFor(), 'user_query', { ...base, aggregate: 'sum', field: 'direction' }),
      'VALIDATION',
    );
    expectError(
      await dispatchTool(ctxFor(), 'user_query', {
        ...base,
        aggregate: 'sum',
        field: 'nosuchfield',
      }),
      'VALIDATION',
    );
  });
});

describe('dispatchTool: user_query материализует окно запроса (обязательство ревью A3, §5.4)', () => {
  // Свой пользователь: до вызова user_query у него НЕТ ни одного инстанса — сумма
  // видна только если сам вызов материализовал окно (тот же каркас, что entity_query)
  const userC = freshUserId();
  const tz = 'Europe/Moscow'; // дефолт queryContext без строки user_settings
  const localToday = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
  const tomorrow = (() => {
    const [y, m, d] = localToday.split('-').map(Number) as [number, number, number];
    return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
  })();

  test('user_query c occurred_on=next_7d видит суммы свеже-материализованных инстансов', async () => {
    await seedEntity(userC, {
      title: 'Абонемент',
      tags: [],
      aspects: {
        'orbis/schedule': {
          start_at: `${tomorrow}T12:00:00+03:00`,
          timezone: tz,
          recurrence: { freq: 'weekly', interval: 1 },
        },
        'orbis/financial': {
          amount: '150.00',
          direction: 'expense',
          category_ref: CATEGORY_REF,
          recurring: true,
        },
      },
    });
    const r = await dispatchTool(ctxFor({ actorUserId: userC }), 'user_query', {
      query: 'aspect=orbis/financial, occurred_on=next_7d',
      aggregate: 'sum',
      field: 'amount',
    });
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    // еженедельно с завтра: в окне next_7d ровно один инстанс (шаблон без occurred_on
    // в выборку не попадает) — сумма именно свеже-материализованного инстанса
    expect(r.result).toBe('150.00');

    const count = await dispatchTool(ctxFor({ actorUserId: userC }), 'user_query', {
      query: 'aspect=orbis/financial, occurred_on=next_7d',
      aggregate: 'count',
    });
    expect(count.status).toBe('ok');
    if (count.status === 'ok') expect(count.result).toBe(1);
  });
});

describe('dispatchTool: thread_post — сообщение в тред сущности мимо executor', () => {
  test('agent/mcp: сообщение role=user с metadata.author_kind=agent; action НЕ журналится', async () => {
    const target = await seedEntity(userA, { title: 'Задача агента', tags: [] });
    const r = await dispatchTool(ctxFor({ actorKind: 'agent', source: 'mcp' }), 'thread_post', {
      entity_id: target.id,
      content: 'Начал работу над задачей.',
    });
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;

    const threadId = entityThreadId(userA, target.id);
    const msgs = await messagesIn(userA, threadId);
    expect(msgs.length).toBe(1);
    expect(msgs[0]?.role).toBe('user');
    expect(msgs[0]?.content).toBe('Начал работу над задачей.');
    // пометка автора-агента; журналирования action нет — сообщение и есть артефакт
    expect(msgs[0]?.metadata).toEqual({ author_kind: 'agent' });
  });

  // V1.6: у поста в треде теперь два не-владельческих автора — внешний агент и
  // внутренний исполнитель рутины. Оба помечаются, иначе владелец не отличит их
  // заметку от своей; прогон в run_id связывает пост с историей рутины.
  test('внутренний AI (actorKind=ai) с runId: пометка author_kind=ai и run_id прогона', async () => {
    const target = await seedEntity(userA, { title: 'Задача AI', tags: [] });
    const runId = newId();
    const r = await dispatchTool(ctxFor({ runId }), 'thread_post', {
      entity_id: target.id,
      content: 'Заметка от AI.',
    });
    expect(r.status).toBe('ok');
    const msgs = await messagesIn(userA, entityThreadId(userA, target.id));
    expect(msgs[0]?.metadata).toEqual({ author_kind: 'ai', run_id: runId });
  });

  test('владелец (actorKind=owner): metadata пустая — помечать автором самого владельца нечего', async () => {
    const target = await seedEntity(userA, { title: 'Задача владельца', tags: [] });
    const r = await dispatchTool(ctxFor({ actorKind: 'owner' }), 'thread_post', {
      entity_id: target.id,
      content: 'Заметка владельца.',
    });
    expect(r.status).toBe('ok');
    const msgs = await messagesIn(userA, entityThreadId(userA, target.id));
    expect(msgs[0]?.metadata).toEqual({});
  });

  test('несуществующая и чужая (RLS) сущность → единый NOT_FOUND', async () => {
    expectError(
      await dispatchTool(ctxFor({ actorKind: 'agent', source: 'mcp' }), 'thread_post', {
        entity_id: newId(),
        content: 'x',
      }),
      'NOT_FOUND',
    );
    const foreign = await seedEntity(userB, { title: 'Чужая задача', tags: [] });
    expectError(
      await dispatchTool(ctxFor({ actorKind: 'agent', source: 'mcp' }), 'thread_post', {
        entity_id: foreign.id,
        content: 'x',
      }),
      'NOT_FOUND',
    );
  });

  test('невалидный envelope (пустой content) → VALIDATION', async () => {
    const target = await seedEntity(userA, { title: 'Задача', tags: [] });
    expectError(
      await dispatchTool(ctxFor(), 'thread_post', { entity_id: target.id, content: '' }),
      'VALIDATION',
    );
  });

  test('идемпотентность по client-id (id): ретрай с тем же id не создаёт второй пост (ON CONFLICT §2.1)', async () => {
    const target = await seedEntity(userA, { title: 'Задача ретрая', tags: [] });
    const msgId = newId();
    const ctx = ctxFor({ actorKind: 'agent', source: 'mcp' });
    const r1 = await dispatchTool(ctx, 'thread_post', {
      id: msgId,
      entity_id: target.id,
      content: 'Заметка №1',
    });
    expect(r1.status).toBe('ok');
    // Ретрай с тем же id (и даже иным content) — исходный пост, append-only §4.6
    const r2 = await dispatchTool(ctx, 'thread_post', {
      id: msgId,
      entity_id: target.id,
      content: 'Заметка №1 (ретрай)',
    });
    expect(r2.status).toBe('ok');
    if (r1.status !== 'ok' || r2.status !== 'ok') return;
    expect((r2.result as { id: string }).id).toBe((r1.result as { id: string }).id);

    // Ровно один пост в треде; content — исходный (правок нет)
    const msgs = await messagesIn(userA, entityThreadId(userA, target.id));
    expect(msgs).toHaveLength(1);
    expect(msgs[0]?.id).toBe(msgId);
    expect(msgs[0]?.content).toBe('Заметка №1');
  });
});

// ---------------------------------------------------------------------------
// Скоуп worker (С7, §4.14): гейт доступа ДО любой записи + сужение thread_post
// ---------------------------------------------------------------------------

describe('dispatchTool: скоуп worker — fail-closed гейт доступа (С7, §4.14)', () => {
  const owner = freshUserId();
  let grantId: string;
  let ticket: WireEntity;
  let project: WireEntity;
  let note: WireEntity;

  /** Контекст вызова от имени фонового исполнителя (MCP + грант со скоупом worker). */
  const worker = () =>
    ctxFor({
      actorUserId: owner,
      actorKind: 'agent',
      source: 'mcp',
      grant: { id: grantId, scope: 'worker', label: 'w' },
    });

  beforeAll(async () => {
    // Грант выдаётся штатным путём (Задача 8 научила issuePatGrant области): инвариант
    // assertAssignment требует ЖИВОГО гранта владельца, а вставка строки руками обходила
    // бы ровно тот код, которым скоуп теперь и записывается.
    const token = await issuePatGrant(db, {
      ownerId: owner,
      label: 'worker-тест',
      scope: 'worker',
    });
    const identity = await verifyBearer(db, token);
    if (identity === null) throw new Error('выданный worker-PAT не прошёл verifyBearer');
    grantId = identity.grantId;
    project = await seedEntity(owner, {
      title: 'Проект исполнителя',
      tags: [],
      aspects: { 'orbis/project': { stage: 'active' } },
    });
    ticket = await seedEntity(owner, {
      title: 'Тикет исполнителя',
      tags: [],
      aspects: {
        'orbis/task': { status: 'planned' },
        'orbis/assignment': { executor: 'agent', grant_id: grantId },
      },
    });
    note = await seedEntity(owner, { title: 'Личная заметка владельца', tags: [] });
    const r = await execute(db, {
      actorUserId: owner,
      actorKind: 'owner',
      source: 'ui',
      operations: [
        {
          tool: 'relation_create',
          input: { source_id: project.id, target_id: ticket.id, relation_type: 'parent' },
        },
      ],
    });
    if (!r.ok) throw new Error(`сид связи проект→тикет: ${r.error.code} ${r.error.message}`);
  });

  test('worker: entity_update / attach_orbis_task / batch_execute → FORBIDDEN_LEVEL, ничего не записано', async () => {
    const calls: Array<[string, Record<string, unknown>]> = [
      ['entity_update', { id: ticket.id, aspects: { 'orbis/task': { status: 'done' } } }],
      ['attach_orbis_task', { entity_id: ticket.id, data: { status: 'done' } }],
      [
        'batch_execute',
        {
          batch_id: newId(),
          operations: [
            {
              tool: 'entity_update',
              input: { id: ticket.id, aspects: { 'orbis/task': { status: 'done' } } },
            },
          ],
        },
      ],
      ['entity_create', { title: 'Сущность мимо назначения', tags: [] }],
      ['relation_delete', { source_id: project.id, target_id: ticket.id, relation_type: 'parent' }],
    ];
    for (const [name, input] of calls) {
      expectError(await dispatchTool(worker(), name, input), 'FORBIDDEN_LEVEL');
    }
    // Гейт стоит ДО записи: статус тикета не изменился, связь проект→тикет на месте
    const rows = await withIdentity(db, owner, (tx) =>
      tx.select({ aspects: entities.aspects }).from(entities).where(eq(entities.id, ticket.id)),
    );
    const task = (rows[0]?.aspects as { 'orbis/task'?: { status?: string } })['orbis/task'];
    expect(task?.status).toBe('planned');
  });

  test('worker: entity_get / entity_query / budget_status исполняются', async () => {
    const got = await dispatchTool(worker(), 'entity_get', { id: ticket.id });
    expect(got.status).toBe('ok');
    const queried = await dispatchTool(worker(), 'entity_query', { query: 'aspect=orbis/task' });
    expect(queried.status).toBe('ok');
    const budget = await dispatchTool(worker(), 'budget_status', {});
    expect(budget.status).toBe('ok');
  });

  test('worker: thread_post в тред назначенного тикета и его проекта — ок; в тред чужой заметки — FORBIDDEN_LEVEL', async () => {
    const onTicket = await dispatchTool(worker(), 'thread_post', {
      entity_id: ticket.id,
      content: 'Взял тикет в работу.',
    });
    expect(onTicket.status).toBe('ok');
    const onProject = await dispatchTool(worker(), 'thread_post', {
      entity_id: project.id,
      content: 'Сводка по проекту.',
    });
    expect(onProject.status).toBe('ok');
    // Заметка владельца исполнителю не назначена — отказ, и до записи: тред пуст
    expectError(
      await dispatchTool(worker(), 'thread_post', {
        entity_id: note.id,
        content: 'не моя заметка',
      }),
      'FORBIDDEN_LEVEL',
    );
    expect(await messagesIn(owner, entityThreadId(owner, note.id))).toHaveLength(0);
  });

  test('worker: thread_post в НЕСУЩЕСТВУЮЩИЙ id → FORBIDDEN_LEVEL, а не NOT_FOUND', async () => {
    // Отличать «нет такой записи» от «не твоя» исполнителю не положено: иначе периметр
    // превращается в оракул чужого графа — перебором id можно было бы узнать, что у
    // владельца есть, а чего нет. Проверка периметра стоит ДО ensureEntityThread.
    expectError(
      await dispatchTool(worker(), 'thread_post', { entity_id: newId(), content: 'в никуда' }),
      'FORBIDDEN_LEVEL',
    );
  });

  test('worker: thread_post в АРХИВИРОВАННЫЙ назначенный тикет → FORBIDDEN_LEVEL', async () => {
    const archivedTicket = await seedEntity(owner, {
      title: 'Тикет, убранный в архив',
      tags: [],
      aspects: {
        'orbis/task': { status: 'planned' },
        'orbis/assignment': { executor: 'agent', grant_id: grantId },
      },
    });
    const r = await execute(db, {
      actorUserId: owner,
      actorKind: 'owner',
      source: 'ui',
      operations: [{ tool: 'entity_update', input: { id: archivedTicket.id, archived: true } }],
    });
    if (!r.ok) throw new Error(`архивация тикета: ${r.error.code} ${r.error.message}`);

    // Архив — «убрано с глаз»: периметр записи исполнителя за ним не тянется
    expectError(
      await dispatchTool(worker(), 'thread_post', {
        entity_id: archivedTicket.id,
        content: 'пишу в архив',
      }),
      'FORBIDDEN_LEVEL',
    );
    expect(await messagesIn(owner, entityThreadId(owner, archivedTicket.id))).toHaveLength(0);
  });

  test('НЕЗНАКОМОЕ значение scope сужает доступ так же, как worker (fail-closed, С7)', async () => {
    // Колонка `scope` — text: значение в неё могло лечь мимо нашего перечисления (ручная
    // правка, откат миграции, будущий скоуп на старом коде). verifyBearer отдаёт его КАК
    // ЕСТЬ, а гейт обязан читать «не full → не полный доступ». Сравнение с одним лишь
    // 'worker' открыло бы такому гранту весь граф — ровно наоборот.
    const token = await issuePatGrant(db, { ownerId: owner, label: 'скоуп из будущего' });
    const { db: admin, client: adminClient } = adminDb();
    try {
      await admin.execute(
        sql`UPDATE agent_grants SET scope = 'foo' WHERE owner_id = ${owner}::uuid AND label = 'скоуп из будущего'`,
      );
    } finally {
      await adminClient.end();
    }
    const identity = await verifyBearer(db, token);
    if (identity === null) throw new Error('PAT с незнакомым скоупом не прошёл verifyBearer');
    // verifyBearer не нормализует значение — иначе гейт проверялся бы на подделке
    expect(String(identity.scope)).toBe('foo');

    const unknownScope = ctxFor({
      actorUserId: owner,
      actorKind: 'agent',
      source: 'mcp',
      grant: { id: identity.grantId, scope: identity.scope, label: identity.label },
    });
    expectError(
      await dispatchTool(unknownScope, 'entity_update', {
        id: ticket.id,
        aspects: { 'orbis/task': { status: 'done' } },
      }),
      'FORBIDDEN_LEVEL',
    );
    // …и это не «отказ всему»: чтения и глаголы такому гранту открыты, как worker'у
    expect((await dispatchTool(unknownScope, 'entity_get', { id: ticket.id })).status).toBe('ok');
    expect((await dispatchTool(unknownScope, 'orbis_my_queue', {})).status).toBe('ok');
  });

  test('скоуп full сужению thread_post не подчиняется: пишет в любой свой тред', async () => {
    const r = await dispatchTool(
      ctxFor({
        actorUserId: owner,
        actorKind: 'agent',
        source: 'mcp',
        grant: { id: grantId, scope: 'full', label: 'f' },
      }),
      'thread_post',
      { entity_id: note.id, content: 'Полный доступ пишет куда угодно в графе владельца.' },
    );
    expect(r.status).toBe('ok');
  });
});

// ---------------------------------------------------------------------------
// Глаголы исполнителя: уровень execute на самом dispatch (инвариант 4, §9.3)
// ---------------------------------------------------------------------------

/**
 * Инвариант 4 проверяется здесь ПОВЕДЕНИЕМ диспатча, а не только классификатором
 * (юниты — policy/confirmation.test.ts): между таблицей §7.10 и ответом агенту лежат
 * гейт скоупа, envelope-валидация, `levelGate` и явная ветка «level !== execute» — и
 * pending мог бы родиться на любом из этих шагов. Поэтому круг гоняется целиком: у
 * фонового прогона нет человека, который нажал бы «подтвердить».
 */
describe('dispatchTool: глаголы исполнителя никогда не дают pending (инвариант 4, §9.3)', () => {
  const owner = freshUserId();
  let grantId: string;
  let projectId: string;

  /** Контекст фонового исполнителя: MCP + грант worker, без явной команды человека. */
  const workerCtx = () =>
    ctxFor({
      actorUserId: owner,
      actorKind: 'agent',
      source: 'mcp',
      explicitCommand: false, // за вызовом агента прямой команды владельца нет
      grant: { id: grantId, scope: 'worker', label: 'w' },
    });

  /** Тикет, назначенный этому гранту, — вход круга. */
  async function seedTicket(title: string): Promise<string> {
    const ticket = await seedEntity(owner, {
      title,
      tags: [],
      aspects: {
        'orbis/task': { status: 'planned' },
        'orbis/assignment': { executor: 'agent', grant_id: grantId },
      },
    });
    const r = await execute(db, {
      actorUserId: owner,
      actorKind: 'owner',
      source: 'ui',
      operations: [
        {
          tool: 'relation_create',
          input: { source_id: projectId, target_id: ticket.id, relation_type: 'parent' },
        },
      ],
    });
    if (!r.ok) throw new Error(`сид связи проект→тикет: ${r.error.code} ${r.error.message}`);
    return ticket.id;
  }

  /** Вызов глагола + сверка «ok и НЕ pending» одним местом; отдаёт result глагола. */
  async function verb(
    name: string,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const r = await dispatchTool(workerCtx(), name, input);
    // Сначала — сам инвариант: pending недопустим ни при каком исходе глагола
    expect(r.status).not.toBe('pending_confirmation');
    if (r.status !== 'ok') throw new Error(`«${name}»: ожидался ok, получено ${JSON.stringify(r)}`);
    return r.result as Record<string, unknown>;
  }

  beforeAll(async () => {
    const token = await issuePatGrant(db, { ownerId: owner, label: 'круг', scope: 'worker' });
    const identity = await verifyBearer(db, token);
    if (identity === null) throw new Error('выданный worker-PAT не прошёл verifyBearer');
    grantId = identity.grantId;
    projectId = (
      await seedEntity(owner, {
        title: 'Проект круга',
        tags: [],
        body: '## Процесс\n\nВетка, тесты, отчёт.\n',
        aspects: { 'orbis/project': { stage: 'active' } },
      })
    ).id;
  });

  test('круг my_queue → claim → step → checkpoint: каждый глагол исполнен, ни одного pending', async () => {
    const ticketId = await seedTicket('Тикет до чекпойнта');

    const queue = await verb('orbis_my_queue', {});
    expect((queue.tickets as Array<{ id: string }>).some((t) => t.id === ticketId)).toBe(true);

    const claimed = await verb('orbis_claim_task', { ticket_id: ticketId });
    const runId = claimed.run_id as string;
    expect(claimed.replayed).toBe(false);

    const stepped = await verb('orbis_run_step', { run_id: runId, summary: 'Прочитал задание' });
    expect(stepped.step_count).toBe(1);

    const checked = await verb('orbis_checkpoint', {
      run_id: runId,
      question: 'Какой подход выбрать?',
    });
    expect(checked.ticket_status).toBe('waiting');
  });

  test('круг claim → step → finish на новом тикете: те же execute, ни одного pending', async () => {
    const ticketId = await seedTicket('Тикет до итога');

    const claimed = await verb('orbis_claim_task', { ticket_id: ticketId });
    const runId = claimed.run_id as string;
    await verb('orbis_run_step', { run_id: runId, summary: 'Починил парсер' });

    const finished = await verb('orbis_finish', { run_id: runId, report: 'Готово, проверь' });
    expect(finished.ticket_id).toBe(ticketId);
    // Тикет закрывает не агент (С8): без may_close итог уводит тикет на проверку
    expect(finished.ticket_status).toBe('waiting');
  });

  test('карточки подтверждения глагол не порождает: во всех тредах владельца ни одной pending-записи', async () => {
    // Сверка по состоянию, а не по возвращённому статусу: pending — это ЗАПИСЬ в тред
    // (policy/pending), и «status не pending» ещё не значит «карточка не легла».
    // RLS скоупит chat_messages владельцем — счёт точен по всему его журналу.
    const rows = await withIdentity(db, owner, (tx) =>
      tx.execute(
        sql`SELECT
              count(*) FILTER (WHERE metadata @> '{"pending": {}}'::jsonb)::int AS pendings,
              count(*) FILTER (WHERE metadata @> '{"actions": []}'::jsonb)::int AS audits
            FROM chat_messages`,
      ),
    );
    const { pendings, audits } = rows[0] as { pendings: number; audits: number };
    expect(pendings).toBe(0);
    // Не вырожденно: круги выше действительно писали в журнал этого владельца —
    // «ноль карточек» здесь означает «глаголы исполнились», а не «ничего не было»
    expect(audits).toBeGreaterThan(0);
  });

  test('глагол без гранта (чат/UI-контекст) → VALIDATION: прогон адресуется конкретному доступу (agentOnly)', async () => {
    // Вторая линия гейта agentOnly: реестр чата такие дефы отсекает сам
    // (ai/send-message.ts), но диспатч обязан отказать любому вызывающему без гранта —
    // иначе прогон было бы не к кому отнести
    for (const [name, input] of [
      ['orbis_my_queue', {}],
      ['orbis_claim_task', { ticket_id: newId() }],
      ['orbis_run_step', { run_id: newId(), summary: 'шаг мимо гранта' }],
      ['orbis_checkpoint', { run_id: newId(), question: 'вопрос мимо гранта?' }],
      ['orbis_finish', { run_id: newId(), report: 'итог мимо гранта' }],
    ] as Array<[string, Record<string, unknown>]>) {
      const r = await dispatchTool(ctxFor({ actorUserId: owner }), name, input);
      expectError(r, 'VALIDATION');
    }
  });
});

describe('CAS-предусловие не протекает в путь модели (dispatch/MCP)', () => {
  // Тул-контракт модели не растёт ради сервера: precondition живёт в exec-схеме
  // executor'а, а вход модели и MCP идёт через strict-схему тула (entityUpdateInput) —
  // лишний ключ режется ДО классификации §7.10 и до executor'а. Соседи по смыслу —
  // «bodyDoc не протекает в путь модели» (executor/body-doc.test.ts).
  const PRECONDITION = [{ aspect: 'orbis/task', field: 'status', in: ['planned'] }];

  test('одиночный entity_update с precondition от модели — VALIDATION, правка не применена', async () => {
    const target = await seedEntity(userA, {
      title: 'Тикет модели',
      tags: [],
      aspects: { 'orbis/task': { status: 'planned' } },
    });
    const r = await dispatchTool(ctxFor(), 'entity_update', {
      id: target.id,
      precondition: PRECONDITION,
      aspects: { 'orbis/task': { status: 'in_progress' } },
    });
    expectError(r, 'VALIDATION');
    const rows = await withIdentity(db, userA, (tx) =>
      tx.select().from(entities).where(eq(entities.id, target.id)),
    );
    expect((rows[0]?.aspects as Record<string, Record<string, unknown>>)['orbis/task']).toEqual({
      status: 'planned',
    });
  });

  test('precondition внутри операции batch_execute — VALIDATION с индексом операции', async () => {
    const target = await seedEntity(userA, {
      title: 'Тикет модели в batch',
      tags: [],
      aspects: { 'orbis/task': { status: 'planned' } },
    });
    const r = await dispatchTool(ctxFor(), 'batch_execute', {
      batch_id: newId(),
      operations: [
        {
          tool: 'entity_update',
          input: {
            id: target.id,
            precondition: PRECONDITION,
            aspects: { 'orbis/task': { status: 'in_progress' } },
          },
        },
      ],
    });
    expectError(r, 'VALIDATION');
    if (r.status === 'error') {
      expect((r.error.details as { index: number; tool: string }).index).toBe(0);
      expect((r.error.details as { index: number; tool: string }).tool).toBe('entity_update');
    }
    const rows = await withIdentity(db, userA, (tx) =>
      tx.select().from(entities).where(eq(entities.id, target.id)),
    );
    expect((rows[0]?.aspects as Record<string, Record<string, unknown>>)['orbis/task']).toEqual({
      status: 'planned',
    });
  });
});

describe('Внутренние операции версий недостижимы из пути модели (С11, §9.2)', () => {
  // Закрепление и удаление версии живут в exec-схемах executor'а и в CORE_TOOLS не
  // регистрируются: единственный вход — роутер version (рука владельца). Проверка не
  // декоративна — у precondition и bodyDoc такая же граница уже закреплена тестами выше,
  // а у версий закрытость держалась только на том, что имён нет в реестре.
  for (const tool of ['entity_version_pin', 'entity_version_delete']) {
    test(`batch_execute с операцией ${tool} → VALIDATION «неизвестный тул операции»`, async () => {
      const target = await seedEntity(userA, { title: `Цель ${tool}`, tags: [] });
      const r = await dispatchTool(ctxFor(), 'batch_execute', {
        batch_id: newId(),
        operations: [{ tool, input: { entity_id: target.id, id: newId(), label: 'из модели' } }],
      });
      expectError(r, 'VALIDATION');
      if (r.status === 'error') {
        expect((r.error.details as { index: number; tool: string }).tool).toBe(tool);
      }
    });

    test(`одиночный вызов ${tool} → неизвестный тул (структурный отказ, не исполнение)`, async () => {
      const r = await dispatchTool(ctxFor(), tool, { entity_id: newId(), label: 'из модели' });
      expect(r.status).toBe('error');
      if (r.status === 'error') expect(r.error.message).toContain('неизвест');
    });
  }
});

describe('V1: выдача автономии рутине из чата → pending_confirmation (V1.10, инвариант 7)', () => {
  /** Рутина в минимальной валидной форме (V1.1). */
  const routine = (over: Record<string, unknown> = {}) => ({
    stage: 'active',
    at: '07:00',
    mode: 'propose',
    ...over,
  });

  async function aspectsOf(id: string): Promise<Record<string, unknown>> {
    const rows = await withIdentity(db, userA, (tx) =>
      tx.select({ aspects: entities.aspects }).from(entities).where(eq(entities.id, id)),
    );
    return (rows[0]?.aspects ?? {}) as Record<string, unknown>;
  }

  test('attach_orbis_routine с mode act → pending_confirmation, карточка в треде, граф не тронут', async () => {
    const host = await seedEntity(userA, { title: 'Хост-тред автономии', tags: [] });
    const threadId = await withIdentity(db, userA, (tx) => ensureEntityThread(tx, userA, host.id));
    const target = await seedEntity(userA, { title: 'Утренний обзор', tags: [] });

    const r = await dispatchTool(ctxFor({ threadId }), 'attach_orbis_routine', {
      entity_id: target.id,
      data: routine({ mode: 'act' }),
    });
    expect(r.status).toBe('pending_confirmation');
    if (r.status !== 'pending_confirmation') return;
    expect(r.card).toEqual({
      kind: 'confirmation_card',
      mode: 'explicit',
      pendingId: r.pendingId,
      summary: 'attach_orbis_routine',
    });
    // Право писать в граф не выдано до подтверждения владельца
    expect(await aspectsOf(target.id)).toEqual({});
    const msgs = await messagesIn(userA, threadId);
    expect(msgs.length).toBe(1);
    expect(msgs[0]?.id).toBe(r.pendingId);
  });

  test('entity_update рутины с mode act → pending_confirmation; режим в графе прежний', async () => {
    const target = await seedEntity(userA, {
      title: 'Вечерний разбор',
      tags: [],
      aspects: { 'orbis/routine': routine() },
    });

    const r = await dispatchTool(ctxFor(), 'entity_update', {
      id: target.id,
      aspects: { 'orbis/routine': { mode: 'act' } },
    });
    expect(r.status).toBe('pending_confirmation');
    const stored = (await aspectsOf(target.id))['orbis/routine'] as { mode?: string } | undefined;
    expect(stored?.mode).toBe('propose');
  });

  test('attach_orbis_routine с mode propose автономии не выдаёт → ok, аспект записан', async () => {
    const target = await seedEntity(userA, { title: 'Обзор без прав', tags: [] });

    const r = await dispatchTool(ctxFor(), 'attach_orbis_routine', {
      entity_id: target.id,
      data: routine(),
    });
    expect(r.status).toBe('ok');
    const stored = (await aspectsOf(target.id))['orbis/routine'] as { mode?: string } | undefined;
    expect(stored?.mode).toBe('propose');
  });
});
