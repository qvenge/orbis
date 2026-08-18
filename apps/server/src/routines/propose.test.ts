// apps/server/src/routines/propose.test.ts
// Терминальный глагол рутины `orbis_propose` (V1.6, V1.7) против живой БД: форма
// предложения, автоснятые предусловия, запрет по объекту, судьба pending и прогона.
//
// Через `dispatchTool`, а не прямым вызовом `runPropose`: гейт режима (V1.10), реестр и
// разбор envelope — часть контракта глагола, и проверять его в обход них значило бы
// закрыть тестом путь, которым модель не ходит.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { entityThreadId, newId, type ProposeResult } from '@orbis/shared';
import { eq } from 'drizzle-orm';
import { appDb, freshUserId, requireEnv, truncateAll } from '../../test/helpers';
import { rollbackRun } from '../agent-loop/rollback';
import { chatMessages } from '../db/schema';
import { withIdentity } from '../db/with-identity';
import { execute } from '../executor/executor';
import { approvePending } from '../policy/pending';
import { agentLoopHelpers, T0 } from '../test/agent-loop-helpers';
import { dispatchTool, type ToolCallCtx } from '../tools/dispatch';
import { AGENT_VERB_NAMES, buildToolRegistry, WORKER_SCOPE_TOOLS } from '../tools/registry';

requireEnv();

const { db, client } = appDb();
const owner = freshUserId();
const {
  actionsOf,
  aspectsOf,
  routineCtx,
  seedEntity,
  seedRoutine,
  seedRoutineRun,
  worker,
  workerGrant,
} = agentLoopHelpers(db);

beforeAll(async () => {
  await truncateAll();
});

afterAll(async () => {
  await client.end();
});

interface LiveRoutine {
  routineId: string;
  runId: string;
  ctx: ToolCallCtx;
}

/** Рутина + её живой прогон + контекст вызова, указывающий ровно на них. */
async function liveRoutine(): Promise<LiveRoutine> {
  const routineId = await seedRoutine(owner);
  const { runId } = await seedRoutineRun(owner, { routineId });
  const ctx = routineCtx(owner, 'propose', [], {
    routine: { id: routineId, runId, mode: 'propose', allowedTools: new Set() },
  });
  return { routineId, runId, ctx };
}

/** Задача-цель предложения: статус есть, срока нет — обе формы предусловия сразу. */
async function seedTask(title: string): Promise<string> {
  const e = await seedEntity(owner, {
    title,
    tags: [],
    aspects: { 'orbis/task': { status: 'inbox' } },
  });
  return e.id;
}

async function messageById(id: string) {
  const rows = await withIdentity(db, owner, (tx) =>
    tx.select().from(chatMessages).where(eq(chatMessages.id, id)),
  );
  return rows[0];
}

/** Сколько pending-карточек лежит в треде рутины. */
async function pendingsInRoutineThread(routineId: string): Promise<number> {
  const rows = await withIdentity(db, owner, (tx) =>
    tx
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.threadId, entityThreadId(owner, routineId))),
  );
  return rows.filter((r) => (r.metadata as { pending?: unknown }).pending !== undefined).length;
}

function expectError(r: Awaited<ReturnType<typeof dispatchTool>>, code: string): void {
  expect(r.status).toBe('error');
  if (r.status === 'error') expect(r.error.code).toBe(code);
}

function errorOf(r: Awaited<ReturnType<typeof dispatchTool>>) {
  if (r.status !== 'error') throw new Error(`ожидался отказ, получено «${r.status}»`);
  return r.error;
}

const EXPLANATION = 'Задача висит в инбоксе третий день — предлагаю взять её сегодня.';

// ---------------------------------------------------------------------------

