// apps/server/src/routines/lifecycle.test.ts
// Жизненный цикл рутины вокруг прогона (V1.8, V1.12) против живой БД: гашение
// незакрытого от прошлых прогонов, стоп-кран после трёх сбоев, системная запись в
// тред рутины и хвост истории.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  type AgentRunAspect,
  entityThreadId,
  isManualBucket,
  newId,
  pendingMessageId,
  routineRunBatchId,
  routineRunId,
} from '@orbis/shared';
import { eq, sql } from 'drizzle-orm';
import { appDb, freshUserId, requireEnv, truncateAll } from '../../test/helpers';
import { runsOfParent } from '../agent-loop/queries';
import { rollbackRun } from '../agent-loop/rollback';
import { closeRoutineRun, type VerbCtx } from '../agent-loop/verbs';
import { chatMessages, entities } from '../db/schema';
import { withIdentity } from '../db/with-identity';
import { ROUTINE_RUNS_PER_DAY_KEY } from '../entitlements';
import { execute } from '../executor/executor';
import { makeChatJournalSink } from '../executor/journal';
import type { ActionRecord } from '../executor/types';
import { ScriptedProvider } from '../llm/scripted';
import {
  answerPendingQuestion,
  approvePending,
  createPending,
  listRunUnits,
  rejectPending,
  rejectPendingTx,
} from '../policy/pending';
import { agentLoopHelpers, T0 } from '../test/agent-loop-helpers';
import { dispatchTool } from '../tools/dispatch';
import {
  CONSECUTIVE_FAILURES_TO_PAUSE,
  MAX_ATTEMPTS,
  MAX_RUN_UNITS,
  RETRY_DELAYS_MS,
  ROUTINE_HISTORY_TAIL,
} from './constants';
import { buildEditedOperations, editsHash, editsSchema, type ProposalEdits } from './edits';
import {
  answerRoutineCheckpoint,
  appendSystemNote,
  closeOpenOfRun,
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
): Promise<{ runId: string; taskId: string; pendingId: string }> {
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
  const run = (await aspectsOf(owner, runId))['orbis/agent-run'] as {
    proposal?: { pending_id?: string };
  };
  const pendingId = run.proposal?.pending_id;
  if (pendingId === undefined) throw new Error('seedProposal: прогон без предложения');
  return { runId, taskId: task.id, pendingId };
}

/**
 * Вопрос-единица прогона НАСТОЯЩИМ путём (`orbis_ask` через диспатч), а не вставкой в
 * ленту: и гашение, и история ищут единицы пробой по pending-записям, и сид мимо
 * `createPending` проверял бы форму, которой в проде не бывает.
 *
 * Модульная область, а не тело describe: читателей пачки два (гашение — ОЧ.8, история —
 * ОЧ.7), и вторая копия того же сида разъехалась бы с первой на первой же правке формы.
 */
async function askUnit(routineId: string, runId: string, question: string): Promise<string> {
  const r = await dispatchTool(
    routineCtx(owner, 'act', [], {
      routine: { id: routineId, runId, mode: 'act', allowedTools: new Set() },
    }),
    'orbis_ask',
    { run_id: runId, question },
  );
  if (r.status !== 'ok') throw new Error(`askUnit: ${JSON.stringify(r)}`);
  return (r.result as { pending_id: string }).pending_id;
}

/** Отложенное действие-единица тем же настоящим путём: архивация записи act-рутиной. */
async function deferUnit(
  routineId: string,
  runId: string,
  title: string,
): Promise<{ pendingId: string; targetId: string }> {
  const target = await seedEntity(owner, {
    title,
    tags: [],
    aspects: { 'orbis/task': { status: 'done' } },
  });
  const r = await dispatchTool(
    routineCtx(owner, 'act', ['entity_update'], {
      routine: { id: routineId, runId, mode: 'act', allowedTools: new Set(['entity_update']) },
    }),
    'entity_update',
    { id: target.id, archived: true },
  );
  if (r.status !== 'pending_confirmation') throw new Error(`deferUnit: ${JSON.stringify(r)}`);
  return { pendingId: r.pendingId, targetId: target.id };
}

/** Причина отказа pending'а из ленты — источник правды о судьбе предложения (V1.8). */
async function rejectReasonOf(pendingId: string): Promise<string | undefined> {
  const probe = JSON.stringify({ type: 'confirmation_rejected', rejects: pendingId });
  const rows = await withIdentity(db, owner, (tx) =>
    tx.execute(sql`SELECT metadata FROM chat_messages WHERE metadata @> ${probe}::jsonb LIMIT 1`),
  );
  const row = (rows as unknown as Array<Record<string, unknown>>)[0];
  return row === undefined ? undefined : ((row.metadata as { reason?: string }).reason ?? 'owner');
}

/** Правленые предложения, рождённые из этого, — по тому же полю, что читает лестница. */
async function editedChildrenOf(parentId: string): Promise<string[]> {
  const probe = JSON.stringify({ pending: { edited_from: parentId } });
  const rows = await withIdentity(db, owner, (tx) =>
    tx.execute(sql`SELECT id FROM chat_messages WHERE metadata @> ${probe}::jsonb`),
  );
  return [...(rows as unknown as Array<{ id: string }>)].map((r) => r.id);
}

/** Правка одного поля предложения `seedProposal`: строка `(0, orbis/task, status)`. */
function statusEdit(value: string): ProposalEdits {
  return editsSchema.parse({
    fields: [{ index: 0, aspect: 'orbis/task', field: 'status', value }],
  });
}

async function taskStatusOf(taskId: string): Promise<unknown> {
  return (await aspectsOf(owner, taskId))['orbis/task']?.status;
}

