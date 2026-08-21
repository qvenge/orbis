// apps/server/src/routines/runner.ts
// Раннер прогона рутины (V1.5) — цикл модели для УЖЕ созданного прогона. Сущность
// прогона заводит планировщик (Задача 10) или «прогнать сейчас» (Задача 11): «кто создал
// прогон, тот и гонит модель» — правило гонки (инвариант 1), и раннер его не дублирует.
//
// Цикл собран из существующих деталей (V1.5): provider.chat, buildToolRegistry +
// routineToolDefs, dispatchTool, runAgentVerb/closeRoutineRun, recordUsage,
// gateAiEntitlements. Отличий от чатового цикла (ai/send-message.ts) четыре, и все —
// следствия того, что за прогоном не стоит человек:
//
//   1. Контекст свой (routines/context.ts): свой системный слой и история прогонов
//      вместо ленты треда.
//   2. Пределы СВОИ: ROUTINE_MAX_STEPS (D42 ОЧ.10) вместо чатового MAX_AGENT_STEPS плюс
//      дедлайн прогона и рубильник остановки процесса — оба проверяются МЕЖДУ шагами
//      (Р-15). Потолок разведён с чатовым потому, что оборванный чат человек продолжает
//      репликой, а оборванный фоновый прогон оставляет утро без плана до следующего бакета.
//   3. Каждый вызов инструмента становится ШАГОМ прогона (V1.5) — кроме терминальных
//      глаголов: их исход и есть запись, а шаг поверх закрытого прогона получил бы
//      CONFLICT.
//   4. Исход прогона — не текст в чате, а состояние сущности: finished / checkpoint /
//      failed с причиной (V1.12). Расход §4.7 пишется в дневной счётчик И в аспект прогона.
import { isManualBucket, type RunUsageInput } from '@orbis/shared';
import { runById } from '../agent-loop/queries';
import { closeRoutineRun, runAgentVerb, type VerbCtx } from '../agent-loop/verbs';
import { recordUsage, type UsageTotals } from '../ai/metering';
import {
  gateAiEntitlements,
  MAX_OUTPUT_TOKENS,
  MAX_TOKENS_NOTE,
  STEP_LIMIT_NOTE,
} from '../ai/send-message';
import { ensureEntityThread } from '../chat/threads';
import { withIdentity } from '../db/with-identity';
import { type EntitlementResolver, resolveEntitlement } from '../entitlements';
import { ExecError } from '../errors';
import { execute } from '../executor/executor';
import { makeChatJournalSink } from '../executor/journal';
import { toolResultMessage } from '../llm/context';
import type { LLMMessage, LLMResponse, LLMToolCall, LLMToolDef } from '../llm/types';
import { dispatchTool, type ToolCallCtx, type ToolDispatchResult } from '../tools/dispatch';
import { buildToolRegistry, type RoutineRef, routineToolDefs } from '../tools/registry';
import { ROUTINE_MAX_STEPS, RUN_DEADLINE_MS } from './constants';
import { buildRoutineContext, type RoutineContextRoutine } from './context';
import { pauseIfFailing, type RoutineDeps, routineHistory, supersedeOpen } from './lifecycle';

/** Боевой синк — один инстанс на модуль (состояния не хранит), как в dispatch.ts. */
const defaultSink = makeChatJournalSink();

/**
 * Терминальные инструменты рутины: те, что закрывают прогон САМИ (V1.6, V1.9). После их
 * успеха раннеру нечего закрывать — только дописать расход, который знает только он.
 */
const TERMINAL_TOOLS: ReadonlySet<string> = new Set(['orbis_propose', 'orbis_checkpoint']);

/** Потолки текстовых полей аспекта прогона (schemas/aspects.ts) — обрезаем ДО записи. */
const REPORT_CAP = 20_000;
const FAIL_NOTE_CAP = 2_000;
const STEP_SUMMARY_CAP = 500;

