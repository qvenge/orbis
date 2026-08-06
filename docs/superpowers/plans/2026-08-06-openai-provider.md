# Второй LLM-провайдер (OpenAI) — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** вернуть к жизни путь модели, добавив OpenAI вторым LLM-провайдером рядом с Anthropic, не изменив поведение Anthropic.

**Architecture:** `apps/server/src/llm/anthropic.ts` уже построен на Vercel AI SDK и содержит два слоя в одном файле. Провайдеро-независимая часть (маппинг `finishReason`, маппинг тулов, таймаут, один шаг `generateText`) переезжает в новый `llm/ai-sdk.ts`; `anthropic.ts` и новый `openai.ts` становятся тонкими фабриками поверх неё. Фабрика `makeLLMProvider` получает ветку `'openai'`. Имя модели для метеринга начинает приходить от самого провайдера.

**Tech Stack:** bun, TypeScript, `ai@7.0.15`, `@ai-sdk/anthropic@4.0.8`, `@ai-sdk/openai@4.0.31` (уже установлен), biome, `bun:test`.

**Спека:** `docs/superpowers/specs/2026-08-06-openai-provider-design.md`
**Проба (основание всех решений):** `docs/superpowers/reviews/2026-08-06-openai-probe.md`

## Global Constraints

- **CI не ходит в сеть за LLM.** Carried-constraint плана 1b: в тестах только `EchoProvider`/`ScriptedProvider` и чистые функции на литеральных фикстурах. Ни один новый тест не делает сетевого вызова к OpenAI или Anthropic.
- **Поведение Anthropic не меняется ни на йоту.** Расслоение — чистый рефакторинг. Ослабление существующих ассертов запрещено; переезд ассерта в файл рядом с переехавшим кодом разрешён.
- **Изменение текста промпта = НОВЫЙ файл `vN` + НОВАЯ фикстура `vN.fixture.txt`.** Carried-решение проекта. Файлы `v1.ts`, `v2.ts`, `v3.ts` и их фикстуры и тесты **не трогаются вовсе**.
- **Схемы аспектов (`packages/shared/src/schemas/aspects.ts`) НЕ меняются.** Любая их правка потребовала бы пересева реестра на проде (`bun scripts/seed-aspects.ts`) и выводит задачу из объёма.
- **Транспорт OpenAI — только Chat Completions** (`provider.chat(model)`, НЕ `provider(model)`). Доказано пробой: Responses API отвергает **два** тула реестра (`attach_orbis_financial`, `attach_orbis_goal`) при любой строгости — `regex lookaround is not supported` на `positiveDecimal`.
- **strict-режим OpenAI не включается.** Вход тула валидирует ajv по реестру (стадия 2 исполнителя).
- Комментарии, докблоки и сообщения об ошибках — **по-русски**, в стиле окружающего кода: объяснять ПОЧЕМУ, а не пересказывать код.
- Прогон тестов — **`bun run test` из корня**; голый `bun test` из корня зависает. Код возврата lint снимать отдельным вызовом (`bun run lint; echo $?`).
- Типы AI SDK не протекают через `LLMProvider`: наружу — только наши `LLMRequest`/`LLMResponse` (PRD 01 §7.7).

---

## Структура файлов

| Файл | Ответственность |
|---|---|
| `apps/server/src/llm/types.ts` | контракт `LLMProvider` (+ новое поле `modelId`) |
| `apps/server/src/llm/ai-sdk.ts` | **НОВЫЙ.** Всё провайдеро-независимое поверх AI SDK: маппинг результата и стоп-причины, маппинг тулов, таймаут, базовый класс `AiSdkProvider` |
| `apps/server/src/llm/anthropic.ts` | **ТОНКИЙ.** `createAnthropic` + `DEFAULT_ANTHROPIC_MODEL` + `AnthropicProvider` |
| `apps/server/src/llm/openai.ts` | **НОВЫЙ, ТОНКИЙ.** `createOpenAI` + `DEFAULT_OPENAI_MODEL` + `OpenAIProvider` |
| `apps/server/src/llm/provider.ts` | фабрика по env: ветка `'openai'`, `OPENAI_API_KEY`, отказ при неоднозначности |
| `apps/server/src/llm/scripted.ts` | `ScriptedProvider` + `modelId` |
| `apps/server/src/ai/send-message.ts` | `makeAiDeps` берёт имя модели у провайдера |
| `apps/server/src/llm/prompts/v4.ts` + `v4.fixture.txt` + `v4.test.ts` | **НОВЫЕ.** Промпт v4 = v3 + `tags=` в шпаргалке + запрет дублирующего `attach` |
| `apps/server/src/llm/context.ts` | переключение на `SYSTEM_PROMPT_V4` |
| `apps/server/.env.example`, `render.yaml`, `docs/**` | окружение и документы |

---

## Task 1: Расслоение AI SDK и имя модели от провайдера

**Files:**
- Create: `apps/server/src/llm/ai-sdk.ts`
- Create: `apps/server/src/llm/ai-sdk.test.ts`
- Modify: `apps/server/src/llm/types.ts`
- Modify: `apps/server/src/llm/anthropic.ts` (переписывается целиком, содержимое ниже)
- Modify: `apps/server/src/llm/anthropic.test.ts` (правится только строка импорта)
- Modify: `apps/server/src/llm/provider.ts` (только `EchoProvider`)
- Modify: `apps/server/src/llm/scripted.ts`
- Modify: `apps/server/src/ai/send-message.ts` (только `makeAiDeps`, строки 83–93)

