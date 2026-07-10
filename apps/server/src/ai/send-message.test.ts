// apps/server/src/ai/send-message.test.ts
// Интеграционные тесты ai.sendMessage (Task 9) против живой БД со ScriptedProvider:
// tool-цикл §7.1 слой 5, ответ целиком (§7.7 D7), карточки всех действий цикла,
// метеринг ai_usage (§4.7) суммой шагов, деградация §7.9 (LLM_UNAVAILABLE),
// entitlements-гейт §8 ДО провайдера, explicit-confirmation §7.10 внутри цикла.
// ScriptedProvider ассертит ЗАПРОСЫ к модели: system НЕ в messages (контракт Task 7),
// tool-результаты — каноническим сериализатором toolResultMessage (контракт Task 8).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { MAX_AGENT_STEPS, newId, processingMessageId } from '@orbis/shared';
import type { TRPCError } from '@trpc/server';
import { eq } from 'drizzle-orm';
import { appDb, freshUserId, requireEnv, truncateAll } from '../../test/helpers';
import { ensureGlobalThread } from '../chat/threads';
import { aiUsage, chatMessages, entities } from '../db/schema';
import { withIdentity } from '../db/with-identity';
import { execute } from '../executor/executor';
import type { ActionRecord, WireEntity } from '../executor/types';
import { SYSTEM_PROMPT_V1, TOOL_RESULT_MARKER } from '../llm/prompts/v1';
import { ScriptedProvider } from '../llm/scripted';
import type { LLMMessage, LLMProvider, LLMRequest, LLMResponse } from '../llm/types';
import { appRouter } from '../router';
import type { Card } from '../tools/registry';
import { type Context, createCallerFactory } from '../trpc';
import { MAX_TOKENS_NOTE, type SendMessageAnswer, type SendMessageResult } from './send-message';

requireEnv();

const { db, client } = appDb();
const createCaller = createCallerFactory(appRouter);

/** Фиксированное «сейчас» для метеринга/политики: день UTC = 2026-07-04. */
const T0 = new Date('2026-07-04T10:00:00.000Z');
const TODAY = '2026-07-04';
const MODEL = 'scripted-model';
/** uuid категории для orbis/financial: схема требует uuid, существование не проверяется. */
const CATEGORY_REF = '019e4466-aaaa-7e07-b5d4-64be9721da51';

beforeAll(async () => {
  await truncateAll();
});

afterAll(async () => {
  await client.end();
});

// ---------------------------------------------------------------------------
// Хелперы
// ---------------------------------------------------------------------------

function endTurn(content: string, usage = { inputTokens: 10, outputTokens: 5 }): LLMResponse {
  return { content, toolCalls: [], usage, stopReason: 'end_turn' };
}

function toolUse(
  calls: Array<{ name: string; input: Record<string, unknown> }>,
  usage = { inputTokens: 10, outputTokens: 5 },
): LLMResponse {
  return {
    content: '',
    toolCalls: calls.map((c, i) => ({ id: `call-${i}`, name: c.name, input: c.input })),
    usage,
    stopReason: 'tool_use',
  };
}

function callerWith(
  user: string,
  provider: LLMProvider,
  over: Partial<NonNullable<Context['ai']>> = {},
) {
  return createCaller({
    actorUserId: user,
    actorKind: 'owner',
    db,
    clientVersion: null,
    ai: { provider, model: MODEL, clock: () => T0, ...over },
  });
}

async function globalThread(user: string): Promise<string> {
  return withIdentity(db, user, (tx) => ensureGlobalThread(tx, user));
}

/** Сообщения треда в хронологии (createdAt, id — как listMessages, но по возрастанию). */
async function threadMessages(user: string, threadId: string) {
  return withIdentity(db, user, (tx) =>
    tx
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.threadId, threadId))
      .orderBy(chatMessages.createdAt, chatMessages.id),
  );
}

/** Сид-сущность через executor без синка — без audit-шума в тредах. */
async function seedEntity(owner: string, input: Record<string, unknown>): Promise<WireEntity> {
  const r = await execute(db, {
    actorUserId: owner,
    actorKind: 'owner',
    source: 'ui',
    operations: [{ tool: 'entity_create', input }],
  });
  if (!r.ok) throw new Error(`seedEntity: ${r.error.code} ${r.error.message}`);
  return r.results[0] as WireEntity;
}

function cardsOf(msg: { metadata: Record<string, unknown> }): Card[] {
  return (msg.metadata as { cards?: Card[] }).cards ?? [];
}

function lastOf(req: LLMRequest | undefined): LLMMessage {
  const m = req?.messages.at(-1);
  if (!m) throw new Error('ожидалось непустое messages запроса к модели');
  return m;
}

