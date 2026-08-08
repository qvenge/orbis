// apps/server/src/llm/ai-sdk.ts
// Провайдеро-независимый слой поверх Vercel AI SDK (PRD 01 §7.7). Здесь живёт всё,
// что одинаково для любого провайдера SDK: маппинг результата и стоп-причины, маппинг
// тулов, таймаут шага и сам вызов generateText. Знание про конкретного провайдера
// (какой клиент создать, как называется модель по умолчанию) живёт в anthropic.ts
// и openai.ts — они тонкие.
//
// Типы AI SDK НЕ протекают наружу: LLMProvider отдаёт только наши LLMRequest/LLMResponse,
// а сам SDK остаётся заменяемой деталью реализации. Стриминг — шов на будущее (§7.7):
// в MVP ответ приходит целиком (generateText, не streamText).
//
// Факты зафиксированы по установленному ai@7.0.15:
// - finishReason SDK: 'stop' | 'length' | 'content-filter' | 'tool-calls' | 'error' | 'other';
// - usage.inputTokens/outputTokens: number | undefined (провайдер может не отдать);
// - toolCalls результата: [{ toolCallId, toolName, input, ... }].

import { generateText, type JSONSchema7, jsonSchema, type ToolSet, tool } from 'ai';
import type { LLMProvider, LLMRequest, LLMResponse, LLMToolDef } from './types';

/**
 * Тип модели, который принимает generateText. Выведен из самой сигнатуры SDK, а не
 * импортирован по имени: имена типов SDK меняются между минорами, форма параметра — нет.
 */
export type SdkModel = Parameters<typeof generateText>[0]['model'];

/** Значения finishReason установленного ai@7.0.15 (node_modules/ai/dist/index.d.ts:125). */
export type SdkFinishReason =
  | 'stop'
  | 'length'
  | 'content-filter'
  | 'tool-calls'
  | 'error'
  | 'other';

/**
 * Подмножество результата generateText, которое потребляет маппинг. Собственный
 * структурный тип (не импорт из SDK): GenerateTextResult ему совместим, а тесты
 * гоняют mapSdkResult на литеральных фикстурах без сети и моков.
 */
export interface SdkResultSubset {
  text: string;
  toolCalls: ReadonlyArray<{ toolCallId: string; toolName: string; input: unknown }>;
  finishReason: SdkFinishReason;
  usage: { inputTokens: number | undefined; outputTokens: number | undefined };
}

/** finishReason SDK → наш stopReason. */
function mapStopReason(reason: SdkFinishReason): LLMResponse['stopReason'] {
  switch (reason) {
    case 'tool-calls':
      return 'tool_use';
    case 'length':
      return 'max_tokens';
    case 'content-filter':
      // Отказ модели различим (ревью 2026-07-09): SDK мапит refusal в content-filter,
      // наружу идёт 'refusal' — send-message отвечает error_card без tool-цикла.
      return 'refusal';
    default:
      // 'stop' — штатный конец хода; 'error' | 'other' — аварийные резоны
      // детерминированно сводим к end_turn: ответ отдаётся как есть,
      // tool-цикл (Task 9) на них не продолжается.
      if (reason !== 'stop') {
        // После маппинга аварийный резон неотличим от штатного end_turn — фиксируем здесь
        console.warn(`[llm/ai-sdk] нештатный finishReason «${reason}» сведён к end_turn`);
      }
      return 'end_turn';
  }
}

/** Невалидный tool-call SDK (input — не JSON-объект) → {}: структурную ошибку модели вернёт валидация dispatch. */
function toInputRecord(input: unknown): Record<string, unknown> {
  if (typeof input === 'object' && input !== null && !Array.isArray(input)) {
    return input as Record<string, unknown>;
  }
  return {};
}

/**
 * Чистый маппинг результата generateText → LLMResponse. Вынесен из класса,
 * чтобы тестировать на литеральных структурах формата SDK (без сети).
 */
