// Тесты маппинга AnthropicProvider — БЕЗ сети и БЕЗ моков generateText:
// чистая mapSdkResult гоняется на литеральных фикстурах формата результата
// generateText (форма зафиксирована по установленному ai@7.0.15:
// GenerateTextResult → text / toolCalls[{toolCallId,toolName,input}] /
// finishReason: 'stop'|'length'|'content-filter'|'tool-calls'|'error'|'other' /
// usage{inputTokens,outputTokens}: number|undefined — node_modules/ai/dist/index.d.ts).

import { describe, expect, test } from 'bun:test';
import { mapSdkResult, toSdkTools } from './anthropic';

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
