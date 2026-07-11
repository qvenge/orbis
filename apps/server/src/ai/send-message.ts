// apps/server/src/ai/send-message.ts
// ai.sendMessage (Task 9) — tool-цикл внутреннего чата: обычная мутация, ответ
// целиком (§7.7 D7, без стриминга). Алгоритм:
//   1) персист user-сообщения (идемпотентно по client-id — путь Task 12 1a) ПЕРВЫМ
//      отдельным tx: при любом дальнейшем исходе сообщение не теряется (§7.9);
//      он же даёт якорь треда (entity_id → слой 3 контекста, 02 §2.2);
//      1a) fix round: если это ПОВТОР (client-id уже в треде) и ответ на него уже
//      существует — вернуть существующий ответ (replay) БЕЗ провайдера и метеринга:
//      ретрай после разрыва «запрос ушёл — ответ не дошёл» не должен исполнять
//      действия и жечь токены второй раз; ответа нет (первый прогон упал
//      LLM_UNAVAILABLE) — легитимный ретрай §7.9, цикл гонится как обычно;
//   2) entitlements-гейт ai.requests_per_day / ai.tokens_per_day (§8) ДО первого
//      вызова провайдера — dev безлимитен, резолвер инжектируем;
//   3) buildContext (§7.1 слои 1–4; user-сообщение уже в окне — контракт Task 8)
//      + buildToolRegistry (слой 5);
//   4) цикл: пока stopReason === 'tool_use' и шаг < MAX_AGENT_STEPS — каждый tool-call
//      через dispatchTool (source 'chat', actorKind 'ai', explicitCommand false —
//      политика §7.10 внутри диспатча); результат — СЛЕДУЮЩИМ user-сообщением строго
//      через toolResultMessage (канонический сериализатор Task 8); превышение лимита
//      шагов — принудительный финал с пометкой, НЕ ошибка;
//   5) персист assistant-сообщения: content = финальный текст, metadata.cards =
//      карточки ВСЕХ действий цикла (вкл. error_card) — хронология для рендера 1c;
//      audit-сообщения своих действий уже написал executor через dispatch;
//   6) recordUsage — суммарно по всем шагам, отдельным коротким tx; сбой метеринга
//      логируется, но НЕ ломает ответ пользователю (решение Task 9);
//   7) throw из provider.chat → структурная ошибка LLM_UNAVAILABLE (503): явная
//      ошибка с возможностью повторить, user-сообщение сохранено, очереди нет (§7.9).
import { MAX_AGENT_STEPS, newId, processingMessageId } from '@orbis/shared';
import { and, eq, sql } from 'drizzle-orm';
import { appendMessage, appendMessageIdempotent, type WireChatMessage } from '../chat/messages';
import type { Db } from '../db/client';
import { aiUsage, chatMessages, chatThreads } from '../db/schema';
import { type Tx, withIdentity } from '../db/with-identity';
import { type EntitlementResolver, resolveEntitlement } from '../entitlements';
import { ExecError } from '../errors';
import { DEFAULT_ANTHROPIC_MODEL } from '../llm/anthropic';
import { buildContext, toolResultMessage } from '../llm/context';
import { EchoProvider, type LLMProviderEnv, makeLLMProvider } from '../llm/provider';
import type { LLMMessage, LLMProvider, LLMResponse, LLMToolDef } from '../llm/types';
import { dispatchTool } from '../tools/dispatch';
import { buildToolRegistry, type Card } from '../tools/registry';
import { toWireChatMessage } from '../wire';
import { recordUsage, type UsageTotals, utcDay } from './metering';

/**
 * Потолок ответа модели за шаг (LLMRequest.maxTokens); ориентиры бюджета — §7.1.
 * 8192: на claude-sonnet-5 adaptive thinking включён по умолчанию и считается в output —
 * прежних 4096 хватало бы впритык (симптом обрыва — stopReason max_tokens).
 */
export const MAX_OUTPUT_TOKENS = 8192;

/** Пометка принудительного финала при достижении MAX_AGENT_STEPS (не ошибка). */
export const STEP_LIMIT_NOTE = '[цикл остановлен: достигнут лимит шагов]';

/**
 * Пометка обрыва по потолку токенов. Без неё усечённый (а при adaptive thinking — и вовсе
 * пустой) ответ персистится как нормальный, да ещё и навсегда: replyTo делает его ответом
 * на этот client-id, и «повторить» будет возвращать обрезок из replay-ветки.
 */
