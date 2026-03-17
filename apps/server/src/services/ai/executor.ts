import { eq, and, sql } from 'drizzle-orm';
import type { LLMToolCall } from '../llm/types.ts';
import { entities, relations, aspectDefinitions, userSettings } from '../../db/schema.ts';
import type { Database } from '../../db/client.ts';
import type { ActionResult } from '@orbis/shared';
import {
  buildBudgetSummary,
  buildFitnessSummary,
  buildNutritionSummary,
  buildHabitsSummary,
  buildDaySummary,
  buildWeekSummary,
} from './summary-builder.ts';

function extractBodyRefs(body: string): string[] {
  const regex = /\[\[entity:([0-9a-f-]{36})\|[^\]]*\]\]/g;
  const refs: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(body)) !== null) {
    refs.push(match[1]);
  }
  return [...new Set(refs)];
}

export async function executeToolCall(
  toolCall: LLMToolCall,
  userId: string,
  db: Database,
): Promise<ActionResult> {
  const args = toolCall.arguments;

  try {
    // --- entity_create ---
    if (toolCall.name === 'entity_create') {
      const id = crypto.randomUUID();
      const now = new Date();
      const body = (args.body as string) ?? '';
      const bodyRefs = extractBodyRefs(body);

      const [entity] = await db
        .insert(entities)
        .values({
          id,
          userId,
          title: args.title as string,
          emoji: (args.emoji as string) ?? null,
          body,
          bodyRefs,
          tags: (args.tags as string[]) ?? [],
          meta: (args.meta as Record<string, unknown>) ?? {},
          aspects: (args.aspects as Record<string, unknown>) ?? {},
          createdAt: now,
          updatedAt: now,
        })
        .returning();

      return { type: 'entity_created', toolCallId: toolCall.id, entity: entity as any };
    }

    // --- entity_update ---
    if (toolCall.name === 'entity_update') {
      const entityId = args.entityId as string;
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

    // --- entity_search ---
    if (toolCall.name === 'entity_search') {
      const conditions = [eq(entities.userId, userId), eq(entities.archived, false)];

      if (args.tags && (args.tags as string[]).length > 0) {
        conditions.push(sql`${entities.tags} @> ${args.tags as string[]}`);
      }
      if (args.aspects && (args.aspects as string[]).length > 0) {
        for (const aspect of args.aspects as string[]) {
          conditions.push(sql`${entities.aspects} ? ${aspect}`);
        }
      }
      if (args.query) {
        conditions.push(
          sql`(to_tsvector('simple', ${entities.title}) || to_tsvector('simple', ${entities.body})) @@ plainto_tsquery('simple', ${args.query as string})`,
        );
      }

      const limit = (args.limit as number) ?? 20;
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

    // --- relation_create ---
    if (toolCall.name === 'relation_create') {
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

    // --- relation_delete ---
    if (toolCall.name === 'relation_delete') {
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

    // --- attach_orbis_* (dynamic aspect tools) ---
    if (toolCall.name.startsWith('attach_')) {
      const aspectId = toolCall.name.replace('attach_', '').replace('_', '/');
      const entityId = args.entityId as string;
      const { entityId: _eid, ...aspectData } = args;

      // Merge aspect data into entity
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

    // --- create_custom_aspect ---
    if (toolCall.name === 'create_custom_aspect') {
      const name = args.name as string;
      const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      const aspectId = `user/${slug}`;
      const fields = args.fields as Array<{ name: string; type: string; description?: string }>;

      // Build JSON Schema from fields
      const properties: Record<string, { type: string; description?: string }> = {};
      for (const f of fields) {
        properties[f.name] = { type: f.type, ...(f.description ? { description: f.description } : {}) };
      }

      // Insert aspect definition
      await db
        .insert(aspectDefinitions)
        .values({
          id: aspectId,
          userId,
          name,
          namespace: 'user',
          schema: { type: 'object', properties },
          aiInstructions: (args.aiInstructions as string) ?? null,
          tagMappings: (args.tagMappings as string[]) ?? [],
          viewConfig: {},
        })
        .onConflictDoNothing();

      // Auto-activate
      await db
        .update(userSettings)
        .set({
          aspectStatuses: sql`jsonb_set(${userSettings.aspectStatuses}, ${`{${aspectId}}`}, '"active"')`,
          updatedAt: new Date(),
        })
        .where(eq(userSettings.userId, userId));

      return {
        type: 'aspect_created',
        toolCallId: toolCall.id,
        aspectId,
        data: { aspectId, name },
        message: `Custom aspect "${name}" (${aspectId}) created and activated`,
      };
    }

    // --- generate_summary ---
    if (toolCall.name === 'generate_summary') {
      const summaryType = args.summaryType as string;
      const now = new Date();
      const year = (args.year as number) ?? now.getFullYear();
      const month = (args.month as number) ?? now.getMonth() + 1;
      const date = (args.date as string) ?? now.toISOString().slice(0, 10);

      let summaryData: Record<string, unknown>;

      if (summaryType === 'budget') {
        summaryData = { summaryType, year, month, ...(await buildBudgetSummary(db, userId, year, month)) };
      } else if (summaryType === 'fitness') {
        summaryData = { summaryType, year, month, ...(await buildFitnessSummary(db, userId, year, month)) };
      } else if (summaryType === 'nutrition') {
        summaryData = { summaryType, year, month, ...(await buildNutritionSummary(db, userId, year, month)) };
      } else if (summaryType === 'habits') {
        summaryData = { summaryType, ...(await buildHabitsSummary(db, userId)) };
      } else if (summaryType === 'day') {
        summaryData = { summaryType, ...(await buildDaySummary(db, userId, date)) };
      } else if (summaryType === 'week') {
        // Find Monday of the week containing the date
        const d = new Date(date + 'T00:00:00');
        const day = d.getDay();
        const diff = day === 0 ? -6 : 1 - day;
        d.setDate(d.getDate() + diff);
        const weekStart = d.toISOString().slice(0, 10);
        summaryData = { summaryType, ...(await buildWeekSummary(db, userId, weekStart)) };
      } else {
        return { type: 'error', toolCallId: toolCall.id, message: `Unknown summary type: ${summaryType}` };
      }

      return {
        type: 'summary_generated',
        toolCallId: toolCall.id,
        data: summaryData,
        message: JSON.stringify(summaryData),
      };
    }

    // --- user_query ---
    if (toolCall.name === 'user_query') {
      const conditions = [eq(entities.userId, userId), eq(entities.archived, false)];
      const filters = args.filters as Record<string, unknown> | undefined;

      if (filters?.tags && (filters.tags as string[]).length > 0) {
        conditions.push(sql`${entities.tags} @> ${filters.tags as string[]}`);
      }
      if (filters?.aspects && (filters.aspects as string[]).length > 0) {
        for (const aspect of filters.aspects as string[]) {
          conditions.push(sql`${entities.aspects} ? ${aspect}`);
        }
      }

      const aggregation = args.aggregation as string | undefined;

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

      // Default: list entities
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

    return { type: 'error', toolCallId: toolCall.id, message: `Unknown tool: ${toolCall.name}` };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Tool failed';
    return { type: 'error', toolCallId: toolCall.id, message };
  }
}
