import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  date,
  index,
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

// Схема 11 таблиц по docs/prd/01-architecture.md §4: восемь исходных (§4.1–§4.8), две
// таблицы доступа внешних агентов (§4.13–§4.14, D34) — они дописаны в конец файла — и
// entity_versions (ADE-срез 1, С11) с закреплёнными версиями тела.
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
  /**
   * Структурная правда тела: `{ v, doc }` (см. @orbis/shared/doc). NULL означает «ещё не
   * сконвертировано» — тела, созданные до этой работы: сервер конвертирует их лениво при первом
   * чтении. `body` остаётся NOT NULL и служит проекцией И аварийным дублем (ProseMirror молча
   * выбрасывает незнакомые схеме узлы).
   */
  bodyDoc: jsonb('body_doc'),
  /**
   * ИСХОДНОЕ тело до разовой конверсии — страховка обратимости, а не рабочая колонка.
   *
   * Заполняется ТЕМ ЖЕ UPDATE, что и конверсия (`backfill-body-doc`), и только когда пусто;
   * ничем не читается в рантайме. Заведена потому, что класс тихой потери на первом разборе
   * ДОКАЗАН (рваная строка таблицы, картинка в ячейке, ссылка с пустым текстом — каждая
   * уничтожала авторский текст мимо всех счётчиков), а гарантии «канон не теряет ничего на
   * любом входе» быть не может: это доказательство корректности чужого парсера.
   *
   * Почему колонка, а не только дамп: из `pg_dump` всей схемы достать ОДНУ запись спустя месяц
   * можно лишь подняв его в отдельную базу, а владелец узнаёт о потере не в день переноса —
   * он открывает старую заметку через недели. Здесь же восстановление одной записи это один
   * UPDATE. Плюс дамп — месяцы хранения полной копии личных заметок в открытом виде, то есть
   * решение про приватность; колонка живёт под той же RLS, что и сама запись.
   *
   * ВОССТАНОВЛЕНИЕ одной записи (запускать локально, тело в транскрипт не выносить):
   *
   *   -- посмотреть расхождение
   *   SELECT body, body_before_doc FROM entities WHERE id = '<id>';
   *   -- вернуть исходное тело; body_doc пересоберётся лениво при первом чтении
   *   UPDATE entities SET body = body_before_doc, body_doc = NULL
   *   WHERE id = '<id>' AND body_before_doc IS NOT NULL;
   *
   * СНИМАТЬ КОЛОНКУ МОЖНО И НУЖНО — миграцией `0012_drop_body_before_doc.sql`, которая лежит
   * рядом ГОТОВОЙ, но НЕ зарегистрирована в `meta/_journal.json`. Это не забывчивость: снятие
   * решает владелец, когда перенос признан удачным, — до тех пор текст, который человек из
   * заметки УДАЛИЛ, продолжает лежать в базе, и это осознанный размен «обратимость против
   * права быть забытым». Чтобы снять: дописать запись в журнал и накатить.
   */
  bodyBeforeDoc: text('body_before_doc'),
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
  // precision 3 — обязательна для составного курсора пагинации (routers/chat.ts):
  // now() пишет микросекунды, а wire отдаёт ISO с миллисекундами (JS Date). Сравнение
  // eq(created_at, <мс>) не совпадало никогда, и сообщения одной миллисекунды —
  // ровно тот случай, ради которого курсор вводили, — пропадали на границе страниц.
  createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
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

// entity_versions (§2.2, ADE-срез 1, С11) — закреплённые версии тела: снимок текста с
// подписью, который делает ЧЕЛОВЕК. Не история правок (её ведёт редактор), а те точки,
// к которым он решил иметь возможность вернуться. Владение прямое, по owner_id, — как у
// entity_origins: снимок принадлежит владельцу сущности и живёт под той же RLS.
export const entityVersions = pgTable(
  'entity_versions',
  {
    id: uuid('id').primaryKey(), // UUIDv7, генерирует сервер (newId)
    ownerId: uuid('owner_id').notNull(),
    // cascade: версия — снимок ТЕЛА конкретной сущности, без неё она ничего не значит.
    // Держать снимки удалённой записи значит хранить текст, который человек уже стёр.
    entityId: uuid('entity_id')
      .notNull()
      .references(() => entities.id, { onDelete: 'cascade' }),
    label: text('label').notNull(), // подпись версии — своими словами, её пишет человек
    // markdown-проекция на момент снимка — ВСЕГДА. Она читаема без ProseMirror и переживает
    // смену схемы документа, поэтому NOT NULL здесь именно она, а не body_doc.
    body: text('body').notNull(),
    // документ, если у сущности он на момент снимка уже был; NULL — тело ещё не бэкфиллено
    bodyDoc: jsonb('body_doc'),
    actorUserId: uuid('actor_user_id').notNull(),
    actorKind: text('actor_kind').notNull(), // owner | agent (агент — со среза 4)
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  // выдача версий одной сущности всегда «свежие сверху»: индекс покрывает и фильтр, и порядок
  (t) => [index('entity_versions_entity_created').on(t.entityId, t.createdAt.desc())],
);

// §9.3 (D34): регистрации внешних агентов (DCR) и выданные им доступы.
// Девятая и десятая таблицы — PRD §4 расширен решением D34.
export const oauthClients = pgTable('oauth_clients', {
  clientId: text('client_id').primaryKey(),
  clientName: text('client_name').notNull(),
  redirectUris: text('redirect_uris').array().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// Одна строка — весь жизненный цикл доступа: выданный код, текущий access и refresh.
// Код и токены хранятся ТОЛЬКО хешем (sha256 hex) — контракт hash-only §9.3.
export const agentGrants = pgTable(
  'agent_grants',
  {
    id: uuid('id').primaryKey(),
    ownerId: uuid('owner_id').notNull(),
    // NULL у PAT: у headless-доступа нет зарегистрированного клиента
    clientId: text('client_id').references(() => oauthClients.clientId, { onDelete: 'cascade' }),
    kind: text('kind').notNull(), // oauth | pat
    label: text('label').notNull(),
    scope: text('scope').notNull().default('full'), // Р6: значение пока одно
    codeHash: text('code_hash'),
    codeChallenge: text('code_challenge'),
    codeExpiresAt: timestamp('code_expires_at', { withTimezone: true }),
    codeUsedAt: timestamp('code_used_at', { withTimezone: true }),
    redirectUri: text('redirect_uri'),
    accessHash: text('access_hash'),
    // NULL у PAT: заголовочный доступ не истекает, отзывается строкой
    accessExpiresAt: timestamp('access_expires_at', { withTimezone: true }),
    refreshHash: text('refresh_hash'),
    // След предыдущего refresh: ротация затирает refresh_hash, и без этой колонки
    // предъявленный повторно старый токен не с чем связать — детект реплея (§7.5)
    // становится невозможен. Уникальности НЕ вешаем: после отзыва значения повторяются,
    // а защищать здесь уникальностью нечего.
    prevRefreshHash: text('prev_refresh_hash'),
    refreshExpiresAt: timestamp('refresh_expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('agent_grants_access_hash').on(t.accessHash),
    uniqueIndex('agent_grants_refresh_hash').on(t.refreshHash),
    uniqueIndex('agent_grants_code_hash').on(t.codeHash),
    index('agent_grants_owner').on(t.ownerId),
    check('agent_grants_kind', sql`${t.kind} IN ('oauth','pat')`),
  ],
);
