// Подметание брошенных прогонов (С6, инвариант 6): живая БД, executor без моков.
// Env: DATABASE_URL (orbis_app, RLS enforced) + DATABASE_URL_ADMIN (truncate/сид).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { MyQueueResult } from '@orbis/shared';
import { eq } from 'drizzle-orm';
import { appDb, freshUserId, requireEnv, truncateAll } from '../../test/helpers';
import { chatMessages, chatThreads, entities } from '../db/schema';
import { withIdentity } from '../db/with-identity';
import { execute } from '../executor/executor';
import type { ActionRecord, WireEntity } from '../executor/types';
import { issuePatGrant, verifyBearer } from '../oauth/grants';
import { dispatchTool, type ToolCallCtx } from '../tools/dispatch';
import { RUN_STALE_AFTER_MS } from './constants';
import { sweepStaleRuns } from './sweep';

requireEnv();

const { db, client } = appDb();
const T0 = new Date('2026-08-17T12:00:00.000Z');
const MINUTE = 60_000;

function iso(d: Date): string {
  return d.toISOString();
}

function minutesBefore(n: number): string {
  return iso(new Date(T0.getTime() - n * MINUTE));
}

type AnyRecord = Record<string, unknown>;

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

/** Тикет в in_progress с прогоном-ребёнком; lastStepMinutesAgo задаёт «живость» прогона. */
async function seedRun(
  owner: string,
  args: {
    grantId: string;
    ticketStatus: string;
    ticketWaitingFor?: string;
    lastStepMinutesAgo: number;
    stepSummary: string;
    external: boolean;
  },
): Promise<{ ticketId: string; runId: string }> {
  const ticket = await seedEntity(owner, {
    title: `Тикет прогона (${args.stepSummary})`,
    tags: [],
    aspects: {
      'orbis/task': {
        status: args.ticketStatus,
        ...(args.ticketWaitingFor !== undefined && { waiting_for: args.ticketWaitingFor }),
      },
      'orbis/assignment': { executor: 'agent', grant_id: args.grantId },
    },
  });
  const at = minutesBefore(args.lastStepMinutesAgo);
  const run = await seedEntity(owner, {
    title: `Прогон: ${ticket.title}`,
    tags: [],
    aspects: {
      'orbis/agent-run': {
        grant_id: args.grantId,
        outcome: 'running',
        started_at: minutesBefore(args.lastStepMinutesAgo + 10),
        last_step_at: at,
        step_count: 1,
        steps: [{ seq: 1, at, summary: args.stepSummary, external: args.external }],
      },
    },
  });
  await link(owner, ticket.id, run.id);
  return { ticketId: ticket.id, runId: run.id };
}

async function workerGrant(owner: string, label: string): Promise<string> {
  const token = await issuePatGrant(db, { ownerId: owner, label, scope: 'worker' });
  const identity = await verifyBearer(db, token);
  if (identity === null) throw new Error('выданный worker-PAT не прошёл verifyBearer');
  return identity.grantId;
}

function worker(owner: string, grantId: string): ToolCallCtx {
  return {
    db,
    actorUserId: owner,
    actorKind: 'agent',
    source: 'mcp',
    explicitCommand: false,
    clock: () => T0,
    grant: { id: grantId, scope: 'worker', label: 'w' },
  };
}

beforeAll(async () => {
  await truncateAll();
});

afterAll(async () => {
  await client.end();
});

