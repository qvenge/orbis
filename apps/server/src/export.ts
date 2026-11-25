// apps/server/src/export.ts
// Экспорт всего графа владельца (01-architecture §9.4, §С5, D8): JSON-дамп одной кнопкой из
// настроек (02 §1.6). Все чтения — одним withIdentity-tx: RLS сама ограничивает выборку
// владельцем (§4.10), поэтому явных owner-фильтров на entities/relations/chat_* нет.
// Реестры — ИСКЛЮЧЕНИЕ: экспортируются ТОЛЬКО строки владельца (graph_id = актор);
// встроенные (graph_id IS NULL) в дамп не входят (§С5: это не пользовательские данные) —
// их восстанавливает сид реестра.
import type {
  AspectDefinition,
  GraphId,
  PropertyDefinition,
  RelationRoleDefinition,
} from '@orbis/shared';
import { and, asc, eq } from 'drizzle-orm';
import type { WireChatMessage } from './chat/messages';
import {
  actionJournal,
  chatMessages,
  chatThreads,
  entities,
  relations,
  userSettings,
} from './db/schema';
import type { Tx } from './db/with-identity';
import { ExecError } from './errors';
import { exportJournal, type JournalEntry } from './executor/journal-read';
import type { WireEntity, WireRelation } from './executor/types';
import { fileProperties, filesOfBody } from './files/holds';
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
 * Запись журнала в дампе — строка журнала целиком (дамп владельца: операции и данные отмены — его данные), без
 * вычисляемого при чтении `touchedKeys`: дамп несёт то, что лежит, а не производное от него. Время — ISO-строкой,
 * как все таймстампы провода (решение 12 плана).
 */
export type ExportedJournalEntry = Omit<
  JournalEntry,
  'touchedKeys' | 'createdAt' | 'consequences'
> & {
  createdAt: string;
};

/**
 * Форма дампа §9.4/§С5: стабильный конверт для импорта/переноса.
 *
 * ВЕРСИЯ 3 (спека скорости §11, план А задача 5): журнал действий едет своим ключом `journal` — все записи графа
 * по времени, включая записи отмены. До v3 он лежал системными сообщениями внутри `chatMessages`; с таблицы журнала
 * сообщения его не несут, и читатель обязан различить, где искать журнал, — отсюда номер, а не молчаливое расширение.
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
 * нет вовсе; своих контрактов, подписок и действий и дельт всех родов (включая дельты правил) —
 * эти реестры с Б-1/Б-2 живут, но в дамп не попадают (правила СВОИХ определений едут в дамп полем `rules`
 * строки) (реестр остатков Б-2, строка 99: экспорт §С5 —
 * остаток бывшего Б-3, решением владельца). До того снимок был бы полем, которое никто не читает.
 */