export const MAX_TOKENS_NOTE = '[ответ обрезан: достигнут потолок токенов]';

/** Текст error_card при отказе модели (stopReason refusal). */
export const REFUSAL_NOTE = 'модель отказалась отвечать';

/** Ключи entitlements §8, которые гейтит sendMessage. */
const AI_REQUESTS_KEY = 'ai.requests_per_day';
const AI_TOKENS_KEY = 'ai.tokens_per_day';

/**
 * Зависимости AI-слоя: создаются один раз на процесс (index.ts) и попадают в
 * request-контекст (Context.ai); тесты инжектируют ScriptedProvider и резолвер.
 */
export interface AiDeps {
  provider: LLMProvider;
  /** Имя модели для метеринга §4.7 (§7.7: имя модели — конфиг, не хардкод PRD). */
  model: string;
  /** Резолвер §8; по умолчанию — боевой resolveEntitlement (dev безлимитен). */
  entitlements?: EntitlementResolver;
  clock?: () => Date;
}

/**
 * Сборка боевых AiDeps по env: провайдер — фабрикой Task 7 (fail-fast на невалидном
 * env при старте процесса), имя модели для метеринга — ORBIS_LLM_MODEL либо дефолт
 * Anthropic; EchoProvider метрится как 'echo' (нулевые токены, но request_count честный).
 */
export function makeAiDeps(env: LLMProviderEnv = process.env): AiDeps {
  const provider = makeLLMProvider(env);
  const model =
    provider instanceof EchoProvider ? 'echo' : env.ORBIS_LLM_MODEL || DEFAULT_ANTHROPIC_MODEL;
  return { provider, model };
}

// Fail-fast: боевой путь ВСЕГДА инжектит ai в контекст (index.ts → makeCreateContext).
// Отсутствие ctx.ai на пути ai.sendMessage — дефект DI, а не легитимный сценарий;
// прежняя ленивая сборка боевых deps по env лишь маскировала бы его (финал-ревью 1b).
export function defaultAiDeps(): AiDeps {
  throw new Error('ai deps must be injected; ctx.ai is required');
}

export interface SendMessageInput {
  ownerId: string;
  /** Client-generated UUID user-сообщения (§2.1); повтор — идемпотентный replay. */
  id: string;
  threadId: string;
  content: string;
}

/** Резюме исполненного действия — для мгновенного UI-обновления (undo-адресуемо §7.8). */
export interface ActionSummary {
  actionId: string;
  entityId?: string;
  /** Реестровое имя тула (§9.2) — что именно исполнено. */
  type: string;
}

export interface PendingSummary {
  pendingId: string;
}

export interface SendMessageAnswer {
  assistantMessage: WireChatMessage;
  actions: ActionSummary[];
  pending: PendingSummary[];
  /**
   * true — ретрай с тем же client-id вернул УЖЕ СУЩЕСТВУЮЩИЙ ответ (fix round):
   * цикл не гонялся, actions/pending пусты (минимальное решение — резюме прошлого
   * прогона не реконструируется; карточки доступны в metadata.cards возвращённого
   * сообщения). UI 1c при replayed обязан рефетчить тред, а не аппендить локально.
   */
  replayed: boolean;
}

/**
 * Ретрай во время ЖИВОГО первого прогона (маркер processing моложе PROCESSING_TTL_MS):
 * второй tool-цикл не запускается — клиент перечитывает тред позже (refetch с backoff).
 */
export interface SendMessageProcessing {
  status: 'processing';
}

export type SendMessageResult = SendMessageAnswer | SendMessageProcessing;

/**
 * TTL маркера processing: моложе — первый прогон считается живым (ретраю отвечаем
 * { status: 'processing' }), старше — прогон умер без снятия маркера (краш процесса),
 * цикл перезапускается. Штатные исходы снимают маркер сами: успех — той же tx, что
 * пишет ответ; сбой — в catch (немедленный ретрай после ошибки легитимен, §7.9).
 */
export const PROCESSING_TTL_MS = 10 * 60_000;

/**
 * Протокол pending для модели (митигация Minor-4 Task 6): dispatch не дедуплицирует
 * pending по batch_id модели — ретрай того же вызова создал бы ВТОРУЮ pending-карточку,
 * поэтому tool-результат прямо запрещает повтор: ожидание — терминальный исход хода.
 */
