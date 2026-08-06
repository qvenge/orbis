// apps/server/src/llm/anthropic.ts
// AnthropicProvider — тонкая обёртка над провайдеро-независимым AiSdkProvider (ai-sdk.ts):
// здесь остаётся только знание про Anthropic — как создать клиента и как называется
// модель по умолчанию. Всё остальное (маппинг, таймаут, один шаг generateText) общее.

import { createAnthropic } from '@ai-sdk/anthropic';
import { AiSdkProvider } from './ai-sdk';

/**
 * Модель по умолчанию; переопределяется env ORBIS_LLM_MODEL (§7.7: имя модели — конфиг).
 * claude-sonnet-5 (решение владельца 2026-07-09): adaptive thinking включён по умолчанию
 * и расходует output-бюджет, не-дефолтные temperature/top_p/top_k отвергаются (400) —
 * generateText ниже их и не передаёт; токенизатор новее (~+30% токенов к 4-5).
 */
export const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-5';

export interface AnthropicProviderOptions {
  apiKey: string;
  /** Id модели Anthropic; по умолчанию DEFAULT_ANTHROPIC_MODEL. */
  model?: string;
  /** Таймаут одного вызова; по умолчанию PROVIDER_TIMEOUT_MS. */
  timeoutMs?: number;
}

export class AnthropicProvider extends AiSdkProvider {
  constructor(opts: AnthropicProviderOptions) {
    const modelId = opts.model ?? DEFAULT_ANTHROPIC_MODEL;
    super({
      model: createAnthropic({ apiKey: opts.apiKey })(modelId),
      modelId,
      timeoutMs: opts.timeoutMs,
    });
  }
}

// Реэкспорт общего слоя. Внутри репозитория его не импортирует НИКТО: тесты маппинга
// ходят прямо в './ai-sdk' (ai-sdk.test.ts), боевой код — тоже. Живые потребители —
// скрипты пробы в `.superpowers/probe/` (csv-analyze.ts, sdk-matrix.ts, sdk-path.ts;
// фактически им нужны mapSdkResult и toSdkTools). Они вне git и вне tsconfig, поэтому
// ни typecheck, ни поиск по репозиторию их не покажут, а снятие реэкспорта сломает их
// молча. Владельцу они ещё нужны — строки ниже оставлены намеренно, это не забытый хвост.
export {
  mapSdkResult,
  PROVIDER_TIMEOUT_MS,
  type SdkFinishReason,
  type SdkResultSubset,
  toSdkTools,
} from './ai-sdk';