export interface OrbisExport {
  format: 'orbis-export';
  version: 3;
  exportedAt: string;
  entities: Array<WireEntity & { body: string }>;
  relations: WireRelation[];
  chatThreads: WireThread[];
  chatMessages: WireChatMessage[];
  journal: ExportedJournalEntry[];
  userSettings: WireUserSettings | null;
  /** Только строки ТЕКУЩЕГО ГРАФА (`graph_id` — граф, не аккаунт); форма — декларация реестра (§А2-1). */
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
 * Признак «своя» — `graphId !== null`: встроенные строки приезжают тем же снимком (система
 * ⊕ владелец) и в дамп не входят (§С5).
 */
function ownRows<T extends { id: string; graphId: string | null; rank: number }>(
  rows: ReadonlyMap<string, T>,
): T[] {
  return [...rows.values()]
    .filter((r) => r.graphId !== null)
    .sort((a, b) => a.rank - b.rank || a.id.localeCompare(b.id));
}

export type OrbisExportV4 = Omit<OrbisExport, 'version' | 'journal'> & {
  version: 4;
  journal: Array<ExportedJournalEntry & { bodyFormatVersion?: 4 }>;
};

function record(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
}

// Application-owned envelopes can contain opaque user values (for example relation meta).
// A user's JSON key named bodyFormatVersion is data and must survive a v3 export verbatim.
const opaqueHistoryKeys = new Set([
  'props',
  'meta',
  'metadata',
  'viewPreferences',
  'label',
  'description',
  'action_params',
]);

function needsFileHistory(value: unknown, propertyNames: ReadonlySet<string>, format?: 4): boolean {
  if (Array.isArray(value))
    return value.some((entry) => needsFileHistory(entry, propertyNames, format));
  const row = record(value);
  if (!row) return false;
  if (
    row.op === 'file_field_edit' ||
    row.tool === 'file_field_edit' ||
    row.type === 'fileRef' ||
    record(row.type)?.kind === 'file' ||
    (typeof row.propertyId === 'string' && propertyNames.has(row.propertyId))
  )
    return true;
  const props = record(row.props);
  if (props && Object.keys(props).some((name) => propertyNames.has(name))) return true;
  if (
    Array.isArray(row.unset) &&
    row.unset.some((name) => typeof name === 'string' && propertyNames.has(name))
  )
    return true;
  if (
    (typeof row.op === 'string' && row.op.startsWith('attach_')) ||
    (typeof row.tool === 'string' && row.tool.startsWith('attach_'))
  ) {
    const attached = record(record(row.payload ?? row.input)?.data);
    if (attached && Object.keys(attached).some((name) => propertyNames.has(name))) return true;
  }
  const stamp = 'bodyFormatVersion' in row ? row.bodyFormatVersion : row.bodyFormat;
  const localFormat = stamp === undefined ? format : stamp === 4 ? 4 : undefined;
  if (filesOfBody({ body: row.body, bodyDoc: row.bodyDoc, bodyFormat: localFormat }).length)
    return true;
  return Object.entries(row).some(
    ([key, entry]) =>
      !opaqueHistoryKeys.has(key) && needsFileHistory(entry, propertyNames, localFormat),
  );
}

function legacyHistory<T>(value: T): T {
  if (Array.isArray(value)) return value.map(legacyHistory) as T;
  const row = record(value);
  if (!row) return value;
  // Journal payloads can include entity snapshots returned from a batch. Strip the body-only
  // stamp recursively so a representable export retains the shape understood by v3 readers.
  const body = typeof row.body === 'string' || 'bodyDoc' in row;
  const stampedEnvelope =
    body || Array.isArray(row.inverse) || typeof row.tool === 'string' || row.kind === 'question';
  return Object.fromEntries(
    Object.entries(row)
      .filter(
        ([key]) =>
          !((key === 'bodyFormatVersion' && stampedEnvelope) || (key === 'bodyFormat' && body)),
      )
      .map(([key, entry]) => {
        if (key === 'bodyDoc' && record(entry)?.v === 4) return [key, { ...record(entry), v: 3 }];
        return [key, opaqueHistoryKeys.has(key) ? entry : legacyHistory(entry)];
      }),
  ) as T;
}

export async function readGraphExport(
  tx: Tx,
  graphId: GraphId,
  clock: () => Date = () => new Date(),
) {
  const entityRows = await tx
    .select()
    .from(entities)
    .where(eq(entities.graphId, graphId))
    .orderBy(asc(entities.createdAt), asc(entities.id));
  const relationRows = await tx
    .select()
    .from(relations)
    .orderBy(asc(relations.createdAt), asc(relations.id));
  const threadRows = await tx
    .select()
    .from(chatThreads)
    .where(eq(chatThreads.graphId, graphId))
    .orderBy(asc(chatThreads.createdAt), asc(chatThreads.id));
  const messageRows = await tx
    .select()
    .from(chatMessages)
    .orderBy(asc(chatMessages.createdAt), asc(chatMessages.id));
  const settingsRows = await tx
    .select()
    .from(userSettings)
    .where(eq(userSettings.graphId, graphId));
  const registry = await effectiveRegistry(tx, graphId);
  const journalFileFormat = new Set(
    (
      await tx
        .select({ id: actionJournal.id })
        .from(actionJournal)
        .where(and(eq(actionJournal.graphId, graphId), eq(actionJournal.bodyFormat, 4)))
    ).map((row) => row.id),
  );
  const journal = (await exportJournal(tx, graphId)).map(
    ({
      touchedKeys: _derived,
      consequences: _internal,
      createdAt,
      ...entry
    }): OrbisExportV4['journal'][number] => ({
      ...entry,
      ...(journalFileFormat.has(entry.id) && { bodyFormatVersion: 4 }),
      createdAt: createdAt.toISOString(),
    }),
  );

  const graph: OrbisExportV4 = {
    format: 'orbis-export',
    version: 4,
    exportedAt: clock().toISOString(),
    // Стрелкой, а не `.map(toWireEntity)`: вторым позиционным параметром туда поехал бы
    // ИНДЕКС массива, и выгрузка начала бы отдавать документ со второй сущности.
    entities: entityRows.map((row) => toWireEntity(row)),
    relations: relationRows.map(toWireRelation),
    chatThreads: threadRows.map(toWireThread),
    chatMessages: messageRows.map(toWireChatMessage),
    journal,
    userSettings: settingsRows[0] ? toWireUserSettings(settingsRows[0]) : null,
    propertyDefinitions: ownRows(registry.properties),
    aspectDefinitions: ownRows(registry.aspects),
    relationRoleDefinitions: ownRows(registry.roles),
  };
  const filePropertyDefinitions = [...registry.properties.values()]
    .filter((definition) => definition.type.kind === 'file')
    .sort((a, b) => a.id.localeCompare(b.id));
  const propertyNames = new Set(filePropertyDefinitions.flatMap(({ id, key }) => [id, key]));
  const fileIds = new Set<string>();
  let hasFileValues = false;
  for (const row of entityRows) {
    for (const id of filesOfBody(row)) fileIds.add(id);
    for (const ids of fileProperties(registry, row.props).values()) {
      hasFileValues = true;
      for (const id of ids) fileIds.add(id);
    }
  }
  const requiresPackage = () =>
    fileIds.size > 0 ||
    hasFileValues ||
    graph.propertyDefinitions.some((definition) => definition.type.kind === 'file') ||
    graph.aspectDefinitions.some((aspect) =>
      aspect.properties.some(({ propertyId }) => propertyNames.has(propertyId)),
    ) ||
    graph.chatMessages.some(({ metadata }) => needsFileHistory(metadata.pending, propertyNames)) ||
    graph.journal.some(
      (entry) =>
        // A v4 action may capture an older document in its inverse or result. Each stored
        // snapshot owns its grammar. Undo's forward list replays precisely that inverse.
        needsFileHistory(
          entry.operations,
          propertyNames,
          entry.undoes ? undefined : entry.bodyFormatVersion,
        ) ||
        needsFileHistory(entry.inverse, propertyNames) ||
        needsFileHistory(entry.results, propertyNames),
    );
  return { graph, filePropertyDefinitions, fileIds: [...fileIds].sort(), requiresPackage };
}

export async function exportData(
  tx: Tx,
  graphId: GraphId,
  clock: () => Date = () => new Date(),
): Promise<OrbisExport> {
  const { graph, requiresPackage } = await readGraphExport(tx, graphId, clock);
  if (requiresPackage()) {
    throw new ExecError(
      'EXPORT_FORMAT_REQUIRED',
      'Для этого графа нужен полный пакет с вложениями.',
      {
        version: 4,
        packageVersion: 1,
      },
    );
  }
  return {
    ...graph,
    version: 3,
    entities: graph.entities.map(({ bodyFormatVersion: _format, ...entity }) => entity),
    chatMessages: graph.chatMessages.map((message) => {
      const { pending } = message.metadata;
      return pending
        ? { ...message, metadata: { ...message.metadata, pending: legacyHistory(pending) } }
        : message;
    }),
    journal: legacyHistory(graph.journal),
  };
}
