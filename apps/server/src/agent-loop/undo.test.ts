// apps/server/src/agent-loop/undo.test.ts
// «Отмени последнее» поверх круга исполнителя (приёмка 14): владелец гасит шаг агента
// тем же Undo §7.8, что и собственные действия. Отдельный файл, а не хвост verbs.test.ts:
// здесь сходятся ДВЕ поверхности — MCP-глагол (dispatchTool с грантом) и владельческая
// (tRPC-caller ai.undoLast), и обвязка у сьюта своя (caller поверх appRouter).
//
// Почему это вообще работает и почему это надо закрепить: глагол — не обход executor'а,
// он собирает batch обычных операций (verbs.ts), поэтому inverse, журнал и Undo
// достаются даром. Ровно это свойство тест и стережёт: стоит глаголу однажды начать
// писать в БД мимо конвейера — шаг перестанет отменяться, и упадёт здесь.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { GraphId } from '@orbis/shared';
import { globalThreadId, newId, type RunStepResult } from '@orbis/shared';
import { appDb, mintGraph, personal, requireEnv, truncateAll } from '../../test/helpers';
import { threadJournal } from '../../test/journal-helpers';
import { appRouter } from '../router';
import { type AnyRecord, agentLoopHelpers, iso, T0 } from '../test/agent-loop-helpers';
import { dispatchTool } from '../tools/dispatch';
import { createCallerFactory } from '../trpc';

requireEnv();

const { db, client } = appDb();
const { link, propsOf, seedEntity, worker, workerGrant } = agentLoopHelpers(db);
const createCaller = createCallerFactory(appRouter);

/** Шаги идут позже захвата — порядок «последнего действия» в журнале однозначен. */
const T1 = new Date(T0.getTime() + 60_000);
const T2 = new Date(T0.getTime() + 120_000);

function okResult<T>(r: Awaited<ReturnType<typeof dispatchTool>>): T {
  if (r.status !== 'ok') throw new Error(`ожидался ok, получено: ${JSON.stringify(r)}`);
  return r.result as T;
}

/** Журнал ГЛОБАЛЬНОГО треда владельца: туда ложатся записи глаголов (треда у них нет). */
async function globalJournal(owner: GraphId) {
  return threadJournal(owner, globalThreadId(owner));
}

beforeAll(async () => {
  await truncateAll();
});

afterAll(async () => {
  await client.end();
});

describe('«отмени последнее» гасит шаг агента (приёмка 14, §7.8)', () => {
  const owner = mintGraph();
  const ownerCaller = createCaller({
    identity: personal(owner),
    actorKind: 'owner',
    db,
    clientVersion: null,
  });
  let grantId = '';
  let runId = '';
  let firstStepId = '';
  let secondStepId = '';

  beforeAll(async () => {
    grantId = await workerGrant(owner, 'исполнитель Undo');
    const project = await seedEntity(owner, {
      title: 'Проект с отменяемым шагом',
      tags: [],
      props: { 'orbis/project_stage': 'active' },
      aspects: ['orbis/project'],
    });
    const ticket = await seedEntity(owner, {
      title: 'Тикет с отменяемым шагом',
      tags: [],
      props: {
        'orbis/task_status': 'planned',
        'orbis/executor': 'agent',
        'orbis/grant': grantId,
      },
      aspects: ['orbis/task', 'orbis/assignment'],
    });
    await link(owner, project.id, ticket.id, 'ticket');

    const claimed = okResult<{ run_id: string }>(
      await dispatchTool(worker(owner, grantId), 'orbis_claim_task', { ticket_id: ticket.id }),
    );
    runId = claimed.run_id;

    firstStepId = newId();
    okResult<RunStepResult>(
      await dispatchTool(worker(owner, grantId, { clock: () => T1 }), 'orbis_run_step', {
        run_id: runId,
        summary: 'Прочитал задание',
        id: firstStepId,
      }),
    );
    secondStepId = newId();
    okResult<RunStepResult>(
      await dispatchTool(worker(owner, grantId, { clock: () => T2 }), 'orbis_run_step', {
        run_id: runId,
        summary: 'Создал ветку fix/parser',
        external: true,
        id: secondStepId,
      }),
    );
  });

  test('audit-запись шага в глобальном треде адресована агенту, его гранту и прогону (§7.8, С2)', async () => {
    // Отмена возможна ровно потому, что шаг — обычная запись журнала; и она же
    // показывает владельцу, ЧЕЙ доступ шагнул: без actor_grant_id гасить было бы вслепую
    const journal = await globalJournal(owner);
    const step = journal.find((a) => a.type !== 'undo' && a.id === secondStepId);
    expect(step).toBeDefined();
    expect(step?.actorKind).toBe('agent');
    expect(step?.actorGrantId).toBe(grantId);
    expect(step?.runId).toBe(runId);
    expect(step?.source).toBe('mcp');
    expect(step?.inverse.length).toBeGreaterThan(0); // без inverse отменять нечего
  });

  test('ai.undoLast() владельца откатывает ПОСЛЕДНИЙ шаг: step_count назад, steps без него', async () => {
    const before = (await propsOf(owner, runId)) as AnyRecord;
    expect(before['orbis/step_count']).toBe(2);
    expect((before['orbis/run_steps'] as AnyRecord[]).map((s) => s.seq)).toEqual([1, 2]);

    // Владелец зовёт тот же «отмени последнее», что и для своих действий — глагол агента
    // никакой особой кнопки не требует
    const undone = await ownerCaller.ai.undoLast();
    expect(undone.ok).toBe(true);
    expect(undone.actionId).toBe(secondStepId);

    const after = (await propsOf(owner, runId)) as AnyRecord;
    expect(after['orbis/step_count']).toBe(1);
    expect(after['orbis/run_steps']).toEqual([
      {
        seq: 1,
        at: iso(T1),
        summary: 'Прочитал задание',
        external: false,
        action_id: firstStepId,
      },
    ]);
    // Прогон отменой не закрывается: владелец убрал шаг, а не работу
    expect(after['orbis/run_outcome']).toBe('running');
  });

  test('журнал append-only: отмена не правит запись шага, а дописывает запись отмены (§4.6)', async () => {
    const journal = await globalJournal(owner);
    const stepRecord = journal.find((e) => e.type !== 'undo' && e.id === secondStepId);
    expect(stepRecord).toBeDefined(); // запись шага на месте, а не стёрта
    const undoRecord = journal.find((e) => e.undoes === secondStepId);
    expect(undoRecord).toBeDefined();
    expect(undoRecord?.type).toBe('undo');
  });

  test('следующий orbis_run_step продолжает прогон с восстановленного счётчика (seq 2 снова свободен)', async () => {
    // Проверка того, что откат вернул прогон в СОГЛАСОВАННОЕ состояние, а не просто
    // уменьшил число: CAS-предусловие шага стоит на step_count, и рассинхрон счётчика
    // с массивом остановил бы исполнителя намертво
    const next = okResult<RunStepResult>(
      await dispatchTool(worker(owner, grantId, { clock: () => T2 }), 'orbis_run_step', {
        run_id: runId,
        summary: 'Переделал шаг после отмены',
      }),
    );
    expect(next.step_count).toBe(2);
    const run = (await propsOf(owner, runId)) as AnyRecord;
    expect((run['orbis/run_steps'] as AnyRecord[]).map((s) => s.summary)).toEqual([
      'Прочитал задание',
      'Переделал шаг после отмены',
    ]);
  });
});
