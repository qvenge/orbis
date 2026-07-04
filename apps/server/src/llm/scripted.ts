// apps/server/src/llm/scripted.ts
// ScriptedProvider — детерминированный LLMProvider для интеграционных тестов
// (главный провайдер Task 9/12; Global Constraints плана 1b: LLM вне CI —
// CI гоняет только echo/scripted). Отдаёт заранее заданные ответы по очереди
// и записывает полученные запросы для ассертов.

import type { LLMProvider, LLMRequest, LLMResponse } from './types';

export class ScriptedProvider implements LLMProvider {
  /** Полученные запросы — снимки на момент вызова (structuredClone), для ассертов. */
  readonly requests: LLMRequest[] = [];
  private next = 0;

  constructor(private readonly script: readonly LLMResponse[]) {}

  async chat(req: LLMRequest): Promise<LLMResponse> {
    this.requests.push(structuredClone(req));
    const response = this.script[this.next];
    if (response === undefined) {
      throw new Error(
        `ScriptedProvider: скрипт исчерпан — вызов №${this.next + 1} при ${this.script.length} заданных ответах`,
      );
    }
    this.next += 1;
    // копия: мутация ответа потребителем не должна портить скрипт и другие ассерты
    return structuredClone(response);
  }
}
