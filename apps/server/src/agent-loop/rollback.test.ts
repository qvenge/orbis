// apps/server/src/agent-loop/rollback.test.ts
// Откат прогона (С12, инвариант 7): серия Undo §7.8 по действиям прогона в обратном
// порядке — с предпроверкой, что затронутые сущности с тех пор не менялись. Против живой
// БД: половина смысла теста в том, ЧТО именно лежит в журнале после настоящих глаголов,
// а не в моках. Прямые вызовы rollbackRun (роутер — трансляция, его тесты рядом).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { ClaimTaskResult, FinishResult, RunStepResult } from '@orbis/shared';
import { eq, sql } from 'drizzle-orm';
import { appDb, freshUserId, requireEnv, truncateAll } from '../../test/helpers';
import { entities } from '../db/schema';
import { withIdentity } from '../db/with-identity';
import type { ActionRecord } from '../executor/types';
import { undoAction } from '../executor/undo';
import { appRouter } from '../router';
import { agentLoopHelpers, T0 } from '../test/agent-loop-helpers';
import { dispatchTool } from '../tools/dispatch';
import { createCallerFactory } from '../trpc';
import { ROLLBACK_NOTE, rollbackRun } from './rollback';
import { sweepStaleRuns } from './sweep';

requireEnv();

const { db, client } = appDb();
const { actionsOf, link, seedEntity, worker, workerGrant } = agentLoopHelpers(db);
const createCaller = createCallerFactory(appRouter);

const MINUTE = 60_000;

function okResult<T>(r: Awaited<ReturnType<typeof dispatchTool>>): T {
  if (r.status !== 'ok') throw new Error(`ожидался ok, получено: ${JSON.stringify(r)}`);
  return r.result as T;
}

/** Свойства строки — новая правда сущности (§А1-1): её и восстанавливает откат. */
async function propsOf(owner: string, id: string): Promise<Record<string, unknown>> {
  const rows = await withIdentity(db, owner, (tx) =>
    tx.select({ props: entities.props }).from(entities).where(eq(entities.id, id)),
  );
  const row = rows[0];
  if (!row) throw new Error(`сущность ${id} не найдена`);
  return row.props as Record<string, unknown>;
}

/** Архивирован ли прогон: инверсия entity_create — архивация, а не удаление (§7.8). */
async function isArchived(owner: string, id: string): Promise<boolean> {
  const rows = await withIdentity(db, owner, (tx) =>
    tx.select({ archived: entities.archived }).from(entities).where(eq(entities.id, id)),
  );
  const row = rows[0];
  if (!row) throw new Error(`сущность ${id} не найдена`);
  return row.archived;
}

/** Сколько undo-сообщений §7.8 в журнале владельца — «откачено ли хоть что-то». */
async function undoMessages(owner: string): Promise<number> {
  const rows = await withIdentity(db, owner, (tx) =>
    tx.execute(sql`SELECT id FROM chat_messages WHERE metadata @> '{"type":"undo"}'::jsonb`),
  );
  return [...rows].length;
}

/** Действие журнала, записанное против прогона, — по системному источнику (подметание). */
async function actionOfRun(owner: string, runId: string, source: string): Promise<ActionRecord> {
  const found = (await actionsOf(owner)).filter((a) => a.run_id === runId && a.source === source);
  const first = found[0];
  if (first === undefined) throw new Error(`действия прогона ${runId} с source=${source} нет`);
  return first;
}

interface Scene {
  owner: string;
  grantId: string;
  ticketId: string;
}

/** Владелец с проектом, назначенным исполнителю тикетом и живым грантом. */
async function scene(title: string): Promise<Scene> {
  const owner = freshUserId();
  const grantId = await workerGrant(owner, `исполнитель отката (${title})`);
  const project = await seedEntity(owner, {
    title: `Проект отката (${title})`,
    tags: [],
    aspects: { 'orbis/project': { stage: 'active' } },
  });
  const ticket = await seedEntity(owner, {
    title,
    tags: [],
    aspects: {
      'orbis/task': { status: 'planned' },
      'orbis/assignment': { executor: 'agent', grant_id: grantId },
    },
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

    const out = await rollbackRun(db, { actorUserId: owner, runId });

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
      ownerId: owner,
      actorKind: 'owner',
      clock: () => new Date(T0.getTime() + 60 * MINUTE),
    });
    expect(swept).toEqual({ swept: 1 });
    const sweepAction = await actionOfRun(owner, runId, 'system');

    const out = await rollbackRun(db, { actorUserId: owner, runId });

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

    const a = createCaller({ actorUserId: owner, actorKind: 'owner', db, clientVersion: null });
    await a.agentRun.answerCheckpoint({ ticketId, runId, answer: 'Postgres' });
    const answerAction = await actionOfRun(owner, runId, 'ui');

    const undoneBefore = await undoMessages(owner);
    const out = await rollbackRun(db, { actorUserId: owner, runId });

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
    const a = createCaller({ actorUserId: owner, actorKind: 'owner', db, clientVersion: null });
    await a.entity.update({ id: ticketId, aspects: { 'orbis/task': { priority: 'high' } } });
    const edit = (await actionsOf(owner)).find((x) => x.source === 'ui' && x.run_id === undefined);
    if (edit === undefined) throw new Error('правка владельца не попала в журнал');

    await dispatchTool(ctx, 'orbis_finish', { run_id: runId, report: 'Готово' });

    const undoneBefore = await undoMessages(owner);
    const out = await rollbackRun(db, { actorUserId: owner, runId });

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
    const undone = await undoAction(db, { actorUserId: owner, actionId: step.action_id });
    expect(undone.ok).toBe(true);

    const out = await rollbackRun(db, { actorUserId: owner, runId });

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
    const owner = freshUserId();
    const before = await undoMessages(owner);
    const out = await rollbackRun(db, { actorUserId: owner, runId: crypto.randomUUID() });
    expect(out).toEqual({ ok: true, undone: [], note: ROLLBACK_NOTE });
    expect(await undoMessages(owner)).toBe(before);
  });
});