describe('orbis_propose: предложение и предусловия (V1.6, V1.7)', () => {
  test('две правки (status + отсутствующий due_date) → pending в треде рутины с proposal_card, прогон finished с proposal pending; payload несёт in:[inbox] и absent:true', async () => {
    const { routineId, runId, ctx } = await liveRoutine();
    const taskId = await seedTask('Разобрать инбокс');

    const r = await dispatchTool(ctx, 'orbis_propose', {
      run_id: runId,
      explanation: EXPLANATION,
      operations: [
        {
          tool: 'entity_update',
          input: {
            id: taskId,
            aspects: { 'orbis/task': { status: 'planned', due_date: '2026-08-20' } },
          },
        },
      ],
    });
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    const result = r.result as ProposeResult;
    expect(result.run_id).toBe(runId);
    expect(result.operations).toBe(1);
    expect(result.replayed).toBe(false);

    // Pending лежит в треде РУТИНЫ (V1.6), а не в глобальном: предложение — событие рутины
    const msg = await messageById(result.pending_id);
    expect(msg).toBeDefined();
    expect(msg?.threadId).toBe(entityThreadId(owner, routineId));

    const metadata = msg?.metadata as {
      pending: {
        tool: string;
        source: string;
        actor_kind: string;
        run_id?: string;
        input: unknown;
      };
      cards: unknown[];
    };
    expect(metadata.pending.tool).toBe('batch_execute');
    expect(metadata.pending.source).toBe('routine');
    expect(metadata.pending.actor_kind).toBe('ai');
    expect(metadata.pending.run_id).toBe(runId);

    // Автоснятые предусловия (V1.7): текущее значение — в `in`, отсутствующее поле — `absent`
    const payload = metadata.pending.input as {
      operations: Array<{ tool: string; input: Record<string, unknown> }>;
    };
    expect(payload.operations).toHaveLength(1);
    expect(payload.operations[0]?.tool).toBe('entity_update');
    expect(payload.operations[0]?.input.precondition).toEqual([
      { aspect: 'orbis/task', field: 'status', in: ['inbox'] },
      { aspect: 'orbis/task', field: 'due_date', absent: true },
    ]);

    // Карточка предложения (V1.6) — своя, не confirmation_card
    expect(metadata.cards).toEqual([
      {
        kind: 'proposal_card',
        pendingId: result.pending_id,
        runId,
        routineId,
        summary: '1 правка',
        explanation: EXPLANATION,
      },
    ]);

    // Прогон закрыт ТЕМ ЖЕ вызовом: исход и судьба предложения — одним патчем
    const run = (await aspectsOf(owner, runId))['orbis/agent-run'];
    expect(run?.outcome).toBe('finished');
    expect(run?.report).toBe(EXPLANATION);
    expect(run?.proposal).toEqual({ pending_id: result.pending_id, status: 'pending' });

    // До решения владельца граф не тронут
    expect((await aspectsOf(owner, taskId))['orbis/task']).toEqual({ status: 'inbox' });
  });

  test('approvePending применяет всё одним батчем с run_id и source routine; rollbackRun возвращает исходное (инвариант 9)', async () => {
    const { runId, ctx } = await liveRoutine();
    const taskId = await seedTask('Задача под одобрение');
    const otherId = await seedTask('Вторая задача предложения');

    const r = await dispatchTool(ctx, 'orbis_propose', {
      run_id: runId,
      explanation: EXPLANATION,
      operations: [
        {
          tool: 'entity_update',
          input: { id: taskId, aspects: { 'orbis/task': { status: 'planned' } } },
        },
        {
          tool: 'entity_update',
          input: { id: otherId, aspects: { 'orbis/task': { status: 'done' } } },
        },
      ],
    });
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    const { pending_id: pendingId } = r.result as ProposeResult;

    const applied = await approvePending(db, { ownerId: owner, pendingId, clock: () => T0 });
    expect(applied.ok).toBe(true);
    expect((await aspectsOf(owner, taskId))['orbis/task']?.status).toBe('planned');
    expect((await aspectsOf(owner, otherId))['orbis/task']?.status).toBe('done');

    // ОДИН action на всё предложение (batch), атрибуция — прогон рутины (V1.6)
    const actions = (await actionsOf(owner)).filter((a) => a.source === 'routine');
    expect(actions).toHaveLength(1);
    expect(actions[0]?.type).toBe('batch');
    expect(actions[0]?.run_id).toBe(runId);
    expect(actions[0]?.actor_kind).toBe('ai');

    // Инвариант 9: у принятого предложения тот же откат, что у любого прогона
    const rolled = await rollbackRun(db, { actorUserId: owner, runId });
    expect(rolled.ok).toBe(true);
    expect((await aspectsOf(owner, taskId))['orbis/task']).toEqual({ status: 'inbox' });
    expect((await aspectsOf(owner, otherId))['orbis/task']).toEqual({ status: 'inbox' });
  });

  test('ручная правка до approve → CONFLICT precondition_failed с mismatches, ничего не применено (инвариант 8) — и для поля, которого не было', async () => {
    // Сценарий 1: владелец сам сдвинул статус
    const first = await liveRoutine();
    const taskId = await seedTask('Задача, которую тронут руками');
    const untouchedId = await seedTask('Соседняя задача того же предложения');
    const r1 = await dispatchTool(first.ctx, 'orbis_propose', {
      run_id: first.runId,
      explanation: EXPLANATION,
      operations: [
        {
          tool: 'entity_update',
          input: { id: taskId, aspects: { 'orbis/task': { status: 'planned' } } },
        },
        {
          tool: 'entity_update',
          input: { id: untouchedId, aspects: { 'orbis/task': { status: 'done' } } },
        },
      ],
    });
    expect(r1.status).toBe('ok');
    if (r1.status !== 'ok') return;
    const pending1 = (r1.result as ProposeResult).pending_id;

    await execute(db, {
      actorUserId: owner,
      actorKind: 'owner',
      source: 'ui',
      operations: [
        {
          tool: 'entity_update',
          input: { id: taskId, aspects: { 'orbis/task': { status: 'in_progress' } } },
        },
      ],
    });

    const denied = await approvePending(db, { ownerId: owner, pendingId: pending1 });
    expect(denied.ok).toBe(false);
    if (denied.ok) return;
    expect(denied.error.code).toBe('CONFLICT');
    const details = denied.error.details as { reason: string; mismatches: unknown[] };
    expect(details.reason).toBe('precondition_failed');
    expect(details.mismatches).toEqual([
      { aspect: 'orbis/task', field: 'status', expected: ['inbox'], actual: 'in_progress' },
    ]);
    // «Всё или ничего»: соседняя операция того же предложения тоже не применилась
    expect((await aspectsOf(owner, untouchedId))['orbis/task']?.status).toBe('inbox');

    // Сценарий 2: владелец заполнил поле, которого при снятии предусловия НЕ БЫЛО
    const second = await liveRoutine();
    const dueId = await seedTask('Задача, которой поставят срок');
    const r2 = await dispatchTool(second.ctx, 'orbis_propose', {
      run_id: second.runId,
      explanation: EXPLANATION,
      operations: [
        {
          tool: 'entity_update',
          input: { id: dueId, aspects: { 'orbis/task': { due_date: '2026-08-20' } } },
        },
      ],
    });
    expect(r2.status).toBe('ok');
    if (r2.status !== 'ok') return;
    const pending2 = (r2.result as ProposeResult).pending_id;

    await execute(db, {
      actorUserId: owner,
      actorKind: 'owner',
      source: 'ui',
      operations: [
        {
          tool: 'entity_update',
          input: { id: dueId, aspects: { 'orbis/task': { due_date: '2026-09-01' } } },
        },
      ],
    });

    const denied2 = await approvePending(db, { ownerId: owner, pendingId: pending2 });
    expect(denied2.ok).toBe(false);
    if (denied2.ok) return;
    expect(denied2.error.code).toBe('CONFLICT');
    const details2 = denied2.error.details as { reason: string; mismatches: unknown[] };
    expect(details2.reason).toBe('precondition_failed');
    expect(details2.mismatches).toEqual([
      { aspect: 'orbis/task', field: 'due_date', expected: 'absent', actual: '2026-09-01' },
    ]);
    expect((await aspectsOf(owner, dueId))['orbis/task']?.due_date).toBe('2026-09-01');
  });
});

