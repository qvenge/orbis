// apps/server/src/agent-loop/rollback.test.ts
// Откат прогона (С12, инвариант 7): серия Undo §7.8 по действиям прогона в обратном
// порядке — с предпроверкой, что затронутые сущности с тех пор не менялись. Против живой
// БД: половина смысла теста в том, ЧТО именно лежит в журнале после настоящих глаголов,
// а не в моках. Прямые вызовы rollbackRun (роутер — трансляция, его тесты рядом).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { ClaimTaskResult, FinishResult, GraphId, RunStepResult } from '@orbis/shared';
import { BUILTIN_SUBSCRIPTION_DEFS, type BudgetSubscription } from '@orbis/shared';
import { eq, sql } from 'drizzle-orm';
import { adminDb, appDb, freshGraph, personal, requireEnv, truncateAll } from '../../test/helpers';
import { actionsOf, wholeJournalOf } from '../../test/journal-helpers';
import { entities } from '../db/schema';
import { withIdentity } from '../db/with-identity';
import { execute } from '../executor/executor';
import { makeJournalSink } from '../executor/journal';
import type { JournalEntry } from '../executor/journal-read';
import { undoAction } from '../executor/undo';
import { effectiveRegistry } from '../registry/cache';
import { appRouter } from '../router';
import { agentLoopHelpers, T0 } from '../test/agent-loop-helpers';
import { dispatchTool } from '../tools/dispatch';
import { createCallerFactory } from '../trpc';
import { ROLLBACK_NOTE, rollbackRun } from './rollback';
import { sweepStaleRuns } from './sweep';

requireEnv();

const { db, client } = appDb();
const { link, seedEntity, seedRoutine, seedRoutineRun, worker, workerGrant } = agentLoopHelpers(db);
const createCaller = createCallerFactory(appRouter);

const MINUTE = 60_000;

function okResult<T>(r: Awaited<ReturnType<typeof dispatchTool>>): T {
  if (r.status !== 'ok') throw new Error(`ожидался ok, получено: ${JSON.stringify(r)}`);
  return r.result as T;
}

/** Свойства строки — новая правда сущности (§А1-1): её и восстанавливает откат. */
async function propsOf(owner: GraphId, id: string): Promise<Record<string, unknown>> {
  const rows = await withIdentity(db, personal(owner), (tx) =>
    tx.select({ props: entities.props }).from(entities).where(eq(entities.id, id)),
  );
  const row = rows[0];
  if (!row) throw new Error(`сущность ${id} не найдена`);
  return row.props as Record<string, unknown>;
}

/** Архивирован ли прогон: инверсия entity_create — архивация, а не удаление (§7.8). */
async function isArchived(owner: GraphId, id: string): Promise<boolean> {
  const rows = await withIdentity(db, personal(owner), (tx) =>
    tx.select({ archived: entities.archived }).from(entities).where(eq(entities.id, id)),
  );
  const row = rows[0];
  if (!row) throw new Error(`сущность ${id} не найдена`);
  return row.archived;
}

/** Сколько записей отмены §7.8 в журнале владельца — «откачено ли хоть что-то». */
async function undoMessages(owner: GraphId): Promise<number> {
  return (await wholeJournalOf(owner)).filter((e) => e.type === 'undo').length;
}

/** Действие журнала, записанное против прогона, — по системному источнику (подметание). */
async function actionOfRun(owner: GraphId, runId: string, source: string): Promise<JournalEntry> {
  const found = (await actionsOf(owner)).filter((a) => a.runId === runId && a.source === source);
  const first = found[0];
  if (first === undefined) throw new Error(`действия прогона ${runId} с source=${source} нет`);
  return first;
}

interface Scene {
  owner: GraphId;
  grantId: string;
  ticketId: string;
}

/** Владелец с проектом, назначенным исполнителю тикетом и живым грантом. */
async function scene(title: string): Promise<Scene> {
  const owner = await freshGraph();
  const grantId = await workerGrant(owner, `исполнитель отката (${title})`);
  const project = await seedEntity(owner, {
    title: `Проект отката (${title})`,
    tags: [],
    props: { 'orbis/project_stage': 'active' },
    aspects: ['orbis/project'],
  });
  const ticket = await seedEntity(owner, {
    title,
    tags: [],
    props: { 'orbis/task_status': 'planned', 'orbis/executor': 'agent', 'orbis/grant': grantId },
    aspects: ['orbis/task', 'orbis/assignment'],
  });
  await link(owner, project.id, ticket.id, 'ticket');
  return { owner, grantId, ticketId: ticket.id };
}

