// Подметание брошенных прогонов (С6, инвариант 6): живая БД, executor без моков.
// Env: DATABASE_URL (orbis_app, RLS enforced) + DATABASE_URL_ADMIN (truncate/сид).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { MyQueueResult } from '@orbis/shared';
import { appDb, freshUserId, requireEnv, truncateAll } from '../../test/helpers';
import { withIdentity } from '../db/with-identity';
import { execute } from '../executor/executor';
import { listRunUnits } from '../policy/pending';
import { type AnyRecord, agentLoopHelpers, iso, T0 } from '../test/agent-loop-helpers';
import { dispatchTool } from '../tools/dispatch';
import { RUN_STALE_AFTER_MS } from './constants';
import { sweepStaleRuns } from './sweep';

requireEnv();

const { db, client } = appDb();
const MINUTE = 60_000;
const {
  actionsOf,
  link,
  propsOf,
  routineCtx,
  seedEntity,
  seedRoutine,
  seedRoutineRun,
  worker,
  workerGrant,
} = agentLoopHelpers(db);

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
  await link(owner, ticket.id, run.id, 'run');
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
    const cleanTask = (await propsOf(owner, clean.ticketId)) as AnyRecord;
    expect(cleanTask['orbis/task_status']).toBe('planned');
    expect(cleanTask['orbis/waiting_for']).toBeUndefined();

    // Эффект был — человек разбирает остатки: waiting + описание в waiting_for
    const dirtyTask = (await propsOf(owner, dirty.ticketId)) as AnyRecord;
    expect(dirtyTask['orbis/task_status']).toBe('waiting');
    expect(String(dirtyTask['orbis/waiting_for'])).toContain('оборван');
    expect(String(dirtyTask['orbis/waiting_for'])).toContain('Создал ветку fix/parser');

    for (const runId of [clean.runId, dirty.runId]) {
      const run = (await propsOf(owner, runId)) as AnyRecord;
      expect(run['orbis/run_outcome']).toBe('abandoned');
      expect(run['orbis/run_finished_at']).toBe(iso(T0));
      expect(String(run['orbis/abandon_note'])).toContain('оборван');
      expect(String(run['orbis/abandon_note'])).toContain('31');
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

    const freshRun = (await propsOf(owner, fresh.runId)) as AnyRecord;
    expect(freshRun['orbis/run_outcome']).toBe('running');
    expect(freshRun['orbis/abandon_note']).toBeUndefined();
    expect(await propsOf(owner, fresh.ticketId)).toMatchObject({
      'orbis/task_status': 'in_progress',
    });

    const detachedRun = (await propsOf(owner, detached.runId)) as AnyRecord;
    expect(detachedRun['orbis/run_outcome']).toBe('abandoned');
    // Тикет уже не в работе — статус ему сервер не переписывает
    expect(await propsOf(owner, detached.ticketId)).toMatchObject({
      'orbis/task_status': 'planned',
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

// ---------------------------------------------------------------------------
// Два running-прогона одного тикета (ручной сброс статуса владельцем)
// ---------------------------------------------------------------------------

describe('sweepStaleRuns: тикет чинится только по ПОСЛЕДНЕМУ прогону', () => {
  /** Владелец правит тикет руками — своим путём, не глаголом исполнителя. */
  async function patchTask(
    owner: string,
    ticketId: string,
    patch: Record<string, unknown>,
  ): Promise<void> {
    const r = await execute(db, {
      actorUserId: owner,
      actorKind: 'owner',
      source: 'ui',
      operations: [
        { tool: 'entity_update', input: { id: ticketId, aspects: { 'orbis/task': patch } } },
      ],
    });
    if (!r.ok) throw new Error(`patchTask: ${r.error.code} ${r.error.message}`);
  }

  test('старый прогон подметается, тикет активного прогона остаётся in_progress, orbis_finish живого проходит', async () => {
    const owner = freshUserId();
    const grantId = await workerGrant(owner, 'два прогона одного тикета');
    const ticket = await seedEntity(owner, {
      title: 'Тикет, сброшенный владельцем руками',
      tags: [],
      aspects: {
        'orbis/task': { status: 'planned' },
        'orbis/assignment': { executor: 'agent', grant_id: grantId },
      },
    });

    // Прогон A взят 31 минуту назад — к T0 он устарел
    const staleAt = new Date(T0.getTime() - 31 * MINUTE);
    const claimA = await dispatchTool(
      worker(owner, grantId, { clock: () => staleAt }),
      'orbis_claim_task',
      { ticket_id: ticket.id },
    );
    if (claimA.status !== 'ok') throw new Error(`захват A: ${JSON.stringify(claimA)}`);
    const runA = (claimA.result as { run_id: string }).run_id;

    // Владелец руками вернул тикет в работу заново (намерение «начни сначала»): прогон A
    // остаётся running — это и есть состояние с ДВУМЯ running-прогонами одного тикета.
    await patchTask(owner, ticket.id, { status: 'planned' });
    const claimB = await dispatchTool(worker(owner, grantId), 'orbis_claim_task', {
      ticket_id: ticket.id,
    });
    if (claimB.status !== 'ok') throw new Error(`захват B: ${JSON.stringify(claimB)}`);
    const runB = (claimB.result as { run_id: string }).run_id;
    expect(runB).not.toBe(runA);

    const { swept } = await sweepStaleRuns(db, {
      ownerId: owner,
      actorKind: 'owner',
      clock: () => T0,
      staleAfterMs: RUN_STALE_AFTER_MS,
    });
    expect(swept).toBe(1);

    // Прогон A помечен, прогон B живёт, а тикет остался при СВОЁМ прогоне: подметание
    // старого хвоста не имеет права выбить из работы того, кто работает сейчас.
    expect(await propsOf(owner, runA)).toMatchObject({
      'orbis/run_outcome': 'abandoned',
    });
    expect(await propsOf(owner, runB)).toMatchObject({
      'orbis/run_outcome': 'running',
    });
    expect(await propsOf(owner, ticket.id)).toMatchObject({
      'orbis/task_status': 'in_progress',
    });

    // …и живой прогон закрывается штатно, а не зависает до собственного подметания
    const finished = await dispatchTool(worker(owner, grantId), 'orbis_finish', {
      run_id: runB,
      report: 'Готово: работа второго прогона доведена до конца.',
    });
    expect(finished.status).toBe('ok');
  });

  test('архивированный running-прогон подметается (инвариант 6 держится и после отката захвата)', async () => {
    const owner = freshUserId();
    const grantId = await workerGrant(owner, 'архивный прогон');
    const { ticketId, runId } = await seedRun(owner, {
      grantId,
      ticketStatus: 'in_progress',
      lastStepMinutesAgo: 31,
      stepSummary: 'Начал и был архивирован',
      external: false,
    });
    const archived = await execute(db, {
      actorUserId: owner,
      actorKind: 'owner',
      source: 'ui',
      operations: [{ tool: 'entity_update', input: { id: runId, archived: true } }],
    });
    if (!archived.ok) throw new Error(`архивация прогона: ${archived.error.message}`);

    const { swept } = await sweepStaleRuns(db, {
      ownerId: owner,
      actorKind: 'owner',
      clock: () => T0,
      staleAfterMs: RUN_STALE_AFTER_MS,
    });
    expect(swept).toBe(1);
    expect(await propsOf(owner, runId)).toMatchObject({
      'orbis/run_outcome': 'abandoned',
    });
    // Тикет не остался висеть в работе с прогоном, которого на экранах уже нет
    expect(await propsOf(owner, ticketId)).toMatchObject({ 'orbis/task_status': 'planned' });
  });

  test('очередь гранта A метёт брошенный прогон гранта B: подметание — про владельца, не про грант', async () => {
    const owner = freshUserId();
    const grantA = await workerGrant(owner, 'грант A');
    const grantB = await workerGrant(owner, 'грант B');
    const foreign = await seedRun(owner, {
      grantId: grantB,
      ticketStatus: 'in_progress',
      lastStepMinutesAgo: 31,
      stepSummary: 'Прогон гранта B',
      external: false,
    });

    const r = await dispatchTool(worker(owner, grantA), 'orbis_my_queue', {});
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect((r.result as MyQueueResult).swept).toBe(1);
    // Тикет гранта B в очередь гранта A не попал — метут прогоны, а видят только своё
    expect((r.result as MyQueueResult).tickets.map((t) => t.id)).not.toContain(foreign.ticketId);
    expect(await propsOf(owner, foreign.runId)).toMatchObject({
      'orbis/run_outcome': 'abandoned',
    });
  });
});

// ---------------------------------------------------------------------------
// Рутинные прогоны (V1.12): та же метла, другой исход — failed, а не abandoned
// ---------------------------------------------------------------------------

describe('sweepStaleRuns: рутинный прогон закрывается как failed (V1.12)', () => {
  test('прогон рутины без шагов дольше порога → failed + fail_note, тикета нет; грантовый прогон рядом — abandoned как был', async () => {
    const owner = freshUserId();
    const grantId = await workerGrant(owner, 'подметание рутин');
    const routineId = await seedRoutine(owner, { title: 'Рутина, чей процесс умер' });
    const { runId } = await seedRoutineRun(owner, {
      routineId,
      startedAt: new Date(T0.getTime() - 41 * MINUTE),
      lastStepAt: new Date(T0.getTime() - 31 * MINUTE),
    });
    const ticketRun = await seedRun(owner, {
      grantId,
      ticketStatus: 'in_progress',
      lastStepMinutesAgo: 31,
      stepSummary: 'Прочитал тикет',
      external: false,
    });

    const { swept } = await sweepStaleRuns(db, {
      ownerId: owner,
      actorKind: 'ai',
      clock: () => T0,
    });
    expect(swept).toBe(2);

    // Рутинный прогон: процесс остановлен — это ПРОВАЛ попытки бакета (её перезапустит
    // ретрай раннера), а не «брошенная работа», которую владелец пойдёт разбирать
    const run = (await propsOf(owner, runId)) as AnyRecord;
    expect(run['orbis/run_outcome']).toBe('failed');
    expect(String(run['orbis/fail_note'])).toContain('прогон прерван');
    expect(String(run['orbis/fail_note'])).toContain('31 мин');
    expect(run['orbis/abandon_note']).toBeUndefined();
    expect(run['orbis/run_finished_at']).toBe(iso(T0));
    // Пачки у этого прогона нет — патч прежний: флажок ставит только проба, нашедшая
    // открытую единицу, а не сам факт подметания рутинного прогона
    expect(run['orbis/undecided']).toBeUndefined();
    // Сама рутина подметанием не трогается: тикетной логики у неё нет вовсе
    expect(await propsOf(owner, routineId)).toMatchObject({
      'orbis/routine_stage': 'active',
      'orbis/routine_mode': 'propose',
    });

    // Грантовый прогон того же владельца — прежний исход и прежняя починка тикета
    const ticketRunProps = await propsOf(owner, ticketRun.runId);
    expect(ticketRunProps['orbis/run_outcome']).toBe('abandoned');
    expect(String(ticketRunProps['orbis/abandon_note'])).toContain('оборван');
    expect(ticketRunProps['orbis/fail_note']).toBeUndefined();
    expect(await propsOf(owner, ticketRun.ticketId)).toMatchObject({
      'orbis/task_status': 'planned',
    });
  });
});

describe('sweepStaleRuns: пачка переживает смерть процесса (D42 ОЧ.6, С1 ревью)', () => {
  test('рутинный прогон с открытой единицей → failed С undecided:true; карточки единиц живы (приёмка 13)', async () => {
    // «Рестарт и сон — основной вид сбоя» (V1.12): для рутины подметание не экзотика, а
    // штатный конец прогона на засыпающем инстансе. Пропущенный здесь флажок означает
    // пачку, которую владелец никогда не увидит: карточки в треде лежат, а сигнала нет.
    const owner = freshUserId();
    const routineId = await seedRoutine(owner, { title: 'Рутина, умершая с пачкой' });
    const { runId } = await seedRoutineRun(owner, {
      routineId,
      startedAt: new Date(T0.getTime() - 41 * MINUTE),
      lastStepAt: new Date(T0.getTime() - 31 * MINUTE),
    });
    // Единица заводится настоящим путём — вопрос из живого прогона; отметку живости
    // `orbis_ask` не двигает, поэтому прогон остаётся брошенным
    const asked = await dispatchTool(
      routineCtx(owner, 'act', [], {
        routine: { id: routineId, runId, mode: 'act', allowedTools: new Set() },
      }),
      'orbis_ask',
      { run_id: runId, question: 'Отменять ли завтрашний созвон — он третий подряд?' },
    );
    expect(asked.status).toBe('ok');

    const { swept } = await sweepStaleRuns(db, {
      ownerId: owner,
      actorKind: 'ai',
      clock: () => T0,
    });
    expect(swept).toBe(1);

    const run = (await propsOf(owner, runId)) as AnyRecord;
    expect(run['orbis/run_outcome']).toBe('failed');
    expect(String(run['orbis/fail_note'])).toContain('прогон прерван');
    expect(run['orbis/undecided']).toBe(true);

    // Единицы подметание НЕ трогает: они переживают прогон и ждут решения владельца либо
    // гашения следующим прогоном (ОЧ.8). «Подмели» значит «закрыли прогон», а не «сняли
    // вопрос»: снятый вместе с процессом вопрос владелец никогда бы и не увидел
    const units = await withIdentity(db, owner, (tx) => listRunUnits(tx, owner, runId));
    expect(units).toHaveLength(1);
    expect(units[0]?.kind).toBe('question');
    expect(units[0]?.fate).toBe('open');

    // Писатель флажка — система (§9.6): будь он `ui`, «отмени последнее» после «Принять»
    // снимало бы флажок вместо действия владельца
    const action = (await actionsOf(owner)).find((a) => a.run_id === runId);
    expect(action?.source).toBe('system');
  });
});