/** Канонический формат tool-результата (toolResultMessage, Task 8): префикс + JSON. */
function toolResultPayload(
  msg: LLMMessage,
  tool: string,
  // biome-ignore lint/suspicious/noExplicitAny: разбор тестового JSON-протокола
): any {
  const prefix = `${TOOL_RESULT_MARKER}${tool}] `;
  expect(msg.role).toBe('user');
  expect(msg.content.startsWith(prefix)).toBe(true);
  return JSON.parse(msg.content.slice(prefix.length));
}

async function trpcError(p: Promise<unknown>): Promise<TRPCError> {
  try {
    await p;
  } catch (e) {
    return e as TRPCError;
  }
  throw new Error('ожидался TRPCError, вызов успешен');
}

/** Полный ответ (не processing) — узкий тип для ассертов существующих сценариев. */
function answered(r: SendMessageResult): SendMessageAnswer {
  if ('status' in r) throw new Error('ожидался полный ответ, получен { status: processing }');
  return r;
}

async function usageRows(user: string) {
  return withIdentity(db, user, (tx) => tx.select().from(aiUsage).where(eq(aiUsage.date, TODAY)));
}

// ---------------------------------------------------------------------------
// (а) Сценарий «создай задачу»
// ---------------------------------------------------------------------------

describe('ai.sendMessage (а): «создай задачу» — цикл из tool_use + end_turn', () => {
  test('сущность в БД, audit-сообщение, entity_card, метеринг суммой двух шагов', async () => {
    const user = freshUserId();
    const threadId = await globalThread(user);
    const scripted = new ScriptedProvider([
      toolUse([{ name: 'entity_create', input: { title: 'Купить хлеб', tags: [] } }], {
        inputTokens: 100,
        outputTokens: 20,
      }),
      endTurn('Готово: задача создана', { inputTokens: 200, outputTokens: 30 }),
    ]);
    const msgId = newId();
    const r = answered(
      await callerWith(user, scripted).ai.sendMessage({
        id: msgId,
        threadId,
        content: 'создай задачу купить хлеб',
      }),
    );

    // Ответ целиком (D7): финальный текст + карточки всех действий цикла
    expect(r.assistantMessage.role).toBe('assistant');
    expect(r.assistantMessage.content).toBe('Готово: задача создана');
    const cards = cardsOf(r.assistantMessage);
    expect(cards).toHaveLength(1);
    const card = cards[0];
    if (card?.kind !== 'entity_card') throw new Error('ожидалась entity_card');
    expect(card.title).toBe('Купить хлеб');
    expect(card.undoActionId).toBeDefined();

    // Сущность реально в графе
    const rows = await withIdentity(db, user, (tx) =>
      tx.select().from(entities).where(eq(entities.title, 'Купить хлеб')),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(card.entityId);

    // Резюме для мгновенного UI-обновления
    expect(r.actions).toEqual([
      { actionId: card.undoActionId as string, entityId: card.entityId, type: 'entity_create' },
    ]);
    expect(r.pending).toEqual([]);

    // Хронология треда: user → audit executor'а (актор ai, source chat) → assistant
    const msgs = await threadMessages(user, threadId);
    expect(msgs.map((m) => m.role)).toEqual(['user', 'system', 'assistant']);
    expect(msgs[0]?.id).toBe(msgId);
    const action = (msgs[1]?.metadata as { actions?: ActionRecord[] }).actions?.[0];
    expect(action?.actor_kind).toBe('ai');
    expect(action?.source).toBe('chat');
    expect(action?.id).toBe(card.undoActionId as string);
    expect(msgs[2]?.id).toBe(r.assistantMessage.id);

    // Метеринг §4.7: одна строка (owner, день UTC, model), суммы обоих шагов
    const usage = await usageRows(user);
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({
      model: MODEL,
      inputTokens: 300,
      outputTokens: 50,
      requestCount: 2,
    });

    // Запросы к модели: system — ОТДЕЛЬНЫМ полем (в messages system-роли нет — Task 7),
    // тулы слоя 5 из реестра, окно заканчивается только что персистированным user-сообщением
    expect(scripted.requests).toHaveLength(2);
    for (const req of scripted.requests) {
      expect(req.system.startsWith(SYSTEM_PROMPT_V1)).toBe(true);
      expect(req.messages.every((m) => m.role === 'user' || m.role === 'assistant')).toBe(true);
      const toolNames = req.tools.map((t) => t.name);
      expect(toolNames).toContain('entity_create');
      expect(toolNames).toContain('user_query'); // internalOnly — внутреннему чату доступен
    }
    expect(scripted.requests[0]?.messages.at(-1)).toEqual({
      role: 'user',
      content: 'создай задачу купить хлеб',
    });
    // Tool-результат — ТОЛЬКО каноническим сериализатором toolResultMessage (Task 8)
    const payload = toolResultPayload(lastOf(scripted.requests[1]), 'entity_create');
    expect(payload.status).toBe('ok');
    expect(payload.result.id).toBe(card.entityId);
  });
});

// ---------------------------------------------------------------------------
// (б) Цикл из двух tool-вызовов
// ---------------------------------------------------------------------------

describe('ai.sendMessage (б): tool-цикл из 2 вызовов (query → create)', () => {
  test('три вызова провайдера; каждый результат — следующим каноническим tool_result', async () => {
    const user = freshUserId();
    const threadId = await globalThread(user);
    const scripted = new ScriptedProvider([
      toolUse([{ name: 'entity_query', input: { query: 'aspect=orbis/task' } }]),
      toolUse([{ name: 'entity_create', input: { title: 'Задача из цикла', tags: [] } }]),
      endTurn('Сделано'),
    ]);
    const r = answered(
      await callerWith(user, scripted).ai.sendMessage({
        id: newId(),
        threadId,
        content: 'проверь задачи и создай новую',
      }),
    );

    expect(scripted.requests).toHaveLength(3);
    const q = toolResultPayload(lastOf(scripted.requests[1]), 'entity_query');
    expect(q.status).toBe('ok');
    expect(Array.isArray(q.result)).toBe(true);
    const c = toolResultPayload(lastOf(scripted.requests[2]), 'entity_create');
    expect(c.status).toBe('ok');
    expect(c.result.title).toBe('Задача из цикла');

    // Карточки всех действий цикла — в хронологии
    expect(cardsOf(r.assistantMessage).map((card) => card.kind)).toEqual([
      'query_result',
      'entity_card',
    ]);
    expect(r.assistantMessage.content).toBe('Сделано');
    const rows = await withIdentity(db, user, (tx) =>
      tx.select().from(entities).where(eq(entities.title, 'Задача из цикла')),
    );
    expect(rows).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// (в) Лимит шагов
// ---------------------------------------------------------------------------

describe('ai.sendMessage (в): лимит шагов MAX_AGENT_STEPS', () => {
  test('10 tool_use подряд → ровно 8 вызовов провайдера, принудительный финал (не ошибка)', async () => {
    const user = freshUserId();
    const threadId = await globalThread(user);
    const scripted = new ScriptedProvider(
      Array.from({ length: 10 }, () =>
        toolUse([{ name: 'entity_query', input: { query: 'aspect=orbis/task' } }]),
      ),
    );
    const r = answered(
      await callerWith(user, scripted).ai.sendMessage({
        id: newId(),
        threadId,
        content: 'зациклись',
      }),
    );

    expect(scripted.requests).toHaveLength(MAX_AGENT_STEPS);
    expect(r.assistantMessage.content).toContain('[цикл остановлен: достигнут лимит шагов]');
    // Тулы шага-нарушителя НЕ исполняются (модель не увидела бы их результат):
    // карточек — по числу исполненных шагов
    expect(cardsOf(r.assistantMessage)).toHaveLength(MAX_AGENT_STEPS - 1);
    // Метеринг честно считает все фактические вызовы
    const usage = await usageRows(user);
    expect(usage[0]?.requestCount).toBe(MAX_AGENT_STEPS);
  });
});

// ---------------------------------------------------------------------------
// (г) Деградация §7.9
// ---------------------------------------------------------------------------

describe('ai.sendMessage: обрыв по потолку токенов', () => {
  // Усечённый (а при adaptive thinking — пустой) ответ персистился как нормальный,
  // и replay-ветка возвращала бы этот обрубок на каждый повтор того же client-id.
  test('stopReason max_tokens → в ответе видимая пометка обрезки', async () => {
    const user = freshUserId();
    const threadId = await globalThread(user);
    const truncated: LLMResponse = {
      content: 'Начал отвечать и не доска',
      toolCalls: [],
      usage: { inputTokens: 10, outputTokens: 8192 },
      stopReason: 'max_tokens',
    };
    const res = answered(
      await callerWith(user, new ScriptedProvider([truncated])).ai.sendMessage({
        id: newId(),
        threadId,
        content: 'расскажи длинно',
      }),
    );
    expect(res.assistantMessage.content).toContain('Начал отвечать и не доска');
    expect(res.assistantMessage.content).toContain(MAX_TOKENS_NOTE);
  });

  test('пустой content при max_tokens → пометка всё равно видна (не пустое сообщение)', async () => {
    const user = freshUserId();
    const threadId = await globalThread(user);
    const empty: LLMResponse = {
      content: '',
      toolCalls: [],
      usage: { inputTokens: 10, outputTokens: 8192 },
      stopReason: 'max_tokens',
    };
    const res = answered(
      await callerWith(user, new ScriptedProvider([empty])).ai.sendMessage({
        id: newId(),
        threadId,
        content: 'думай долго',
      }),
    );
    expect(res.assistantMessage.content).toBe(MAX_TOKENS_NOTE);
  });
});

describe('ai.sendMessage: отказ модели (stopReason refusal)', () => {
  test('refusal → error_card «модель отказалась отвечать», tool-цикл не продолжается', async () => {
    const user = freshUserId();
    const threadId = await globalThread(user);
    // toolCalls при refusal не исполняются: отказ — терминальный исход хода
    const refusal: LLMResponse = {
      content: '',
      toolCalls: [
        { id: 'call-0', name: 'entity_create', input: { title: 'Не должна появиться', tags: [] } },
      ],
      usage: { inputTokens: 10, outputTokens: 5 },
      stopReason: 'refusal',
    };
    const scripted = new ScriptedProvider([refusal]);
    const r = answered(
      await callerWith(user, scripted).ai.sendMessage({
        id: newId(),
        threadId,
        content: 'сделай что-нибудь запретное',
      }),
    );

    expect(scripted.requests).toHaveLength(1); // ровно один шаг, цикла нет
    const cards = cardsOf(r.assistantMessage);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ kind: 'error_card', code: 'LLM_REFUSAL' });
    expect(String((cards[0] as { message?: string }).message)).toContain('отказалась');

    // Тул шага-отказа не исполнен — сущности нет, действий нет
    const rows = await withIdentity(db, user, (tx) =>
      tx.select().from(entities).where(eq(entities.title, 'Не должна появиться')),
    );
    expect(rows).toHaveLength(0);
    expect(r.actions).toEqual([]);

    // Метеринг честный: шаг отказа потреблён
    const usage = await usageRows(user);
    expect(usage.some((row) => row.requestCount >= 1)).toBe(true);
  });
});

describe('ai.sendMessage (г): сбой провайдера — деградация §7.9', () => {
  test('provider.chat бросает → LLM_UNAVAILABLE (503); user-сообщение сохранено, очереди нет', async () => {
    const user = freshUserId();
    const threadId = await globalThread(user);
    const scripted = new ScriptedProvider([]); // первый же вызов бросает (скрипт исчерпан)
    const msgId = newId();
    const err = await trpcError(
      callerWith(user, scripted).ai.sendMessage({ id: msgId, threadId, content: 'привет' }),
    );

    expect(err.code).toBe('SERVICE_UNAVAILABLE');
    expect((err.cause as { code?: string }).code).toBe('LLM_UNAVAILABLE');
    // §7.9: сообщение пользователя НЕ потеряно; ответа/очереди нет
    const msgs = await threadMessages(user, threadId);
    expect(msgs.map((m) => m.id)).toEqual([msgId]);
    expect(msgs[0]?.content).toBe('привет');
  });
});

// ---------------------------------------------------------------------------
// (д) Entitlements-гейт §8
// ---------------------------------------------------------------------------

describe('ai.sendMessage (д): entitlements-гейт §8 ДО провайдера', () => {
  test('лимит 0 → TOO_MANY_REQUESTS; провайдер не тронут; user-сообщение уже персистировано', async () => {
    const user = freshUserId();
    const threadId = await globalThread(user);
    const scripted = new ScriptedProvider([endTurn('не должен быть вызван')]);
    const msgId = newId();
    const err = await trpcError(
      callerWith(user, scripted, {
        entitlements: () => ({ allowed: true, limit: 0 }),
      }).ai.sendMessage({ id: msgId, threadId, content: 'посчитай расходы' }),
    );

    expect(err.code).toBe('TOO_MANY_REQUESTS');
    expect((err.cause as { code?: string }).code).toBe('LIMIT');
    expect(scripted.requests).toHaveLength(0); // ассерт по записанным запросам: их нет
    const msgs = await threadMessages(user, threadId);
    expect(msgs.map((m) => m.id)).toEqual([msgId]); // сообщение в БД (§7.9)
    expect(await usageRows(user)).toHaveLength(0); // метеринг не инкрементирован
  });
});

// ---------------------------------------------------------------------------
// (е) Explicit-confirmation §7.10 внутри цикла
// ---------------------------------------------------------------------------

describe('ai.sendMessage (е): explicit-confirmation внутри цикла (batch archived)', () => {
  test('pending-карточка в ответе, граф не тронут, tool-результат запрещает повтор', async () => {
    const user = freshUserId();
    const threadId = await globalThread(user);
    const target = await seedEntity(user, { title: 'Архивная цель', tags: [] });
    const scripted = new ScriptedProvider([
      toolUse([
        {
          name: 'batch_execute',
          input: {
            batch_id: newId(),
            operations: [{ tool: 'entity_update', input: { id: target.id, archived: true } }],
          },
        },
      ]),
      endTurn('Действие ждёт подтверждения владельца.'),
    ]);
    const r = answered(
      await callerWith(user, scripted).ai.sendMessage({
        id: newId(),
        threadId,
        content: 'наведи порядок в задачах',
      }),
    );

    expect(r.pending).toHaveLength(1);
    const pendingId = r.pending[0]?.pendingId;
    const cards = cardsOf(r.assistantMessage);
    expect(cards).toHaveLength(1);
    const card = cards[0];
    if (card?.kind !== 'confirmation_card') throw new Error('ожидалась confirmation_card');
    expect(card.mode).toBe('explicit');
    expect(card.pendingId).toBe(pendingId as string);
    expect(r.actions).toEqual([]); // ничего не исполнено — actions пуст

    // Граф не тронут до approve (§7.10)
    const rows = await withIdentity(db, user, (tx) =>
      tx.select({ archived: entities.archived }).from(entities).where(eq(entities.id, target.id)),
    );
    expect(rows[0]?.archived).toBe(false);

    // Протокол модели: ожидание — терминальный исход хода, повтор вызова запрещён
    // (митигация Minor-4 Task 6: ретрай того же batch_id создал бы вторую pending-карточку)
    const payload = toolResultPayload(lastOf(scripted.requests[1]), 'batch_execute');
    expect(payload.status).toBe('pending_confirmation');
    expect(payload.pendingId).toBe(pendingId as string);
    expect(String(payload.message)).toContain('не повторяй');
  });
});

// ---------------------------------------------------------------------------
// (ж) user_query sum — decimal-строка
// ---------------------------------------------------------------------------

describe('ai.sendMessage (ж): user_query sum по decimal', () => {
  test('сумма доходит до модели точной decimal-строкой (§3.3), не float', async () => {
    const user = freshUserId();
    const threadId = await globalThread(user);
    for (const amount of ['10.10', '20.20']) {
      await seedEntity(user, {
        title: `Расход ${amount}`,
        tags: ['sumtest'],
        aspects: {
          'orbis/financial': {
            amount,
            direction: 'expense',
            category_ref: CATEGORY_REF,
            occurred_on: '2026-07-01',
          },
        },
      });
    }
    const scripted = new ScriptedProvider([
      toolUse([
        {
          name: 'user_query',
          input: {
            query: 'aspect=orbis/financial, tags=sumtest',
            aggregate: 'sum',
            field: 'amount',
          },
        },
      ]),
      endTurn('Итого 30.30'),
    ]);
    const r = answered(
      await callerWith(user, scripted).ai.sendMessage({
        id: newId(),
        threadId,
        content: 'сколько я потратил?',
      }),
    );

    const payload = toolResultPayload(lastOf(scripted.requests[1]), 'user_query');
    expect(payload.status).toBe('ok');
    expect(payload.result).toBe('30.30'); // точная строка суммы
    expect(cardsOf(r.assistantMessage)[0]).toMatchObject({
      kind: 'query_result',
      aggregate: { op: 'sum', value: '30.30' },
    });
  });
});

// ---------------------------------------------------------------------------
// Дополнительно: идемпотентный персист, error_card, ownerOnly-гейт
// ---------------------------------------------------------------------------

describe('ai.sendMessage: ретрай с тем же client-id (fix round — replay ответа)', () => {
  test('ответ существует → replay БЕЗ провайдера и метеринга; ни второй сущности, ни второго ответа', async () => {
    const user = freshUserId();
    const threadId = await globalThread(user);
    const msgId = newId();
    const first = new ScriptedProvider([
      toolUse([{ name: 'entity_create', input: { title: 'Ретрай-задача', tags: [] } }], {
        inputTokens: 100,
        outputTokens: 20,
      }),
      endTurn('Создано', { inputTokens: 200, outputTokens: 30 }),
    ]);
    const r1 = answered(
      await callerWith(user, first).ai.sendMessage({
        id: msgId,
        threadId,
        content: 'оригинал',
      }),
    );
    expect(r1.replayed).toBe(false);

    // Повтор: пустой скрипт — если бы цикл пошёл, провайдер бы бросил
    const second = new ScriptedProvider([]);
    const r2 = answered(
      await callerWith(user, second).ai.sendMessage({
        id: msgId,
        threadId,
        content: 'повтор с другим текстом',
      }),
    );

    // Replay СУЩЕСТВУЮЩЕГО ответа: тот же assistantMessage, провайдер не тронут
    expect(r2.replayed).toBe(true);
    expect(r2.assistantMessage.id).toBe(r1.assistantMessage.id);
    expect(r2.assistantMessage.content).toBe('Создано');
    expect(cardsOf(r2.assistantMessage)).toHaveLength(1); // карточки — в metadata ответа
    expect(r2.actions).toEqual([]); // минимально: UI 1c при replayed рефетчит тред
    expect(r2.pending).toEqual([]);
    expect(second.requests).toHaveLength(0);

    // Сущность ОДНА, второго action и второго assistant-сообщения нет
    const rows = await withIdentity(db, user, (tx) =>
      tx.select().from(entities).where(eq(entities.title, 'Ретрай-задача')),
    );
    expect(rows).toHaveLength(1);
    const msgs = await threadMessages(user, threadId);
    expect(msgs.filter((m) => m.role === 'assistant')).toHaveLength(1);
    const userMsgs = msgs.filter((m) => m.role === 'user');
    expect(userMsgs).toHaveLength(1); // дубля нет
    expect(userMsgs[0]?.content).toBe('оригинал'); // append-only §4.6: правок нет

    // Метеринг не вырос: только два шага первого прогона
    const usage = await usageRows(user);
    expect(usage[0]).toMatchObject({ inputTokens: 300, outputTokens: 50, requestCount: 2 });
  });

  test('ответа нет (первый вызов упал LLM_UNAVAILABLE) → легитимный ретрай §7.9: цикл гонится', async () => {
    const user = freshUserId();
    const threadId = await globalThread(user);
    const msgId = newId();
    const failing = new ScriptedProvider([]); // первый вызов провайдера бросает
    const err = await trpcError(
      callerWith(user, failing).ai.sendMessage({ id: msgId, threadId, content: 'оригинал' }),
    );
    expect(err.code).toBe('SERVICE_UNAVAILABLE');

    // Повтор с тем же id: ответа в треде нет → полный цикл (не replay)
    const retry = new ScriptedProvider([
      toolUse([{ name: 'entity_create', input: { title: 'Задача после сбоя', tags: [] } }]),
      endTurn('Готово после ретрая'),
    ]);
    const r2 = answered(
      await callerWith(user, retry).ai.sendMessage({
        id: msgId,
        threadId,
        content: 'оригинал',
      }),
    );

    expect(r2.replayed).toBe(false);
    expect(r2.assistantMessage.content).toBe('Готово после ретрая');
    expect(retry.requests).toHaveLength(2);
    // Окно ретрая кончается user-сообщением, персистированным ПЕРВЫМ вызовом (§7.9)
    expect(lastOf(retry.requests[0])).toEqual({ role: 'user', content: 'оригинал' });

    // Сущность одна; assistant-сообщение одно; метеринг честный — только успешный прогон
    const rows = await withIdentity(db, user, (tx) =>
      tx.select().from(entities).where(eq(entities.title, 'Задача после сбоя')),
    );
    expect(rows).toHaveLength(1);
    const msgs = await threadMessages(user, threadId);
    expect(msgs.filter((m) => m.role === 'assistant')).toHaveLength(1);
    expect(msgs.filter((m) => m.role === 'user')).toHaveLength(1);
    const usage = await usageRows(user);
    expect(usage[0]?.requestCount).toBe(2);
  });

  test('out-of-order: ретрай СТАРОГО упавшего A не возвращает ЧУЖОЙ ответ Rb (детерминизм по replyTo)', async () => {
    // Дыра временно́й логики (findAnswerAfter): «ближайший assistant ПОСЛЕ A» — это Rb,
    // ответ на ПОЗЖЕ пришедшее B, а не на A. Детерминизм по metadata.replyTo это чинит:
    // у A ответа нет → честный прогон в провайдер, НИКОГДА чужой Rb.
    const user = freshUserId();
    const threadId = await globalThread(user);
    const idA = newId();

    // 1) A: первый прогон падает (LLM_UNAVAILABLE) — user A персистирован, ответа НЕТ
    const failingA = new ScriptedProvider([]);
    const errA = await trpcError(
      callerWith(user, failingA).ai.sendMessage({ id: idA, threadId, content: 'сообщение A' }),
    );
    expect(errA.code).toBe('SERVICE_UNAVAILABLE');

    // 2) B: приходит ПОЗЖЕ и получает ответ Rb (пишется с metadata.replyTo = idB)
    const idB = newId();
    const providerB = new ScriptedProvider([endTurn('ответ на B (Rb)')]);
    const rB = answered(
      await callerWith(user, providerB).ai.sendMessage({
        id: idB,
        threadId,
        content: 'сообщение B',
      }),
    );
    expect(rB.replayed).toBe(false);
    expect(rB.assistantMessage.content).toBe('ответ на B (Rb)');

    // 3) Ретрай A с тем же client-id. Временна́я логика вернула бы Rb (replayed=true);
    //    detерминизм по replyTo: ответа A нет → провайдер вызывается, отдаёт свой Ra.
    const retryA = new ScriptedProvider([endTurn('ответ на A (Ra)')]);
    const rA = answered(
      await callerWith(user, retryA).ai.sendMessage({
        id: idA,
        threadId,
        content: 'сообщение A',
      }),
    );

    expect(rA.replayed).toBe(false); // на старой логике было бы true (вернулся бы Rb)
    expect(rA.assistantMessage.id).not.toBe(rB.assistantMessage.id); // НИКОГДА чужой Rb
    expect(rA.assistantMessage.content).toBe('ответ на A (Ra)');
    expect(retryA.requests).toHaveLength(1); // провайдер тронут — честный прогон, не replay

    // Ответы адресны по replyTo: Ra→idA, Rb→idB
    const msgs = await threadMessages(user, threadId);
    const assistants = msgs.filter((m) => m.role === 'assistant');
    expect(assistants).toHaveLength(2);
    const replyToOf = (m: { metadata: unknown }) => (m.metadata as { replyTo?: string }).replyTo;
    expect(assistants.find((m) => replyToOf(m) === idA)?.id).toBe(rA.assistantMessage.id);
    expect(assistants.find((m) => replyToOf(m) === idB)?.id).toBe(rB.assistantMessage.id);
  });
});

// ---------------------------------------------------------------------------
// Конкурентный ретрай (маркер processing)
// ---------------------------------------------------------------------------

describe('ai.sendMessage: конкурентный ретрай во время первого прогона (маркер processing)', () => {
  /** Провайдер с воротами: chat() виснет до release() — окно конкуренции управляемо. */
  class GatedProvider implements LLMProvider {
    calls = 0;
    private releaseGate!: () => void;
    private signalStarted!: () => void;
    readonly started: Promise<void>;
    private readonly gate: Promise<void>;
    constructor() {
      this.started = new Promise((res) => {
        this.signalStarted = res;
      });
      this.gate = new Promise((res) => {
        this.releaseGate = res;
      });
    }
    release(): void {
      this.releaseGate();
    }
    async chat(): Promise<LLMResponse> {
      this.calls += 1;
      this.signalStarted();
      await this.gate;
      return endTurn('готово после гонки');
    }
  }

  test('два конкурентных вызова с одним client-UUID → один tool-цикл, второй ответ { status: processing }', async () => {
    const user = freshUserId();
    const threadId = await globalThread(user);
    const msgId = newId();
    const gated = new GatedProvider();
    const caller = callerWith(user, gated);

    const firstCall = caller.ai.sendMessage({ id: msgId, threadId, content: 'долгий запрос' });
    await gated.started; // первый прогон дошёл до провайдера — маркер закоммичен

    // Ретрай во время прогона: НЕ второй цикл, а сигнал «ответ готовится»
    const r2 = await caller.ai.sendMessage({ id: msgId, threadId, content: 'долгий запрос' });
    expect(r2).toEqual({ status: 'processing' });
    expect(gated.calls).toBe(1);

    gated.release();
    const r1 = await firstCall;
    if ('status' in r1) throw new Error('ожидался полный ответ первого прогона');
    expect(r1.assistantMessage.content).toBe('готово после гонки');
    expect(gated.calls).toBe(1); // ровно один tool-цикл на оба вызова

    // Маркер снят той же tx, что записала ответ: повтор — replay ответа, не processing
    const r3 = await callerWith(user, new ScriptedProvider([])).ai.sendMessage({
      id: msgId,
      threadId,
      content: 'долгий запрос',
    });
    if ('status' in r3) throw new Error('ожидался replay существующего ответа');
    expect(r3.replayed).toBe(true);
    expect(r3.assistantMessage.id).toBe(r1.assistantMessage.id);
    const markerRows = await withIdentity(db, user, (tx) =>
      tx
        .select()
        .from(chatMessages)
        .where(eq(chatMessages.id, processingMessageId(msgId))),
    );
    expect(markerRows).toHaveLength(0);
  });

  test('маркер моложе 10 минут без ответа → { status: processing }, провайдер не тронут', async () => {
    const user = freshUserId();
    const threadId = await globalThread(user);
    const msgId = newId();
    // Сымитированный живой прогон другого процесса: user-сообщение + маркер без ответа
    await seedDeadRun(user, threadId, msgId, T0);
    const provider = new ScriptedProvider([]); // при вызове бросил бы
    const r = await callerWith(user, provider, {
      clock: () => new Date(T0.getTime() + 5 * 60_000),
    }).ai.sendMessage({ id: msgId, threadId, content: 'запрос' });
    expect(r).toEqual({ status: 'processing' });
    expect(provider.requests).toHaveLength(0);
  });

  test('маркер старше 10 минут без ответа → прогон умер: цикл перезапускается', async () => {
    const user = freshUserId();
    const threadId = await globalThread(user);
    const msgId = newId();
    await seedDeadRun(user, threadId, msgId, T0);
    const retry = new ScriptedProvider([endTurn('ответ после перезапуска')]);
    const r = await callerWith(user, retry, {
      clock: () => new Date(T0.getTime() + 11 * 60_000),
    }).ai.sendMessage({ id: msgId, threadId, content: 'запрос' });
    if ('status' in r) throw new Error('ожидался полный ответ перезапуска');
    expect(r.replayed).toBe(false);
    expect(r.assistantMessage.content).toBe('ответ после перезапуска');
    expect(retry.requests).toHaveLength(1);
  });

  test('сбой прогона снимает маркер: немедленный ретрай — легитимный полный прогон (§7.9)', async () => {
    const user = freshUserId();
    const threadId = await globalThread(user);
    const msgId = newId();
    const failing = new ScriptedProvider([]); // первый вызов провайдера бросает
    const err = await trpcError(
      callerWith(user, failing).ai.sendMessage({ id: msgId, threadId, content: 'запрос' }),
    );
    expect(err.code).toBe('SERVICE_UNAVAILABLE');
    // Маркер мёртвого прогона не должен блокировать ретрай ни секунды
    const markerRows = await withIdentity(db, user, (tx) =>
      tx
        .select()
        .from(chatMessages)
        .where(eq(chatMessages.id, processingMessageId(msgId))),
    );
    expect(markerRows).toHaveLength(0);
  });
});

/** Сид мёртвого прогона (краш процесса): user-сообщение + маркер processing без ответа. */
async function seedDeadRun(user: string, threadId: string, msgId: string, at: Date): Promise<void> {
  await withIdentity(db, user, async (tx) => {
    await tx.insert(chatMessages).values({
      id: msgId,
      threadId,
      role: 'user',
      content: 'запрос',
      metadata: {},
      createdAt: at,
    });
    await tx.insert(chatMessages).values({
      id: processingMessageId(msgId),
      threadId,
      role: 'system',
      content: '',
      metadata: { type: 'processing', replyTo: msgId },
      createdAt: at,
    });
  });
}

describe('ai.sendMessage: ошибка тула в цикле', () => {
  test('error_card в карточках; модель получает структурную ошибку (путь самокоррекции)', async () => {
    const user = freshUserId();
    const threadId = await globalThread(user);
    const scripted = new ScriptedProvider([
      toolUse([{ name: 'entity_update', input: { id: newId(), title: 'Нет такой' } }]),
      endTurn('Не нашёл сущность.'),
    ]);
    const r = answered(
      await callerWith(user, scripted).ai.sendMessage({
        id: newId(),
        threadId,
        content: 'переименуй',
      }),
    );

    const payload = toolResultPayload(lastOf(scripted.requests[1]), 'entity_update');
    expect(payload.status).toBe('error');
    expect(payload.error.code).toBe('NOT_FOUND');
    const cards = cardsOf(r.assistantMessage);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ kind: 'error_card', code: 'NOT_FOUND' });
    expect(r.assistantMessage.content).toBe('Не нашёл сущность.');
  });
});

describe('ai.sendMessage: ctx.ai не инжектирован — fail-fast (§DI hardening)', () => {
  test('ctx.ai=undefined → проброс Error(/ai deps/i), а не тихая сборка фолбэка', async () => {
    // Боевой путь ВСЕГДА инжектит ai (index.ts). Отсутствие ctx.ai — дефект DI, а не
    // легитимный сценарий: раньше роутер молча собирал боевые deps по env (в тест-окружении
    // — EchoProvider) и прогонял цикл на валидном треде. Теперь defaultAiDeps() бросает.
    const user = freshUserId();
    const threadId = await globalThread(user); // валидный тред: старый фолбэк дошёл бы до цикла
    const caller = createCaller({
      actorUserId: user,
      actorKind: 'owner',
      db,
      clientVersion: null,
      ai: undefined,
    });
    await expect(
      caller.ai.sendMessage({ id: newId(), threadId, content: 'привет' }),
    ).rejects.toThrow(/ai deps/i);
  });
});

describe('ai.sendMessage: ownerOnly (§9.3)', () => {
  test('PAT-агент получает FORBIDDEN из middleware до какой-либо работы', async () => {
    // db — стаб: если middleware пропустит, вызов упадёт не-FORBIDDEN ошибкой БД
    const scripted = new ScriptedProvider([]);
    const agent = createCaller({
      actorUserId: freshUserId(),
      actorKind: 'agent',
      db: null as unknown as Context['db'],
      clientVersion: null,
      ai: { provider: scripted, model: MODEL },
    });
    const err = await trpcError(
      agent.ai.sendMessage({ id: newId(), threadId: newId(), content: 'хак' }),
    );
    expect(err.code).toBe('FORBIDDEN');
    expect(scripted.requests).toHaveLength(0);
  });
});
