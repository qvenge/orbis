// apps/server/src/wire.ts
// ЕДИНСТВЕННОЕ место преобразования Drizzle-строк в wire-формы (бриф Task 12):
// core-таймстампы наружу — всегда Date.toISOString() → UTC с суффиксом 'Z', не '+00:00'
// (решение 12 плана; zod .datetime() в shared-схемах офсет не принимает).
// БД хранит микросекунды, но драйвер парсит timestamptz в Date (мс), поэтому сравнение
// expectedUpdatedAt (клиент видел wire-форму) с row.updatedAt.toISOString() симметрично.
import type { GrantScope, PropertyDefinition } from '@orbis/shared';
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
import type { GrantSummary } from './oauth/grants';

type EntityRow = typeof entities.$inferSelect;
type RelationRow = typeof relations.$inferSelect;
type ChatMessageRow = typeof chatMessages.$inferSelect;
type ChatThreadRow = typeof chatThreads.$inferSelect;
type UserSettingsRow = typeof userSettings.$inferSelect;
type AspectDefinitionRow = typeof aspectDefinitions.$inferSelect;

/**
 * `includeBodyDoc` — явный opt-in (Р6): без него ключа `bodyDoc` в ответе НЕТ вовсе, а не
 * `null`. Документ весит столько же, сколько тело, и в списках сущностей он не нужен.
 */
export function toWireEntity(row: EntityRow, includeBodyDoc = false): WireEntity {
  return {
    id: row.id,
    ownerId: row.ownerId,
    title: row.title,
    emoji: row.emoji,
    body: row.body,
    ...(includeBodyDoc ? { bodyDoc: (row.bodyDoc ?? null) as WireEntity['bodyDoc'] } : {}),
    bodyRefs: row.bodyRefs,
    tags: row.tags,
    meta: row.meta as Record<string, unknown>, // jsonb — как есть, не трогаем
    props: row.props as Record<string, unknown>,
    aspects: row.aspects,
    queryRefs: row.queryRefs,
    // Старая карта наружу под новым именем: имя `aspects` заняла новая правда (§А1-1).
    aspectsMap: row.aspectsLegacy as Record<string, Record<string, unknown>>,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    archived: row.archived,
  };
}

/**
 * Сущность в форме, которую видит МОДЕЛЬ (§А9-2, Р12 «key для машин»).
 *
 * Чем она отличается от `toWireEntity` и почему проекции ДВЕ, а не одна:
 *  - `props` адресованы **key** свойства, а не id. Модель обязана писать тем же именем,
 *    которым читала (`props` тулов, `unset`, `entity_query`), а id ПОЛЬЗОВАТЕЛЬСКОГО
 *    свойства — uuid, и до модели он доезжать не должен;
 *  - `meta` нет вовсе: мешок снят (§А1-3), и печатать пустой объект значило бы обещать
 *    модели место, куда можно писать мимо реестра;
 *  - старой карты аспектов (`aspectsMap`) нет: аспект перестал быть владельцем полей (Р5),
 *    и вторая, вложенная копия тех же значений учила бы модель адресовать поле парой
 *    «аспект + имя» — формой, которой в реестре свойств нет;
 *  - `ownerId` и `queryRefs` не едут: первое модель знает по построению (это владелец
 *    вызова), второе — служебный индекс ссылок тела, читателя у него в чате нет.
 *
 * Внутренний wire (`toWireEntity`) остаётся по id и с картой: web строит формы и контролы
 * по реестру и адресует значения id (§А9-2, асимметрия названа спекой).
 *
 * Свойство, которого нет в снимке, печатается ПОД СВОИМ id: значение существует, и молча
 * потерять его хуже, чем показать машинным адресом. Такое бывает ровно у следа переезда —
 * строка реестра снята, значения на сущностях остались (§А10-3).
 */
export interface LlmEntity {
  id: string;
  title: string;
  emoji: string | null;
  body: string | null;
  bodyRefs: string[];
  tags: string[];
  props: Record<string, unknown>;
  aspects: string[];
  createdAt: string;
  updatedAt: string;
  archived: boolean;
}

