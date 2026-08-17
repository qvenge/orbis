// Интеграционные тесты глаголов исполнителя (§9.3, С6/С7): живая БД, executor без моков.
// Env: DATABASE_URL (orbis_app, RLS enforced) + DATABASE_URL_ADMIN (truncate/сид).
// Вызов идёт ровно тем же путём, что у настоящего агента, — через dispatchTool с
// грантом скоупа worker: гейты скоупа и agentOnly (Задача 7) остаются в контуре теста.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { ClaimTaskResult, MyQueueResult } from '@orbis/shared';
import { newId } from '@orbis/shared';
import { and, eq } from 'drizzle-orm';
import { appDb, freshUserId, requireEnv, truncateAll } from '../../test/helpers';
import { chatMessages, chatThreads, entities, relations } from '../db/schema';
import { withIdentity } from '../db/with-identity';
import { execute } from '../executor/executor';
import type { ActionRecord, WireEntity } from '../executor/types';
import { issuePatGrant, verifyBearer } from '../oauth/grants';
import { dispatchTool, type ToolCallCtx } from '../tools/dispatch';

requireEnv();

const { db, client } = appDb();
const T0 = new Date('2026-08-17T12:00:00.000Z');

function iso(d: Date): string {
  return d.toISOString();
}

/** Контекст вызова от имени фонового исполнителя (MCP + грант скоупа worker). */
function worker(owner: string, grantId: string, over: Partial<ToolCallCtx> = {}): ToolCallCtx {
  return {
    db,
    actorUserId: owner,
    actorKind: 'agent',
    source: 'mcp',
    explicitCommand: false,
    clock: () => T0,
    grant: { id: grantId, scope: 'worker', label: 'w' },
    ...over,
  };
}

/**
 * Грант выдаётся штатным путём: инвариант assertAssignment требует ЖИВОГО гранта
 * владельца, а вставка строки руками обходила бы ровно тот код, которым скоуп пишется.
 */
