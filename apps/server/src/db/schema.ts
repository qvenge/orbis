import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  date,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

// Схема-скелет 8 таблиц по docs/prd/01-architecture.md §4.1–§4.8.
// RLS-политики и сид аспектов — Слайс 1; здесь только структура, defaults, индексы, FK.
// owner_id логически ссылается на auth.users (Supabase); FK на auth-схему не объявляем —
// она управляется Supabase, а не нашими миграциями.

// §4.1 entities
export const entities = pgTable('entities', {
  id: uuid('id').primaryKey(), // UUIDv7, генерируется клиентом
  ownerId: uuid('owner_id').notNull(),
  title: text('title').notNull(),
  emoji: text('emoji'),
  body: text('body').notNull().default(''),
  bodyRefs: text('body_refs').array().notNull().default(sql`'{}'`),
  tags: text('tags').array().notNull().default(sql`'{}'`),
  meta: jsonb('meta').notNull().default({}),
  aspects: jsonb('aspects').notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  archived: boolean('archived').notNull().default(false),
});

// §4.2 relations
export const relations = pgTable(
  'relations',
  {
    id: uuid('id').primaryKey(), // генерируется клиентом
    sourceId: uuid('source_id')
      .notNull()
      .references(() => entities.id, { onDelete: 'cascade' }),
    targetId: uuid('target_id')
      .notNull()
      .references(() => entities.id, { onDelete: 'cascade' }),
    relationType: text('relation_type').notNull(), // parent | blocks | related_to | derived_from
    meta: jsonb('meta').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('rel_uniq').on(t.sourceId, t.targetId, t.relationType),
    check('rel_no_self', sql`${t.sourceId} <> ${t.targetId}`),
  ],
);

// §4.3 aspect_definitions — без surrogate PK; уникальность — два partial unique index
export const aspectDefinitions = pgTable(
  'aspect_definitions',
  {
    id: text('id').notNull(), // namespaced: orbis/task, user/sleep
    ownerId: uuid('owner_id'), // NULL = встроенный аспект
    name: text('name').notNull(),
    namespace: text('namespace').notNull(),
    description: text('description'),
    icon: text('icon'),
    schema: jsonb('schema').notNull(),
    aiInstructions: text('ai_instructions'),
    tagMappings: text('tag_mappings').array().notNull().default(sql`'{}'`),
    aggregations: jsonb('aggregations').default({}),
    viewConfig: jsonb('view_config').default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('aspect_definitions_builtin_uniq').on(t.id).where(sql`${t.ownerId} IS NULL`),
    uniqueIndex('aspect_definitions_custom_uniq')
      .on(t.ownerId, t.id)
      .where(sql`${t.ownerId} IS NOT NULL`),
  ],
);

// §4.4 user_settings — имена столбцов настроек в camelCase (историческое соответствие коду)
export const userSettings = pgTable('user_settings', {
  ownerId: uuid('owner_id').primaryKey(),
  plan: text('plan').notNull().default('dev'),
  timezone: text('timezone').notNull().default('Europe/Moscow'),
  defaultCurrency: text('defaultCurrency').notNull().default('RUB'),
  weekStartDay: text('weekStartDay').notNull().default('monday'), // monday | sunday
  tagColors: jsonb('tagColors').notNull().default({}),
  installedViews: text('installedViews').array().notNull().default(sql`'{}'`),
  pinnedEntities: jsonb('pinnedEntities').notNull().default([]),
  viewPreferences: jsonb('viewPreferences').notNull().default({}),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// §4.5 chat_threads — NULL entity_id = глобальный тред; инвариант — два partial unique index
export const chatThreads = pgTable(
  'chat_threads',
  {
    id: uuid('id').primaryKey(), // детерминированный uuidv5, генерируется клиентом
    ownerId: uuid('owner_id').notNull(),
    entityId: uuid('entity_id').references(() => entities.id),
    title: text('title'),
    archived: boolean('archived').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('chat_threads_global_uniq').on(t.ownerId).where(sql`${t.entityId} IS NULL`),
    uniqueIndex('chat_threads_entity_uniq')
      .on(t.ownerId, t.entityId)
      .where(sql`${t.entityId} IS NOT NULL`),
  ],
);

// §4.6 chat_messages — append-only: без updated_at, metadata неизменяема
export const chatMessages = pgTable('chat_messages', {
  id: uuid('id').primaryKey(), // генерируется клиентом
  threadId: uuid('thread_id')
    .notNull()
    .references(() => chatThreads.id),
  role: text('role').notNull(), // user | assistant | system
  content: text('content').notNull(),
  metadata: jsonb('metadata').notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// §4.7 ai_usage — метеринг LLM per user/day/model; PK (owner_id, date, model)
export const aiUsage = pgTable(
  'ai_usage',
  {
    ownerId: uuid('owner_id').notNull(),
    date: date('date').notNull(), // календарный день в UTC
    model: text('model').notNull(),
    inputTokens: bigint('input_tokens', { mode: 'number' }).notNull().default(0),
    outputTokens: bigint('output_tokens', { mode: 'number' }).notNull().default(0),
    requestCount: integer('request_count').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.ownerId, t.date, t.model] })],
);

// §4.8 entity_origins — provenance импорта
export const entityOrigins = pgTable(
  'entity_origins',
  {
    id: uuid('id').primaryKey(),
    ownerId: uuid('owner_id').notNull(),
    entityId: uuid('entity_id')
      .notNull()
      .references(() => entities.id),
    namespace: text('namespace').notNull(), // например csv:<источник>
    externalId: text('external_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('entity_origins_uniq').on(t.ownerId, t.namespace, t.externalId)],
);
