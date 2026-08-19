// apps/server/src/routers/routine.test.ts
// Роутер routine (§9.1, V1.3/V1.6/V1.9): владельческая половина рутины — «прогнать
// сейчас», ответ на вопрос прогона, чтение предложения и решение по нему, обзор.
// Против живой БД, caller как в бою (createCallerFactory с инжектированным ai —
// провайдер/часы, лекало send-message.test.ts), предложение рождается НАСТОЯЩИМ
// прогоном через `runNow`: собранный руками pending проверял бы фикстуру, а не путь.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { manualBucket, newId, routineRunId } from '@orbis/shared';
import { TRPCError } from '@trpc/server';
import { eq, sql } from 'drizzle-orm';
import { appDb, freshUserId, requireEnv, truncateAll } from '../../test/helpers';
import { routineById } from '../agent-loop/queries';
import { ROUTINE_ROLLBACK_NOTE, rollbackRun } from '../agent-loop/rollback';
import { entities } from '../db/schema';
import { withIdentity } from '../db/with-identity';
import { execute } from '../executor/executor';
import { undoLast } from '../executor/undo';
import { ScriptedProvider } from '../llm/scripted';
import type { LLMProvider, LLMRequest, LLMResponse } from '../llm/types';
import { appRouter } from '../router';
import type { RoutineDeps } from '../routines/lifecycle';
import { startBucketRun, supersedeOpen } from '../routines/lifecycle';
import { runRoutineRun } from '../routines/runner';
import { makeRunRegistry } from '../routines/shutdown';
import { agentLoopHelpers, iso, T0 } from '../test/agent-loop-helpers';
import { type Context, createCallerFactory } from '../trpc';

requireEnv();

const { db, client } = appDb();
const owner = freshUserId();
const { actionsOf, aspectsOf, seedEntity, seedRoutine, seedRoutineRun } = agentLoopHelpers(db);
const createCaller = createCallerFactory(appRouter);

const MODEL = 'scripted-model';
const EXPLANATION = 'Задача висит в инбоксе третий день — предлагаю взять её сегодня.';
/** Бакет ручного прогона при часах `() => T0` — детерминирован, как и id прогона. */
const MANUAL_BUCKET = manualBucket(T0.toISOString());
/** T0 = 15:00 мск; рутина «в 07:00» сегодня уже сработала → следующий слот завтра. */
const NEXT_AFTER_T0 = '2026-08-18T04:00:00.000Z';
/** «Через минуту»: момент владельческого решения — он всегда позже создания прогона. */
const LATER = new Date(T0.getTime() + 60_000);

beforeAll(async () => {
  await truncateAll();
});

afterAll(async () => {
  await client.end();
});

// ---------------------------------------------------------------------------
// Хелперы
// ---------------------------------------------------------------------------

function toolUse(calls: Array<{ name: string; input: Record<string, unknown> }>): LLMResponse {
  return {
    content: '',
    toolCalls: calls.map((c, i) => ({ id: `call-${i}`, name: c.name, input: c.input })),
    usage: { inputTokens: 10, outputTokens: 5 },
    stopReason: 'tool_use',
  };
}

/** Провайдер, который держит первый ответ до отпускания: так прогон остаётся `running`. */
class GatedProvider implements LLMProvider {
  readonly modelId = MODEL;
  constructor(
    private readonly inner: ScriptedProvider,
    private readonly gate: Promise<void>,
  ) {}
  async chat(req: LLMRequest): Promise<LLMResponse> {
    await this.gate;
    return this.inner.chat(req);
  }
}

function callerWith(provider: LLMProvider, over: Partial<NonNullable<Context['ai']>> = {}) {
  return createCaller({
    actorUserId: owner,
    actorKind: 'owner',
    db,
    clientVersion: null,
    ai: { provider, model: MODEL, clock: () => T0, ...over },
  });
}

/** Caller без сценария модели: процедуры без раннера провайдер не трогают. */
function caller() {
  return callerWith(new ScriptedProvider([]));
}