/**
 * Сколько текста вопроса влезает в сводку шага. Меньше потолка самого шага намеренно: шаг
 * — строка в списке, а не место для четырёх тысяч символов; полный текст владелец читает
 * на карточке вопроса, которая лежит в том же треде.
 */
const ASK_STEP_CAP = 120;

/**
 * Чем кончился прогон — информационно для вызывающего (тик, «прогнать сейчас»). Само
 * состояние лежит в аспекте прогона: этот тип нужен, чтобы тик не перечитывал сущность
 * ради решения «ретраить ли» и мог отличить «не гоняли модель» от «модель отработала».
 *
 * Причины `failed`: `provider` — провайдер бросил; `deadline` — RUN_DEADLINE_MS между
 * шагами; `limit` — гейт §8 до провайдера; `refusal` — модель отказалась; `no_proposal` —
 * propose-прогон кончился без предложения; `aborted` — рубильник процесса ЛИБО прогон
 * закрыт чужой рукой (подметание, другой процесс) — раннер его не трогал; `steps` — лимит
 * шагов в propose; `internal` — исключение самого раннера вне обращения к провайдеру
 * (БД, журнал, запись шага): прогон закрыт `failed`, чтобы не висеть `running` до
 * подметания, а причина названа отдельно — это баг или инфраструктура, а не поведение
 * модели, и ретраить его тиком имеет смысл ровно так же, как `provider`.
 */
export type RunEnd = {
  outcome: 'finished' | 'checkpoint' | 'failed';
  reason?:
    | 'provider'
    | 'deadline'
    | 'limit'
    | 'refusal'
    | 'no_proposal'
    | 'aborted'
    | 'steps'
    | 'internal';
};

/** Что цикл решил сделать с прогоном — приговор, который исполняется ПОСЛЕ цикла. */
type Verdict =
  /** Закрыть прогон самим раннером (`closeRoutineRun` с расходом одним патчем). */
  | { kind: 'close'; end: RunEnd; report?: string; failNote?: string }
  /** Прогон закрыл терминальный глагол — остаётся дописать расход. */
  | { kind: 'closed-by-verb'; end: RunEnd }
  /** Прогон закрыт ЧУЖОЙ рукой (подметание, дедлайн другого процесса) — не трогаем. */
  | { kind: 'foreign'; end: RunEnd };

export interface RunRoutineRunArgs {
  ownerId: string;
  routine: RoutineContextRoutine;
  /** Прогон, уже созданный и находящийся в `running`. */
  runId: string;
  bucket: string;
}

/**
 * Ведёт прогон рутины от контекста до исхода.
 *
 * Порядок шагов задан спекой и не переставляется: гашение прошлого (V1.8) идёт ДО сборки
 * контекста — иначе модель увидела бы в истории собственное вчерашнее предложение как
 * «ждёт решения» и не стала бы предлагать новое; гейт лимитов (V1.15) — ДО первого
 * обращения к провайдеру (инвариант 13); стоп-кран (V1.12) — ПОСЛЕ закрытия прогона,
 * иначе последний сбой в счёт не попадёт.
 */
