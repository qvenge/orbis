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
      // Транспорт — Responses API (голый вызов провайдера, без .chat()): именно его
      // OpenAI рекомендует новому коду, и наши схемы он принимает. Прежнее решение D26
      // («Responses отвергает схемы реестра безусловно») стояло на неверном факте и
      // отменено владельцем 2026-08-08.
      model: createOpenAI({ apiKey: opts.apiKey })(modelId),
      modelId,
      timeoutMs: opts.timeoutMs,
      // ПОЧЕМУ strict: false. Дефолт строгости у эндпоинтов разный: /v1/chat/completions
      // нестрогий, /v1/responses — строгий, а строгий режим не принимает regex
      // lookaround: «Invalid JSON schema: regex lookaround is not supported. Found at
      // $.properties.data.properties.amount.pattern.» Лукахед стоит в positiveDecimal
      // (packages/shared/src/schemas/aspects.ts) ровно у двух полей —
      // orbis/financial.amount и orbis/goal.target_value, — то есть без strict: false
      // отваливаются два тула из девятнадцати: все финансы и все цели.
      //
      // ПОЧЕМУ НЕ strictJsonSchema. Этот переключатель SDK кормит только response_format
      // (@ai-sdk/openai/dist/index.js:1005, 1025, 6543, 6583) и к тулам не относится
      // ни на одном транспорте — на нём и построилось ошибочное D26. Строгость тула
      // берётся из поля самого тула: `...tool.strict != null ? { strict: tool.strict } : {}`
      // (там же, :6275 для responses). providerOptions.openai.strict — тоже не тот
      // рычаг, проверено пробой (отказ).
      toolExtras: { strict: false },
      // ПОЧЕМУ store: false. На Responses SDK по умолчанию ставит store: true
      // (@ai-sdk/openai/dist/index.js:6533) — и OpenAI сохраняет у себя запрос вместе
      // с ответом. Через чат Orbis идут банковские выписки, суммы и личные заметки,
      // оставлять их на стороне провайдера мы не согласились (решение владельца
      // 2026-08-08). На Chat Completions такого дефолта не было, поэтому смена
      // транспорта без этой строки молча включила бы хранение.
      providerOptions: { openai: { store: false } },
      // Матрица «транспорт × строгость» и полный цикл на Responses:
      // docs/superpowers/reviews/2026-08-06-openai-probe.md.
    });
  }
}
