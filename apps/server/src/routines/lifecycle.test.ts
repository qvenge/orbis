// apps/server/src/routines/lifecycle.test.ts
// Жизненный цикл рутины вокруг прогона (V1.8, V1.12) против живой БД: гашение
// незакрытого от прошлых прогонов, стоп-кран после трёх сбоев, системная запись в
// тред рутины и хвост истории.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { entityThreadId } from '@orbis/shared';
import { eq } from 'drizzle-orm';
import { appDb, freshUserId, requireEnv, truncateAll } from '../../test/helpers';
import { chatMessages } from '../db/schema';
import { withIdentity } from '../db/with-identity';
import { ScriptedProvider } from '../llm/scripted';
import { agentLoopHelpers, T0 } from '../test/agent-loop-helpers';
import { dispatchTool } from '../tools/dispatch';
import { CONSECUTIVE_FAILURES_TO_PAUSE, ROUTINE_HISTORY_TAIL } from './constants';
import {
  appendSystemNote,
  pauseIfFailing,
  type RoutineDeps,
  routineHistory,
  supersedeOpen,
} from './lifecycle';

requireEnv();

const { db, client } = appDb();
const owner = freshUserId();
const { aspectsOf, routineCtx, seedEntity, seedRoutine, seedRoutineRun } = agentLoopHelpers(db);

beforeAll(async () => {
  await truncateAll();
});

afterAll(async () => {
  await client.end();
});

/** Зависимости без модели: провайдер этим функциям не нужен, но тип требует его. */
function deps(over: Partial<RoutineDeps> = {}): RoutineDeps {
  return { db, provider: new ScriptedProvider([]), model: 'scripted', clock: () => T0, ...over };
}

function minutes(n: number): Date {
  return new Date(T0.getTime() + n * 60_000);
}

async function threadRows(routineId: string) {
  return withIdentity(db, owner, (tx) =>
    tx
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.threadId, entityThreadId(owner, routineId)))
      .orderBy(chatMessages.createdAt, chatMessages.id),
  );
}

/** Живое предложение прошлого прогона: настоящий путь глагола, а не подложенный аспект. */
async function seedProposal(routineId: string, bucket: string): Promise<string> {
  const { runId } = await seedRoutineRun(owner, { routineId, bucket });
  const task = await seedEntity(owner, {
    title: `Задача для ${bucket}`,
    tags: [],
    aspects: { 'orbis/task': { status: 'inbox' } },
  });
  const ctx = routineCtx(owner, 'propose', [], {
    routine: { id: routineId, runId, mode: 'propose', allowedTools: new Set() },
  });
  const r = await dispatchTool(ctx, 'orbis_propose', {
    run_id: runId,
    explanation: 'Задача висит в инбоксе — предлагаю взять её сегодня.',
    operations: [
      {
        tool: 'entity_update',
        input: { id: task.id, aspects: { 'orbis/task': { status: 'planned' } } },
      },
    ],
  });
  if (r.status !== 'ok') throw new Error(`seedProposal: ${JSON.stringify(r)}`);
  return runId;
}

