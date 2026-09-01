// apps/server/src/routines/ask.test.ts
// Нетерминальный вопрос рутины `orbis_ask` (D42 ОЧ.5, ОЧ.9, ОЧ.10, ОЧ.12) против живой БД:
// запись вопроса, своя карточка, идемпотентность по содержимому, кап пачки и гейты доступа.
//
// Через `dispatchTool`, а не прямым вызовом `runAsk`: гейт режима (V1.10, ОЧ.12), реестр и
// разбор envelope — часть контракта тула, и проверять его в обход них значило бы закрыть
// тестом путь, которым модель не ходит.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { type AskResult, entityThreadId, newId, pendingMessageId } from '@orbis/shared';
import { eq } from 'drizzle-orm';
import { appDb, freshUserId, requireEnv, truncateAll } from '../../test/helpers';
import { chatMessages } from '../db/schema';
import { withIdentity } from '../db/with-identity';
import { askDedupeKey } from '../policy/pending';
import { agentLoopHelpers } from '../test/agent-loop-helpers';
import { dispatchTool, type ToolCallCtx } from '../tools/dispatch';
import type { Card } from '../tools/registry';
import { MAX_RUN_UNITS } from './constants';

requireEnv();

const { db, client } = appDb();
const owner = freshUserId();
const { propsOf, routineCtx, seedRoutine, seedRoutineRun, worker, workerGrant } =
  agentLoopHelpers(db);

beforeAll(async () => {
  await truncateAll();
});

afterAll(async () => {
  await client.end();
});

interface LiveRoutine {
  routineId: string;
  runId: string;
  threadId: string;
  ctx: ToolCallCtx;
}

/**
 * Рутина + её живой прогон + контекст вызова, указывающий ровно на них. Рутина настоящая,
 * а не подменённый id: вопрос ложится в её тред (`ensureEntityThread`), а тому нужна
 * существующая сущность.
 */
async function liveRoutine(mode: 'propose' | 'act', bucket: string): Promise<LiveRoutine> {
  const routineId = await seedRoutine(owner, {
    title: `Рутина вопроса (${mode})`,
    routine: { 'orbis/routine_mode': mode },
  });
  const { runId } = await seedRoutineRun(owner, { routineId, bucket });
  const ctx = routineCtx(owner, mode, [], {
    routine: { id: routineId, runId, mode, allowedTools: new Set() },
  });
  return { routineId, runId, threadId: entityThreadId(owner, routineId), ctx };
}

/** Pending-сообщения треда рутины — единицы пачки прогона, как их видит владелец. */
async function pendingsIn(threadId: string) {
  const rows = await withIdentity(db, owner, (tx) =>
    tx.select().from(chatMessages).where(eq(chatMessages.threadId, threadId)),
  );
  return rows.filter((r) => (r.metadata as { pending?: unknown }).pending !== undefined);
}

async function outcomeOf(runId: string): Promise<unknown> {
  return (await propsOf(owner, runId))['orbis/run_outcome'];
}

function expectError(r: Awaited<ReturnType<typeof dispatchTool>>, code: string): void {
  expect(r.status).toBe('error');
  if (r.status === 'error') expect(r.error.code).toBe(code);
}

function okResult(r: Awaited<ReturnType<typeof dispatchTool>>): AskResult {
  if (r.status !== 'ok') throw new Error(`ожидался ok, получено «${r.status}»`);
  return r.result as AskResult;
}

const QUESTION = 'Переносить ли встречу с понедельника: у тебя в этот день уже три созвона?';

// ---------------------------------------------------------------------------