/**
 * Caller с часами «через минуту после T0»: владелец отвечает и решает ПОЗЖЕ, чем прогон
 * был заведён. Для журнала это не косметика — окно конфликтов отката отбирается составным
 * курсором `(created_at, id)`, и замороженные на один миг часы сделали бы ответ владельца
 * неотличимым по времени от создания прогона.
 */
function callerLater() {
  return callerWith(new ScriptedProvider([]), { clock: () => LATER });
}

async function trpcError(p: Promise<unknown>): Promise<TRPCError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof TRPCError) return e;
    throw e;
  }
  throw new Error('ожидался TRPCError, вызов успешен');
}

interface RunAspect {
  outcome: string;
  bucket?: string;
  report?: string;
  fail_note?: string;
  reply?: { text: string; at: string };
  proposal?: {
    pending_id: string;
    status: string;
    decided_at?: string;
    mismatches?: Array<{ aspect: string; field: string; note: string }>;
  };
}

async function runAspect(runId: string): Promise<RunAspect> {
  return (await aspectsOf(owner, runId))['orbis/agent-run'] as unknown as RunAspect;
}

async function taskStatus(taskId: string): Promise<unknown> {
  return (await aspectsOf(owner, taskId))['orbis/task']?.status;
}

/** Ждём, пока фоновый раннер закроет прогон: fire-and-forget ответа не даёт. */
async function waitClosed(runId: string, timeoutMs = 2000): Promise<RunAspect> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const aspect = await runAspect(runId);
    if (aspect.outcome !== 'running') return aspect;
    if (Date.now() > until) throw new Error(`прогон ${runId} не закрыт за ${timeoutMs} мс`);
    await Bun.sleep(20);
  }
}

async function seedTask(title: string): Promise<string> {
  const e = await seedEntity(owner, {
    title,
    tags: [],
    aspects: { 'orbis/task': { status: 'inbox' } },
  });
  return e.id;
}

/** Правка владельца своей же рукой — то, обо что разбивается устаревшее предложение. */
async function ownerSets(taskId: string, status: string): Promise<void> {
  const r = await execute(db, {
    actorUserId: owner,
    actorKind: 'owner',
    source: 'ui',
    operations: [
      { tool: 'entity_update', input: { id: taskId, aspects: { 'orbis/task': { status } } } },
    ],
  });
  if (!r.ok) throw new Error(`ownerSets: ${r.error.code} ${r.error.message}`);
}

function proposeCall(runId: string, taskId: string) {
  return {
    name: 'orbis_propose',
    input: {
      run_id: runId,
      explanation: EXPLANATION,
      operations: [
        {
          tool: 'entity_update',
          input: { id: taskId, aspects: { 'orbis/task': { status: 'planned' } } },
        },
      ],
    },
  };
}

interface Proposed {
  routineId: string;
  taskId: string;
  runId: string;
  pendingId: string;
}

/**
 * Рутина + задача + НАСТОЯЩЕЕ предложение: ручной прогон, модель зовёт `orbis_propose`,
 * прогон закрывается `finished` с pending в треде рутины. id прогона детерминирован
 * (рутина + бакет ручного запуска + попытка), поэтому сценарий модели можно написать
 * до вызова.
 */
async function proposed(title: string): Promise<Proposed> {
  const routineId = await seedRoutine(owner, { title: `Рутина: ${title}` });
  const taskId = await seedTask(title);
  const runId = routineRunId(routineId, MANUAL_BUCKET, 1);
  const provider = new ScriptedProvider([toolUse([proposeCall(runId, taskId)])]);
  const started = await callerWith(provider).routine.runNow({ routineId });
  expect(started.runId).toBe(runId);
  const aspect = await waitClosed(runId);
  expect(aspect.outcome).toBe('finished');
  const pendingId = aspect.proposal?.pending_id;
  if (pendingId === undefined) throw new Error('прогон закрыт без предложения');
  return { routineId, taskId, runId, pendingId };
}

/** Причина отказа pending'а из ленты (append-only сообщение confirmation_rejected). */
async function rejectReason(pendingId: string): Promise<string | undefined> {
  const probe = JSON.stringify({ type: 'confirmation_rejected', rejects: pendingId });
  const rows = await withIdentity(db, owner, (tx) =>
    tx.execute(sql`SELECT metadata FROM chat_messages WHERE metadata @> ${probe}::jsonb LIMIT 1`),
  );
  const row = (rows as unknown as Array<Record<string, unknown>>)[0];
  return row === undefined ? undefined : ((row.metadata as { reason?: string }).reason ?? 'owner');
}