async function workerGrant(owner: string, label: string): Promise<string> {
  const token = await issuePatGrant(db, { ownerId: owner, label, scope: 'worker' });
  const identity = await verifyBearer(db, token);
  if (identity === null) throw new Error('выданный worker-PAT не прошёл verifyBearer');
  return identity.grantId;
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

async function link(owner: string, parentId: string, childId: string): Promise<void> {
  const r = await execute(db, {
    actorUserId: owner,
    actorKind: 'owner',
    source: 'ui',
    operations: [
      {
        tool: 'relation_create',
        input: { source_id: parentId, target_id: childId, relation_type: 'parent' },
      },
    ],
  });
  if (!r.ok) throw new Error(`link: ${r.error.code} ${r.error.message}`);
}

async function aspectsOf(owner: string, id: string): Promise<Record<string, AnyRecord>> {
  const rows = await withIdentity(db, owner, (tx) =>
    tx.select({ aspects: entities.aspects }).from(entities).where(eq(entities.id, id)),
  );
  const row = rows[0];
  if (!row) throw new Error(`сущность ${id} не найдена`);
  return row.aspects as Record<string, AnyRecord>;
}

type AnyRecord = Record<string, unknown>;

/** Дети сущности по связи parent (прогоны тикета). */
async function childrenOf(owner: string, parentId: string): Promise<string[]> {
  const rows = await withIdentity(db, owner, (tx) =>
    tx
      .select({ id: relations.targetId })
      .from(relations)
      .where(and(eq(relations.sourceId, parentId), eq(relations.relationType, 'parent'))),
  );
  return rows.map((r) => r.id);
}

/** Все action'ы журнала §7.8 владельца — по всем его тредам. */
async function actionsOf(owner: string): Promise<ActionRecord[]> {
  const rows = await withIdentity(db, owner, (tx) =>
    tx
      .select({ metadata: chatMessages.metadata })
      .from(chatMessages)
      .innerJoin(chatThreads, eq(chatThreads.id, chatMessages.threadId))
      .where(eq(chatThreads.ownerId, owner)),
  );
  return rows.flatMap((r) => (r.metadata as { actions?: ActionRecord[] }).actions ?? []);
}

function okResult<T>(r: Awaited<ReturnType<typeof dispatchTool>>): T {
  if (r.status !== 'ok') throw new Error(`ожидался ok, получено: ${JSON.stringify(r)}`);
  return r.result as T;
}

function errorCode(r: Awaited<ReturnType<typeof dispatchTool>>): string {
  if (r.status !== 'error') throw new Error(`ожидалась ошибка, получено: ${JSON.stringify(r)}`);
  return r.error.code;
}

beforeAll(async () => {
  await truncateAll();
});

afterAll(async () => {
  await client.end();
});

// ---------------------------------------------------------------------------
// orbis_my_queue
// ---------------------------------------------------------------------------

describe('orbis_my_queue: очередь исполнителя (§9.3, С7)', () => {
  const owner = freshUserId();
  let grantId = '';
  let otherGrantId = '';
  let projectId = '';
  let ticketId = '';

  beforeAll(async () => {
    grantId = await workerGrant(owner, 'очередь');
    otherGrantId = await workerGrant(owner, 'второй исполнитель');
    projectId = (
      await seedEntity(owner, {
        title: 'Проект «Орбис»',
        tags: [],
        aspects: { 'orbis/project': { stage: 'active' } },
      })
    ).id;
    ticketId = (
      await seedEntity(owner, {
        title: 'Починить парсер',
        tags: [],
        aspects: {
          'orbis/task': { status: 'planned', priority: 'high', due_date: '2026-08-20' },
          'orbis/assignment': { executor: 'agent', grant_id: grantId },
        },
      })
    ).id;
    await link(owner, projectId, ticketId);
    await seedEntity(owner, {
      title: 'Тикет другого исполнителя',
      tags: [],
      aspects: {
        'orbis/task': { status: 'planned' },
        'orbis/assignment': { executor: 'agent', grant_id: otherGrantId },
      },
    });
    await seedEntity(owner, {
      title: 'Тикет без назначения',
      tags: [],
      aspects: { 'orbis/task': { status: 'planned' } },
    });
  });

  test('назначенные гранту тикеты; чужие/неназначенные не видны; claimable только inbox|planned', async () => {
    const r = await dispatchTool(worker(owner, grantId), 'orbis_my_queue', {});
    expect(r.status).toBe('ok');
    const q = okResult<MyQueueResult>(r);
    expect(q.tickets.map((t) => t.id)).toEqual([ticketId]);
    expect(q.tickets[0]?.claimable).toBe(true);
    expect(q.tickets[0]?.status).toBe('planned');
    expect(q.tickets[0]?.priority).toBe('high');
    expect(q.tickets[0]?.due_date).toBe('2026-08-20');
    expect(q.tickets[0]?.project?.id).toBe(projectId);
    expect(q.tickets[0]?.project?.title).toBe('Проект «Орбис»');
    expect(q.tickets[0]?.last_run).toBeUndefined();
    expect(q.swept).toBe(0);
  });

  test('тикет в waiting/done — в очереди виден, но не claimable (работу берут только из inbox|planned)', async () => {
    const waiting = (
      await seedEntity(owner, {
        title: 'Ждёт ответа владельца',
        tags: [],
        aspects: {
          'orbis/task': { status: 'waiting', waiting_for: 'вопрос с чекпойнта' },
          'orbis/assignment': { executor: 'agent', grant_id: grantId },
        },
      })
    ).id;
    const done = (
      await seedEntity(owner, {
        title: 'Уже закрыт',
        tags: [],
        aspects: {
          'orbis/task': { status: 'done' },
          'orbis/assignment': { executor: 'agent', grant_id: grantId },
        },
      })
    ).id;
    const q = okResult<MyQueueResult>(
      await dispatchTool(worker(owner, grantId), 'orbis_my_queue', {}),
    );
    const byId = new Map(q.tickets.map((t) => [t.id, t]));
    expect(byId.get(waiting)?.claimable).toBe(false);
    expect(byId.get(done)?.claimable).toBe(false);
    expect(byId.get(ticketId)?.claimable).toBe(true);
  });

  test('лишнее поле в envelope → VALIDATION (strict, §7.10: валидация ДО классификации)', async () => {
    expect(errorCode(await dispatchTool(worker(owner, grantId), 'orbis_my_queue', { x: 1 }))).toBe(
      'VALIDATION',
    );
  });
});

// ---------------------------------------------------------------------------
// orbis_claim_task
// ---------------------------------------------------------------------------

describe('orbis_claim_task: атомарный захват (С7, инвариант 1)', () => {
  const owner = freshUserId();
  let grantId = '';
  let otherGrantId = '';
  let projectId = '';

  /** Свежий тикет проекта, назначенный основному гранту. */
  async function makeTicket(title = 'Тикет для захвата', status = 'planned'): Promise<string> {
    const id = (
      await seedEntity(owner, {
        title,
        tags: [],
        aspects: {
          'orbis/task': { status },
          'orbis/assignment': { executor: 'agent', grant_id: grantId },
        },
      })
    ).id;
    await link(owner, projectId, id);
    return id;
  }

  beforeAll(async () => {
    grantId = await workerGrant(owner, 'захват');
    otherGrantId = await workerGrant(owner, 'чужой грант');
    projectId = (
      await seedEntity(owner, {
        title: 'Проект захвата',
        tags: [],
        aspects: { 'orbis/project': { stage: 'active' } },
      })
    ).id;
  });

  test('тикет → in_progress, прогон создан ребёнком, ответ несёт body проекта (процесс) и пустую историю', async () => {
    const ticketId = await makeTicket('Первый захват');
    const r = await dispatchTool(worker(owner, grantId), 'orbis_claim_task', {
      ticket_id: ticketId,
    });
    expect(r.status).toBe('ok');
    const c = okResult<ClaimTaskResult>(r);

    expect(c.process).toContain('## Процесс');
    expect(c.project?.id).toBe(projectId);
    expect(c.ticket.id).toBe(ticketId);
    expect(c.ticket.title).toBe('Первый захват');
    expect(c.history).toEqual([]);
    expect(c.replayed).toBe(false);

    const ticketAspects = await aspectsOf(owner, ticketId);
    expect((ticketAspects['orbis/task'] as { status?: string }).status).toBe('in_progress');

    const runAspects = await aspectsOf(owner, c.run_id);
    expect(runAspects['orbis/agent-run']).toMatchObject({
      grant_id: grantId,
      outcome: 'running',
      step_count: 0,
      project_id: projectId,
      started_at: iso(T0),
      last_step_at: iso(T0),
      steps: [],
    });

    expect(await childrenOf(owner, ticketId)).toEqual([c.run_id]);

    // Журнал §7.8: ровно один action типа batch, с run_id и actor_grant_id
    const action = (await actionsOf(owner)).find((a) => a.id === c.action_id);
    expect(action?.type).toBe('batch');
    expect(action?.run_id).toBe(c.run_id);
    expect(action?.actor_grant_id).toBe(grantId);
    expect(action?.actor_kind).toBe('agent');
    expect(action?.source).toBe('mcp');
  });

  test('инвариант 1: два одновременных захвата одного тикета — ровно один получает работу, второй CONFLICT', async () => {
    for (let round = 0; round < 5; round++) {
      const ticketId = await makeTicket(`Гонка ${round}`);
      const [a, b] = await Promise.all([
        dispatchTool(worker(owner, grantId), 'orbis_claim_task', { ticket_id: ticketId }),
        dispatchTool(worker(owner, grantId), 'orbis_claim_task', { ticket_id: ticketId }),
      ]);
      const oks = [a, b].filter((x) => x.status === 'ok');
      expect(oks).toHaveLength(1);
      const lost = [a, b].find((x) => x.status === 'error');
      expect(lost === undefined ? null : errorCode(lost)).toBe('CONFLICT');
      // Ровно один прогон-ребёнок: проигравший batch откатился целиком
      expect(await childrenOf(owner, ticketId)).toHaveLength(1);
    }
  }, 60_000);

  test('захват тикета, назначенного ДРУГОМУ гранту / не назначенного / в waiting|done → CONFLICT, ничего не создано', async () => {
    const foreign = (
      await seedEntity(owner, {
        title: 'Назначен другому гранту',
        tags: [],
        aspects: {
          'orbis/task': { status: 'planned' },
          'orbis/assignment': { executor: 'agent', grant_id: otherGrantId },
        },
      })
    ).id;
    const unassigned = (
      await seedEntity(owner, {
        title: 'Без назначения',
        tags: [],
        aspects: { 'orbis/task': { status: 'planned' } },
      })
    ).id;
    const human = (
      await seedEntity(owner, {
        title: 'Назначен человеку',
        tags: [],
        aspects: {
          'orbis/task': { status: 'planned' },
          'orbis/assignment': { executor: 'human', assignee: 'владелец' },
        },
      })
    ).id;
    const waiting = await makeTicket('Ждёт владельца', 'waiting');
    const done = await makeTicket('Закрыт', 'done');

    for (const id of [foreign, unassigned, human, waiting, done]) {
      const r = await dispatchTool(worker(owner, grantId), 'orbis_claim_task', { ticket_id: id });
      expect({ id, code: errorCode(r) }).toEqual({ id, code: 'CONFLICT' });
      // Ничего не создано: транзакция batch откатилась целиком
      expect(await childrenOf(owner, id)).toHaveLength(0);
    }
    // Статусы не сдвинулись
    expect((await aspectsOf(owner, waiting))['orbis/task']).toMatchObject({ status: 'waiting' });
    expect((await aspectsOf(owner, done))['orbis/task']).toMatchObject({ status: 'done' });
  });

  test('чужой тикет (RLS) → NOT_FOUND', async () => {
    const stranger = freshUserId();
    const alien = (
      await seedEntity(stranger, {
        title: 'Тикет постороннего',
        tags: [],
        aspects: { 'orbis/task': { status: 'planned' } },
      })
    ).id;
    expect(
      errorCode(
        await dispatchTool(worker(owner, grantId), 'orbis_claim_task', { ticket_id: alien }),
      ),
    ).toBe('NOT_FOUND');
  });

  test('повтор orbis_claim_task с тем же id — replay: тот же run_id, второй прогон не создан', async () => {
    const ticketId = await makeTicket('Идемпотентный захват');
    const callId = newId();
    const first = await dispatchTool(worker(owner, grantId), 'orbis_claim_task', {
      ticket_id: ticketId,
      id: callId,
    });
    const second = await dispatchTool(worker(owner, grantId), 'orbis_claim_task', {
      ticket_id: ticketId,
      id: callId,
    });
    const c1 = okResult<ClaimTaskResult>(first);
    const c2 = okResult<ClaimTaskResult>(second);
    expect(c1.replayed).toBe(false);
    expect(c2.replayed).toBe(true);
    expect(c2.run_id).toBe(c1.run_id);
    expect(await childrenOf(owner, ticketId)).toEqual([c1.run_id]);
    expect(c2.history).toEqual([]); // сам прогон в свою же историю не попадает
  });

  test('тот же id вызова на ДРУГОМ тикете — CONFLICT, чужой прогон агенту не отдаётся', async () => {
    // Ключ идемпотентности адресует ВЫЗОВ (batch_id action'а §7.8), а не тикет: повтор с
    // тем же id вернул бы сохранённый ответ первого захвата — то есть прогон по чужому
    // тикету, в который агент начал бы писать шаги.
    const callId = newId();
    const first = await makeTicket('Первый тикет одного id');
    const second = await makeTicket('Второй тикет того же id');
    const c1 = okResult<ClaimTaskResult>(
      await dispatchTool(worker(owner, grantId), 'orbis_claim_task', {
        ticket_id: first,
        id: callId,
      }),
    );
    const r = await dispatchTool(worker(owner, grantId), 'orbis_claim_task', {
      ticket_id: second,
      id: callId,
    });
    expect(errorCode(r)).toBe('CONFLICT');
    // Второй тикет не тронут: replay ничего не применял, а мы ничего не отдали
    expect(await childrenOf(owner, second)).toHaveLength(0);
    expect((await aspectsOf(owner, second))['orbis/task']).toMatchObject({ status: 'planned' });
    expect(await childrenOf(owner, first)).toEqual([c1.run_id]);
  });

  test('orbis_claim_task тикета с историей: history содержит прошлый прогон с reply', async () => {
    const ticketId = await makeTicket('Тикет с историей');
    const askedAt = new Date(T0.getTime() - 3 * 3_600_000);
    const past = await seedEntity(owner, {
      title: 'Прогон: Тикет с историей',
      tags: [],
      aspects: {
        'orbis/agent-run': {
          grant_id: grantId,
          project_id: projectId,
          outcome: 'checkpoint',
          started_at: iso(new Date(T0.getTime() - 4 * 3_600_000)),
          finished_at: iso(askedAt),
          last_step_at: iso(askedAt),
          step_count: 1,
          steps: [{ seq: 1, at: iso(askedAt), summary: 'Прочитал требования', external: false }],
          checkpoint: { question: 'Какую библиотеку взять?', asked_at: iso(askedAt) },
          reply: { text: 'Бери zod.', at: iso(new Date(T0.getTime() - 2 * 3_600_000)) },
        },
      },
    });
    await link(owner, ticketId, past.id);

    const c = okResult<ClaimTaskResult>(
      await dispatchTool(worker(owner, grantId), 'orbis_claim_task', { ticket_id: ticketId }),
    );
    expect(c.history.map((h) => h.id)).toEqual([past.id]);
    expect(c.history[0]?.outcome).toBe('checkpoint');
    expect(c.history[0]?.reply?.text).toBe('Бери zod.');
    expect(c.history[0]?.checkpoint?.question).toBe('Какую библиотеку взять?');
    expect(c.history[0]?.step_count).toBe(1);
    expect(c.history[0]?.last_steps).toHaveLength(1);
    expect(c.run_id).not.toBe(past.id);
  });
});
