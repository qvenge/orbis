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
      // нестрогий, /v1/responses — строгий. Решение D29 принято по ЖИВОМУ отказу строгого
      // режима на regex lookaround: «Invalid JSON schema: regex lookaround is not supported.
      // Found at $.properties.data.properties.amount.pattern.»
      //
      // ТОЙ КОНКРЕТНОЙ ПРИЧИНЫ БОЛЬШЕ НЕТ, и это надо было сказать вслух. Лукахед стоял в
      // паттерне суммы старой zod-схемы аспекта; реформа выразила «строго > 0» границей ТИПА
      // (`orbis/amount`/`orbis/target_value`: `exclusiveMin` → `exclusiveMinimum`,
      // `registry/value-schema.ts`, пин — `property-type.test.ts`), а сам словарь типов
      // lookaround запрещает (`registry/property-type.ts`, `assertPatternRegular`). Замер по
      // отгружаемому реестру: `grep -c '(?!' apps/server/test/golden/tool-registry.json` → 0
      // на 37 тулах. Лукахед в дереве ещё есть (`positiveDecimal`,
      // `packages/shared/src/contracts/import.ts`), но он живёт в tRPC-входе и НИ В ОДНУ
      // схему тула не попадает — единственный LLM-тул импорта зовётся `csv_mapping`, и его
      // схему строит `csvMappingToolJsonSchema()` без единого lookaround.
      //
      // ПОЧЕМУ ПЕРЕКЛЮЧАТЕЛЬ ВСЁ ЖЕ СТОИТ. «Причина ушла» и «строгий режим теперь примет наши
      // схемы» — РАЗНЫЕ утверждения, и второе без живого прогона недоказуемо: D29 и родилось
      // из того, что схему разобрали глазами, а отказ пришёл от провайдера. Что в реестре
      // тулов есть сегодня (замерено обходом того же golden): рекурсия через `$defs`
      // (`$ref: '#/$defs/node'` — 22 вхождения, схема Q-AST §А5-4), 60 объектов, у которых
      // `required` перечисляет НЕ ВСЕ свойства, и 2 объекта без `additionalProperties: false`.
      // Годится ли это строгому режиму — вопрос к провайдеру, и отвечает на него живая проба
      // `scripts/probe-openai-schema.ts` (приёмка §С8-4), а не чтение. До такого прогона
      // `strict: false` остаётся страховкой D29.
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