describe('orbis_ask: нетерминальный вопрос владельцу (D42 ОЧ.5)', () => {
  test('act и propose: pending kind:question с question_card в треде рутины; {run_id, pending_id, replayed:false}; прогон НЕ закрыт (приёмка 1)', async () => {
    for (const mode of ['act', 'propose'] as const) {
      const { routineId, runId, threadId, ctx } = await liveRoutine(
        mode,
        `2026-08-21T0${mode === 'act' ? 7 : 8}:00`,
      );

      const r = await dispatchTool(ctx, 'orbis_ask', {
        run_id: runId,
        question: QUESTION,
        options: ['перенести', 'оставить'],
      });
      const result = okResult(r);
      const pendingId = pendingMessageId(
        owner,
        askDedupeKey(runId, QUESTION, ['перенести', 'оставить']),
      );
      expect(result).toEqual({ run_id: runId, pending_id: pendingId, replayed: false });

      // Запись — единица пачки: явный kind, прогон, содержимое вопроса и НИ tool, НИ input
      const pendings = await pendingsIn(threadId);
      expect(pendings).toHaveLength(1);
      const msg = pendings[0];
      expect(msg?.id).toBe(pendingId);
      const record = (msg?.metadata as { pending: Record<string, unknown> }).pending;
      expect(record.kind).toBe('question');
      expect(record.run_id).toBe(runId);
      expect(record.source).toBe('routine');
      expect(record.actor_kind).toBe('ai');
      expect(record.question).toBe(QUESTION);
      expect(record.options).toEqual(['перенести', 'оставить']);
      expect(record.tool).toBeUndefined();
      expect(record.input).toBeUndefined();

      // Ф-2b: карточка и текст ленты — СВОИ. Умолчания `createPending` тут негодны:
      // confirmation_card предлагает владельцу кнопки, на которые гейт рода отвечает
      // отказом, а «Требуется подтверждение: …» врёт про то, что происходит
      const card = (msg?.metadata as { cards: Card[] }).cards[0];
      expect(card).toEqual({
        kind: 'question_card',
        pendingId,
        runId,
        routineId,
        question: QUESTION,
        options: ['перенести', 'оставить'],
      });
      expect(msg?.content).toBe(`Вопрос владельцу: «${QUESTION}»`);

      // Вопрос НЕтерминален: прогон продолжается — его закроет раннер, а не тул
      expect(await outcomeOf(runId)).toBe('running');
    }
  });

  test('вопрос без options: карточка и запись без ключа options; прогон по-прежнему running', async () => {
    const { routineId, runId, threadId, ctx } = await liveRoutine('act', '2026-08-21T09:00');
    const question = 'Купить билеты сегодня или подождать распродажи?';

    const r = await dispatchTool(ctx, 'orbis_ask', { run_id: runId, question });
    const result = okResult(r);
    expect(result.replayed).toBe(false);

    const pendings = await pendingsIn(threadId);
    expect(pendings).toHaveLength(1);
    const record = (pendings[0]?.metadata as { pending: Record<string, unknown> }).pending;
    expect(record.options).toBeUndefined();
    expect((pendings[0]?.metadata as { cards: Card[] }).cards[0]).toEqual({
      kind: 'question_card',
      pendingId: result.pending_id,
      runId,
      routineId,
      question,
    });
    expect(await outcomeOf(runId)).toBe('running');
  });

  test('повтор того же вопроса → тот же pending_id, replayed:true, второй карточки нет (приёмка 15)', async () => {
    const { runId, threadId, ctx } = await liveRoutine('act', '2026-08-21T10:00');
    const first = okResult(
      await dispatchTool(ctx, 'orbis_ask', { run_id: runId, question: QUESTION }),
    );
    const again = okResult(
      await dispatchTool(ctx, 'orbis_ask', { run_id: runId, question: QUESTION }),
    );

    expect(again.pending_id).toBe(first.pending_id);
    expect(first.replayed).toBe(false);
    expect(again.replayed).toBe(true);
    expect(await pendingsIn(threadId)).toHaveLength(1);

    // Другой текст — другая единица: личность вопроса считается от СОДЕРЖИМОГО (ОЧ.9)
    const other = okResult(
      await dispatchTool(ctx, 'orbis_ask', { run_id: runId, question: `${QUESTION} (и ещё)` }),
    );
    expect(other.pending_id).not.toBe(first.pending_id);
    expect(await pendingsIn(threadId)).toHaveLength(2);
  });

  test('11-й открытый вопрос → VALIDATION «пачка полна»; ретрай уже стоящего кап НЕ отвергает (приёмка 16)', async () => {
    const { runId, threadId, ctx } = await liveRoutine('act', '2026-08-21T11:00');
    const questions = Array.from(
      { length: MAX_RUN_UNITS },
      (_, i) => `Вопрос номер ${i + 1}: как быть?`,
    );
    for (const question of questions) {
      expect(
        okResult(await dispatchTool(ctx, 'orbis_ask', { run_id: runId, question })).replayed,
      ).toBe(false);
    }
    expect(await pendingsIn(threadId)).toHaveLength(MAX_RUN_UNITS);

    const over = await dispatchTool(ctx, 'orbis_ask', {
      run_id: runId,
      question: 'Одиннадцатый вопрос — уже лишний',
    });
    expectError(over, 'VALIDATION');
    if (over.status === 'error') {
      expect(over.error.message).toContain('пачка полна');
      expect(over.error.details).toEqual({ reason: 'run_units_cap', limit: MAX_RUN_UNITS });
    }
    // Отказ структурный: карточки нет, прогон живой — модель корректируется и работает дальше
    expect(await pendingsIn(threadId)).toHaveLength(MAX_RUN_UNITS);
    expect(await outcomeOf(runId)).toBe('running');

    // Ретрай ДЕСЯТОГО вопроса при полной пачке — replay, а не отказ: наивный порядок
    // «кап → запись» отверг бы повтор того, что уже стоит (Р-15)
    const replay = okResult(
      await dispatchTool(ctx, 'orbis_ask', {
        run_id: runId,
        question: questions[MAX_RUN_UNITS - 1] as string,
      }),
    );
    expect(replay.replayed).toBe(true);
    expect(await pendingsIn(threadId)).toHaveLength(MAX_RUN_UNITS);
  });

  test('run_id чужого прогона → VALIDATION, карточки нет', async () => {
    const { threadId, ctx } = await liveRoutine('act', '2026-08-21T12:00');
    const foreign = await liveRoutine('act', '2026-08-21T13:00');

    const r = await dispatchTool(ctx, 'orbis_ask', { run_id: foreign.runId, question: QUESTION });
    expectError(r, 'VALIDATION');
    if (r.status === 'error') expect(r.error.message).toContain('не тому прогону');
    expect(await pendingsIn(threadId)).toHaveLength(0);
    expect(await pendingsIn(foreign.threadId)).toHaveLength(0);
  });

  test('чат и MCP: orbis_ask недоступен — VALIDATION гейта, а не FORBIDDEN_LEVEL (приёмка 14, ОЧ.12)', async () => {
    const grantId = await workerGrant(owner, 'внешний исполнитель');
    const contexts: ToolCallCtx[] = [
      {
        db,
        actorUserId: owner,
        actorKind: 'ai',
        source: 'chat',
        explicitCommand: false,
      },
      worker(owner, grantId),
    ];
    for (const ctx of contexts) {
      const r = await dispatchTool(ctx, 'orbis_ask', { run_id: newId(), question: QUESTION });
      // Именно VALIDATION: для чата и MCP такого тула просто НЕ СУЩЕСТВУЕТ — их реестры
      // его не публикуют (routineOnly), и это ошибка формы вызова, а не отказ по правам
      expectError(r, 'VALIDATION');
    }
  });

  test('source routine без контекста рутины → FORBIDDEN_LEVEL (fail-closed)', async () => {
    const broken: ToolCallCtx = {
      db,
      actorUserId: owner,
      actorKind: 'ai',
      source: 'routine',
      explicitCommand: false,
      runId: newId(),
    };
    expectError(
      await dispatchTool(broken, 'orbis_ask', {
        run_id: broken.runId as string,
        question: QUESTION,
      }),
      'FORBIDDEN_LEVEL',
    );
  });
});
