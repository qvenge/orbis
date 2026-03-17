import type { LLMToolCall } from '../llm/types.ts';
import type { Database } from '../../db/client.ts';
import type { ActionResult } from '@orbis/shared';
import { resolveHandler } from './tool-handlers/index.ts';

export async function executeToolCall(
  toolCall: LLMToolCall,
  userId: string,
  db: Database,
): Promise<ActionResult> {
  const handler = resolveHandler(toolCall.name);

  if (!handler) {
    return { type: 'error', toolCallId: toolCall.id, message: `Unknown tool: ${toolCall.name}` };
  }

  try {
    return await handler(toolCall.arguments, userId, db, toolCall);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Tool failed';
    return { type: 'error', toolCallId: toolCall.id, message };
  }
}
