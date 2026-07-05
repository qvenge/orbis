// Интеграционные тесты диспатча тулов (§9.2): живая БД, executor без моков.
// Env: DATABASE_URL (orbis_app, RLS enforced) + DATABASE_URL_ADMIN (truncate/сид).
// Политика §7.10 подключена (Task 5): уровень мутации назначает classifyToolCall
// (policy/confirmation, юнит-тесты там же); здесь — поведение уровней через dispatch.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { entityThreadId, newId } from '@orbis/shared';
import { eq, inArray } from 'drizzle-orm';
import { adminDb, appDb, freshUserId, requireEnv, truncateAll } from '../../test/helpers';
import { ensureEntityThread, ensureGlobalThread } from '../chat/threads';
import { aspectDefinitions, chatMessages, entities } from '../db/schema';
import { withIdentity } from '../db/with-identity';
import { execute } from '../executor/executor';
import type { ActionRecord, WireEntity } from '../executor/types';
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

  test('внутренний AI (actorKind=ai): без пометки author_kind', async () => {
    const target = await seedEntity(userA, { title: 'Задача AI', tags: [] });
    const r = await dispatchTool(ctxFor(), 'thread_post', {
      entity_id: target.id,
      content: 'Заметка от AI.',
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