beforeAll(async () => {
  await truncateAll();
});

afterAll(async () => {
  await client.end();
});

describe('rollbackRun (С12, инвариант 7)', () => {
  test('откат прогона claim→step→finish: тикет вернулся в planned, прогон архивирован, undone = 3 action id в обратном порядке (приёмка 13)', async () => {
    const { owner, grantId, ticketId } = await scene('Тикет полного отката');
    const ctx = worker(owner, grantId);
    const claim = okResult<ClaimTaskResult>(
      await dispatchTool(ctx, 'orbis_claim_task', { ticket_id: ticketId }),
    );
    const runId = claim.run_id;
    const step = okResult<RunStepResult>(
      await dispatchTool(ctx, 'orbis_run_step', {
        run_id: runId,
        summary: 'Завёл ветку и починил тест',
        external: true,
      }),
    );
    const finish = okResult<FinishResult>(
      await dispatchTool(ctx, 'orbis_finish', { run_id: runId, report: 'Готово, проверь' }),
    );
    expect(await propsOf(owner, ticketId)).toMatchObject({ 'orbis/task_status': 'waiting' });

    const out = await rollbackRun(db, { identity: personal(owner), runId });

    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error('ожидался успешный откат');
    expect(out.undone).toEqual([finish.action_id, step.action_id, claim.action_id]);
    expect(out.note).toBe(ROLLBACK_NOTE);
    // Тикет — в том состоянии, в котором его застал захват (inverse захвата), а не в
    // in_progress: откат снимает ВЕСЬ прогон, а не последний его глагол
    expect(await propsOf(owner, ticketId)).toMatchObject({ 'orbis/task_status': 'planned' });
    // `toEqual` по всему набору свойств не годится: у тикета есть ещё назначение и
    // вычисленные предки. Смысл прежней проверки — «хвоста прошлого ожидания нет».
    expect(await propsOf(owner, ticketId)).not.toHaveProperty('orbis/waiting_for');
    // Восстановлена НОВАЯ правда (§А1-1), а не только её проекция: единица отката —
    // свойство, и проверять надо ту колонку, из которой проекция и считается
    const props = await propsOf(owner, ticketId);
    expect(props['orbis/task_status']).toBe('planned');
    // Назначение прогон не трогал — откат его и не касается
    expect(props['orbis/executor']).toBe('agent');
    expect(await isArchived(owner, runId)).toBe(true);
  });

  test('откат включает подметание прогона (source=system): claim→step→подметание откатываются вместе', async () => {
    const { owner, grantId, ticketId } = await scene('Тикет подметённого прогона');
    const ctx = worker(owner, grantId);
    const claim = okResult<ClaimTaskResult>(
      await dispatchTool(ctx, 'orbis_claim_task', { ticket_id: ticketId }),
    );
    const runId = claim.run_id;
    const step = okResult<RunStepResult>(
      await dispatchTool(ctx, 'orbis_run_step', { run_id: runId, summary: 'Начал и пропал' }),
    );
    // Часы подметания — на час позже часов исполнителя: прогон брошен по порогу С6
    const swept = await sweepStaleRuns(db, {
      identity: personal(owner),
      actorKind: 'owner',
      clock: () => new Date(T0.getTime() + 60 * MINUTE),
    });
    expect(swept).toEqual({ swept: 1 });
    const sweepAction = await actionOfRun(owner, runId, 'system');

    const out = await rollbackRun(db, { identity: personal(owner), runId });

    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error('ожидался успешный откат');
    // Подметание — часть истории прогона, а не «чужое изменение»: «отмени последнее» его
    // пропускает (source=system), точечный откат прогона обязан его включать
    expect(out.undone).toEqual([sweepAction.id, step.action_id, claim.action_id]);
    expect(await propsOf(owner, ticketId)).toMatchObject({ 'orbis/task_status': 'planned' });
    // `toEqual` по всему набору свойств не годится: у тикета есть ещё назначение и
    // вычисленные предки. Смысл прежней проверки — «хвоста прошлого ожидания нет».
    expect(await propsOf(owner, ticketId)).not.toHaveProperty('orbis/waiting_for');
    expect(await isArchived(owner, runId)).toBe(true);
  });

  test('конфликт: владелец ответил на чекпойнт после прогона → ok:false, conflicts указывает тикет и action ответа; ничего не откачено (инвариант 7)', async () => {
    const { owner, grantId, ticketId } = await scene('Тикет с ответом владельца');
    const ctx = worker(owner, grantId);
    const claim = okResult<ClaimTaskResult>(
      await dispatchTool(ctx, 'orbis_claim_task', { ticket_id: ticketId }),
    );
    const runId = claim.run_id;
    await dispatchTool(ctx, 'orbis_run_step', { run_id: runId, summary: 'Уперся в развилку' });
    await dispatchTool(ctx, 'orbis_checkpoint', { run_id: runId, question: 'Какую БД брать?' });

    const a = createCaller({
      identity: personal(owner),
      actorKind: 'owner',
      db,
      clientVersion: null,
    });
    await a.agentRun.answerCheckpoint({ ticketId, runId, answer: 'Postgres' });
    const answerAction = await actionOfRun(owner, runId, 'ui');

    const undoneBefore = await undoMessages(owner);
    const out = await rollbackRun(db, { identity: personal(owner), runId });

    expect(out.ok).toBe(false);
    if (out.ok) throw new Error('ожидался конфликт');
    expect(out.reason).toBe('conflict');
    if (out.reason !== 'conflict') throw new Error('ожидался reason=conflict');
    expect(out.conflicts).toContainEqual(
      expect.objectContaining({
        entityId: ticketId,
        actionId: answerAction.id,
        source: 'ui',
      }),
    );
    // Ничего не откачено: ни одного undo-сообщения и состояния на месте
    expect(await undoMessages(owner)).toBe(undoneBefore);
    expect(await propsOf(owner, ticketId)).toMatchObject({ 'orbis/task_status': 'planned' });
    // Ответ владельца на месте: вопрос закрыт исходом `answered` (V1, D38), не снят откатом
    expect(await propsOf(owner, runId)).toMatchObject({
      'orbis/run_outcome': 'answered',
    });
    expect(await isArchived(owner, runId)).toBe(false);
  });

  test('чужая правка тикета МЕЖДУ claim и finish → ok:false, conflicts указывает тикет и action правки; ничего не откачено (инвариант 7)', async () => {
    const { owner, grantId, ticketId } = await scene('Тикет с правкой между шагами');
    const ctx = worker(owner, grantId);
    const claim = okResult<ClaimTaskResult>(
      await dispatchTool(ctx, 'orbis_claim_task', { ticket_id: ticketId }),
    );
    const runId = claim.run_id;

    // Владелец правит тот же тикет ПОКА ПРОГОН ИДЁТ — самый обычный случай: прогон длится
    // часами. Правка ложится в журнал МЕЖДУ действиями прогона, и окно предпроверки «после
    // последнего действия» её бы не увидело
    const a = createCaller({
      identity: personal(owner),
      actorKind: 'owner',
      db,
      clientVersion: null,
    });
    await a.entity.update({
      id: ticketId,
      props: { 'orbis/priority': 'high' },
    });
    const edit = (await actionsOf(owner)).find((x) => x.source === 'ui' && x.runId === undefined);
    if (edit === undefined) throw new Error('правка владельца не попала в журнал');

    await dispatchTool(ctx, 'orbis_finish', { run_id: runId, report: 'Готово' });

    const undoneBefore = await undoMessages(owner);
    const out = await rollbackRun(db, { identity: personal(owner), runId });

    expect(out.ok).toBe(false);
    if (out.ok) throw new Error('ожидался конфликт');
    if (out.reason !== 'conflict') throw new Error('ожидался reason=conflict');
    expect(out.conflicts).toContainEqual(
      expect.objectContaining({ entityId: ticketId, actionId: edit.id, source: 'ui' }),
    );
    // Ничего не откачено, и приоритет владельца на месте. С единицей отката «свойство»
    // (§А7-4) inverse захвата унёс бы только `orbis/task_status`, а не весь `orbis/task`,
    // — но конфликт всё равно ОБЯЗАН быть показан: `touchedEntities` считает по сущности
    // (TOUCHED_KEYS — uuid-ключи payload'а), а не по свойству, и это осознанная
    // перестраховка инварианта 7: лучше лишняя строка конфликта, чем затёртая правка
    // владельца в том же свойстве
    expect(await undoMessages(owner)).toBe(undoneBefore);
    expect(await propsOf(owner, ticketId)).toMatchObject({
      'orbis/task_status': 'waiting',
      'orbis/priority': 'high',
    });
    expect(await isArchived(owner, runId)).toBe(false);
  });

  test('шаг уже отменён вручную (ai.undo) → пропускается, остальное откатывается', async () => {
    const { owner, grantId, ticketId } = await scene('Тикет с отменённым шагом');
    const ctx = worker(owner, grantId);
    const claim = okResult<ClaimTaskResult>(
      await dispatchTool(ctx, 'orbis_claim_task', { ticket_id: ticketId }),
    );
    const runId = claim.run_id;
    const step = okResult<RunStepResult>(
      await dispatchTool(ctx, 'orbis_run_step', { run_id: runId, summary: 'Лишний шаг' }),
    );
    const finish = okResult<FinishResult>(
      await dispatchTool(ctx, 'orbis_finish', { run_id: runId, report: 'Готово' }),
    );
    const undone = await undoAction(db, { identity: personal(owner), actionId: step.action_id });
    expect(undone.ok).toBe(true);

    const out = await rollbackRun(db, { identity: personal(owner), runId });

    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error('ожидался успешный откат');
    // Отменённое второй раз не отменяется: undoAction по нему вернул бы VALIDATION и
    // весь откат встал бы «частичным» на ровном месте
    expect(out.undone).toEqual([finish.action_id, claim.action_id]);
    expect(out.undone).not.toContain(step.action_id);
    expect(await propsOf(owner, ticketId)).toMatchObject({ 'orbis/task_status': 'planned' });
    // `toEqual` по всему набору свойств не годится: у тикета есть ещё назначение и
    // вычисленные предки. Смысл прежней проверки — «хвоста прошлого ожидания нет».
    expect(await propsOf(owner, ticketId)).not.toHaveProperty('orbis/waiting_for');
    expect(await isArchived(owner, runId)).toBe(true);
  });

  test('откатывать нечего (прогона нет или он чужой) → ok с пустым undone, журнал не тронут', async () => {
    const owner = await freshGraph();
    const before = await undoMessages(owner);
    const out = await rollbackRun(db, { identity: personal(owner), runId: crypto.randomUUID() });
    expect(out).toEqual({ ok: true, undone: [], note: ROLLBACK_NOTE });
    expect(await undoMessages(owner)).toBe(before);
  });
});