function deps(provider: LLMProvider = new ScriptedProvider([])): RoutineDeps {
  return { db, provider, model: MODEL, clock: () => T0 };
}

/** Архивирован ли прогон — маркер отката рутинного прогона (rollback.ts). */
async function isArchived(id: string): Promise<boolean> {
  const rows = await withIdentity(db, owner, (tx) =>
    tx.select({ archived: entities.archived }).from(entities).where(eq(entities.id, id)),
  );
  const row = rows[0];
  if (row === undefined) throw new Error(`сущность ${id} не найдена`);
  return row.archived;
}

interface PlannedProposed extends Proposed {
  bucket: string;
  routineTitle: string;
}

let plannedSeq = 0;

/**
 * То же, что `proposed`, но ПЛАНОВЫМ прогоном: слот заводится `startBucketRun` (как тиком
 * планировщика), модель гонится раннером в этом же тесте. Нужен там, где после отката
 * проверяется судьба самого СЛОТА (ретрая нет), — у ручного прогона слота нет.
 */
async function plannedProposed(title: string, routineId?: string): Promise<PlannedProposed> {
  const routineTitle = `Рутина: ${title}`;
  const rid = routineId ?? (await seedRoutine(owner, { title: routineTitle }));
  const taskId = await seedTask(title);
  plannedSeq += 1;
  const bucket = `2026-08-${String((plannedSeq % 28) + 1).padStart(2, '0')}T07:00`;
  const started = await startBucketRun(deps(), {
    ownerId: owner,
    routine: { id: rid, title: routineTitle },
    bucket,
  });
  if (!started.started) throw new Error(`слот не запущен: ${started.reason}`);
  const runId = started.runId;
  const routine = await withIdentity(db, owner, (tx) => routineById(tx, rid));
  if (routine === null) throw new Error('рутина не найдена');
  const provider = new ScriptedProvider([toolUse([proposeCall(runId, taskId)])]);
  const end = await runRoutineRun(deps(provider), { ownerId: owner, routine, runId, bucket });
  expect(end).toEqual({ outcome: 'finished' });
  const aspect = await runAspect(runId);
  const pendingId = aspect.proposal?.pending_id;
  if (pendingId === undefined) throw new Error('прогон закрыт без предложения');
  return { routineId: rid, taskId, runId, pendingId, bucket, routineTitle };
}

// ---------------------------------------------------------------------------
// runNow (V1.3, приёмка 10)
// ---------------------------------------------------------------------------

