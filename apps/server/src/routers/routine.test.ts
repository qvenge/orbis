// apps/server/src/routers/routine.test.ts
// Роутер routine (§9.1, V1.3/V1.6/V1.9): владельческая половина рутины — «прогнать
// сейчас», ответ на вопрос прогона, чтение предложения и решение по нему, обзор.
// Против живой БД, caller как в бою (createCallerFactory с инжектированным ai —
// провайдер/часы, лекало send-message.test.ts), предложение рождается НАСТОЯЩИМ
// прогоном через `runNow`: собранный руками pending проверял бы фикстуру, а не путь.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { manualBucket, newId, pendingMessageId, routineRunId } from '@orbis/shared';
import { parseBody, readBodyDoc, serializeBody } from '@orbis/shared/doc';
import { type DiffUnit, flattenBlocks } from '@orbis/shared/doc/diff';
import { TRPCError } from '@trpc/server';
import { eq, sql } from 'drizzle-orm';
import { appDb, freshUserId, requireEnv, truncateAll } from '../../test/helpers';
import { routineById, runsOfParent } from '../agent-loop/queries';
import { ROUTINE_ROLLBACK_NOTE, rollbackRun } from '../agent-loop/rollback';
import { ensureEntityThread } from '../chat/threads';
import { chatMessages, entities } from '../db/schema';
import { withIdentity } from '../db/with-identity';
import { ExecError } from '../errors';
import { execute } from '../executor/executor';
import { undoLast } from '../executor/undo';
import { ScriptedProvider } from '../llm/scripted';
import type { LLMProvider, LLMRequest, LLMResponse } from '../llm/types';
import { createPending } from '../policy/pending';
import { appRouter } from '../router';
import {
  editsNoun,
  PROPOSAL_DIFF_MAX_BODY_BYTES,
  PROPOSAL_DIFF_MAX_SOURCE_LINES,
} from '../routines/constants';
import { editsHash, editsSchema } from '../routines/edits';
import type { ProposalOperationView, RoutineDeps } from '../routines/lifecycle';
import { answerRunQuestion, startBucketRun, supersedeOpen } from '../routines/lifecycle';
import { runRoutineRun } from '../routines/runner';
import { makeRunRegistry } from '../routines/shutdown';
import { agentLoopHelpers, iso, T0 } from '../test/agent-loop-helpers';
import { dispatchTool } from '../tools/dispatch';
import { type Context, createCallerFactory } from '../trpc';

requireEnv();

const { db, client } = appDb();
const owner = freshUserId();
const { actionsOf, aspectsOf, routineCtx, seedEntity, seedRoutine, seedRoutineRun } =
  agentLoopHelpers(db);
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
    mismatches?: Array<{ property: string; note: string }>;
    edited_from?: string;
  };
}

async function runAspect(runId: string): Promise<RunAspect> {
  return (await aspectsOf(owner, runId))['orbis/agent-run'] as unknown as RunAspect;
}

/** Сообщение ленты по id — им экран рутины и показывает предложение владельцу. */
async function messageById(id: string) {
  const rows = await withIdentity(db, owner, (tx) =>
    tx.select().from(chatMessages).where(eq(chatMessages.id, id)),
  );
  return rows[0];
}

