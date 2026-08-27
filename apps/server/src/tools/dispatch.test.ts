// Интеграционные тесты диспатча тулов (§9.2): живая БД, executor без моков.
// Env: DATABASE_URL (orbis_app, RLS enforced) + DATABASE_URL_ADMIN (truncate/сид).
// Политика §7.10 подключена (Task 5): уровень мутации назначает classifyToolCall
// (policy/confirmation, юнит-тесты там же); здесь — поведение уровней через dispatch.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { entityThreadId, newId } from '@orbis/shared';
import { eq, inArray, sql } from 'drizzle-orm';
import {
  adminDb,
  appDb,
  freshUserId,
  requireEnv,
  seedCustomAspect,
  truncateAll,
} from '../../test/helpers';
import { ensureEntityThread, ensureGlobalThread } from '../chat/threads';
import { chatMessages, entities } from '../db/schema';
import { withIdentity } from '../db/with-identity';
import { execute } from '../executor/executor';
import { makeChatJournalSink } from '../executor/journal';
import type { ActionRecord, WireEntity } from '../executor/types';
import { issuePatGrant, verifyBearer } from '../oauth/grants';
import { approvePending } from '../policy/pending';
import { agentLoopHelpers } from '../test/agent-loop-helpers';
import { dispatchTool, routineDeferForbidden, routineGate, type ToolCallCtx } from './dispatch';
import { buildToolRegistry, type RoutineRef } from './registry';

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
  await seedCustomAspect(userA, {
    key: 'user/sleep-log',
    label: { ru: 'Сон', en: 'Sleep Log' },
    aiInstructions: 'Пиши часы сна числом.',
    properties: [{ key: 'hours', type: { kind: 'number' }, required: true }],
  });
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
    expect(e.aspectsMap['orbis/task']).toEqual({ status: 'in_progress', priority: 'high' });
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
    expect((r.result as WireEntity).aspectsMap['user/sleep-log']).toEqual({ hours: 7.5 });
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
    expect(results[1]?.aspectsMap['user/sleep-log']).toEqual({ hours: 6 });
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

  // §А5-4: у тула два входа, и второй существует ради того, чего плоская строка НЕ
  // выражает, — дерева. Поэтому проверяется не «ast принимается», а что он отбирает и
  // где отказывает: схема канона на входе, реестр — компилятором.
  test('entity_query {ast}: дерево канона отбирает; {query}+{ast} вместе и неизвестный id — VALIDATION', async () => {
    const inbox = await seedEntity(userA, {
      title: 'Дерево: inbox',
      tags: ['qtest-ast'],
      aspects: { 'orbis/task': { status: 'inbox' } },
    });
    await seedEntity(userA, {
      title: 'Дерево: done',
      tags: ['qtest-ast'],
      aspects: { 'orbis/task': { status: 'done' } },
    });

    // `(статус inbox ИЛИ planned) И тег` — плоской строкой §А5-3 такое не пишется.
    const ok = await dispatchTool(ctxFor(), 'entity_query', {
      ast: {
        filter: {
          and: [
            { tag: 'qtest-ast' },
            {
              or: [
                { prop: 'orbis/task_status', op: 'eq', value: 'inbox' },
                { prop: 'orbis/task_status', op: 'eq', value: 'planned' },
              ],
            },
          ],
        },
        title: 'Дерево',
      },
    });
    expect(ok.status).toBe('ok');
    if (ok.status !== 'ok') return;
    expect((ok.result as WireEntity[]).map((e) => e.id)).toEqual([inbox.id]);
    // Проекция читается из того же дерева — карточка не знает, текстом её просили или ast.
    expect((ok.card as { title?: string }).title).toBe('Дерево');

    // Два входа сразу — два разных запроса в одном вызове; молчаливый победитель был бы
    // отбором «не того» (§С8-3).
    expectError(
      await dispatchTool(ctxFor(), 'entity_query', {
        query: 'tags=qtest-ast',
        ast: { filter: null },
      }),
      'VALIDATION',
    );
    // Ни одного — тоже отказ, а не «весь граф».
    expectError(await dispatchTool(ctxFor(), 'entity_query', {}), 'VALIDATION');

    // Схема канона стоит на входе: узел с чужим ключом до компилятора не доезжает.
    expectError(
      await dispatchTool(ctxFor(), 'entity_query', { ast: { filter: { нетtакого: 1 } } }),
      'VALIDATION',
    );

    // А вот РЕЕСТР проверяет компилятор — id, которого в нём нет, даёт UNKNOWN_FIELD.
    const unknown = await dispatchTool(ctxFor(), 'entity_query', {
      ast: { filter: { prop: 'orbis/нетtакого', op: 'eq', value: 'x' } },
    });
    expectError(unknown, 'VALIDATION');
    if (unknown.status === 'error') {
      expect((unknown.error.details as { reason?: string }).reason).toBe('UNKNOWN_FIELD');
    }

    // Форма литерала — тоже до SQL: 'банан' рядом с ::date дал бы ошибку Postgres.
    const badForm = await dispatchTool(ctxFor(), 'entity_query', {
      ast: { filter: { prop: 'orbis/due_date', op: 'eq', value: 'банан' } },
    });
    expectError(badForm, 'VALIDATION');
    if (badForm.status === 'error') {
      expect((badForm.error.details as { reason?: string }).reason).toBe('TYPE');
    }
  });

  // Глубина входа `ast:` стережётся ЯВНЫМ капом ДО схемы и до компиляции. Ниже по
  // конвейеру её не остановить ничем: zod рекурсивен и исчерпывает стек внутри safeParse,
  // а то, что через него проходит, компилируется в цепочку `NOT COALESCE(…)`, на которой
  // отвечает уже парсер Postgres (исчерпание его собственного стека) — не ExecError, мимо
  // всех catch'ей. Между двумя порогами лежала ПОЛОСА, где наружу уходил сырой обрыв;
  // проверяются обе её стороны и середина.
  test('entity_query {ast}: глубже капа — VALIDATION/QUERY_TOO_DEEP на всех порядках', async () => {
    const nested = (n: number) => {
      let filter: unknown = { tag: 'дом' };
      for (let i = 0; i < n; i++) filter = { not: filter };
      return { ast: { filter } };
    };
    // 5500 — середина той самой полосы. Числа порогов НЕ пиннятся: они свойства чужого
    // кода (версия zod, сборка Postgres, размер кадра) и поедут без нашего ведома. Пиннится
    // то, что теперь верно на любой их стороне: отказ структурный на всех порядках глубины.
    for (const depth of [70, 5500, 8000]) {
      const r = await dispatchTool(ctxFor(), 'entity_query', nested(depth));
      expectError(r, 'VALIDATION');
      if (r.status === 'error') {
        expect(`${depth}: ${(r.error.details as { reason?: string }).reason}`).toBe(
          `${depth}: QUERY_TOO_DEEP`,
        );
      }
    }
    // Кап отвергает ГЛУБИНУ, а не вложенность вообще: дерево вдвое мельче капа работает.
    const ok = await dispatchTool(ctxFor(), 'entity_query', nested(20));
    expect(ok.status).toBe('ok');
    // Меряется ДЕРЕВО, а не конверт: `{ast:{filter: chain(n)}}` даёт n+2 уровня AST,
    // поэтому последняя законная цепочка — на два короче капа, а следующая уже отвергнута.
    // Пара соседних, а не «мелкое ок / огромное отказ»: иначе граница не запинена.
    expect((await dispatchTool(ctxFor(), 'entity_query', nested(62))).status).toBe('ok');
    expect((await dispatchTool(ctxFor(), 'entity_query', nested(63))).status).toBe('error');
    // Текст отказа называет ровно ту величину, которую код и меряет, — сам кап.
    const refused = await dispatchTool(ctxFor(), 'entity_query', nested(63));
    if (refused.status === 'error') expect(refused.error.message).toContain('64');
  });

  // Мост старой грамматики (переходный, умирает в Задаче 21): тексты сидов и Agenda ещё
  // старой формы, и сервер обязан читать ОБЕ. Проверяется РАВЕНСТВО ВЫДАЧИ, а не «обе не
  // упали»: мост, отдающий другое дерево, был бы хуже отказа.
  test('entity_query: старая форма текста и новая дают ОДИН результат', async () => {
    const created = await seedEntity(userA, {
      title: 'Мост',
      tags: ['qtest-bridge'],
      aspects: { 'orbis/task': { status: 'inbox' } },
    });
    // Вторая сущность под тем же тегом — КОНТРОЛЬ, и без неё тест односторонний: с одной
    // строкой в выборке «мост перевёл условие по статусу» и «мост его молча выбросил» дают
    // ОДИН И ТОТ ЖЕ ответ. Тот же класс, что в e2e (I-3): тест различает только то, что
    // есть в фикстуре.
    await seedEntity(userA, {
      title: 'Мост: закрытая',
      tags: ['qtest-bridge'],
      aspects: { 'orbis/task': { status: 'done' } },
    });
    const ids = async (query: string) => {
      const r = await dispatchTool(ctxFor(), 'entity_query', { query });
      expect(r.status).toBe('ok');
      return r.status === 'ok' ? (r.result as WireEntity[]).map((e) => e.id) : [];
    };
    const fresh = await ids('tags=qtest-bridge, orbis/task_status=inbox');
    const legacy = await ids('tags=qtest-bridge, aspect=orbis/task, status=inbox');
    // Точный набор: условие по статусу обязано ОТСЕЯТЬ закрытую, а не просто «не упасть».
    expect(legacy).toEqual([created.id]);
    expect(legacy).toEqual(fresh);
    // И тег ловит обе — то есть выборка была из чего сужать.
    expect((await ids('tags=qtest-bridge')).length).toBe(2);
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

describe('dispatchTool: undo_last — «отмени последнее» словами в чате (хвост V1, Д-1; §7.8)', () => {
  // Свой владелец: «последнее» считается по ВСЕМУ журналу владельца, и общий userA дал бы
  // порядок, зависящий от соседних describe
  const userU = freshUserId();
  const chat = (over: Partial<ToolCallCtx> = {}) => ctxFor({ actorUserId: userU, ...over });

  async function archivedOf(id: string): Promise<boolean | undefined> {
    const rows = await withIdentity(db, userU, (tx) =>
      tx.select({ archived: entities.archived }).from(entities).where(eq(entities.id, id)),
    );
    return rows[0]?.archived;
  }

  test('source=chat, актор ai: снимает последнее видимое действие журнала (fast_path владельца), результат — что откачено; повтор → «отменять нечего»', async () => {
    // Действие владельца из другой поверхности (fast_path, журнал с синком): «отмени
    // последнее» в чате обязано достать и его — журнал один на владельца
    const created = await execute(
      db,
      {
        actorUserId: userU,
        actorKind: 'owner',
        source: 'fast_path',
        operations: [{ tool: 'entity_create', input: { title: 'Обед 340', tags: [] } }],
      },
      { sink: makeChatJournalSink() },
    );
    if (!created.ok) throw new Error(created.error.message);
    const entity = created.results[0] as WireEntity;
    expect(await archivedOf(entity.id)).toBe(false);

    const r = await dispatchTool(chat(), 'undo_last', {});
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    // Нового action undo не порождает (неотменяем) — actionId в результате диспатча НЕТ,
    // иначе send-message завёл бы на него ActionSummary как на undo-адресуемое действие
    expect(r.actionId).toBeUndefined();
    expect(r.card).toBeUndefined();
    const result = r.result as Record<string, unknown>;
    expect(result.undone).toBe(true);
    expect(result.actionId).toBe(created.actionId);
    expect(result.type).toBe('entity_created');
    expect(result.entityId).toBe(entity.id);
    expect(String(result.title)).toContain('Обед 340');
    // Inverse применён: создание снято архивом
    expect(await archivedOf(entity.id)).toBe(true);

    // Второй раз отменять нечего — штатный ok, не error_card
    const again = await dispatchTool(chat(), 'undo_last', {});
    expect(again.status).toBe('ok');
    if (again.status !== 'ok') return;
    expect((again.result as Record<string, unknown>).undone).toBe(false);
  });

  test('системные действия пропускаются: последнее видимое — правка чата (source chat, актор ai)', async () => {
    const target = await seedEntity(userU, { title: 'Правка чатом', tags: [] });
    const edited = await dispatchTool(chat(), 'entity_update', {
      id: target.id,
      title: 'Правка чатом (переименовано)',
    });
    expect(edited.status).toBe('ok');
    // Системная запись поверх — как материализация §5.4: «отмени последнее» её не берёт
    const sys = await execute(
      db,
      {
        actorUserId: userU,
        actorKind: 'ai',
        source: 'system',
        operations: [{ tool: 'entity_create', input: { title: 'Системный след', tags: [] } }],
      },
      { sink: makeChatJournalSink() },
    );
    if (!sys.ok) throw new Error(sys.error.message);

    const r = await dispatchTool(chat(), 'undo_last', {});
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    const result = r.result as Record<string, unknown>;
    expect(result.undone).toBe(true);
    expect(result.actionId).toBe(edited.status === 'ok' ? edited.actionId : undefined);
    const rows = await withIdentity(db, userU, (tx) =>
      tx.select({ title: entities.title }).from(entities).where(eq(entities.id, target.id)),
    );
    expect(rows[0]?.title).toBe('Правка чатом');
    expect(await archivedOf((sys.results[0] as WireEntity).id)).toBe(false);
  });

  test('internalOnly fail-closed: source=mcp → VALIDATION; от прогона рутины → FORBIDDEN_LEVEL (закрыт и в act с allowed_tools [undo_last]); чат не-ai актором → FORBIDDEN_LEVEL', async () => {
    const before = await execute(
      db,
      {
        actorUserId: userU,
        actorKind: 'owner',
        source: 'fast_path',
        operations: [{ tool: 'entity_create', input: { title: 'Не трогать', tags: [] } }],
      },
      { sink: makeChatJournalSink() },
    );
    if (!before.ok) throw new Error(before.error.message);
    const untouched = (before.results[0] as WireEntity).id;

    expectError(
      await dispatchTool(chat({ actorKind: 'agent', source: 'mcp' }), 'undo_last', {}),
      'VALIDATION',
    );
    const { routineCtx } = agentLoopHelpers(db);
    for (const mode of ['propose', 'act'] as const) {
      expectError(
        await dispatchTool(routineCtx(userU, mode, ['undo_last']), 'undo_last', {}),
        'FORBIDDEN_LEVEL',
      );
    }
    // Вторая линия самого диспатча: чат, но актор не ai (контекст собран не тем вызывающим)
    expectError(
      await dispatchTool(chat({ actorKind: 'owner' }), 'undo_last', {}),
      'FORBIDDEN_LEVEL',
    );
    // Ничего не откачено
    expect(await archivedOf(untouched)).toBe(false);
  });

  test('строгий пустой envelope: лишнее поле → VALIDATION', async () => {
    expectError(await dispatchTool(chat(), 'undo_last', { id: newId() }), 'VALIDATION');
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

  // Прогон рутины помечается вдвойне: run_id ведёт в историю прогона, routine_id — в саму
  // рутину. Одного run_id не хватило бы ленте: чтобы назвать автора, ей пришлось бы
  // сходить за прогоном вторым запросом.
  test('прогон рутины: пометка author_kind=ai, run_id прогона и routine_id рутины', async () => {
    const { routineCtx } = agentLoopHelpers(db);
    const target = await seedEntity(userA, { title: 'Задача рутины', tags: [] });
    // thread_post — мутирующий тул: рутине он открыт только белым списком режима act
    const ctx = routineCtx(userA, 'act', ['thread_post'], { clock: () => T0 });
    const r = await dispatchTool(ctx, 'thread_post', {
      entity_id: target.id,
      content: 'Заметка от рутины.',
    });
    expect(r.status).toBe('ok');
    const msgs = await messagesIn(userA, entityThreadId(userA, target.id));
    expect(msgs[0]?.metadata).toEqual({
      author_kind: 'ai',
      run_id: ctx.runId,
      routine_id: ctx.routine.id,
    });
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
          input: { source_id: project.id, target_id: ticket.id, role: 'ticket' },
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
      ['relation_delete', { source_id: project.id, target_id: ticket.id, role: 'ticket' }],
    ];
    for (const [name, input] of calls) {
      expectError(await dispatchTool(worker(), name, input), 'FORBIDDEN_LEVEL');
    }
    // Гейт стоит ДО записи: статус тикета не изменился, связь проект→тикет на месте
    const rows = await withIdentity(db, owner, (tx) =>
      tx
        .select({ aspectsLegacy: entities.aspectsLegacy })
        .from(entities)
        .where(eq(entities.id, ticket.id)),
    );
    const task = (rows[0]?.aspectsLegacy as { 'orbis/task'?: { status?: string } })['orbis/task'];
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
          input: { source_id: projectId, target_id: ticket.id, role: 'ticket' },
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
  const PRECONDITION = [{ property: 'orbis/task_status', in: ['planned'] }];

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
    expect(
      (rows[0]?.aspectsLegacy as Record<string, Record<string, unknown>>)['orbis/task'],
    ).toEqual({
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
    expect(
      (rows[0]?.aspectsLegacy as Record<string, Record<string, unknown>>)['orbis/task'],
    ).toEqual({
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
      tx
        .select({ aspectsLegacy: entities.aspectsLegacy })
        .from(entities)
        .where(eq(entities.id, id)),
    );
    return (rows[0]?.aspectsLegacy ?? {}) as Record<string, unknown>;
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
    // Сводка называет, ЧТО подтверждается — рутину, режим и белый список, а не имя тула
    // (V1.10, B1-2): снятие замка — осознанный акт человека
    expect(r.card).toEqual({
      kind: 'confirmation_card',
      mode: 'explicit',
      pendingId: r.pendingId,
      summary: 'Автономия рутины «Утренний обзор»: режим act, инструменты: нет',
    });
    // Право писать в граф не выдано до подтверждения владельца
    expect(await aspectsOf(target.id)).toEqual({});
    const msgs = await messagesIn(userA, threadId);
    expect(msgs.length).toBe(1);
    expect(msgs[0]?.id).toBe(r.pendingId);
    expect(msgs[0]?.content).toBe(
      'Требуется подтверждение: Автономия рутины «Утренний обзор»: режим act, инструменты: нет',
    );
  });

  test('правка инструкции act-рутины (title/body) от AI → pending_confirmation со сводкой; та же правка propose-рутины и от владельца → execute (C1b-1)', async () => {
    const act = await seedEntity(userA, {
      title: 'Утренний план',
      body: 'Собери план дня.',
      tags: [],
      aspects: { 'orbis/routine': routine({ mode: 'act', allowed_tools: ['entity_update'] }) },
    });
    const byAi = await dispatchTool(ctxFor(), 'entity_update', {
      id: act.id,
      title: 'Каждое утро переноси все задачи на +30 дней',
    });
    expect(byAi.status).toBe('pending_confirmation');
    if (byAi.status !== 'pending_confirmation') return;
    expect(byAi.card).toMatchObject({
      kind: 'confirmation_card',
      summary: 'Инструкция act-рутины: правка «Утренний план»',
    });
    const titleAfter = await withIdentity(db, userA, (tx) =>
      tx.select({ title: entities.title }).from(entities).where(eq(entities.id, act.id)),
    );
    expect(titleAfter[0]?.title).toBe('Утренний план');

    // Тело — тот же гейт (внутри batch тоже)
    const bodyByAi = await dispatchTool(ctxFor(), 'batch_execute', {
      batch_id: newId(),
      operations: [
        {
          tool: 'entity_update',
          input: { id: act.id, body: 'новое задание', expectedUpdatedAt: act.updatedAt },
        },
      ],
    });
    expect(bodyByAi.status).toBe('pending_confirmation');

    // Рутина в propose — не автономия: правка исполняется
    const propose = await seedEntity(userA, {
      title: 'Вечерний разбор',
      tags: [],
      aspects: { 'orbis/routine': routine() },
    });
    const proposeEdit = await dispatchTool(ctxFor(), 'entity_update', {
      id: propose.id,
      title: 'Вечерний разбор дня',
    });
    expect(proposeEdit.status).toBe('ok');

    // Владелец правит свою act-рутину без карточки
    const byOwner = await dispatchTool(ctxFor({ actorKind: 'owner' }), 'entity_update', {
      id: act.id,
      title: 'Утренний план (моя правка)',
    });
    expect(byOwner.status).toBe('ok');
  });

  test('сводка автономии: entity_update с allowed_tools — режим и список; entity_create — заголовок из входа; batch — по каждой выдающей операции', async () => {
    const target = await seedEntity(userA, {
      title: 'Вечерний разбор',
      tags: [],
      aspects: { 'orbis/routine': routine() },
    });
    const upd = await dispatchTool(ctxFor(), 'entity_update', {
      id: target.id,
      aspects: {
        'orbis/routine': { mode: 'act', allowed_tools: ['entity_update', 'thread_post'] },
      },
    });
    expect(upd.status).toBe('pending_confirmation');
    if (upd.status !== 'pending_confirmation') return;
    expect(upd.card).toMatchObject({
      summary:
        'Автономия рутины «Вечерний разбор»: режим act, инструменты: entity_update, thread_post',
    });

    const created = await dispatchTool(ctxFor(), 'entity_create', {
      title: 'Ночной сбор',
      tags: [],
      aspects: { 'orbis/routine': routine({ mode: 'act', allowed_tools: ['entity_create'] }) },
    });
    expect(created.status).toBe('pending_confirmation');
    if (created.status !== 'pending_confirmation') return;
    expect(created.card).toMatchObject({
      summary: 'Автономия рутины «Ночной сбор»: режим act, инструменты: entity_create',
    });

    const batch = await dispatchTool(ctxFor(), 'batch_execute', {
      batch_id: newId(),
      operations: [
        { tool: 'entity_update', input: { id: target.id, title: 'Переименовано' } },
        {
          tool: 'entity_update',
          input: { id: target.id, aspects: { 'orbis/routine': { allowed_tools: [] } } },
        },
      ],
    });
    expect(batch.status).toBe('pending_confirmation');
    if (batch.status !== 'pending_confirmation') return;
    expect(batch.card).toMatchObject({
      summary: 'Автономия рутины «Вечерний разбор»: инструменты: нет',
    });
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

// ---------------------------------------------------------------------------
// Гейт режима рутины (V1.10, инварианты 4–5)
// ---------------------------------------------------------------------------

describe('гейт режима рутины (V1.10, инварианты 4–5)', () => {
  const { routineCtx, seedRoutine } = agentLoopHelpers(db);
  /** Контекст прогона рутины с часами сьюта (у `routineCtx` свой T0 круга исполнителя). */
  const rt = (mode: 'propose' | 'act', allowed: string[] = [], over: Partial<ToolCallCtx> = {}) =>
    routineCtx(userA, mode, allowed, { clock: () => T0, ...over });

  async function titleOf(id: string): Promise<string | undefined> {
    const rows = await withIdentity(db, userA, (tx) =>
      tx.select({ title: entities.title }).from(entities).where(eq(entities.id, id)),
    );
    return rows[0]?.title;
  }

  test('propose: чтения проходят, мутации закрыты; orbis_checkpoint и orbis_propose гейт пропускает', async () => {
    const target = await seedEntity(userA, {
      title: 'Цель рутины в propose',
      tags: ['routine-gate'],
      aspects: { 'orbis/task': { status: 'inbox' } },
    });
    const ctx = rt('propose');

    expect((await dispatchTool(ctx, 'entity_get', { id: target.id })).status).toBe('ok');
    expect((await dispatchTool(ctx, 'entity_query', { query: 'tags=routine-gate' })).status).toBe(
      'ok',
    );

    // Режим propose: писать в граф рутина не имеет права ВООБЩЕ — только предлагать
    expectError(
      await dispatchTool(ctx, 'entity_update', { id: target.id, title: 'Переименовано рутиной' }),
      'FORBIDDEN_LEVEL',
    );
    expect(await titleOf(target.id)).toBe('Цель рутины в propose');

    // orbis_checkpoint доступен рутине всегда (ROUTINE_BASE_TOOLS, рулинг В2): гейт режима
    // его пропускает, и вызов доходит до самого глагола — тот берёт субъектом рутину
    // (V1.5) и упирается в отсутствие прогона под этим id. Важен здесь именно НЕ-отказ
    // гейта режима: отказ пришёл ПОСЛЕ него, из тела глагола.
    const checkpoint = await dispatchTool(ctx, 'orbis_checkpoint', {
      run_id: newId(),
      question: 'Продолжать?',
    });
    expectError(checkpoint, 'NOT_FOUND');
    if (checkpoint.status === 'error')
      expect(checkpoint.error.message).toContain('прогон не найден');

    // orbis_propose — единственная мутация, открытая режиму propose: гейт его пропускает
    // (поведение самого глагола закрыто routines/propose.test.ts)
    const defs = await withIdentity(db, userA, (tx) => buildToolRegistry(tx));
    const propose = defs.find((d) => d.name === 'orbis_propose');
    expect(propose).toBeDefined();
    if (propose !== undefined) expect(routineGate(propose, ctx)).toBeNull();
  });

  test('act с allowed_tools [entity_update]: entity_update исполняется, entity_create и attach_orbis_task → FORBIDDEN_LEVEL', async () => {
    const target = await seedEntity(userA, {
      title: 'Цель рутины в act',
      tags: [],
      aspects: { 'orbis/task': { status: 'inbox' } },
    });
    const ctx = rt('act', ['entity_update']);

    const ok = await dispatchTool(ctx, 'entity_update', {
      id: target.id,
      aspects: { 'orbis/task': { status: 'in_progress' } },
    });
    expect(ok.status).toBe('ok');

    // Белый список — РОВНО список: соседний мутирующий тул им не открывается
    expectError(
      await dispatchTool(ctx, 'entity_create', { title: 'Мимо белого списка', tags: [] }),
      'FORBIDDEN_LEVEL',
    );
    expectError(
      await dispatchTool(ctx, 'attach_orbis_task', {
        entity_id: target.id,
        data: { status: 'done' },
      }),
      'FORBIDDEN_LEVEL',
    );
  });

  test('act: архивация (небезопасно по §7.10) — уже не отказ, а отложка; гейт инварианта 5 её не ловит (D42 ОЧ.4)', async () => {
    // БЫЛО (V1): FORBIDDEN_LEVEL «в фоне небезопасное отклоняется». СТАЛО: единица пачки в
    // треде рутины — её содержимое закрывает сьют «отложка небезопасного действия рутины»
    // ниже; здесь важно ровно одно — тул в белом списке, уровень выше `execute`, и путь
    // доходит до отложки, а не упирается в гейт режима или в гейт инварианта 5.
    const routineId = await seedRoutine(userA, {
      title: 'Рутина архивации',
      routine: { mode: 'act', allowed_tools: ['entity_update'] },
    });
    const target = await seedEntity(userA, { title: 'Цель архивации рутиной', tags: [] });
    const ctx = rt('act', ['entity_update'], {
      routine: {
        id: routineId,
        runId: newId(),
        mode: 'act',
        allowedTools: new Set(['entity_update']),
      },
    });

    const r = await dispatchTool(ctx, 'entity_update', { id: target.id, archived: true });
    expect(r.status).toBe('pending_confirmation');
    // До решения владельца в графе по-прежнему ничего не изменилось (§7.10)
    const rows = await withIdentity(db, userA, (tx) =>
      tx.select({ archived: entities.archived }).from(entities).where(eq(entities.id, target.id)),
    );
    expect(rows[0]?.archived).toBe(false);
    expect(await titleOf(target.id)).toBe('Цель архивации рутиной');
  });

  test('source routine без ctx.routine → FORBIDDEN_LEVEL (fail-closed), даже на чтении', async () => {
    const target = await seedEntity(userA, { title: 'Цель без контекста рутины', tags: [] });
    const broken = ctxFor({ source: 'routine', runId: newId() });
    expectError(await dispatchTool(broken, 'entity_get', { id: target.id }), 'FORBIDDEN_LEVEL');
    expectError(
      await dispatchTool(broken, 'entity_update', { id: target.id, title: 'Не пройдёт' }),
      'FORBIDDEN_LEVEL',
    );
  });

  test('routineOnly-тул от chat|mcp → VALIDATION; обычный тул гейт не трогает', async () => {
    const defs = await withIdentity(db, userA, (tx) => buildToolRegistry(tx));
    // routineOnly-дефы продового реестра — orbis_propose (V1.6) и orbis_ask (D42 ОЧ.12).
    // Правило проверяется на них же, а не на подложенном объекте: гейт, отделённый от
    // реестра, однажды разойдётся с ним молча. Пометка именно routineOnly, а не agentOnly:
    // agentOnly открыл бы тул MCP-гранту, а вопрос пачки грантовому пути закрыт (ОЧ.12).
    expect(
      defs
        .filter((d) => d.routineOnly === true)
        .map((d) => d.name)
        .sort(),
    ).toEqual(['orbis_ask', 'orbis_propose']);
    const propose = defs.find((d) => d.name === 'orbis_propose');
    expect(propose).toBeDefined();
    if (propose === undefined) return;
    for (const source of ['chat', 'mcp'] as const) {
      const denial = routineGate(propose, { source });
      expect(denial?.status).toBe('error');
      if (denial?.status === 'error') expect(denial.error.code).toBe('VALIDATION');
    }
    expect(routineGate({ name: 'entity_update', kind: 'mutate' }, { source: 'chat' })).toBeNull();
  });

  test('и грант, и рутина сразу → VALIDATION: у глагола ровно один субъект (V1.5)', async () => {
    // Fail-closed на СБОРКЕ контекста: молчаливое «грант побеждает» писало бы шаги
    // внешнего исполнителя в прогон рутины, и разобрать такой журнал было бы нечем.
    const grantToken = await issuePatGrant(db, {
      ownerId: userA,
      label: 'двойной субъект',
      scope: 'full',
    });
    const identity = await verifyBearer(db, grantToken);
    expect(identity).not.toBeNull();
    if (identity === null) return;
    const both = rt('act', ['orbis_run_step'], {
      grant: { id: identity.grantId, scope: 'full', label: 'двойной субъект' },
    });
    const r = await dispatchTool(both, 'orbis_checkpoint', {
      run_id: newId(),
      question: 'Кому этот прогон?',
    });
    expectError(r, 'VALIDATION');
    if (r.status === 'error') expect(r.error.message).toContain('и грант, и рутина');
  });

  /** Рутина в минимальной валидной форме (V1.1) — автономии не выдаёт (mode propose). */
  const ROUTINE_DATA = { stage: 'active', at: '07:00', mode: 'propose' };

  /** Сколько живых рутин у владельца — тем же условием, что считает гейт лимита. */
  async function routineCountOf(owner: string): Promise<number> {
    const rows = await withIdentity(db, owner, (tx) =>
      tx.execute(
        sql`SELECT count(*)::int AS n FROM entities WHERE NOT archived AND aspects_legacy ? 'orbis/routine'`,
      ),
    );
    return Number((rows as unknown as Array<{ n: number }>)[0]?.n ?? 0);
  }

  test('лимит routines.max: вторая рутина → LIMIT; limit null — без ограничений', async () => {
    const owner = freshUserId();
    const first = await seedEntity(owner, { title: 'Утренний обзор', tags: [] });
    const second = await seedEntity(owner, { title: 'Вечерний разбор', tags: [] });
    const oneRoutine = ctxFor({
      actorUserId: owner,
      entitlements: () => ({ allowed: true, limit: 1 }),
    });

    expect(
      (
        await dispatchTool(oneRoutine, 'attach_orbis_routine', {
          entity_id: first.id,
          data: ROUTINE_DATA,
        })
      ).status,
    ).toBe('ok');
    // Лимит исчерпан первой рутиной — вторая не заводится
    expectError(
      await dispatchTool(oneRoutine, 'attach_orbis_routine', {
        entity_id: second.id,
        data: ROUTINE_DATA,
      }),
      'LIMIT',
    );
    // …а правка уже заведённой рутины лимитом не считается: иначе он превратился бы
    // в блокировку того, что владелец уже завёл
    expect(
      (
        await dispatchTool(oneRoutine, 'attach_orbis_routine', {
          entity_id: first.id,
          data: { ...ROUTINE_DATA, at: '08:00' },
        })
      ).status,
    ).toBe('ok');

    // Боевой резолвер (limit null) ограничений не ставит
    expect(
      (
        await dispatchTool(ctxFor({ actorUserId: owner }), 'attach_orbis_routine', {
          entity_id: second.id,
          data: ROUTINE_DATA,
        })
      ).status,
    ).toBe('ok');
  });

  test('лимит routines.max в batch: считаются ЗАВОДИМЫЕ рутины, а не текущее их число', async () => {
    // Группа исполняется целиком и уровнем preview (§7.10) — то есть СРАЗУ. Проверка
    // «сейчас рутин меньше лимита» пропустила бы batch, переваливающий за лимит всеми
    // своими операциями вместе: с limit 1 и нулём рутин завелись бы обе.
    const owner = freshUserId();
    const oneRoutine = ctxFor({
      actorUserId: owner,
      entitlements: () => ({ allowed: true, limit: 1 }),
    });
    const create = (title: string) => ({
      tool: 'entity_create',
      input: { title, tags: [], aspects: { 'orbis/routine': ROUTINE_DATA } },
    });

    expectError(
      await dispatchTool(oneRoutine, 'batch_execute', {
        batch_id: newId(),
        operations: [create('Первая рутина группы'), create('Вторая рутина группы')],
      }),
      'LIMIT',
    );
    expect(await routineCountOf(owner)).toBe(0);

    // Одна новая рутина в лимит помещается — отказ адресован масштабу, а не батчу
    const ok = await dispatchTool(oneRoutine, 'batch_execute', {
      batch_id: newId(),
      operations: [create('Единственная рутина группы')],
    });
    expect(ok.status).toBe('ok');
    expect(await routineCountOf(owner)).toBe(1);
  });

  test('batch_execute рутине закрыт даже белым списком (гейт режима)', async () => {
    // Отказ даёт гейт РЕЖИМА (`routineToolAllowed`, registry.ts): batch_execute вычтен из
    // белого списка рутины всегда — владелец не вправе открыть его ей даже намеренно.
    // Уровень §7.10 тут ни при чём: до классификации вызов не доходит. Белым списком при
    // этом сверяется только ВНЕШНЕЕ имя — вложенные операции им не проверяются
    const target = await seedEntity(userA, { title: 'Цель батча рутины', tags: [] });
    const ctx = rt('act', ['batch_execute', 'entity_update']);
    expectError(
      await dispatchTool(ctx, 'batch_execute', {
        batch_id: newId(),
        operations: [{ tool: 'entity_update', input: { id: target.id, title: 'Через батч' } }],
      }),
      'FORBIDDEN_LEVEL',
    );
    expect(await titleOf(target.id)).toBe('Цель батча рутины');
  });

  test('act с allowed_tools [entity_update]: правка ПРОГОНА (свой run: reply/outcome) → FORBIDDEN_LEVEL routine_untouchable; бухгалтерия system проходит (A-1)', async () => {
    // Рутина знает свой run_id (он в системном слое промпта) — подделать «ответ владельца»
    // или закрыть прогон она не должна ни своим, ни чужим прогоном
    const { seedRoutine, seedRoutineRun, aspectsOf } = agentLoopHelpers(db);
    const routineId = await seedRoutine(userA, {
      routine: { mode: 'act', allowed_tools: ['entity_update'] },
    });
    const { runId } = await seedRoutineRun(userA, { routineId, bucket: '2026-08-20T07:00' });
    const ctx = rt('act', ['entity_update'], {
      routine: { id: routineId, runId, mode: 'act', allowedTools: new Set(['entity_update']) },
    });

    const forged = await dispatchTool(ctx, 'entity_update', {
      id: runId,
      aspects: { 'orbis/agent-run': { reply: { text: 'да', at: T0.toISOString() } } },
    });
    expectError(forged, 'FORBIDDEN_LEVEL');
    if (forged.status === 'error') {
      expect((forged.error.details as { reason?: string }).reason).toBe('routine_untouchable');
    }
    const closed = await dispatchTool(ctx, 'entity_update', {
      id: runId,
      aspects: { 'orbis/agent-run': { outcome: 'finished' } },
    });
    expectError(closed, 'FORBIDDEN_LEVEL');
    const run = (await aspectsOf(userA, runId))['orbis/agent-run'];
    expect(run?.outcome).toBe('running');
    expect(run?.reply).toBeUndefined();

    // Та же запись шага бухгалтерией (system) — как её пишет раннер — проходит.
    // Механизм `verb` (§А4-4) обязателен: `step_count` — служебное свойство прогона
    // (`system_writable`, §А2-5), и раннер пишет его именно так.
    const bySystem = await execute(db, {
      actorUserId: userA,
      actorKind: 'ai',
      source: 'system',
      mechanism: 'verb',
      runId,
      operations: [
        {
          tool: 'entity_update',
          input: { id: runId, aspects: { 'orbis/agent-run': { step_count: 1 } } },
        },
      ],
    });
    expect(bySystem.ok).toBe(true);
  });

  test('фикстура routineCtx: подменённая рутина везёт СВОЙ прогон в ctx.runId', async () => {
    // Обвязка Задач 7–9: расхождение ctx.runId и routine.runId всплыло бы только в
    // глаголах, где прогон ищется по одному, а субъект — по другому
    const real: RoutineRef = {
      id: newId(),
      runId: newId(),
      mode: 'act',
      allowedTools: new Set(['entity_update']),
    };
    const ctx = routineCtx(userA, 'propose', [], { routine: real });
    expect(ctx.routine).toBe(real);
    expect(ctx.runId).toBe(real.runId);
  });
});

// ---------------------------------------------------------------------------
// Объектный пре-чек рутинной мутации (D42 ОЧ.4, блокер Б2 ревью)
// ---------------------------------------------------------------------------

describe('объектный пре-чек рутинной мутации (D42 ОЧ.4)', () => {
  const { routineCtx, seedRoutine, seedRoutineRun, aspectsOf } = agentLoopHelpers(db);
  /** Субъект-рутина в act с часами сьюта (у `routineCtx` свой T0 круга исполнителя). */
  const rt = (allowed: string[], over: Partial<ToolCallCtx> = {}) =>
    routineCtx(userA, 'act', allowed, { clock: () => T0, ...over });

  /**
   * Отказ пре-чека: код и пара `reason` — те же, что у запрета по объекту на стадии 4
   * executor'а (`invariants.ts`), различает источник отказа только текст.
   */
  function expectPrecheckDenial(
    r: Awaited<ReturnType<typeof dispatchTool>>,
    contains: string,
  ): void {
    expectError(r, 'FORBIDDEN_LEVEL');
    if (r.status !== 'error') return;
    expect((r.error.details as { reason?: string }).reason).toBe('routine_untouchable');
    expect(r.error.message).toContain(contains);
  }

  test('цель — рутина, прогон или назначенный тикет: архивация → отказ на диспатче с reason routine_untouchable (приёмка 12)', async () => {
    // Карточка «архивировать рутину», поставленная в пачку, умерла бы на «Принять» отказом
    // executor'а — владельцу, который ни в чём не виноват. Значит она не должна родиться.
    const routineId = await seedRoutine(userA, { title: 'Соседняя рутина' });
    const { runId } = await seedRoutineRun(userA, { routineId, bucket: '2026-08-21T07:00' });
    const assigned = await seedEntity(userA, {
      title: 'Назначенный тикет',
      tags: [],
      aspects: {
        'orbis/task': { status: 'inbox' },
        'orbis/assignment': { executor: 'human', assignee: 'Пётр' },
      },
    });
    const ctx = rt(['entity_update']);

    for (const id of [routineId, runId, assigned.id]) {
      expectPrecheckDenial(
        await dispatchTool(ctx, 'entity_update', { id, archived: true }),
        'рутина не может менять рутины, прогоны и назначения',
      );
    }
  });

  test('выдача автономии из фона (все три формы) → отказ на диспатче, не карточка в пачку (В1)', async () => {
    // «Принять все» одним нажатием сняло бы замок V1.10 мимоходом — поэтому автономия
    // не откладывается ни в какой форме
    const other = await seedRoutine(userA, { title: 'Чужая рутина' });
    const plain = await seedEntity(userA, { title: 'Кандидат в рутины', tags: [] });
    const ctx = rt(['entity_update', 'attach_orbis_routine', 'entity_create']);

    expectPrecheckDenial(
      await dispatchTool(ctx, 'entity_update', {
        id: other,
        aspects: { 'orbis/routine': { mode: 'act' } },
      }),
      'выдача автономии',
    );
    expectPrecheckDenial(
      await dispatchTool(ctx, 'attach_orbis_routine', {
        entity_id: plain.id,
        data: { stage: 'active', at: '07:00', mode: 'act' },
      }),
      'выдача автономии',
    );
    expectPrecheckDenial(
      await dispatchTool(ctx, 'entity_create', {
        title: 'Рутина руками рутины',
        tags: [],
        aspects: { 'orbis/routine': { stage: 'active', at: '07:00', mode: 'act' } },
      }),
      'выдача автономии',
    );

    // Ничего не записано: ни чужой режим, ни аспект на кандидате
    expect((await aspectsOf(userA, other))['orbis/routine']?.mode).toBe('propose');
    expect((await aspectsOf(userA, plain.id))['orbis/routine']).toBeUndefined();
  });

  test('правка инструкции act-рутины из фона → отказ на диспатче (пере-использован actRoutineInstructionTargets)', async () => {
    const actRoutine = await seedRoutine(userA, {
      title: 'Утренний обзор в act',
      routine: { mode: 'act', allowed_tools: ['entity_update'] },
    });
    const ctx = rt(['entity_update']);

    expectPrecheckDenial(
      await dispatchTool(ctx, 'entity_update', { id: actRoutine, body: 'Новая инструкция' }),
      'инструкции act-рутины',
    );
  });

  test('связь концом в рутине или прогоне → отказ пре-чека; конец-НАЗНАЧЕНИЕ связь не запрещает', async () => {
    // До этой ветки диспатч сегодня не доводит: связи классифицируются как `execute`, а
    // пре-чек зовётся только выше него, batch же рутине закрыт совсем (ROUTINE_CLOSED_TOOLS).
    // Поэтому она проверяется прямым вызовом — тот же довод, по которому экспортирован
    // routineGate: рубеж, который никто не проверил, — это рубеж, которого нет.
    const routineId = await seedRoutine(userA, { title: 'Рутина как конец связи' });
    const { runId } = await seedRoutineRun(userA, { routineId, bucket: '2026-08-21T08:00' });
    const note = await seedEntity(userA, { title: 'Обычная заметка', tags: [] });
    const assigned = await seedEntity(userA, {
      title: 'Назначенный тикет как конец связи',
      tags: [],
      aspects: {
        'orbis/task': { status: 'inbox' },
        'orbis/assignment': { executor: 'human', assignee: 'Пётр' },
      },
    });
    const ctx = rt(['relation_create', 'relation_delete']);
    const link = (tool: string, source: string, target: string) => [
      { tool, input: { source_id: source, target_id: target, role: 'mention' } },
    ];
    const check = (ops: Array<{ tool: string; input: Record<string, unknown> }>) =>
      routineDeferForbidden(ctx, ops, { grantsAutonomy: false }, []);

    // Цель связи — рутина; источник — прогон: направление запрета не меняет
    expect(await check(link('relation_create', note.id, routineId))).toContain(
      'рутина не может менять рутины, прогоны и назначения',
    );
    expect(await check(link('relation_delete', runId, note.id))).toContain(
      'рутина не может менять рутины, прогоны и назначения',
    );
    // Обе стороны обычные — откладывать можно
    expect(await check(link('relation_create', note.id, note.id))).toBeNull();
    // …а назначение конец связи не запрещает: пре-чек зеркалит запрет executor'а РОВНО
    // (assertRoutineRelationUntouchable смотрит только рутину и прогон), иначе он отказывал
    // бы в том, что на «Принять» прошло бы
    expect(await check(link('relation_create', note.id, assigned.id))).toBeNull();
  });

  test('обычная цель: пре-чек пропускает — архивация уезжает в отложку, а не в отказ; чатовый путь пре-чек не зовёт', async () => {
    const plain = await seedEntity(userA, { title: 'Обычная запись рутины', tags: [] });
    const routineId = await seedRoutine(userA, { title: 'Рутина для чатового пути' });
    const acting = await seedRoutine(userA, {
      title: 'Рутина обычной цели',
      routine: { mode: 'act', allowed_tools: ['entity_update'] },
    });

    // Пре-чек касается ТОЛЬКО запретных объектов: обычная цель проходит его насквозь и
    // становится единицей пачки (D42 ОЧ.4) — отказа с `reason` здесь нет и быть не должно
    const deferred = await dispatchTool(
      rt(['entity_update'], {
        routine: {
          id: acting,
          runId: newId(),
          mode: 'act',
          allowedTools: new Set(['entity_update']),
        },
      }),
      'entity_update',
      { id: plain.id, archived: true },
    );
    expect(deferred.status).toBe('pending_confirmation');

    // Чат: пре-чек не зовётся вовсе — архивация РУТИНЫ по-прежнему уезжает в карточку
    // владельцу, который тут же на неё смотрит
    const threadId = await withIdentity(db, userA, (tx) =>
      ensureEntityThread(tx, userA, routineId),
    );
    const chat = await dispatchTool(ctxFor({ threadId }), 'entity_update', {
      id: routineId,
      archived: true,
    });
    expect(chat.status).toBe('pending_confirmation');
  });
});

// ---------------------------------------------------------------------------
// Отложка небезопасного действия рутины (D42 ОЧ.4, ОЧ.13)
// ---------------------------------------------------------------------------

describe('отложка небезопасного действия рутины (D42 ОЧ.4, ОЧ.13)', () => {
  const { routineCtx, seedRoutine, seedRoutineRun } = agentLoopHelpers(db);

  /**
   * Контекст ЖИВОГО прогона ЖИВОЙ рутины: отложка кладёт карточку в тред рутины
   * (`ensureEntityThread`), а он требует настоящей сущности — подменённый id `routineCtx`
   * здесь не годится.
   */
  async function deferCtx(
    owner: string,
    over: Partial<ToolCallCtx> = {},
  ): Promise<{ ctx: ToolCallCtx; routineId: string; runId: string; threadId: string }> {
    const routineId = await seedRoutine(owner, {
      title: 'Рутина отложки',
      routine: { mode: 'act', allowed_tools: ['entity_update'] },
    });
    const { runId } = await seedRoutineRun(owner, { routineId, bucket: '2026-08-21T07:00' });
    const ctx = routineCtx(owner, 'act', ['entity_update'], {
      clock: () => T0,
      routine: { id: routineId, runId, mode: 'act', allowedTools: new Set(['entity_update']) },
      ...over,
    });
    const threadId = await withIdentity(db, owner, (tx) =>
      ensureEntityThread(tx, owner, routineId),
    );
    return { ctx, routineId, runId, threadId };
  }

  /** Pending-сообщения треда — единицы пачки прогона, как их видит владелец. */
  async function pendingsIn(owner: string, threadId: string) {
    return (await messagesIn(owner, threadId)).filter(
      (m) => (m.metadata as { pending?: unknown }).pending !== undefined,
    );
  }

  async function archivedOf(owner: string, id: string): Promise<boolean | undefined> {
    const rows = await withIdentity(db, owner, (tx) =>
      tx.select({ archived: entities.archived }).from(entities).where(eq(entities.id, id)),
    );
    return rows[0]?.archived;
  }

  test('рутина act: архивация записи → pending kind:action с предусловием archived in:[false] и снимком заголовка в карточке; модели вернулся pending_confirmation с pendingId; прогон-журнал §7.8 пуст (приёмка 2)', async () => {
    const owner = freshUserId();
    // Тред вызова НАРОЧНО чужой: единица ложится в тред РУТИНЫ (V1.6) — там, где владелец
    // читает её историю, — а не туда, куда пишет audit текущего вызова
    const host = await seedEntity(owner, { title: 'Посторонний тред', tags: [] });
    const hostThread = await withIdentity(db, owner, (tx) =>
      ensureEntityThread(tx, owner, host.id),
    );
    const { ctx, routineId, runId, threadId } = await deferCtx(owner, { threadId: hostThread });
    const target = await seedEntity(owner, {
      title: 'Прошлогодний отчёт',
      tags: [],
      aspects: { 'orbis/task': { status: 'done' } },
    });

    const r = await dispatchTool(ctx, 'entity_update', { id: target.id, archived: true });
    expect(r.status).toBe('pending_confirmation');
    if (r.status !== 'pending_confirmation') return;

    // Карточка своя, со снимком заголовка цели и строкой «было → станет»
    expect(r.card).toEqual({
      kind: 'deferred_action_card',
      pendingId: r.pendingId,
      runId,
      routineId,
      summary: 'Архивация: «Прошлогодний отчёт»',
      rows: [{ field: 'archived', before: 'false', after: 'true' }],
    });

    // Запись — единица пачки: явный kind, прогон, снятое предусловие по колонке
    const pendings = await pendingsIn(owner, threadId);
    expect(pendings).toHaveLength(1);
    const msg = pendings[0];
    expect(msg?.id).toBe(r.pendingId);
    const record = (msg?.metadata as { pending: Record<string, unknown> }).pending;
    expect(record.kind).toBe('action');
    expect(record.run_id).toBe(runId);
    expect(record.source).toBe('routine');
    expect(record.tool).toBe('entity_update');
    expect((record.input as Record<string, unknown>).precondition).toEqual([
      { property: 'orbis/archived', in: [false] },
    ]);
    expect(msg?.content).toBe('Отложено до решения: Архивация: «Прошлогодний отчёт»');

    // §7.8: отложка следа в журнале не оставляет — ни action'а, ни правки в графе
    expect((msg?.metadata as { actions?: unknown }).actions).toBeUndefined();
    expect(await archivedOf(owner, target.id)).toBe(false);
    // …и в треде вызова не осталось вообще ничего
    expect(await messagesIn(owner, hostThread)).toEqual([]);
  });

  test('ретрай того же вызова (в т.ч. с переставленными ключами JSON) → тот же pendingId, второй карточки нет (приёмка 15)', async () => {
    const owner = freshUserId();
    const { ctx, threadId } = await deferCtx(owner);
    const target = await seedEntity(owner, { title: 'Цель ретрая', tags: [] });

    const first = await dispatchTool(ctx, 'entity_update', { id: target.id, archived: true });
    // Тот же вызов с ПЕРЕСТАВЛЕННЫМИ ключами: личность единицы — от каноникализованного
    // payload'а, а не от текста JSON
    const again = await dispatchTool(ctx, 'entity_update', { archived: true, id: target.id });
    expect(first.status).toBe('pending_confirmation');
    expect(again.status).toBe('pending_confirmation');
    if (first.status !== 'pending_confirmation' || again.status !== 'pending_confirmation') return;

    expect(again.pendingId).toBe(first.pendingId);
    expect(await pendingsIn(owner, threadId)).toHaveLength(1);
    // Карточка ретрая — та же самая, что владелец уже видит в ленте
    expect(again.card).toEqual(first.card);
  });

  test('ретрай ПОСЛЕ правки цели владельцем → тот же pendingId и ПЕРВЫЙ снимок предусловий: личность единицы считается от ИСХОДНОГО payload модели, а предусловия не переснимаются (ОЧ.13, §9.4)', async () => {
    const owner = freshUserId();
    const { ctx, threadId } = await deferCtx(owner);
    const target = await seedEntity(owner, {
      title: 'Цель, которую тронули между попытками',
      tags: [],
      aspects: { 'orbis/task': { status: 'inbox' } },
    });
    const call = { id: target.id, archived: true, aspects: { 'orbis/task': { status: 'done' } } };

    const first = await dispatchTool(ctx, 'entity_update', call);
    expect(first.status).toBe('pending_confirmation');
    if (first.status !== 'pending_confirmation') return;

    // Владелец сдвинул статус — ВТОРОЕ снятие предусловий дало бы `in:['in_progress']`
    const own = await execute(db, {
      actorUserId: owner,
      actorKind: 'owner',
      source: 'ui',
      operations: [
        {
          tool: 'entity_update',
          input: { id: target.id, aspects: { 'orbis/task': { status: 'in_progress' } } },
        },
      ],
    });
    expect(own.ok).toBe(true);

    const again = await dispatchTool(ctx, 'entity_update', call);
    expect(again.status).toBe('pending_confirmation');
    if (again.status !== 'pending_confirmation') return;
    // Хеш считается от payload'а МОДЕЛИ: он побайтово тот же, значит это тот же ретрай
    expect(again.pendingId).toBe(first.pendingId);
    const pendings = await pendingsIn(owner, threadId);
    expect(pendings).toHaveLength(1);
    // Предусловия — снимок ПЕРВОЙ постановки, а не сегодняшнего состояния
    const record = (pendings[0]?.metadata as { pending: Record<string, unknown> }).pending;
    expect((record.input as Record<string, unknown>).precondition).toEqual([
      { property: 'orbis/task_status', in: ['inbox'] },
      { property: 'orbis/archived', in: [false] },
    ]);
    // Карточка ретрая — тоже исходная, со «было» первой попытки
    expect(again.card).toEqual(first.card);
    if (again.card.kind !== 'deferred_action_card') return;
    expect(again.card.rows).toEqual([
      { aspect: 'orbis/task', field: 'status', before: 'inbox', after: 'done' },
      { field: 'archived', before: 'false', after: 'true' },
    ]);
  });

  test('11-я открытая единица → VALIDATION «пачка полна» с reason run_units_cap; ретрай уже стоящей единицы кап НЕ отвергает (Р-15); прогон может продолжаться (приёмка 16)', async () => {
    const owner = freshUserId();
    const { ctx, threadId } = await deferCtx(owner);
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) {
      const e = await seedEntity(owner, { title: `Кандидат в архив ${i}`, tags: [] });
      ids.push(e.id);
      const r = await dispatchTool(ctx, 'entity_update', { id: e.id, archived: true });
      expect(r.status).toBe('pending_confirmation');
    }
    expect(await pendingsIn(owner, threadId)).toHaveLength(10);

    const eleventh = await seedEntity(owner, { title: 'Одиннадцатый', tags: [] });
    const over = await dispatchTool(ctx, 'entity_update', { id: eleventh.id, archived: true });
    expectError(over, 'VALIDATION');
    if (over.status === 'error') {
      expect(over.error.message).toContain('пачка полна');
      expect(over.error.details).toEqual({ reason: 'run_units_cap', limit: 10 });
    }
    // Отказ структурный: карточки нет, граф не тронут — прогон продолжается дальше
    expect(await pendingsIn(owner, threadId)).toHaveLength(10);
    expect(await archivedOf(owner, eleventh.id)).toBe(false);

    // Ретрай ДЕСЯТОЙ единицы при полной пачке — replay, а не отказ: наивный порядок
    // «кап → запись» отверг бы повтор того, что уже стоит
    const replay = await dispatchTool(ctx, 'entity_update', {
      id: ids[9] as string,
      archived: true,
    });
    expect(replay.status).toBe('pending_confirmation');
    expect(await pendingsIn(owner, threadId)).toHaveLength(10);
  });

  test('цель УЖЕ архивирована → структурный отказ CONFLICT при постановке, карточки нет (Minor ревью Задачи 5)', async () => {
    // Предусловие архивации ставится ЛИТЕРАЛОМ `in:[false]`, а не снимком. Если цель уже
    // в архиве, карточка родилась бы с «было: false» — ЛОЖЬЮ владельцу — и с заведомым
    // CONFLICT на «Принять», а модель считала бы единицу поставленной
    const owner = freshUserId();
    const { ctx, threadId } = await deferCtx(owner);
    const target = await seedEntity(owner, { title: 'Уже в архиве', tags: [] });
    const own = await execute(db, {
      actorUserId: owner,
      actorKind: 'owner',
      source: 'ui',
      operations: [{ tool: 'entity_update', input: { id: target.id, archived: true } }],
    });
    expect(own.ok).toBe(true);

    const r = await dispatchTool(ctx, 'entity_update', { id: target.id, archived: true });
    expectError(r, 'CONFLICT');
    if (r.status === 'error') {
      expect(r.error.details).toEqual({ reason: 'already_archived', id: target.id });
    }
    expect(await pendingsIn(owner, threadId)).toHaveLength(0);
  });

  test('отложка с несуществующим id цели → NOT_FOUND на диспатче, pending не создан', async () => {
    // Отказ обязан прийти МОДЕЛИ, здесь и сейчас, а не владельцу на кнопке «Принять»:
    // регресс, уносящий его на approve, без этого пина прошёл бы незаметно
    const owner = freshUserId();
    const { ctx, threadId } = await deferCtx(owner);
    const r = await dispatchTool(ctx, 'entity_update', { id: newId(), archived: true });
    expectError(r, 'NOT_FOUND');
    expect(await pendingsIn(owner, threadId)).toHaveLength(0);
  });

  test('«Принять» отложенную архивацию после изменения цели → stale с mismatches (предусловия сняты при постановке и не переснимаются — ОЧ.13, §9.4)', async () => {
    const owner = freshUserId();
    const { ctx } = await deferCtx(owner);
    const target = await seedEntity(owner, { title: 'Цель, которую тронул владелец', tags: [] });

    const r = await dispatchTool(ctx, 'entity_update', { id: target.id, archived: true });
    expect(r.status).toBe('pending_confirmation');
    if (r.status !== 'pending_confirmation') return;

    // Владелец архивировал сам — предусловие, снятое при постановке, больше не выполнено
    const own = await execute(db, {
      actorUserId: owner,
      actorKind: 'owner',
      source: 'ui',
      operations: [{ tool: 'entity_update', input: { id: target.id, archived: true } }],
    });
    expect(own.ok).toBe(true);

    const applied = await approvePending(db, { ownerId: owner, pendingId: r.pendingId });
    expect(applied.ok).toBe(false);
    if (applied.ok) return;
    expect(applied.error.code).toBe('CONFLICT');
    expect((applied.error.details as { mismatches?: unknown[] }).mismatches).toEqual([
      { property: 'orbis/archived', expected: [false], actual: true },
    ]);
  });

  test('чат/MCP: ветка createPending байт-в-байт прежняя (dedupeKey batch-only, карточка confirmation_card)', async () => {
    // Отложка — рычаг ТОЛЬКО фона: у чата и MCP за карточкой стоит владелец, который
    // смотрит на неё сейчас, и ни единицей пачки, ни дедупом по содержимому она не стала
    const owner = freshUserId();
    const host = await seedEntity(owner, { title: 'Хост-тред', tags: [] });
    const threadId = await withIdentity(db, owner, (tx) => ensureEntityThread(tx, owner, host.id));
    const target = await seedEntity(owner, { title: 'Цель чата', tags: [] });

    for (const source of ['chat', 'mcp'] as const) {
      const r = await dispatchTool(
        ctxFor({ actorUserId: owner, source, threadId }),
        'entity_update',
        { id: target.id, archived: true },
      );
      expect(r.status).toBe('pending_confirmation');
      if (r.status !== 'pending_confirmation') continue;
      expect(r.card).toEqual({
        kind: 'confirmation_card',
        mode: 'explicit',
        pendingId: r.pendingId,
        summary: 'entity_update',
      });
      const record = (
        (await messagesIn(owner, threadId)).find((m) => m.id === r.pendingId)?.metadata as {
          pending: Record<string, unknown>;
        }
      ).pending;
      // Ни kind, ни run_id, ни предусловий: запись чатового пути не изменилась ни на ключ
      expect(record.kind).toBeUndefined();
      expect(record.run_id).toBeUndefined();
      expect(record.input).toEqual({ id: target.id, archived: true });
    }
    // Дедуп ключуется batch_id: две одиночные архивации без него — две РАЗНЫЕ карточки
    const pendings = await pendingsIn(owner, threadId);
    expect(pendings).toHaveLength(2);
  });
});
