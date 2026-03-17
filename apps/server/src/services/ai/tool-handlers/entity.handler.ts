import { eq, and, sql } from 'drizzle-orm';
import { entities } from '../../../db/schema.ts';
import type { Database } from '../../../db/client.ts';
import type { ActionResult } from '@orbis/shared';
import type { LLMToolCall } from '../../llm/types.ts';
import { extractBodyRefs } from '../../../utils/body-refs.ts';

export async function handleEntityCreate(
  args: Record<string, unknown>,
  userId: string,
  db: Database,
  toolCall: LLMToolCall,
): Promise<ActionResult> {
  const id = crypto.randomUUID();
  const now = new Date();
  const body = typeof args.body === 'string' ? args.body : '';
  const bodyRefs = extractBodyRefs(body);

  const [entity] = await db
    .insert(entities)
    .values({
      id,
      userId,
      title: typeof args.title === 'string' ? args.title : 'Untitled',
      emoji: typeof args.emoji === 'string' ? args.emoji : null,
      body,
      bodyRefs,
      tags: Array.isArray(args.tags) ? (args.tags as string[]) : [],
      meta: (args.meta as Record<string, unknown>) ?? {},
      aspects: (args.aspects as Record<string, unknown>) ?? {},
      createdAt: now,
      updatedAt: now,
    })
    .returning();

  return { type: 'entity_created', toolCallId: toolCall.id, entity: entity as any };
}

export async function handleEntityUpdate(
  args: Record<string, unknown>,
  userId: string,
  db: Database,
  toolCall: LLMToolCall,
): Promise<ActionResult> {
  const entityId = typeof args.entityId === 'string' ? args.entityId : '';
  const setClause: Record<string, unknown> = { updatedAt: new Date() };

  if (args.title !== undefined) setClause.title = args.title;
  if (args.emoji !== undefined) setClause.emoji = args.emoji;
  if (args.body !== undefined) {
    setClause.body = args.body;
    setClause.bodyRefs = extractBodyRefs(args.body as string);
  }
  if (args.tags !== undefined) setClause.tags = args.tags;
  if (args.meta !== undefined) setClause.meta = args.meta;
  if (args.aspects !== undefined) setClause.aspects = args.aspects;

  const [entity] = await db
    .update(entities)
    .set(setClause)
    .where(and(eq(entities.id, entityId), eq(entities.userId, userId)))
    .returning();

  return { type: 'entity_updated', toolCallId: toolCall.id, entity: entity as any };
}

export async function handleEntitySearch(
  args: Record<string, unknown>,
  userId: string,
  db: Database,
  toolCall: LLMToolCall,
): Promise<ActionResult> {
  const conditions = [eq(entities.userId, userId), eq(entities.archived, false)];

  if (args.tags && Array.isArray(args.tags) && args.tags.length > 0) {
    conditions.push(sql`${entities.tags} @> ${args.tags as string[]}`);
  }
  if (args.aspects && Array.isArray(args.aspects) && args.aspects.length > 0) {
    for (const aspect of args.aspects as string[]) {
      conditions.push(sql`${entities.aspects} ? ${aspect}`);
    }
  }
  if (typeof args.query === 'string' && args.query) {
    conditions.push(
      sql`(to_tsvector('simple', ${entities.title}) || to_tsvector('simple', ${entities.body})) @@ plainto_tsquery('simple', ${args.query})`,
    );
  }

  const limit = typeof args.limit === 'number' ? args.limit : 20;
  const items = await db
    .select()
    .from(entities)
    .where(and(...conditions))
    .limit(limit);

  return {
    type: 'entity_list',
    toolCallId: toolCall.id,
    entities: items as any[],
    message: `Found ${items.length} entities`,
  };
}