**Interfaces:**
- Consumes: ничего от предыдущих задач (первая).
- Produces:
  - `apps/server/src/llm/ai-sdk.ts` экспортирует: `SdkFinishReason`, `SdkResultSubset`, `mapSdkResult(result: SdkResultSubset): LLMResponse`, `toSdkTools(tools: readonly LLMToolDef[]): ToolSet`, `PROVIDER_TIMEOUT_MS: number`, `SdkModel`, `AiSdkProviderOptions`, `class AiSdkProvider implements LLMProvider`.
  - `AiSdkProvider` конструктор: `constructor(opts: { model: SdkModel; modelId: string; timeoutMs?: number })`; публичное поле `readonly modelId: string`; метод `chat(req: LLMRequest): Promise<LLMResponse>`.
  - `LLMProvider` получает `readonly modelId: string` — Task 2 обязана его реализовать в `OpenAIProvider`.
  - `apps/server/src/llm/anthropic.ts` продолжает экспортировать `DEFAULT_ANTHROPIC_MODEL`, `AnthropicProvider`, `AnthropicProviderOptions` и **реэкспортирует** `mapSdkResult`, `toSdkTools`, `PROVIDER_TIMEOUT_MS`, `SdkFinishReason`, `SdkResultSubset` — чтобы существующие импорты не ломались.

---

- [ ] **Step 1: Написать падающий тест на `modelId`**

Создать `apps/server/src/llm/ai-sdk.test.ts` с этим содержимым:

```ts
// apps/server/src/llm/ai-sdk.test.ts
// Провайдеро-независимый слой поверх AI SDK. Ассерты маппинга переехали сюда
// из anthropic.test.ts вместе с кодом: они и были про SDK, а не про Anthropic.

import { describe, expect, test } from 'bun:test';
import { AiSdkProvider, mapSdkResult, PROVIDER_TIMEOUT_MS, toSdkTools } from './ai-sdk';

describe('AiSdkProvider', () => {
  test('modelId — тот, что передан; провайдер отдаёт имя модели сам', () => {
    const p = new AiSdkProvider({ model: 'заглушка' as never, modelId: 'некая-модель-1' });
    expect(p.modelId).toBe('некая-модель-1');
  });

  test('таймаут по умолчанию — PROVIDER_TIMEOUT_MS, переопределяется опцией', () => {
    expect(PROVIDER_TIMEOUT_MS).toBe(180_000);
    const p = new AiSdkProvider({ model: 'з' as never, modelId: 'м', timeoutMs: 42 });
    expect((p as unknown as { timeoutMs: number }).timeoutMs).toBe(42);
  });

  test('system-сообщение внутри messages — внятная ошибка, а не молчаливая потеря', async () => {
    const p = new AiSdkProvider({ model: 'з' as never, modelId: 'м' });
    await expect(
      p.chat({
        system: '',
        messages: [{ role: 'system', content: 'нельзя' }],
        tools: [],
        maxTokens: 16,
      }),
    ).rejects.toThrow(/system-сообщения в messages не поддерживаются/);
  });
});
```

- [ ] **Step 2: Прогнать тест и убедиться, что он падает**

Run: `bun test apps/server/src/llm/ai-sdk.test.ts`
Expected: FAIL — `Cannot find module './ai-sdk'`.

- [ ] **Step 3: Создать `apps/server/src/llm/ai-sdk.ts`**

Содержимое целиком (тела функций перенесены из `anthropic.ts` **без изменения логики**; изменены только префикс лог-сообщения и докблоки):

```ts
// apps/server/src/llm/ai-sdk.ts
// Провайдеро-независимый слой поверх Vercel AI SDK (PRD 01 §7.7). Здесь живёт всё,
// что одинаково для любого провайдера SDK: маппинг результата и стоп-причины, маппинг
// тулов, таймаут шага и сам вызов generateText. Знание про конкретного провайдера
// (какой клиент создать, как называется модель по умолчанию) живёт в anthropic.ts
// и openai.ts — они тонкие.
//
// Типы AI SDK НЕ протекают наружу: LLMProvider отдаёт только наши LLMRequest/LLMResponse.
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

  constructor(opts: AiSdkProviderOptions) {
    this.model = opts.model;
    this.modelId = opts.modelId;
    this.timeoutMs = opts.timeoutMs ?? PROVIDER_TIMEOUT_MS;
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
      // tools/toolChoice только при непустом наборе: Anthropic API отвергает
      // tool_choice без tools; выбор тула — всегда 'auto' (решение плана 1b)
      ...(req.tools.length > 0
        ? { tools: toSdkTools(req.tools), toolChoice: 'auto' as const }
        : {}),
    });
    return mapSdkResult(result);
  }
}
```

- [ ] **Step 4: Добавить `modelId` в контракт `LLMProvider`**

В `apps/server/src/llm/types.ts` заменить блок

```ts
export interface LLMProvider {
  chat(req: LLMRequest): Promise<LLMResponse>;
}
```

на

```ts
export interface LLMProvider {
  /**
   * Имя модели для метеринга §4.7. Отдаёт САМ провайдер: пока имя вычислялось
   * снаружи как `env.ORBIS_LLM_MODEL || DEFAULT_ANTHROPIC_MODEL`, второй провайдер
   * без явной env писал бы в ai_usage чужую модель.
   */
  readonly modelId: string;
  chat(req: LLMRequest): Promise<LLMResponse>;
}
```

- [ ] **Step 5: Сделать `anthropic.ts` тонким**

