import { eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { entities, userSettings } from './schema.ts';

const SMART_VIEWS = [
  {
    title: 'Daily Planning',
    emoji: '📋',
    tags: ['system', 'smart-view'],
    body: `## Inbox
{{query: aspect=orbis/task, status=inbox, sortBy=created_at:desc, title=Inbox}}

## Today
{{query: aspect=orbis/task, due=today|overdue, status=!done&!cancelled&!waiting, excludeBlocked=true, sortBy=priority:desc|due_date:asc, title=Today}}

## Waiting
{{query: aspect=orbis/task, status=waiting, sortBy=updated_at:desc, title=Waiting}}`,
  },
  {
    title: 'Upcoming',
    emoji: '📅',
    tags: ['system', 'smart-view'],
    body: `## Next 7 Days
{{query: aspect=orbis/task, due=next_7d, status=!done&!cancelled, excludeBlocked=true, sortBy=due_date:asc|priority:desc, title=Next 7 Days}}

## Later
{{query: aspect=orbis/task, due=after_7d, status=!done&!cancelled, sortBy=due_date:asc, limit=30, title=Later}}`,
  },
  {
    title: 'All Tasks',
    emoji: '✅',
    tags: ['system', 'smart-view'],
    body: `{{query: aspect=orbis/task, status=!done&!cancelled, sortBy=updated_at:desc, title=All Active Tasks}}`,
  },
];

/**
 * Bootstrap smart view entities for a user if they don't exist yet.
 * Returns the pinned entities array.
 */
export async function ensureSmartViews(
  db: NodePgDatabase<Record<string, never>>,
  userId: string,
): Promise<Array<{ id: string; order: number }>> {
  // Check if smart views already exist
  const existingTags = await db
    .select({ id: entities.id, tags: entities.tags })
    .from(entities)
    .where(eq(entities.userId, userId));

  const hasSmartViews = existingTags.some(
    (e) => Array.isArray(e.tags) && e.tags.includes('smart-view'),
  );

  if (hasSmartViews) return [];

  const now = new Date();
  const pinnedEntities: Array<{ id: string; order: number }> = [];

  for (let i = 0; i < SMART_VIEWS.length; i++) {
    const sv = SMART_VIEWS[i];
    const id = crypto.randomUUID();

    await db.insert(entities).values({
      id,
      userId,
      title: sv.title,
      emoji: sv.emoji,
      body: sv.body,
      bodyRefs: [],
      tags: sv.tags,
      meta: {},
      aspects: {},
      createdAt: now,
      updatedAt: now,
    });

    pinnedEntities.push({ id, order: i });
  }

  // Update user settings with pinned entities
  await db
    .update(userSettings)
    .set({ pinnedEntities, updatedAt: now })
    .where(eq(userSettings.userId, userId));

  return pinnedEntities;
}