describe('sweepStaleRuns (С6, инвариант 6)', () => {
  test('прогон без шагов дольше порога: без external → тикет planned, прогон abandoned; с external → тикет waiting с waiting_for о разборе', async () => {
    const owner = freshUserId();
    const grantId = await workerGrant(owner, 'подметание');
    const clean = await seedRun(owner, {
      grantId,
      ticketStatus: 'in_progress',
      ticketWaitingFor: 'старый хвост',
      lastStepMinutesAgo: 31,
      stepSummary: 'Прочитал тикет',
      external: false,
    });
    const dirty = await seedRun(owner, {
      grantId,
      ticketStatus: 'in_progress',
      lastStepMinutesAgo: 31,
      stepSummary: 'Создал ветку fix/parser',
      external: true,
    });

    const { swept } = await sweepStaleRuns(db, {
      ownerId: owner,
      actorKind: 'owner',
      clock: () => T0,
      staleAfterMs: RUN_STALE_AFTER_MS,
    });
    expect(swept).toBe(2);

    // Без эффекта — безопасно перезапустить: planned, хвост waiting_for снят
    const cleanTask = (await aspectsOf(owner, clean.ticketId))['orbis/task'] as AnyRecord;
    expect(cleanTask.status).toBe('planned');
    expect(cleanTask.waiting_for).toBeUndefined();

    // Эффект был — человек разбирает остатки: waiting + описание в waiting_for
    const dirtyTask = (await aspectsOf(owner, dirty.ticketId))['orbis/task'] as AnyRecord;
    expect(dirtyTask.status).toBe('waiting');
    expect(String(dirtyTask.waiting_for)).toContain('оборван');
    expect(String(dirtyTask.waiting_for)).toContain('Создал ветку fix/parser');

    for (const runId of [clean.runId, dirty.runId]) {
      const run = (await aspectsOf(owner, runId))['orbis/agent-run'] as AnyRecord;
      expect(run.outcome).toBe('abandoned');
      expect(run.finished_at).toBe(iso(T0));
      expect(String(run.abandon_note)).toContain('оборван');
      expect(String(run.abandon_note)).toContain('31');
    }

    // Журнал §7.8: обслуживание инварианта, а не решение актора — source system,
    // прогон адресован в run_id (по нему Задача 13 откатывает)
    const actions = await actionsOf(owner);
    const sweepActions = actions.filter((a) => a.source === 'system');
    expect(sweepActions).toHaveLength(2);
    expect(new Set(sweepActions.map((a) => a.run_id))).toEqual(new Set([clean.runId, dirty.runId]));
    expect(sweepActions.every((a) => a.type === 'batch')).toBe(true);
  });

  test('свежий прогон (last_step_at = T0-5мин) не трогается; тикет не в in_progress → помечается только прогон', async () => {
    const owner = freshUserId();
    const grantId = await workerGrant(owner, 'свежесть');
    const fresh = await seedRun(owner, {
      grantId,
      ticketStatus: 'in_progress',
      lastStepMinutesAgo: 5,
      stepSummary: 'Гоняю тесты',
      external: false,
    });
    // Владелец руками вернул тикет в planned, а прогон остался висеть running
    const detached = await seedRun(owner, {
      grantId,
      ticketStatus: 'planned',
      lastStepMinutesAgo: 31,
      stepSummary: 'Что-то делал',
      external: false,
    });

    const { swept } = await sweepStaleRuns(db, {
      ownerId: owner,
      actorKind: 'owner',
      clock: () => T0,
      staleAfterMs: RUN_STALE_AFTER_MS,
    });
    expect(swept).toBe(1);

    const freshRun = (await aspectsOf(owner, fresh.runId))['orbis/agent-run'] as AnyRecord;
    expect(freshRun.outcome).toBe('running');
    expect(freshRun.abandon_note).toBeUndefined();
    expect((await aspectsOf(owner, fresh.ticketId))['orbis/task']).toMatchObject({
      status: 'in_progress',
    });

    const detachedRun = (await aspectsOf(owner, detached.runId))['orbis/agent-run'] as AnyRecord;
    expect(detachedRun.outcome).toBe('abandoned');
    // Тикет уже не в работе — статус ему сервер не переписывает
    expect((await aspectsOf(owner, detached.ticketId))['orbis/task']).toMatchObject({
      status: 'planned',
    });

    // Повторное подметание ничего не находит: подобранный прогон терминален
    const again = await sweepStaleRuns(db, {
      ownerId: owner,
      actorKind: 'owner',
      clock: () => T0,
      staleAfterMs: RUN_STALE_AFTER_MS,
    });
    expect(again.swept).toBe(0);
  });

  test('orbis_my_queue подметает по дороге: swept в ответе, тикет вернулся claimable', async () => {
    const owner = freshUserId();
    const grantId = await workerGrant(owner, 'очередь подметает');
    const stale = await seedRun(owner, {
      grantId,
      ticketStatus: 'in_progress',
      lastStepMinutesAgo: 31,
      stepSummary: 'Начал и пропал',
      external: false,
    });

    const r = await dispatchTool(worker(owner, grantId), 'orbis_my_queue', {});
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    const q = r.result as MyQueueResult;
    expect(q.swept).toBe(1);
    const ticket = q.tickets.find((t) => t.id === stale.ticketId);
    expect(ticket?.status).toBe('planned');
    expect(ticket?.claimable).toBe(true);
    // Сводка брошенного прогона едет вместе с тикетом — агенту видно, что было
    expect(ticket?.last_run?.id).toBe(stale.runId);
    expect(ticket?.last_run?.outcome).toBe('abandoned');
    expect(String(ticket?.last_run?.abandon_note)).toContain('оборван');
  });
});