/** Предложение прогона так, как его видит граф. */
async function proposalOf(runId: string): Promise<Record<string, unknown>> {
  const run = (await aspectsOf(owner, runId))['orbis/agent-run'] as {
    proposal?: Record<string, unknown>;
  };
  if (run.proposal === undefined) throw new Error(`у прогона ${runId} нет предложения`);
  return run.proposal;
}

/**
 * Состояние «шаг 1 лестницы прошёл, шаг 2 не дошёл» — собранное руками ровно так, как его
 * оставил бы крэш процесса между транзакциями: исходное предложение погашено причиной
 * `edited`, правленое лежит рядом, а указатель прогона всё ещё смотрит на мёртвое.
 *
 * Собирается той же парой вызовов, что и сама лестница (иначе тест проверял бы фикстуру,
 * а не крэш-окно), и в ОДНОЙ транзакции — атомарность шага 1 в том и состоит.
 */
async function crashedEdit(
  run: { runId: string; routineId: string; pendingId: string },
  edits: ProposalEdits,
): Promise<string> {
  const dedupeKey = `edit:${run.pendingId}:${editsHash(edits)}`;
  const childId = pendingMessageId(owner, dedupeKey);
  await withIdentity(db, owner, async (tx) => {
    const probe = JSON.stringify({ pending: { id: run.pendingId } });
    const rows = await tx.execute(
      sql`SELECT metadata FROM chat_messages WHERE metadata @> ${probe}::jsonb LIMIT 1`,
    );
    const row = (rows as unknown as Array<Record<string, unknown>>)[0];
    const stored = (row?.metadata as { pending?: { input?: { operations?: unknown[] } } }).pending
      ?.input?.operations;
    if (stored === undefined) throw new Error('crashedEdit: у предложения нет payload’а');
    const rejected = await rejectPendingTx(tx, {
      ownerId: owner,
      pendingId: run.pendingId,
      reason: 'edited',
    });
    await createPending(tx, {
      threadId: rejected.threadId,
      actor: {
        userId: owner,
        kind: 'ai',
        source: 'routine',
        runId: run.runId,
        editedFrom: run.pendingId,
      },
      tool: 'batch_execute',
      input: { batch_id: childId, operations: buildEditedOperations(stored, edits) },
      level: 'explicit-confirmation',
      dedupeKey,
      clock: () => T0,
      content: 'Предложение рутины: 1 правка',
      summary: '1 правка',
      card: {
        kind: 'proposal_card',
        pendingId: childId,
        runId: run.runId,
        routineId: run.routineId,
        summary: '1 правка',
        explanation: 'Правленое предложение',
        editedFrom: run.pendingId,
      },
    });
  });
  return childId;
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

describe('closeOpenOfRun: гашение пачки списком (D42 ОЧ.8)', () => {
  /** Текст, с которым новый прогон снимает вопросы прошлого (тот же, что у supersedeOpen). */
  const SUPERSEDE_NOTE = 'Вопрос прошлого прогона снят: рутина сработала заново';

  /** Контекст внутреннего закрытия прогона раннером — им же ставится флажок `undecided`. */
  function verbCtx(routineId: string): VerbCtx {
    return {
      db,
      ownerId: owner,
      subject: { kind: 'routine', routineId },
      clock: () => T0,
      sink: makeChatJournalSink(),
    };
  }

  async function runAspect(runId: string): Promise<AgentRunAspect> {
    return (await aspectsOf(owner, runId))['orbis/agent-run'] as unknown as AgentRunAspect;
  }

  async function unitsOf(runId: string) {
    return withIdentity(db, owner, (tx) => listRunUnits(tx, owner, runId));
  }

  /** Строка ленты, записанная судьбой единицы: её ТЕКСТ владелец и читает (С6). */
  async function ledgerRow(
    probe: Record<string, unknown>,
  ): Promise<{ content: string; metadata: Record<string, unknown> } | undefined> {
    const json = JSON.stringify(probe);
    const rows = await withIdentity(db, owner, (tx) =>
      tx.execute(
        sql`SELECT content, metadata FROM chat_messages WHERE metadata @> ${json}::jsonb LIMIT 1`,
      ),
    );
    return (rows as unknown as Array<{ content: string; metadata: Record<string, unknown> }>)[0];
  }

  /** Бухгалтерские патчи, снявшие флажок с этого прогона: их должно быть ровно столько. */
  async function clearingActions(runId: string): Promise<ActionRecord[]> {
    return (await actionsOf(owner)).filter(
      (a) => a.run_id === runId && JSON.stringify(a.operations).includes('"undecided":false'),
    );
  }

  async function archivedOf(id: string): Promise<boolean | undefined> {
    const rows = await withIdentity(db, owner, (tx) =>
      tx.select({ archived: entities.archived }).from(entities).where(eq(entities.id, id)),
    );
    return rows[0]?.archived;
  }

  test('гасит СПИСОК: два вопроса + отложка + pending-предложение одного прогона; у единиц СВОИ тексты судеб, у предложения — прежний (С6, приёмка 8)', async () => {
    const routineId = await seedRoutine(owner);
    const { runId, pendingId: proposalId } = await seedProposal(routineId, '2026-08-16T07:00');
    // Предложение и пачка на ОДНОМ прогоне собраны нарочно: в проде режим рутины на прогон
    // один, и вместе они не встретятся, — но гашение обязано пройти обе ветки И список, а
    // не остановиться на первой сработавшей.
    const first = await askUnit(routineId, runId, 'Переносить ли встречу с понедельника?');
    const second = await askUnit(routineId, runId, 'Брать ли отчёт в работу сегодня?');
    const defer = await deferUnit(routineId, runId, 'Прошлогодний отчёт');

    const out = await closeOpenOfRun(deps(), {
      ownerId: owner,
      routineId,
      runId,
      run: await runAspect(runId),
      reason: 'superseded',
      questionNote: SUPERSEDE_NOTE,
    });
    expect(out).toEqual({ proposal: true, question: false, units: 3 });

    // Предложение — прежним путём и прежним текстом: оно и правда предложение
    expect((await proposalOf(runId)).status).toBe('superseded');
    expect((await ledgerRow({ type: 'confirmation_rejected', rejects: proposalId }))?.content).toBe(
      'Предложение заменено новым прогоном',
    );
    // А вот на отложенной архивации «Предложение снято новым прогоном» было бы неправдой
    const deferRow = await ledgerRow({ type: 'confirmation_rejected', rejects: defer.pendingId });
    expect(deferRow?.content).toBe('Отложенное действие снято новым прогоном');
    expect((deferRow?.metadata as { reason?: string }).reason).toBe('superseded');
    // Причина в metadata — прежний enum: текст только представление, второго источника
    // правды о судьбе он не заводит
    expect(await rejectReasonOf(defer.pendingId)).toBe('superseded');

    for (const pendingId of [first, second]) {
      expect((await ledgerRow({ type: 'question_stale', stales: pendingId }))?.content).toBe(
        SUPERSEDE_NOTE,
      );
    }

    // Открытых не осталось; отложенное действие ИСПОЛНЕНО не было — гашение его сняло
    const units = await unitsOf(runId);
    expect(units.map((u) => `${u.kind}:${u.fate}`).sort()).toEqual([
      'action:rejected',
      'question:stale',
      'question:stale',
    ]);
    expect(await archivedOf(defer.targetId)).toBe(false);
    // Порядок «сначала судьба pending, потом патч прогона»: статус на прогоне пишется
    // ТОЛЬКО после успешного reject'а — иначе жила бы кнопка «Принять» под снятым планом
    expect(await rejectReasonOf(proposalId)).toBe('superseded');
  });

  test('прогон с предложением И терминальным вопросом: гасятся ОБА — ранний return «либо-либо» снят (Р-5 разведки)', async () => {
    const routineId = await seedRoutine(owner);
    const { runId, pendingId } = await seedProposal(routineId, '2026-08-16T08:00');
    // Пара, которой прежний код не знал: он выходил из функции сразу после ветки
    // предложения, и терминальный вопрос того же прогона оставался висеть на владельце
    await patchRun(runId, {
      outcome: 'checkpoint',
      checkpoint: {
        question: 'Без решения по бюджету дальше двигаться некуда — что делаем?',
        asked_at: T0.toISOString(),
      },
    });

    const out = await closeOpenOfRun(deps(), {
      ownerId: owner,
      routineId,
      runId,
      run: await runAspect(runId),
      reason: 'superseded',
      questionNote: SUPERSEDE_NOTE,
    });
    expect(out).toEqual({ proposal: true, question: true, units: 0 });
    expect((await proposalOf(runId)).status).toBe('superseded');
    expect(await rejectReasonOf(pendingId)).toBe('superseded');
    expect((await runAspect(runId)).outcome).toBe('stale');
    const note = (await threadRows(routineId)).find(
      (r) => (r.metadata as { type?: string; run_id?: string }).type === 'routine_stale',
    );
    expect(note?.content).toBe(SUPERSEDE_NOTE);
    // Единиц у прогона нет вовсе — снимать флажок нечем и незачем
    expect((await runAspect(runId)).undecided).toBeUndefined();
    expect(await clearingActions(runId)).toHaveLength(0);
  });

  test('гашение сняло undecided (запись false, актор {ai, system} + run_id); отвеченный вопрос гашение пережил — ответ важнее (приёмка 17)', async () => {
    const routineId = await seedRoutine(owner);
    const { runId } = await seedRoutineRun(owner, { routineId, bucket: '2026-08-16T09:00' });
    const answered = await askUnit(routineId, runId, 'Сдвигать ли дедлайн по отчёту?');
    const open = await askUnit(routineId, runId, 'Кому отдать разбор писем?');
    expect(
      await answerPendingQuestion(db, { ownerId: owner, pendingId: answered, answer: 'сдвигай' }),
    ).toEqual({ status: 'answered', pendingId: answered });
    // Флажок ставит НАСТОЯЩИЙ его писатель — закрытие прогона (Задача 7), а не рука теста:
    // снятие обязано работать ровно над тем, что оставляет пара «close-патч → гашение»
    expect(
      (
        await closeRoutineRun(verbCtx(routineId), {
          runId,
          outcome: 'finished',
          report: 'Разобрал день, вопросы оставил владельцу.',
        })
      ).status,
    ).toBe('ok');
    expect((await runAspect(runId)).undecided).toBe(true);

    const out = await closeOpenOfRun(deps(), {
      ownerId: owner,
      routineId,
      runId,
      run: await runAspect(runId),
      reason: 'superseded',
      questionNote: SUPERSEDE_NOTE,
    });
    expect(out).toEqual({ proposal: false, question: false, units: 1 });

    // Ответ важнее гашения: судьба отвеченного прежняя, строки гашения в ленте нет
    const fates = new Map((await unitsOf(runId)).map((u) => [u.pendingId, u.fate]));
    expect(fates.get(answered)).toBe('answered');
    expect(fates.get(open)).toBe('stale');
    expect(await ledgerRow({ type: 'question_stale', stales: answered })).toBeUndefined();

    // Снятие — ЗАПИСЬ `false`, а не удаление ключа: предиката «поля нет» у грамматики §6
    // нет, и разобранную пачку иначе нечем отличить запросом от неразобранной
    expect((await runAspect(runId)).undecided).toBe(false);
    const clearing = await clearingActions(runId);
    expect(clearing).toHaveLength(1);
    // §9.6: все писатели флажка — system, иначе «отмени последнее» после «Принять» снимало
    // бы флажок вместо действия владельца (undoLast пропускает только system)
    expect(clearing[0]?.actor_kind).toBe('ai');
    expect(clearing[0]?.source).toBe('system');

    // Повтор: гасить нечего и снимать нечего — второго бухгалтерского патча не появляется
    expect(
      await closeOpenOfRun(deps(), {
        ownerId: owner,
        routineId,
        runId,
        run: await runAspect(runId),
        reason: 'superseded',
        questionNote: SUPERSEDE_NOTE,
      }),
    ).toEqual({ proposal: false, question: false, units: 0 });
    expect(await clearingActions(runId)).toHaveLength(1);
  });

  test('предложение отклонил САМ владелец, а пачка открыта: «гасить нечего» обрывает только ветку предложения — единицы гасятся (мутация :303)', async () => {
    const routineId = await seedRoutine(owner);
    const { runId, pendingId } = await seedProposal(routineId, '2026-08-16T12:00');
    const defer = await deferUnit(routineId, runId, 'Отчёт, который прогон отложил');
    // Окно V1.8: reject-строка владельца уже в ленте, а статус на прогоне ещё `pending` —
    // `closeProposalOfRun` вернёт `null`, «решено ЧУЖОЙ причиной». Прежняя форма этого
    // выхода уносила управление из ФУНКЦИИ целиком, и пачка висела бы на владельце вечно.
    expect(await rejectPending(db, { ownerId: owner, pendingId, reason: 'owner' })).toMatchObject({
      ok: true,
      alreadyRejected: false,
      reason: 'owner',
    });

    const out = await closeOpenOfRun(deps(), {
      ownerId: owner,
      routineId,
      runId,
      run: await runAspect(runId),
      reason: 'superseded',
      questionNote: SUPERSEDE_NOTE,
    });
    expect(out).toEqual({ proposal: false, question: false, units: 1 });

    // Чужое решение не переписано ни в ленте, ни на прогоне
    expect(await rejectReasonOf(pendingId)).toBe('owner');
    expect((await proposalOf(runId)).status).toBe('pending');
    // А единица пачки погашена своей причиной и своим текстом
    expect(
      (await ledgerRow({ type: 'confirmation_rejected', rejects: defer.pendingId }))?.content,
    ).toBe('Отложенное действие снято новым прогоном');
    expect((await unitsOf(runId)).every((u) => u.fate !== 'open')).toBe(true);
  });

  test('владелец ответил на терминальный вопрос, а пачка открыта: CONFLICT обрывает только ветку вопроса — единицы гасятся (мутация :350)', async () => {
    const routineId = await seedRoutine(owner);
    const { runId } = await seedRoutineRun(owner, {
      routineId,
      bucket: '2026-08-16T13:00',
      run: {
        outcome: 'checkpoint',
        checkpoint: { question: 'Переносим ли релиз на неделю?', asked_at: T0.toISOString() },
        finished_at: T0.toISOString(),
      },
    });
    const question = await askUnit(routineId, runId, 'Кому отдать разбор писем?');
    // Снимок прочитан ДО ответа — ровно та гонка, которую сторожит предусловие `outcome`:
    // владелец ответил, пока мы читали, и терминальный вопрос гасить уже нельзя
    const snapshot = await runAspect(runId);
    await answerRoutineCheckpoint(deps(), { ownerId: owner, runId, answer: 'не переносим' });

    const out = await closeOpenOfRun(deps(), {
      ownerId: owner,
      routineId,
      runId,
      run: snapshot,
      reason: 'superseded',
      questionNote: SUPERSEDE_NOTE,
    });
    expect(out).toEqual({ proposal: false, question: false, units: 1 });

    // Ответ владельца цел: исход не переписан на `stale`, записи о снятии в треде нет
    expect((await runAspect(runId)).outcome).toBe('answered');
    expect(
      (await threadRows(routineId)).some(
        (r) => (r.metadata as { type?: string }).type === 'routine_stale',
      ),
    ).toBe(false);
    // А единица пачки к терминальному вопросу отношения не имеет — она погашена
    expect((await ledgerRow({ type: 'question_stale', stales: question }))?.content).toBe(
      SUPERSEDE_NOTE,
    );
  });

  test('решённые единицы гашением не тронуты: исполненная пропущена, чужая причина отказа не перезаписана; флажок снят по «открытых не осталось»', async () => {
    const routineId = await seedRoutine(owner);
    const { runId } = await seedRoutineRun(owner, { routineId, bucket: '2026-08-16T10:00' });
    const approved = await deferUnit(routineId, runId, 'Отчёт, который владелец согласился убрать');
    const refused = await deferUnit(routineId, runId, 'Отчёт, который владелец решил оставить');
    expect(
      (
        await closeRoutineRun(verbCtx(routineId), {
          runId,
          outcome: 'finished',
          report: 'Две архивации отложил.',
        })
      ).status,
    ).toBe('ok');
    expect((await runAspect(runId)).undecided).toBe(true);

    // Владелец разобрал пачку сам: одну единицу принял, вторую отклонил СВОЕЙ причиной
    expect(
      (await approvePending(db, { ownerId: owner, pendingId: approved.pendingId, clock: () => T0 }))
        .ok,
    ).toBe(true);
    expect(
      await rejectPending(db, { ownerId: owner, pendingId: refused.pendingId, reason: 'owner' }),
    ).toMatchObject({ ok: true, alreadyRejected: false, reason: 'owner' });

    const out = await closeOpenOfRun(deps(), {
      ownerId: owner,
      routineId,
      runId,
      run: await runAspect(runId),
      reason: 'superseded',
      questionNote: SUPERSEDE_NOTE,
    });
    expect(out).toEqual({ proposal: false, question: false, units: 0 });

    const units = new Map((await unitsOf(runId)).map((u) => [u.pendingId, u]));
    expect(units.get(approved.pendingId)?.fate).toBe('approved');
    expect(await archivedOf(approved.targetId)).toBe(true); // исполненное осталось исполненным
    expect(units.get(refused.pendingId)?.fate).toBe('rejected');
    expect(units.get(refused.pendingId)?.reason).toBe('owner'); // чужая причина уважена
    expect(
      (await ledgerRow({ type: 'confirmation_rejected', rejects: refused.pendingId }))?.content,
    ).toBe('Подтверждение отклонено');

    // Гасить было нечего, но открытых не осталось — вторая половина правила снятия
    expect((await runAspect(runId)).undecided).toBe(false);
    expect(await clearingActions(runId)).toHaveLength(1);
  });

  test('rollbackRun: откат прогона гасит единицы причиной stale и СВОИМИ текстами отката (приёмка 3-хвост)', async () => {
    const routineId = await seedRoutine(owner);
    const { runId } = await seedRoutineRun(owner, { routineId, bucket: '2026-08-16T11:00' });
    const question = await askUnit(routineId, runId, 'Отменять ли завтрашний созвон?');
    const defer = await deferUnit(routineId, runId, 'Черновик, который прогон хотел убрать');
    expect(
      (
        await closeRoutineRun(verbCtx(routineId), {
          runId,
          outcome: 'finished',
          report: 'Отложил архивацию и спросил.',
        })
      ).status,
    ).toBe('ok');

    // Откат наследует обобщение автоматически — своей причиной и своими текстами
    expect((await rollbackRun(db, { actorUserId: owner, runId })).ok).toBe(true);

    const deferRow = await ledgerRow({ type: 'confirmation_rejected', rejects: defer.pendingId });
    expect(deferRow?.content).toBe('Отложенное действие устарело: прогон откачен');
    expect((deferRow?.metadata as { reason?: string }).reason).toBe('stale');
    expect((await ledgerRow({ type: 'question_stale', stales: question }))?.content).toBe(
      'Вопрос прогона снят: прогон откачен',
    );
    expect((await unitsOf(runId)).every((u) => u.fate !== 'open')).toBe(true);
    expect(await archivedOf(defer.targetId)).toBe(false);
    // Откаченный прогон не держит на владельце ни кнопок, ни сигнала о неразобранном
    expect((await runAspect(runId)).undecided).toBe(false);
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

    const history = await withIdentity(db, owner, (tx) =>
      routineHistory(tx, owner, routineId, currentId),
    );
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

    const history = await withIdentity(db, owner, (tx) =>
      routineHistory(tx, owner, routineId, currentId),
    );
    const proposed = history.find((h) => h.run.id === oldRunId);
    expect(proposed?.proposalStatus).toBe('pending');
    expect(proposed?.explanation).toContain('Задача висит в инбоксе');
    const answered = history.find((h) => h.run.id === answeredId);
    expect(answered?.reply).toBe('Не переноси.');
  });
});

describe('routineHistory: единицы пачки прошлых прогонов (D42 ОЧ.7, Б1)', () => {
  const QUESTION = 'Переносить ли встречу с Ирой?';
  const ANSWER = 'Не переноси, я сам напишу.';
  const SECOND = 'Брать ли отчёт в работу сегодня?';

  /** Хвост истории рутины глазами СЛЕДУЮЩЕГО прогона — ровно так его зовёт раннер. */
  async function historyOf(routineId: string, exceptRunId: string) {
    return withIdentity(db, owner, (tx) => routineHistory(tx, owner, routineId, exceptRunId));
  }

  test('единицы с судьбами: ответ владельца доезжает текстом, принятая отложка — своей судьбой', async () => {
    const routineId = await seedRoutine(owner);
    const { runId } = await seedRoutineRun(owner, { routineId, bucket: '2026-08-16T07:00' });
    const answered = await askUnit(routineId, runId, QUESTION);
    const defer = await deferUnit(routineId, runId, 'Прошлогодний отчёт');
    await askUnit(routineId, runId, SECOND);
    // Судьбы ставят НАСТОЯЩИЕ их писатели — кнопки владельца, а не рука теста
    expect(
      await answerPendingQuestion(db, { ownerId: owner, pendingId: answered, answer: ANSWER }),
    ).toEqual({ status: 'answered', pendingId: answered });
    expect(
      (await approvePending(db, { ownerId: owner, pendingId: defer.pendingId, clock: () => T0 }))
        .ok,
    ).toBe(true);

    const { runId: currentId } = await seedRoutineRun(owner, {
      routineId,
      bucket: '2026-08-17T07:00',
      startedAt: minutes(10),
    });
    const item = (await historyOf(routineId, currentId)).find((h) => h.run.id === runId);
    // Порядок — `created_at, id` самого listRunUnits, тексты — те, что видел владелец
    expect(item?.units).toEqual([
      { kind: 'question', text: QUESTION, fate: 'answered', answer: ANSWER },
      { kind: 'action', text: 'Архивация: «Прошлогодний отчёт»', fate: 'approved' },
      { kind: 'question', text: SECOND, fate: 'open' },
    ]);
    expect(item?.unitsOmitted).toBeUndefined();
  });

  test('отклонённая отложка едет с ПРИЧИНОЙ: подпись выводится из пары (fate, reason)', async () => {
    const routineId = await seedRoutine(owner);
    const { runId } = await seedRoutineRun(owner, { routineId, bucket: '2026-08-14T07:00' });
    const defer = await deferUnit(routineId, runId, 'Отчёт позапрошлого года');
    expect(
      await rejectPending(db, { ownerId: owner, pendingId: defer.pendingId, reason: 'owner' }),
    ).toMatchObject({ ok: true, reason: 'owner' });

    const { runId: currentId } = await seedRoutineRun(owner, {
      routineId,
      bucket: '2026-08-15T07:00',
      startedAt: minutes(10),
    });
    const item = (await historyOf(routineId, currentId)).find((h) => h.run.id === runId);
    expect(item?.units).toEqual([
      {
        kind: 'action',
        text: 'Архивация: «Отчёт позапрошлого года»',
        fate: 'rejected',
        reason: 'owner',
      },
    ]);
  });

  test('прогон без единиц — ключа units нет вовсе (не пустой массив)', async () => {
    const routineId = await seedRoutine(owner);
    const { runId } = await seedRoutineRun(owner, {
      routineId,
      bucket: '2026-08-13T07:00',
      run: { outcome: 'finished', report: 'Готово', finished_at: T0.toISOString() },
    });
    const { runId: currentId } = await seedRoutineRun(owner, {
      routineId,
      bucket: '2026-08-14T07:00',
      startedAt: minutes(10),
    });
    const item = (await historyOf(routineId, currentId)).find((h) => h.run.id === runId);
    expect(item).toBeDefined();
    // Именно ОТСУТСТВИЕ ключа, а не пустой массив: строка истории старого прогона обязана
    // остаться байт-в-байт прежней, а `units: []` уже поменял бы форму элемента
    expect(item !== undefined && 'units' in item).toBe(false);
    expect(item !== undefined && 'unitsOmitted' in item).toBe(false);
  });

  test('предложение прогона в units не попадает: пробы единиц идут по явному kind (Б5)', async () => {
    const routineId = await seedRoutine(owner);
    const { runId } = await seedProposal(routineId, '2026-08-12T07:00');
    // Предложение и вопрос на ОДНОМ прогоне — нарочно: в проде режим у прогона один, но
    // отличать их проба обязана не режимом, а ключом `kind`, которого у предложения нет
    await askUnit(routineId, runId, SECOND);

    const { runId: currentId } = await seedRoutineRun(owner, {
      routineId,
      bucket: '2026-08-13T07:00',
      startedAt: minutes(10),
    });
    const item = (await historyOf(routineId, currentId)).find((h) => h.run.id === runId);
    expect(item?.units).toEqual([{ kind: 'question', text: SECOND, fate: 'open' }]);
    // Проза предложения едет прежней проекцией, а не единицей: два носителя одного и того
    // же текста модель прочитала бы как два разных события
    expect(JSON.stringify(item?.units)).not.toContain('Задача висит в инбоксе');
    expect(item?.proposalStatus).toBe('pending');
  });

  test('свыше MAX_RUN_UNITS: в units ровно кап, остаток — в unitsOmitted (кап считает ОТКРЫТЫЕ)', async () => {
    const routineId = await seedRoutine(owner);
    const { runId } = await seedRoutineRun(owner, { routineId, bucket: '2026-08-10T07:00' });
    const asked: string[] = [];
    for (let i = 0; i < MAX_RUN_UNITS; i++) {
      asked.push(await askUnit(routineId, runId, `Вопрос №${i + 1}?`));
    }
    // Кап единиц считает ОТКРЫТЫЕ, а потолок истории — ВСЕ: два ответа освобождают место
    // под капом, и за прогон единиц накапливается больше десяти. Ветка «и ещё N» живая
    for (const pendingId of asked.slice(0, 2)) {
      expect(await answerPendingQuestion(db, { ownerId: owner, pendingId, answer: 'да' })).toEqual({
        status: 'answered',
        pendingId,
      });
    }
    for (let i = 0; i < 2; i++) await askUnit(routineId, runId, `Добавочный вопрос №${i + 1}?`);

    const { runId: currentId } = await seedRoutineRun(owner, {
      routineId,
      bucket: '2026-08-11T07:00',
      startedAt: minutes(20),
    });
    expect(await withIdentity(db, owner, (tx) => listRunUnits(tx, owner, runId))).toHaveLength(
      MAX_RUN_UNITS + 2,
    );
    const item = (await historyOf(routineId, currentId)).find((h) => h.run.id === runId);
    expect(item?.units).toHaveLength(MAX_RUN_UNITS);
    expect(item?.unitsOmitted).toBe(2);
    // Усекается ХВОСТ, а не голова: первыми модель читает те единицы, что были раньше
    expect(item?.units?.[0]?.text).toBe('Вопрос №1?');
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
      // ЛИБО после (тогда он видит идущий прогон → running).
      //
      // «done» невозможен ЗДЕСЬ, и дело не в одном снимке: прогон победителя в этом тесте
      // никто не закрывает — модель не гонится, раннера нет, — и он навсегда `running`.
      // Поэтому `done` в ЭТОМ тесте = регресс f939456 (рваный снимок из двух запросов
      // принимал идущий прогон конкурента за отработанный слот), и список расширять нельзя.
      // В scheduler.test.ts у той же гонки причин ЧЕТЫРЕ: там тик тем же вызовом гонит
      // модель до конца, победитель успевает закрыть прогон, и `done` законен — см. разбор
      // в комментарии там. Два места не противоречат друг другу: различает их не снимок, а
      // то, доходит ли прогон победителя до закрытия.
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
  /** Помечает живое предложение как рождённое правкой — так же, как это сделает писатель. */
  async function markEdited(runId: string): Promise<string> {
    const editedFrom = newId();
    await patchRun(runId, { proposal: { ...(await proposalOf(runId)), edited_from: editedFrom } });
    return editedFrom;
  }

  test('settleProposal сохраняет edited_from при пометке approved', async () => {
    const routineId = await seedRoutine(owner);
    const { runId, pendingId } = await seedProposal(routineId, '2026-08-16T07:00');
    const editedFrom = await markEdited(runId);

    const decided = await decideProposal(deps(), {
      ownerId: owner,
      runId,
      pendingId,
      decision: 'approve',
    });
    expect(decided.status).toBe('applied');

    const proposal = await proposalOf(runId);
    expect(proposal.status).toBe('approved');
    expect(proposal.edited_from).toBe(editedFrom);
  });

  test('settleProposal сохраняет edited_from при пометке stale (предусловие разошлось)', async () => {
    const routineId = await seedRoutine(owner);
    const { runId, taskId, pendingId } = await seedProposal(routineId, '2026-08-16T07:00');
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

    const decided = await decideProposal(deps(), {
      ownerId: owner,
      runId,
      pendingId,
      decision: 'approve',
    });
    expect(decided.status).toBe('stale');

    const proposal = await proposalOf(runId);
    expect(proposal.status).toBe('stale');
    expect(proposal.mismatches).toBeDefined();
    // Расхождения дописываются тем же патчем — и не должны вытеснить след правки
    expect(proposal.edited_from).toBe(editedFrom);
  });

  test('settleProposal сохраняет edited_from при пометке rejected', async () => {
    const routineId = await seedRoutine(owner);
    const { runId, pendingId } = await seedProposal(routineId, '2026-08-16T07:00');
    const editedFrom = await markEdited(runId);

    const decided = await decideProposal(deps(), {
      ownerId: owner,
      runId,
      pendingId,
      decision: 'reject',
    });
    expect(decided.status).toBe('rejected');

    const proposal = await proposalOf(runId);
    expect(proposal.status).toBe('rejected');
    expect(proposal.edited_from).toBe(editedFrom);
  });

  test('closeOpenOfRun гасит ПРАВЛЕНОЕ предложение, на которое указатель не переехал, и пишет статус по нему («решено без тебя», приёмка 13)', async () => {
    const routineId = await seedRoutine(owner);
    const { runId: oldRunId, pendingId } = await seedProposal(routineId, '2026-08-16T07:00');
    const child = await crashedEdit(
      { runId: oldRunId, routineId, pendingId },
      statusEdit('in_progress'),
    );
    const { runId: newRunId } = await seedRoutineRun(owner, {
      routineId,
      bucket: '2026-08-17T07:00',
      startedAt: minutes(10),
    });

    // Новый прогон гасит открытое прошлого. Указатель смотрит на МЁРТВОГО родителя, а
    // живёт дитя: не пойди гашение за правкой, оно вышло бы без записи и оставило бы
    // живое предложение, на которое никто не указывает.
    expect(
      await supersedeOpen(deps(), { ownerId: owner, routineId, exceptRunId: newRunId }),
    ).toEqual({ superseded: 1, staled: 0 });

    expect(await rejectReasonOf(child)).toBe('superseded');
    const proposal = await proposalOf(oldRunId);
    expect(proposal.pending_id).toBe(child);
    expect(proposal.status).toBe('superseded');
    expect(proposal.edited_from).toBe(pendingId);
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

// ---------------------------------------------------------------------------
// Правило возобновления лестницы правки (Ш1.5, Р-10). Лестница физически не может быть
// одной транзакцией: перевод указателя идёт через executor, а тот открывает свою. Значит
// крэш-окно «шаг 1 прошёл, шаг 2 не дошёл» — не редкость, а состояние, которое обязано
// доводиться само, с ЛЮБОЙ стороны: и по адресу исходного предложения, и по адресу
// правленого. Иначе владелец получает ответ «заменено» с указанием на мертвеца — круг,
// из которого экрану не выйти.
// ---------------------------------------------------------------------------

describe('возобновление лестницы правки: крэш-окно между шагами 1 и 2 (Р-10)', () => {
  /** Прогон с предложением и все три адреса, которыми оперирует правило. */
  async function crashed(bucket: string, edits: ProposalEdits) {
    const routineId = await seedRoutine(owner);
    const seeded = await seedProposal(routineId, bucket);
    const child = await crashedEdit({ ...seeded, routineId }, edits);
    // Указатель не переехал: прогон всё ещё считает живым мёртвое предложение
    expect(await proposalOf(seeded.runId)).toMatchObject({
      pending_id: seeded.pendingId,
      status: 'pending',
    });
    return { ...seeded, routineId, child };
  }

  test('решение по исходному с ТОЙ ЖЕ правкой доводит шаг 2 и применяет правленое (replay тапа, чей ответ не дошёл)', async () => {
    const edits = statusEdit('in_progress');
    const { runId, taskId, pendingId, child } = await crashed('2026-08-16T07:00', edits);

    const decided = await decideProposal(deps(), {
      ownerId: owner,
      runId,
      pendingId,
      decision: 'approve',
      edits,
    });
    expect(decided).toEqual({ status: 'applied', actionId: child, editedFrom: pendingId });

    expect(await taskStatusOf(taskId)).toBe('in_progress');
    expect(await proposalOf(runId)).toMatchObject({
      pending_id: child,
      status: 'approved',
      edited_from: pendingId,
    });
    // Второго дитяти не завелось: личность правки та же — тот же pending
    expect(await editedChildrenOf(pendingId)).toEqual([child]);
  });

  test('решение по исходному с ДРУГОЙ правкой доводит шаг 2 и отвечает replaced на живое дитя — чужую правку не применяет и своей не заводит', async () => {
    const { runId, taskId, pendingId, child } = await crashed(
      '2026-08-16T07:00',
      statusEdit('in_progress'),
    );

    const decided = await decideProposal(deps(), {
      ownerId: owner,
      runId,
      pendingId,
      decision: 'approve',
      edits: statusEdit('done'),
    });
    expect(decided).toEqual({
      status: 'replaced',
      livePendingId: child,
      liveStatus: 'pending',
      reason: 'edited',
    });

    // Ответ «заменено» не отменяет починки: указатель доведён до живого, и следующий
    // заход владельца попадает уже в него
    expect(await proposalOf(runId)).toMatchObject({
      pending_id: child,
      status: 'pending',
      edited_from: pendingId,
    });
    expect(await taskStatusOf(taskId)).toBe('inbox');
    expect(await editedChildrenOf(pendingId)).toEqual([child]);
  });

  test('решение по ПРАВЛЕНОМУ, пока указатель на мёртвом исходном, само доводит шаг 2 и применяет (вторая половина правила)', async () => {
    const { runId, taskId, pendingId, child } = await crashed(
      '2026-08-16T07:00',
      statusEdit('in_progress'),
    );

    const decided = await decideProposal(deps(), {
      ownerId: owner,
      runId,
      pendingId: child,
      decision: 'approve',
    });
    expect(decided).toEqual({ status: 'applied', actionId: child, editedFrom: pendingId });
    expect(await taskStatusOf(taskId)).toBe('in_progress');
    expect(await proposalOf(runId)).toMatchObject({
      pending_id: child,
      status: 'approved',
      edited_from: pendingId,
    });
  });

  test('«Отклонить» правленого, пока указатель на мёртвом исходном, тоже доводит шаг 2 — и закрывает именно правленое', async () => {
    const { runId, taskId, pendingId, child } = await crashed(
      '2026-08-16T07:00',
      statusEdit('in_progress'),
    );

    expect(
      await decideProposal(deps(), { ownerId: owner, runId, pendingId: child, decision: 'reject' }),
    ).toEqual({ status: 'rejected' });
    expect(await rejectReasonOf(child)).toBe('owner');
    expect(await proposalOf(runId)).toMatchObject({
      pending_id: child,
      status: 'rejected',
      edited_from: pendingId,
    });
    expect(await taskStatusOf(taskId)).toBe('inbox');
  });
});

describe('гонка двух правок одного предложения (Ш1.9, приёмка 15)', () => {
  /**
   * Две РАЗНЫЕ правки одного предложения, поданные одновременно. Инвариант: применяется
   * ровно одна, второй владелец получает ответ, называющий живое предложение («молча не
   * проигрывает никто»), и — главное — второго правленого предложения не заводится: сирота
   * pending без указателя жил бы в ленте вечно.
   *
   * Гоняется 25 раз, как гонка approve ∥ reject (policy/pending.test.ts): один прогон
   * ничего не доказывает — окно между гашением исходного и переводом указателя короткое.
   * Победитель определяется по ФАКТУ ГРАФА, а не по порядку вызовов.
   */
  test('25 итераций Promise.all: ровно одно applied, второму — replaced с живым, сирот-предложений нет', async () => {
    const iterations = 25;
    let bothApplied = 0;
    for (let i = 0; i < iterations; i++) {
      const routineId = await seedRoutine(owner);
      const { runId, taskId, pendingId } = await seedProposal(
        routineId,
        `2026-08-16T07:0${i % 10}`,
      );
      const first = statusEdit('in_progress');
      const second = statusEdit('done');

      const [a, b] = await Promise.all([
        decideProposal(deps(), {
          ownerId: owner,
          runId,
          pendingId,
          decision: 'approve',
          edits: first,
        }),
        decideProposal(deps(), {
          ownerId: owner,
          runId,
          pendingId,
          decision: 'approve',
          edits: second,
        }),
      ]);
      if (a.status === 'applied' && b.status === 'applied') {
        bothApplied++; // несогласованный исход — считаем все итерации, отчёт в assert ниже
        continue;
      }

      // Дитя одно на всю гонку — это и есть атомарность шага 1
      const children = await editedChildrenOf(pendingId);
      expect(children).toHaveLength(1);
      const child = children[0];
      const applied = a.status === 'applied' ? a : b;
      const other = a.status === 'applied' ? b : a;
      expect(applied.status).toBe('applied');
      if (applied.status !== 'applied') throw new Error('ни одна правка не применена');
      expect(applied.actionId).toBe(child as string);
      expect(applied.editedFrom).toBe(pendingId);
      // Проигравший узнаёт про живое предложение, а не молчит и не получает мертвеца.
      // `liveStatus` — снимок момента ответа: победитель мог ещё не дописать статус, и
      // требовать здесь `approved` значило бы пинить порядок двух транзакций.
      expect(other).toMatchObject({
        status: 'replaced',
        livePendingId: child as string,
        reason: 'edited',
      });
      if (other.status !== 'replaced') throw new Error('проигравший ответил не replaced');
      expect(['pending', 'approved']).toContain(other.liveStatus);
      // Победила ровно одна правка — по факту графа
      const status = await taskStatusOf(taskId);
      expect(status === 'in_progress' || status === 'done').toBe(true);
      expect(await proposalOf(runId)).toMatchObject({
        pending_id: child as string,
        status: 'approved',
        edited_from: pendingId,
      });
      expect(await rejectReasonOf(pendingId)).toBe('edited');
    }
    expect(bothApplied).toBe(0);
  }, 120_000);
});