describe('supersedeOpen: новый прогон гасит незакрытое (V1.8)', () => {
  test('pending-предложение прошлого прогона → отклонено как «заменено», статус на прогоне superseded', async () => {
    const routineId = await seedRoutine(owner);
    const oldRunId = await seedProposal(routineId, '2026-08-16T07:00');
    const { runId: newRunId } = await seedRoutineRun(owner, {
      routineId,
      bucket: '2026-08-17T07:00',
      startedAt: minutes(10),
    });

    const out = await supersedeOpen(deps(), { ownerId: owner, routineId, exceptRunId: newRunId });
    expect(out).toEqual({ superseded: 1, staled: 0 });

    const run = (await aspectsOf(owner, oldRunId))['orbis/agent-run'] as {
      proposal?: { pending_id: string; status: string };
    };
    expect(run.proposal?.status).toBe('superseded');

    // Причина отказа отличима от кнопки владельца (V1.8): в треде рутины лежит
    // reject-строка именно с reason 'superseded'
    const rows = await threadRows(routineId);
    const reject = rows.find(
      (r) => (r.metadata as { type?: string }).type === 'confirmation_rejected',
    );
    expect(reject).toBeDefined();
    expect((reject?.metadata as { reason?: string }).reason).toBe('superseded');
  });

  test('неотвеченный чекпойнт → outcome stale + запись в тред; текущий прогон не тронут', async () => {
    const routineId = await seedRoutine(owner);
    const { runId: askedId } = await seedRoutineRun(owner, {
      routineId,
      bucket: '2026-08-16T07:00',
      run: {
        outcome: 'checkpoint',
        checkpoint: { question: 'Переносить ли встречу?', asked_at: T0.toISOString() },
        finished_at: T0.toISOString(),
      },
    });
    const { runId: currentId } = await seedRoutineRun(owner, {
      routineId,
      bucket: '2026-08-17T07:00',
      startedAt: minutes(10),
    });

    const out = await supersedeOpen(deps(), { ownerId: owner, routineId, exceptRunId: currentId });
    expect(out).toEqual({ superseded: 0, staled: 1 });

    expect((await aspectsOf(owner, askedId))['orbis/agent-run']?.outcome).toBe('stale');
    // текущий прогон — не «прошлый»: его гасить нельзя ни при каких условиях
    expect((await aspectsOf(owner, currentId))['orbis/agent-run']?.outcome).toBe('running');

    const rows = await threadRows(routineId);
    const note = rows.find((r) => (r.metadata as { type?: string }).type === 'routine_stale');
    expect(note).toBeDefined();
    expect(note?.role).toBe('system');
    expect((note?.metadata as { routine_id?: string }).routine_id).toBe(routineId);
  });

  test('гасить нечего → нули, повтор идемпотентен (второй раз тоже нули)', async () => {
    const routineId = await seedRoutine(owner);
    const { runId } = await seedRoutineRun(owner, { routineId });
    const first = await supersedeOpen(deps(), { ownerId: owner, routineId, exceptRunId: runId });
    expect(first).toEqual({ superseded: 0, staled: 0 });

    const asked = await seedRoutineRun(owner, {
      routineId,
      bucket: '2026-08-18T07:00',
      startedAt: minutes(20),
      run: {
        outcome: 'checkpoint',
        checkpoint: { question: 'Вопрос?', asked_at: T0.toISOString() },
        finished_at: T0.toISOString(),
      },
    });
    const { runId: laterId } = await seedRoutineRun(owner, {
      routineId,
      bucket: '2026-08-19T07:00',
      startedAt: minutes(30),
    });
    expect(
      await supersedeOpen(deps(), { ownerId: owner, routineId, exceptRunId: laterId }),
    ).toEqual({ superseded: 0, staled: 1 });
    // второй проход: гасить уже нечего — stale не гасится повторно
    expect(
      await supersedeOpen(deps(), { ownerId: owner, routineId, exceptRunId: laterId }),
    ).toEqual({ superseded: 0, staled: 0 });
    expect((await aspectsOf(owner, asked.runId))['orbis/agent-run']?.outcome).toBe('stale');
  });
});

describe('pauseIfFailing: стоп-кран после трёх (V1.12)', () => {
  async function seedFailed(routineId: string, bucket: string, offsetMin: number): Promise<void> {
    await seedRoutineRun(owner, {
      routineId,
      bucket,
      startedAt: minutes(offsetMin),
      run: { outcome: 'failed', fail_note: 'AI-провайдер недоступен' },
    });
  }

  test('три плановых failed подряд → stage paused + системная запись в тред рутины', async () => {
    const routineId = await seedRoutine(owner);
    expect(CONSECUTIVE_FAILURES_TO_PAUSE).toBe(3);
    await seedFailed(routineId, '2026-08-15T07:00', 1);
    await seedFailed(routineId, '2026-08-16T07:00', 2);
    expect(await pauseIfFailing(deps(), { ownerId: owner, routineId })).toEqual({ paused: false });
    expect((await aspectsOf(owner, routineId))['orbis/routine']?.stage).toBe('active');

    await seedFailed(routineId, '2026-08-17T07:00', 3);
    expect(await pauseIfFailing(deps(), { ownerId: owner, routineId })).toEqual({ paused: true });
    expect((await aspectsOf(owner, routineId))['orbis/routine']?.stage).toBe('paused');

    const notes = (await threadRows(routineId)).filter(
      (r) => (r.metadata as { type?: string }).type === 'routine_paused',
    );
    expect(notes).toHaveLength(1);
    expect(notes[0]?.role).toBe('system');

    // Повтор ничего не делает: рутина уже на паузе, второй записи в тред не появляется
    expect(await pauseIfFailing(deps(), { ownerId: owner, routineId })).toEqual({ paused: false });
    expect(
      (await threadRows(routineId)).filter(
        (r) => (r.metadata as { type?: string }).type === 'routine_paused',
      ),
    ).toHaveLength(1);
  });

  test('ручной прогон в счёт не идёт: два плановых сбоя и ручной между ними — паузы нет', async () => {
    const routineId = await seedRoutine(owner);
    await seedFailed(routineId, '2026-08-15T07:00', 1);
    await seedRoutineRun(owner, {
      routineId,
      bucket: 'manual:2026-08-15T12:00:00.000Z',
      startedAt: minutes(2),
      run: { outcome: 'failed', fail_note: 'AI-провайдер недоступен' },
    });
    await seedFailed(routineId, '2026-08-16T07:00', 3);

    expect(await pauseIfFailing(deps(), { ownerId: owner, routineId })).toEqual({ paused: false });
    expect((await aspectsOf(owner, routineId))['orbis/routine']?.stage).toBe('active');
  });

  test('удачный прогон в хвосте сбрасывает счёт', async () => {
    const routineId = await seedRoutine(owner);
    await seedFailed(routineId, '2026-08-15T07:00', 1);
    await seedFailed(routineId, '2026-08-16T07:00', 2);
    await seedRoutineRun(owner, {
      routineId,
      bucket: '2026-08-17T07:00',
      startedAt: minutes(3),
      run: { outcome: 'finished', report: 'Готово', finished_at: minutes(3).toISOString() },
    });
    await seedFailed(routineId, '2026-08-18T07:00', 4);

    expect(await pauseIfFailing(deps(), { ownerId: owner, routineId })).toEqual({ paused: false });
  });
});