describe('routine.runNow', () => {
  test('создаёт ручной прогон и отвечает сразу; второй вызов при идущем прогоне → CONFLICT; раннер закрывает прогон сам', async () => {
    const routineId = await seedRoutine(owner, { title: 'Рутина: ручной запуск' });
    const taskId = await seedTask('Разобрать инбокс');
    const runId = routineRunId(routineId, MANUAL_BUCKET, 1);
    let release = (): void => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const provider = new GatedProvider(
      new ScriptedProvider([toolUse([proposeCall(runId, taskId)])]),
      gate,
    );
    const c = callerWith(provider);

    const started = await c.routine.runNow({ routineId });
    expect(started).toEqual({ runId });

    // Ответ пришёл ДО модели: прогон уже в графе и ещё идёт
    const running = await runAspect(runId);
    expect(running.outcome).toBe('running');
    expect(running.bucket).toBe(MANUAL_BUCKET);

    const conflict = await trpcError(c.routine.runNow({ routineId }));
    expect(conflict.code).toBe('CONFLICT');
    expect(conflict.message).toContain('прогон уже идёт');

    release();
    const closed = await waitClosed(runId);
    expect(closed.outcome).toBe('finished');
    expect(closed.proposal?.status).toBe('pending');
  });

  test('несуществующая рутина → NOT_FOUND', async () => {
    const e = await trpcError(caller().routine.runNow({ routineId: newId() }));
    expect(e.code).toBe('NOT_FOUND');
  });

  test('остановка процесса во время ручного прогона: shutdown() реестра даёт рубильник → прогон failed «остановлен при выключении процесса»; shutdown ждёт закрытия (C2-1/E2-5)', async () => {
    const routineId = await seedRoutine(owner, { title: 'Рутина: деплой посреди прогона' });
    const runId = routineRunId(routineId, MANUAL_BUCKET, 1);
    // Провайдер «думает», пока тест не отпустит: shutdown застаёт прогон посреди шага, и
    // рубильник срабатывает на следующей проверке между шагами (как у планировщика, Р-12)
    let release = (): void => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let calls = 0;
    const provider: LLMProvider = {
      modelId: MODEL,
      async chat() {
        calls += 1;
        await gate;
        return toolUse([{ name: 'entity_query', input: { query: 'aspect=orbis/task' } }]);
      },
    };
    // Свой реестр (не процессный): его остановка не должна задеть соседние тесты
    const registry = makeRunRegistry();
    const c = callerWith(provider, { manualRuns: registry });

    expect(await c.routine.runNow({ routineId })).toEqual({ runId });
    expect((await runAspect(runId)).outcome).toBe('running');
    // Дожидаемся, пока раннер дойдёт до модели: рубильник должен застать прогон ПОСРЕДИ шага
    // (до первого шага он закрылся бы тем же исходом, но не проверил бы ожидание shutdown)
    const until = Date.now() + 3_000;
    while (calls === 0) {
      if (Date.now() > until) throw new Error('раннер не дошёл до модели');
      await Bun.sleep(10);
    }

    let stopped = false;
    const stopping = registry.shutdown().then(() => {
      stopped = true;
    });
    // shutdown не завершается, пока прогон держит шаг
    await Bun.sleep(40);
    expect(stopped).toBe(false);
    release();
    await stopping;

    const closed = await runAspect(runId);
    expect(closed.outcome).toBe('failed');
    expect(closed.fail_note).toBe('прогон остановлен при выключении процесса');
    // После рубильника второго шага не было
    expect(calls).toBe(1);
    // Рутина НЕ на паузе: ручной прогон в стоп-кране не участвует
    expect((await aspectsOf(owner, routineId))['orbis/routine']?.stage).toBe('active');
  });
});

// ---------------------------------------------------------------------------
// answerCheckpoint (V1.9, приёмка 10)
// ---------------------------------------------------------------------------

describe('routine.answerCheckpoint', () => {
  test('вопрос → ответ: outcome answered с reply; действие владельца source ui и с run_id; откат прогона не снимает ответ и не считает его конфликтом (инвариант 7)', async () => {
    // Вопрос задаёт НАСТОЯЩИЙ прогон: откат читает журнал, а сид фикстурой идёт мимо
    // синка (без audit-сообщений откатывать было бы нечего, и проверка стала бы пустой)
    const routineId = await seedRoutine(owner, { title: 'Рутина: вопрос' });
    const runId = routineRunId(routineId, MANUAL_BUCKET, 1);
    const provider = new ScriptedProvider([
      toolUse([
        {
          name: 'orbis_checkpoint',
          input: { run_id: runId, question: 'Перенести встречу на завтра?' },
        },
      ]),
    ]);
    await callerWith(provider).routine.runNow({ routineId });
    expect((await waitClosed(runId)).outcome).toBe('checkpoint');

    const answered = await callerLater().routine.answerCheckpoint({
      runId,
      answer: 'Да, перенеси на 10:00',
    });
    expect(answered).toEqual({ runId });

    const aspect = await runAspect(runId);
    expect(aspect.outcome).toBe('answered');
    expect(aspect.reply?.text).toBe('Да, перенеси на 10:00');

    const answerActions = (await actionsOf(owner)).filter(
      (a) => a.run_id === runId && a.source === 'ui',
    );
    expect(answerActions).toHaveLength(1);

    // Повторный ответ отвечать уже не на что
    const conflict = await trpcError(
      callerLater().routine.answerCheckpoint({ runId, answer: 'ещё раз' }),
    );
    expect(conflict.code).toBe('CONFLICT');

    // Откат рутинного прогона инвертирует только РАБОТУ прогона (source routine); ответ
    // владельца — решение о прогоне, а не работа в графе: он не снимается и конфликтом не
    // считается (rollback.ts). Маркер отката — архив прогона.
    const rolled = await rollbackRun(db, { actorUserId: owner, runId });
    expect(rolled.ok).toBe(true);
    if (!rolled.ok) throw new Error('ожидался успешный откат');
    expect(rolled.undone).toEqual([]);
    expect((await runAspect(runId)).reply?.text).toBe('Да, перенеси на 10:00');
    expect((await runAspect(runId)).outcome).toBe('answered');
    expect(await isArchived(runId)).toBe(true);
  });

  test('прогон не найден (и тикетный прогон тоже) → NOT_FOUND', async () => {
    const e = await trpcError(caller().routine.answerCheckpoint({ runId: newId(), answer: 'да' }));
    expect(e.code).toBe('NOT_FOUND');
  });
});

