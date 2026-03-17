import { eq, and, sql } from 'drizzle-orm';
import { entities, aspectDefinitions, userSettings } from '../../../db/schema.ts';
import type { Database } from '../../../db/client.ts';
import type { ActionResult } from '@orbis/shared';
import type { LLMToolCall } from '../../llm/types.ts';

export async function handleAttachAspect(
  args: Record<string, unknown>,
  userId: string,
  db: Database,
  toolCall: LLMToolCall,
): Promise<ActionResult> {
  const aspectId = toolCall.name.replace('attach_', '').replace('_', '/');
  const entityId = args.entityId as string;
  const { entityId: _eid, ...aspectData } = args;

  const [existing] = await db
    .select({ aspects: entities.aspects })
    .from(entities)
    .where(and(eq(entities.id, entityId), eq(entities.userId, userId)));

  if (!existing) {
    return { type: 'error', toolCallId: toolCall.id, message: 'Entity not found' };
  }

  const currentAspects = (existing.aspects as Record<string, unknown>) ?? {};
  const updatedAspects = { ...currentAspects, [aspectId]: aspectData };

  const [entity] = await db
    .update(entities)
    .set({ aspects: updatedAspects, updatedAt: new Date() })
    .where(and(eq(entities.id, entityId), eq(entities.userId, userId)))
    .returning();

  return {
    type: 'aspect_attached',
    toolCallId: toolCall.id,
    entity: entity as any,
    aspectId,
  };
}

export async function handleCreateCustomAspect(
  args: Record<string, unknown>,
  userId: string,
  db: Database,
  toolCall: LLMToolCall,
): Promise<ActionResult> {
  const name = typeof args.name === 'string' ? args.name : 'custom';
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const aspectId = `user/${slug}`;
  const fields = args.fields as Array<{ name: string; type: string; description?: string }>;

  const properties: Record<string, { type: string; description?: string }> = {};
  for (const f of fields) {
    properties[f.name] = { type: f.type, ...(f.description ? { description: f.description } : {}) };
  }

  // Use transaction for multi-table operation
  await db.transaction(async (tx) => {
    await tx
      .insert(aspectDefinitions)
      .values({
        id: aspectId,
        userId,
        name,
        namespace: 'user',
        schema: { type: 'object', properties },
        aiInstructions: typeof args.aiInstructions === 'string' ? args.aiInstructions : null,
        tagMappings: Array.isArray(args.tagMappings) ? (args.tagMappings as string[]) : [],
        viewConfig: {},
      })
      .onConflictDoNothing();

    await tx
      .update(userSettings)
      .set({
        aspectStatuses: sql`jsonb_set(${userSettings.aspectStatuses}, ${`{${aspectId}}`}, '"active"')`,
        updatedAt: new Date(),
      })
      .where(eq(userSettings.userId, userId));
  });

  return {
    type: 'aspect_created',
    toolCallId: toolCall.id,
    aspectId,
    data: { aspectId, name },
    message: `Custom aspect "${name}" (${aspectId}) created and activated`,
  };
}
