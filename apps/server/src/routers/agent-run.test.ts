// apps/server/src/routers/agent-run.test.ts
// Роутер agentRun (§9.1, С10/С12): владельческая половина круга — ответ на чекпойнт,
// подметание с экранов, откат прогона. Против живой БД, caller как в бою
// (createCallerFactory), глаголы исполнителя — через dispatchTool с worker-контекстом:
// иначе «ответ владельца» проверялся бы на руками вылепленном прогоне, а не на том,
// который оставляет настоящий агент.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { ClaimTaskResult, MyQueueResult } from '@orbis/shared';
import { TRPCError } from '@trpc/server';
import { appDb, freshUserId, requireEnv, truncateAll } from '../../test/helpers';
import type { ActionRecord } from '../executor/types';
import { appRouter } from '../router';
import { type AnyRecord, agentLoopHelpers } from '../test/agent-loop-helpers';
import { dispatchTool } from '../tools/dispatch';
import { createCallerFactory } from '../trpc';

requireEnv();

const { db, client } = appDb();
const { seedEntity, link, aspectsOf, actionsOf, workerGrant, worker } = agentLoopHelpers(db);
const createCaller = createCallerFactory(appRouter);

const MINUTE = 60_000;

/** Caller от лица владельца: ctx как в бою (§9.1); clientVersion=null — гейт пропускает. */
function callerFor(user: string) {
  return createCaller({ actorUserId: user, actorKind: 'owner', db, clientVersion: null });
}

