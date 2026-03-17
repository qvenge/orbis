import { ClaudeProvider } from './claude.provider.ts';
import type { LLMProvider } from './types.ts';

let _provider: LLMProvider | null = null;

export function getLLMProvider(): LLMProvider {
  if (!_provider) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error('ANTHROPIC_API_KEY environment variable is required');
    }
    _provider = new ClaudeProvider(apiKey);
  }
  return _provider;
}

export type { LLMProvider, LLMMessage, LLMToolDefinition, LLMToolCall, LLMToolResult, LLMRequest, LLMResponse } from './types.ts';
