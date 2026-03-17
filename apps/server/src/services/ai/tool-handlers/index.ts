import type { Database } from '../../../db/client.ts';
import type { ActionResult } from '@orbis/shared';
import type { LLMToolCall } from '../../llm/types.ts';
import { handleEntityCreate, handleEntityUpdate, handleEntitySearch } from './entity.handler.ts';
import { handleRelationCreate, handleRelationDelete } from './relation.handler.ts';
import { handleAttachAspect, handleCreateCustomAspect } from './aspect.handler.ts';
import { handleGenerateSummary } from './summary.handler.ts';
import { handleUserQuery } from './query.handler.ts';

export type ToolHandler = (
  args: Record<string, unknown>,
  userId: string,
  db: Database,
  toolCall: LLMToolCall,
) => Promise<ActionResult>;

const registry = new Map<string, ToolHandler>([
  ['entity_create', handleEntityCreate],
  ['entity_update', handleEntityUpdate],
  ['entity_search', handleEntitySearch],
  ['relation_create', handleRelationCreate],
  ['relation_delete', handleRelationDelete],
  ['create_custom_aspect', handleCreateCustomAspect],
  ['generate_summary', handleGenerateSummary],
  ['user_query', handleUserQuery],
]);

export function resolveHandler(toolName: string): ToolHandler | null {
  const handler = registry.get(toolName);
  if (handler) return handler;

  // Dynamic aspect attachment tools: attach_orbis_task, attach_user_myaspect, etc.
  if (toolName.startsWith('attach_')) return handleAttachAspect;

  return null;
}