export async function runRoutineRun(deps: RoutineDeps, args: RunRoutineRunArgs): Promise<RunEnd> {
  const { ownerId, routine, runId } = args;
  const resolve = deps.entitlements ?? resolveEntitlement;
  const sink = deps.sink ?? defaultSink;
  const verbCtx: VerbCtx = {
    db: deps.db,
    ownerId,
    subject: { kind: 'routine', routineId: routine.id },
    clock: deps.clock,
    sink,
  };

  // Отсчёт дедлайна — от `started_at` САМОГО прогона, а не от входа в раннер: прогон
  // создаёт другой код (Задача 10/11), и между созданием и запуском цикла может пройти
  // время — например, если процесс подобрал прогон после рестарта.
  const row = await withIdentity(deps.db, ownerId, (tx) => runById(tx, runId));
  if (row === null || row.run.routine_id !== routine.id || row.run.outcome !== 'running') {
    // Прогона нет, он чужой или уже закрыт (подметание успело раньше). Модель не гоним и
    // ничего не переписываем: закрывший знал о прогоне столько же, сколько мы.
    return { outcome: 'failed', reason: 'aborted' };
  }
  const startedAt = Date.parse(row.run.started_at);

  const usage: UsageTotals = { inputTokens: 0, outputTokens: 0, requestCount: 0 };
  let verdict: Verdict;
  try {
    // Шаги 1–3 (гашение, гейт, снимок графа) стоят ПОД тем же catch-all, что и цикл модели
    // (финальное ревью V1, C1a-2): упавший синк журнала в гашении или отказ БД на сборке
    // контекста иначе оставляли бы прогон `running` до подметания — полчаса без ретрая, с
    // пропуском бакетов и «прогон уже идёт» на кнопке.
    verdict = await prepareAndLoop(deps, {
      args,
      startedAt,
      resolve,
      verbCtx,
      usage,
    });
  } catch (e) {
    // Сбой провайдера цикл ловит сам; сюда долетает всё остальное — БД, журнал, запись
    // шага. Пробросить значило бы оставить прогон в `running` до подметания (полчаса без
    // ретрая и без стоп-крана). Закрываем `failed` с названной причиной; если упадёт и
    // закрытие — исключение уйдёт наверх (тик Задачи 10 ловит), прогон подберёт sweep.
    console.error('[routines] внутренняя ошибка раннера:', e);
    verdict = {
      kind: 'close',
      end: { outcome: 'failed', reason: 'internal' },
      failNote: `внутренняя ошибка раннера: ${e instanceof Error ? e.message : String(e)}`,
    };
  } finally {
    // Расход §4.7 — отдельной короткой транзакцией и ВСЕГДА: потреблённые до сбоя шаги —
    // честный расход. Сбой метеринга не имеет права менять исход прогона.
    if (usage.requestCount > 0) {
      try {
        await recordUsage(deps.db, { ownerId, model: deps.model, usage, clock: deps.clock });
      } catch (e) {
        console.error('[routines] метеринг ai_usage не записан:', e);
      }
    }
  }

  return await settle(deps, verbCtx, args, verdict, usage);
}

/**
 * Шаги 1–3 подготовки прогона плюс цикл модели — всё, что может упасть исключением и
 * обязано быть закрыто `failed internal` (см. catch-all в runRoutineRun). Исчерпанный лимит
 * (шаг 2) — не исключение, а приговор: `failed limit` тем же путём, что и остальные исходы.
 */