Заменить содержимое `apps/server/src/llm/anthropic.ts` целиком на:

```ts
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

// Реэкспорт общего слоя: у существующих потребителей (anthropic.test.ts и др.)
// пути импорта не меняются, а код живёт там, где ему место.
export {
  mapSdkResult,
  PROVIDER_TIMEOUT_MS,
  type SdkFinishReason,
  type SdkResultSubset,
  toSdkTools,
} from './ai-sdk';
```

- [ ] **Step 6: Дать `modelId` заглушечным провайдерам**

В `apps/server/src/llm/provider.ts` в классе `EchoProvider` добавить первой строкой тела класса:

```ts
  /** Метеринг метит заглушку честно: нулевые токены, но модель называется 'echo'. */
  readonly modelId = 'echo';
```

В `apps/server/src/llm/scripted.ts` в классе `ScriptedProvider` добавить перед полем `requests`:

```ts
  readonly modelId = 'scripted';
```

- [ ] **Step 7: Метеринг берёт имя модели у провайдера**

В `apps/server/src/ai/send-message.ts` заменить функцию `makeAiDeps` (и её докблок) на:

```ts
/**
 * Сборка боевых AiDeps по env: провайдер — фабрикой Task 7 (fail-fast на невалидном
 * env при старте процесса), имя модели для метеринга берётся У САМОГО ПРОВАЙДЕРА.
 * Раньше оно вычислялось как `ORBIS_LLM_MODEL || DEFAULT_ANTHROPIC_MODEL`, и второй
 * провайдер без явной env писал бы в ai_usage «claude-sonnet-5» — то есть счётчик
 * расхода врал бы про модель.
 */
export function makeAiDeps(env: LLMProviderEnv = process.env): AiDeps {
  const provider = makeLLMProvider(env);
  return { provider, model: provider.modelId };
}
```

Затем убрать ставшие неиспользуемыми импорты `EchoProvider` и `DEFAULT_ANTHROPIC_MODEL`
из шапки файла — **если** они больше нигде в файле не используются (проверить grep'ом
по файлу перед удалением).

- [ ] **Step 8: Перенацелить импорт в `anthropic.test.ts`**

В `apps/server/src/llm/anthropic.test.ts` строку

```ts
import { mapSdkResult, toSdkTools } from './anthropic';
```

заменить на

```ts
import { mapSdkResult, toSdkTools } from './ai-sdk';
```

Остальное содержимое файла **не трогать**: ассерты маппинга обязаны остаться дословно теми же.

- [ ] **Step 9: Прогнать тесты сервера**

Run: `bun test apps/server/src/llm/ apps/server/src/ai/`
Expected: PASS, включая новый `ai-sdk.test.ts`.

- [ ] **Step 10: Typecheck и lint**

Run: `bun run typecheck` затем `bun run lint; echo "lint exit=$?"`
Expected: обе команды чистые (`lint exit=0`).

- [ ] **Step 11: Полный прогон**

Run: `bun run test`
Expected: PASS. **Если краснеет случайный web-тест с секундным `waitFor`** (известный флак проекта при параллельном корневом прогоне, четыре наблюдения) — перепрогнать ЭТОТ ФАЙЛ изолированно (`bun test <файл>`) и, если он зелёный, зафиксировать это в отчёте, а не чинить.

- [ ] **Step 12: Коммит**

```bash
git add apps/server/src/llm/ai-sdk.ts apps/server/src/llm/ai-sdk.test.ts apps/server/src/llm/types.ts apps/server/src/llm/anthropic.ts apps/server/src/llm/anthropic.test.ts apps/server/src/llm/provider.ts apps/server/src/llm/scripted.ts apps/server/src/ai/send-message.ts
git commit -m "refactor(llm): слой AI SDK отделён от Anthropic, имя модели отдаёт провайдер"
```

---

## Task 2: Провайдер OpenAI и ветка фабрики

**Files:**
- Create: `apps/server/src/llm/openai.ts`
- Create: `apps/server/src/llm/openai.test.ts`
- Modify: `apps/server/src/llm/provider.ts`
- Modify: `apps/server/src/llm/provider.test.ts`

**Interfaces:**
- Consumes: из Task 1 — `AiSdkProvider` из `./ai-sdk` с конструктором `{ model: SdkModel; modelId: string; timeoutMs?: number }` и полем `readonly modelId: string`.
- Produces: `apps/server/src/llm/openai.ts` экспортирует `DEFAULT_OPENAI_MODEL: string`, `OpenAIProviderOptions`, `class OpenAIProvider extends AiSdkProvider`. `makeLLMProvider` начинает понимать `ORBIS_LLM_PROVIDER='openai'` и читать `OPENAI_API_KEY`; `LLMProviderEnv` получает поле `OPENAI_API_KEY?: string`.

---

- [ ] **Step 1: Написать падающие тесты**

Создать `apps/server/src/llm/openai.test.ts`:

