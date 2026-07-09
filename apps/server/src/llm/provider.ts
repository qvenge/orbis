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
  NODE_ENV?: string;
}

/**
 * Фабрика провайдера по env:
 * - `ORBIS_LLM_PROVIDER='anthropic'` — Anthropic; без ANTHROPIC_API_KEY —
 *   внятная ошибка сразу при создании (не при первом вызове);
 * - `ORBIS_LLM_PROVIDER='echo'` — echo принудительно (даже при наличии ключа);
 * - не задан (или пуст): есть ключ → anthropic, нет ключа → echo (fail-safe
 *   для dev — сервер поднимается без секретов). В production неявный echo запрещён:
 *   молча отвечать заглушкой и метерить её как 'echo' хуже, чем не подняться;
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
  if (apiKey) return new AnthropicProvider({ apiKey, model: env.ORBIS_LLM_MODEL || undefined });
  if (env.NODE_ENV === 'production') {
    throw new Error(
      'makeLLMProvider: в production нет ANTHROPIC_API_KEY — сервис поднялся бы с EchoProvider ' +
        "и отвечал заглушками. Задайте ключ (или ORBIS_LLM_PROVIDER='echo' осознанно).",
    );
  }
  return new EchoProvider();
}

export type { LLMProvider } from './types';