function okResult<T>(r: Awaited<ReturnType<typeof dispatchTool>>): T {
  if (r.status !== 'ok') throw new Error(`ожидался ok, получено: ${JSON.stringify(r)}`);
  return r.result as T;
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

/** Действия журнала, записанные против прогона (обратная ссылка run_id, Задача 6). */
async function actionsOfRun(owner: string, runId: string): Promise<ActionRecord[]> {
  return (await actionsOf(owner)).filter((a) => a.run_id === runId);
}

beforeAll(async () => {
  await truncateAll();
});

afterAll(async () => {
  await client.end();
});

// ---------------------------------------------------------------------------
// agentRun.answerCheckpoint (С3, приёмка 7–8)
// ---------------------------------------------------------------------------

describe('agentRun.answerCheckpoint (С3, приёмка 8)', () => {
  const owner = freshUserId();
  const a = callerFor(owner);
  let grantId = '';
  let projectId = '';

  beforeAll(async () => {
    grantId = await workerGrant(owner, 'исполнитель ответа');
    const project = await seedEntity(owner, {
      title: 'Проект с чекпойнтом',
      tags: [],
      aspects: { 'orbis/project': { stage: 'active' } },
    });
    projectId = project.id;
  });

  /** Тикет, назначенный исполнителю, — в проекте: как в бою (С10). */
  async function makeTicket(title: string): Promise<string> {
    const ticket = await seedEntity(owner, {
      title,
      tags: [],
      aspects: {
        'orbis/task': { status: 'planned' },
        'orbis/assignment': { executor: 'agent', grant_id: grantId },
      },
    });
    await link(owner, projectId, ticket.id, 'ticket');
    return ticket.id;
  }

  test('тикет planned, waiting_for снят, на прогоне reply; один action (undo одним движением); следующий claim видит reply в history (приёмка 8)', async () => {
    const ticketId = await makeTicket('Тикет с вопросом');
    const claim = okResult<ClaimTaskResult>(
      await dispatchTool(worker(owner, grantId), 'orbis_claim_task', { ticket_id: ticketId }),
    );
    const runId = claim.run_id;
    const question = 'Какую библиотеку взять — zod или valibot?';
    await dispatchTool(worker(owner, grantId), 'orbis_checkpoint', { run_id: runId, question });
    expect((await aspectsOf(owner, ticketId))['orbis/task']).toMatchObject({
      status: 'waiting',
      waiting_for: question,
    });

    const answer = 'Бери zod — он уже в зависимостях.';
    const out = await a.agentRun.answerCheckpoint({ ticketId, runId, answer });

    // Тикет вернулся в работу человека: хвост ожидания снят, а не оставлен рядом с planned
    expect(out.ticket.id).toBe(ticketId);
    expect(out.ticket.aspectsMap['orbis/task']).toEqual({ status: 'planned' });
    expect(out.run.id).toBe(runId);
    const reply = out.run.aspectsMap['orbis/agent-run']?.reply as { text: string; at: string };
    expect(reply.text).toBe(answer);
    expect(new Date(reply.at).getTime()).toBeGreaterThan(0);
    // Чекпойнт на месте: ответ дополняет прогон, а не затирает его вопрос
    expect(out.run.aspectsMap['orbis/agent-run']?.checkpoint).toMatchObject({ question });
    // Вопрос закрыт: исход `answered` — прогон уходит из блока «Ждут ответа» (V1, D38)
    expect(out.run.aspectsMap['orbis/agent-run']?.outcome).toBe('answered');

    // Один action на обе правки — иначе «Отменить» гасило бы половину ответа
    const uiActions = (await actionsOfRun(owner, runId)).filter((x) => x.source === 'ui');
    expect(uiActions).toHaveLength(1);
    const act = uiActions[0] as ActionRecord;
    expect(act.actor_kind).toBe('owner');
    expect(act.type).toBe('batch');

    // …и это проверяется движением, а не счётом: одно «отмени последнее» снимает обе правки
    await a.ai.undoLast();
    expect((await aspectsOf(owner, ticketId))['orbis/task']).toMatchObject({
      status: 'waiting',
      waiting_for: question,
    });
    expect((await aspectsOf(owner, runId))['orbis/agent-run']?.reply).toBeUndefined();
    expect((await aspectsOf(owner, runId))['orbis/agent-run']?.outcome).toBe('checkpoint');

    // Отвечаем заново — и следующий захват видит ответ в истории прогонов (приёмка 8)
    await a.agentRun.answerCheckpoint({ ticketId, runId, answer });
    const next = okResult<ClaimTaskResult>(
      await dispatchTool(worker(owner, grantId), 'orbis_claim_task', { ticket_id: ticketId }),
    );
    expect(next.run_id).not.toBe(runId);
    const past = next.history.find((h) => h.id === runId);
    expect(past?.reply?.text).toBe(answer);
    expect(past?.checkpoint?.question).toBe(question);
    expect(past?.outcome).toBe('answered');
  });

  test('ответ на прогон, законченный без вопроса (finished/abandoned), исход не переписывает — только reply', async () => {
    const ticketId = await makeTicket('Тикет с итогом');
    const claim = okResult<ClaimTaskResult>(
      await dispatchTool(worker(owner, grantId), 'orbis_claim_task', { ticket_id: ticketId }),
    );
    await dispatchTool(worker(owner, grantId), 'orbis_finish', {
      run_id: claim.run_id,
      report: 'Готово, проверь',
    });
    expect((await aspectsOf(owner, ticketId))['orbis/task']).toMatchObject({ status: 'waiting' });
    const out = await a.agentRun.answerCheckpoint({
      ticketId,
      runId: claim.run_id,
      answer: 'Принял, спасибо',
    });
    expect(out.run.aspectsMap['orbis/agent-run']?.outcome).toBe('finished');
    expect((out.run.aspectsMap['orbis/agent-run']?.reply as AnyRecord).text).toBe(
      'Принял, спасибо',
    );
    expect(out.ticket.aspectsMap['orbis/task']).toEqual({ status: 'planned' });
  });

  test('по тикету не в waiting → CONFLICT', async () => {
    const ticketId = await makeTicket('Тикет без вопроса');
    const claim = okResult<ClaimTaskResult>(
      await dispatchTool(worker(owner, grantId), 'orbis_claim_task', { ticket_id: ticketId }),
    );
    // Прогон идёт, вопроса не было: тикет в in_progress
    const e = await trpcError(
      a.agentRun.answerCheckpoint({ ticketId, runId: claim.run_id, answer: 'Ответ в пустоту' }),
    );
    expect(e.code).toBe('CONFLICT');
    expect((await aspectsOf(owner, ticketId))['orbis/task']).toMatchObject({
      status: 'in_progress',
    });
    expect((await aspectsOf(owner, claim.run_id))['orbis/agent-run']?.reply).toBeUndefined();
  });

  // Таймаут поднят с дефолтных 5 с: тест ходит в живую БД, и под ПАРАЛЛЕЛЬНЫМ прогоном
  // сьютов трёх пакетов ответы приходят медленнее лимита — падение было по нетерпению,
  // а не по ошибке (изолированно тест зелёный). Замерено за срез Ш1, 2026-08-20/21.
  test('ответ адресуется ПОСЛЕДНЕМУ прогону тикета: старый прогон → CONFLICT, reply не записан', async () => {
    const ticketId = await makeTicket('Тикет с двумя вопросами');
    const first = okResult<ClaimTaskResult>(
      await dispatchTool(worker(owner, grantId), 'orbis_claim_task', { ticket_id: ticketId }),
    );
    await dispatchTool(worker(owner, grantId), 'orbis_checkpoint', {
      run_id: first.run_id,
      question: 'Вопрос первого прогона?',
    });
    await a.agentRun.answerCheckpoint({ ticketId, runId: first.run_id, answer: 'Ответ первому' });

    const second = okResult<ClaimTaskResult>(
      await dispatchTool(worker(owner, grantId), 'orbis_claim_task', { ticket_id: ticketId }),
    );
    await dispatchTool(worker(owner, grantId), 'orbis_checkpoint', {
      run_id: second.run_id,
      question: 'Вопрос второго прогона?',
    });

    // Устаревший экран (или чужой вызов API) шлёт runId прошлого прогона: тикет ждёт, а
    // прошлый прогон терминален — предусловия одни это пропустили бы, и ответ лёг бы не
    // туда, а вопрос текущего прогона остался бы без ответа навсегда.
    const e = await trpcError(
      a.agentRun.answerCheckpoint({
        ticketId,
        runId: first.run_id,
        answer: 'Ответ не в тот прогон',
      }),
    );
    expect(e.code).toBe('CONFLICT');
    // Ответ первого прогона на месте (тот, что был дан вовремя), второго — нет
    expect(
      ((await aspectsOf(owner, first.run_id))['orbis/agent-run']?.reply as AnyRecord).text,
    ).toBe('Ответ первому');
    expect((await aspectsOf(owner, second.run_id))['orbis/agent-run']?.reply).toBeUndefined();
    expect((await aspectsOf(owner, ticketId))['orbis/task']).toMatchObject({ status: 'waiting' });
  }, 20_000);

  test('прогон чужого тикета → NOT_FOUND, ничего не записано', async () => {
    const first = await makeTicket('Тикет A');
    const second = await makeTicket('Тикет B');
    const claim = okResult<ClaimTaskResult>(
      await dispatchTool(worker(owner, grantId), 'orbis_claim_task', { ticket_id: first }),
    );
    await dispatchTool(worker(owner, grantId), 'orbis_checkpoint', {
      run_id: claim.run_id,
      question: 'Вопрос по A',
    });
    const e = await trpcError(
      a.agentRun.answerCheckpoint({ ticketId: second, runId: claim.run_id, answer: 'Не туда' }),
    );
    expect(e.code).toBe('NOT_FOUND');
    expect((await aspectsOf(owner, claim.run_id))['orbis/agent-run']?.reply).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// agentRun.sweep (С6, инвариант 6)
// ---------------------------------------------------------------------------

describe('agentRun.sweep (С6)', () => {
  /**
   * Брошенный прогон в «настоящем» времени: у tRPC-пути инъекции часов нет (её и не
   * должно быть — это боевая процедура), поэтому фикстура отсчитывается от Date.now().
   */
  async function seedStale(
    owner: string,
    grantId: string,
  ): Promise<{ ticketId: string; runId: string }> {
    const at = new Date(Date.now() - 31 * MINUTE).toISOString();
    const ticket = await seedEntity(owner, {
      title: 'Тикет брошенного прогона',
      tags: [],
      aspects: {
        'orbis/task': { status: 'in_progress' },
        'orbis/assignment': { executor: 'agent', grant_id: grantId },
      },
    });
    const run = await seedEntity(owner, {
      title: 'Прогон: Тикет брошенного прогона',
      tags: [],
      aspects: {
        'orbis/agent-run': {
          grant_id: grantId,
          outcome: 'running',
          started_at: new Date(Date.now() - 41 * MINUTE).toISOString(),
          last_step_at: at,
          step_count: 1,
          steps: [{ seq: 1, at, summary: 'Прочитал тикет', external: false }],
        },
      },
    });
    await link(owner, ticket.id, run.id, 'run');
    return { ticketId: ticket.id, runId: run.id };
  }

  test('с экрана: тот же результат, что подметание в orbis_my_queue; actor owner, source system', async () => {
    // Две одинаковые фикстуры у РАЗНЫХ владельцев: сравниваем не «похоже», а результат
    const viaScreen = freshUserId();
    const viaQueue = freshUserId();
    const screenGrant = await workerGrant(viaScreen, 'подметание с экрана');
    const queueGrant = await workerGrant(viaQueue, 'подметание из очереди');
    const screen = await seedStale(viaScreen, screenGrant);
    const queue = await seedStale(viaQueue, queueGrant);

    const screenOut = await callerFor(viaScreen).agentRun.sweep({});
    const queueOut = okResult<MyQueueResult>(
      // Часы worker-контекста живут в прошлом (T0) — подметанию нужен настоящий «сейчас»
      await dispatchTool(
        worker(viaQueue, queueGrant, { clock: () => new Date() }),
        'orbis_my_queue',
        {},
      ),
    );

    expect(screenOut).toEqual({ swept: 1 });
    expect(queueOut.swept).toBe(1);

    const screenTicket = (await aspectsOf(viaScreen, screen.ticketId))['orbis/task'] as AnyRecord;
    const queueTicket = (await aspectsOf(viaQueue, queue.ticketId))['orbis/task'] as AnyRecord;
    expect(screenTicket).toEqual(queueTicket);
    expect(screenTicket).toMatchObject({ status: 'planned' });

    const screenRun = (await aspectsOf(viaScreen, screen.runId))['orbis/agent-run'] as AnyRecord;
    const queueRun = (await aspectsOf(viaQueue, queue.runId))['orbis/agent-run'] as AnyRecord;
    expect(screenRun.outcome).toBe('abandoned');
    expect(queueRun.outcome).toBe('abandoned');
    expect(screenRun.abandon_note).toBe(queueRun.abandon_note as string);

    // Атрибуция: с экрана подметает владелец, из очереди — агент; source у обоих
    // системный (обслуживание инварианта 6, а не решение актора — «отмени последнее»
    // такие записи пропускает)
    const screenAction = (await actionsOfRun(viaScreen, screen.runId))[0] as ActionRecord;
    expect(screenAction.actor_kind).toBe('owner');
    expect(screenAction.source).toBe('system');
    const queueAction = (await actionsOfRun(viaQueue, queue.runId))[0] as ActionRecord;
    expect(queueAction.actor_kind).toBe('agent');
    expect(queueAction.source).toBe('system');
  });

  test('подметать нечего → swept 0, журнал не растёт', async () => {
    const owner = freshUserId();
    const before = (await actionsOf(owner)).length;
    expect(await callerFor(owner).agentRun.sweep({})).toEqual({ swept: 0 });
    expect((await actionsOf(owner)).length).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// ownerOnly-гейт (§9.3)
// ---------------------------------------------------------------------------

describe('agentRun: ownerOnly (§9.3)', () => {
  /**
   * Весь роутер — поверхность владельца. Особенно откат: агент, откатывающий собственный
   * прогон, стирал бы след своей работы, а ответ на чекпойнт от агента — это ответ на
   * свой же вопрос. Гейт обязан лететь ДО БД, поэтому caller без рабочего пула.
   */
  const agent = createCaller({
    actorUserId: freshUserId(),
    actorKind: 'agent',
    db: undefined as never,
    clientVersion: null,
  });

  test('агент (PAT) не отвечает на чекпойнты, не подметает и не откатывает — FORBIDDEN', async () => {
    const calls: Array<Promise<unknown>> = [
      agent.agentRun.answerCheckpoint({
        ticketId: crypto.randomUUID(),
        runId: crypto.randomUUID(),
        answer: 'от агента',
      }),
      agent.agentRun.sweep({}),
      agent.agentRun.rollback({ runId: crypto.randomUUID() }),
    ];
    for (const call of calls) {
      expect((await trpcError(call)).code).toBe('FORBIDDEN');
    }
  });
});
