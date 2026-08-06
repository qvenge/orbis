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
