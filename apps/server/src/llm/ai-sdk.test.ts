// apps/server/src/llm/ai-sdk.test.ts
// Единственный тест провайдеро-независимого слоя: чистый маппинг (mapSdkResult,
// toSdkTools) и поведение AiSdkProvider.
//
// Ассерты маппинга жили в anthropic.test.ts, пока сам слой жил в anthropic.ts;
// вместе с кодом они переехали сюда — они и были про SDK, а не про Anthropic.
// Тот файл удалён, а не оставлен рядом: имя «anthropic» над тестами, целиком
// импортирующими `./ai-sdk`, звало вычистить его «как устаревший» после того, как
// Anthropic стал тонкой обёрткой, — и унести с собой всё покрытие маппинга.
// Обёртки провайдеров проверяются отдельно: openai.test.ts, а AnthropicProvider —
// через фабрику в provider.test.ts (instanceof + DEFAULT_ANTHROPIC_MODEL).
//
// Сети здесь нет и быть не может: там, где нужен настоящий вызов generateText,
// подставляется модель-заглушка спецификации SDK — она никуда не ходит. Маппинг
// гоняется на литеральных фикстурах формата результата generateText (форма
// зафиксирована по установленному ai@7.0.15: GenerateTextResult → text /
// toolCalls[{toolCallId,toolName,input}] /
// finishReason: 'stop'|'length'|'content-filter'|'tool-calls'|'error'|'other' /
// usage{inputTokens,outputTokens}: number|undefined — node_modules/ai/dist/index.d.ts).

import { describe, expect, test } from 'bun:test';
import {
  AiSdkProvider,
  mapSdkResult,
  PROVIDER_TIMEOUT_MS,
  type SdkModel,
  toSdkTools,
} from './ai-sdk';
import type { LLMRequest } from './types';

/**
 * Модель-заглушка, которая ЗАВИСАЕТ до отмены. Так таймаут проверяется по
 * наблюдаемому поведению (запрос действительно прерывается), а не заглядыванием
 * в приватное поле: поле само по себе ничего не доказывает — важно, что оно
 * доехало до abortSignal вызова.
 */
function hangingModel(): SdkModel {
  return {
    specificationVersion: 'v4',
    provider: 'test',
    modelId: 'hang',
    supportedUrls: {},
    doGenerate: ({ abortSignal }) =>
      new Promise<never>((_resolve, reject) => {
        // Как настоящий fetch: уже отменённый сигнал отказывает сразу. Без этой
        // ветки повторная попытка SDK (maxRetries) зависла бы навсегда — событие
        // 'abort' к тому моменту уже прошло.
        if (abortSignal?.aborted) {
          reject(abortSignal.reason);
          return;
        }
        abortSignal?.addEventListener('abort', () => {
          reject(abortSignal.reason);
        });
      }),
    doStream: () => Promise.reject(new Error('стриминг в этих тестах не используется')),
  };
}

/**
 * Модель-заглушка, которая никуда не ходит, а ЗАПИСЫВАЕТ то, что ей передал SDK.
 * Провайдеро-специфичные добавки (toolExtras, providerOptions) проверяются по
 * содержимому вызова, а не чтением приватных полей провайдера: поле само по себе
 * доказывает лишь то, что мы его куда-то положили, — а нужно, чтобы оно доехало
 * до запроса. Пустой успешный ответ: предмет проверки — вход, не выход.
 */
function capturingModel(): {
  model: SdkModel;
  calls: { tools: unknown; providerOptions: unknown }[];
} {
  const calls: { tools: unknown; providerOptions: unknown }[] = [];
  const model: SdkModel = {
    specificationVersion: 'v4',
    provider: 'test',
    modelId: 'capture',
    supportedUrls: {},
    doGenerate: ({ tools, providerOptions }) => {
      calls.push({ tools, providerOptions });
      return Promise.resolve({
        content: [],
        finishReason: { unified: 'stop' as const, raw: undefined },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 1, text: 1, reasoning: 0 },
        },
        warnings: [],
      });
    },
    doStream: () => Promise.reject(new Error('стриминг в этих тестах не используется')),
  };
  return { model, calls };
}

function userRequest(): LLMRequest {
  return { system: '', messages: [{ role: 'user', content: 'привет' }], tools: [], maxTokens: 16 };
}

/** Схема тула для проверок формы: важно не её содержимое, а то, что она доезжает дословно. */
const TOOL_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: { id: { type: 'string' } },
  required: ['id'],
  additionalProperties: false,
};

/** Запрос с ДВУМЯ тулами: добавки обязаны попасть в каждый, а не только в первый. */
function requestWithTools(): LLMRequest {
  return {
    system: '',
    messages: [{ role: 'user', content: 'привет' }],
    tools: [
      { name: 'entity_get', description: 'взять сущность', inputSchema: TOOL_SCHEMA },
      { name: 'entity_create', description: 'создать сущность', inputSchema: TOOL_SCHEMA },
    ],
    maxTokens: 16,
  };
}