```ts
// apps/server/src/llm/openai.test.ts
// Сети здесь нет и быть не может (Global Constraints: CI гоняет только echo/scripted).
// Проверяется то, что проверяемо офлайн: имя модели по умолчанию, переопределение
// и то, что провайдер — наследник общего слоя.

import { describe, expect, test } from 'bun:test';
import { AiSdkProvider } from './ai-sdk';
import { DEFAULT_OPENAI_MODEL, OpenAIProvider } from './openai';

describe('OpenAIProvider', () => {
  test('дефолтная модель — полноразмерная, не mini/nano', () => {
    // Проба 2026-08-06: gpt-5.4-mini собирал orbis/financial без обязательного
    // category_ref и терял чипы продолжений. Дефолт обязан быть полноразмерным.
    expect(DEFAULT_OPENAI_MODEL).not.toMatch(/mini|nano/);
  });

  test('modelId по умолчанию — DEFAULT_OPENAI_MODEL', () => {
    const p = new OpenAIProvider({ apiKey: 'ключ-для-теста' });
    expect(p.modelId).toBe(DEFAULT_OPENAI_MODEL);
  });

  test('modelId переопределяется опцией model', () => {
    const p = new OpenAIProvider({ apiKey: 'ключ-для-теста', model: 'иная-модель' });
    expect(p.modelId).toBe('иная-модель');
  });

  test('провайдер построен на общем слое AI SDK, а не на своей копии', () => {
    expect(new OpenAIProvider({ apiKey: 'ключ-для-теста' })).toBeInstanceOf(AiSdkProvider);
  });
});
```

Добавить в `apps/server/src/llm/provider.test.ts` внутрь `describe('makeLLMProvider', …)` (импорт `OpenAIProvider` из `'./openai'` добавить в шапку файла):

```ts
  test("явный 'openai' с ключом → openai", () => {
    const p = makeLLMProvider({ ORBIS_LLM_PROVIDER: 'openai', OPENAI_API_KEY: 'к' });
    expect(p).toBeInstanceOf(OpenAIProvider);
  });

  test("явный 'openai' БЕЗ ключа → внятная ошибка при создании (не при вызове)", () => {
    expect(() => makeLLMProvider({ ORBIS_LLM_PROVIDER: 'openai' })).toThrow(/OPENAI_API_KEY/);
  });

  test('без ORBIS_LLM_PROVIDER, но с одним лишь OPENAI_API_KEY → openai', () => {
    const p = makeLLMProvider({ OPENAI_API_KEY: 'к' });
    expect(p).toBeInstanceOf(OpenAIProvider);
  });

  // Неоднозначность — отказ, а не молчаливый выбор: доктрина этого файла уже
  // запрещает молча поднимать echo в production. Молча выбрать один из двух живых
  // провайдеров — та же ошибка, и дороже: счётчик расхода уйдёт не туда.
  test('оба ключа без явного ORBIS_LLM_PROVIDER → ошибка, называющая оба', () => {
    expect(() => makeLLMProvider({ ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'o' })).toThrow(
      /ORBIS_LLM_PROVIDER/,
    );
  });

  test('сообщение о неизвестном провайдере перечисляет и openai', () => {
    expect(() => makeLLMProvider({ ORBIS_LLM_PROVIDER: 'нечто' })).toThrow(/openai/);
  });
```

- [ ] **Step 2: Прогнать и убедиться, что падает**

Run: `bun test apps/server/src/llm/openai.test.ts apps/server/src/llm/provider.test.ts`
Expected: FAIL — `Cannot find module './openai'`.

- [ ] **Step 3: Создать `apps/server/src/llm/openai.ts`**

```ts
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
      // @ai-sdk/openai@4 по умолчанию ходит в Responses API, и тот отвергает схемы
      // нашего реестра тулов — дословно:
      //   «Invalid JSON schema: regex lookaround is not supported.
      //    Found at $.properties.data.properties.amount.pattern.»
      // Виноват не anyOf у attach_orbis_goal (он проходит), а негативный lookahead
      // в positiveDecimal (packages/shared/src/schemas/aspects.ts): он стоит ровно
      // у двух полей — orbis/financial.amount и orbis/goal.target_value, — то есть
      // роняет два тула из девятнадцати. Отказ БЕЗУСЛОВЕН: strictJsonSchema:false
      // его не снимает — это свойство эндпоинта, а не настройки строгости.
      // Chat Completions те же схемы принимает. Проверено пробой 2026-08-06,
      // матрица «транспорт × строгость» — docs/superpowers/reviews/2026-08-06-openai-probe.md §1.2.
      model: createOpenAI({ apiKey: opts.apiKey }).chat(modelId),
      modelId,
      timeoutMs: opts.timeoutMs,
    });
  }
}
```

- [ ] **Step 4: Научить фабрику ветке `openai`**

В `apps/server/src/llm/provider.ts`:

(а) добавить импорт `import { OpenAIProvider } from './openai';` рядом с импортом `AnthropicProvider`;

(б) в интерфейс `LLMProviderEnv` добавить поле после `ANTHROPIC_API_KEY`:

```ts
  OPENAI_API_KEY?: string;
```

(в) заменить докблок и тело `makeLLMProvider` на:

```ts
/**
 * Фабрика провайдера по env:
 * - `ORBIS_LLM_PROVIDER='anthropic'` — Anthropic; без ANTHROPIC_API_KEY —
 *   внятная ошибка сразу при создании (не при первом вызове);
 * - `ORBIS_LLM_PROVIDER='openai'` — OpenAI; без OPENAI_API_KEY — то же самое;
 * - `ORBIS_LLM_PROVIDER='echo'` — echo принудительно (даже при наличии ключей);
 * - не задан (или пуст): ровно один ключ → соответствующий провайдер; ОБА ключа →
 *   ошибка (неоднозначность разрешает человек, а не порядок веток в этом файле —
 *   молча выбрать один из двух живых провайдеров значит молча метерить чужую модель);
 *   ключей нет → echo (fail-safe для dev — сервер поднимается без секретов).
 *   В production неявный echo запрещён: молча отвечать заглушкой и метерить её
 *   как 'echo' хуже, чем не подняться;
 * - иное значение — ошибка при создании.
 */
export function makeLLMProvider(env: LLMProviderEnv = process.env): LLMProvider {
  const requested = env.ORBIS_LLM_PROVIDER || undefined; // пустая строка — как «не задан»
  const anthropicKey = env.ANTHROPIC_API_KEY || undefined;
  const openaiKey = env.OPENAI_API_KEY || undefined;

  if (requested === 'anthropic') {
    if (!anthropicKey) {
      throw new Error(
        "makeLLMProvider: ORBIS_LLM_PROVIDER='anthropic' требует ANTHROPIC_API_KEY в env",
      );
    }
    return new AnthropicProvider({ apiKey: anthropicKey, model: env.ORBIS_LLM_MODEL || undefined });
  }
  if (requested === 'openai') {
    if (!openaiKey) {
      throw new Error(
        "makeLLMProvider: ORBIS_LLM_PROVIDER='openai' требует OPENAI_API_KEY в env",
      );
    }
    return new OpenAIProvider({ apiKey: openaiKey, model: env.ORBIS_LLM_MODEL || undefined });
  }
  if (requested === 'echo') {
    return new EchoProvider();
  }
  if (requested !== undefined) {
    throw new Error(
      `makeLLMProvider: неизвестный ORBIS_LLM_PROVIDER='${requested}' (ожидается 'anthropic' | 'openai' | 'echo')`,
    );
  }
  if (anthropicKey && openaiKey) {
    throw new Error(
      'makeLLMProvider: в env есть и ANTHROPIC_API_KEY, и OPENAI_API_KEY, а ORBIS_LLM_PROVIDER ' +
        "не задан — выбор неоднозначен. Задайте ORBIS_LLM_PROVIDER='anthropic' или 'openai' явно.",
    );
  }
  if (anthropicKey) {
    return new AnthropicProvider({ apiKey: anthropicKey, model: env.ORBIS_LLM_MODEL || undefined });
  }
  if (openaiKey) {
    return new OpenAIProvider({ apiKey: openaiKey, model: env.ORBIS_LLM_MODEL || undefined });
  }
  if (env.NODE_ENV === 'production') {
    throw new Error(
      'makeLLMProvider: в production нет ни ANTHROPIC_API_KEY, ни OPENAI_API_KEY — сервис ' +
        "поднялся бы с EchoProvider и отвечал заглушками. Задайте ключ (или ORBIS_LLM_PROVIDER='echo' осознанно).",
    );
  }
  return new EchoProvider();
}
```

- [ ] **Step 5: Прогнать тесты слоя**

Run: `bun test apps/server/src/llm/`
Expected: PASS — включая новые тесты и все прежние ветки фабрики.

- [ ] **Step 6: Typecheck, lint, полный прогон**

Run: `bun run typecheck`, затем `bun run lint; echo "lint exit=$?"`, затем `bun run test`
Expected: всё чистое (про известный флак web — см. Task 1 Step 11).

- [ ] **Step 7: Коммит**

```bash
git add apps/server/src/llm/openai.ts apps/server/src/llm/openai.test.ts apps/server/src/llm/provider.ts apps/server/src/llm/provider.test.ts
git commit -m "feat(llm): провайдер OpenAI на Chat Completions и ветка фабрики"
```

---

## Task 3: Промпт v4 — `tags=` в шпаргалке и запрет дублирующего attach

**Files:**
- Create: `apps/server/src/llm/prompts/v4.ts`
- Create: `apps/server/src/llm/prompts/v4.fixture.txt`
- Create: `apps/server/src/llm/prompts/v4.test.ts`
- Modify: `apps/server/src/llm/context.ts` (строки 26 и 255)
- Modify: `apps/server/src/llm/context.test.ts` (строки 22, 73, 78)
- Modify: `apps/server/src/ai/send-message.test.ts` (строки 18, 229)
- **НЕ трогать:** `v1.ts`, `v2.ts`, `v3.ts` и их фикстуры и тесты.

**Interfaces:**
- Consumes: ничего от Task 1–2.
- Produces: `apps/server/src/llm/prompts/v4.ts` экспортирует `SYSTEM_PROMPT_V4: string`, `SYSTEM_PROMPT_VERSION = 'v4'` и реэкспорт `TOOL_RESULT_MARKER` из `./v1`.

**Почему это в объёме задачи про провайдера:** оба дефекта найдены пробой в области, которую работа и трогает, и оба провайдеро-независимы. Д1 делает цели молча нерабочими: модель сочиняет `tag=` (единственное число), грамматика отвечает «неизвестное поле 'tag'», `progress_source` не разбирается — цель создаётся, прогресса нет, объяснения нет. Слово `tags` в v3 встречается **ноль раз**.

---

- [ ] **Step 1: Создать `v4.ts` из `v3.ts`**

Скопировать `apps/server/src/llm/prompts/v3.ts` в `apps/server/src/llm/prompts/v4.ts`, заменить в новом файле шапку-докблок на:

```ts
// apps/server/src/llm/prompts/v4.ts
// Версионированный системный промпт v4 — статика слоя 1 (§7.1). Carried-решение:
// ИЗМЕНЕНИЕ текста промпта = НОВЫЙ файл vN + новая фикстура v(N).fixture.txt;
// v1, v2 и v3 (с их фикстурами и тестами) остаются нетронутыми.
//
// v4 = v3 + ДВЕ правки, обе найдены пробой второго LLM-провайдера 2026-08-06
// (docs/superpowers/reviews/2026-08-06-openai-probe.md §2.3) и обе провайдеро-НЕзависимы:
//
// 1. В ШПАРГАЛКЕ ГРАММАТИКИ ПОЯВИЛИСЬ tags= и excludeTags=. В v3 слово «tags»
//    не встречалось НИ РАЗУ, хотя фильтр существует (packages/shared/src/query/grammar.ts)
//    и является единственным способом выразить «доходы с тегом savings» — а это ровно
//    та формулировка, которую блок целей просит превратить в progress_source.
//    Наблюдалось живьём: модель сочиняет ключ `tag=` в единственном числе, настоящий
//    parseQuery отвечает «неизвестное поле 'tag'», и цель создаётся БЕЗ работающего
//    прогресса — молча, потому что fail-soft расчёта (решение Р10 фазы E) показывает
//    отсутствие полосы, а не «твой запрос неразбираем».
//
// 2. ЗАПРЕЩЁН ДУБЛИРУЮЩИЙ attach_<аспект> для аспекта, уже переданного в этом же
//    entity_create. Промпт с v2 просит навешивать аспекты сразу одним entity_create —
//    модель это делает и всё равно вызывает attach следом теми же данными. Цена:
//    лишний шаг из восьми (MAX_AGENT_STEPS) и лишняя запись аудита; у слабых моделей
//    наблюдался тройной вызов подряд.
//
// Позиция блока продолжений сохранена: он обязан остаться ПОСЛЕДНИМ (гард в тесте).
// Обе правки — вставки в существующие блоки в середине текста, не дописки в хвост.
```

Заменить `export const SYSTEM_PROMPT_VERSION = 'v3';` на `= 'v4';`
и `export const SYSTEM_PROMPT_V3 = \`` на `export const SYSTEM_PROMPT_V4 = \``.

- [ ] **Step 2: Внести правку Д1 — `tags=` в шпаргалку грамматики**

В теле промпта v4 найти строку

```
- children_of=<uuid> — дети сущности (по parent-связи); sortBy=<поле>:asc|desc, search=<текст по title+body>, limit=<число>.
```

и вставить **перед ней** новую строку:

```
- tags=<тег>|<тег> — отбор по тегам сущности (ключ во МНОЖЕСТВЕННОМ числе, `tag=` грамматика не знает); excludeTags=<тег> — исключение. «Доходы с тегом savings» = «aspect=orbis/financial, direction=income, tags=savings».
```

- [ ] **Step 3: Внести правку Д2 — запрет дублирующего attach**

В блоке «Одна сущность на намерение» найти строку

```
- Навешивай аспекты СРАЗУ, одним entity_create: aspects — объект, ключей в нём может быть несколько. Сущность без аспектов создавай только тогда, когда её тип из реплики не следует.
```

и вставить **сразу после неё**:

```
- Аспект, уже переданный в aspects этого entity_create, повторно attach-тулом НЕ навешивай: сущность уже создана вместе с ним, и второй вызов только тратит шаг цикла.
```

- [ ] **Step 4: Сгенерировать фикстуру**

Run:

```bash
bun -e 'import {SYSTEM_PROMPT_V4} from "./apps/server/src/llm/prompts/v4.ts"; await Bun.write("apps/server/src/llm/prompts/v4.fixture.txt", SYSTEM_PROMPT_V4)'
```

Затем убедиться глазами, что дифф фикстур — ровно две вставленные строки:

```bash
diff apps/server/src/llm/prompts/v3.fixture.txt apps/server/src/llm/prompts/v4.fixture.txt
```

Expected: ровно два блока `>` — вставки из Step 2 и Step 3, и ничего больше. Если diff показывает что-то ещё — исправить, прежде чем идти дальше.

- [ ] **Step 5: Создать `v4.test.ts`**

Скопировать `apps/server/src/llm/prompts/v3.test.ts` в `apps/server/src/llm/prompts/v4.test.ts` и внести:

(а) в шапке заменить импорт `./v3` на `./v4`, `SYSTEM_PROMPT_V3` → `SYSTEM_PROMPT_V4` **везде по файлу**, `SYSTEM_PROMPT_V2` → `SYSTEM_PROMPT_V3` и импорт `./v2` → `./v3` (гард «ничего не потеряно» теперь сравнивает v4 с v3), `v3.fixture.txt` → `v4.fixture.txt`, ожидание версии `'v3'` → `'v4'`, заголовок describe и название теста «v3 не потерял ни одной строки v2» → «v4 не потерял ни одной строки v3»;

(б) добавить внутрь describe два новых теста — гарды именно правок v4:

```ts
  // --- Новое в v4 -----------------------------------------------------------

  // Д1 пробы 2026-08-06: модель сочиняла `tag=`, грамматика отвечала «неизвестное
  // поле 'tag'», и цель приезжала без прогресса молча. Гард исполняемый, а не
  // toContain: ключ из шпаргалки прогоняется через НАСТОЯЩИЙ parseQuery.
  test('шпаргалка грамматики: ключ tags= назван и разбирается настоящей грамматикой', () => {
    expect(SYSTEM_PROMPT_V4).toContain('tags=');
    expect(SYSTEM_PROMPT_V4).toContain('excludeTags=');
    // единственное число названо как НЕсуществующее — иначе модель его и придумает
    expect(SYSTEM_PROMPT_V4).toMatch(/`tag=` грамматика не знает/);

    const catalog = buildFieldCatalog(
      BUILTIN_ASPECT_META.map((m) => ({ id: m.id, schema: aspectJsonSchema(m.id) })),
    );
    // Пример из самого промпта обязан разбираться — иначе промпт учит неверному
    const example = SYSTEM_PROMPT_V4.match(/«(aspect=orbis\/financial[^»]+)»/)?.[1];
    if (!example) throw new Error('в шпаргалке нет примера запроса с tags=');
    expect(parseQuery(example, catalog).ok).toBe(true);
    // и обратная сторона: единственное число действительно НЕ разбирается
    expect(parseQuery('aspect=orbis/note, tag=book', catalog).ok).toBe(false);
  });

  // Д2 пробы: модель передаёт аспект в entity_create и следом дублирует attach-вызов.
  test('одна сущность на намерение: дублирующий attach после entity_create запрещён', () => {
    expect(SYSTEM_PROMPT_V4).toMatch(/повторно attach-тулом НЕ навешивай/);
  });
```

(в) добавить в шапку файла импорты, которых требуют новые гарды:

```ts
import {
  aspectJsonSchema,
  BUILTIN_ASPECT_META,
  BUILTIN_ASPECT_IDS,
  buildFieldCatalog,
  goalAspectSchema,
  parseQuery,
} from '@orbis/shared';
```

(строка импорта из `@orbis/shared`, которая уже есть в скопированном файле, заменяется на эту — дубля быть не должно).

- [ ] **Step 6: Прогнать тесты промптов**

Run: `bun test apps/server/src/llm/prompts/`
Expected: PASS — включая нетронутые `v1.test.ts`, `v2.test.ts`, `v3.test.ts`.

- [ ] **Step 7: Переключить потребителей на v4**

В `apps/server/src/llm/context.ts`: заменить импорт `from './prompts/v3'` на `from './prompts/v4'` и `SYSTEM_PROMPT_V3` на `SYSTEM_PROMPT_V4` (строки 26 и 255).

В `apps/server/src/llm/context.test.ts` (строки 22, 73, 78) и `apps/server/src/ai/send-message.test.ts` (строки 18, 229): те же две замены. Названия тестов, где встречается «V3», тоже обновить на «V4».

- [ ] **Step 8: Прогнать сервер целиком**

Run: `bun test apps/server/`
Expected: PASS.

- [ ] **Step 9: Typecheck, lint, полный прогон**

Run: `bun run typecheck`, затем `bun run lint; echo "lint exit=$?"`, затем `bun run test`
Expected: всё чистое.

- [ ] **Step 10: Коммит**

```bash
git add apps/server/src/llm/prompts/v4.ts apps/server/src/llm/prompts/v4.fixture.txt apps/server/src/llm/prompts/v4.test.ts apps/server/src/llm/context.ts apps/server/src/llm/context.test.ts apps/server/src/ai/send-message.test.ts
git commit -m "feat(prompt): v4 — tags= в шпаргалке грамматики и запрет дублирующего attach"
```

---

## Task 4: Окружение, деплой и документы

**Files:**
- Modify: `apps/server/.env.example`
- Modify: `render.yaml` (строки 33–37)
- Modify: `docs/implementation/02-ops-runbook.md` (таблица переменных, строки 251–253)
- Modify: `docs/prd/01-architecture.md` (§7.7 — мульти-провайдерность)
- Modify: `docs/prd/04-decision-log.md` (новые решения)

**Interfaces:**
- Consumes: из Task 2 — имена `ORBIS_LLM_PROVIDER='openai'`, `OPENAI_API_KEY`, `DEFAULT_OPENAI_MODEL = 'gpt-5.5'`; поведение фабрики при двух ключах.
- Produces: ничего в коде.

---

- [ ] **Step 1: Секция LLM в `.env.example`**

В `apps/server/.env.example` **секции LLM нет вообще** — переменные документированы только в рунбуке. Дописать в конец файла:

```
# --- LLM-провайдер (PRD 01 §7.7) -------------------------------------------
# Выбор провайдера ЯВНЫЙ. Без него: один ключ → этот провайдер, ОБА ключа → отказ
# при старте (неоднозначность разрешает человек), ключей нет → echo в dev и отказ
# в production. См. apps/server/src/llm/provider.ts.
ORBIS_LLM_PROVIDER=openai
# Нужен, если ORBIS_LLM_PROVIDER=anthropic
ANTHROPIC_API_KEY=
# Нужен, если ORBIS_LLM_PROVIDER=openai
OPENAI_API_KEY=
# (опц.) модель. Без неё — дефолт выбранного провайдера: claude-sonnet-5 либо gpt-5.5.
# ORBIS_LLM_MODEL=
```

- [ ] **Step 2: `render.yaml`**

Заменить блок строк 33–37 на:

```yaml
      # Ключи провайдеров: нужен ТОТ, который выбран ниже. Оба сразу без явного
      # ORBIS_LLM_PROVIDER сервис не поднимут — это осознанный отказ, а не баг.
      - key: ANTHROPIC_API_KEY
        sync: false
      - key: OPENAI_API_KEY
        sync: false
      # Явный выбор провайдера: снимает «неявный echo при пустом ключе» (см. llm/provider.ts).
      - key: ORBIS_LLM_PROVIDER
        value: openai
```

- [ ] **Step 3: Таблица переменных в рунбуке**

В `docs/implementation/02-ops-runbook.md` заменить строки 251–253 на:

```markdown
| `ANTHROPIC_API_KEY` | ключ Anthropic | нужен при `ORBIS_LLM_PROVIDER=anthropic` |
| `OPENAI_API_KEY` | ключ OpenAI | нужен при `ORBIS_LLM_PROVIDER=openai` |
| `ORBIS_LLM_PROVIDER` | явный выбор провайдера (в `render.yaml` = `openai`) | без него: один ключ → он и выбран, ОБА ключа → отказ при старте, ключей нет → echo (в production отказ) |
| `ORBIS_LLM_MODEL` | (опц.) модель по умолчанию | иначе дефолт провайдера: `claude-sonnet-5` (`DEFAULT_ANTHROPIC_MODEL`) либо `gpt-5.5` (`DEFAULT_OPENAI_MODEL`, `apps/server/src/llm/openai.ts`) |
```

- [ ] **Step 4: PRD §7.7**

Открыть `docs/prd/01-architecture.md`, найти §7.7 (искать по строке `7.7`). Привести раздел к факту: мульти-провайдерность больше не «оставленный шов», а реализация — два провайдера поверх общего слоя `llm/ai-sdk.ts`, выбор через `ORBIS_LLM_PROVIDER`, имя модели отдаёт сам провайдер. Обязательно назвать транспортное ограничение OpenAI (Chat Completions, причина — lookahead в `positiveDecimal`) со ссылкой на `docs/superpowers/reviews/2026-08-06-openai-probe.md`. Существующие формулировки, ставшие неверными, **переписать, а не дописать рядом**.

- [ ] **Step 5: Decision log**

В `docs/prd/04-decision-log.md` дописать после D24 четыре записи в формате соседей (**Решение / Статус / Обоснование / Заменяет / Детали**). Статус у всех четырёх: `принято 2026-08-06 контроллером в отсутствие владельца — ждёт валидации владельцем`.

- **D25. Второй LLM-провайдер: OpenAI поверх общего слоя AI SDK.** Обоснование: на счёте Anthropic нет средств, весь путь модели мёртв; `anthropic.ts` уже был на Vercel AI SDK, поэтому провайдеро-независимая часть выделена в `llm/ai-sdk.ts`, а оба провайдера стали тонкими. Заменяет: §7.7 в части «оставленный шов».
- **D26. Транспорт OpenAI — только Chat Completions; strict-режим не включается.** Обоснование: Responses API (транспорт `@ai-sdk/openai` ПО УМОЛЧАНИЮ) отвергает схемы двух тулов (`attach_orbis_financial`, `attach_orbis_goal`) при любой строгости — `regex lookaround is not supported` на `positiveDecimal`; strict потребовал бы менять схемы аспектов, то есть пересев реестра на проде, и ничего не дал бы — вход валидирует ajv. Обе части доказаны пробой, матрица в §1.2 отчёта. Цена: возможности Responses API недоступны.
- **D27. Имя модели для метеринга отдаёт провайдер.** Обоснование: `makeAiDeps` считал его как `ORBIS_LLM_MODEL || DEFAULT_ANTHROPIC_MODEL` — при OpenAI без явной env `ai_usage` записал бы `claude-sonnet-5`. Цена: правка интерфейса `LLMProvider` с четырьмя реализациями.
- **D28. Неоднозначный выбор провайдера — отказ при старте.** Обоснование: доктрина `llm/provider.ts` уже запрещает молчаливый echo в production по той же причине; молча выбрать один из двух живых провайдеров дороже — счётчик расхода уйдёт не туда. Цена: стенд с двумя ключами не поднимется без явной `ORBIS_LLM_PROVIDER`.

- [ ] **Step 6: Проверить, что документы не разошлись с кодом**

Run:

```bash
grep -rn "DEFAULT_OPENAI_MODEL\|gpt-5.5" apps/server/src/llm/openai.ts docs/implementation/02-ops-runbook.md docs/prd/04-decision-log.md
```

Expected: имя модели в документах совпадает с константой в коде. Если разошлось — править документ, не код.

- [ ] **Step 7: Lint документов и коммит**

Run: `bun run lint; echo "lint exit=$?"`
Expected: `lint exit=0`.

```bash
git add apps/server/.env.example render.yaml docs/implementation/02-ops-runbook.md docs/prd/01-architecture.md docs/prd/04-decision-log.md
git commit -m "docs(llm): окружение, деплой и PRD второго провайдера к факту"
```

---

## Самопроверка плана

- **Покрытие спеки.** Р1 (транспорт) → Task 2 Step 3. Р2 (strict) → Global Constraints + Task 4 D26. Р3 (расслоение) → Task 1. Р4 (`modelId`) → Task 1 Steps 4, 6, 7. Р5 (фабрика) → Task 2 Step 4. Р6 (дефолтная модель) → Task 2 Step 3 + тест Step 1. Р7 (промпт v4) → Task 3. Р8 (деплой без пересева) → Task 4. Приёмка T7 спеки — живой смоук контроллера, вне задач для сабагентов.
- **Плейсхолдеров нет:** каждый шаг несёт либо точный код, либо точную команду с ожидаемым выводом.
- **Согласованность типов:** `AiSdkProvider` объявлен в Task 1 Step 3 с полями `modelId`/`model`/`timeoutMs`; Task 2 наследует его тем же конструктором. `LLMProvider.modelId` объявлен в Task 1 Step 4 и реализован во всех четырёх провайдерах (Anthropic и OpenAI — наследованием, Echo и Scripted — полем).
- **Известный флак:** оговорён в Task 1 Step 11 и распространяется на все прогоны `bun run test`.