// ---------------------------------------------------------------------------
// proposal + decideProposal (V1.6, V1.7; приёмка 2, 4, 5)
// ---------------------------------------------------------------------------

describe('routine.proposal / decideProposal', () => {
  test('предложение отдаётся операциями с заголовком сущности и «было → станет»; approve применяет батч и ставит статус approved; повтор → already', async () => {
    const { routineId, taskId, runId, pendingId } = await proposed('Позвонить в банк');

    const view = await caller().routine.proposal({ runId });
    if (view === null) throw new Error('предложение не найдено');
    expect(view.pendingId).toBe(pendingId);
    expect(view.runId).toBe(runId);
    expect(view.routineId).toBe(routineId);
    expect(view.status).toBe('pending');
    expect(view.explanation).toBe(EXPLANATION);
    expect(view.runArchived).toBe(false);
    expect(view.operations).toHaveLength(1);
    expect(view.operations[0]).toMatchObject({
      index: 0,
      tool: 'entity_update',
      entity: { id: taskId, title: 'Позвонить в банк' },
      aspect: 'orbis/task',
      field: 'status',
      before: 'inbox',
      after: 'planned',
    });
    expect(typeof view.operations[0]?.summary).toBe('string');

    const applied = await caller().routine.decideProposal({ runId, decision: 'approve' });
    expect(applied.status).toBe('applied');
    if (applied.status !== 'applied') throw new Error('не applied');
    expect(typeof applied.actionId).toBe('string');
    expect(await taskStatus(taskId)).toBe('planned');

    const aspect = await runAspect(runId);
    expect(aspect.proposal?.status).toBe('approved');
    expect(typeof aspect.proposal?.decided_at).toBe('string');
    expect((await caller().routine.proposal({ runId }))?.status).toBe('approved');

    const again = await caller().routine.decideProposal({ runId, decision: 'approve' });
    expect(again).toEqual({ status: 'already', proposalStatus: 'approved' });
  });

  test('approve при устаревшем предусловии → stale с расхождениями, ничего не применено, pending отклонён причиной stale, расхождения записаны на прогон (приёмка 4)', async () => {
    const { taskId, runId, pendingId } = await proposed('Отдать в ремонт');
    await ownerSets(taskId, 'done'); // владелец успел раньше

    const decided = await caller().routine.decideProposal({ runId, decision: 'approve' });
    expect(decided.status).toBe('stale');
    if (decided.status !== 'stale') throw new Error('не stale');
    expect(decided.mismatches).toEqual([
      { aspect: 'orbis/task', field: 'status', expected: ['inbox'], actual: 'done' },
    ]);

    // Всё или ничего: правка предложения не применена
    expect(await taskStatus(taskId)).toBe('done');
    expect(await rejectReason(pendingId)).toBe('stale');

    const aspect = await runAspect(runId);
    expect(aspect.proposal?.status).toBe('stale');
    expect(aspect.proposal?.mismatches?.[0]?.aspect).toBe('orbis/task');
    expect(aspect.proposal?.mismatches?.[0]?.field).toBe('status');
    expect(aspect.proposal?.mismatches?.[0]?.note).toContain('ожидали');
    expect(aspect.proposal?.mismatches?.[0]?.note).toContain('done');

    const view = await caller().routine.proposal({ runId });
    expect(view?.status).toBe('stale');
    expect(view?.mismatches?.[0]?.field).toBe('status');
  });

  test('предложение с правкой ТЕЛА, цель менялась после составления → approve даёт stale с расхождением тела (не голую STALE_VERSION), pending отклонён причиной stale, нота на прогоне (A-2/B2-1)', async () => {
    const routineId = await seedRoutine(owner, { title: 'Рутина: правка тела' });
    const taskId = await seedTask('Переписать описание');
    const runId = routineRunId(routineId, MANUAL_BUCKET, 1);
    const provider = new ScriptedProvider([
      toolUse([
        {
          name: 'orbis_propose',
          input: {
            run_id: runId,
            explanation: EXPLANATION,
            operations: [
              { tool: 'entity_update', input: { id: taskId, body: 'Описание от рутины' } },
            ],
          },
        },
      ]),
    ]);
    await callerWith(provider).routine.runNow({ routineId });
    const closed = await waitClosed(runId);
    expect(closed.outcome).toBe('finished');
    const pendingId = closed.proposal?.pending_id;
    if (pendingId === undefined) throw new Error('прогон закрыт без предложения');

    // Владелец тронул НЕ тело, а статус — updated_at бампит любая правка сущности
    await ownerSets(taskId, 'planned');

    const decided = await callerLater().routine.decideProposal({ runId, decision: 'approve' });
    expect(decided.status).toBe('stale');
    if (decided.status !== 'stale') throw new Error('не stale');
    expect(decided.mismatches).toHaveLength(1);
    expect(decided.mismatches[0]).toMatchObject({ aspect: '', field: 'body' });
    expect(typeof decided.mismatches[0]?.actual).toBe('string');

    // Ничего не применено, карточка погашена причиной stale, нота — словами
    const body = await withIdentity(db, owner, (tx) =>
      tx.execute(sql`SELECT body FROM entities WHERE id = ${taskId}::uuid`),
    );
    expect((body as unknown as Array<{ body: string }>)[0]?.body).not.toBe('Описание от рутины');
    expect(await rejectReason(pendingId)).toBe('stale');
    const aspect = await runAspect(runId);
    expect(aspect.proposal?.status).toBe('stale');
    expect(aspect.proposal?.mismatches).toEqual([
      { aspect: '', field: 'body', note: 'тело изменено после составления предложения' },
    ]);
    // Повторное «Принять» — уже решено, а не вторая ошибка
    expect(await caller().routine.decideProposal({ runId, decision: 'approve' })).toEqual({
      status: 'already',
      proposalStatus: 'stale',
    });
  });

  test('reject закрывает предложение: статус rejected, граф не тронут (приёмка 5)', async () => {
    const { taskId, runId, pendingId } = await proposed('Оплатить счёт');

    const decided = await caller().routine.decideProposal({ runId, decision: 'reject' });
    expect(decided).toEqual({ status: 'rejected' });
    expect(await taskStatus(taskId)).toBe('inbox');
    expect(await rejectReason(pendingId)).toBe('owner');
    expect((await runAspect(runId)).proposal?.status).toBe('rejected');
  });

  test('предложение, погашенное новым прогоном, решению не поддаётся → already со статусом superseded', async () => {
    const { routineId, taskId, runId } = await proposed('Записаться к врачу');
    await supersedeOpen(deps(), { ownerId: owner, routineId, exceptRunId: newId() });
    expect((await runAspect(runId)).proposal?.status).toBe('superseded');

    expect(await caller().routine.decideProposal({ runId, decision: 'approve' })).toEqual({
      status: 'already',
      proposalStatus: 'superseded',
    });
    expect(await caller().routine.decideProposal({ runId, decision: 'reject' })).toEqual({
      status: 'already',
      proposalStatus: 'superseded',
    });
    expect(await taskStatus(taskId)).toBe('inbox');
  });

  test('прогон без предложения → null', async () => {
    const routineId = await seedRoutine(owner, { title: 'Рутина: без предложения' });
    const { runId } = await seedRoutineRun(owner, {
      routineId,
      bucket: '2026-08-14T07:00',
      run: { outcome: 'finished', finished_at: iso(T0), report: 'нечего предлагать' },
    });
    expect(await caller().routine.proposal({ runId })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Откат рутинного прогона (приёмка 3, 11; инвариант 9)
// ---------------------------------------------------------------------------

describe('откат рутинного прогона: decideProposal(approve) → rollbackRun / undoLast', () => {
  test('approve → rollbackRun ok: план откачен, прогон архивирован, бухгалтерия (статус предложения) не тронута; повтор идемпотентен; слот отработан — startBucketRun → done', async () => {
    const { routineId, routineTitle, taskId, runId, bucket } =
      await plannedProposed('Разобрать почту');

    const applied = await callerLater().routine.decideProposal({ runId, decision: 'approve' });
    expect(applied.status).toBe('applied');
    if (applied.status !== 'applied') throw new Error('не applied');
    expect(await taskStatus(taskId)).toBe('planned');

    const rolled = await rollbackRun(db, { actorUserId: owner, runId });
    expect(rolled.ok).toBe(true);
    if (!rolled.ok) throw new Error(`ожидался успешный откат: ${JSON.stringify(rolled)}`);
    // Инвертирована ТОЛЬКО работа прогона — принятое предложение (один batch-action)
    expect(rolled.undone).toEqual([applied.actionId]);
    expect(rolled.note).toBe(ROUTINE_ROLLBACK_NOTE);
    expect(await taskStatus(taskId)).toBe('inbox');

    // Бухгалтерия прогона на месте: исход, судьба предложения, связь с рутиной
    const aspect = await runAspect(runId);
    expect(aspect.outcome).toBe('finished');
    expect(aspect.proposal?.status).toBe('approved');
    // Маркер отката — архив (RunFeed показывает «в архиве»); карточка предложения при этом
    // остаётся читаемой и знает про архив (ProposalCard: «Принято, затем откачено»)
    expect(await isArchived(runId)).toBe(true);
    const view = await caller().routine.proposal({ runId });
    expect(view?.status).toBe('approved');
    expect(view?.runArchived).toBe(true);

    // Повторное нажатие безопасно: откатывать уже нечего, состояние то же
    const again = await rollbackRun(db, { actorUserId: owner, runId });
    expect(again).toEqual({ ok: true, undone: [], note: ROUTINE_ROLLBACK_NOTE });
    expect(await taskStatus(taskId)).toBe('inbox');

    // Слот отработан: архивный терминальный прогон занимает его — ретрая нет
    const slot = await startBucketRun(deps(), {
      ownerId: owner,
      routine: { id: routineId, title: routineTitle },
      bucket,
    });
    expect(slot).toEqual({ started: false, reason: 'done' });
  });

  test('сегодняшний прогон создан (связь parent с рутиной, гашение) → откат вчерашнего всё ещё ok', async () => {
    const yesterday = await plannedProposed('Позвонить маме');
    const applied = await callerLater().routine.decideProposal({
      runId: yesterday.runId,
      decision: 'approve',
    });
    expect(applied.status).toBe('applied');

    // Сегодняшний прогон той же рутины: relation parent трогает рутину, гашение —
    // прошлый прогон; ни то, ни другое — не сущности работы вчерашнего прогона
    const today = await plannedProposed('Купить хлеб', yesterday.routineId);
    expect((await runAspect(today.runId)).proposal?.status).toBe('pending');

    const rolled = await rollbackRun(db, { actorUserId: owner, runId: yesterday.runId });
    expect(rolled.ok).toBe(true);
    expect(await taskStatus(yesterday.taskId)).toBe('inbox');
    expect(await isArchived(yesterday.runId)).toBe(true);
    // Сегодняшний прогон и его предложение не задеты
    expect(await isArchived(today.runId)).toBe(false);
    expect((await runAspect(today.runId)).proposal?.status).toBe('pending');
    expect(await taskStatus(today.taskId)).toBe('inbox');
  });

  test('владелец тронул цель ПОСЛЕ принятия → конфликт по этой сущности, ничего не откачено, прогон не архивирован (инвариант 7)', async () => {
    const { taskId, runId } = await proposed('Записаться в бассейн');
    const applied = await callerLater().routine.decideProposal({ runId, decision: 'approve' });
    expect(applied.status).toBe('applied');
    // Правка ВЛАДЕЛЬЦА через роутер — с журналом (§7.8): откат читает конфликты из него,
    // а `ownerSets` (execute без синка) правит только состояние
    await callerLater().entity.update({
      id: taskId,
      aspects: { 'orbis/task': { status: 'done' } },
    });

    const rolled = await rollbackRun(db, { actorUserId: owner, runId });
    expect(rolled.ok).toBe(false);
    if (rolled.ok) throw new Error('ожидался конфликт');
    expect(rolled.reason).toBe('conflict');
    if (rolled.reason !== 'conflict') throw new Error('ожидался reason=conflict');
    expect(rolled.conflicts.map((c) => c.entityId)).toEqual([taskId]);
    expect(await taskStatus(taskId)).toBe('done');
    expect(await isArchived(runId)).toBe(false);
  });

  test('«отмени последнее» после approve снимает ПЛАН (batch предложения), а не пометку статуса на прогоне (приёмка 3)', async () => {
    const { taskId, runId } = await proposed('Отнести обувь в ремонт');
    const applied = await callerLater().routine.decideProposal({ runId, decision: 'approve' });
    expect(applied.status).toBe('applied');
    if (applied.status !== 'applied') throw new Error('не applied');

    const undone = await undoLast(db, { actorUserId: owner });
    expect(undone.ok).toBe(true);
    expect(await taskStatus(taskId)).toBe('inbox');
    // Статус предложения — бухгалтерия прогона (source system): «отмени последнее» её не видит
    expect((await runAspect(runId)).proposal?.status).toBe('approved');
    // Отменён именно batch предложения — откат прогона после этого пропускает его
    const rolled = await rollbackRun(db, { actorUserId: owner, runId });
    expect(rolled.ok).toBe(true);
    if (!rolled.ok) throw new Error('ожидался успешный откат');
    expect(rolled.undone).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// overview (V1.14)
// ---------------------------------------------------------------------------

describe('routine.overview', () => {
  test('следующее срабатывание — завтра 07:00 мск (сегодняшнее уже прошло); последний прогон, счётчик ждущих ответа и признак открытого предложения', async () => {
    const routineId = await seedRoutine(owner, { title: 'Рутина: обзор' });
    await seedRoutineRun(owner, {
      routineId,
      bucket: '2026-08-15T07:00',
      startedAt: new Date(T0.getTime() - 2 * 24 * 3600_000),
      run: {
        outcome: 'checkpoint',
        finished_at: iso(T0),
        checkpoint: { question: 'Что с этим делать?', asked_at: iso(T0) },
      },
    });
    const last = await seedRoutineRun(owner, {
      routineId,
      bucket: '2026-08-16T07:00',
      startedAt: new Date(T0.getTime() - 24 * 3600_000),
      run: { outcome: 'finished', finished_at: iso(T0), report: 'всё спокойно' },
    });

    const overview = await caller().routine.overview({ routineId });
    expect(overview.nextBucketAt).toBe(NEXT_AFTER_T0);
    expect(overview.lastRun?.id).toBe(last.runId);
    expect(overview.lastRun?.outcome).toBe('finished');
    expect(overview.waiting).toBe(1);
    expect(overview.openProposal).toBe(false);
  });

  test('открытое предложение видно признаком; рутина на паузе следующего срабатывания не имеет', async () => {
    const { routineId } = await proposed('Продлить страховку');
    expect((await caller().routine.overview({ routineId })).openProposal).toBe(true);

    await execute(db, {
      actorUserId: owner,
      actorKind: 'owner',
      source: 'ui',
      operations: [
        {
          tool: 'entity_update',
          input: { id: routineId, aspects: { 'orbis/routine': { stage: 'paused' } } },
        },
      ],
    });
    expect((await caller().routine.overview({ routineId })).nextBucketAt).toBeNull();
  });

  test('несуществующая рутина → NOT_FOUND', async () => {
    const e = await trpcError(caller().routine.overview({ routineId: newId() }));
    expect(e.code).toBe('NOT_FOUND');
  });
});