describe('orbis_propose: форма и запрет по объекту (V1.6, инвариант 6)', () => {
  test('attach_* / batch_execute / thread_post / >50 операций / precondition во входе / detach аспекта → VALIDATION', async () => {
    const { routineId, runId, ctx } = await liveRoutine();
    const taskId = await seedTask('Цель форменных отказов');
    const base = { run_id: runId, explanation: EXPLANATION };

    for (const tool of ['attach_orbis_task', 'batch_execute', 'thread_post', 'entity_get']) {
      expectError(
        await dispatchTool(ctx, 'orbis_propose', {
          ...base,
          operations: [{ tool, input: { entity_id: taskId, data: { status: 'done' } } }],
        }),
        'VALIDATION',
      );
    }

    // Потолок 50 (V1.6) — 51-я операция отклоняется схемой входа
    expectError(
      await dispatchTool(ctx, 'orbis_propose', {
        ...base,
        operations: Array.from({ length: 51 }, () => ({
          tool: 'entity_update',
          input: { id: taskId, aspects: { 'orbis/task': { status: 'planned' } } },
        })),
      }),
      'VALIDATION',
    );

    // Непротекание: предусловия снимает СЕРВЕР, модель их не подставляет
    expectError(
      await dispatchTool(ctx, 'orbis_propose', {
        ...base,
        operations: [
          {
            tool: 'entity_update',
            input: {
              id: taskId,
              aspects: { 'orbis/task': { status: 'planned' } },
              precondition: [{ aspect: 'orbis/task', field: 'status', in: ['done'] }],
            },
          },
        ],
      }),
      'VALIDATION',
    );

    // Снятие аспекта целиком предложением не выражается (V1.7)
    expectError(
      await dispatchTool(ctx, 'orbis_propose', {
        ...base,
        operations: [
          { tool: 'entity_update', input: { id: taskId, aspects: { 'orbis/task': null } } },
        ],
      }),
      'VALIDATION',
    );

    // Ни один отказ формы не завёл pending и не закрыл прогон
    expect(await pendingsInRoutineThread(routineId)).toBe(0);
    expect((await aspectsOf(owner, runId))['orbis/agent-run']?.outcome).toBe('running');
  });

  test('операция над рутиной или с orbis/assignment (статически и по id из БД) → VALIDATION proposal_forbidden_target (приёмка 8)', async () => {
    const { routineId, runId, ctx } = await liveRoutine();
    const taskId = await seedTask('Цель запрета по объекту');
    const base = { run_id: runId, explanation: EXPLANATION };

    const forbidden: Array<{ tool: string; input: Record<string, unknown> }> = [
      // Статически: аспект рутины в патче
      {
        tool: 'entity_create',
        input: {
          title: 'Своя новая рутина',
          tags: [],
          aspects: { 'orbis/routine': { stage: 'active', at: '08:00', mode: 'act' } },
        },
      },
      {
        tool: 'entity_update',
        input: { id: taskId, aspects: { 'orbis/routine': { mode: 'act' } } },
      },
      // Статически: назначение исполнителю
      {
        tool: 'entity_update',
        input: { id: taskId, aspects: { 'orbis/assignment': { executor: 'agent' } } },
      },
      // По БД: объект — сама рутина, её аспекта в патче нет
      { tool: 'entity_update', input: { id: routineId, title: 'Переименовать рутину' } },
      // По БД: связь одним концом упирается в рутину
      {
        tool: 'relation_create',
        input: { source_id: routineId, target_id: taskId, relation_type: 'parent' },
      },
      {
        tool: 'relation_delete',
        input: { source_id: taskId, target_id: routineId, relation_type: 'related_to' },
      },
    ];

    for (const op of forbidden) {
      const r = await dispatchTool(ctx, 'orbis_propose', { ...base, operations: [op] });
      expectError(r, 'VALIDATION');
      expect((errorOf(r).details as { reason?: string }).reason).toBe('proposal_forbidden_target');
    }

    expect(await pendingsInRoutineThread(routineId)).toBe(0);
    expect((await aspectsOf(owner, runId))['orbis/agent-run']?.outcome).toBe('running');
  });

  test('от chat и mcp → VALIDATION (routineOnly); в реестре чата и MCP orbis_propose нет; в WORKER_SCOPE_TOOLS нет', async () => {
    const { runId } = await liveRoutine();
    const taskId = await seedTask('Цель чужой поверхности');
    const payload = {
      run_id: runId,
      explanation: EXPLANATION,
      operations: [
        {
          tool: 'entity_update',
          input: { id: taskId, aspects: { 'orbis/task': { status: 'planned' } } },
        },
      ],
    };

    const chat: ToolCallCtx = {
      db,
      actorUserId: owner,
      actorKind: 'ai',
      source: 'chat',
      explicitCommand: false,
      clock: () => T0,
    };
    expectError(await dispatchTool(chat, 'orbis_propose', payload), 'VALIDATION');

    const grantId = await workerGrant(owner, 'propose-mcp');
    expectError(await dispatchTool(worker(owner, grantId), 'orbis_propose', payload), 'VALIDATION');

    const defs = await withIdentity(db, owner, (tx) => buildToolRegistry(tx));
    expect(defs.find((d) => d.name === 'orbis_propose')?.routineOnly).toBe(true);
    // Фильтры публикации: чат (send-message.ts) и MCP (mcp/server.ts) режут routineOnly
    expect(defs.filter((d) => d.routineOnly !== true).map((d) => d.name)).not.toContain(
      'orbis_propose',
    );
    // Не глагол внешнего исполнителя: ни в его именах, ни в скоупе worker
    expect((AGENT_VERB_NAMES as readonly string[]).includes('orbis_propose')).toBe(false);
    expect(WORKER_SCOPE_TOOLS.has('orbis_propose')).toBe(false);
  });

  test('повтор с тем же id → replayed, второго pending нет', async () => {
    const { routineId, runId, ctx } = await liveRoutine();
    const taskId = await seedTask('Цель повтора');
    const payload = {
      run_id: runId,
      explanation: EXPLANATION,
      id: newId(),
      operations: [
        {
          tool: 'entity_update',
          input: { id: taskId, aspects: { 'orbis/task': { status: 'planned' } } },
        },
      ],
    };

    const first = await dispatchTool(ctx, 'orbis_propose', payload);
    expect(first.status).toBe('ok');
    if (first.status !== 'ok') return;
    const firstResult = first.result as ProposeResult;
    expect(firstResult.replayed).toBe(false);

    const second = await dispatchTool(ctx, 'orbis_propose', payload);
    expect(second.status).toBe('ok');
    if (second.status !== 'ok') return;
    const secondResult = second.result as ProposeResult;
    expect(secondResult.replayed).toBe(true);
    expect(secondResult.pending_id).toBe(firstResult.pending_id);

    expect(await pendingsInRoutineThread(routineId)).toBe(1);
    const run = (await aspectsOf(owner, runId))['orbis/agent-run'];
    expect(run?.outcome).toBe('finished');
    expect(run?.proposal).toEqual({ pending_id: firstResult.pending_id, status: 'pending' });
  });
});
