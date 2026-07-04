// Тесты echo/scripted-провайдеров и фабрики makeLLMProvider.
// Ни одного сетевого вызова: echo/scripted детерминированы, а создание
// AnthropicProvider (фабрикой) не ходит в сеть — сеть только в chat().

import { describe, expect, test } from 'bun:test';
import { AnthropicProvider } from './anthropic';
import { EchoProvider, makeLLMProvider } from './provider';
import { ScriptedProvider } from './scripted';
import type { LLMRequest, LLMResponse } from './types';

function userRequest(content: string): LLMRequest {
  return {
    system: '',
    messages: [{ role: 'user', content }],
    tools: [],
    maxTokens: 100,
  };
}

// ---------------------------------------------------------------------------
// EchoProvider — обязательство Вехи 0 (T8): формат префикса и usage пиннятся
// точными значениями, а не toContain — регресс формата ломает CI.
// ---------------------------------------------------------------------------

describe('EchoProvider', () => {
  test('пин Вехи 0: ровно `echo: <последнее сообщение>`, нулевой usage, end_turn', async () => {
    const r = await new EchoProvider().chat(userRequest('привет'));
    expect(r.content).toBe('echo: привет');
    expect(r.toolCalls).toEqual([]);
    expect(r.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
    expect(r.stopReason).toBe('end_turn');
  });

  test('эхо берёт именно последнее сообщение истории', async () => {
    const r = await new EchoProvider().chat({
      system: 'system-промпт не влияет на echo',
      messages: [
        { role: 'user', content: 'первое' },
        { role: 'assistant', content: 'echo: первое' },
        { role: 'user', content: 'второе' },
      ],
      tools: [],
      maxTokens: 100,
    });
    expect(r.content).toBe('echo: второе');
  });

  test('пустая история → `echo: ` (пустой хвост, без падения)', async () => {
    const r = await new EchoProvider().chat({ system: '', messages: [], tools: [], maxTokens: 1 });
    expect(r.content).toBe('echo: ');
    expect(r.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });
});

// ---------------------------------------------------------------------------
// ScriptedProvider — главный провайдер интеграционных тестов Task 9/12:
// отдаёт заранее заданные ответы по очереди, записывает полученные запросы.
// ---------------------------------------------------------------------------

const scriptedToolCall: LLMResponse = {
  content: '',
  toolCalls: [{ id: 'call_1', name: 'entity_query', input: { query: 'kind:task' } }],
  usage: { inputTokens: 10, outputTokens: 5 },
  stopReason: 'tool_use',
};

const scriptedFinal: LLMResponse = {
  content: 'готово',
  toolCalls: [],
  usage: { inputTokens: 20, outputTokens: 7 },
  stopReason: 'end_turn',
};

describe('ScriptedProvider', () => {
  test('отдаёт ответы строго по очереди', async () => {
    const p = new ScriptedProvider([scriptedToolCall, scriptedFinal]);
    expect(await p.chat(userRequest('раз'))).toEqual(scriptedToolCall);
    expect(await p.chat(userRequest('два'))).toEqual(scriptedFinal);
  });

  test('записывает полученные LLMRequest для ассертов', async () => {
    const p = new ScriptedProvider([scriptedToolCall, scriptedFinal]);
    await p.chat(userRequest('раз'));
    await p.chat(userRequest('два'));
    expect(p.requests).toHaveLength(2);
    expect(p.requests[0]?.messages[0]?.content).toBe('раз');
    expect(p.requests[1]?.messages[0]?.content).toBe('два');
  });

  test('записанный запрос — снимок: последующая мутация вызывающим не портит ассерты', async () => {
    const p = new ScriptedProvider([scriptedFinal]);
    const req = userRequest('исходное');
    await p.chat(req);
    req.messages[0] = { role: 'user', content: 'подменили' };
    expect(p.requests[0]?.messages[0]?.content).toBe('исходное');
  });

  test('исчерпание скрипта → понятная ошибка, а не undefined', async () => {
    const p = new ScriptedProvider([scriptedFinal]);
    await p.chat(userRequest('раз'));
    await expect(p.chat(userRequest('два'))).rejects.toThrow('скрипт исчерпан');
  });
});

// ---------------------------------------------------------------------------
// makeLLMProvider — выбор по env: все комбинации ORBIS_LLM_PROVIDER × ключа.
// env инжектится параметром — тесты не зависят от реального process.env.
// ---------------------------------------------------------------------------

describe('makeLLMProvider', () => {
  test('без ORBIS_LLM_PROVIDER и без ключа → echo (fail-safe для dev)', () => {
    expect(makeLLMProvider({})).toBeInstanceOf(EchoProvider);
  });

  test('без ORBIS_LLM_PROVIDER, но с ключом → anthropic', () => {
    expect(makeLLMProvider({ ANTHROPIC_API_KEY: 'sk-test' })).toBeInstanceOf(AnthropicProvider);
  });

  test("явный 'anthropic' с ключом → anthropic", () => {
    const p = makeLLMProvider({ ORBIS_LLM_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'sk-test' });
    expect(p).toBeInstanceOf(AnthropicProvider);
  });

  test("явный 'anthropic' БЕЗ ключа → внятная ошибка при создании (не при вызове)", () => {
    expect(() => makeLLMProvider({ ORBIS_LLM_PROVIDER: 'anthropic' })).toThrow('ANTHROPIC_API_KEY');
  });

  test("явный 'echo' → echo даже при наличии ключа", () => {
    const p = makeLLMProvider({ ORBIS_LLM_PROVIDER: 'echo', ANTHROPIC_API_KEY: 'sk-test' });
    expect(p).toBeInstanceOf(EchoProvider);
  });

  test('неизвестное значение ORBIS_LLM_PROVIDER → ошибка при создании', () => {
    expect(() => makeLLMProvider({ ORBIS_LLM_PROVIDER: 'openai' })).toThrow(
      "неизвестный ORBIS_LLM_PROVIDER='openai'",
    );
  });

  test('пустая строка ORBIS_LLM_PROVIDER трактуется как «не задан»', () => {
    expect(makeLLMProvider({ ORBIS_LLM_PROVIDER: '' })).toBeInstanceOf(EchoProvider);
  });
});