/**
 * Ключи РЕЕСТРА в окне конфликтов (рулинг R-11, гейт задачи 4 I-1). Рутина в `act` вправе править реестр
 * (`routineToolAllowed` закрывает только `batch_execute` и `undo_last`), и её обратная операция — тоже правка реестра.
 * Правка владельца той же подписки после прогона обязана стать конфликтом отката, а не молча снестись серией отмен
 * (инвариант 7): ключ подписки — не uuid записи, и окно, смотрящее только на записи графа, её не увидело бы.
 */
describe('откат прогона видит ключи реестра (R-11)', () => {
  const sink = makeJournalSink();
  const SUBSCRIPTION = 'orbis/budget-overview';
  const SURFACE = 'finance/budget-overview';
  const BUDGET_SUB = BUILTIN_SUBSCRIPTION_DEFS.find((d) => d.id === SUBSCRIPTION)
    ?.definition as BudgetSubscription;
  const withWarnAt = (warn_at: string): BudgetSubscription => ({
    ...BUDGET_SUB,
    alerts: { ...BUDGET_SUB.alerts, warn_at },
  });
  const warnAtOf = async (owner: GraphId) =>
    (
      (
        await withIdentity(db, personal(owner), (tx) => effectiveRegistry(tx, owner))
      ).subscriptions.get(SUBSCRIPTION)?.definition as BudgetSubscription
    ).alerts.warn_at;

  test('рутина в act правит подписку, владелец — её же; «Откатить прогон» → конфликт, правка владельца цела', async () => {
    const owner = await freshGraph();
    const routineId = await seedRoutine(owner, {
      routine: { 'orbis/routine_mode': 'act', 'orbis/allowed_tools': ['subscription_set'] },
    });
    const { runId } = await seedRoutineRun(owner, { routineId });
    // Модельная мутация режима `act` — тем же исполнением, что делает диспатч рутины (source routine + run_id)
    const byRoutine = await execute(
      db,
      {
        identity: personal(owner),
        actorKind: 'ai',
        source: 'routine',
        runId,
        operations: [
          {
            tool: 'subscription_set',
            input: { id: SUBSCRIPTION, surface: SURFACE, definition: withWarnAt('0.5') },
          },
        ],
      },
      { sink },
    );
    if (!byRoutine.ok) throw new Error(JSON.stringify(byRoutine.error));
    const byOwner = await execute(
      db,
      {
        identity: personal(owner),
        actorKind: 'owner',
        source: 'ui',
        operations: [
          {
            tool: 'subscription_set',
            input: { id: SUBSCRIPTION, surface: SURFACE, definition: withWarnAt('0.7') },
          },
        ],
      },
      { sink },
    );
    if (!byOwner.ok) throw new Error(JSON.stringify(byOwner.error));

    const out = await rollbackRun(db, { identity: personal(owner), runId });
    expect(out.ok).toBe(false);
    if (out.ok || out.reason !== 'conflict')
      throw new Error(`ожидался конфликт: ${JSON.stringify(out)}`);
    expect(out.conflicts.map((c) => [c.entityId, c.actionId, c.source])).toEqual([
      [SUBSCRIPTION, byOwner.actionId, 'ui'],
    ]);
    // Предпроверка ничего не отменила: правка владельца на месте, отмен нет
    expect(await warnAtOf(owner)).toBe('0.7');
    expect((await wholeJournalOf(owner)).filter((e) => e.type === 'undo')).toEqual([]);
  });

  // К-22 для ключей реестра: запись отмены несёт операции (применённый inverse) по тому же ключу подписки, и окно
  // конфликтов, просматривающее записи графа по времени, обязано не принять её за чужую правку. Владелец поправил
  // подписку и сам отменил свою правку — чужой правки в окне нет, прогон откатывается.
  test('владелец поправил подписку и сам отменил правку — запись отмены не конфликт, прогон откатывается', async () => {
    const owner = await freshGraph();
    const routineId = await seedRoutine(owner, {
      routine: { 'orbis/routine_mode': 'act', 'orbis/allowed_tools': ['subscription_set'] },
    });
    const { runId } = await seedRoutineRun(owner, { routineId });
    const set = (warnAt: string, over: { source: 'routine' | 'ui'; runId?: string }) =>
      execute(
        db,
        {
          identity: personal(owner),
          actorKind: over.source === 'routine' ? 'ai' : 'owner',
          source: over.source,
          ...(over.runId !== undefined && { runId: over.runId }),
          operations: [
            {
              tool: 'subscription_set',
              input: { id: SUBSCRIPTION, surface: SURFACE, definition: withWarnAt(warnAt) },
            },
          ],
        },
        { sink },
      );
    const byRoutine = await set('0.5', { source: 'routine', runId });
    if (!byRoutine.ok) throw new Error(JSON.stringify(byRoutine.error));
    const byOwner = await set('0.7', { source: 'ui' });
    if (!byOwner.ok) throw new Error(JSON.stringify(byOwner.error));
    const undone = await undoAction(db, { identity: personal(owner), actionId: byOwner.actionId });
    expect(undone.ok).toBe(true);
    expect(await warnAtOf(owner)).toBe('0.5');

    const out = await rollbackRun(db, { identity: personal(owner), runId });
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error(`ожидался откат: ${JSON.stringify(out)}`);
    expect(out.undone).toEqual([byRoutine.actionId]);
    expect(await warnAtOf(owner)).toBe(BUDGET_SUB.alerts.warn_at);
  });
});