export function mapSdkResult(result: SdkResultSubset): LLMResponse {
  return {
    content: result.text,
    toolCalls: result.toolCalls.map((c) => ({
      id: c.toolCallId,
      name: c.toolName,
      input: toInputRecord(c.input),
    })),
    usage: {
      inputTokens: result.usage.inputTokens ?? 0,
      outputTokens: result.usage.outputTokens ?? 0,
    },
    stopReason: mapStopReason(result.finishReason),
  };
}

/**
 * Провайдеро-специфичные поля, которые домешиваются в КАЖДЫЙ тул запроса.
 *
 * Набор узкий не по осторожности: ядро ai@7 собирает описание тула для провайдера из
 * закрытого списка полей — description / inputExamples / providerOptions / strict
 * (node_modules/ai/dist/index.js:2028–2045), — и любое другое поле молча теряется по
 * дороге. Тип Record<string, unknown> обещал бы то, чего SDK не делает.
 */
export interface SdkToolExtras {
  /**
   * Строгость схемы тула. Задавать его вправе ТОЛЬКО тот провайдер, который сам этого
   * попросил, и цена нарушения — не косметическая.
   *
   * Пакет @ai-sdk/anthropic поступает с чужим strict по-разному, и решает это не он,
   * а способности модели: `supportsStrictTools = (config.supportsStrictTools ?? true)
   * && modelSupportsStructuredOutput` (dist/index.js:3652). У модели БЕЗ structured
   * output поле выбрасывается с предупреждением в консоль (:1599) — это безобидно.
   * У модели С structured output — а это ровно наш claude-sonnet-5 — работает другая
   * ветка (:1612), и strict МОЛЧА УХОДИТ в запрос к Anthropic, без единого warning.
   * Проверено перехватом fetch на @ai-sdk/anthropic@4.0.8: у claude-sonnet-5 в теле
   * запроса «"strict": false», warnings пуст; у claude-3-haiku-20240307 поля нет,
   * warning есть.
   *
   * То есть навязанное общим слоем значение не «поругалось бы в логи», а изменило бы
   * запрос к живому провайдеру за спиной у Anthropic-обёртки. Поэтому общий слой
   * своего strict не имеет и без extras форму тула не меняет вообще.
   *
   * Поле объявлено самим SDK (@ai-sdk/provider-utils, BaseFunctionTool.strict) и
   * реэкспортировано из 'ai' вместе с tool()/ToolSet — каст здесь не нужен.
   */
  strict?: boolean;
}

/**
 * providerOptions вызова generateText. Форма выведена из сигнатуры SDK по тем же
 * соображениям, что и SdkModel: имена типов SDK меняются между минорами, форма — нет.
 * Своими руками её не написать: ProviderOptions требует JSONObject в значениях, и
 * «похожий» Record<string, Record<string, unknown>> потребовал бы каста.
 */
export type SdkProviderOptions = NonNullable<Parameters<typeof generateText>[0]['providerOptions']>;

/**
 * Наши LLMToolDef (JSON Schema из реестра Task 4) → ToolSet SDK через
 * jsonSchema()-хелпер. execute не задаётся: SDK не исполняет тулы —
 * tool-цикл ведёт chat-роутер (Task 9).
 *
 * extras домешиваются в каждый тул; при их отсутствии спред не добавляет ничего,
 * и тул остаётся ровно той же формы, что был, — от этого зависит Anthropic.
 */
export function toSdkTools(tools: readonly LLMToolDef[], extras?: SdkToolExtras): ToolSet {
  return Object.fromEntries(
    tools.map((t) => [
      t.name,
      tool({
        description: t.description,
        inputSchema: jsonSchema(t.inputSchema as JSONSchema7),
        ...extras,
      }),
    ]),
  );
}

/**
 * Потолок одного шага провайдера. Без него зависший коннект вешает мутацию навсегда:
 * SDK своего таймаута не ставит, а его maxRetries реагирует только на reject —
 * «висящий» запрос не ретраится и не отменяется. 180 с: adaptive thinking на
 * claude-sonnet-5 легитимно думает десятки секунд, поэтому порог заведомо выше рабочего.
 */