function pendingNote(pendingId: string): string {
  return (
    `действие не исполнено — ждёт подтверждения владельца (pendingId=${pendingId}). ` +
    'Ожидание подтверждения — терминальный исход этого хода: не повторяй этот вызов ' +
    'и не отправляй его заново с другими параметрами; сообщи пользователю, что действие ' +
    'ждёт его решения на карточке.'
  );
}

export async function sendMessage(
  db: Db,
  deps: AiDeps,
  input: SendMessageInput,
): Promise<SendMessageResult> {
  const clock = deps.clock ?? (() => new Date());
  const resolve = deps.entitlements ?? resolveEntitlement;
  const markerId = processingMessageId(input.id);

  // 1. Персист user-сообщения ПЕРВЫМ отдельным tx (§7.9: не теряется ни при гейте,
  //    ни при сбое провайдера) + якорь треда. Чужой/несуществующий тред под RLS
  //    неразличимы — единый NOT_FOUND (как chat.appendUserMessage).
  interface Preflight {
    anchorEntityId: string | null;
    existingAnswer?: WireChatMessage;
    processing?: true;
  }
  const pre = await withIdentity(db, input.ownerId, async (tx): Promise<Preflight> => {
    const rows = await tx
      .select({ entityId: chatThreads.entityId })
      .from(chatThreads)
      .where(eq(chatThreads.id, input.threadId));
    const thread = rows[0];
    if (!thread) {
      throw new ExecError('NOT_FOUND', 'тред не найден', { threadId: input.threadId });
    }
    const appended = await appendMessageIdempotent(tx, {
      id: input.id,
      threadId: input.threadId,
      role: 'user',
      content: input.content,
    });
    if (appended.replayed) {
      // 1a (fix round). Повтор client-id: ответ уже существует → replay без нового цикла.
      // Матч ДЕТЕРМИНИРОВАННЫЙ — по metadata.replyTo === id этого user-сообщения (не по
      // временно́му курсору «ближайший assistant после»): при out-of-order ретрае старого
      // упавшего сообщения ближайший по времени assistant мог бы оказаться ответом на
      // ДРУГОЕ, более позднее сообщение — replyTo это исключает.
      const existingAnswer = await findAnswerByReplyTo(tx, input.threadId, appended.message.id);
      if (existingAnswer !== undefined) {
        return { anchorEntityId: thread.entityId, existingAnswer };
      }
      // 1b. Ответа нет. Маркер processing моложе TTL — первый прогон ЖИВ: второй
      // параллельный tool-цикл не запускается (двойное исполнение действий, двойной
      // метеринг, два ответа с одним replyTo) — клиенту сигнал «ответ готовится».
      const markerRows = await tx
        .select({ createdAt: chatMessages.createdAt })
        .from(chatMessages)
        .where(eq(chatMessages.id, markerId));
      const marker = markerRows[0];
      if (marker && clock().getTime() - marker.createdAt.getTime() < PROCESSING_TTL_MS) {
        return { anchorEntityId: thread.entityId, processing: true };
      }
      // Прогона нет (сбой снял маркер, §7.9) либо он умер, не сняв (краш процесса,
      // маркер старше TTL) → легитимный перезапуск; протухший маркер пересоздаётся
      // ниже со свежим createdAt той же tx.
      if (marker) await tx.delete(chatMessages).where(eq(chatMessages.id, markerId));
    }
    // Маркер «прогон идёт» — той же tx, что и user-сообщение: конкурентный ретрай
    // либо увидит закоммиченную пару (сообщение + маркер), либо подождёт её на
    // unique-индексе PK. Детерминированный id — processingMessageId(client-UUID).
    // Конфликт PK достижим только в гонке перезапусков мёртвого прогона (оба увидели
    // протухший маркер, конкурент пересоздал первым) → цикл ведёт он, нам — processing.
    const inserted = await tx
      .insert(chatMessages)
      .values({
        id: markerId,
        threadId: input.threadId,
        role: 'system',
        content: '',
        metadata: { type: 'processing', replyTo: input.id },
        createdAt: clock(),
      })
      .onConflictDoNothing({ target: chatMessages.id })
      .returning({ id: chatMessages.id });
    if (inserted.length === 0) {
      return { anchorEntityId: thread.entityId, processing: true };
    }
    return { anchorEntityId: thread.entityId };
  });
  if (pre.processing === true) {
    return { status: 'processing' };
  }
  if (pre.existingAnswer !== undefined) {
    // БЕЗ вызова провайдера и БЕЗ метеринга: действия прошлого прогона не повторяются
    return { assistantMessage: pre.existingAnswer, actions: [], pending: [], replayed: true };
  }
  const anchorEntityId = pre.anchorEntityId;

  try {
    return await runAgentLoop(db, deps, input, { clock, resolve, anchorEntityId, markerId });
  } catch (e) {
    // Прогон умер до ответа (гейт §8, сбой провайдера, ошибка цикла): маркер снимается —
    // немедленный ретрай легитимен (§7.9), «processing» не блокирует его до TTL.
    // Сбой уборки не маскирует исходную ошибку.
    try {
      await withIdentity(db, input.ownerId, (tx) =>
        tx.delete(chatMessages).where(eq(chatMessages.id, markerId)),
      );
    } catch (cleanupError) {
      console.error('[ai.sendMessage] маркер processing не снят:', cleanupError);
    }
    throw e;
  }
}