// ---------------------------------------------------------------------------
// Откат прогона рутины и правило отмены текста (§8.6 «Откат прогона», К-43, D37 п. 6; план А, задача 11): цепочка тела
// проверяется В ПРЕДПРОВЕРКЕ с раскруткой через любые записи отмены; правка текста между предпроверкой и серией
// останавливает серию отказом правила — `partial` с причиной `text_changed`.
// ---------------------------------------------------------------------------

describe('откат прогона рутины: цепочка тела в предпроверке, гонка — `partial` с причиной (§8.6, К-43)', () => {
  const admin = adminDb();
  const sink = makeJournalSink();
  afterAll(async () => {
    await admin.client.end();
  });

  async function bodyRow(id: string): Promise<{ body: string; rev: number }> {
    const rows = (await admin.db.execute(
      sql`SELECT body, body_revision FROM entities WHERE id = ${id}::uuid`,
    )) as unknown as Array<{ body: string; body_revision: number }>;
    const row = rows[0];
    if (row === undefined) throw new Error(`записи ${id} нет`);
    return { body: row.body, rev: row.body_revision };
  }

  /** Правка тела одним действием: работа прогона рутины (`routine` + `run_id`) или владелец в интерфейсе. */
  async function bodyEdit(
    owner: GraphId,
    id: string,
    body: string,
    by: { routineRun: string } | 'owner',
  ): Promise<string> {
    const r = await execute(
      db,
      {
        identity: personal(owner),
        ...(by === 'owner'
          ? { actorKind: 'owner' as const, source: 'ui' as const }
          : { actorKind: 'ai' as const, source: 'routine' as const, runId: by.routineRun }),
        operations: [
          {
            tool: 'entity_update',
            input: { id, body, expectedBodyRevision: (await bodyRow(id)).rev },
          },
        ],
      },
      { sink },
    );
    if (!r.ok) throw new Error(`правка тела: ${r.error.code} ${r.error.message}`);
    return r.actionId;
  }

  /** Прогон рутины в `act`, дважды правивший тело одной заметки: A1, затем A2. */
  async function twoEdits(title: string) {
    const owner = await freshGraph();
    const routineId = await seedRoutine(owner, {
      routine: { 'orbis/routine_mode': 'act', 'orbis/allowed_tools': ['entity_update'] },
    });
    const { runId } = await seedRoutineRun(owner, { routineId });
    const note = await seedEntity(owner, { title, tags: [], body: 'исходный' });
    const a1 = await bodyEdit(owner, note.id, 'рутина 1', { routineRun: runId });
    const a2 = await bodyEdit(owner, note.id, 'рутина 2', { routineRun: runId });
    return { owner, runId, noteId: note.id, a1, a2 };
  }

  test('рутина дважды правила тело одной заметки → откат проходит целиком: A2, затем A1 через раскрутку записи отмены A2', async () => {
    const { owner, runId, noteId, a1, a2 } = await twoEdits('Заметка двух правок');
    const out = await rollbackRun(db, { identity: personal(owner), runId });
    if (!out.ok) throw new Error(`ожидался откат: ${JSON.stringify(out)}`);
    expect(out.undone).toEqual([a2, a1]);
    expect((await bodyRow(noteId)).body).toBe('исходный');
  });

  test('владелец дописал после A2 → конфликт в предпроверке; серия не началась — записей отмены нет, текст владельца цел', async () => {
    const { owner, runId, noteId } = await twoEdits('Заметка с набором владельца');
    const typed = await bodyEdit(owner, noteId, 'рутина 2 + владелец', 'owner');
    const out = await rollbackRun(db, { identity: personal(owner), runId });
    if (out.ok || out.reason !== 'conflict') {
      throw new Error(`ожидался конфликт: ${JSON.stringify(out)}`);
    }
    // Окно чужих действий и цепочка тела называют ОДНУ правку — одна строка
    expect(out.conflicts.map((c) => [c.entityId, c.actionId, c.source])).toEqual([
      [noteId, typed, 'ui'],
    ]);
    expect(await undoMessages(owner)).toBe(0);
    expect((await bodyRow(noteId)).body).toBe('рутина 2 + владелец');
  });

  test('владелец отменил A2 отдельно (карточка `routine`), затем откат → проходит: A1 через раскрутку отмены владельцем', async () => {
    const { owner, runId, noteId, a1, a2 } = await twoEdits('Заметка с отменой владельца');
    const own = await undoAction(db, { identity: personal(owner), actionId: a2 });
    expect(own.ok).toBe(true);
    expect((await bodyRow(noteId)).body).toBe('рутина 1');
    const out = await rollbackRun(db, { identity: personal(owner), runId });
    if (!out.ok) throw new Error(`ожидался откат: ${JSON.stringify(out)}`);
    expect(out.undone).toEqual([a1]);
    expect((await bodyRow(noteId)).body).toBe('исходный');
  });

  test('три правки, среднюю (A2) владелец отменил до A3 → откат проходит целиком: A3, затем A1 — раскрутка от «до» A3 через запись отмены A2 посреди цепочки', async () => {
    const { owner, runId, noteId, a1, a2 } = await twoEdits('Заметка трёх правок');
    expect((await undoAction(db, { identity: personal(owner), actionId: a2 })).ok).toBe(true);
    // «до» A3 — запись отмены A2: предпроверка звена A1 обязана пройти её раскруткой, как правило в транзакции отмены A1
    const a3 = await bodyEdit(owner, noteId, 'рутина 3', { routineRun: runId });
    const out = await rollbackRun(db, { identity: personal(owner), runId });
    if (!out.ok) throw new Error(`ожидался откат: ${JSON.stringify(out)}`);
    expect(out.undone).toEqual([a3, a1]);
    expect((await bodyRow(noteId)).body).toBe('исходный');
  });

  test('текст сменил писатель без журнала → конфликт той же гранулярности {запись, «вне приложения»}; окно чужих действий его не видит', async () => {
    // После прогона — поверх A2; между A1 и A2 — внутри цепочки прогона: оба видны до первой отмены
    const after = await twoEdits('Заметка после прогона');
    await admin.db.execute(
      sql`UPDATE entities SET body = 'вне приложения' WHERE id = ${after.noteId}::uuid`,
    );
    const top = await rollbackRun(db, { identity: personal(after.owner), runId: after.runId });
    if (top.ok || top.reason !== 'conflict') {
      throw new Error(`ожидался конфликт: ${JSON.stringify(top)}`);
    }
    expect(top.conflicts.map((c) => [c.entityId, c.actionId, c.source])).toEqual([
      [after.noteId, null, 'outside'],
    ]);
    expect(await undoMessages(after.owner)).toBe(0);

    const owner = await freshGraph();
    const routineId = await seedRoutine(owner, {
      routine: { 'orbis/routine_mode': 'act', 'orbis/allowed_tools': ['entity_update'] },
    });
    const { runId } = await seedRoutineRun(owner, { routineId });
    const note = await seedEntity(owner, {
      title: 'Заметка внутри цепочки',
      tags: [],
      body: 'исходный',
    });
    await bodyEdit(owner, note.id, 'рутина 1', { routineRun: runId });
    await admin.db.execute(
      sql`UPDATE entities SET body = 'вне приложения' WHERE id = ${note.id}::uuid`,
    );
    const a2 = await bodyEdit(owner, note.id, 'рутина 2', { routineRun: runId });
    const mid = await rollbackRun(db, { identity: personal(owner), runId });
    if (mid.ok || mid.reason !== 'conflict') {
      throw new Error(`ожидался конфликт: ${JSON.stringify(mid)}`);
    }
    const a2At = (await actionsOf(owner)).find((e) => e.id === a2)?.createdAt.toISOString();
    expect(mid.conflicts).toEqual([
      { entityId: note.id, actionId: null, at: a2At as string, source: 'outside' },
    ]);
    expect(await undoMessages(owner)).toBe(0);
    expect((await bodyRow(note.id)).body).toBe('рутина 2');
  });

  test('сеанс владельца с нулевым итогом между правками прогона, им же отменённый: правило серии откажет на A1 — предпроверка видит это заранее (раскрутка от «до» A2 — шагом за записью отмены, как у правила)', async () => {
    const owner = await freshGraph();
    const routineId = await seedRoutine(owner, {
      routine: { 'orbis/routine_mode': 'act', 'orbis/allowed_tools': ['entity_update'] },
    });
    const { runId } = await seedRoutineRun(owner, { routineId });
    const note = await seedEntity(owner, { title: 'Заметка сеанса', tags: [], body: 'исходный' });
    await bodyEdit(owner, note.id, 'рутина 1', { routineRun: runId });
    // Сеанс правки текста: набрал и вернул текст к «рутина 1» (паузы короче 10 минут — одна запись сеанса)
    const caller = createCaller({
      identity: personal(owner),
      actorKind: 'owner',
      db,
      clientVersion: null,
    });
    for (const body of ['рутина 1 + набор', 'рутина 1']) {
      await caller.entity.update({
        id: note.id,
        body,
        expectedBodyRevision: (await bodyRow(note.id)).rev,
        autosave: true,
      });
    }
    const session = (await actionsOf(owner)).find((e) => e.textSession);
    if (session === undefined) throw new Error('сеанса правки текста нет');
    // Отмена сеанса текст не меняет (он уже «рутина 1») — колонка остаётся на отменённом сеансе
    expect((await undoAction(db, { identity: personal(owner), actionId: session.id })).ok).toBe(
      true,
    );
    const raw = (await admin.db.execute(
      sql`SELECT body_action_id::text AS raw FROM entities WHERE id = ${note.id}::uuid`,
    )) as unknown as Array<{ raw: string | null }>;
    expect(raw[0]?.raw).toBe(session.id);
    await bodyEdit(owner, note.id, 'рутина 2', { routineRun: runId });

    // Окно чужих действий отменённый сеанс не называет; правило в транзакции отмены A1 — назовёт (после A2 колонка —
    // запись отмены A2, её «до» — сеанс, а за записью отмены отменённое действие раскруткой не пропускается)
    const out = await rollbackRun(db, { identity: personal(owner), runId });
    if (out.ok || out.reason !== 'conflict') {
      throw new Error(`ожидался конфликт: ${JSON.stringify(out)}`);
    }
    expect(out.conflicts.map((c) => [c.entityId, c.actionId, c.source])).toEqual([
      [note.id, session.id, 'ui'],
    ]);
    // Серия не начиналась: единственная запись отмены — отмена сеанса владельцем
    expect(await undoMessages(owner)).toBe(1);
  });

  test('правка владельца легла между предпроверкой и серией (шов `beforeStages` серии) → `partial` с причиной `text_changed` и перечнем откаченного', async () => {
    const { owner, runId, noteId, a1, a2 } = await twoEdits('Заметка гонки');
    let calls = 0;
    let typed: string | undefined;
    const out = await rollbackRun(
      db,
      { identity: personal(owner), runId },
      {
        // Вторая транзакция серии (отмена A1): владелец дописывает текст своим соединением до того, как транзакция
        // отмены возьмёт замки, — правило §8.6 в ней увидит его набор
        beforeStages: async () => {
          calls += 1;
          if (calls === 2) typed = await bodyEdit(owner, noteId, 'рутина 1 + владелец', 'owner');
        },
      },
    );
    if (out.ok || out.reason !== 'partial') {
      throw new Error(`ожидался частичный откат: ${JSON.stringify(out)}`);
    }
    expect(typed).toBeDefined();
    expect(out.undone).toEqual([a2]);
    expect(out.failed.actionId).toBe(a1);
    expect(out.failed.reason).toBe('text_changed');
    expect(out.failed.error.code).toBe('UNDO_TEXT_CHANGED');
    expect(out.failed.error.message).toBe(
      'Текст изменён после прогона: «Заметка гонки» — откат остановлен, текст не тронут',
    );
    expect(out.failed.entries?.map((e) => [e.entityId, e.actorKind])).toEqual([[noteId, 'owner']]);
    // Текст владельца цел; отменено ровно A2
    expect((await bodyRow(noteId)).body).toBe('рутина 1 + владелец');
    expect(await undoMessages(owner)).toBe(1);
  });
});
