import { eq, and } from 'drizzle-orm';
import { relations } from '../../../db/schema.ts';
import type { Database } from '../../../db/client.ts';
import type { ActionResult } from '@orbis/shared';
import type { LLMToolCall } from '../../llm/types.ts';

export async function handleRelationCreate(
  args: Record<string, unknown>,
  _userId: string,
  db: Database,
  toolCall: LLMToolCall,
): Promise<ActionResult> {
  const id = crypto.randomUUID();
  const [relation] = await db
    .insert(relations)
    .values({
      id,
      sourceId: args.sourceId as string,
      targetId: args.targetId as string,
      relationType: args.relationType as string,
      meta: {},
    })
    .returning();

  return { type: 'relation_created', toolCallId: toolCall.id, relation: relation as any };
}

export async function handleRelationDelete(
  args: Record<string, unknown>,
  _userId: string,
  db: Database,
  toolCall: LLMToolCall,
): Promise<ActionResult> {
  await db
    .delete(relations)
    .where(
      and(
        eq(relations.sourceId, args.sourceId as string),
        eq(relations.targetId, args.targetId as string),
        eq(relations.relationType, args.relationType as string),
      ),
    );

  return { type: 'relation_deleted', toolCallId: toolCall.id };
}
