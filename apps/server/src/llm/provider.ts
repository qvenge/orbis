// apps/server/src/llm/provider.ts
// EchoProvider (заглушка Вехи 0 — формат ответа запиннен тестом) и фабрика
// makeLLMProvider: выбор реализации по env. Наружу — только наши типы (§7.7).

import { AnthropicProvider } from './anthropic';
import type { LLMProvider, LLMRequest, LLMResponse } from './types';

export class EchoProvider implements LLMProvider {
  async chat(req: LLMRequest): Promise<LLMResponse> {
    const last = req.messages.at(-1)?.content ?? '';
    return {
      content: `echo: ${last}`,
      toolCalls: [],
      usage: { inputTokens: 0, outputTokens: 0 },
      stopReason: 'end_turn',
    };
  }
}

/** Подмножество env, которое читает фабрика; в тестах инжектится литералом. */
export interface LLMProviderEnv {
  ORBIS_LLM_PROVIDER?: string;
  ORBIS_LLM_MODEL?: string;
  ANTHROPIC_API_KEY?: string;
}

/**
 * Фабрика провайдера по env:
 * - `ORBIS_LLM_PROVIDER='anthropic'` — Anthropic; без ANTHROPIC_API_KEY —
 *   внятная ошибка сразу при создании (не при первом вызове);
 * - `ORBIS_LLM_PROVIDER='echo'` — echo принудительно (даже при наличии ключа);
 * - не задан (или пуст): есть ключ → anthropic, нет ключа → echo (fail-safe
 *   для dev — сервер поднимается без секретов);
 * - иное значение — ошибка при создании.
 */
export function makeLLMProvider(env: LLMProviderEnv = process.env): LLMProvider {
  const requested = env.ORBIS_LLM_PROVIDER || undefined; // пустая строка — как «не задан»
  const apiKey = env.ANTHROPIC_API_KEY || undefined;

  if (requested === 'anthropic') {
    if (!apiKey) {
      throw new Error(
        "makeLLMProvider: ORBIS_LLM_PROVIDER='anthropic' требует ANTHROPIC_API_KEY в env",
      );
    }
    return new AnthropicProvider({ apiKey, model: env.ORBIS_LLM_MODEL || undefined });
  }
  if (requested === 'echo') {
    return new EchoProvider();
  }
  if (requested !== undefined) {
    throw new Error(
      `makeLLMProvider: неизвестный ORBIS_LLM_PROVIDER='${requested}' (ожидается 'anthropic' | 'echo')`,
    );
  }
  return apiKey
    ? new AnthropicProvider({ apiKey, model: env.ORBIS_LLM_MODEL || undefined })
    : new EchoProvider();
}

export type { LLMProvider } from './types';