describe('AiSdkProvider', () => {
  test('modelId — тот, что передан; провайдер отдаёт имя модели сам', () => {
    const p = new AiSdkProvider({ model: 'заглушка' as never, modelId: 'некая-модель-1' });
    expect(p.modelId).toBe('некая-модель-1');
  });

  test('PROVIDER_TIMEOUT_MS — 180 с: порог заведомо выше легитимного adaptive thinking', () => {
    expect(PROVIDER_TIMEOUT_MS).toBe(180_000);
  });

  test('timeoutMs доезжает до abortSignal: зависший провайдер отменяется, а не висит вечно', async () => {
    const p = new AiSdkProvider({ model: hangingModel(), modelId: 'м', timeoutMs: 30 });
    // Bun 1.2.7: таймер AbortSignal.timeout не ref-ит цикл событий, и под `bun test`
    // он не срабатывает вовсе, если цикл больше ничем не занят (проверено пробой).
    // В бою цикл держит HTTP-сервер, здесь его держит этот интервал.
    const keepAlive = setInterval(() => {}, 10);
    try {
      const started = Date.now();
      await expect(p.chat(userRequest())).rejects.toThrow();
      // Запас огромный намеренно: проверяется не точность таймера, а сам факт отмены —
      // без неё этот вызов не завершился бы никогда.
      expect(Date.now() - started).toBeLessThan(10_000);
    } finally {
      clearInterval(keepAlive);
    }
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

// ---------------------------------------------------------------------------
// Провайдеро-специфичные добавки: общий слой их ПЕРЕНОСИТ, но не придумывает сам
// ---------------------------------------------------------------------------

describe('AiSdkProvider: toolExtras и providerOptions', () => {
  test('toolExtras домешивается в КАЖДЫЙ тул запроса, а не только в первый', async () => {
    const { model, calls } = capturingModel();
    const p = new AiSdkProvider({ model, modelId: 'м', toolExtras: { strict: true } });
    await p.chat(requestWithTools());
    // Сравнение целыми объектами, а не по одному полю: заодно пинит, что описание
    // и схема доезжают до провайдера дословно, а имя тула становится именем в запросе.
    expect(calls[0]?.tools).toEqual([
      {
        type: 'function',
        name: 'entity_get',
        description: 'взять сущность',
        inputSchema: TOOL_SCHEMA,
        strict: true,
      },
      {
        type: 'function',
        name: 'entity_create',
        description: 'создать сущность',
        inputSchema: TOOL_SCHEMA,
        strict: true,
      },
    ]);
  });

  test('без toolExtras тулы не обрастают лишними полями', async () => {
    // Это защита Anthropic, а не косметика: @ai-sdk/anthropic на ЛЮБОЕ непустое
    // strict печатает предупреждение и поле игнорирует (dist/index.js:1599). Общий
    // слой не имеет права навязывать провайдерам значения, которых у них не спросили.
    const { model, calls } = capturingModel();
    const p = new AiSdkProvider({ model, modelId: 'м' });
    await p.chat(requestWithTools());
    expect(calls[0]?.tools).toEqual([
      {
        type: 'function',
        name: 'entity_get',
        description: 'взять сущность',
        inputSchema: TOOL_SCHEMA,
      },
      {
        type: 'function',
        name: 'entity_create',
        description: 'создать сущность',
        inputSchema: TOOL_SCHEMA,
      },
    ]);
  });

  test('providerOptions конструктора доезжают до вызова', async () => {
    const { model, calls } = capturingModel();
    const p = new AiSdkProvider({
      model,
      modelId: 'м',
      providerOptions: { openai: { store: false } },
    });
    await p.chat(userRequest());
    expect(calls[0]?.providerOptions).toEqual({ openai: { store: false } });
  });

  test('без providerOptions вызову ничего не навязывается', async () => {
    const { model, calls } = capturingModel();
    await new AiSdkProvider({ model, modelId: 'м' }).chat(userRequest());
    expect(calls[0]?.providerOptions).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// mapSdkResult: текстовый ответ
// ---------------------------------------------------------------------------

describe('mapSdkResult: текстовый ответ', () => {
  test("finishReason 'stop' → end_turn; content и usage переносятся как есть", () => {
    const r = mapSdkResult({
      text: 'Привет! Чем могу помочь?',
      toolCalls: [],
      finishReason: 'stop',
      usage: { inputTokens: 42, outputTokens: 17 },
    });
    expect(r).toEqual({
      content: 'Привет! Чем могу помочь?',
      toolCalls: [],
      usage: { inputTokens: 42, outputTokens: 17 },
      stopReason: 'end_turn',
    });
  });

  test("finishReason 'length' → max_tokens (обрезка по лимиту)", () => {
    const r = mapSdkResult({
      text: 'Начало длинного отв',
      toolCalls: [],
      finishReason: 'length',
      usage: { inputTokens: 10, outputTokens: 100 },
    });
    expect(r.stopReason).toBe('max_tokens');
  });

  test('usage undefined (провайдер не отдал числа) → нули, а не NaN/undefined', () => {
    const r = mapSdkResult({
      text: 'ок',
      toolCalls: [],
      finishReason: 'stop',
      usage: { inputTokens: undefined, outputTokens: undefined },
    });
    expect(r.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });
});

// ---------------------------------------------------------------------------
// mapSdkResult: tool-calls
// ---------------------------------------------------------------------------

describe('mapSdkResult: tool-calls', () => {
  test("finishReason 'tool-calls' → tool_use; toolCallId/toolName/input → id/name/input", () => {
    const r = mapSdkResult({
      text: '',
      toolCalls: [
        {
          toolCallId: 'toolu_01A',
          toolName: 'entity_query',
          input: { query: 'kind:task and !done' },
        },
      ],
      finishReason: 'tool-calls',
      usage: { inputTokens: 350, outputTokens: 60 },
    });
    expect(r.stopReason).toBe('tool_use');
    expect(r.content).toBe('');
    expect(r.toolCalls).toEqual([
      { id: 'toolu_01A', name: 'entity_query', input: { query: 'kind:task and !done' } },
    ]);
  });

  test('параллельные tool-calls: порядок сохраняется', () => {
    const r = mapSdkResult({
      text: 'Сейчас проверю обе сущности.',
      toolCalls: [
        { toolCallId: 'toolu_01', toolName: 'entity_get', input: { id: 'a' } },
        { toolCallId: 'toolu_02', toolName: 'entity_get', input: { id: 'b' } },
      ],
      finishReason: 'tool-calls',
      usage: { inputTokens: 400, outputTokens: 90 },
    });
    expect(r.toolCalls.map((c) => c.id)).toEqual(['toolu_01', 'toolu_02']);
    expect(r.content).toBe('Сейчас проверю обе сущности.');
  });

  test('невалидный input (SDK: dynamic/invalid tool-call, input не объект) → пустой объект', () => {
    // Валидацию входа на исполнении делает dispatch (zod/ajv) и возвращает
    // модели структурную ошибку — здесь только детерминированная форма.
    const r = mapSdkResult({
      text: '',
      toolCalls: [{ toolCallId: 'toolu_bad', toolName: 'entity_get', input: 'не json-объект' }],
      finishReason: 'tool-calls',
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    expect(r.toolCalls).toEqual([{ id: 'toolu_bad', name: 'entity_get', input: {} }]);
  });
});

// ---------------------------------------------------------------------------
// mapSdkResult: полнота по finishReason — все 6 значений ai@7 покрыты
// ---------------------------------------------------------------------------

describe('mapSdkResult: полнота stopReason', () => {
  const base = { text: '', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } } as const;

  test.each([
    ['stop', 'end_turn'],
    ['length', 'max_tokens'],
    ['tool-calls', 'tool_use'],
    // отказ модели различим (§7.7, ревью 2026-07-09): SDK сводит refusal к
    // content-filter — наружу идёт 'refusal', send-message отвечает error_card
    ['content-filter', 'refusal'],
    // прочие аварийные резоны детерминированно сводятся к end_turn (ответ как есть)
    ['error', 'end_turn'],
    ['other', 'end_turn'],
  ] as const)("finishReason '%s' → '%s'", (finishReason, stopReason) => {
    expect(mapSdkResult({ ...base, finishReason }).stopReason).toBe(stopReason);
  });
});

// ---------------------------------------------------------------------------
// toSdkTools: конвертация наших LLMToolDef в ToolSet SDK (jsonSchema-хелпер)
// ---------------------------------------------------------------------------

describe('toSdkTools', () => {
  test('имена становятся ключами ToolSet, description переносится, схема — через jsonSchema()', () => {
    const schema = {
      type: 'object',
      properties: { query: { type: 'string', minLength: 1 } },
      required: ['query'],
      additionalProperties: false,
    };
    const tools = toSdkTools([
      { name: 'entity_query', description: 'Поиск сущностей (§6).', inputSchema: schema },
    ]);
    expect(Object.keys(tools)).toEqual(['entity_query']);
    expect(tools.entity_query?.description).toBe('Поиск сущностей (§6).');
    // jsonSchema() SDK хранит исходную JSON Schema в поле .jsonSchema — наша
    // схема реестра (Task 4, inputJsonSchema) должна дойти до SDK дословно
    expect((tools.entity_query?.inputSchema as { jsonSchema: unknown }).jsonSchema).toEqual(schema);
    // execute не задаём: SDK не должен исполнять тулы сам — исполняет Task 9
    expect(tools.entity_query?.execute).toBeUndefined();
  });
});
