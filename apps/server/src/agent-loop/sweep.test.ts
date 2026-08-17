// Подметание брошенных прогонов (С6, инвариант 6): живая БД, executor без моков.
// Env: DATABASE_URL (orbis_app, RLS enforced) + DATABASE_URL_ADMIN (truncate/сид).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { MyQueueResult } from '@orbis/shared';
import { appDb, freshUserId, requireEnv, truncateAll } from '../../test/helpers';
import { type AnyRecord, agentLoopHelpers, iso, T0 } from '../test/agent-loop-helpers';
import { dispatchTool } from '../tools/dispatch';
import { RUN_STALE_AFTER_MS } from './constants';
import { sweepStaleRuns } from './sweep';

requireEnv();

const { db, client } = appDb();
const MINUTE = 60_000;
const { seedEntity, link, aspectsOf, actionsOf, workerGrant, worker } = agentLoopHelpers(db);

function minutesBefore(n: number): string {
  return iso(new Date(T0.getTime() - n * MINUTE));
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