/** Шаги 2–6: гейт §8 → контекст §7.1 → tool-цикл → персист ответа (+снятие маркера) → метеринг. */
async function runAgentLoop(
  db: Db,
  deps: AiDeps,
  input: SendMessageInput,
  run: {
    clock: () => Date;
    resolve: EntitlementResolver;
    anchorEntityId: string | null;
    markerId: string;
  },
): Promise<SendMessageAnswer> {
  const { clock, resolve, anchorEntityId, markerId } = run;

  // 2. Entitlements-гейт §8 — ДО первого вызова провайдера
  await gateAiEntitlements(db, input.ownerId, resolve, clock);

  // 3. Контекст §7.1 (слои 1–4) + реестр тулов (слой 5) — один withIdentity-tx.
  //    system идёт ОТДЕЛЬНЫМ полем запроса (контракт Task 7: system-роль в messages
  //    запрещена — Anthropic бросает); buildContext это гарантирует по построению.
  const { system, history, tools } = await withIdentity(db, input.ownerId, async (tx) => {
    const ctx = await buildContext(tx, {
      ownerId: input.ownerId,
      threadId: input.threadId,
      ...(anchorEntityId !== null && { anchorEntityId }),
    });
    const defs = await buildToolRegistry(tx);
    // OrbisToolDef → LLMToolDef; internalOnly (user_query) остаётся: внутренний чат —
    // его законный потребитель, отсечение касается только MCP (Task 10)
    const llmTools: LLMToolDef[] = defs.map((d) => ({
      name: d.name,
      description: d.description,
      inputSchema: d.inputJsonSchema,
    }));
    return { system: ctx.system, history: ctx.messages, tools: llmTools };
  });

  // 4. Tool-цикл: копим карточки/резюме и usage по шагам
  const cards: Card[] = [];
  const actions: ActionSummary[] = [];
  const pending: PendingSummary[] = [];
  const usage: UsageTotals = { inputTokens: 0, outputTokens: 0, requestCount: 0 };
  const convo: LLMMessage[] = [...history];
  let finalText = '';

  try {
    for (let step = 1; ; step++) {
      let response: LLMResponse;
      try {
        response = await deps.provider.chat({
          system,
          messages: convo,
          tools,
          maxTokens: MAX_OUTPUT_TOKENS,
        });
      } catch (e) {
        // §7.9: явная структурная ошибка с причиной; user-сообщение уже в БД,
        // в очередь ничего не встаёт; оригинал — в серверный лог
        console.error('[ai.sendMessage] сбой LLM-провайдера:', e);
        throw new ExecError(
          'LLM_UNAVAILABLE',
          'AI-провайдер недоступен — попробуйте повторить запрос',
          { reason: e instanceof Error ? e.message : String(e) },
        );
      }
      usage.inputTokens += response.usage.inputTokens;
      usage.outputTokens += response.usage.outputTokens;
      usage.requestCount += 1;

      // Отказ модели (refusal, §7.7): терминальный исход хода — error_card в хронологию,
      // tool-вызовы шага-отказа НЕ исполняются, цикл не продолжается. Токены шага
      // уже отметрены (честный расход).
      if (response.stopReason === 'refusal') {
        cards.push({ kind: 'error_card', code: 'LLM_REFUSAL', message: REFUSAL_NOTE });
        finalText = response.content;
        break;
      }

      // end_turn / max_tokens / tool_use без вызовов (защита от пустого зацикливания): финал.
      if (response.stopReason !== 'tool_use' || response.toolCalls.length === 0) {
        finalText =
          response.stopReason === 'max_tokens'
            ? // Обрыв по потолку — видимая пометка, а не «успешный» обрубок (см. MAX_TOKENS_NOTE).
              // Ошибку не бросаем: токены уже отметрены, а отсутствие ответа погнало бы
              // повторный полный цикл с повторным исполнением уже применённых действий.
              [response.content, MAX_TOKENS_NOTE].filter(Boolean).join('\n\n')
            : response.content;
        break;
      }
      if (step >= MAX_AGENT_STEPS) {
        // Принудительный финал (НЕ ошибка): tool-вызовы шага-нарушителя не исполняются —
        // модель уже не увидит их результатов и не сможет скорректироваться
        finalText = response.content
          ? `${response.content}\n\n${STEP_LIMIT_NOTE}`
          : STEP_LIMIT_NOTE;
        break;
      }

      // Промежуточный текст модели — в историю цикла (assistant), затем результаты
      // тулов user-сообщениями КАНОНИЧЕСКИМ сериализатором toolResultMessage (Task 8)
      if (response.content) convo.push({ role: 'assistant', content: response.content });
      for (const call of response.toolCalls) {
        const result = await runToolCall(db, input, clock, call.name, call.input, {
          cards,
          actions,
          pending,
        });
        convo.push(toolResultMessage(call.name, result));
      }
    }
  } finally {
    // 6. Метеринг §4.7 — суммарно по шагам, отдельным коротким tx ВНЕ цикла и вне
    //    tx executor'а (решение 8); пишется и при деградации (потреблённые шаги до
    //    сбоя — честный расход); сбой метеринга не ломает ответ пользователю
    if (usage.requestCount > 0) {
      try {
        await recordUsage(db, { ownerId: input.ownerId, model: deps.model, usage, clock });
      } catch (e) {
        console.error('[ai.sendMessage] метеринг ai_usage не записан:', e);
      }
    }
  }

  // 5. Assistant-сообщение: финальный текст + карточки всех действий цикла + replyTo —
  //    адресная привязка к user-сообщению (input.id): детерминированный replay ретрая
  //    §7.9 (findAnswerByReplyTo) вместо временно́го «ближайший assistant после».
  //    metadata.suggestions НЕ пишем (слайс 3). id — серверный uuidv7: ретрай
  //    sendMessage — новый прогон цикла, а не replay ответа (осознанно, MVP).
  //    Маркер processing снимается ТОЙ ЖЕ tx: «ответ есть» и «прогон идёт» не сосуществуют.
  const assistantMessage = await withIdentity(db, input.ownerId, async (tx) => {
    const message = await appendMessage(tx, {
      id: newId(),
      threadId: input.threadId,
      role: 'assistant',
      content: finalText,
      metadata: { cards, replyTo: input.id },
    });
    await tx.delete(chatMessages).where(eq(chatMessages.id, markerId));
    return message;
  });

  return { assistantMessage, actions, pending, replayed: false };
}