export const PROVIDER_TIMEOUT_MS = 180_000;

export interface AiSdkProviderOptions {
  /** Готовая модель SDK: её создаёт провайдеро-специфичный подкласс. */
  model: SdkModel;
  /**
   * Имя модели для метеринга (§4.7). Провайдер обязан знать его сам: раньше имя
   * бралось из env с дефолтом Anthropic, и второй провайдер молча метерился бы
   * как claude-sonnet-5.
   */
  modelId: string;
  /** Таймаут одного вызова; по умолчанию PROVIDER_TIMEOUT_MS. */
  timeoutMs?: number;
  /**
   * Поля, домешиваемые в КАЖДЫЙ тул запроса. Живут здесь, а не в общем коде, потому
   * что нужное значение знает только провайдер: OpenAI на Responses требует
   * strict: false, а claude-sonnet-5 то же самое поле молча увёз бы в запрос к
   * Anthropic — см. разбор в SdkToolExtras.
   */
  toolExtras?: SdkToolExtras;
  /**
   * providerOptions для generateText — провайдеро-специфичные настройки запроса
   * (OpenAI: store). Общий слой их только переносит и своих не добавляет.
   */
  providerOptions?: SdkProviderOptions;
}

/**
 * Базовый провайдер поверх AI SDK: РОВНО ОДИН шаг generateText на chat() — без
 * stopWhen/maxSteps SDK. Tool-цикл и его лимит — забота вызывающего (Task 9).
 *
 * Ограничение MVP (осознанное решение плана 1b): типы Вехи 0 (LLMMessage —
 * только текстовый content) не выражают tool-результаты как отдельные части
 * сообщений. Продолжение tool-цикла сериализует результаты тулов в user-сообщение
 * по текстовому протоколу, описанному в system-промпте (Task 9). Native tool
 * calling при этом сохраняется на стороне ЗАПРОСА определений и ОТВЕТА модели
 * (toolCalls), меняется только канал доставки результатов.
 *
 * system-сообщения внутри messages не поддерживаются (SDK: allowSystemInMessages
 * по умолчанию false) — системный канал один: поле LLMRequest.system.
 */
export class AiSdkProvider implements LLMProvider {
  readonly modelId: string;
  private readonly model: SdkModel;
  private readonly timeoutMs: number;
  private readonly toolExtras: SdkToolExtras | undefined;
  private readonly providerOptions: SdkProviderOptions | undefined;

  constructor(opts: AiSdkProviderOptions) {
    this.model = opts.model;
    this.modelId = opts.modelId;
    this.timeoutMs = opts.timeoutMs ?? PROVIDER_TIMEOUT_MS;
    this.toolExtras = opts.toolExtras;
    this.providerOptions = opts.providerOptions;
  }

  async chat(req: LLMRequest): Promise<LLMResponse> {
    const messages = req.messages.map((m) => {
      if (m.role === 'system') {
        throw new Error(
          'AiSdkProvider: system-сообщения в messages не поддерживаются — используйте поле LLMRequest.system',
        );
      }
      return { role: m.role, content: m.content };
    });
    const result = await generateText({
      model: this.model,
      system: req.system || undefined,
      messages,
      maxOutputTokens: req.maxTokens,
      // Таймаут шага (§7.9): по срабатыванию generateText отклоняется, вызывающий мапит
      // это в LLM_UNAVAILABLE с кнопкой «повторить» — вместо бесконечно висящей мутации.
      abortSignal: AbortSignal.timeout(this.timeoutMs),
      // undefined тут равнозначно отсутствию поля: провайдер, который ничего не
      // просил, получает запрос ровно той же формы, что и до появления опции
      providerOptions: this.providerOptions,
      // tools/toolChoice только при непустом наборе: Anthropic API отвергает
      // tool_choice без tools; выбор тула — всегда 'auto' (решение плана 1b)
      ...(req.tools.length > 0
        ? { tools: toSdkTools(req.tools, this.toolExtras), toolChoice: 'auto' as const }
        : {}),
    });
    return mapSdkResult(result);
  }
}
