// apps/server/src/routines/lifecycle.test.ts
// Жизненный цикл рутины вокруг прогона (V1.8, V1.12) против живой БД: гашение
// незакрытого от прошлых прогонов, стоп-кран после трёх сбоев, системная запись в
// тред рутины и хвост истории.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  entityThreadId,
  isManualBucket,
  newId,
  routineRunBatchId,
  routineRunId,
} from '@orbis/shared';
import { eq } from 'drizzle-orm';
import { appDb, freshUserId, requireEnv, truncateAll } from '../../test/helpers';
import { runsOfParent } from '../agent-loop/queries';
import { chatMessages, entities } from '../db/schema';
import { withIdentity } from '../db/with-identity';
import { ROUTINE_RUNS_PER_DAY_KEY } from '../entitlements';
import { execute } from '../executor/executor';
import type { ActionRecord } from '../executor/types';
import { ScriptedProvider } from '../llm/scripted';
import { rejectPending } from '../policy/pending';
import { agentLoopHelpers, T0 } from '../test/agent-loop-helpers';
import { dispatchTool } from '../tools/dispatch';
import {
  CONSECUTIVE_FAILURES_TO_PAUSE,
  MAX_ATTEMPTS,
  RETRY_DELAYS_MS,
  ROUTINE_HISTORY_TAIL,
} from './constants';
import {
  appendSystemNote,
  decideProposal,
  pauseIfFailing,
  type RoutineDeps,
  routineHistory,
  startBucketRun,
  startManualRun,
  supersedeOpen,
} from './lifecycle';
import { makeRoutineLocks } from './locks';

requireEnv();

const { db, client } = appDb();
const owner = freshUserId();
const { actionsOf, aspectsOf, routineCtx, seedEntity, seedRoutine, seedRoutineRun } =
  agentLoopHelpers(db);

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

/**
 * Живое предложение прошлого прогона: настоящий путь глагола, а не подложенный аспект.
 * Возвращает и цель правки (`taskId`): предусловие снято по ЕЙ, и разойтись с графом
 * (путь `stale`) можно только тронув её.
 */
async function seedProposal(
  routineId: string,
  bucket: string,
): Promise<{ runId: string; taskId: string }> {
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
  return { runId, taskId: task.id };
}