/**
 * Существующий ответ на данное user-сообщение для replay ретрая (fix round §7.9):
 * assistant-сообщение с metadata.replyTo === userMessageId. Детерминированный адресный
 * матч (не «ближайший по времени»): при out-of-order ретрае старого упавшего сообщения
 * временно́й курсор вернул бы ЧУЖОЙ более поздний ответ на другое сообщение того же треда.
 * replyTo пишется при персисте assistant-сообщения (шаг 5); нескольких ответов на один
 * запрос быть не может (id — серверный uuidv7, шаг цикла один), limit(1) — страховка.
 */
async function findAnswerByReplyTo(
  tx: Tx,
  threadId: string,
  userMessageId: string,
): Promise<WireChatMessage | undefined> {
  const rows = await tx
    .select()
    .from(chatMessages)
    .where(
      and(
        eq(chatMessages.threadId, threadId),
        eq(chatMessages.role, 'assistant'),
        sql`${chatMessages.metadata} ->> 'replyTo' = ${userMessageId}`,
      ),
    )
    .orderBy(chatMessages.createdAt, chatMessages.id)
    .limit(1);
  const row = rows[0];
  return row === undefined ? undefined : toWireChatMessage(row);
}

/**
 * Один tool-call цикла через dispatchTool (политика §7.10 — внутри диспатча).
 * Возвращает payload для toolResultMessage — дискриминированный union, зеркалящий
 * ToolDispatchResult; попутно копит карточки/резюме:
 * - ok → данные + карточка (entity_card/query_result/…) + ActionSummary при журналировании;
 * - pending_confirmation → карточка-заглушка «ждёт подтверждения», протокол «не повторяй»;
 * - error → структурная ошибка (путь самокоррекции модели) + error_card в хронологию.
 */
