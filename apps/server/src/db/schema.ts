import {
  pgTable,
  uuid,
  text,
  jsonb,
  timestamp,
  boolean,
  integer,
  unique,
  check,
  index,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

// ─── entities ───
export const entities = pgTable(
  'entities',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id').notNull(),
    title: text('title').notNull(),
    emoji: text('emoji'),
    body: text('body').notNull().default(''),
    bodyRefs: text('body_refs').array().notNull().default(sql`'{}'::text[]`),
    tags: text('tags').array().notNull().default(sql`'{}'::text[]`),
    meta: jsonb('meta').notNull().default({}),
    aspects: jsonb('aspects').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    syncedAt: timestamp('synced_at', { withTimezone: true }),
    archived: boolean('archived').notNull().default(false),
  },
  (table) => [
    index('idx_entities_user_updated').on(table.userId, table.updatedAt),
    index('idx_entities_tags').using('gin', table.tags),
    index('idx_entities_aspects').using('gin', table.aspects),
    index('idx_entities_meta').using('gin', table.meta),
    index('idx_entities_body_refs').using('gin', table.bodyRefs),
    index('idx_entities_archived').on(table.userId, table.archived),
  ],
);

// ─── relations ───
export const relations = pgTable(
  'relations',
  {
    id: uuid('id').primaryKey(),
    sourceId: uuid('source_id')
      .notNull()
      .references(() => entities.id, { onDelete: 'cascade' }),
    targetId: uuid('target_id')
      .notNull()
      .references(() => entities.id, { onDelete: 'cascade' }),
    relationType: text('relation_type').notNull(),
    meta: jsonb('meta').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('uq_relations').on(table.sourceId, table.targetId, table.relationType),
    check('no_self_relation', sql`${table.sourceId} != ${table.targetId}`),
    index('idx_relations_source').on(table.sourceId, table.relationType),
    index('idx_relations_target').on(table.targetId, table.relationType),
  ],
);

// ─── aspect_definitions ───
export const aspectDefinitions = pgTable('aspect_definitions', {
  id: text('id').primaryKey(),
  userId: uuid('user_id'),
  name: text('name').notNull(),
  namespace: text('namespace').notNull(),
  schema: jsonb('schema').notNull(),
  aiInstructions: text('ai_instructions'),
  tagMappings: text('tag_mappings').array().notNull().default(sql`'{}'::text[]`),
  aggregations: jsonb('aggregations').default({}),
  viewConfig: jsonb('view_config').default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// ─── user_settings ───
export const userSettings = pgTable('user_settings', {
  userId: uuid('user_id').primaryKey(),
  displayName: text('display_name'),
  timezone: text('timezone').notNull().default('Europe/Moscow'),
  defaultCurrency: text('default_currency').notNull().default('RUB'),
  weekStartDay: text('week_start_day').notNull().default('monday'),
  aspectStatuses: jsonb('aspect_statuses').notNull().default({}),
  tagColors: jsonb('tag_colors').notNull().default({}),
  installedViews: text('installed_views').array().notNull().default(sql`'{}'::text[]`),
  pinnedEntities: jsonb('pinned_entities').notNull().default(sql`'[]'::jsonb`),
  statusStripMetrics: jsonb('status_strip_metrics').default(sql`'[]'::jsonb`),
  viewPreferences: jsonb('view_preferences').notNull().default({}),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ─── sync_log ───
export const syncLog = pgTable('sync_log', {
  id: uuid('id').primaryKey(),
  userId: uuid('user_id').notNull(),
  deviceId: text('device_id').notNull(),
  lastSyncAt: timestamp('last_sync_at', { withTimezone: true }).notNull(),
  entityCount: integer('entity_count'),
  conflicts: jsonb('conflicts').default(sql`'[]'::jsonb`),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// ─── shared_packages ───
export const sharedPackages = pgTable('shared_packages', {
  id: text('id').primaryKey(),
  userId: uuid('user_id').notNull(),
  data: jsonb('data').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
});
