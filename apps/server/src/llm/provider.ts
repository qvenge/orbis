import type { LLMProvider, LLMRequest, LLMResponse } from './types';

export class EchoProvider implements LLMProvider {
  async chat(req: LLMRequest): Promise<LLMResponse> {
    const last = req.messages.at(-1)?.content ?? '';
    return {
      content: `echo: ${last}`,
      toolCalls: [],
      usage: { inputTokens: 0, outputTokens: 0 },
      stopReason: 'end_turn',
    };
  }
}
export type { LLMProvider } from './types';