async function runToolCall(
  db: Db,
  input: SendMessageInput,
  clock: () => Date,
  name: string,
  callInput: Record<string, unknown>,
  collect: { cards: Card[]; actions: ActionSummary[]; pending: PendingSummary[] },
): Promise<unknown> {
  const r = await dispatchTool(
    {
      db,
      actorUserId: input.ownerId,
      actorKind: 'ai', // внутренний AI (§7.8 атрибуция; MutationSource 'chat')
      source: 'chat',
      threadId: input.threadId,
      explicitCommand: false, // §7.10: в 1b всегда false
      clock,
    },
    name,
    callInput,
  );
  if (r.status === 'ok') {
    if (r.card !== undefined) collect.cards.push(r.card);
    if (r.actionId !== undefined) {
      collect.actions.push({
        actionId: r.actionId,
        type: name,
        ...(r.card?.kind === 'entity_card' && { entityId: r.card.entityId }),
      });
    }
    return { status: 'ok', result: r.result };
  }
  if (r.status === 'pending_confirmation') {
    collect.cards.push(r.card);
    collect.pending.push({ pendingId: r.pendingId });
    return {
      status: 'pending_confirmation',
      pendingId: r.pendingId,
      message: pendingNote(r.pendingId),
    };
  }
  collect.cards.push({ kind: 'error_card', code: r.error.code, message: r.error.message });
  return { status: 'error', error: r.error };
}

/**
 * Гейт §8: оба AI-ключа через резолвер (инжектируемый). Отказ резолвера или
 * исчерпанный дневной лимит (счётчики ai_usage за день UTC, суммарно по моделям) →
 * LIMIT (429 маппингом errors.ts). На плане dev лимиты null — счётчики не читаются.
 */
async function gateAiEntitlements(
  db: Db,
  ownerId: string,
  resolve: EntitlementResolver,
  clock: () => Date,
): Promise<void> {
  const requests = resolve(ownerId, AI_REQUESTS_KEY);
  const tokens = resolve(ownerId, AI_TOKENS_KEY);
  for (const [key, decision] of [
    [AI_REQUESTS_KEY, requests],
    [AI_TOKENS_KEY, tokens],
  ] as const) {
    if (!decision.allowed) {
      throw new ExecError('LIMIT', `лимит «${key}» исчерпан`, { key, limit: decision.limit });
    }
  }
  if (requests.limit === null && tokens.limit === null) return;

  const date = utcDay(clock());
  const rows = await withIdentity(db, ownerId, (tx) =>
    tx
      .select({
        inputTokens: aiUsage.inputTokens,
        outputTokens: aiUsage.outputTokens,
        requestCount: aiUsage.requestCount,
      })
      .from(aiUsage)
      .where(eq(aiUsage.date, date)),
  );
  let usedRequests = 0;
  let usedTokens = 0;
  for (const row of rows) {
    usedRequests += row.requestCount;
    usedTokens += row.inputTokens + row.outputTokens;
  }
  if (requests.limit !== null && usedRequests >= requests.limit) {
    throw new ExecError('LIMIT', `лимит «${AI_REQUESTS_KEY}» исчерпан`, {
      key: AI_REQUESTS_KEY,
      limit: requests.limit,
      used: usedRequests,
    });
  }
  if (tokens.limit !== null && usedTokens >= tokens.limit) {
    throw new ExecError('LIMIT', `лимит «${AI_TOKENS_KEY}» исчерпан`, {
      key: AI_TOKENS_KEY,
      limit: tokens.limit,
      used: usedTokens,
    });
  }
}
