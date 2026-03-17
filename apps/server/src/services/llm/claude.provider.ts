import Anthropic from '@anthropic-ai/sdk';
import type { LLMProvider, LLMRequest, LLMResponse, LLMMessage, LLMToolDefinition } from './types.ts';

export class ClaudeProvider implements LLMProvider {
  private client: Anthropic;
  private model = 'claude-sonnet-4-20250514';

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  async chat(request: LLMRequest): Promise<LLMResponse> {
    const messages = this.mapMessages(request.messages);
    const tools = request.tools?.map((t) => this.mapTool(t));

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: request.maxTokens ?? 2000,
      system: request.systemPrompt ?? undefined,
      messages,
      ...(tools && tools.length > 0 ? { tools } : {}),
    });

    let content = '';
    const toolCalls: LLMResponse['toolCalls'] = [];

    for (const block of response.content) {
      if (block.type === 'text') {
        content += block.text;
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          name: block.name,
          arguments: block.input as Record<string, unknown>,
        });
      }
    }

    return {
      content,
      toolCalls,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
      stopReason: response.stop_reason ?? 'end_turn',
    };
  }

  private mapMessages(messages: LLMMessage[]): Anthropic.MessageParam[] {
    const result: Anthropic.MessageParam[] = [];

    for (const msg of messages) {
      if (msg.role === 'user') {
        if (msg.toolResults && msg.toolResults.length > 0) {
          result.push({
            role: 'user',
            content: msg.toolResults.map((tr) => ({
              type: 'tool_result' as const,
              tool_use_id: tr.toolCallId,
              content: tr.content,
            })),
          });
        } else {
          result.push({ role: 'user', content: msg.content });
        }
      } else if (msg.role === 'assistant') {
        const content: Anthropic.ContentBlockParam[] = [];
        if (msg.content) {
          content.push({ type: 'text', text: msg.content });
        }
        if (msg.toolCalls) {
          for (const tc of msg.toolCalls) {
            content.push({
              type: 'tool_use',
              id: tc.id,
              name: tc.name,
              input: tc.arguments,
            });
          }
        }
        result.push({ role: 'assistant', content });
      }
    }

    return result;
  }

  private mapTool(tool: LLMToolDefinition): Anthropic.Tool {
    return {
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema as Anthropic.Tool['input_schema'],
    };
  }
}
