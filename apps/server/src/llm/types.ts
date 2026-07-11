export interface LLMMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}
export interface LLMToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}
export interface LLMToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}
export interface LLMRequest {
  system: string;
  messages: LLMMessage[];
  tools: LLMToolDef[];
  maxTokens: number;
}
export type LLMStopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal';
export interface LLMResponse {
  content: string;
  toolCalls: LLMToolCall[];
  usage: { inputTokens: number; outputTokens: number };
  stopReason: LLMStopReason;
}
export interface LLMProvider {
  chat(req: LLMRequest): Promise<LLMResponse>;
}
