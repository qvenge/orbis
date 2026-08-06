// apps/server/src/llm/ai-sdk.test.ts
// Провайдеро-независимый слой поверх AI SDK. Ассерты маппинга переехали сюда
// из anthropic.test.ts вместе с кодом: они и были про SDK, а не про Anthropic.
//
// Сети здесь нет и быть не может: там, где нужен настоящий вызов generateText,
// подставляется модель-заглушка спецификации SDK — она никуда не ходит.

import { describe, expect, test } from 'bun:test';
import { AiSdkProvider, PROVIDER_TIMEOUT_MS, type SdkModel } from './ai-sdk';
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

function userRequest(): LLMRequest {
  return { system: '', messages: [{ role: 'user', content: 'привет' }], tools: [], maxTokens: 16 };
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
