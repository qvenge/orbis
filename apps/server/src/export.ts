// apps/server/src/export.ts
// Экспорт всего графа владельца (01-architecture §9.4, §С5, D8): JSON-дамп одной кнопкой из
// настроек (02 §1.6). Все чтения — одним withIdentity-tx: RLS сама ограничивает выборку
// владельцем (§4.10), поэтому явных owner-фильтров на entities/relations/chat_* нет.
// Реестры — ИСКЛЮЧЕНИЕ: экспортируются ТОЛЬКО строки владельца (owner_id = актор);
// встроенные (owner_id IS NULL) в дамп не входят (§С5: это не пользовательские данные) —
// их восстанавливает сид реестра.
import type { AspectDefinition, PropertyDefinition, RelationRoleDefinition } from '@orbis/shared';
import { asc, eq } from 'drizzle-orm';
import type { WireChatMessage } from './chat/messages';
import { chatMessages, chatThreads, entities, relations, userSettings } from './db/schema';
import type { Tx } from './db/with-identity';
import type { WireEntity, WireRelation } from './executor/types';
import { effectiveRegistry } from './registry/cache';
import {
  toWireChatMessage,
  toWireEntity,
  toWireRelation,
  toWireThread,
  toWireUserSettings,
  type WireThread,
  type WireUserSettings,
} from './wire';

/**
 * Форма дампа §9.4/§С5: стабильный конверт для импорта/переноса.
 *
 * ВЕРСИЯ 2 (Задача 13c). Что изменилось против первой и почему номер, а не молчаливое
 * расширение:
 *  - сущности едут НОВОЙ формой (§А1-1): `props` по id свойства и `aspects` списком.
 *    Старой карты `{аспект: {поле: значение}}` и мешка `meta` в них больше нет — дамп v1
 *    и дамп v2 описывают одну и ту же запись НЕСОВМЕСТИМЫМИ формами, и читатель обязан
 *    уметь их различить прежде, чем разбирать;
 *  - реестров стало три вместо одного: к аспектам добавились свойства и роли рёбер.
 *    Правило то же, что было у аспектов, — только строки владельца (§С5).
 *
 * Чего в v2 ещё НЕТ и где это появится: снимка соответствий `id ↔ key ↔ label` встроенных
 * определений (§С5, Р12) — он нужен ИМПОРТУ дампа в чужой мир, а импорта дампа в срезе А
 * нет вовсе; строк контрактов, привязок, подписок и действий — этих реестров в срезе А не
 * существует (§А12-1: таблицы созданы и пусты). И то, и другое — срез Б-3, и до него
 * снимок был бы полем, которое никто не заполняет и не читает.
 */
export interface OrbisExport {
  format: 'orbis-export';
  version: 2;
  exportedAt: string;
  entities: WireEntity[];
  relations: WireRelation[];
  chatThreads: WireThread[];
  chatMessages: WireChatMessage[];
  userSettings: WireUserSettings | null;
  /** Только строки владельца (owner_id = актор); форма — декларация реестра (§А2-1). */
  propertyDefinitions: PropertyDefinition[];
  aspectDefinitions: AspectDefinition[];
  relationRoleDefinitions: RelationRoleDefinition[];
}

/**
 * Строки реестра, принадлежащие ВЛАДЕЛЬЦУ, в порядке `rank`, при равенстве — id.
 *
 * Снимок берётся `effectiveRegistry`, а не своим SELECT'ом, и это не экономия строк: у перевода
 * строки таблицы в декларацию есть ровно одно место (`registry/load.ts`), и второе,
 * заведённое ради дампа, разъехалось бы с ним молча — дамп начал бы описывать реестр
 * формой, которой приложение не пользуется.
 *
 * Признак «своя» — `ownerId !== null`: встроенные строки приезжают тем же снимком (система
 * ⊕ владелец) и в дамп не входят (§С5).
 */
function ownRows<T extends { id: string; ownerId: string | null; rank: number }>(
  rows: ReadonlyMap<string, T>,
): T[] {
  return [...rows.values()]
    .filter((r) => r.ownerId !== null)
    .sort((a, b) => a.rank - b.rank || a.id.localeCompare(b.id));
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
  const registry = await effectiveRegistry(tx, ownerId);

  return {
    format: 'orbis-export',
    version: 2,
    exportedAt: clock().toISOString(),
    // Стрелкой, а не `.map(toWireEntity)`: вторым позиционным параметром туда поехал бы
    // ИНДЕКС массива, и выгрузка начала бы отдавать документ со второй сущности.
    entities: entityRows.map((row) => toWireEntity(row)),
    relations: relationRows.map(toWireRelation),
    chatThreads: threadRows.map(toWireThread),
    chatMessages: messageRows.map(toWireChatMessage),
    userSettings: settingsRows[0] ? toWireUserSettings(settingsRows[0]) : null,
    propertyDefinitions: ownRows(registry.properties),
    aspectDefinitions: ownRows(registry.aspects),
    relationRoleDefinitions: ownRows(registry.roles),
  };
}
