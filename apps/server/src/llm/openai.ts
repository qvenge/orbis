// apps/server/src/llm/openai.ts
// OpenAIProvider — тонкая обёртка над AiSdkProvider (ai-sdk.ts), симметрична anthropic.ts.
// Здесь только знание про OpenAI: какой клиент создать, какая модель по умолчанию
// и КАКИМ ТРАНСПОРТОМ ходить.

import { createOpenAI } from '@ai-sdk/openai';
import { AiSdkProvider } from './ai-sdk';

/**
 * Модель по умолчанию; переопределяется env ORBIS_LLM_MODEL (§7.7: имя модели — конфиг).
 * Полноразмерная осознанно: проба 2026-08-06 (docs/superpowers/reviews/2026-08-06-openai-probe.md)
 * показала, что gpt-5.4-mini собирает orbis/financial БЕЗ обязательного category_ref
 * (исполнитель отверг бы это жёстким VALIDATION), дублирует attach_* трижды и теряет
 * чипы продолжений. Экономия на mini оплачивается отказами на глазах у пользователя.
 */
export const DEFAULT_OPENAI_MODEL = 'gpt-5.5';

export interface OpenAIProviderOptions {
  apiKey: string;
  /** Id модели OpenAI; по умолчанию DEFAULT_OPENAI_MODEL. */
  model?: string;
  /** Таймаут одного вызова; по умолчанию PROVIDER_TIMEOUT_MS. */
  timeoutMs?: number;
}

export class OpenAIProvider extends AiSdkProvider {
  constructor(opts: OpenAIProviderOptions) {
    const modelId = opts.model ?? DEFAULT_OPENAI_MODEL;
    super({
      // ВАЖНО: provider.chat(modelId), а НЕ provider(modelId).
      //
      // @ai-sdk/openai@4 по умолчанию ходит в Responses API (голый вызов провайдера
      // типизирован как OpenAIResponsesModelId), и тот отвергает схемы нашего реестра
      // тулов — дословно:
      //   «Invalid JSON schema: regex lookaround is not supported.
      //    Found at $.properties.data.properties.amount.pattern.»
      // Виноват не anyOf у attach_orbis_goal (он проходит), а негативный lookahead
      // в positiveDecimal (packages/shared/src/schemas/aspects.ts): он стоит ровно
      // у двух полей — orbis/financial.amount и orbis/goal.target_value, — то есть
      // роняет два тула из девятнадцати. Отказ БЕЗУСЛОВЕН: strictJsonSchema:false
      // его не снимает — это свойство эндпоинта, а не настройки строгости.
      // Chat Completions те же схемы принимает. Проверено пробой 2026-08-06,
      // матрица «транспорт × строгость» — docs/superpowers/reviews/2026-08-06-openai-probe.md §1.2.
      //
      // Компилятор эту ошибку не поймает: SdkModel принимает и голую строку, и любую
      // LanguageModelV4 — оба транспорта для него одинаковы.
      model: createOpenAI({ apiKey: opts.apiKey }).chat(modelId),
      modelId,
      timeoutMs: opts.timeoutMs,
    });
  }
}
