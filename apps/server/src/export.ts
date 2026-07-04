// apps/server/src/export.ts
// Экспорт всего графа владельца (01-architecture §9.4, D8): JSON-дамп одной кнопкой из
// настроек (02 §1.6). Все чтения — одним withIdentity-tx: RLS сама ограничивает выборку
// владельцем (§4.10), поэтому явных owner-фильтров на entities/relations/chat_* нет.
// aspect_definitions — ИСКЛЮЧЕНИЕ: экспортируются ТОЛЬКО кастомные (owner_id = актор);
// встроенные (owner_id IS NULL) в дамп не входят (§9.4) — их восстанавливает сид реестра.
import { asc, eq } from 'drizzle-orm';
import type { WireChatMessage } from './chat/messages';
import {
  aspectDefinitions,
  chatMessages,
  chatThreads,
  entities,
  relations,
  userSettings,
} from './db/schema';
import type { Tx } from './db/with-identity';
import type { WireEntity, WireRelation } from './executor/types';
import {
  toWireAspectDefinition,
  toWireChatMessage,
  toWireEntity,
  toWireRelation,
  toWireThread,
  toWireUserSettings,
  type WireAspectDefinition,
  type WireThread,
  type WireUserSettings,
} from './wire';

/** Форма дампа §9.4: стабильный конверт для импорта/переноса. */
export interface OrbisExport {
  format: 'orbis-export';
  version: 1;
  exportedAt: string;
  entities: WireEntity[];
  relations: WireRelation[];
  chatThreads: WireThread[];
  chatMessages: WireChatMessage[];
  userSettings: WireUserSettings | null;
  aspectDefinitions: WireAspectDefinition[]; // только кастомные (owner_id = актор)
}

export async function exportData(
  tx: Tx,
  ownerId: string,
  clock: () => Date = () => new Date(),
): Promise<OrbisExport> {
  const entityRows = await tx
    .select()
    .from(entities)
    .orderBy(asc(entities.createdAt), asc(entities.id));
  const relationRows = await tx
    .select()
    .from(relations)
    .orderBy(asc(relations.createdAt), asc(relations.id));
  const threadRows = await tx
    .select()
    .from(chatThreads)
    .orderBy(asc(chatThreads.createdAt), asc(chatThreads.id));
  const messageRows = await tx
    .select()
    .from(chatMessages)
    .orderBy(asc(chatMessages.createdAt), asc(chatMessages.id));
  const settingsRows = await tx
    .select()
    .from(userSettings)
    .where(eq(userSettings.ownerId, ownerId));
  // Только кастомные аспекты владельца: NULL-owner builtin отсеиваются равенством (§9.4)
  const aspectRows = await tx
    .select()
    .from(aspectDefinitions)
    .where(eq(aspectDefinitions.ownerId, ownerId))
    .orderBy(asc(aspectDefinitions.id));

  return {
    format: 'orbis-export',
    version: 1,
    exportedAt: clock().toISOString(),
    entities: entityRows.map(toWireEntity),
    relations: relationRows.map(toWireRelation),
    chatThreads: threadRows.map(toWireThread),
    chatMessages: messageRows.map(toWireChatMessage),
    userSettings: settingsRows[0] ? toWireUserSettings(settingsRows[0]) : null,
    aspectDefinitions: aspectRows.map(toWireAspectDefinition),
  };
}