async function prepareAndLoop(
  deps: RoutineDeps,
  run: {
    args: RunRoutineRunArgs;
    startedAt: number;
    resolve: EntitlementResolver;
    verbCtx: VerbCtx;
    usage: UsageTotals;
  },
): Promise<Verdict> {
  const { args, resolve, verbCtx, usage } = run;
  const { ownerId, routine, runId, bucket } = args;

  // 1. V1.8: новый прогон гасит незакрытое от прошлых
  await supersedeOpen(deps, { ownerId, routineId: routine.id, exceptRunId: runId });

  // 2. Гейт §8 — ДО провайдера (инвариант 13, приёмка 15). Исчерпанный лимит для рутины —
  //    не 429 кому-то в ответ, а исход прогона: `failed`, с ретраем и стоп-краном.
  try {
    await gateAiEntitlements(deps.db, ownerId, resolve, deps.clock);
  } catch (e) {
    if (e instanceof ExecError && e.code === 'LIMIT') {
      return {
        kind: 'close',
        end: { outcome: 'failed', reason: 'limit' },
        failNote: `прогон не запущен: ${e.message}`,
      };
    }
    throw e;
  }

  // 3. Один снимок графа на прогон: тред рутины (в него лягут audit мутаций и карточка
  //    предложения — FK на chat_threads), контекст и реестр тулов режима.
  const routineRef: RoutineRef = {
    id: routine.id,
    runId,
    mode: routine.routine.mode,
    allowedTools: new Set(routine.routine.allowed_tools ?? []),
  };
  const { threadId, system, messages, tools } = await withIdentity(deps.db, ownerId, async (tx) => {
    const thread = await ensureEntityThread(tx, ownerId, routine.id);
    const history = await routineHistory(tx, ownerId, routine.id, runId);
    const ctx = await buildRoutineContext(tx, {
      ownerId,
      routine,
      run: { id: runId, bucket },
      history,
    });
    // Реестр раннера — второй рубеж того же правила, что гейт диспатча (V1.10):
    // показанное модели и исполняемое сервером обязаны совпадать
    const defs = routineToolDefs(await buildToolRegistry(tx), routineRef);
    const llmTools: LLMToolDef[] = defs.map((d) => ({
      name: d.name,
      description: d.description,
      inputSchema: d.inputJsonSchema,
    }));
    return { threadId: thread, system: ctx.system, messages: ctx.messages, tools: llmTools };
  });

  const toolCtx: ToolCallCtx = {
    db: deps.db,
    actorUserId: ownerId,
    actorKind: 'ai', // за прогоном стоит внутренний AI (§7.8), а не внешний агент
    source: 'routine',
    runId,
    routine: routineRef,
    threadId,
    explicitCommand: false, // прямой команды владельца за фоновым прогоном нет
    clock: deps.clock,
    entitlements: resolve,
  };

  return modelLoop(deps, {
    args,
    startedAt: run.startedAt,
    system,
    messages,
    tools,
    toolCtx,
    verbCtx,
    usage,
  });
}

/**
 * Цикл модели. Возвращает приговор, а не пишет исход сам: закрытие прогона обязано нести
 * ПОЛНЫЙ расход, а он известен только после выхода из цикла — иначе токены последнего шага
 * не попали бы ни в аспект, ни в счётчик.
 */