export function toLlmEntity(
  row: WireEntity,
  reg: { properties: Map<string, PropertyDefinition> },
): LlmEntity {
  const props: Record<string, unknown> = {};
  for (const [propertyId, value] of Object.entries(row.props)) {
    props[reg.properties.get(propertyId)?.key ?? propertyId] = value;
  }
  return {
    id: row.id,
    title: row.title,
    emoji: row.emoji,
    body: row.body,
    bodyRefs: row.bodyRefs,
    tags: row.tags,
    props,
    aspects: row.aspects,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
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
 *
 * Документ здесь НЕ отдаётся намеренно: это путь списков (entity.query, backlinks), где
 * body_doc не нужен ни одному потребителю, а вес ответа удвоился бы. Компилятор запроса его
 * и не выбирает (SELECT перечисляет колонки явно).
 */
export function toWireEntityFromSql(row: Record<string, unknown>): WireEntity {
  return {
    ...toWireEntity({
      id: row.id,
      ownerId: row.owner_id,
      title: row.title,
      emoji: row.emoji,
      body: row.body,
      bodyRefs: row.body_refs,
      tags: row.tags,
      meta: row.meta,
      // Новая правда (§А1-1) и старая карта — обе из выдачи и обе под своими именами:
      // алиас `aspects_legacy AS aspects` снят вместе с появлением писателя `props`
      // (см. ENTITY_COLUMNS). Пока колонок здесь не было, списочные пути отдавали пустую
      // новую форму при том, что одиночное чтение отдавало правду, — и ни один тест этого
      // не пиннил.
      props: row.props,
      aspects: row.aspects,
      queryRefs: row.query_refs,
      aspectsLegacy: row.aspects_legacy,
      createdAt: toDate(row.created_at),
      updatedAt: toDate(row.updated_at),
      archived: row.archived,
    } as EntityRow),
  };
}

export function toWireRelation(row: RelationRow): WireRelation {
  return {
    id: row.id,
    sourceId: row.sourceId,
    targetId: row.targetId,
    role: row.role,
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

/**
 * Версия реестра в wire-форме — `<системная>.<владельца>` (§А10-1).
 *
 * Строка, а не пара чисел, потому что клиент делает с ней ровно одно: сравнивает с
 * предыдущей и, если не совпало, перечитывает реестр (ключ кеша `['registry', version]`,
 * §А9-2). Пара чисел заставила бы каждого читателя писать своё сравнение, а число одно —
 * склеить две независимые последовательности в одну не даёт ничего: сид двигает системную
 * половину, операции реестра владельца — его собственную, и обе растут порознь.
 *
 * Дом здесь, а не в роутере: версию отдают ДВА ответа — `registry.effective` (вместе со
 * словарями) и `entity.get` (без них, §А9-2), — и второй формат склейки развёл бы один и
 * тот же снимок на две разные строки, то есть заставил бы клиент перечитывать реестр на
 * каждом открытии записи.
 */
export function registryVersionOf(v: { systemVersion: number; ownerVersion: number }): string {
  return `${v.systemVersion}.${v.ownerVersion}`;
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

/**
 * Wire-форма выданного доступа (§9.3) для экрана «Агенты». Таймстампы — ISO-строками, как
 * у всех остальных wire-форм (соглашение файла): по HTTP `Date` всё равно уезжает строкой
 * (проверено пробой — `createdAt` доезжает как "2026-08-11T13:56:47.228Z"), и объявленная
 * форма говорит это прямо.
 *
 * Прежнее обоснование в этом докблоке было НЕВЕРНО (найдено ревью Task 7): якобы отдача
 * доменного `GrantSummary` обещала бы клиенту тип `Date` при строке в рантайме и роняла
 * бы экран TypeError. На деле в tRPC 11 `inferRouterOutputs` без transformer'а прогоняет
 * вывод через `Serialize<>`, а тот сам сводит `{ toJSON(): U }` к `U` — ревьюер проверил
 * компилятором: присваивание в `Date` даёт TS2322, в `string` — молчание. Ни падения, ни
 * ошибки компиляции не было бы.
 *
 * Выбор остаётся прежним по другой причине: явная форма не зависит от того, как транспорт
 * выводит типы, переживёт появление transformer'а и не заставляет читателя держать в
 * голове поведение `Serialize<>`.
 */
export interface WireAgentGrant {
  id: string;
  kind: string;
  label: string;
  /** Агент забрал токены; false — согласие есть, обмена кода не было (см. GrantSummary). */
  connected: boolean;
  /** Область доступа (С2): по ней экран «Агенты» подписывает строку. */
  scope: GrantScope;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export function toWireAgentGrant(row: GrantSummary): WireAgentGrant {
  return {
    id: row.id,
    kind: row.kind,
    label: row.label,
    connected: row.connected,
    scope: row.scope,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
  };
}

/**
 * Wire-форма aspect_definitions НОВОЙ формы (§А3-1): owner_id NULL = встроенный аспект.
 *
 * Что ушло и куда: `name` → `label` (per-locale), `description` стал per-locale, `icon` →
 * `viewConfig.icon`, `namespace` — вычислимая часть `key` и отдельным полем не нужна.
 * `properties` — ссылки на свойства реестра (`[{propertyId, required, rank}]`).
 *
 * `schema` ОСТАЁТСЯ (Р-24): по ней web строит каталог полей query-грамматики
 * (`query-blocks/catalog.ts`), а сервер — вход `attach_*`-тула. Она станет производной от
 * реестра свойств миграцией 0017; до тех пор это единственный носитель формы значений, и
 * снимать её из wire раньше значило бы ослепить web на весь срез.
 */
export interface WireAspectDefinition {
  id: string;
  ownerId: string | null;
  key: string;
  label: Record<string, string>;
  description: Record<string, string>;
  properties: { propertyId: string; required: boolean; rank: number }[];
  /** NULL у строки реестра, заведённой уже по-новому (колонка старой формы, Р-24). */
  schema: Record<string, unknown> | null;
  aiInstructions: string | null;
  tagMappings: string[];
  aggregations: Record<string, unknown> | null;
  viewConfig: Record<string, unknown> | null;
  module: string | null;
  service: boolean;
  rank: number;
  createdAt: string;
}

export function toWireAspectDefinition(row: AspectDefinitionRow): WireAspectDefinition {
  return {
    id: row.id,
    ownerId: row.ownerId,
    key: row.key,
    label: row.label as Record<string, string>,
    description: row.description as Record<string, string>,
    properties: row.properties as WireAspectDefinition['properties'],
    schema: row.schema as Record<string, unknown> | null,
    aiInstructions: row.aiInstructions,
    tagMappings: row.tagMappings,
    aggregations: row.aggregations as Record<string, unknown> | null,
    viewConfig: row.viewConfig as Record<string, unknown> | null,
    module: row.module,
    service: row.service,
    rank: row.rank,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Одно расхождение предпроверки отката прогона (С12): «эту сущность после прогона тронуло
 * вот это действие». Пары {сущность, действие} хватает экрану, чтобы человек понял, что
 * именно он потеряет, — поэтому здесь id, а не заголовки: тянуть их значило бы читать
 * граф ради ветки, которая обычно пуста.
 */
export interface RollbackConflict {
  entityId: string;
  actionId: string;
  /** Когда действие легло в журнал (ISO, как все таймстампы wire-форм). */
  at: string;
  /** Источник действия (§7.8): по нему экран отличает правку человека от чужого агента. */
  source: string;
}

/**
 * Ответ `agentRun.rollback` (С12). Живёт здесь, а не в `executor/types.ts`, по тому же
 * основанию, что `WireAgentGrant`: это форма tRPC-ОТВЕТА, собранная сервером, а не
 * результат операции executor'а — тот отдаёт ExecuteResult, и откат прогона к нему не
 * сводится (он серия отмен с собственной предпроверкой).
 *
 * Три исхода, а не «ok + error», потому что два отказа читаются человеком по-разному:
 * `conflict` — «не откатили НИЧЕГО, вот что помешало» (инвариант 7), `partial` — «часть
 * уже откачена, вот на чём встали». Смешать их в один код значило бы заставить экран
 * гадать, в каком состоянии граф.
 */
export type WireRollbackResult =
  | { ok: true; undone: string[]; note: string }
  | { ok: false; reason: 'conflict'; conflicts: RollbackConflict[] }
  | {
      ok: false;
      reason: 'partial';
      undone: string[];
      failed: { actionId: string; error: { code: string; message: string } };
    };
