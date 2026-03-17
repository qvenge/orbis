export interface LLMMessage {
  role: 'user' | 'assistant';
  content: string;
  toolCalls?: LLMToolCall[];
  toolResults?: LLMToolResult[];
}

export interface LLMToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface LLMToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface LLMToolResult {
  toolCallId: string;
  content: string;
}

export interface LLMRequest {
  messages: LLMMessage[];
  tools?: LLMToolDefinition[];
  systemPrompt?: string;
  maxTokens?: number;
}

export interface LLMResponse {
  content: string;
  toolCalls: LLMToolCall[];
  usage: { inputTokens: number; outputTokens: number };
  stopReason: string;
}

export interface LLMProvider {
  chat(request: LLMRequest): Promise<LLMResponse>;
}
