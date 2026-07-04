// apps/server/src/llm/anthropic.ts
// AnthropicProvider — реализация LLMProvider поверх Vercel AI SDK (PRD 01 §7.7).
// Типы AI SDK НЕ протекают через интерфейс: наружу — только наши LLMRequest/LLMResponse;
// SDK остаётся заменяемой деталью реализации. Стриминг — шов на будущее (§7.7):
// в MVP ответ приходит целиком (generateText, не streamText).
//
// Факты зафиксированы по установленным пакетам ai@7.0.15 / @ai-sdk/anthropic@4.0.8:
// - finishReason SDK: 'stop' | 'length' | 'content-filter' | 'tool-calls' | 'error' | 'other';
// - usage.inputTokens/outputTokens: number | undefined (провайдер может не отдать);
// - toolCalls результата: [{ toolCallId, toolName, input, ... }].

import { createAnthropic } from '@ai-sdk/anthropic';
import { generateText, type JSONSchema7, jsonSchema, type ToolSet, tool } from 'ai';
import type { LLMProvider, LLMRequest, LLMResponse, LLMToolDef } from './types';

/** Модель по умолчанию; переопределяется env ORBIS_LLM_MODEL (§7.7: имя модели — конфиг). */
export const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-4-5';

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

/** finishReason SDK → наш stopReason (трёхзначный тип Вехи 0 — не расширяем). */
function mapStopReason(reason: SdkFinishReason): LLMResponse['stopReason'] {
  switch (reason) {
    case 'tool-calls':
      return 'tool_use';
    case 'length':
      return 'max_tokens';
    default:
      // 'stop' — штатный конец хода; 'content-filter' | 'error' | 'other' —
      // аварийные резоны детерминированно сводим к end_turn: ответ отдаётся
      // как есть, tool-цикл (Task 9) на них не продолжается.
      if (reason !== 'stop') {
        // Минимальный лог refusal (кандидат Task 7 Minor-2, закрыт Task 9): после
        // маппинга аварийный резон неотличим от штатного end_turn — фиксируем здесь
        console.warn(`[llm/anthropic] нештатный finishReason «${reason}» сведён к end_turn`);
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
 * Наши LLMToolDef (JSON Schema из реестра Task 4) → ToolSet SDK через
 * jsonSchema()-хелпер. execute не задаётся: SDK не исполняет тулы —
 * tool-цикл ведёт chat-роутер (Task 9).
 */
export function toSdkTools(tools: readonly LLMToolDef[]): ToolSet {
  return Object.fromEntries(
    tools.map((t) => [
      t.name,
      tool({ description: t.description, inputSchema: jsonSchema(t.inputSchema as JSONSchema7) }),
    ]),
  );
}

export interface AnthropicProviderOptions {
  apiKey: string;
  /** Id модели Anthropic; по умолчанию DEFAULT_ANTHROPIC_MODEL. */
  model?: string;
}

/**
 * Провайдер Anthropic: РОВНО ОДИН шаг generateText на chat() — без stopWhen/maxSteps
 * SDK. Tool-цикл и его лимит — забота вызывающего (Task 9, наша константа).
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
export class AnthropicProvider implements LLMProvider {
  private readonly model: ReturnType<ReturnType<typeof createAnthropic>>;

  constructor(opts: AnthropicProviderOptions) {
    const provider = createAnthropic({ apiKey: opts.apiKey });
    this.model = provider(opts.model ?? DEFAULT_ANTHROPIC_MODEL);
  }

  async chat(req: LLMRequest): Promise<LLMResponse> {
    const messages = req.messages.map((m) => {
      if (m.role === 'system') {
        throw new Error(
          'AnthropicProvider: system-сообщения в messages не поддерживаются — используйте поле LLMRequest.system',
        );
      }
      return { role: m.role, content: m.content };
    });
    const result = await generateText({
      model: this.model,
      system: req.system || undefined,
      messages,
      maxOutputTokens: req.maxTokens,
      // tools/toolChoice только при непустом наборе: Anthropic API отвергает
      // tool_choice без tools; выбор тула — всегда 'auto' (решение плана 1b)
      ...(req.tools.length > 0
        ? { tools: toSdkTools(req.tools), toolChoice: 'auto' as const }
        : {}),
    });
    return mapSdkResult(result);
  }
}