/** Карточка предложения из метаданных сообщения — вторая копия сводки, рядом со строкой ленты. */
function cardOf(msg: { metadata?: unknown } | undefined): { summary?: string } | undefined {
  const cards = (msg?.metadata as { cards?: { kind: string; summary?: string }[] } | undefined)
    ?.cards;
  return cards?.find((c) => c.kind === 'proposal_card');
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

/**
 * Перевести указатель прогона на ДРУГОЕ предложение. Пока лестницы правки нет, это
 * единственный способ получить состояние «адресованное предложение прогону больше не
 * принадлежит» — то самое, которое лестница будет создавать штатно.
 */
async function pointRunAt(runId: string, pendingId: string, status: string): Promise<void> {
  const r = await execute(db, {
    actorUserId: owner,
    actorKind: 'owner',
    source: 'system',
    // Как на боевом пути (lifecycle.patchAspect): указатель предложения — служебное
    // свойство прогона (§А2-5), и пишет его глагол исполнителя.
    mechanism: 'verb',
    runId,
    operations: [
      {
        tool: 'entity_update',
        input: {
          id: runId,
          aspects: { 'orbis/agent-run': { proposal: { pending_id: pendingId, status } } },
        },
      },
    ],
  });
  if (!r.ok) throw new Error(`pointRunAt: ${r.error.code} ${r.error.message}`);
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

/**
 * То же, что `proposed`, но предложение правит и ТЕЛО (Ш1.11): без него правка тела
 * адресовать нечего — `edits.body` меняет строку, которая в предложении уже есть.
 */
async function proposedWithBody(title: string): Promise<Proposed> {
  const routineId = await seedRoutine(owner, { title: `Рутина: ${title}` });
  const taskId = await seedTask(title);
  const runId = routineRunId(routineId, MANUAL_BUCKET, 1);
  const provider = new ScriptedProvider([
    toolUse([
      {
        name: 'orbis_propose',
        input: {
          run_id: runId,
          explanation: EXPLANATION,
          operations: [
            {
              tool: 'entity_update',
              input: {
                id: taskId,
                body: 'Черновик рутины',
                aspects: { 'orbis/task': { status: 'planned' } },
              },
            },
          ],
        },
      },
    ]),
  ]);
  await callerWith(provider).routine.runNow({ routineId });
  const aspect = await waitClosed(runId);
  expect(aspect.outcome).toBe('finished');
  const pendingId = aspect.proposal?.pending_id;
  if (pendingId === undefined) throw new Error('прогон закрыт без предложения');
  return { routineId, taskId, runId, pendingId };
}

/**
 * Тело, каким его присылает слой предложения: настоящий разбор markdown (блок кода и
 * ссылка с подписью — то, на чём ломались бы потери сериализации) плюс блочные id, каких
 * в схеме документа нет. В БД обязан лечь ВХОД: `nodeFromJSON().toJSON()` id потерял бы.
 */
function ownerDoc(): { v: number; doc: { type: 'doc'; content: Record<string, unknown>[] } } {
  const parsed = parseBody(
    'Правка владельца: [подпись](https://example.com)\n\n```ts\nconst a = 1;\n```',
  );
  const content = (parsed.doc.content ?? []).map((node, i) => ({
    ...(node as Record<string, unknown>),
    attrs: { ...((node as { attrs?: Record<string, unknown> }).attrs ?? {}), id: `blk-${i}` },
  }));
  return { v: parsed.v, doc: { type: 'doc', content } };
}

/**
 * Предложение, правящее ТЕЛО СУЩЕСТВУЮЩЕГО текста: у записи уже есть тело, рутина предлагает
 * другое. Отличие от `proposedWithBody` — там тело правится у пустой записи, а диффу нужна
 * сторона «было».
 */
async function proposedBodyChange(
  title: string,
  current: string,
  proposed: string,
): Promise<Proposed> {
  const routineId = await seedRoutine(owner, { title: `Рутина: ${title}` });
  const created = await seedEntity(owner, {
    title,
    tags: [],
    body: current,
    aspects: { 'orbis/task': { status: 'inbox' } },
  });
  const taskId = created.id;
  const runId = routineRunId(routineId, MANUAL_BUCKET, 1);
  const provider = new ScriptedProvider([
    toolUse([
      {
        name: 'orbis_propose',
        input: {
          run_id: runId,
          explanation: EXPLANATION,
          operations: [{ tool: 'entity_update', input: { id: taskId, body: proposed } }],
        },
      },
    ]),
  ]);
  await callerWith(provider).routine.runNow({ routineId });
  const aspect = await waitClosed(runId);
  expect(aspect.outcome).toBe('finished');
  const pendingId = aspect.proposal?.pending_id;
  if (pendingId === undefined) throw new Error('прогон закрыт без предложения');
  return { routineId, taskId, runId, pendingId };
}

/** Строка тела в показе предложения — та единственная, ради которой считается дифф. */
async function bodyRowOf(runId: string): Promise<ProposalOperationView> {
  const view = await caller().routine.proposal({ runId });
  if (view === null) throw new Error('предложение не найдено');
  const row = view.operations.find((o) => o.field === 'body');
  if (row === undefined) throw new Error('в предложении нет строки тела');
  return row;
}

/**
 * After-сторона диффа: тексты единиц, кроме удалённых. `after` заполнен у всех трёх видов
 * (контракт DiffUnit) — его отсутствие это поломка, а не повод на неё зажмуриться.
 */
function afterTexts(units: DiffUnit[]): string[] {
  return units
    .filter((u) => u.kind !== 'removed')
    .map((u) => {
      if (u.after === undefined) throw new Error(`единица ${u.kind} без after`);
      return u.after;
    });
}

/** Тело в n непустых строк: абзацами, чтобы каждая строка была отдельным блоком. */
function manyLines(n: number): string {
  return Array.from({ length: n }, (_, i) => `Пункт ${i + 1}`).join('\n\n');
}

/** Тело сверх потолка БАЙТ, но в одну строку: срабатывает ровно байтовый сторож. */
function heavyBody(): string {
  const chunk = 'текст ';
  return chunk.repeat(Math.ceil(PROPOSAL_DIFF_MAX_BODY_BYTES / Buffer.byteLength(chunk)) + 1);
}

/** Тело записи документом — то, что реально легло в `body_doc`. */
async function bodyDocOf(id: string): Promise<unknown> {
  const rows = await withIdentity(db, owner, (tx) =>
    tx.execute(sql`SELECT body_doc FROM entities WHERE id = ${id}::uuid`),
  );
  return (rows as unknown as Array<{ body_doc: unknown }>)[0]?.body_doc;
}

/** Тело записи текстом — проекция документа, она же аварийный дубль (§2.1). */
async function bodyOf(id: string): Promise<string | undefined> {
  const rows = await withIdentity(db, owner, (tx) =>
    tx.execute(sql`SELECT body FROM entities WHERE id = ${id}::uuid`),
  );
  return (rows as unknown as Array<{ body: string }>)[0]?.body;
}

/** Сколько pending-предложений лежит в треде рутины (карточки, а не отказы). */
async function pendingCount(runId: string): Promise<number> {
  const probe = JSON.stringify({ pending: { run_id: runId } });
  const rows = await withIdentity(db, owner, (tx) =>
    tx.execute(sql`SELECT id FROM chat_messages WHERE metadata @> ${probe}::jsonb`),
  );
  return [...rows].length;
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

/**
 * Предложение отдельной рутины из ПРОИЗВОЛЬНЫХ операций — там, где записи заводятся
 * снаружи: одну запись трогают две рутины, а одно предложение накрывает две записи.
 * Рутина своя у каждого вызова: `supersedeOpen` гасит открытое предложение соседнего
 * прогона ТОЙ ЖЕ рутины, и общая рутина превратила бы второе предложение в `superseded`.
 */
async function proposedOps(
  title: string,
  operations: Array<{ tool: string; input: Record<string, unknown> }>,
): Promise<{ routineId: string; runId: string; pendingId: string }> {
  const routineId = await seedRoutine(owner, { title: `Рутина: ${title}` });
  const runId = routineRunId(routineId, MANUAL_BUCKET, 1);
  const provider = new ScriptedProvider([
    toolUse([
      { name: 'orbis_propose', input: { run_id: runId, explanation: EXPLANATION, operations } },
    ]),
  ]);
  await callerWith(provider).routine.runNow({ routineId });
  const aspect = await waitClosed(runId);
  expect(aspect.outcome).toBe('finished');
  const pendingId = aspect.proposal?.pending_id;
  if (pendingId === undefined) throw new Error('прогон закрыт без предложения');
  return { routineId, runId, pendingId };
}

/**
 * Чат-подтверждение (§7.10) с теми же операциями по той же записи. Отличается от
 * предложения рутины ровно источником (`chat` против `routine`) — и отсекается ровно им:
 * иначе экран записи показывал бы «по этой записи есть предложение рутины» там, где
 * владелец просто не дожал кнопку в чате.
 */
async function chatConfirmation(taskId: string): Promise<string> {
  const dedupeKey = `chat:${taskId}`;
  const created = await withIdentity(db, owner, (tx) =>
    createPending(tx, {
      actor: { userId: owner, kind: 'ai', source: 'chat' },
      tool: 'batch_execute',
      input: {
        batch_id: pendingMessageId(owner, dedupeKey),
        operations: [
          {
            tool: 'entity_update',
            input: { id: taskId, aspects: { 'orbis/task': { status: 'done' } } },
          },
        ],
      },
      level: 'explicit-confirmation',
      dedupeKey,
      clock: () => LATER,
    }),
  );
  return created.pendingId;
}

/**
 * Убрать прогон в архив ровно тем жестом, каким это делает откат (rollback.ts:433-442) —
 * и НЕ трогая само предложение: нужно состояние «предложение ещё pending, а прогона в
 * живых нет».
 */
async function archiveRun(runId: string): Promise<void> {
  const r = await execute(db, {
    actorUserId: owner,
    actorKind: 'owner',
    source: 'system',
    runId,
    operations: [{ tool: 'entity_update', input: { id: runId, archived: true } }],
  });
  if (!r.ok) throw new Error(`archiveRun: ${r.error.code} ${r.error.message}`);
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

    // Под уже дёрнутым рубильником runNow прогон не заводит — CONFLICT «сервер
    // останавливается», прогонов у рутины по-прежнему один (S-2)
    const refused = await trpcError(c.routine.runNow({ routineId }));
    expect(refused.code).toBe('CONFLICT');
    expect(refused.message).toContain('останавливается');
    const runs = await withIdentity(db, owner, (tx) => runsOfParent(tx, routineId));
    expect(runs.map((r) => r.id)).toEqual([runId]);
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

    const applied = await caller().routine.decideProposal({
      runId,
      pendingId,
      decision: 'approve',
    });
    expect(applied.status).toBe('applied');
    if (applied.status !== 'applied') throw new Error('не applied');
    expect(typeof applied.actionId).toBe('string');
    expect(await taskStatus(taskId)).toBe('planned');

    const aspect = await runAspect(runId);
    expect(aspect.proposal?.status).toBe('approved');
    expect(typeof aspect.proposal?.decided_at).toBe('string');
    expect((await caller().routine.proposal({ runId }))?.status).toBe('approved');

    const again = await caller().routine.decideProposal({ runId, pendingId, decision: 'approve' });
    expect(again).toEqual({ status: 'already', proposalStatus: 'approved' });
  });

  test('approve при устаревшем предусловии → stale с расхождениями, ничего не применено, pending отклонён причиной stale, расхождения записаны на прогон (приёмка 4)', async () => {
    const { taskId, runId, pendingId } = await proposed('Отдать в ремонт');
    await ownerSets(taskId, 'done'); // владелец успел раньше

    const decided = await caller().routine.decideProposal({
      runId,
      pendingId,
      decision: 'approve',
    });
    expect(decided.status).toBe('stale');
    if (decided.status !== 'stale') throw new Error('не stale');
    expect(decided.mismatches).toEqual([
      { property: 'orbis/task_status', expected: ['inbox'], actual: 'done' },
    ]);
    // Тело не трогали — флаг честно false (РП-10): «устарело» бывает двух видов, и экран
    // обязан различать их, а не печатать оба текста разом.
    expect(decided.bodyChanged).toBe(false);

    // Всё или ничего: правка предложения не применена
    expect(await taskStatus(taskId)).toBe('done');
    expect(await rejectReason(pendingId)).toBe('stale');

    const aspect = await runAspect(runId);
    expect(aspect.proposal?.status).toBe('stale');
    // Единица расхождения на прогоне — СВОЙСТВО (§А7-4), как и в самом предусловии (§А7-3).
    expect(aspect.proposal?.mismatches?.[0]).toMatchObject({ property: 'orbis/task_status' });
    expect(aspect.proposal?.mismatches?.[0]?.note).toContain('ожидали');
    expect(aspect.proposal?.mismatches?.[0]?.note).toContain('done');

    const view = await caller().routine.proposal({ runId });
    expect(view?.status).toBe('stale');
    expect(view?.mismatches?.[0]).toMatchObject({ property: 'orbis/task_status' });
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

    const decided = await callerLater().routine.decideProposal({
      runId,
      pendingId,
      decision: 'approve',
    });
    expect(decided.status).toBe('stale');
    if (decided.status !== 'stale') throw new Error('не stale');
    // РП-10: тело — ФЛАГ, а не пункт списка. Пунктов по свойствам здесь нет ни одного:
    // расхождение тела свойством не является, и подделывать его пунктом с пустым именем
    // аспекта больше нечем — форма `PreconditionMismatch` такого поля не имеет вовсе.
    expect(decided.bodyChanged).toBe(true);
    expect(decided.mismatches).toEqual([]);

    // Ничего не применено, карточка погашена причиной stale, нота — словами
    const body = await withIdentity(db, owner, (tx) =>
      tx.execute(sql`SELECT body FROM entities WHERE id = ${taskId}::uuid`),
    );
    expect((body as unknown as Array<{ body: string }>)[0]?.body).not.toBe('Описание от рутины');
    expect(await rejectReason(pendingId)).toBe('stale');
    const aspect = await runAspect(runId);
    expect(aspect.proposal?.status).toBe('stale');
    expect(aspect.proposal?.mismatches).toEqual([
      // У расхождения тела свойства в §А8 нет (тело — не свойство), поэтому нота несёт
      // заведомо неизвестный id той же формы, что и переходная карта: `orbis/<поле>`.
      { property: 'orbis/body', note: 'тело изменено после составления предложения' },
    ]);
    // Повторное «Принять» — уже решено, а не вторая ошибка
    expect(
      await caller().routine.decideProposal({ runId, pendingId, decision: 'approve' }),
    ).toEqual({
      status: 'already',
      proposalStatus: 'stale',
    });
  });

  test('reject закрывает предложение: статус rejected, граф не тронут (приёмка 5)', async () => {
    const { taskId, runId, pendingId } = await proposed('Оплатить счёт');

    const decided = await caller().routine.decideProposal({ runId, pendingId, decision: 'reject' });
    expect(decided).toEqual({ status: 'rejected' });
    expect(await taskStatus(taskId)).toBe('inbox');
    expect(await rejectReason(pendingId)).toBe('owner');
    expect((await runAspect(runId)).proposal?.status).toBe('rejected');
  });

  test('предложение, погашенное новым прогоном, решению не поддаётся → already со статусом superseded', async () => {
    const { routineId, taskId, runId, pendingId } = await proposed('Записаться к врачу');
    await supersedeOpen(deps(), { ownerId: owner, routineId, exceptRunId: newId() });
    expect((await runAspect(runId)).proposal?.status).toBe('superseded');

    expect(
      await caller().routine.decideProposal({ runId, pendingId, decision: 'approve' }),
    ).toEqual({
      status: 'already',
      proposalStatus: 'superseded',
    });
    expect(await caller().routine.decideProposal({ runId, pendingId, decision: 'reject' })).toEqual(
      {
        status: 'already',
        proposalStatus: 'superseded',
      },
    );
    expect(await taskStatus(taskId)).toBe('inbox');
  });

  test('решение по ЧУЖОМУ pendingId → replaced с живым предложением, граф не тронут («принимаю то, что вижу»)', async () => {
    const { taskId, runId, pendingId } = await proposed('Сдать анализы');

    const stranger = newId();
    expect(
      await caller().routine.decideProposal({ runId, pendingId: stranger, decision: 'approve' }),
    ).toEqual({
      status: 'replaced',
      livePendingId: pendingId,
      liveStatus: 'pending',
      // Про адресованное неизвестно ничего: отказа по нему в ленте нет
      reason: 'superseded',
    });
    // Ни исполнения, ни отказа: решение адресовано не тому, чем прогон живёт
    expect(await taskStatus(taskId)).toBe('inbox');
    expect((await runAspect(runId)).proposal?.status).toBe('pending');
    expect(await rejectReason(pendingId)).toBeUndefined();

    // «Отклонить» чужим адресом — тот же отказ, а не отказ живого предложения
    expect(
      await caller().routine.decideProposal({ runId, pendingId: stranger, decision: 'reject' }),
    ).toEqual({
      status: 'replaced',
      livePendingId: pendingId,
      liveStatus: 'pending',
      reason: 'superseded',
    });
    expect((await runAspect(runId)).proposal?.status).toBe('pending');

    // Живое предложение своим адресом решается как прежде
    expect(await caller().routine.decideProposal({ runId, pendingId, decision: 'reject' })).toEqual(
      { status: 'rejected' },
    );
  });

  test('чужой pendingId при УЖЕ РЕШЁННОМ живом предложении → replaced, а не чужая судьба под видом своей (сверка адреса ДО проверки статуса)', async () => {
    const { taskId, runId, pendingId } = await proposed('Продлить страховку');
    expect(await caller().routine.decideProposal({ runId, pendingId, decision: 'reject' })).toEqual(
      { status: 'rejected' },
    );
    expect((await runAspect(runId)).proposal?.status).toBe('rejected');

    /**
     * Порядок проверок в `decideProposal` — не косметика: сверка адреса стоит ДО проверки
     * статуса. Поменяй их местами — и владелец, ткнувший в чужую (или устаревшую) карточку,
     * получит `already: rejected`, то есть прочитает судьбу НЕ СВОЕГО предложения как
     * судьбу своего. Сверка целого объекта нарочно: перестановка обязана падать громко.
     */
    expect(
      await callerLater().routine.decideProposal({
        runId,
        pendingId: newId(),
        decision: 'approve',
      }),
    ).toEqual({
      status: 'replaced',
      livePendingId: pendingId,
      liveStatus: 'rejected',
      reason: 'superseded',
    });
    expect(await taskStatus(taskId)).toBe('inbox');
  });

  test('replaced: причина — из отказа АДРЕСОВАННОГО предложения, а не живого', async () => {
    const { runId, pendingId } = await proposed('Забрать посылку');
    expect(await caller().routine.decideProposal({ runId, pendingId, decision: 'reject' })).toEqual(
      { status: 'rejected' },
    );
    expect(await rejectReason(pendingId)).toBe('owner');

    const live = newId();
    await pointRunAt(runId, live, 'pending');

    expect(
      await callerLater().routine.decideProposal({ runId, pendingId, decision: 'approve' }),
    ).toEqual({
      status: 'replaced',
      livePendingId: live,
      liveStatus: 'pending',
      reason: 'owner',
    });
  });

  test('операции предложения читаются по pending_id: у прогона ДВА pending-сообщения — показывается то, на которое указывает прогон', async () => {
    const { routineId, taskId, runId, pendingId } = await proposed('Оплатить интернет');

    // Второе pending-сообщение того же прогона — ровно то, что породит правка владельца:
    // тот же run_id, свой payload, своя проза.
    const secondExplanation = 'Правленое предложение: закрываю задачу сразу.';
    const secondBatchId = `edit:${pendingId}:тест`;
    const second = await withIdentity(db, owner, async (tx) => {
      const threadId = await ensureEntityThread(tx, owner, routineId);
      return createPending(tx, {
        threadId,
        actor: { userId: owner, kind: 'ai', source: 'routine', runId },
        tool: 'batch_execute',
        input: {
          batch_id: pendingMessageId(owner, secondBatchId),
          operations: [
            {
              tool: 'entity_update',
              input: { id: taskId, aspects: { 'orbis/task': { status: 'done' } } },
            },
          ],
        },
        level: 'explicit-confirmation',
        dedupeKey: secondBatchId,
        clock: () => LATER,
        card: {
          kind: 'proposal_card',
          pendingId: pendingMessageId(owner, secondBatchId),
          runId,
          routineId,
          summary: '1 правка',
          explanation: secondExplanation,
        },
        content: 'Предложение рутины: 1 правка',
      });
    });
    expect(second.pendingId).not.toBe(pendingId);

    await pointRunAt(runId, second.pendingId, 'pending');

    const view = await caller().routine.proposal({ runId });
    if (view === null) throw new Error('предложение не найдено');
    expect(view.pendingId).toBe(second.pendingId);
    // Проза и операции — ТОГО ЖЕ сообщения, что и адрес: иначе владелец решает по одному
    // предложению, а видит операции другого
    expect(view.explanation).toBe(secondExplanation);
    expect(view.operations).toHaveLength(1);
    expect(view.operations[0]).toMatchObject({
      index: 0,
      tool: 'entity_update',
      entity: { id: taskId, title: 'Оплатить интернет' },
      aspect: 'orbis/task',
      field: 'status',
      after: 'done',
    });
  });

  // -------------------------------------------------------------------------
  // Правка предложения до принятия (Ш1.5, Ш1.6, Ш1.11): «принять список правок, а не
  // пересказ модели» доведено до конца — владелец правит значения и текст, и применяется
  // РОВНО то, что он видел. Исходное предложение при этом не переписывается (журнал
  // append-only): оно гаснет причиной `edited`, а рядом ложится новое, правленое.
  // -------------------------------------------------------------------------

  test('правка тела и поля + approve: в записи ровно присланный документ (блок кода, подпись ссылки, блочные id), правленое значение поля; исходное погашено edited; указатель на правленом; статус approved с edited_from; действие журнала — source routine, run_id и edited_from (приёмки 5, 6, 9)', async () => {
    const { taskId, runId, pendingId } = await proposedWithBody('Описать переезд');
    const doc = ownerDoc();
    const edits = {
      body: [{ index: 0, bodyDoc: doc }],
      fields: [{ index: 0, aspect: 'orbis/task', field: 'status', value: 'in_progress' }],
    };

    const applied = await callerLater().routine.decideProposal({
      runId,
      pendingId,
      decision: 'approve',
      edits,
    });
    expect(applied.status).toBe('applied');
    if (applied.status !== 'applied') throw new Error('не applied');
    // Экран исходной карточки обязан понять, что применено не ровно то, что он показывал
    expect(applied.editedFrom).toBe(pendingId);

    // Приёмка 6: применено то, что владелец видел, — его документ байт в байт (потери
    // сериализации Ш1.11 не воспроизводятся) и его значение поля
    expect(await bodyDocOf(taskId)).toEqual(doc);
    expect(await taskStatus(taskId)).toBe('in_progress');

    // Приёмка 9: исходное погашено ПРАВКОЙ, а не отказом владельца
    expect(await rejectReason(pendingId)).toBe('edited');

    const aspect = await runAspect(runId);
    const editedId = aspect.proposal?.pending_id;
    if (editedId === undefined) throw new Error('прогон без предложения');
    expect(editedId).not.toBe(pendingId);
    expect(aspect.proposal?.status).toBe('approved');
    expect(aspect.proposal?.edited_from).toBe(pendingId);
    // id правленого детерминирован содержимым правки: тот же тап — тот же pending
    expect(editedId).toBe(
      pendingMessageId(owner, `edit:${pendingId}:${editsHash(editsSchema.parse(edits))}`),
    );
    // Батч ключуется правленым предложением — по нему работают и «Отменить», и откат
    expect(applied.actionId).toBe(editedId);

    // В-1: журнал §7.8 знает и чья это работа, и что она — правка владельца
    const action = (await actionsOf(owner)).find((a) => a.id === editedId);
    expect(action?.source).toBe('routine');
    expect(action?.run_id).toBe(runId);
    expect(action?.edited_from).toBe(pendingId);
  });

  test('сводка предложения считает те же строки, что покажет proposalView — и у исходного, и у правленого (смоук 4.6.1)', async () => {
    /**
     * Страж против ДВУХ ЧИСЕЛ У ОДНОГО ПРЕДЛОЖЕНИЯ. Сводку («2 правки») пишет составление
     * внутри транзакции, до всякого показа, и считает её `countProposalRows` — своё правило,
     * повторяющее `updateRows`. Разъедься эти два правила, и об одном событии тред скажет
     * одно, а плашка на записи — другое: ровно это и нашёл живой смоук (4.6.1), когда сводка
     * считала ОПЕРАЦИИ, а оба экрана рисовали СТРОКИ.
     *
     * Сверяется не число с числом, а СТРОКА ЛЕНТЫ с длиной настоящего списка строк — то есть
     * ровно то, что владелец сравнил бы глазами, перейдя из треда на запись.
     *
     * `proposedWithBody` не случаен: это одна операция `entity_update`, дающая ДВЕ строки
     * (статус и тело). На однострочном предложении оба правила совпадают, и тест был бы зелен
     * при любом из них.
     */
    const { runId, pendingId } = await proposedWithBody('Свести числа');

    const view = await caller().routine.proposal({ runId });
    if (view === null) throw new Error('предложение не найдено');
    // Премиса: строк действительно больше, чем операций, — иначе сверка ниже ничего не ловит.
    expect(view.operations).toHaveLength(2);
    expect(new Set(view.operations.map((op) => op.index)).size).toBe(1);

    const rows = view.operations.length;
    const first = await messageById(pendingId);
    expect(first?.content).toBe(`Предложение рутины: ${rows} ${editsNoun(rows)}`);
    expect(cardOf(first)?.summary).toBe(`${rows} ${editsNoun(rows)}`);

    // Второй писатель сводки — лестница правки: у правленого предложения строка ленты обязана
    // выглядеть так же, как у того, что оно заменило, и считаться тем же правилом.
    const applied = await callerLater().routine.decideProposal({
      runId,
      pendingId,
      decision: 'approve',
      edits: {
        fields: [{ index: 0, aspect: 'orbis/task', field: 'status', value: 'in_progress' }],
      },
    });
    expect(applied.status).toBe('applied');

    const editedId = (await runAspect(runId)).proposal?.pending_id;
    if (editedId === undefined) throw new Error('прогон без предложения');
    const editedView = await caller().routine.proposal({ runId });
    if (editedView === null) throw new Error('правленое предложение не найдено');
    const editedRows = editedView.operations.length;
    expect(editedRows).toBe(rows);
    const second = await messageById(editedId);
    expect(second?.content).toBe(`Предложение рутины: ${editedRows} ${editsNoun(editedRows)}`);
    expect(cardOf(second)?.summary).toBe(`${editedRows} ${editsNoun(editedRows)}`);
  });

  test('replay двойного тапа: та же правка дважды → второе предложение не заводится, ответ applied идемпотентен с тем же actionId (приёмка 14)', async () => {
    const { taskId, runId, pendingId } = await proposed('Сдать отчёт');
    const edits = {
      fields: [{ index: 0, aspect: 'orbis/task', field: 'status', value: 'in_progress' }],
    };

    const first = await callerLater().routine.decideProposal({
      runId,
      pendingId,
      decision: 'approve',
      edits,
    });
    expect(first.status).toBe('applied');
    if (first.status !== 'applied') throw new Error('не applied');
    expect(await pendingCount(runId)).toBe(2); // исходное + правленое, и всё

    // Тот же запрос второй раз (кнопка нажата дважды, ретрай клиента): личность правки
    // та же → тот же pendingId → тот же батч. Второй план не применяется и не заводится.
    const again = await callerLater().routine.decideProposal({
      runId,
      pendingId,
      decision: 'approve',
      edits,
    });
    expect(again).toEqual({
      status: 'applied',
      actionId: first.actionId,
      editedFrom: pendingId,
    });
    expect(await pendingCount(runId)).toBe(2);
    expect(await taskStatus(taskId)).toBe('in_progress');
    // Один батч в журнале, а не два
    expect((await actionsOf(owner)).filter((a) => a.id === first.actionId)).toHaveLength(1);
  });

  test('пустые edits при совпавшем pendingId — путь ровно сегодняшний: правленого предложения нет, исходное принято как есть (приёмка 7)', async () => {
    const { taskId, runId, pendingId } = await proposed('Купить билеты');

    const applied = await callerLater().routine.decideProposal({
      runId,
      pendingId,
      decision: 'approve',
      edits: {},
    });
    expect(applied).toEqual({ status: 'applied', actionId: pendingId });
    expect(await pendingCount(runId)).toBe(1); // второго предложения нет
    expect(await taskStatus(taskId)).toBe('planned');
    expect(await rejectReason(pendingId)).toBeUndefined();
    const aspect = await runAspect(runId);
    expect(aspect.proposal?.pending_id).toBe(pendingId);
    expect(aspect.proposal?.status).toBe('approved');
    expect(aspect.proposal?.edited_from).toBeUndefined();
  });

  test('правки при «Отклонить» → VALIDATION: отклонение ничего не применяет, и делать вид, что правки учтены, нельзя', async () => {
    const { taskId, runId, pendingId } = await proposed('Отменить подписку');

    const e = await trpcError(
      callerLater().routine.decideProposal({
        runId,
        pendingId,
        decision: 'reject',
        edits: { fields: [{ index: 0, aspect: 'orbis/task', field: 'status', value: 'done' }] },
      }),
    );
    expect(e.code).toBe('BAD_REQUEST');
    // Ни отказа, ни правленого предложения: отказ входа стоит до всякой записи
    expect(await rejectReason(pendingId)).toBeUndefined();
    expect(await pendingCount(runId)).toBe(1);
    expect((await runAspect(runId)).proposal?.status).toBe('pending');
    expect(await taskStatus(taskId)).toBe('inbox');
  });

  test('правка + разошедшееся предусловие → stale с расхождениями и адресом правленого; правленое погашено stale, правки НЕ применены (Ш1.6, приёмка 12)', async () => {
    const { taskId, runId, pendingId } = await proposedWithBody('Продлить абонемент');
    await ownerSets(taskId, 'done'); // владелец успел раньше — снятое предусловие не держится
    const doc = ownerDoc();

    const decided = await callerLater().routine.decideProposal({
      runId,
      pendingId,
      decision: 'approve',
      edits: {
        body: [{ index: 0, bodyDoc: doc }],
        fields: [{ index: 0, aspect: 'orbis/task', field: 'status', value: 'in_progress' }],
      },
    });
    expect(decided.status).toBe('stale');
    if (decided.status !== 'stale') throw new Error('не stale');
    expect(decided.mismatches).toEqual([
      { property: 'orbis/task_status', expected: ['inbox'], actual: 'done' },
    ]);
    expect(decided.bodyChanged).toBe(false);

    const aspect = await runAspect(runId);
    const editedId = aspect.proposal?.pending_id;
    if (editedId === undefined) throw new Error('прогон без предложения');
    // Устарело ПРАВЛЕНОЕ — карточка обязана узнать своё среди двух
    expect(decided.pendingId).toBe(editedId);
    expect(editedId).not.toBe(pendingId);
    expect(aspect.proposal?.status).toBe('stale');
    expect(aspect.proposal?.edited_from).toBe(pendingId);
    expect(await rejectReason(editedId)).toBe('stale');
    expect(await rejectReason(pendingId)).toBe('edited');

    // Ревалидация — до записи: ни правка тела, ни правка поля не применены
    expect(await taskStatus(taskId)).toBe('done');
    expect(await bodyOf(taskId)).toBe('');
    expect(await bodyDocOf(taskId)).not.toEqual(doc);
  });

  test('правка ломает значение (сырая форма) → VALIDATION на применении: правленое живо и ждёт решения, указатель на нём — владелец правит и жмёт ещё раз (цена §7.10)', async () => {
    const { taskId, runId, pendingId } = await proposed('Разобрать шкаф');

    const e = await trpcError(
      callerLater().routine.decideProposal({
        runId,
        pendingId,
        decision: 'approve',
        edits: {
          fields: [{ index: 0, aspect: 'orbis/task', field: 'status', value: 'не-статус' }],
        },
      }),
    );
    expect(e.code).toBe('BAD_REQUEST');
    expect(await taskStatus(taskId)).toBe('inbox');

    // Лестница дошла до применения: исходное погашено, правленое живо, указатель на нём —
    // иначе владельцу было бы некуда возвращаться со своей правкой
    const aspect = await runAspect(runId);
    const editedId = aspect.proposal?.pending_id;
    if (editedId === undefined) throw new Error('прогон без предложения');
    expect(editedId).not.toBe(pendingId);
    expect(aspect.proposal?.status).toBe('pending');
    expect(aspect.proposal?.edited_from).toBe(pendingId);
    expect(await rejectReason(pendingId)).toBe('edited');
    expect(await rejectReason(editedId)).toBeUndefined();

    // Владелец правит правленое и жмёт ещё раз — обычный второй виток той же лестницы
    const applied = await callerLater().routine.decideProposal({
      runId,
      pendingId: editedId,
      decision: 'approve',
      edits: { fields: [{ index: 0, aspect: 'orbis/task', field: 'status', value: 'done' }] },
    });
    expect(applied.status).toBe('applied');
    if (applied.status !== 'applied') throw new Error('не applied');
    expect(applied.editedFrom).toBe(editedId);
    expect(await taskStatus(taskId)).toBe('done');
  });

  test('«Отклонить» правленого предложения закрывает его причиной owner, граф не тронут', async () => {
    const { taskId, runId, pendingId } = await proposed('Вынести ёлку');
    await trpcError(
      callerLater().routine.decideProposal({
        runId,
        pendingId,
        decision: 'approve',
        edits: {
          fields: [{ index: 0, aspect: 'orbis/task', field: 'status', value: 'не-статус' }],
        },
      }),
    );
    const editedId = (await runAspect(runId)).proposal?.pending_id;
    if (editedId === undefined) throw new Error('прогон без предложения');

    expect(
      await callerLater().routine.decideProposal({
        runId,
        pendingId: editedId,
        decision: 'reject',
      }),
    ).toEqual({ status: 'rejected' });
    expect(await rejectReason(editedId)).toBe('owner');
    const aspect = await runAspect(runId);
    expect(aspect.proposal?.status).toBe('rejected');
    // Судьба меняется, происхождение — нет
    expect(aspect.proposal?.edited_from).toBe(pendingId);
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
// Дифф тела в показе предложения (Ш1.1, Ш1.2)
// ---------------------------------------------------------------------------

describe('routine.proposal: дифф тела предложения', () => {
  test('строка тела pending-предложения несёт bodyDiff.units и proposedDoc; изменённый блок — changed с parts (приёмки 1, 4)', async () => {
    const { runId } = await proposedBodyChange(
      'Позвонить в банк',
      'Позвонить в банк в 10:00\n\nВзять паспорт',
      'Позвонить в банк в 14:00\n\nВзять паспорт',
    );

    const row = await bodyRowOf(runId);
    // Запасная форма показа на месте: полный markdown никуда не делся
    expect(row.after).toBe('Позвонить в банк в 14:00\n\nВзять паспорт');

    const diff = row.bodyDiff;
    if (diff === undefined || 'skipped' in diff) throw new Error('дифф не построен');
    expect(diff.units.map((u) => u.kind)).toEqual(['changed', 'same']);
    const changed = diff.units[0];
    expect(changed?.before).toBe('Позвонить в банк в 10:00');
    expect(changed?.after).toBe('Позвонить в банк в 14:00');
    // Приёмка 4: внутри изменённого блока видно ИМЕННО правку, а не весь блок целиком
    expect(changed?.parts).toEqual([
      { kind: 'same', text: 'Позвонить в банк в' },
      { kind: 'removed', text: '10:00' },
      { kind: 'added', text: '14:00' },
    ]);
    expect(diff.units[1]).toEqual({
      kind: 'same',
      before: 'Взять паспорт',
      after: 'Взять паспорт',
    });

    // Документ предложенного тела — редактору слоя (Ш1.3/Ш1.11): его открывать на правку
    const proposed = row.proposedDoc;
    if (proposed === undefined) throw new Error('proposedDoc не отдан');
    expect(flattenBlocks(proposed.doc).map((b) => b.text)).toEqual([
      'Позвонить в банк в 14:00',
      'Взять паспорт',
    ]);
    // Предложение не правлено владельцем — происхождения у него нет
    expect((await caller().routine.proposal({ runId }))?.editedFrom).toBeUndefined();
  });

  test('ИНВАРИАНТ 1а: канон применённого тела равен after-стороне серверного диффа — approve и сверка flattenBlocks(readBodyDoc(тела записи)) с after-склейкой units', async () => {
    const { taskId, runId, pendingId } = await proposedBodyChange(
      'Собрать чемодан',
      '# План\n\nПаспорт\n\n- носки\n- зарядка',
      '# План поездки\n\nПаспорт и билеты\n\n- носки\n- зарядка\n- зонт',
    );

    const row = await bodyRowOf(runId);
    const diff = row.bodyDiff;
    if (diff === undefined || 'skipped' in diff) throw new Error('дифф не построен');
    const afterSide = afterTexts(diff.units);

    const applied = await callerLater().routine.decideProposal({
      runId,
      pendingId,
      decision: 'approve',
    });
    expect(applied.status).toBe('applied');

    // То, что легло в запись, — ровно то, что сервер показал «станет»: поэлементно и в
    // порядке документа (инвариант порядка after-стороны у diffBodyDocs жёсткий)
    const stored = readBodyDoc(await bodyDocOf(taskId), (await bodyOf(taskId)) ?? '');
    expect(flattenBlocks(stored.doc).map((b) => b.text)).toEqual(afterSide);
  });

  test('тело записи тронуто после составления → bodyDiff {skipped: body_changed}, диффа нет (приёмка 12, С1)', async () => {
    const { taskId, runId, pendingId } = await proposedBodyChange(
      'Переписать заметку',
      'Старый текст',
      'Новый текст',
    );
    // Владелец тронул запись сам — updated_at бампит любая её правка
    await ownerSets(taskId, 'planned');

    const row = await bodyRowOf(runId);
    expect(row.bodyDiff).toEqual({ skipped: 'body_changed' });
    // Разбора не было — значит и документа редактору нет; запасная форма показа осталась
    expect(row.proposedDoc).toBeUndefined();
    expect(row.after).toBe('Новый текст');

    // Ровно то, ради чего пометка и заведена: дифф против НОВОГО тела нарисовал бы
    // согласие там, где «Принять» отвечает отказом
    const decided = await callerLater().routine.decideProposal({
      runId,
      pendingId,
      decision: 'approve',
    });
    expect(decided.status).toBe('stale');
  });

  test('тело сверх потолка (байты/строки) → {skipped: too_large}, after-форма на месте, кнопки живы (приёмка 16)', async () => {
    // Сторона «стало»: предложено тело из PROPOSAL_DIFF_MAX_SOURCE_LINES + 1 непустых строк
    const many = manyLines(PROPOSAL_DIFF_MAX_SOURCE_LINES + 1);
    const wide = await proposedBodyChange('Разложить архив', 'Коротко', many);
    const wideRow = await bodyRowOf(wide.runId);
    expect(wideRow.bodyDiff).toEqual({ skipped: 'too_large' });
    expect(wideRow.proposedDoc).toBeUndefined();
    expect(wideRow.after).toBe(many);

    // Кнопки живы и форма прежняя: предложение по-прежнему принимается целиком
    const applied = await callerLater().routine.decideProposal({
      runId: wide.runId,
      pendingId: wide.pendingId,
      decision: 'approve',
    });
    expect(applied.status).toBe('applied');
    expect(await bodyOf(wide.taskId)).toContain(`Пункт ${PROPOSAL_DIFF_MAX_SOURCE_LINES + 1}`);

    // Сторона «было»: у записи тело сверх потолка байт, предложено крошечное
    const heavy = await proposedBodyChange('Сжать конспект', heavyBody(), 'Коротко и по делу');
    const heavyRow = await bodyRowOf(heavy.runId);
    expect(heavyRow.bodyDiff).toEqual({ skipped: 'too_large' });
    expect(heavyRow.after).toBe('Коротко и по делу');

    // ПОРЯДОК проверок: устаревание сильнее потолка. Тело и сверх потолка, и тронуто —
    // владельцу говорят про устаревание, потому что «Принять» откажет именно по нему
    await ownerSets(heavy.taskId, 'planned');
    expect((await bodyRowOf(heavy.runId)).bodyDiff).toEqual({ skipped: 'body_changed' });
  });

  test('тело переписано целиком → {skipped: rewritten}, но proposedDoc отдан: разбор уже состоялся, и слой правки открывается', async () => {
    const before = Array.from({ length: 40 }, (_, i) => `Альфа бета гамма ${i}`).join('\n\n');
    const after = Array.from({ length: 40 }, (_, i) => `Ро сигма тау ${i + 100}`).join('\n\n');
    const { runId } = await proposedBodyChange('Переписать план', before, after);

    const row = await bodyRowOf(runId);
    expect(row.bodyDiff).toEqual({ skipped: 'rewritten' });
    expect(row.after).toBe(after);
    // Отличие от до-разборных отказов: потолок не сработал, документ построен — значит его и
    // отдаём, иначе владельцу нечего было бы открыть на правку ровно там, где правка нужнее
    const proposed = row.proposedDoc;
    if (proposed === undefined) throw new Error('proposedDoc не отдан');
    expect(flattenBlocks(proposed.doc)).toHaveLength(40);
  });

  test('решённое предложение — bodyDiff и proposedDoc отсутствуют (Ш1.1: дифф только для pending)', async () => {
    const { runId, pendingId } = await proposedBodyChange('Оплатить счёт', 'Было', 'Стало');
    expect((await bodyRowOf(runId)).bodyDiff).toBeDefined();

    expect(
      (await callerLater().routine.decideProposal({ runId, pendingId, decision: 'reject' })).status,
    ).toBe('rejected');

    const view = await caller().routine.proposal({ runId });
    expect(view?.status).toBe('rejected');
    const row = await bodyRowOf(runId);
    expect(row.bodyDiff).toBeUndefined();
    expect(row.proposedDoc).toBeUndefined();
    // Строка тела и её «станет» остаются: решённое предложение обязано читаться
    expect(row.after).toBe('Стало');
  });

  test('правленое P2: строка тела на месте, после-сторона — присланный bodyDoc без канонизации (Ш1.11)', async () => {
    const { taskId, runId, pendingId } = await proposedWithBody('Описать переезд');
    const doc = ownerDoc();

    // Правка ломает ЗНАЧЕНИЕ поля → применение падает VALIDATION, а правленое остаётся
    // живым и ждёт решения: единственный способ увидеть pending-P2 в показе
    await trpcError(
      callerLater().routine.decideProposal({
        runId,
        pendingId,
        decision: 'approve',
        edits: {
          body: [{ index: 0, bodyDoc: doc }],
          fields: [{ index: 0, aspect: 'orbis/task', field: 'status', value: 'не-статус' }],
        },
      }),
    );
    const aspect = await runAspect(runId);
    expect(aspect.proposal?.status).toBe('pending');
    const editedId = aspect.proposal?.pending_id;
    if (editedId === undefined) throw new Error('прогон без предложения');

    const view = await caller().routine.proposal({ runId });
    if (view === null) throw new Error('предложение не найдено');
    expect(view.pendingId).toBe(editedId);
    // Рулинг П-2: подпись «правка владельца» на карточке — по этому полю
    expect(view.editedFrom).toBe(pendingId);

    // Строка тела у правленого предложения ЕСТЬ: payload несёт bodyDoc, а не body
    const row = view.operations.find((o) => o.field === 'body');
    if (row === undefined) throw new Error('строки тела в правленом предложении нет');
    expect(row.after).toBe(serializeBody(doc));
    // Тело владельца берётся КАК ЕСТЬ: канонизация снесла бы блочные id
    expect(row.proposedDoc).toEqual(doc);

    // Дифф считается против тела ЗАПИСИ и after-стороной даёт ровно документ владельца
    const diff = row.bodyDiff;
    if (diff === undefined || 'skipped' in diff) throw new Error('дифф не построен');
    expect(afterTexts(diff.units)).toEqual(flattenBlocks(doc.doc).map((b) => b.text));
    expect(await bodyOf(taskId)).toBe(''); // ничего не применено
  });
});

// ---------------------------------------------------------------------------
// Открытые предложения по записи (Ш1.3): экран записи спрашивает сервер «есть ли по мне
// план, которого я не видел», а не узнаёт об этом из ленты чата
// ---------------------------------------------------------------------------

describe('routine.proposalsForEntity', () => {
  test('две рутины с открытыми предложениями по одной записи → обе В ПОРЯДКЕ ленты, решение по каждому своё (приёмка 18)', async () => {
    const taskId = await seedTask('Собрать документы');
    // Порядок ответа держится на КОЛОНКЕ `created_at` сообщения, а её ставит `defaultNow()`
    // — настоящими часами БД, которые прогону не подчиняются. Замер на этом тесте: 04:01:16.586
    // и .746, то есть 160 мс разницы, тогда как `metadata.pending.created_at` у обоих
    // одинаков. Развести предложения во времени часами прогона НЕЛЬЗЯ: `ctx.clock` доезжает
    // только до метаданных, а сортировка их не читает вовсе (прежний комментарий здесь
    // утверждал обратное и вёл за собой мёртвый параметр `clock` у `proposedOps`).
    const first = await proposedOps('первая по документам', [
      {
        tool: 'entity_update',
        input: { id: taskId, aspects: { 'orbis/task': { status: 'planned' } } },
      },
    ]);
    const second = await proposedOps('вторая по документам', [
      { tool: 'entity_update', input: { id: taskId, title: 'Собрать документы к пятнице' } },
    ]);

    const both = await caller().routine.proposalsForEntity({ entityId: taskId });
    // Порядок — по времени сообщения, старшее первым: сравнение через sort() пропустило бы
    // регрессию ORDER BY, а экран рисует список сверху вниз
    expect(both.map((v) => v.pendingId)).toEqual([first.pendingId, second.pendingId]);
    expect(both.every((v) => v.status === 'pending')).toBe(true);
    // Каждое ведёт на СВОЮ рутину: без этого владелец не поймёт, кто из двух что предлагает
    expect(both.map((v) => v.routineId)).toEqual([first.routineId, second.routineId]);

    // Решение по одному не трогает второе: список сужается ровно на решённое
    expect(
      await callerLater().routine.decideProposal({
        runId: first.runId,
        pendingId: first.pendingId,
        decision: 'reject',
      }),
    ).toEqual({ status: 'rejected' });

    const left = await caller().routine.proposalsForEntity({ entityId: taskId });
    expect(left).toHaveLength(1);
    expect(left[0]?.pendingId).toBe(second.pendingId);
    expect(left[0]?.status).toBe('pending');
  });

  test('чат-подтверждение (source=chat) по той же записи НЕ попадает; решённое и архивный прогон НЕ попадают', async () => {
    const taskId = await seedTask('Оплатить страховку');
    const live = await proposedOps('живое по страховке', [
      {
        tool: 'entity_update',
        input: { id: taskId, aspects: { 'orbis/task': { status: 'planned' } } },
      },
    ]);

    // Чат-подтверждение с ТЕМИ ЖЕ операциями по той же записи: голая проба по операциям
    // притащила бы его, а решается оно другой кнопкой и к рутинам отношения не имеет
    await chatConfirmation(taskId);

    // Решённое предложение отдельной рутины
    const decided = await proposedOps('решённое по страховке', [
      { tool: 'entity_update', input: { id: taskId, title: 'Оплатить страховку до среды' } },
    ]);
    expect(
      await callerLater().routine.decideProposal({
        runId: decided.runId,
        pendingId: decided.pendingId,
        decision: 'reject',
      }),
    ).toEqual({ status: 'rejected' });

    // Прогон в архиве (след отката) при СВОЁМ pending-предложении: решать по нему нельзя
    const archived = await proposedOps('архивное по страховке', [
      {
        tool: 'entity_update',
        input: { id: taskId, aspects: { 'orbis/task': { status: 'done' } } },
      },
    ]);
    await archiveRun(archived.runId);
    expect((await runAspect(archived.runId)).proposal?.status).toBe('pending');

    const open = await caller().routine.proposalsForEntity({ entityId: taskId });
    expect(open.map((v) => v.pendingId)).toEqual([live.pendingId]);
  });

  test('после правки владельца: мёртвый P1 не попадает, живой P2 попадает (условие pending_id = id сообщения)', async () => {
    const taskId = await seedTask('Разобрать кладовку');
    const { runId, pendingId } = await proposedOps('правка по кладовке', [
      {
        tool: 'entity_update',
        input: { id: taskId, aspects: { 'orbis/task': { status: 'planned' } } },
      },
    ]);

    // НАСТОЯЩАЯ лестница правки: значение ломает схему аспекта, поэтому применение падает
    // VALIDATION уже после того, как P1 погашен `edited`, а P2 создан и живёт
    await trpcError(
      callerLater().routine.decideProposal({
        runId,
        pendingId,
        decision: 'approve',
        edits: {
          fields: [{ index: 0, aspect: 'orbis/task', field: 'status', value: 'не-статус' }],
        },
      }),
    );
    const editedId = (await runAspect(runId)).proposal?.pending_id;
    if (editedId === undefined) throw new Error('прогон без предложения');
    expect(editedId).not.toBe(pendingId);
    // Оба сообщения лежат в ленте и оба несут операции по этой записи — отличает их только
    // указатель прогона
    expect(await pendingCount(runId)).toBe(2);
    expect((await runAspect(runId)).proposal?.status).toBe('pending');

    const open = await caller().routine.proposalsForEntity({ entityId: taskId });
    expect(open).toHaveLength(1);
    expect(open[0]?.pendingId).toBe(editedId);
    expect(open[0]?.editedFrom).toBe(pendingId);
  });

  test('предложение из нескольких записей находится по каждой из них (приёмка 17)', async () => {
    const firstId = await seedTask('Заказать пропуск');
    const secondId = await seedTask('Забрать пропуск');
    const { pendingId } = await proposedOps('две записи одним предложением', [
      {
        tool: 'entity_update',
        input: { id: firstId, aspects: { 'orbis/task': { status: 'planned' } } },
      },
      {
        tool: 'entity_update',
        input: { id: secondId, aspects: { 'orbis/task': { status: 'planned' } } },
      },
    ]);

    for (const entityId of [firstId, secondId]) {
      const open = await caller().routine.proposalsForEntity({ entityId });
      expect(open.map((v) => v.pendingId)).toEqual([pendingId]);
      // Предложение отдаётся ЦЕЛИКОМ: слой записи показывает и строки по соседней записи
      expect(open[0]?.operations.map((o) => o.entity?.id)).toEqual([firstId, secondId]);
    }

    // Запись без предложений — пустой список, а не отсутствие ответа
    expect(
      await caller().routine.proposalsForEntity({ entityId: await seedTask('Тихая') }),
    ).toEqual([]);
  });

  test('предложение из ОДНОЙ связи находится по обоим концам: по источнику (тап из карточки, приёмка 2) и по цели (обычное открытие, приёмка 3)', async () => {
    const taskId = await seedTask('Сверстать смету');
    const project = await seedEntity(owner, {
      title: 'Ремонт кухни',
      tags: [],
      aspects: { 'orbis/project': { stage: 'active' } },
    });
    // Ни одной entity_update: единственная операция адресуется концами связи, и проба по
    // `id` не увидела бы это предложение вовсе
    const { pendingId } = await proposedOps('связать задачу с проектом', [
      {
        tool: 'relation_create',
        input: { source_id: taskId, target_id: project.id, relation_type: 'parent' },
      },
    ]);

    // Источник: ровно та запись, которую карточка перечисляет строкой (relationRow ставит
    // entity: {id: source_id}) — тап по ней обязан привести к слою, а не в тупик
    const bySource = await caller().routine.proposalsForEntity({ entityId: taskId });
    expect(bySource.map((v) => v.pendingId)).toEqual([pendingId]);
    expect(bySource[0]?.operations[0]).toMatchObject({
      index: 0,
      tool: 'relation_create',
      entity: { id: taskId, title: 'Сверстать смету' },
    });

    // Цель связи затронута не меньше источника, хотя в карточке отдельной строкой не стоит
    const byTarget = await caller().routine.proposalsForEntity({ entityId: project.id });
    expect(byTarget.map((v) => v.pendingId)).toEqual([pendingId]);
  });

  test('смешанное предложение (правка + две связи) находится по каждой из трёх записей ровно ОДИН раз — совпадение по двум пробам не двоит ответ', async () => {
    const a = await seedTask('Собрать анализы');
    const b = await seedTask('Записаться к врачу');
    const c = await seedTask('Забрать заключение');
    const { pendingId } = await proposedOps('приём у врача одним планом', [
      { tool: 'entity_update', input: { id: a, aspects: { 'orbis/task': { status: 'planned' } } } },
      { tool: 'relation_create', input: { source_id: a, target_id: b, relation_type: 'blocks' } },
      { tool: 'relation_create', input: { source_id: b, target_id: c, relation_type: 'blocks' } },
    ]);

    // A совпадает с пробой по `id` (правка) И с пробой по `source_id` (первая связь);
    // B — с пробой по `target_id` (первая связь) И по `source_id` (вторая). Оба обязаны
    // приехать ОДНИМ элементом: иначе экран нарисовал бы две плашки одного предложения
    for (const entityId of [a, b, c]) {
      const open = await caller().routine.proposalsForEntity({ entityId });
      expect(open.map((v) => v.pendingId)).toEqual([pendingId]);
      expect(open[0]?.operations).toHaveLength(3);
    }
  });

  test('PAT-агенту хода нет: ownerOnly, как весь routine.*', async () => {
    const taskId = await seedTask('Не для агента');
    const agent = createCaller({
      actorUserId: owner,
      actorKind: 'agent',
      db,
      clientVersion: null,
      ai: { provider: new ScriptedProvider([]), model: MODEL, clock: () => T0 },
    });
    const e = await trpcError(agent.routine.proposalsForEntity({ entityId: taskId }));
    expect(e.code).toBe('FORBIDDEN');
  });
});

// ---------------------------------------------------------------------------
// Откат рутинного прогона (приёмка 3, 11; инвариант 9)
// ---------------------------------------------------------------------------

describe('откат рутинного прогона: decideProposal(approve) → rollbackRun / undoLast', () => {
  test('approve → rollbackRun ok: план откачен, прогон архивирован, бухгалтерия (статус предложения) не тронута; повтор идемпотентен; слот отработан — startBucketRun → done', async () => {
    const { routineId, routineTitle, taskId, runId, pendingId, bucket } =
      await plannedProposed('Разобрать почту');

    const applied = await callerLater().routine.decideProposal({
      runId,
      pendingId,
      decision: 'approve',
    });
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
      pendingId: yesterday.pendingId,
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
    const { taskId, runId, pendingId } = await proposed('Записаться в бассейн');
    const applied = await callerLater().routine.decideProposal({
      runId,
      pendingId,
      decision: 'approve',
    });
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

  test('откат прогона с ОТКРЫТЫМ предложением: pending отклонён причиной stale, статус на прогоне stale, прогон в архиве; decideProposal → NOT_FOUND, обзор не считает его открытым (хвост ре-ревью)', async () => {
    const { routineId, taskId, runId, pendingId } = await proposed('Полить цветы');
    expect((await runAspect(runId)).proposal?.status).toBe('pending');
    expect((await caller().routine.overview({ routineId })).openProposal).toBe(true);

    const rolled = await rollbackRun(db, { actorUserId: owner, runId });
    expect(rolled).toEqual({ ok: true, undone: [], note: ROUTINE_ROLLBACK_NOTE });
    // Работы у прогона не было (предложение не принято) — граф не тронут
    expect(await taskStatus(taskId)).toBe('inbox');
    // Открытое погашено: карточке больше нечего предлагать
    expect(await rejectReason(pendingId)).toBe('stale');
    const aspect = await runAspect(runId);
    expect(aspect.proposal?.status).toBe('stale');
    expect(aspect.proposal?.decided_at).toBeDefined();
    expect(await isArchived(runId)).toBe(true);
    // Карточка читается (архивный прогон отдаётся) и знает и статус, и архив
    const view = await caller().routine.proposal({ runId });
    expect(view?.status).toBe('stale');
    expect(view?.runArchived).toBe(true);
    expect(view?.mismatches).toBeUndefined();
    // Решать по нему нечего: под архивом прогон не найден (как и было), но теперь кнопок
    // к этому NOT_FOUND у карточки нет
    const e = await trpcError(
      callerLater().routine.decideProposal({ runId, pendingId, decision: 'approve' }),
    );
    expect(e.code).toBe('NOT_FOUND');
    expect((await caller().routine.overview({ routineId })).openProposal).toBe(false);
    // Повтор отката — тот же исход, второго отказа pending'а нет
    expect(await rollbackRun(db, { actorUserId: owner, runId })).toEqual({
      ok: true,
      undone: [],
      note: ROUTINE_ROLLBACK_NOTE,
    });
    expect((await runAspect(runId)).proposal?.status).toBe('stale');
  });

  test('откат прогона с НЕОТВЕЧЕННЫМ вопросом: исход stale + запись в тред рутины, прогон в архиве; answerCheckpoint → NOT_FOUND, обзор не считает «ждёт» (хвост ре-ревью)', async () => {
    const routineId = await seedRoutine(owner, { title: 'Рутина: вопрос и откат' });
    const { runId } = await seedRoutineRun(owner, {
      routineId,
      bucket: '2026-08-10T07:00',
      run: {
        outcome: 'checkpoint',
        checkpoint: { question: 'Какой приоритет у почты?', asked_at: T0.toISOString() },
        finished_at: T0.toISOString(),
      },
    });
    expect((await caller().routine.overview({ routineId })).waiting).toBe(1);

    const rolled = await rollbackRun(db, { actorUserId: owner, runId });
    expect(rolled.ok).toBe(true);
    expect((await runAspect(runId)).outcome).toBe('stale');
    expect(await isArchived(runId)).toBe(true);
    const notes = await withIdentity(db, owner, (tx) =>
      tx.execute(
        sql`SELECT content FROM chat_messages
            WHERE metadata @> ${JSON.stringify({ type: 'routine_stale', run_id: runId })}::jsonb`,
      ),
    );
    expect([...notes].map((r) => (r as { content: string }).content)).toEqual([
      'Вопрос прогона снят: прогон откачен',
    ]);
    const e = await trpcError(callerLater().routine.answerCheckpoint({ runId, answer: 'Высокий' }));
    expect(e.code).toBe('NOT_FOUND');
    expect((await caller().routine.overview({ routineId })).waiting).toBe(0);
  });

  test('обзор не считает архивный прогон с pending/checkpoint старого формата (до хвоста — архив без гашения)', async () => {
    const routineId = await seedRoutine(owner, { title: 'Рутина: старый архив' });
    const { runId } = await seedRoutineRun(owner, {
      routineId,
      bucket: '2026-08-11T07:00',
      run: {
        outcome: 'checkpoint',
        checkpoint: { question: 'Снять?', asked_at: T0.toISOString() },
        finished_at: T0.toISOString(),
      },
    });
    expect((await caller().routine.overview({ routineId })).waiting).toBe(1);
    const archived = await execute(db, {
      actorUserId: owner,
      actorKind: 'owner',
      source: 'system',
      runId,
      operations: [{ tool: 'entity_update', input: { id: runId, archived: true } }],
    });
    if (!archived.ok) throw new Error(archived.error.message);
    expect((await caller().routine.overview({ routineId })).waiting).toBe(0);
  });

  test('«отмени последнее» после approve снимает ПЛАН (batch предложения), а не пометку статуса на прогоне (приёмка 3)', async () => {
    const { taskId, runId, pendingId } = await proposed('Отнести обувь в ремонт');
    const applied = await callerLater().routine.decideProposal({
      runId,
      pendingId,
      decision: 'approve',
    });
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

  test('откат прогона после принятия ПРАВЛЕНОГО инвертирует батч правленого предложения: правка владельца — работа прогона (source routine + run_id), а не его бухгалтерия (приёмка 11)', async () => {
    const { taskId, runId, pendingId } = await proposed('Забрать справку');
    const applied = await callerLater().routine.decideProposal({
      runId,
      pendingId,
      decision: 'approve',
      edits: {
        fields: [{ index: 0, aspect: 'orbis/task', field: 'status', value: 'in_progress' }],
      },
    });
    expect(applied.status).toBe('applied');
    if (applied.status !== 'applied') throw new Error('не applied');
    expect(await taskStatus(taskId)).toBe('in_progress');

    const rolled = await rollbackRun(db, { actorUserId: owner, runId });
    expect(rolled.ok).toBe(true);
    if (!rolled.ok) throw new Error(`ожидался успешный откат: ${JSON.stringify(rolled)}`);
    // Инвертирован батч ПРАВЛЕНОГО предложения — того, что применилось
    expect(rolled.undone).toEqual([applied.actionId]);
    expect(await taskStatus(taskId)).toBe('inbox');
    // Бухгалтерия прогона на месте, вместе со следом правки
    const aspect = await runAspect(runId);
    expect(aspect.proposal?.status).toBe('approved');
    expect(aspect.proposal?.edited_from).toBe(pendingId);
    expect(await isArchived(runId)).toBe(true);
  });

  test('«отмени последнее» после принятия правленого снимает батч ПРАВЛЕНОГО предложения, а не пометку статуса (приёмка 10)', async () => {
    const { taskId, runId, pendingId } = await proposed('Поменять шины');
    const applied = await callerLater().routine.decideProposal({
      runId,
      pendingId,
      decision: 'approve',
      edits: {
        fields: [{ index: 0, aspect: 'orbis/task', field: 'status', value: 'in_progress' }],
      },
    });
    expect(applied.status).toBe('applied');
    if (applied.status !== 'applied') throw new Error('не applied');

    const undone = await undoLast(db, { actorUserId: owner });
    expect(undone.ok).toBe(true);
    expect(await taskStatus(taskId)).toBe('inbox');
    // Снят план, а не пометка: статус предложения и след правки на прогоне не тронуты
    const aspect = await runAspect(runId);
    expect(aspect.proposal?.status).toBe('approved');
    expect(aspect.proposal?.edited_from).toBe(pendingId);
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

  test('undecided считает прогоны с флажком пачки (снятый и архивный — нет); propose-прогон со ждущим предложением в счёт не попал (приёмка 11, Б5, С8)', async () => {
    const routineId = await seedRoutine(owner, { title: 'Рутина: бейдж пачки' });
    await seedRoutineRun(owner, {
      routineId,
      bucket: '2026-08-14T07:00',
      startedAt: new Date(T0.getTime() - 4 * 24 * 3600_000),
      run: { outcome: 'finished', finished_at: iso(T0), undecided: true },
    });
    // Разобранная пачка несёт `undecided:false` (снятие — запись, а не удаление ключа)
    await seedRoutineRun(owner, {
      routineId,
      bucket: '2026-08-15T07:00',
      startedAt: new Date(T0.getTime() - 3 * 24 * 3600_000),
      run: { outcome: 'finished', finished_at: iso(T0), undecided: false },
    });
    // Прогон без пачки вовсе — ключа нет
    await seedRoutineRun(owner, {
      routineId,
      bucket: '2026-08-16T07:00',
      startedAt: new Date(T0.getTime() - 2 * 24 * 3600_000),
      run: { outcome: 'finished', finished_at: iso(T0), report: 'всё спокойно' },
    });
    expect((await caller().routine.overview({ routineId })).undecided).toBe(1);

    // Архивный (след отката) не считается — по тому же доводу, что и `waiting`: решать
    // его пачку владельцу никто не мешает, но экран рутины обещал бы работу, которой на
    // нём нет
    const rolled = await seedRoutineRun(owner, {
      routineId,
      bucket: '2026-08-13T07:00',
      startedAt: new Date(T0.getTime() - 5 * 24 * 3600_000),
      run: { outcome: 'finished', finished_at: iso(T0), undecided: true },
    });
    await execute(db, {
      actorUserId: owner,
      actorKind: 'owner',
      source: 'ui',
      operations: [{ tool: 'entity_update', input: { id: rolled.runId, archived: true } }],
    });
    expect((await caller().routine.overview({ routineId })).undecided).toBe(1);

    // Б5: предложение — НЕ пачка. Propose-прогон ждёт решения владельца, но `undecided`
    // не несёт, и слить эти два ожидания в одну цифру значило бы обещать кнопку «Принять
    // все» там, где решается план целиком
    const p = await proposed('Бейдж и предложение');
    const view = await caller().routine.overview({ routineId: p.routineId });
    expect(view.openProposal).toBe(true);
    expect(view.undecided).toBe(0);
  });

  test('несуществующая рутина → NOT_FOUND', async () => {
    const e = await trpcError(caller().routine.overview({ routineId: newId() }));
    expect(e.code).toBe('NOT_FOUND');
  });
});

// ---------------------------------------------------------------------------
// Пачка решений: поштучные решения владельца (D42 §6; приёмки 3, 4, 5, 10, 18)
// ---------------------------------------------------------------------------

/**
 * Рутина + ЗАКРЫТЫЙ прогон с флажком пачки — то состояние, в котором владелец её и
 * застаёт: прогон отработал ночью, `undecided:true` поставил его close-патч (ОЧ.6).
 * Единицы кладутся в него уже после закрытия — для ленты это те же сообщения, а сид
 * настоящим прогоном стоил бы сценария модели ради состояния, которое от него не зависит.
 */
async function batchRun(title: string): Promise<{ routineId: string; runId: string }> {
  const routineId = await seedRoutine(owner, { title: `Рутина: ${title}` });
  const { runId } = await seedRoutineRun(owner, {
    routineId,
    run: { outcome: 'finished', finished_at: iso(T0), undecided: true },
  });
  return { routineId, runId };
}

/**
 * Отложенное действие-единица НАСТОЯЩИМ путём (архивация записи act-рутиной через
 * диспатч), а не вставкой в ленту: и предусловия ОЧ.13, и карточка, и `kind` рождаются
 * там, и сид мимо `deferRoutineUnit` проверял бы форму, которой в проде не бывает.
 */
async function deferUnit(
  routineId: string,
  runId: string,
  title: string,
  over: Record<string, unknown> = {},
): Promise<{ pendingId: string; targetId: string }> {
  const targetId = await seedTask(title);
  const r = await dispatchTool(
    routineCtx(owner, 'act', ['entity_update'], {
      routine: { id: routineId, runId, mode: 'act', allowedTools: new Set(['entity_update']) },
    }),
    'entity_update',
    { id: targetId, archived: true, ...over },
  );
  if (r.status !== 'pending_confirmation') throw new Error(`deferUnit: ${JSON.stringify(r)}`);
  return { pendingId: r.pendingId, targetId };
}

/** Вопрос-единица тем же настоящим путём — `orbis_ask` через диспатч. */
async function askUnit(
  routineId: string,
  runId: string,
  question: string,
  options?: string[],
): Promise<string> {
  const r = await dispatchTool(
    routineCtx(owner, 'act', [], {
      routine: { id: routineId, runId, mode: 'act', allowedTools: new Set() },
    }),
    'orbis_ask',
    { run_id: runId, question, ...(options !== undefined && { options }) },
  );
  if (r.status !== 'ok') throw new Error(`askUnit: ${JSON.stringify(r)}`);
  return (r.result as { pending_id: string }).pending_id;
}

/** Строки ленты по единице: отказ, ответ, гашение — по ним читается её судьба. */
async function unitMessages(pendingId: string): Promise<Array<Record<string, unknown>>> {
  const rows = await withIdentity(db, owner, (tx) =>
    tx.execute(
      sql`SELECT id, content, metadata FROM chat_messages
          WHERE metadata @> ${JSON.stringify({ rejects: pendingId })}::jsonb
             OR metadata @> ${JSON.stringify({ answers: pendingId })}::jsonb
             OR metadata @> ${JSON.stringify({ stales: pendingId })}::jsonb`,
    ),
  );
  return [...(rows as unknown as Array<Record<string, unknown>>)];
}

/** Действия журнала, снимающие флажок пачки, — по ним читается их атрибуция (§9.6). */
async function flagPatches(runId: string) {
  return (await actionsOf(owner)).filter(
    (a) =>
      a.run_id === runId &&
      a.operations.some(
        (op) =>
          (op.payload.aspects as { 'orbis/agent-run'?: { undecided?: unknown } } | undefined)?.[
            'orbis/agent-run'
          ]?.undecided === false,
      ),
  );
}

/** Флажок пачки на прогоне: `undefined` — ключа нет вовсе (пачки не было). */
async function undecidedOf(runId: string): Promise<boolean | undefined> {
  return ((await aspectsOf(owner, runId))['orbis/agent-run'] as { undecided?: boolean }).undecided;
}

describe('routine.decideDeferred: отложенное действие (D42 §6)', () => {
  test('«Принять» отложенную архивацию → applied; запись заархивирована source=routine + run_id; в журнале один action; откат прогона откатывает и её (приёмка 3)', async () => {
    const { routineId, runId } = await batchRun('Архив отчётов');
    const { pendingId, targetId } = await deferUnit(routineId, runId, 'Прошлогодний отчёт');

    const applied = await callerLater().routine.decideDeferred({ pendingId, decision: 'approve' });
    expect(applied.status).toBe('applied');
    if (applied.status !== 'applied') throw new Error('не applied');
    expect(await isArchived(targetId)).toBe(true);

    // Атрибуция — работа ПРОГОНА (§9.5): по паре source+run_id её находят журнал, Undo и
    // откат прогона, и без неё «Принять» осталось бы работой ниоткуда
    const own = (await actionsOf(owner)).filter(
      (a) => a.run_id === runId && a.source === 'routine',
    );
    expect(own.length).toBe(1);
    expect(own[0]?.id).toBe(applied.actionId);
    expect(own[0]?.actor_kind).toBe('ai');

    const rolled = await rollbackRun(db, { actorUserId: owner, runId });
    expect(rolled.ok).toBe(true);
    if (!rolled.ok) throw new Error(`ожидался успешный откат: ${JSON.stringify(rolled)}`);
    expect(rolled.undone).toEqual([applied.actionId]);
    expect(await isArchived(targetId)).toBe(false);
  });

  test('«Отклонить» → append-отказ с текстом единицы, граф не тронут; повтор reject возвращает already (приёмка 4)', async () => {
    const { routineId, runId } = await batchRun('Отказ');
    const { pendingId, targetId } = await deferUnit(routineId, runId, 'Черновик письма');

    const rejected = await callerLater().routine.decideDeferred({ pendingId, decision: 'reject' });
    expect(rejected).toEqual({ status: 'rejected' });
    expect(await isArchived(targetId)).toBe(false);

    // Текст СВОЙ, единицы: «Подтверждение отклонено» и «Предложение…» писаны про другое (С6)
    const messages = await unitMessages(pendingId);
    expect(messages.length).toBe(1);
    expect(messages[0]?.content).toBe('Отложенное действие отклонено владельцем');
    expect((messages[0]?.metadata as { reason?: string }).reason).toBe('owner');

    const again = await callerLater().routine.decideDeferred({ pendingId, decision: 'reject' });
    expect(again).toEqual({ status: 'already', fate: 'rejected' });
    // Повтор ничего не дописал: журнал append-only, вторая строка отказа была бы второй судьбой
    expect((await unitMessages(pendingId)).length).toBe(1);
  });

  test('двойной клик «Принять» → replay тем же actionId, одна запись в журнале (приёмка 10)', async () => {
    const { routineId, runId } = await batchRun('Двойной клик');
    const { pendingId, targetId } = await deferUnit(routineId, runId, 'Старая заметка');

    const first = await callerLater().routine.decideDeferred({ pendingId, decision: 'approve' });
    const second = await callerLater().routine.decideDeferred({ pendingId, decision: 'approve' });
    expect(first.status).toBe('applied');
    expect(second).toEqual(first);
    expect(await isArchived(targetId)).toBe(true);
    expect(
      (await actionsOf(owner)).filter((a) => a.run_id === runId && a.source === 'routine'),
    ).toHaveLength(1);
  });

  test('владелец тронул цель после постановки → approve даёт stale с расхождениями и гасит карточку (ОЧ.13); вторая НЕЗАВИСИМАЯ единица по тому же полю после applied первой → stale честно, не молча (Р-16)', async () => {
    const { routineId, runId } = await batchRun('Устаревание');
    const { pendingId, targetId } = await deferUnit(routineId, runId, 'Заявка на отпуск', {
      aspects: { 'orbis/task': { status: 'done' } },
    });
    // Правка владельца своей рукой — ровно то, обо что предусловие ОЧ.13 и разбивается
    await ownerSets(targetId, 'in_progress');

    const stale = await callerLater().routine.decideDeferred({ pendingId, decision: 'approve' });
    expect(stale.status).toBe('stale');
    if (stale.status !== 'stale') throw new Error('не stale');
    expect(stale.mismatches).toEqual([
      { property: 'orbis/task_status', expected: ['inbox'], actual: 'in_progress' },
    ]);
    expect(stale.bodyChanged).toBe(false);
    expect(await isArchived(targetId)).toBe(false);
    // Протухшая единица закрыта: предусловия не переснимаются (§9.4), и кнопка «Принять»
    // на ней не заработает уже никогда — оставить её открытой значило бы обещать невозможное
    const closed = await unitMessages(pendingId);
    expect(closed.length).toBe(1);
    expect((closed[0]?.metadata as { reason?: string }).reason).toBe('stale');
    expect(closed[0]?.content).toBe('Отложенное действие устарело: состояние изменилось');

    // Р-16: две единицы по ОДНОМУ полю независимы — применённая первая делает вторую
    // устаревшей, и владелец обязан увидеть это расхождением, а не молчаливым «принято»
    const { routineId: r2, runId: run2 } = await batchRun('Две единицы');
    const target = await seedTask('Прошлогодний акт');
    const one = await dispatchTool(
      routineCtx(owner, 'act', ['entity_update'], {
        routine: { id: r2, runId: run2, mode: 'act', allowedTools: new Set(['entity_update']) },
      }),
      'entity_update',
      { id: target, archived: true },
    );
    const two = await dispatchTool(
      routineCtx(owner, 'act', ['entity_update'], {
        routine: { id: r2, runId: run2, mode: 'act', allowedTools: new Set(['entity_update']) },
      }),
      'entity_update',
      { id: target, archived: true, aspects: { 'orbis/task': { status: 'done' } } },
    );
    if (one.status !== 'pending_confirmation' || two.status !== 'pending_confirmation') {
      throw new Error('обе единицы обязаны отложиться');
    }
    expect(one.pendingId).not.toBe(two.pendingId);

    const applied = await callerLater().routine.decideDeferred({
      pendingId: one.pendingId,
      decision: 'approve',
    });
    expect(applied.status).toBe('applied');
    const second = await callerLater().routine.decideDeferred({
      pendingId: two.pendingId,
      decision: 'approve',
    });
    expect(second.status).toBe('stale');
    if (second.status !== 'stale') throw new Error('вторая единица обязана протухнуть');
    expect(second.mismatches).toEqual([
      { property: 'orbis/archived', expected: [false], actual: true },
    ]);
  });

  test('approve отклонённой → already {fate:rejected}; reject применённой → already {fate:approved}', async () => {
    const { routineId, runId } = await batchRun('Чужой ход');
    const rejected = await deferUnit(routineId, runId, 'Смета на ремонт');
    await callerLater().routine.decideDeferred({
      pendingId: rejected.pendingId,
      decision: 'reject',
    });
    expect(
      await callerLater().routine.decideDeferred({
        pendingId: rejected.pendingId,
        decision: 'approve',
      }),
    ).toEqual({ status: 'already', fate: 'rejected' });
    expect(await isArchived(rejected.targetId)).toBe(false);

    const applied = await deferUnit(routineId, runId, 'Скан паспорта');
    await callerLater().routine.decideDeferred({
      pendingId: applied.pendingId,
      decision: 'approve',
    });
    expect(
      await callerLater().routine.decideDeferred({
        pendingId: applied.pendingId,
        decision: 'reject',
      }),
    ).toEqual({ status: 'already', fate: 'approved' });
    expect(await isArchived(applied.targetId)).toBe(true);
  });

  test('гейты рода: decideDeferred на вопросе → структурный отказ (С7); на предложении прогона (записи без kind) — тоже, путь предложения ему не открыт (приёмка 19)', async () => {
    const { routineId, runId } = await batchRun('Гейты');
    const questionId = await askUnit(routineId, runId, 'Переносить ли встречу?');
    for (const decision of ['approve', 'reject'] as const) {
      const err = await trpcError(
        callerLater().routine.decideDeferred({
          pendingId: questionId,
          decision,
        }),
      );
      expect(err.code).toBe('BAD_REQUEST');
    }
    // Ответ на вопрос по-прежнему возможен: гейт запрещает ЧУЖУЮ судьбу, а не решение вовсе
    expect(
      (await callerLater().routine.answerQuestion({ pendingId: questionId, answer: 'Да' })).status,
    ).toBe('answered');
    // И судьбой гейт не смягчается: на ОТВЕЧЕННЫЙ вопрос «Принять» по-прежнему структурный
    // отказ, а не «уже решено» — иначе экран получил бы разрешение принять то, что принимать
    // нельзя вовсе
    const answered = await trpcError(
      callerLater().routine.decideDeferred({ pendingId: questionId, decision: 'approve' }),
    );
    expect(answered.code).toBe('BAD_REQUEST');
    expect(answered.message).toContain('это вопрос');

    // Предложение прогона — не единица пачки (Б5): у него нет `kind`, и решать его отсюда
    // значило бы применить план мимо статуса на прогоне (decideProposal)
    const proposal = await proposed('Не единица пачки');
    const err = await trpcError(
      callerLater().routine.decideDeferred({ pendingId: proposal.pendingId, decision: 'approve' }),
    );
    expect(err.code).toBe('BAD_REQUEST');
    expect((await runAspect(proposal.runId)).proposal?.status).toBe('pending');
  });

  test('несуществующая единица → NOT_FOUND', async () => {
    const err = await trpcError(
      caller().routine.decideDeferred({ pendingId: newId(), decision: 'approve' }),
    );
    expect(err.code).toBe('NOT_FOUND');
  });
});

describe('routine.answerQuestion: вопрос пачки (приёмка 5, В2)', () => {
  test('ответ → answered; тот же повторно → replay без второй записи; ДРУГОЙ → already с применившимся (С5)', async () => {
    const { routineId, runId } = await batchRun('Ответы');
    const pendingId = await askUnit(routineId, runId, 'Звонить подрядчику сегодня?', ['Да', 'Нет']);

    expect(
      await callerLater().routine.answerQuestion({ pendingId, answer: 'Да', option: 0 }),
    ).toEqual({ status: 'answered', pendingId });
    const written = await unitMessages(pendingId);
    expect(written.length).toBe(1);
    expect(written[0]?.content).toBe('Ответ: «Да»');
    expect((written[0]?.metadata as { source?: string; option?: number }).source).toBe('ui');
    expect((written[0]?.metadata as { option?: number }).option).toBe(0);

    expect(
      await callerLater().routine.answerQuestion({ pendingId, answer: 'Да', option: 0 }),
    ).toEqual({ status: 'answered', pendingId });
    expect((await unitMessages(pendingId)).length).toBe(1);

    // Другой ответ молча не схлопывается (С5): владелец обязан увидеть, что применилось
    expect(await callerLater().routine.answerQuestion({ pendingId, answer: 'Нет' })).toEqual({
      status: 'already',
      answer: 'Да',
    });
    expect((await unitMessages(pendingId)).length).toBe(1);
  });

  test('ответ на ПОГАШЕННЫЙ вопрос → stale, записи нет (В2)', async () => {
    const { routineId, runId } = await batchRun('Гашение');
    const pendingId = await askUnit(routineId, runId, 'Продлевать ли подписку?');
    // Гасит новый прогон рутины — штатный путь V1.8/ОЧ.8
    await seedRoutineRun(owner, {
      routineId,
      bucket: '2026-08-18T07:00',
      startedAt: new Date(T0.getTime() + 24 * 3600_000),
    });
    await supersedeOpen(deps(), { ownerId: owner, routineId, exceptRunId: newId() });

    expect(await callerLater().routine.answerQuestion({ pendingId, answer: 'Да' })).toEqual({
      status: 'stale',
    });
    const messages = await unitMessages(pendingId);
    expect(messages.length).toBe(1);
    expect((messages[0]?.metadata as { type?: string }).type).toBe('question_stale');
  });

  test('option вне фактических вариантов единицы → VALIDATION, ответ НЕ записан (Р3-3)', async () => {
    const { routineId, runId } = await batchRun('Варианты');
    const withOptions = await askUnit(routineId, runId, 'Какой подрядчик?', ['Первый', 'Второй']);
    const free = await askUnit(routineId, runId, 'Что написать в ответе?');

    const outOfRange = await trpcError(
      callerLater().routine.answerQuestion({ pendingId: withOptions, answer: 'Третий', option: 2 }),
    );
    expect(outOfRange.code).toBe('BAD_REQUEST');
    expect(await unitMessages(withOptions)).toEqual([]);

    const noOptions = await trpcError(
      callerLater().routine.answerQuestion({ pendingId: free, answer: 'Да', option: 0 }),
    );
    expect(noOptions.code).toBe('BAD_REQUEST');
    expect(await unitMessages(free)).toEqual([]);

    // Свободный ответ без индекса на том же вопросе проходит
    expect(
      (await callerLater().routine.answerQuestion({ pendingId: free, answer: 'Да' })).status,
    ).toBe('answered');
  });

  test('несуществующий вопрос → NOT_FOUND (чужой и несуществующий под RLS неразличимы)', async () => {
    const err = await trpcError(
      caller().routine.answerQuestion({ pendingId: newId(), answer: 'Да' }),
    );
    expect(err.code).toBe('NOT_FOUND');
  });

  test('answerQuestion на отложенном ДЕЙСТВИИ → структурный отказ (гейт рода, С7); с `option` первым говорит тот же гейт, а не сверка вариантов', async () => {
    const { routineId, runId } = await batchRun('Не вопрос');
    const { pendingId } = await deferUnit(routineId, runId, 'Договор аренды');
    const err = await trpcError(callerLater().routine.answerQuestion({ pendingId, answer: 'Да' }));
    expect(err.code).toBe('BAD_REQUEST');
    expect(err.message).toContain('это действие');
    // У действия вариантов нет по схеме записи, и сверка Р3-3 сказала бы «у вопроса нет
    // варианта №1» — про вопрос, которого здесь не было. Род записи объявляется первым
    const withOption = await trpcError(
      callerLater().routine.answerQuestion({ pendingId, answer: 'Да', option: 0 }),
    );
    expect(withOption.message).toContain('это действие');
    expect(await unitMessages(pendingId)).toEqual([]);
  });

  test('ОТРИЦАТЕЛЬНЫЙ option на прямом вызове ядра → VALIDATION, ответ не записан (Minor-1 ревью Задачи 10)', async () => {
    const { routineId, runId } = await batchRun('Отрицательный вариант');
    const pendingId = await askUnit(routineId, runId, 'Какой из двух?', ['А', 'Б']);

    // Ядро зовётся НАПРЯМУЮ, а не через роутер: через роутер `-1` не проходит схему входа
    // (`min(0)`), и тест проверял бы zod. Но ядро экспортировано, и прямой вызыватель —
    // `decideAllDeferred` рядом, будущий MCP-путь — уехал бы с `option:-1` в append-only
    // metadata НАВСЕГДА: там его не исправить ни правкой, ни повторным ответом
    const failed = await answerRunQuestion(
      { db, clock: () => LATER },
      { ownerId: owner, pendingId, answer: 'А', option: -1 },
    ).then(
      () => null,
      (e: unknown) => e,
    );
    expect(failed).toBeInstanceOf(ExecError);
    expect((failed as ExecError).code).toBe('VALIDATION');
    expect(await unitMessages(pendingId)).toEqual([]);

    // Гейт не задевает годный индекс: тот же вопрос отвечается вариантом №1
    expect(
      (await callerLater().routine.answerQuestion({ pendingId, answer: 'А', option: 0 })).status,
    ).toBe('answered');
  });
});

describe('бухгалтерия флажка пачки (§9.6, приёмка 18)', () => {
  test('пока открытая единица есть — флажок стоит; после решения ПОСЛЕДНЕЙ он снят патчем source=system, и «отмени последнее» после «Принять» отменяет ПРИМЕНЁННОЕ действие, а не патч флажка', async () => {
    const { routineId, runId } = await batchRun('Флажок');
    const questionId = await askUnit(routineId, runId, 'Успеем к пятнице?');
    const { pendingId, targetId } = await deferUnit(routineId, runId, 'Отчёт за июль');

    // Первое решение пачку не разбирает: вопрос ещё открыт
    await callerLater().routine.answerQuestion({ pendingId: questionId, answer: 'Успеем' });
    expect(await undecidedOf(runId)).toBe(true);

    const applied = await callerLater().routine.decideDeferred({ pendingId, decision: 'approve' });
    expect(applied.status).toBe('applied');
    if (applied.status !== 'applied') throw new Error('не applied');
    expect(await undecidedOf(runId)).toBe(false);

    // Патч флажка — `system` (§9.6): иначе «отмени последнее» снимало бы его вместо действия
    const flag = await flagPatches(runId);
    expect(flag.length).toBe(1);
    expect(flag[0]?.source).toBe('system');
    expect(flag[0]?.actor_kind).toBe('ai');

    const undone = await undoLast(db, { actorUserId: owner });
    expect(undone.ok).toBe(true);
    // Отменено ПРИМЕНЁННОЕ действие: запись снова жива, а флажок остался снятым
    expect(await isArchived(targetId)).toBe(false);
    expect(await undecidedOf(runId)).toBe(false);

    // Повторное нажатие второго патча не пишет: снимать нечего, а лишнее действие журнала
    // на каждый клик — это шум в ленте владельца
    await callerLater().routine.decideDeferred({ pendingId, decision: 'approve' });
    expect(await flagPatches(runId)).toHaveLength(1);
  });

  test('единицы АРХИВНОГО прогона решаются, и флажок с него снимается: адресация по pendingId обходит `NOT archived` чтения прогона (Р-17)', async () => {
    const { routineId, runId } = await batchRun('Архивный прогон');
    const { pendingId, targetId } = await deferUnit(routineId, runId, 'Список покупок');
    await execute(db, {
      actorUserId: owner,
      actorKind: 'owner',
      source: 'ui',
      operations: [{ tool: 'entity_update', input: { id: runId, archived: true } }],
    });
    expect(await isArchived(runId)).toBe(true);

    const applied = await callerLater().routine.decideDeferred({ pendingId, decision: 'approve' });
    expect(applied.status).toBe('applied');
    expect(await isArchived(targetId)).toBe(true);
    // Р-17 оказался мягче, чем ждал план: `NOT archived` стоит на ЧТЕНИИ прогона
    // (`runById`), а правку архивной записи executor не запрещает — процедуры единиц не
    // читают прогон вовсе, и бухгалтерия доводится до конца даже по откаченному прогону
    expect(await undecidedOf(runId)).toBe(false);
    // И пачка архивного прогона по-прежнему читается: `runUnits` тоже не ходит через runById
    expect((await caller().routine.runUnits({ runId })).map((u) => u.fate)).toEqual(['approved']);
  });
});

describe('routine.runUnits', () => {
  test('единицы прогона с судьбами и карточками, в порядке постановки; предложение прогона в списке НЕТ (Б5)', async () => {
    const { routineId, runId } = await batchRun('Список пачки');
    const questionId = await askUnit(routineId, runId, 'Какой вариант?', ['А', 'Б']);
    const { pendingId, targetId } = await deferUnit(routineId, runId, 'Акт сверки');
    // Предложение того же прогона — под тем же run_id, но без `kind`
    const proposalId = pendingMessageId(owner, `proposal:${runId}`);
    await withIdentity(db, owner, async (tx) =>
      createPending(tx, {
        threadId: await ensureEntityThread(tx, owner, routineId),
        actor: { userId: owner, kind: 'ai', source: 'routine', runId },
        tool: 'batch_execute',
        input: { batch_id: proposalId, operations: [] },
        level: 'explicit-confirmation',
        dedupeKey: `proposal:${runId}`,
        clock: () => T0,
        content: 'Предложение рутины: 1 правка',
        summary: '1 правка',
        card: {
          kind: 'proposal_card',
          pendingId: proposalId,
          runId,
          routineId,
          summary: '1 правка',
          explanation: EXPLANATION,
        },
      }),
    );

    await callerLater().routine.answerQuestion({ pendingId: questionId, answer: 'А', option: 0 });
    const units = await caller().routine.runUnits({ runId });
    expect(units.map((u) => u.pendingId)).toEqual([questionId, pendingId]);
    expect(units[0]).toMatchObject({
      kind: 'question',
      question: 'Какой вариант?',
      options: ['А', 'Б'],
      fate: 'answered',
      answer: 'А',
      card: { kind: 'question_card', pendingId: questionId, runId, routineId },
    });
    expect(units[1]).toMatchObject({
      kind: 'action',
      tool: 'entity_update',
      fate: 'open',
      card: {
        kind: 'deferred_action_card',
        pendingId,
        summary: 'Архивация: «Акт сверки»',
        rows: [{ field: 'archived', before: 'false', after: 'true' }],
      },
    });
    expect((units[1]?.input as { id?: string }).id).toBe(targetId);
  });

  test('у прогона без единиц — пустой список, а не отказ', async () => {
    const { runId } = await batchRun('Пустая пачка');
    expect(await caller().routine.runUnits({ runId })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// «Принять все» (D42 ОЧ.11; приёмки 6, 10, 19)
// ---------------------------------------------------------------------------

describe('routine.decideAll', () => {
  test('одна протухшая среди трёх: два applied и один stale с расхождениями; вопрос не тронут; порядок сводки — порядок пачки; повтор кнопки работы не делает (приёмка 6)', async () => {
    const { routineId, runId } = await batchRun('Принять все');
    const questionId = await askUnit(routineId, runId, 'Звонить подрядчику сегодня?', [
      'Да',
      'Нет',
    ]);
    const first = await deferUnit(routineId, runId, 'Акт сверки за май');
    const stale = await deferUnit(routineId, runId, 'Акт сверки за июнь', {
      aspects: { 'orbis/task': { status: 'done' } },
    });
    const last = await deferUnit(routineId, runId, 'Акт сверки за июль');
    // Правка владельца своей рукой — то, обо что разбивается предусловие средней единицы
    await ownerSets(stale.targetId, 'in_progress');

    const summary = await callerLater().routine.decideAll({ runId });

    // Порядок сводки = порядок пачки (`created_at, id` — контракт listRunUnits): экран
    // рисует её тем же списком, что и карточки, а два нажатия обходят единицы одинаково
    expect(summary.map((s) => s.pendingId)).toEqual([
      first.pendingId,
      stale.pendingId,
      last.pendingId,
    ]);
    expect(summary.map((s) => s.status)).toEqual(['applied', 'stale', 'applied']);
    const middle = summary[1];
    if (middle?.status !== 'stale') throw new Error('средняя единица обязана протухнуть');
    expect(middle.mismatches).toEqual([
      { property: 'orbis/task_status', expected: ['inbox'], actual: 'in_progress' },
    ]);
    // Протухшая соседей не блокирует: обе применены, её цель не тронута
    expect(await isArchived(first.targetId)).toBe(true);
    expect(await isArchived(last.targetId)).toBe(true);
    expect(await isArchived(stale.targetId)).toBe(false);

    // Вопрос кнопка не трогает: «принять» его нельзя вовсе (ОЧ.11), и открытым он
    // продолжает держать флажок пачки
    const units = await caller().routine.runUnits({ runId });
    expect(units.find((u) => u.pendingId === questionId)?.fate).toBe('open');
    expect(await undecidedOf(runId)).toBe(true);

    // Повтор кнопки: открытых действий не осталось — сводка пуста, журнал не вырос
    expect(await callerLater().routine.decideAll({ runId })).toEqual([]);
    expect(
      (await actionsOf(owner)).filter((a) => a.run_id === runId && a.source === 'routine'),
    ).toHaveLength(2);
  }, 20_000);

  test('пачка из одних действий: кнопка разбирает её до конца — флажок снят ЯДРОМ решения, своей бухгалтерии у decideAll нет', async () => {
    const { routineId, runId } = await batchRun('Пачка без вопросов');
    const a = await deferUnit(routineId, runId, 'Договор аренды гаража');
    const b = await deferUnit(routineId, runId, 'Смета подрядчика на кровлю');
    expect(await undecidedOf(runId)).toBe(true);

    const summary = await callerLater().routine.decideAll({ runId });
    expect(summary.map((s) => s.status)).toEqual(['applied', 'applied']);
    expect(await isArchived(a.targetId)).toBe(true);
    expect(await isArchived(b.targetId)).toBe(true);
    expect(await undecidedOf(runId)).toBe(false);
  }, 20_000);

  test('прогон без единиц → пустая сводка, а не отказ; отклонённую владельцем единицу кнопка не воскрешает', async () => {
    const { routineId, runId } = await batchRun('Пустая пачка и отказ');
    expect(await callerLater().routine.decideAll({ runId })).toEqual([]);

    const rejected = await deferUnit(routineId, runId, 'Черновик сметы');
    await callerLater().routine.decideDeferred({
      pendingId: rejected.pendingId,
      decision: 'reject',
    });
    // Кнопка берёт только ОТКРЫТЫЕ единицы: «Принять все» не отменяет прежний отказ
    expect(await callerLater().routine.decideAll({ runId })).toEqual([]);
    expect(await isArchived(rejected.targetId)).toBe(false);
  });

  test('предложение propose-прогона кнопка не трогает (проба по kind), decideProposal работает как прежде (приёмка 19)', async () => {
    const p = await proposed('Пачка рядом с предложением');
    const unit = await deferUnit(p.routineId, p.runId, 'Скан договора');

    const summary = await callerLater().routine.decideAll({ runId: p.runId });
    expect(summary.map((s) => s.pendingId)).toEqual([unit.pendingId]);
    expect(summary[0]?.status).toBe('applied');
    expect(await isArchived(unit.targetId)).toBe(true);
    // План предложения не исполнен, статус на прогоне прежний
    expect((await runAspect(p.runId)).proposal?.status).toBe('pending');
    expect((await aspectsOf(owner, p.taskId))['orbis/task']?.status).toBe('inbox');

    const decided = await callerLater().routine.decideProposal({
      runId: p.runId,
      pendingId: p.pendingId,
      decision: 'approve',
    });
    expect(decided.status).toBe('applied');
    expect((await runAspect(p.runId)).proposal?.status).toBe('approved');
    expect((await aspectsOf(owner, p.taskId))['orbis/task']?.status).toBe('planned');
  }, 20_000);

  test('два одновременных «Принять все»: обе сводки вернулись, применение одно — журнал не вырос (N replay’ев)', async () => {
    const { routineId, runId } = await batchRun('Два нажатия');
    const a = await deferUnit(routineId, runId, 'Счёт за март');
    const b = await deferUnit(routineId, runId, 'Счёт за апрель');

    const [left, right] = await Promise.all([
      callerLater().routine.decideAll({ runId }),
      callerLater().routine.decideAll({ runId }),
    ]);
    // Кто из двух увидел единицы открытыми — гонка, и сводки могут разойтись длиной.
    // Чего гонка НЕ вправе дать — второго применения: каждое «Принять» идемпотентно по
    // batchId (приёмка 10), а обход в одном порядке разводит захваты замков единиц
    for (const item of [...left, ...right]) {
      expect(['applied', 'already']).toContain(item.status);
    }
    expect(await isArchived(a.targetId)).toBe(true);
    expect(await isArchived(b.targetId)).toBe(true);
    expect(
      (await actionsOf(owner)).filter((x) => x.run_id === runId && x.source === 'routine'),
    ).toHaveLength(2);
  }, 20_000);
});
