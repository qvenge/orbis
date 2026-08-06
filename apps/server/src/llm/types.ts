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
  /**
   * Имя модели для метеринга §4.7. Отдаёт САМ провайдер: пока имя вычислялось
   * снаружи как `env.ORBIS_LLM_MODEL || DEFAULT_ANTHROPIC_MODEL`, второй провайдер
   * без явной env писал бы в ai_usage чужую модель.
   */
  readonly modelId: string;
  chat(req: LLMRequest): Promise<LLMResponse>;
}