describe('supersedeOpen: новый прогон гасит незакрытое (V1.8)', () => {
  test('pending-предложение прошлого прогона → отклонено как «заменено», статус на прогоне superseded', async () => {
    const routineId = await seedRoutine(owner);
    const { runId: oldRunId } = await seedProposal(routineId, '2026-08-16T07:00');
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

  test('предложение уже отклонил владелец (reject-строка reason owner), статус на прогоне ещё pending → гашение НЕ переписывает его на superseded', async () => {
    const routineId = await seedRoutine(owner);
    const { runId: oldRunId } = await seedProposal(routineId, '2026-08-16T07:00');
    const run = (await aspectsOf(owner, oldRunId))['orbis/agent-run'] as {
      proposal?: { pending_id: string; status: string };
    };
    const pendingId = run.proposal?.pending_id;
    if (pendingId === undefined) throw new Error('у прогона нет предложения');
    // Окно V1.8: владелец нажал «отклонить» (reject-строка с reason 'owner' уже лежит), а
    // decideProposal (Задача 11) ещё не дописал статус на прогон — он по-прежнему pending
    const owned = await rejectPending(db, { ownerId: owner, pendingId, reason: 'owner' });
    expect(owned).toMatchObject({ ok: true, alreadyRejected: false, reason: 'owner' });
    const { runId: newRunId } = await seedRoutineRun(owner, {
      routineId,
      bucket: '2026-08-17T07:00',
      startedAt: minutes(10),
    });

    const out = await supersedeOpen(deps(), { ownerId: owner, routineId, exceptRunId: newRunId });
    expect(out).toEqual({ superseded: 0, staled: 0 });

    // Статус пишет тот, чей reason в reject-строке: «заменено» поверх «владелец отклонил»
    // соврало бы про его решение — прогон остался таким, каким его оставит decideProposal
    const after = (await aspectsOf(owner, oldRunId))['orbis/agent-run'] as {
      proposal?: { status: string };
    };
    expect(after.proposal?.status).toBe('pending');
    const reject = (await threadRows(routineId)).find(
      (r) => (r.metadata as { type?: string }).type === 'confirmation_rejected',
    );
    expect((reject?.metadata as { reason?: string }).reason).toBe('owner');
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

  test('после снятия паузы владельцем старые провалы не считаются: один новый failed → паузы нет, ещё два → пауза снова (C1a-6)', async () => {
    const routineId = await seedRoutine(owner);
    await seedFailed(routineId, '2026-08-15T07:00', 1);
    await seedFailed(routineId, '2026-08-16T07:00', 2);
    await seedFailed(routineId, '2026-08-17T07:00', 3);
    expect(await pauseIfFailing(deps(), { ownerId: owner, routineId })).toEqual({ paused: true });
    const first = (await threadRows(routineId)).filter(
      (r) => (r.metadata as { type?: string }).type === 'routine_paused',
    );
    expect(first).toHaveLength(1);
    // Запись стоп-крана помнит последний учтённый провал — границу следующего счёта
    expect((first[0]?.metadata as { run_id?: string }).run_id).toBe(
      routineRunId(routineId, '2026-08-17T07:00', 1),
    );

    // Владелец снял паузу рукой: «причина устранена», счёт с нуля
    const unpaused = await execute(db, {
      actorUserId: owner,
      actorKind: 'owner',
      source: 'ui',
      operations: [
        {
          tool: 'entity_update',
          input: { id: routineId, aspects: { 'orbis/routine': { stage: 'active' } } },
        },
      ],
      clock: () => minutes(4),
    });
    if (!unpaused.ok) throw new Error(unpaused.error.message);

    // Один НОВЫЙ плановый сбой (транзиент): хвост старых [f,f,f] не считается — паузы нет,
    // и попытки 2–3 бакета смогут случиться
    await seedFailed(routineId, '2026-08-18T07:00', 5);
    expect(await pauseIfFailing(deps(), { ownerId: owner, routineId })).toEqual({ paused: false });
    expect((await aspectsOf(owner, routineId))['orbis/routine']?.stage).toBe('active');

    // Ещё два новых подряд — три новых, пауза снова, вторая запись с новой границей
    await seedFailed(routineId, '2026-08-19T07:00', 6);
    expect(await pauseIfFailing(deps(), { ownerId: owner, routineId })).toEqual({ paused: false });
    await seedFailed(routineId, '2026-08-20T07:00', 7);
    expect(await pauseIfFailing(deps(), { ownerId: owner, routineId })).toEqual({ paused: true });
    expect((await aspectsOf(owner, routineId))['orbis/routine']?.stage).toBe('paused');
    const notes = (await threadRows(routineId)).filter(
      (r) => (r.metadata as { type?: string }).type === 'routine_paused',
    );
    expect(notes).toHaveLength(2);
    expect((notes[1]?.metadata as { run_id?: string }).run_id).toBe(
      routineRunId(routineId, '2026-08-20T07:00', 1),
    );
  });

  test('запись стоп-крана старого формата (без run_id) границы не даёт: считаются все плановые', async () => {
    const routineId = await seedRoutine(owner);
    await seedFailed(routineId, '2026-08-15T07:00', 1);
    await seedFailed(routineId, '2026-08-16T07:00', 2);
    await withIdentity(db, owner, (tx) =>
      appendSystemNote(tx, {
        ownerId: owner,
        entityId: routineId,
        content: 'Рутина поставлена на паузу (старый формат)',
        metadata: { type: 'routine_paused', routine_id: routineId },
      }),
    );
    await seedFailed(routineId, '2026-08-17T07:00', 3);
    expect(await pauseIfFailing(deps(), { ownerId: owner, routineId })).toEqual({ paused: true });
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
    const { runId: oldRunId } = await seedProposal(routineId, '2026-08-16T07:00');
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

// ---------------------------------------------------------------------------
// Запуск прогона (V1.3): бакет — детерминированный batch, «создатель — не replay»,
// ретраи с паузой, лимит прогонов в сутки; ручной прогон — свой ключ.
// ---------------------------------------------------------------------------

/** Патч аспекта прогона рукой владельца (как это сделал бы экран) — вне путей раннера. */
async function patchRun(runId: string, patch: Record<string, unknown>): Promise<void> {
  const r = await execute(db, {
    actorUserId: owner,
    actorKind: 'owner',
    source: 'ui',
    operations: [
      { tool: 'entity_update', input: { id: runId, aspects: { 'orbis/agent-run': patch } } },
    ],
    clock: () => T0,
  });
  if (!r.ok) throw new Error(`patchRun: ${r.error.code} ${r.error.message}`);
}

async function runsOf(routineId: string) {
  return withIdentity(db, owner, (tx) => runsOfParent(tx, routineId));
}

function routineRef(routineId: string): { id: string; title: string } {
  return { id: routineId, title: 'Утренний обзор' };
}

/** Резолвер лимитов: только ключ прогонов в сутки ограничен, остальное безлимитно. */
function runsPerDay(limit: number | null, allowed = true) {
  return (_owner: string, key: string) =>
    key === ROUTINE_RUNS_PER_DAY_KEY ? { allowed, limit } : { allowed: true, limit: null };
}

describe("startBucketRun: прогон бакета одним batch'ем (V1.3, инвариант 1)", () => {
  test('создаёт прогон с детерминированными id и batch_id, связью parent и бухгалтерией ai/system; повтор при running → running; после закрытия — done', async () => {
    const routineId = await seedRoutine(owner);
    const bucket = '2026-08-17T07:00';

    const first = await startBucketRun(deps(), {
      ownerId: owner,
      routine: routineRef(routineId),
      bucket,
    });
    expect(first).toEqual({ started: true, runId: routineRunId(routineId, bucket, 1), bucket });
    if (!first.started) throw new Error('unreachable');

    const run = (await aspectsOf(owner, first.runId))['orbis/agent-run'] as Record<string, unknown>;
    expect(run).toMatchObject({
      routine_id: routineId,
      bucket,
      attempt: 1,
      outcome: 'running',
      started_at: T0.toISOString(),
      last_step_at: T0.toISOString(),
      step_count: 0,
      steps: [],
    });
    expect(run.grant_id).toBeUndefined();
    // Связь parent рутина→прогон — тем же batch'ем: прогон виден в истории рутины
    expect((await runsOf(routineId)).map((r) => r.id)).toEqual([first.runId]);
    // Бухгалтерия прогона (Р-7): актор ai, источник system, run_id — и action именно
    // с детерминированным batch_id, по которому конкурент получит replay
    const action = (await actionsOf(owner)).find(
      (a: ActionRecord) => a.id === routineRunBatchId(routineId, bucket, 1),
    );
    expect(action).toBeDefined();
    expect(action).toMatchObject({ actor_kind: 'ai', source: 'system', run_id: first.runId });

    // Тот же бакет, пока прогон идёт — «уже идёт», второй сущности нет
    expect(
      await startBucketRun(deps(), { ownerId: owner, routine: routineRef(routineId), bucket }),
    ).toEqual({ started: false, reason: 'running' });
    expect(await runsOf(routineId)).toHaveLength(1);

    // Прогон закрыт удачно — бакет отработан навсегда
    await patchRun(first.runId, { outcome: 'finished', finished_at: T0.toISOString() });
    expect(
      await startBucketRun(deps(), { ownerId: owner, routine: routineRef(routineId), bucket }),
    ).toEqual({ started: false, reason: 'done' });
    // Вопрос (checkpoint) и ответ на него — тоже «отработан»: попытка не повторяется
    await patchRun(first.runId, { outcome: 'checkpoint' });
    expect(
      await startBucketRun(deps(), { ownerId: owner, routine: routineRef(routineId), bucket }),
    ).toEqual({ started: false, reason: 'done' });
  });

  test('два конкурентных запуска одного бакета ИЗ ДВУХ ПРОЦЕССОВ: ровно один started, второй replay|id_conflict|running; сущность одна — 5 раундов (приёмка 13, Р-1)', async () => {
    for (let round = 0; round < 5; round++) {
      const routineId = await seedRoutine(owner);
      const bucket = '2026-08-17T07:00';
      const args = { ownerId: owner, routine: routineRef(routineId), bucket };
      // Два экземпляра замка = два процесса (locks.ts): межпроцессную гонку одного бакета
      // держат batch_id/PK, и именно их здесь и проверяем — общий замок процесса свёл бы
      // второй запуск к «уже идёт», не дав дойти до execute
      const [a, b] = await Promise.all([
        startBucketRun(deps({ locks: makeRoutineLocks() }), args),
        startBucketRun(deps({ locks: makeRoutineLocks() }), args),
      ]);
      const started = [a, b].filter((o) => o.started);
      const lost = [a, b].filter((o) => !o.started);
      expect(started).toHaveLength(1);
      expect(lost).toHaveLength(1);
      expect(started[0]).toEqual({
        started: true,
        runId: routineRunId(routineId, bucket, 1),
        bucket,
      });
      // Проигравший различим по причине, но не по последствиям: сущность одна. Причин три,
      // потому что снимок проигравшего берётся ЛИБО до коммита победителя (тогда он идёт в
      // execute и проигрывает там: replay по PK audit'а или занятый id/связь → id_conflict),
      // ЛИБО после (тогда он видит идущий прогон → running); «done» невозможен — снимок один
      expect(['replay', 'id_conflict', 'running']).toContain(
        (lost[0] as { reason: string }).reason,
      );
      expect((await runsOf(routineId)).map((r) => r.id)).toEqual([
        routineRunId(routineId, bucket, 1),
      ]);
    }
  });

  test('ретраи: failed → пауза RETRY_DELAYS_MS[attempt−1] от finished_at → следующая попытка с новым id; после MAX_ATTEMPTS — attempts', async () => {
    const routineId = await seedRoutine(owner);
    const bucket = '2026-08-17T07:00';
    const args = { ownerId: owner, routine: routineRef(routineId), bucket };
    // Попытка 1 провалилась в T0
    await seedRoutineRun(owner, {
      routineId,
      bucket,
      attempt: 1,
      run: {
        outcome: 'failed',
        fail_note: 'AI-провайдер недоступен',
        finished_at: T0.toISOString(),
      },
    });
    const firstDelay = RETRY_DELAYS_MS[0];
    const secondDelay = RETRY_DELAYS_MS[1];

    // Пауза ещё идёт — попытка не заводится
    expect(await startBucketRun(deps({ clock: () => minutes(1) }), args)).toEqual({
      started: false,
      reason: 'backoff',
    });
    // Пауза вышла (граница включительно) — попытка 2 с id по тройке (рутина, бакет, 2)
    const second = await startBucketRun(
      deps({ clock: () => new Date(T0.getTime() + firstDelay) }),
      args,
    );
    expect(second).toEqual({ started: true, runId: routineRunId(routineId, bucket, 2), bucket });
    expect(
      (await aspectsOf(owner, routineRunId(routineId, bucket, 2)))['orbis/agent-run'],
    ).toMatchObject({
      attempt: 2,
      outcome: 'running',
    });

    // Попытка 2 провалилась спустя минуту — отсчёт следующей паузы (15 мин) от ЕЁ finished_at
    const failedAt2 = new Date(T0.getTime() + firstDelay + 60_000);
    await patchRun(routineRunId(routineId, bucket, 2), {
      outcome: 'failed',
      fail_note: 'снова',
      finished_at: failedAt2.toISOString(),
    });
    expect(
      await startBucketRun(
        deps({ clock: () => new Date(failedAt2.getTime() + secondDelay - 60_000) }),
        args,
      ),
    ).toEqual({ started: false, reason: 'backoff' });
    const third = await startBucketRun(
      deps({ clock: () => new Date(failedAt2.getTime() + secondDelay) }),
      args,
    );
    expect(third).toEqual({ started: true, runId: routineRunId(routineId, bucket, 3), bucket });

    // Третья провалилась — попыток больше нет, сколько бы времени ни прошло
    await patchRun(routineRunId(routineId, bucket, 3), {
      outcome: 'failed',
      finished_at: minutes(60).toISOString(),
    });
    expect(MAX_ATTEMPTS).toBe(3);
    expect(await startBucketRun(deps({ clock: () => minutes(24 * 60) }), args)).toEqual({
      started: false,
      reason: 'attempts',
    });
    expect(await runsOf(routineId)).toHaveLength(3);
  });

  test('ручной прогон и бакет В ОДНО ОКНО одного процесса: ровно один started, второй — running (замок рутины, C1a-5/C2-2)', async () => {
    // Без замка оба читали бы снимок без running и создавали бы прогоны с РАЗНЫМИ ключами
    // (manual:<ISO> и бакет) — PK проигравшего не останавливает. Замок по умолчанию общий
    // на процесс (processRoutineLocks): так делят его тик и кнопка «прогнать сейчас»
    for (let round = 0; round < 5; round++) {
      const routineId = await seedRoutine(owner);
      const [manual, bucket] = await Promise.all([
        startManualRun(deps(), {
          ownerId: owner,
          routine: routineRef(routineId),
          timeZone: 'Europe/Moscow',
        }),
        startBucketRun(deps(), {
          ownerId: owner,
          routine: routineRef(routineId),
          bucket: '2026-08-17T07:00',
        }),
      ]);
      const started = [manual, bucket].filter((o) => o.started);
      const lost = [manual, bucket].filter((o) => !o.started);
      expect(started).toHaveLength(1);
      expect(lost).toEqual([{ started: false, reason: 'running' }]);
      expect(await runsOf(routineId)).toHaveLength(1);
    }
  });

  test('идущий прогон ДРУГОГО слота (ручной) блокирует бакет: у рутины не бывает двух running', async () => {
    const routineId = await seedRoutine(owner);
    const manual = await startManualRun(deps(), {
      ownerId: owner,
      routine: routineRef(routineId),
      timeZone: 'Europe/Moscow',
    });
    expect(manual.started).toBe(true);
    expect(
      await startBucketRun(deps(), {
        ownerId: owner,
        routine: routineRef(routineId),
        bucket: '2026-08-17T07:00',
      }),
    ).toEqual({ started: false, reason: 'running' });
  });
});

describe('лимит routines.runs_per_day (V1.15): плановые прогоны за локальный день рутины', () => {
  test('limit 1: плановый прогон другого бакета того же дня уже есть → второй плановый limit; ручной тоже упирается', async () => {
    const routineId = await seedRoutine(owner);
    // Слот 06:00 того же дня (владелец сдвинул `at` после того, как утро уже отработало)
    await seedRoutineRun(owner, {
      routineId,
      bucket: '2026-08-17T06:00',
      run: { outcome: 'finished', finished_at: T0.toISOString() },
    });
    const limited = deps({ entitlements: runsPerDay(1) });
    expect(
      await startBucketRun(limited, {
        ownerId: owner,
        routine: routineRef(routineId),
        bucket: '2026-08-17T07:00',
      }),
    ).toEqual({ started: false, reason: 'limit' });
    // T0 = 12:00Z = 15:00 мск 17-го: локальный день тот же — ручной прогон тоже не заводится
    expect(
      await startManualRun(limited, {
        ownerId: owner,
        routine: routineRef(routineId),
        timeZone: 'Europe/Moscow',
      }),
    ).toEqual({ started: false, reason: 'limit' });
    // Отказ резолвера («прогонов на этом плане нет») — тот же исход без счёта
    expect(
      await startBucketRun(deps({ entitlements: runsPerDay(null, false) }), {
        ownerId: owner,
        routine: routineRef(routineId),
        bucket: '2026-08-17T07:00',
      }),
    ).toEqual({ started: false, reason: 'limit' });
    // Ничего не создано
    expect(await runsOf(routineId)).toHaveLength(1);
  });

  test('день считается по дате бакета: вчерашний прогон и ручные прогоны сегодняшний лимит не занимают; безлимитный план не считает вовсе', async () => {
    const routineId = await seedRoutine(owner);
    await seedRoutineRun(owner, {
      routineId,
      bucket: '2026-08-16T07:00',
      run: { outcome: 'finished', finished_at: T0.toISOString() },
    });
    await seedRoutineRun(owner, {
      routineId,
      bucket: 'manual:2026-08-17T10:00:00.000Z',
      run: { outcome: 'finished', finished_at: T0.toISOString() },
    });
    const limited = deps({ entitlements: runsPerDay(1) });
    const started = await startBucketRun(limited, {
      ownerId: owner,
      routine: routineRef(routineId),
      bucket: '2026-08-17T07:00',
    });
    expect(started).toEqual({
      started: true,
      runId: routineRunId(routineId, '2026-08-17T07:00', 1),
      bucket: '2026-08-17T07:00',
    });
    // Теперь сегодняшний плановый есть — ручной упирается (прогон идёт → running раньше лимита,
    // поэтому закрываем его)
    await patchRun(routineRunId(routineId, '2026-08-17T07:00', 1), {
      outcome: 'finished',
      finished_at: T0.toISOString(),
    });
    expect(
      await startManualRun(limited, {
        ownerId: owner,
        routine: routineRef(routineId),
        timeZone: 'Europe/Moscow',
      }),
    ).toEqual({ started: false, reason: 'limit' });
    // Тот же граф без лимита (план dev) — ручной прогон заводится
    const free = await startManualRun(deps({ clock: () => minutes(1) }), {
      ownerId: owner,
      routine: routineRef(routineId),
      timeZone: 'Europe/Moscow',
    });
    expect(free.started).toBe(true);
  });
});

describe('startManualRun: ручной прогон — свой ключ, не занимает бакет (V1.3)', () => {
  test('bucket = manual:<ISO часов>, attempt 1, свежий batch_id; повтор в ту же миллисекунду — id_conflict, а не replay; при running — running', async () => {
    const routineId = await seedRoutine(owner);
    const first = await startManualRun(deps(), {
      ownerId: owner,
      routine: routineRef(routineId),
      timeZone: 'Europe/Moscow',
    });
    const bucket = `manual:${T0.toISOString()}`;
    expect(first).toEqual({ started: true, runId: routineRunId(routineId, bucket, 1), bucket });
    const run = (await aspectsOf(owner, routineRunId(routineId, bucket, 1)))[
      'orbis/agent-run'
    ] as Record<string, unknown>;
    expect(run).toMatchObject({ routine_id: routineId, bucket, attempt: 1, outcome: 'running' });
    expect(isManualBucket(run.bucket as string)).toBe(true);
    // Свой batch_id: action создания НЕ под routineRunBatchId (это не плановый слот)
    const planned = (await actionsOf(owner)).find(
      (a: ActionRecord) => a.id === routineRunBatchId(routineId, bucket, 1),
    );
    expect(planned).toBeUndefined();

    // Пока идёт — второй ручной не заводится
    expect(
      await startManualRun(deps(), {
        ownerId: owner,
        routine: routineRef(routineId),
        timeZone: 'Europe/Moscow',
      }),
    ).toEqual({ started: false, reason: 'running' });

    await patchRun(routineRunId(routineId, bucket, 1), {
      outcome: 'finished',
      finished_at: T0.toISOString(),
    });
    // Те же часы → тот же ключ, но batch_id свежий: это НЕ replay прошлого запуска, а занятый
    // id — прогон не заводится и модель никто не гонит
    expect(
      await startManualRun(deps(), {
        ownerId: owner,
        routine: routineRef(routineId),
        timeZone: 'Europe/Moscow',
      }),
    ).toEqual({ started: false, reason: 'id_conflict' });

    // Плановый бакет ручным прогоном не занят: слот 07:00 свободен
    expect(
      await startBucketRun(deps(), {
        ownerId: owner,
        routine: routineRef(routineId),
        bucket: '2026-08-17T07:00',
      }),
    ).toEqual({
      started: true,
      runId: routineRunId(routineId, '2026-08-17T07:00', 1),
      bucket: '2026-08-17T07:00',
    });
  });

  test('часы читаются один раз: при тикающих часах ключ manual:<ISO>, started_at и created_at совпадают до миллисекунды', async () => {
    const routineId = await seedRoutine(owner);
    let ticks = 0;
    const ticking = deps({ clock: () => new Date(T0.getTime() + ticks++) });
    const out = await startManualRun(ticking, {
      ownerId: owner,
      routine: routineRef(routineId),
      timeZone: 'Europe/Moscow',
    });
    if (!out.started) throw new Error(`ручной прогон не заведён: ${out.reason}`);
    expect(out.bucket).toBe(`manual:${T0.toISOString()}`);
    // Второе чтение часов дало бы started_at на миллисекунду позже ключа — тикающие часы это ловят
    const run = (await aspectsOf(owner, out.runId))['orbis/agent-run'] as Record<string, unknown>;
    expect(run.started_at).toBe(T0.toISOString());
    expect(run.last_step_at).toBe(T0.toISOString());
    const rows = await withIdentity(db, owner, (tx) =>
      tx.select({ createdAt: entities.createdAt }).from(entities).where(eq(entities.id, out.runId)),
    );
    expect(rows[0]?.createdAt.toISOString()).toBe(T0.toISOString());
  });
});

// ---------------------------------------------------------------------------
// Правка предложения (Ш1.8): `edited_from` — след того, что предложение родилось из
// правки владельца. Писателя поля ещё нет, но оба пересборщика объекта `proposal`
// (settleProposal и closeOpenOfRun) обязаны протаскивать его уже сейчас: патч они
// собирают руками, `patchAspect` принимает `Record<string, unknown>` — забытое поле
// оторвалось бы молча, и тип этого не поймает.
// ---------------------------------------------------------------------------

describe('edited_from переживает решение по предложению (Ш1.8)', () => {
  /** Предложение прогона так, как его видит граф. */
  async function proposalOf(runId: string): Promise<Record<string, unknown>> {
    const run = (await aspectsOf(owner, runId))['orbis/agent-run'] as {
      proposal?: Record<string, unknown>;
    };
    if (run.proposal === undefined) throw new Error(`у прогона ${runId} нет предложения`);
    return run.proposal;
  }

  /** Помечает живое предложение как рождённое правкой — так же, как это сделает писатель. */
  async function markEdited(runId: string): Promise<string> {
    const editedFrom = newId();
    await patchRun(runId, { proposal: { ...(await proposalOf(runId)), edited_from: editedFrom } });
    return editedFrom;
  }

  test('settleProposal сохраняет edited_from при пометке approved', async () => {
    const routineId = await seedRoutine(owner);
    const { runId } = await seedProposal(routineId, '2026-08-16T07:00');
    const editedFrom = await markEdited(runId);

    const decided = await decideProposal(deps(), { ownerId: owner, runId, decision: 'approve' });
    expect(decided.status).toBe('applied');

    const proposal = await proposalOf(runId);
    expect(proposal.status).toBe('approved');
    expect(proposal.edited_from).toBe(editedFrom);
  });

  test('settleProposal сохраняет edited_from при пометке stale (предусловие разошлось)', async () => {
    const routineId = await seedRoutine(owner);
    const { runId, taskId } = await seedProposal(routineId, '2026-08-16T07:00');
    const editedFrom = await markEdited(runId);
    // Владелец закрыл задачу сам — снятое предусловие `status in ['inbox']` больше не держится
    const done = await execute(db, {
      actorUserId: owner,
      actorKind: 'owner',
      source: 'ui',
      operations: [
        {
          tool: 'entity_update',
          input: { id: taskId, aspects: { 'orbis/task': { status: 'done' } } },
        },
      ],
      clock: () => T0,
    });
    if (!done.ok) throw new Error(`закрытие задачи: ${done.error.code}`);

    const decided = await decideProposal(deps(), { ownerId: owner, runId, decision: 'approve' });
    expect(decided.status).toBe('stale');

    const proposal = await proposalOf(runId);
    expect(proposal.status).toBe('stale');
    expect(proposal.mismatches).toBeDefined();
    // Расхождения дописываются тем же патчем — и не должны вытеснить след правки
    expect(proposal.edited_from).toBe(editedFrom);
  });

  test('settleProposal сохраняет edited_from при пометке rejected', async () => {
    const routineId = await seedRoutine(owner);
    const { runId } = await seedProposal(routineId, '2026-08-16T07:00');
    const editedFrom = await markEdited(runId);

    const decided = await decideProposal(deps(), { ownerId: owner, runId, decision: 'reject' });
    expect(decided.status).toBe('rejected');

    const proposal = await proposalOf(runId);
    expect(proposal.status).toBe('rejected');
    expect(proposal.edited_from).toBe(editedFrom);
  });

  test('closeOpenOfRun сохраняет edited_from при гашении superseded', async () => {
    const routineId = await seedRoutine(owner);
    const { runId: oldRunId } = await seedProposal(routineId, '2026-08-16T07:00');
    const editedFrom = await markEdited(oldRunId);
    const { runId: newRunId } = await seedRoutineRun(owner, {
      routineId,
      bucket: '2026-08-17T07:00',
      startedAt: minutes(10),
    });

    expect(
      await supersedeOpen(deps(), { ownerId: owner, routineId, exceptRunId: newRunId }),
    ).toEqual({ superseded: 1, staled: 0 });

    const proposal = await proposalOf(oldRunId);
    expect(proposal.status).toBe('superseded');
    expect(proposal.edited_from).toBe(editedFrom);
  });
});