async function modelLoop(
  deps: RoutineDeps,
  run: {
    args: RunRoutineRunArgs;
    startedAt: number;
    system: string;
    messages: LLMMessage[];
    tools: LLMToolDef[];
    toolCtx: ToolCallCtx;
    verbCtx: VerbCtx;
    usage: UsageTotals;
  },
): Promise<Verdict> {
  const { args, toolCtx, verbCtx, usage } = run;
  const mode = args.routine.routine.mode;
  const convo: LLMMessage[] = [...run.messages];

  for (let step = 1; ; step++) {
    // Дедлайн и рубильник — ПЕРЕД каждым шагом (Р-15): внешний AbortSignal провайдер не
    // принимает, а таймаут одного шага у него свой, поэтому граница проверяется здесь.
    if (deps.signal?.aborted === true) {
      return {
        kind: 'close',
        end: { outcome: 'failed', reason: 'aborted' },
        failNote: 'прогон остановлен при выключении процесса',
      };
    }
    if (deps.clock().getTime() - run.startedAt > RUN_DEADLINE_MS) {
      return {
        kind: 'close',
        end: { outcome: 'failed', reason: 'deadline' },
        failNote: `прогон превысил дедлайн ${RUN_DEADLINE_MS / 60_000} мин`,
      };
    }

    let response: LLMResponse;
    try {
      response = await deps.provider.chat({
        system: run.system,
        messages: convo,
        tools: run.tools,
        maxTokens: MAX_OUTPUT_TOKENS,
      });
    } catch (e) {
      // Сбой провайдера — исход прогона, а не 503 наружу: ретраит бакет тик (V1.3)
      console.error('[routines] сбой LLM-провайдера:', e);
      return {
        kind: 'close',
        end: { outcome: 'failed', reason: 'provider' },
        failNote: `AI-провайдер недоступен: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
    usage.inputTokens += response.usage.inputTokens;
    usage.outputTokens += response.usage.outputTokens;
    usage.requestCount += 1;

    // Отказ модели (§7.7): терминальный исход. Для чата это error_card в ленте, для
    // рутины — `failed`: прогон, который ничего не сделал, обязан быть ретраибельным.
    if (response.stopReason === 'refusal') {
      return {
        kind: 'close',
        end: { outcome: 'failed', reason: 'refusal' },
        failNote: 'модель отказалась работать',
      };
    }

    // end_turn / max_tokens / tool_use без вызовов (защита от пустого зацикливания)
    if (response.stopReason !== 'tool_use' || response.toolCalls.length === 0) {
      if (mode === 'propose') {
        // V1.12, названное исключение: propose-прогон без предложения — `failed`, иначе
        // утро осталось бы и без плана, и без ретрая. Успешный propose сюда не доходит —
        // orbis_propose терминален и выходит из цикла раньше.
        return {
          kind: 'close',
          end: { outcome: 'failed', reason: 'no_proposal' },
          failNote: 'прогон в режиме propose закончился без предложения',
        };
      }
      // Обрыв по потолку токенов — видимая пометка в отчёте, а не «успешный» обрубок (тот
      // же приём, что MAX_TOKENS_NOTE в чате): отчёт читает владелец на экране прогона, и
      // оборванный на полуслове текст без пометки выглядел бы законченной работой.
      const report =
        response.stopReason === 'max_tokens'
          ? [response.content, MAX_TOKENS_NOTE].filter(Boolean).join('\n\n')
          : response.content;
      return { kind: 'close', end: { outcome: 'finished' }, report };
    }

    if (step >= ROUTINE_MAX_STEPS) {
      // Лимит шагов (V1.12): в act — штатное закрытие с пометкой (работа, скорее всего,
      // частично сделана и видна в шагах), в propose — `failed`: предложения нет.
      if (mode === 'propose') {
        return {
          kind: 'close',
          end: { outcome: 'failed', reason: 'steps' },
          failNote: 'достигнут лимит шагов, предложение не подано',
        };
      }
      return {
        kind: 'close',
        end: { outcome: 'finished' },
        report: response.content ? `${response.content}\n\n${STEP_LIMIT_NOTE}` : STEP_LIMIT_NOTE,
      };
    }

    if (response.content) convo.push({ role: 'assistant', content: response.content });

    for (const call of response.toolCalls) {
      const result = await dispatchTool(toolCtx, call.name, call.input);
      const terminal = TERMINAL_TOOLS.has(call.name);

      if (terminal && result.status === 'ok') {
        // Прогон закрыт глаголом — цикл окончен. Второй шаг поверх терминального прогона
        // получил бы CONFLICT, а «продолжить» модели уже нечего.
        return {
          kind: 'closed-by-verb',
          end: { outcome: call.name === 'orbis_checkpoint' ? 'checkpoint' : 'finished' },
        };
      }
      if (terminal && result.status === 'error') {
        // Отказ терминального глагола двусмыслен: это либо «поправь вход» (VALIDATION —
        // модель ещё может исправиться), либо «твоего прогона больше нет» (его закрыл
        // sweep, дедлайн другого процесса или гашение). Различаем ЧТЕНИЕМ прогона, а не
        // разбором текста ошибки: состояние авторитетно, формулировки — нет.
        const alive = await runStillOurs(deps, args, toolCtx.actorUserId);
        if (!alive) return { kind: 'foreign', end: { outcome: 'failed', reason: 'aborted' } };
      }

      convo.push(toolResultMessage(call.name, toolResultPayload(result)));

      // Каждый НЕтерминальный вызов — шаг прогона (V1.5). Пишет его раннер напрямую
      // (runAgentVerb), а не модель: `orbis_run_step` ей не показан и закрыт гейтом —
      // бухгалтерию прогона ведёт тот, кто отвечает за его итог.
      if (!terminal) {
        const stepResult = await runAgentVerb(verbCtx, 'orbis_run_step', {
          run_id: args.runId,
          summary: stepSummary(call, result),
          external: false,
        });
        if (stepResult.status === 'error') {
          // Шаг не записался — значит прогон уже не `running` (или не наш). Продолжать
          // цикл нельзя: следующие шаги упрутся туда же, а исход уже подведён не нами.
          const alive = await runStillOurs(deps, args, toolCtx.actorUserId);
          if (!alive) return { kind: 'foreign', end: { outcome: 'failed', reason: 'aborted' } };
          console.error('[routines] шаг прогона не записан:', stepResult.error);
        }
      }
    }
  }
}

/** Прогон всё ещё наш и всё ещё идёт? Авторитетная сверка вместо разбора текста отказа. */
async function runStillOurs(
  deps: RoutineDeps,
  args: RunRoutineRunArgs,
  ownerId: string,
): Promise<boolean> {
  const row = await withIdentity(deps.db, ownerId, (tx) => runById(tx, args.runId));
  return row !== null && row.run.routine_id === args.routine.id && row.run.outcome === 'running';
}

/**
 * Приведение результата тула к форме, которую видит модель — тот же дискриминированный
 * union, что в чатовом цикле: `ok` с данными, `error` со структурной ошибкой (путь
 * самокоррекции), `pending_confirmation` — единица пачки.
 *
 * Ветка `pending_confirmation` — БОЕВАЯ с D42 (ОЧ.4): небезопасное действие фонового прогона
 * не отклоняется, а откладывается карточкой в тред рутины, и модель обязана узнать об этом
 * честно — `{status, pendingId}`, — чтобы продолжить работу, а не считать шаг проваленным.
 * До D42 сюда было не попасть: мутацию уровня выше `execute` рутине снимал гейт V1.10.
 */
function toolResultPayload(r: ToolDispatchResult): unknown {
  if (r.status === 'ok') return { status: 'ok', result: r.result };
  if (r.status === 'pending_confirmation') {
    return { status: 'pending_confirmation', pendingId: r.pendingId };
  }
  return { status: 'error', error: r.error };
}

/**
 * Сводка шага для ВЛАДЕЛЬЦА (экран прогона и история прогонов), а не для отладки. Прежняя
 * пара «имя: исход» остаётся всему, что и правда описывается ею, но у двух вызовов D42 она
 * скрывает ровно то, ради чего владелец открывает прогон: `orbis_ask: ok` не говорит, ЧТО
 * спросили, а `entity_update: pending_confirmation` — ЧТО отложили.
 *
 * `card.summary` без сужения по `kind` не скомпилируется — поля нет у карточки вопроса (на
 * вопрос отвечают, сводки-заголовка у него нет) и у карточек, которых у этой ветки не
 * бывает; отсутствие поля читается как «нечего сказать сверх имени тула».
 */
function stepSummary(call: LLMToolCall, result: ToolDispatchResult): string {
  if (call.name === 'orbis_ask' && result.status === 'ok') {
    const question = typeof call.input.question === 'string' ? call.input.question : '';
    return cap(`спросил: «${cap(question, ASK_STEP_CAP)}»`, STEP_SUMMARY_CAP);
  }
  if (result.status === 'pending_confirmation') {
    const summary = 'summary' in result.card ? result.card.summary : call.name;
    return cap(`отложено: ${summary}`, STEP_SUMMARY_CAP);
  }
  return `${call.name}: ${result.status}`;
}

function cap(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

/**
 * Исполнение приговора: закрытие прогона (или дозапись расхода) плюс стоп-кран.
 *
 * Расход попадает в аспект двумя разными путями, и это осознанно:
 * - закрывает раннер → `usage` едет ТЕМ ЖЕ патчем, что исход (одна операция, один action);
 * - закрыл терминальный глагол → отдельный `entity_update` без предусловия на исход:
 *   прогон уже терминален, и предусловие «всё ещё running» отклонило бы дозапись. Второй
 *   вариант не редкость, а штатный путь propose-прогона, поэтому он не «страховка».
 */
async function settle(
  deps: RoutineDeps,
  verbCtx: VerbCtx,
  args: RunRoutineRunArgs,
  verdict: Verdict,
  usage?: UsageTotals,
): Promise<RunEnd> {
  let end = verdict.end;

  if (verdict.kind === 'close') {
    const closed = await closeRoutineRun(verbCtx, {
      runId: args.runId,
      outcome: end.outcome === 'failed' ? 'failed' : 'finished',
      ...(verdict.report !== undefined &&
        verdict.report !== '' && { report: cap(verdict.report, REPORT_CAP) }),
      ...(verdict.failNote !== undefined && { failNote: cap(verdict.failNote, FAIL_NOTE_CAP) }),
      ...(usageInput(usage) !== undefined && { usage: usageInput(usage) }),
    });
    if (closed.status !== 'ok') {
      // Закрыть не удалось — прогон подобрал кто-то другой (подметание, ретрай тика).
      // Свой исход не навязываем: тик узнаёт «модель отработала, но итог не наш».
      // `pending_confirmation` здесь невозможен (closeRoutineRun идёт мимо политики), но
      // разбор через status честнее приведения: у ветки pending поля `error` нет.
      console.error(
        '[routines] исход прогона не записан:',
        closed.status === 'error' ? closed.error : closed.status,
      );
      end = { outcome: 'failed', reason: 'aborted' };
    }
  } else if (verdict.kind === 'closed-by-verb') {
    await patchRunUsage(deps, args, usage);
  }

  // Стоп-кран (V1.12) — после того, как исход лёг в граф: иначе последний сбой не попал бы
  // в счёт трёх. Ветка `foreign` тоже сюда: прогон закрыт как `failed` чужой рукой, и
  // считать его надо — счёт ведётся по графу, а не по нашим попыткам.
  //
  // Ручной прогон в стоп-кране не участвует (V1.3) — ни как единица счёта (это уже внутри
  // pauseIfFailing), ни как ПОВОД для оценки: владелец снял паузу и жмёт «прогнать
  // сейчас», чтобы проверить починку, — а хвост плановых прогонов всё ещё три сбоя, и
  // оценка по нему вернула бы паузу тем же тапом, которым он её снял.
  if (end.outcome === 'failed' && !isManualBucket(args.bucket)) {
    await pauseIfFailing(deps, { ownerId: args.ownerId, routineId: args.routine.id });
  }
  return end;
}

/** Расход в форме аспекта; ничего не потрачено — ключа нет (а не нули). */
function usageInput(usage?: UsageTotals): RunUsageInput | undefined {
  if (usage === undefined || usage.requestCount === 0) return undefined;
  return { input_tokens: usage.inputTokens, output_tokens: usage.outputTokens };
}

/** Дозапись расхода в прогон, закрытый терминальным глаголом (см. докблок settle). */
async function patchRunUsage(
  deps: RoutineDeps,
  args: RunRoutineRunArgs,
  usage?: UsageTotals,
): Promise<void> {
  const value = usageInput(usage);
  if (value === undefined) return;
  const r = await execute(
    deps.db,
    {
      actorUserId: args.ownerId,
      actorKind: 'ai',
      source: 'system', // бухгалтерия прогона (Р-7): не правка графа, а протокол
      runId: args.runId,
      operations: [
        {
          tool: 'entity_update',
          input: { id: args.runId, aspects: { 'orbis/agent-run': { usage: value } } },
        },
      ],
      clock: deps.clock,
    },
    { sink: deps.sink ?? defaultSink },
  );
  if (!r.ok) {
    // Расход в дневном счётчике уже есть (recordUsage) — потеря копии в аспекте портит
    // экран прогона, но не учёт лимитов; исход прогона из-за неё переписывать нельзя.
    console.error('[routines] расход не дописан в аспект прогона:', r.error);
  }
}
