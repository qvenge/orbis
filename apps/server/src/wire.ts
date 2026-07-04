// apps/server/src/wire.ts
// ЕДИНСТВЕННОЕ место преобразования Drizzle-строк в wire-формы (бриф Task 12):
// core-таймстампы наружу — всегда Date.toISOString() → UTC с суффиксом 'Z', не '+00:00'
// (решение 12 плана; zod .datetime() в shared-схемах офсет не принимает).
// БД хранит микросекунды, но драйвер парсит timestamptz в Date (мс), поэтому сравнение
// expectedUpdatedAt (клиент видел wire-форму) с row.updatedAt.toISOString() симметрично.
import type { ChatRole, WireChatMessage } from './chat/messages';
import type {
  aspectDefinitions,
  chatMessages,
  chatThreads,
  entities,
  relations,
  userSettings,
} from './db/schema';
import type { WireEntity, WireRelation } from './executor/types';

type EntityRow = typeof entities.$inferSelect;
type RelationRow = typeof relations.$inferSelect;
type ChatMessageRow = typeof chatMessages.$inferSelect;
type ChatThreadRow = typeof chatThreads.$inferSelect;
type UserSettingsRow = typeof userSettings.$inferSelect;
type AspectDefinitionRow = typeof aspectDefinitions.$inferSelect;

export function toWireEntity(row: EntityRow): WireEntity {
  return {
    id: row.id,
    ownerId: row.ownerId,
    title: row.title,
    emoji: row.emoji,
    body: row.body,
    bodyRefs: row.bodyRefs,
    tags: row.tags,
    meta: row.meta as Record<string, unknown>, // jsonb — как есть, не трогаем
    aspects: row.aspects as Record<string, Record<string, unknown>>,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    archived: row.archived,
  };
}

/**
 * timestamptz raw-SQL выдачи: drizzle отключает date-парсеры postgres.js (конверсию
 * делает маппинг колонок), поэтому tx.execute отдаёт строку PG — приводим к Date тем же
 * способом, что drizzle для withTimezone-колонок (new Date(value)).
 */
function toDate(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value));
}

/**
 * Строка raw-SQL выдачи query-компилятора (§6): имена колонок snake_case. Маппинг
 * делегирует в toWireEntity — Date→ISO остаётся в одном месте.
 */
export function toWireEntityFromSql(row: Record<string, unknown>): WireEntity {
  return toWireEntity({
    id: row.id,
    ownerId: row.owner_id,
    title: row.title,
    emoji: row.emoji,
    body: row.body,
    bodyRefs: row.body_refs,
    tags: row.tags,
    meta: row.meta,
    aspects: row.aspects,
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
    archived: row.archived,
  } as EntityRow);
}

export function toWireRelation(row: RelationRow): WireRelation {
  return {
    id: row.id,
    sourceId: row.sourceId,
    targetId: row.targetId,
    relationType: row.relationType,
    meta: row.meta as Record<string, unknown>,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toWireChatMessage(row: ChatMessageRow): WireChatMessage {
  return {
    id: row.id,
    threadId: row.threadId,
    role: row.role as ChatRole, // колонка text; значения ограничены appendMessage
    content: row.content,
    metadata: row.metadata as Record<string, unknown>,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Wire-форма треда (§4.5): entityId NULL — глобальный тред владельца. */
export interface WireThread {
  id: string;
  ownerId: string;
  entityId: string | null;
  title: string | null;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}

export function toWireThread(row: ChatThreadRow): WireThread {
  return {
    id: row.id,
    ownerId: row.ownerId,
    entityId: row.entityId,
    title: row.title,
    archived: row.archived,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Один pinned-элемент сайдбара (§4.4): сущность + порядок. */
export interface PinnedEntity {
  id: string;
  order: number;
}

/** Wire-форма user_settings (§4.4): столбцы уже camelCase, updated_at → ISO. */
export interface WireUserSettings {
  ownerId: string;
  plan: string;
  timezone: string;
  defaultCurrency: string;
  weekStartDay: string;
  tagColors: Record<string, unknown>;
  installedViews: string[];
  pinnedEntities: PinnedEntity[];
  viewPreferences: Record<string, unknown>;
  updatedAt: string;
}

export function toWireUserSettings(row: UserSettingsRow): WireUserSettings {
  return {
    ownerId: row.ownerId,
    plan: row.plan,
    timezone: row.timezone,
    defaultCurrency: row.defaultCurrency,
    weekStartDay: row.weekStartDay,
    tagColors: row.tagColors as Record<string, unknown>,
    installedViews: row.installedViews,
    pinnedEntities: row.pinnedEntities as PinnedEntity[], // jsonb [{id, order}] — как есть
    viewPreferences: row.viewPreferences as Record<string, unknown>,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Wire-форма aspect_definitions (§4.3): owner_id NULL = встроенный аспект. */
export interface WireAspectDefinition {
  id: string;
  ownerId: string | null;
  name: string;
  namespace: string;
  description: string | null;
  icon: string | null;
  schema: Record<string, unknown>;
  aiInstructions: string | null;
  tagMappings: string[];
  aggregations: Record<string, unknown> | null;
  viewConfig: Record<string, unknown> | null;
  createdAt: string;
}

export function toWireAspectDefinition(row: AspectDefinitionRow): WireAspectDefinition {
  return {
    id: row.id,
    ownerId: row.ownerId,
    name: row.name,
    namespace: row.namespace,
    description: row.description,
    icon: row.icon,
    schema: row.schema as Record<string, unknown>,
    aiInstructions: row.aiInstructions,
    tagMappings: row.tagMappings,
    aggregations: row.aggregations as Record<string, unknown> | null,
    viewConfig: row.viewConfig as Record<string, unknown> | null,
    createdAt: row.createdAt.toISOString(),
  };
}
