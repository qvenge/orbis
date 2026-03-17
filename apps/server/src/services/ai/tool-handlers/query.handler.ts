import { eq, and, sql } from 'drizzle-orm';
import { entities } from '../../../db/schema.ts';
import type { Database } from '../../../db/client.ts';
import type { ActionResult } from '@orbis/shared';
import type { LLMToolCall } from '../../llm/types.ts';

export async function handleUserQuery(
  args: Record<string, unknown>,
  userId: string,
  db: Database,
  toolCall: LLMToolCall,
): Promise<ActionResult> {
  const conditions = [eq(entities.userId, userId), eq(entities.archived, false)];
  const filters = args.filters as Record<string, unknown> | undefined;

  if (filters?.tags && Array.isArray(filters.tags) && filters.tags.length > 0) {
    conditions.push(sql`${entities.tags} @> ${filters.tags as string[]}`);
  }
  if (filters?.aspects && Array.isArray(filters.aspects) && filters.aspects.length > 0) {
    for (const aspect of filters.aspects as string[]) {
      conditions.push(sql`${entities.aspects} ? ${aspect}`);
    }
  }

  const aggregation = typeof args.aggregation === 'string' ? args.aggregation : undefined;

  if (aggregation === 'count') {
    const [result] = await db
      .select({ count: sql<number>`count(*)` })
      .from(entities)
      .where(and(...conditions));
    return {
      type: 'query_result',
      toolCallId: toolCall.id,
      data: { count: Number(result.count) },
      message: `Count: ${result.count}`,
    };
  }

  const items = await db
    .select()
    .from(entities)
    .where(and(...conditions))
    .limit(20);

  return {
    type: 'query_result',
    toolCallId: toolCall.id,
    data: { entities: items },
    message: `Found ${items.length} entities`,
  };
}