describe('appendSystemNote и routineHistory', () => {
  test('appendSystemNote кладёт системное сообщение в тред сущности с метаданными', async () => {
    const routineId = await seedRoutine(owner);
    await withIdentity(db, owner, (tx) =>
      appendSystemNote(tx, {
        ownerId: owner,
        entityId: routineId,
        content: 'Проверка записи',
        metadata: { type: 'routine_note', routine_id: routineId },
      }),
    );
    const rows = await threadRows(routineId);
    const note = rows.find((r) => r.content === 'Проверка записи');
    expect(note).toBeDefined();
    expect(note?.role).toBe('system');
    expect((note?.metadata as { type?: string }).type).toBe('routine_note');
  });

  test('routineHistory: хвост ROUTINE_HISTORY_TAIL, текущий прогон исключён, порядок от старых к новым', async () => {
    const routineId = await seedRoutine(owner);
    const ids: string[] = [];
    for (let i = 0; i < ROUTINE_HISTORY_TAIL + 2; i++) {
      const { runId } = await seedRoutineRun(owner, {
        routineId,
        bucket: `2026-08-0${i + 1}T07:00`,
        startedAt: minutes(i),
        run: { outcome: 'failed', fail_note: `сбой ${i}` },
      });
      ids.push(runId);
    }
    const { runId: currentId } = await seedRoutineRun(owner, {
      routineId,
      bucket: '2026-08-20T07:00',
      startedAt: minutes(100),
    });

    const history = await withIdentity(db, owner, (tx) => routineHistory(tx, routineId, currentId));
    expect(history).toHaveLength(ROUTINE_HISTORY_TAIL);
    expect(history.map((h) => h.run.id)).toEqual(ids.slice(-ROUTINE_HISTORY_TAIL));
    expect(history.every((h) => h.run.id !== currentId)).toBe(true);
  });

  test('routineHistory: проекции предложения и ответа владельца заполнены', async () => {
    const routineId = await seedRoutine(owner);
    const oldRunId = await seedProposal(routineId, '2026-08-16T07:00');
    const { runId: answeredId } = await seedRoutineRun(owner, {
      routineId,
      bucket: '2026-08-17T07:00',
      startedAt: minutes(5),
      run: {
        outcome: 'answered',
        checkpoint: { question: 'Переносить?', asked_at: T0.toISOString() },
        reply: { text: 'Не переноси.', at: minutes(6).toISOString() },
        finished_at: minutes(6).toISOString(),
      },
    });
    const { runId: currentId } = await seedRoutineRun(owner, {
      routineId,
      bucket: '2026-08-18T07:00',
      startedAt: minutes(10),
    });

    const history = await withIdentity(db, owner, (tx) => routineHistory(tx, routineId, currentId));
    const proposed = history.find((h) => h.run.id === oldRunId);
    expect(proposed?.proposalStatus).toBe('pending');
    expect(proposed?.explanation).toContain('Задача висит в инбоксе');
    const answered = history.find((h) => h.run.id === answeredId);
    expect(answered?.reply).toBe('Не переноси.');
  });
});
