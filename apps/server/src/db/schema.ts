import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  real,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

// Схема 24 таблиц: одиннадцать исходных (docs/prd/01-architecture.md §4 — восемь §4.1–§4.8,
// две таблицы доступа внешних агентов §4.13–§4.14 D34 в конце файла, entity_versions
// ADE-среза 1), восемь таблиц реформы свойств (§С6 спеки «Реформа свойств»): пять реестров,
// таблица дельт, однострочная таблица версии system-реестра и кэш `spent` конверта (§Б5-5),
// две таблицы среза «Г — единица владения» (D44): `graphs` и `graph_members` в самом конце файла, —
// полевые замеры `perf_samples` (спека скорости §3.2) сразу за `user_settings`: не граф, ключ — аккаунт, —
// и журнал действий `action_journal` с боковой `action_journal_entities` (спека скорости §11.2) за `chat_messages`.
// RLS-политики и сид аспектов — Слайс 1; здесь только структура, defaults, индексы, FK.
// graph_id — ключ владения и изоляции (D44): строка принадлежит ГРАФУ. У личного графа id равен id
// аккаунта Supabase по построению (CHECK таблицы graphs, срез Г-2). FK на auth-схему не объявляем —
// она управляется Supabase, а не нашими миграциями; FK на graphs.id стоит с миграции 0020.

// §4.1 entities
export const entities = pgTable('entities', {
  id: uuid('id').primaryKey(), // UUIDv7, генерируется клиентом
  graphId: uuid('graph_id')
    .notNull()
    .references(() => graphs.id, { onDelete: 'no action' }),
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
   * Страховка разовой конверсии тел (перенос выполнен 02.09.2026, скрипт снят планом А скорости, РП-23).
   * Рантайм её не читает; снятие — 0012_drop_body_before_doc.sql по слову владельца (остаток).
   */
  bodyBeforeDoc: text('body_before_doc'),
  tags: text('tags').array().notNull().default(sql`'{}'`),
  /**
   * НОВАЯ правда значений (§А1-1): плоская карта `{id свойства: значение}` — один
   * идентификатор на свойство независимо от того, сколько аспектов его носят (§А8/В1
   * слили `orbis/finance_category`, `orbis/currency`, `orbis/grant`).
   */
  props: jsonb('props').notNull().default({}),
  /** НОВАЯ правда интерпретаций: список id аспектов, а не карта (§А1-1, Р5). */
  aspects: text('aspects').array().notNull().default(sql`'{}'`),
  /**
   * Кого АДРЕСУЮТ query-блоки тела этой строки (§А11-1): id свойств, аспектов, ролей и
   * сущностей, названные деревьями блоков. Обратный индекс, по которому операции реестра
   * находят тела, ссылающиеся на свойство, не обходя корпус (`registry/ops.ts`).
   *
   * Пишется РЯДОМ С `body_refs` во всех пяти точках записи тела (`executor/executor.ts`) —
   * колонка денормализована, и любой писатель тела мимо executor'а оставит её устаревшей.
   *
   * Собирается ТОЛЬКО с дерева (`queryRefsFromDoc`): у неразобранного блока дерева нет, а его
   * текст имён реестра не содержит по построению.
   */
  queryRefs: text('query_refs').array().notNull().default(sql`'{}'`),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  archived: boolean('archived').notNull().default(false),
  /**
   * Ревизия тела, «действие текущего тела» и время изменения тела (спека скорости §8.1, 0026). Пишет их ТОЛЬКО
   * триггер `entities_body_stamp` — при создании и при каждой смене `body`/`body_doc` (`IS DISTINCT FROM`), у любого
   * писателя, включая сырой SQL слияния свойства: писателей тела не меньше шести, и забытый писатель молча ломал бы
   * замок текста и цепочку отмены. Код колонки не пишет (кроме засева прод-операцией переноса журнала, РП-2).
   *
   * `body_action_id` — id записи журнала, чьё действие поставило текущее тело (или записи отмены); берётся из настройки
   * транзакции `orbis.body_action`, которую executor объявляет один раз на свою транзакцию. Пусто — писатель вне
   * executor'а (ops-скрипт) или транзакция без журнала (сев). Внешнего ключа на журнал нет (К-34): строка журнала
   * пишется ПОСЛЕ правки той же транзакцией.
   */
  bodyRevision: integer('body_revision').notNull().default(1),
  bodyActionId: uuid('body_action_id'),
  bodyChangedAt: timestamp('body_changed_at', { withTimezone: true, precision: 3 })
    .notNull()
    .defaultNow(),
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
    /**
     * Роль ребра (§А4-3) — ЕДИНСТВЕННАЯ его правда: id строки реестра
     * `relation_role_definitions`. Пять сегодняшних смыслов `parent` («часть внутри
     * целого», «тикет проекта», «прогон», «транзакция в конверте», «дерево категорий»)
     * различаются здесь поимённо, а не догадкой по аспектам концов.
     */
    role: text('role').notNull(),
    /**
     * Мешок ребра. У СУЩНОСТИ такой колонки нет (§А1-3 снял её вместе с write-only мешком),
     * а у связи он живой и адресуемый: зеркало ссылочного свойства подписывает себя
     * `meta->>'property'` (§А6-2), и по этой подписи идут и починка зеркал, и обратный
     * обход импорта.
     */
    meta: jsonb('meta').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Уникальность — по РОЛИ (contract-миграция 0017). До неё третьей колонкой ключа стояла
    // производная `relation_type`, и две роли с одной проекцией (`subitem`+`ticket`,
    // `subitem`+`envelope-binding`) на одной паре сущностей были невыразимы.
    unique('rel_uniq').on(t.sourceId, t.targetId, t.role),
    check('rel_no_self', sql`${t.sourceId} <> ${t.targetId}`),
  ],
);

// §4.3 aspect_definitions — новая форма §А3-1: аспект есть ИНТЕРПРЕТАЦИЯ, а не владелец
// полей (Р5). Поля переехали в property_definitions, здесь остались ссылки на них
// (`properties`) с обязательностью и порядком. Без surrogate PK; уникальность — два
// partial unique index, как было.
export const aspectDefinitions = pgTable(
  'aspect_definitions',
  {
    id: text('id').notNull(), // namespaced: orbis/task, user/sleep
    graphId: uuid('graph_id').references(() => graphs.id, { onDelete: 'no action' }), // NULL = встроенный аспект
    // Машинная ручка §А2-3: из неё собирается имя тула attach_* (§А9-1). У встроенных = id.
    key: text('key').notNull(),
    label: jsonb('label').notNull(), // per-locale {ru, en} — подпись для человека
    // per-locale; ОБЯЗАТЕЛЕН (Р4): единственный носитель смысла для AI.
    description: jsonb('description').notNull(),
    // [{propertyId, required, rank}] — форма `aspectPropertyRefSchema` из @orbis/shared
    // ДОСЛОВНО (camelCase внутри jsonb): у этого значения одна строгая zod-схема на сид,
    // загрузчик и web, и второе именование потребовало бы двух конвертеров.
    properties: jsonb('properties').notNull().default([]),
    // §Б2 (bind + value_map) — часть Б; в срезе А пустует, но колонка заведена сразу:
    // форма строки реестра не должна меняться миграцией между срезами.
    implements: jsonb('implements').notNull().default([]),
    aiInstructions: text('ai_instructions'),
    tagMappings: text('tag_mappings').array().notNull().default(sql`'{}'`),
    aggregations: jsonb('aggregations').default({}),
    viewConfig: jsonb('view_config').default({}),
    // §Б4-1: правила каталога — jsonb СТРОКИ-НОСИТЕЛЯ, не таблица (правило умирает с владельцем).
    // NOT NULL DEFAULT '[]': строки, посеянные до 0022, читаются пустым списком, а не NULL'ом.
    rules: jsonb('rules').notNull().default([]),
    module: text('module'), // модуль-владелец; NULL = ядро (§А2-1, №14/№15)
    // §А3-1/Р-П-5: служебность — колонка реестра, а не список в коде (сегодня их три копии).
    service: boolean('service').notNull().default(false),
    rank: integer('rank').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('aspect_definitions_builtin_uniq').on(t.id).where(sql`${t.graphId} IS NULL`),
    uniqueIndex('aspect_definitions_custom_uniq')
      .on(t.graphId, t.id)
      .where(sql`${t.graphId} IS NOT NULL`),
  ],
);

// §4.4 user_settings — имена столбцов настроек в camelCase (историческое соответствие коду)
export const userSettings = pgTable('user_settings', {
  graphId: uuid('graph_id')
    .primaryKey()
    .references(() => graphs.id, { onDelete: 'no action' }),
  plan: text('plan').notNull().default('dev'),
  timezone: text('timezone').notNull().default('Europe/Moscow'),
  defaultCurrency: text('defaultCurrency').notNull().default('RUB'),
  weekStartDay: text('weekStartDay').notNull().default('monday'), // monday | sunday
  tagColors: jsonb('tagColors').notNull().default({}),
  installedViews: text('installedViews').array().notNull().default(sql`'{}'`),
  pinnedEntities: jsonb('pinnedEntities').notNull().default([]),
  viewPreferences: jsonb('viewPreferences').notNull().default({}),
  /**
   * Версия реестров ВЛАДЕЛЬЦА (§А10-1, Б7): инкремент в той же транзакции, что любая его
   * мутация реестра; ключ процессного кеша эффективных определений — `(owner, version)`.
   * Имя колонки — snake_case ЯВНО (РП-16), вопреки camelCase соседей: те написаны так по
   * историческому совпадению с кодом (см. комментарий таблицы), и продлевать эту случайность
   * на новую колонку незачем.
   */
  registryVersion: integer('registry_version').notNull().default(0),
  /**
   * §Б8-1 (ревизия 3, Р13): модули, ВЫКЛЮЧЕННЫЕ владельцем. Список выключенных, а не
   * включённых, намеренно: модуль, появившийся после этой строки, обязан быть включён у
   * всех и без миграции данных, а список включённых пришлось бы досевать каждому владельцу.
   * Колонка приезжает ЗДЕСЬ, а читателя ей даёт задача 17: миграция на срез одна (Р-И-23).
   */
  disabledModules: text('disabled_modules').array().notNull().default(sql`'{}'`),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Полевые замеры (спека скорости §3.2): НЕ граф и НЕ журнал — содержимого нет (ни текстов, ни заголовков, ни id записей).
 * Ключ владения — АККАУНТ (`auth.uid()`), не граф: замер — про устройство и сеть человека, а не про данные графа.
 * Хранение 30 дней — задача `pg_cron` в самой базе (0024).
 */
export const perfSamples = pgTable(
  'perf_samples',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    accountId: uuid('account_id').notNull().default(sql`auth.uid()`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    metric: text('metric').notNull(),
    screen: text('screen'),
    kind: text('kind'),
    procedure: text('procedure'),
    durMs: real('dur_ms').notNull(),
    serverMs: real('server_ms'),
    dbMs: real('db_ms'),
    device: text('device').notNull(),
    net: text('net'),
    appVersion: text('app_version').notNull(),
    cached: boolean('cached'),
  },
  (t) => [index('perf_samples_account_created').on(t.accountId, t.createdAt)],
);

// §4.5 chat_threads — NULL entity_id = глобальный тред; инвариант — два partial unique index
export const chatThreads = pgTable(
  'chat_threads',
  {
    id: uuid('id').primaryKey(), // детерминированный uuidv5, генерируется клиентом
    graphId: uuid('graph_id')
      .notNull()
      .references(() => graphs.id, { onDelete: 'no action' }),
    entityId: uuid('entity_id').references(() => entities.id),
    title: text('title'),
    archived: boolean('archived').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('chat_threads_global_uniq').on(t.graphId).where(sql`${t.entityId} IS NULL`),
    uniqueIndex('chat_threads_entity_uniq')
      .on(t.graphId, t.entityId)
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

// Журнал действий (спека скорости §11.2, миграция 0025): отдельная таблица вместо системных сообщений чата.
// Строка — действие целиком (весь `ActionRecord`, РП-7) либо запись отмены (`type = 'undo'`, `undoes`). Только
// дописывается: политики — SELECT и INSERT. Ключ `(graph_id, id)`: id действия, у пачки — её `batch_id`.
// Имена полей — camelCase колонок; политики, гранты и CHECK формы отмены — в рукописном SQL миграции.
export const actionJournal = pgTable(
  'action_journal',
  {
    graphId: uuid('graph_id')
      .notNull()
      .references(() => graphs.id, { onDelete: 'cascade' }),
    id: uuid('id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
    type: text('type').notNull(),
    entityId: uuid('entity_id'),
    actorUserId: uuid('actor_user_id').notNull(),
    actorKind: text('actor_kind').notNull(),
    source: text('source').notNull(),
    mechanism: text('mechanism').notNull(),
    actorGrantId: uuid('actor_grant_id'),
    runId: uuid('run_id'),
    actionId: text('action_id'),
    module: text('module'),
    editedFrom: uuid('edited_from'),
    threadId: uuid('thread_id').references(() => chatThreads.id, { onDelete: 'set null' }),
    title: text('title').notNull(),
    cardTool: text('card_tool').notNull(),
    entityIds: uuid('entity_ids').array().notNull().default(sql`'{}'`),
    operations: jsonb('operations').notNull(),
    inverse: jsonb('inverse').notNull(),
    results: jsonb('results'),
    textSession: boolean('text_session').notNull().default(false),
    bodyBefore: jsonb('body_before'),
    undoes: uuid('undoes'),
    pinnedVersionIds: uuid('pinned_version_ids').array().notNull().default(sql`'{}'`),
    cardInReply: boolean('card_in_reply').notNull().default(false),
  },
  (t) => [
    primaryKey({ name: 'action_journal_pkey', columns: [t.graphId, t.id] }),
    check('action_journal_undo_shape', sql`(${t.type} = 'undo') = (${t.undoes} IS NOT NULL)`),
    uniqueIndex('action_journal_undoes_uniq')
      .on(t.graphId, t.undoes)
      .where(sql`${t.undoes} IS NOT NULL`),
    index('action_journal_graph_time').on(
      t.graphId,
      t.createdAt.desc().nullsFirst(),
      t.id.desc().nullsFirst(),
    ),
    index('action_journal_thread_time')
      .on(t.graphId, t.threadId, t.createdAt.desc().nullsFirst(), t.id.desc().nullsFirst())
      .where(sql`${t.threadId} IS NOT NULL`),
    index('action_journal_run').on(t.graphId, t.runId).where(sql`${t.runId} IS NOT NULL`),
    index('action_journal_type_time').on(t.graphId, t.type, t.createdAt.desc().nullsFirst()),
  ],
);

// Боковая таблица проб «по затронутой записи» (РП-8): под RLS `uuid[] @>`/`&&` не leakproof и индекс не берут,
// равенство uuid — leakproof, поэтому пробы R-18, окна конфликтов отката и будущего журнала записи идут btree сюда.
// Пишет её тот же синк журнала той же транзакцией; `created_at` — копия времени строки журнала.
export const actionJournalEntities = pgTable(
  'action_journal_entities',
  {
    graphId: uuid('graph_id').notNull(),
    actionId: uuid('action_id').notNull(),
    entityId: uuid('entity_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).notNull(),
  },
  (t) => [
    primaryKey({
      name: 'action_journal_entities_pkey',
      columns: [t.graphId, t.actionId, t.entityId],
    }),
    foreignKey({
      name: 'action_journal_entities_action_fk',
      columns: [t.graphId, t.actionId],
      foreignColumns: [actionJournal.graphId, actionJournal.id],
    }).onDelete('cascade'),
    index('action_journal_entities_probe').on(
      t.graphId,
      t.entityId,
      t.createdAt.desc().nullsFirst(),
    ),
  ],
);

// §4.7 ai_usage — метеринг LLM на ГРАФ/день/модель (расход — на граф, D44); PK (graph_id, date, model)
export const aiUsage = pgTable(
  'ai_usage',
  {
    graphId: uuid('graph_id')
      .notNull()
      .references(() => graphs.id, { onDelete: 'no action' }),
    date: date('date').notNull(), // календарный день в UTC
    model: text('model').notNull(),
    inputTokens: bigint('input_tokens', { mode: 'number' }).notNull().default(0),
    outputTokens: bigint('output_tokens', { mode: 'number' }).notNull().default(0),
    requestCount: integer('request_count').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.graphId, t.date, t.model] })],
);

// §4.8 entity_origins — provenance импорта
export const entityOrigins = pgTable(
  'entity_origins',
  {
    id: uuid('id').primaryKey(),
    graphId: uuid('graph_id')
      .notNull()
      .references(() => graphs.id, { onDelete: 'no action' }),
    entityId: uuid('entity_id')
      .notNull()
      .references(() => entities.id),
    namespace: text('namespace').notNull(), // например csv:<источник>
    externalId: text('external_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('entity_origins_uniq').on(t.graphId, t.namespace, t.externalId)],
);

// entity_versions (§2.2, ADE-срез 1, С11) — закреплённые версии тела: снимок текста с
// подписью, который делает ЧЕЛОВЕК. Не история правок (её ведёт редактор), а те точки,
// к которым он решил иметь возможность вернуться. Владение прямое, по graph_id, — как у
// entity_origins: снимок принадлежит владельцу сущности и живёт под той же RLS.
export const entityVersions = pgTable(
  'entity_versions',
  {
    id: uuid('id').primaryKey(), // UUIDv7, генерирует сервер (newId)
    graphId: uuid('graph_id')
      .notNull()
      .references(() => graphs.id, { onDelete: 'no action' }),
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
    graphId: uuid('graph_id')
      .notNull()
      .references(() => graphs.id, { onDelete: 'no action' }),
    // Аккаунт, выдавший грант (D44): актор путей без живого человека; NOT NULL с миграции 0021.
    issuedBy: uuid('issued_by').notNull(),
    // NULL у PAT: у headless-доступа нет зарегистрированного клиента
    clientId: text('client_id').references(() => oauthClients.clientId, { onDelete: 'cascade' }),
    kind: text('kind').notNull(), // oauth | pat
    label: text('label').notNull(),
    // Область гранта (С2, §4.14): 'full' — весь граф владельца, 'worker' — фоновый
    // исполнитель. Пишется при выдаче кода и PAT; DEFAULT держит строки, заведённые до
    // среза, и остаётся прежним поведением для вызовов без области.
    scope: text('scope').notNull().default('full'),
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
    index('agent_grants_graph').on(t.graphId),
    check('agent_grants_kind', sql`${t.kind} IN ('oauth','pat')`),
  ],
);

// ---------------------------------------------------------------------------
// Реестры реформы свойств (§С6) — семь таблиц.
//
// Общая форма пяти реестров: `graph_id IS NULL` — встроенная запись из сида (общая для
// всех), иначе запись владельца. Уникальность — не PK, а пара partial unique index'ов
// (образец — aspect_definitions §4.3): своя запись с тем же `id`, что у встроенной,
// ЗАКОННА и перекрывает её при загрузке (ORDER BY graph_id NULLS FIRST) — на этом стоит
// сегодняшнее переопределение аспекта и будущая дельта.
//
// RLS, GRANT'ы и политики — рукописная часть миграции 0014 (drizzle-kit их не видит).
// ---------------------------------------------------------------------------

// §А2-1: реестр свойств. Свойство — владелец типа и ограничений; аспект добавляет к нему
// только обязательность и порядок (Р5).
export const propertyDefinitions = pgTable(
  'property_definitions',
  {
    // Тождество, не меняется НИКОГДА. У встроенных — читаемая строка (`orbis/task_status`),
    // у пользовательских и приложений — uuid (Р3). На экране id — баг.
    id: text('id').notNull(),
    graphId: uuid('graph_id').references(() => graphs.id, { onDelete: 'no action' }), // NULL = встроенное
    // Машинная ручка: имя параметра тула, текст запроса, MCP, канонический экспорт.
    // У встроенных изначально = id; меняется только релизом системы (№12).
    key: text('key').notNull(),
    label: jsonb('label').notNull(), // per-locale {ru, en}; fallback: локаль → en → любая
    description: jsonb('description').notNull(), // per-locale; обязателен (Р4)
    type: jsonb('type').notNull(), // {kind, …конфиг} из закрытого словаря §А2-2
    status: text('status').notNull().default('active'),
    // §А1-3: `core` — хранение осталось колонкой (title/archived/created_at/updated_at),
    // реестр даёт им единый адрес для Q-AST, CAS и подписи.
    storage: text('storage').notNull().default('props'),
    // Статический Q-AST (Р15): «показывать колонкой на всех сущностях по условию».
    // NULL — свойство живёт только через аспекты. Сужается Задачей 8 вместе с каноном Q-AST.
    scope: jsonb('scope'),
    // Указатель слияния (Р10); резолвер идёт в ОДИН шаг, и это обещание держат две проверки
    // операции слияния (`registry/ops.ts`, §А10-2): компактация указателей на поглощённое и
    // отказ сливать в уже поглощённое (`MERGE_ALREADY_MERGED`). Цепочки длиннее одного шага
    // в этой колонке не бывает по построению, а не по договорённости.
    mergedInto: text('merged_into'),
    module: text('module'), // модуль-владелец; NULL = ядро (№14/№15)
    // Порядок объявления — в каталоге промпта и в форме. Обязателен: jsonb порядок ключей
    // не хранит, и в проде обязательный start_at уже показывается четвёртым (П3 §7.2).
    rank: integer('rank').notNull(),
    // model_writable / system_writable / computed — §А2-1, гейт §А2-5.
    flags: jsonb('flags').notNull().default({}),
    // §Б4-1: правила каталога — jsonb СТРОКИ-НОСИТЕЛЯ, не таблица (правило умирает с владельцем).
    // NOT NULL DEFAULT '[]': строки, посеянные до 0022, читаются пустым списком, а не NULL'ом.
    rules: jsonb('rules').notNull().default([]),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('property_definitions_builtin_uniq').on(t.id).where(sql`${t.graphId} IS NULL`),
    uniqueIndex('property_definitions_custom_uniq')
      .on(t.graphId, t.id)
      .where(sql`${t.graphId} IS NOT NULL`),
    // key уникален отдельно от id: по нему адресуют запросы и параметры тулов, и два
    // свойства с одним key сделали бы текст запроса неоднозначным. «Уникален среди
    // ВИДИМОГО владельцу» (встроенные ∪ свои) индексом не выражается — эту половину
    // проверяет приложение при создании и переименовании key (Задача 15).
    uniqueIndex('property_definitions_builtin_key').on(t.key).where(sql`${t.graphId} IS NULL`),
    uniqueIndex('property_definitions_custom_key')
      .on(t.graphId, t.key)
      .where(sql`${t.graphId} IS NOT NULL`),
    check('property_definitions_status', sql`${t.status} IN ('active','proposed','deprecated')`),
    check('property_definitions_storage', sql`${t.storage} IN ('props','core')`),
  ],
);

// §А4-2: реестр ролей рёбер (Ч7). Роль — единственная истина ребра (§А4-1).
export const relationRoleDefinitions = pgTable(
  'relation_role_definitions',
  {
    id: text('id').notNull(),
    graphId: uuid('graph_id').references(() => graphs.id, { onDelete: 'no action' }), // NULL = системная роль; свои роли — v1.5 (Ч7)
    key: text('key').notNull(), // namespace НЕ обязателен: системные v1 — голые слаги
    label: jsonb('label').notNull(),
    description: jsonb('description').notNull(),
    // Ч10-С3: направление ребра подписывает реестр («Конверт» → «Транзакция»), а не UI.
    sourceLabel: jsonb('source_label').notNull(),
    targetLabel: jsonb('target_label').notNull(),
    // Входит ли роль в семейство иерархии: children_of/descendants_of без via= компилятор
    // разворачивает в role IN (…) по этому признаку (Ч10-С1).
    hierarchical: boolean('hierarchical').notNull().default(false),
    // target_max_incoming / acyclic / source_contract / target_contract / created_by.
    // Работают все: target_max_incoming/acyclic — с Задачи 7a, контрактные — с Б-2
    // (`executor/relations.ts`, `assertEndContracts`).
    constraints: jsonb('constraints').notNull().default({}),
    // §Б4-1: правила каталога — jsonb СТРОКИ-НОСИТЕЛЯ, не таблица (правило умирает с владельцем).
    // NOT NULL DEFAULT '[]': строки, посеянные до 0022, читаются пустым списком, а не NULL'ом.
    rules: jsonb('rules').notNull().default([]),
    // named-future Ч10-С2: колонка описана, поведение не реализуется до второго кейса.
    symmetric: boolean('symmetric').notNull().default(false),
    module: text('module'),
    rank: integer('rank').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('relation_role_definitions_builtin_uniq').on(t.id).where(sql`${t.graphId} IS NULL`),
    uniqueIndex('relation_role_definitions_custom_uniq')
      .on(t.graphId, t.id)
      .where(sql`${t.graphId} IS NOT NULL`),
  ],
);

/**
 * §Б1-1: реестр контрактов. В срезе А таблица создавалась и оставалась ПУСТОЙ (§А12-1): сид
 * контрактов ядра — первый акт среза Б-1, гейт части Б — §С8-18 (ревизия 3 спеки сняла
 * прежнее условие П5, §0.2-18). Таблица засеяна срезом Б-1; `action_definitions` засеяна срезом
 * Б-2 (два встроенных действия), и пустых реестров структуры больше нет. Пустая таблица заводилась
 * здесь, а не миграцией в Б-1, потому что drift, `/health` и `ops.ts check` обязаны знать все
 * реестры уже в срезе А (§А12-1 п.4), а знать несуществующую таблицу они не могут.
 *
 * `kind`: `slots` — контракт со слотами/классами/наборами; `facts` — закрытый словарь
 * фактов чувствительности без слотов и привязок (§Б1-2).
 */
export const contractDefinitions = pgTable(
  'contract_definitions',
  {
    id: text('id').notNull(),
    graphId: uuid('graph_id').references(() => graphs.id, { onDelete: 'no action' }), // v1 — только NULL: пользовательские контракты — v1.5 (Ч7)
    key: text('key').notNull(),
    label: jsonb('label').notNull(),
    description: jsonb('description').notNull(),
    kind: text('kind').notNull(),
    slots: jsonb('slots'), // [{name, type, required, label}]
    classes: jsonb('classes'), // [{key, label}] — классы значений слота-статуса
    sets: jsonb('sets'), // {имя: [классы] | E-предикат по слотам}
    facts: jsonb('facts'), // словарь фактов чувствительности (kind = 'facts')
    // Р-И-38: один вариант на класс — запись классом однозначна; флаг читает валидатор привязок.
    exclusiveClasses: boolean('exclusive_classes').notNull().default(false),
    module: text('module'),
    rank: integer('rank').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('contract_definitions_builtin_uniq').on(t.id).where(sql`${t.graphId} IS NULL`),
    uniqueIndex('contract_definitions_custom_uniq')
      .on(t.graphId, t.id)
      .where(sql`${t.graphId} IS NOT NULL`),
    check('contract_definitions_kind', sql`${t.kind} IN ('slots','facts')`),
  ],
);

/** §Б5-1: реестр подписок поверхностей. ПУСТАЯ в срезе А (§А12-1) — см. contract_definitions. */
export const subscriptionDefinitions = pgTable(
  'subscription_definitions',
  {
    id: text('id').notNull(),
    graphId: uuid('graph_id').references(() => graphs.id, { onDelete: 'no action' }),
    surface: text('surface').notNull(), // поверхность-потребитель: agenda, budget, …
    definition: jsonb('definition').notNull(), // декларация подписки (§Б5)
    module: text('module'),
    rank: integer('rank').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('subscription_definitions_builtin_uniq').on(t.id).where(sql`${t.graphId} IS NULL`),
    uniqueIndex('subscription_definitions_custom_uniq')
      .on(t.graphId, t.id)
      .where(sql`${t.graphId} IS NOT NULL`),
  ],
);

/**
 * §Б6-1: реестр действий. ПУСТАЯ в срезе А (§А12-1) — см. contract_definitions; засеяна срезом Б-2
 * (два встроенных действия, `BUILTIN_ACTION_DEFS`). Колонки `rank`/`status`/`over` и частичная
 * уникальность `key` пришли миграцией 0022 — одной на срез (Р-18), раньше своих читателей (снимок
 * реестра, `run_action`, отказ `ACTION_DEPRECATED`).
 */
export const actionDefinitions = pgTable(
  'action_definitions',
  {
    id: text('id').notNull(),
    graphId: uuid('graph_id').references(() => graphs.id, { onDelete: 'no action' }),
    key: text('key').notNull(),
    label: jsonb('label').notNull(),
    description: jsonb('description').notNull(),
    params: jsonb('params'),
    precondition: jsonb('precondition'), // E-предикат допустимости
    steps: jsonb('steps'), // шаги действия языком E
    sensitivity: jsonb('sensitivity'), // факты чувствительности → класс подтверждения §7.10
    offeredBy: jsonb('offered_by'), // где предлагается (поверхности, контракты)
    module: text('module'),
    batchCap: integer('batch_cap'), // кап на применение к результатам Q (§Б6-3)
    rank: integer('rank').notNull().default(0), // единственный реестр без rank (§Б6-1, export.ts:74-80)
    status: text('status').notNull().default('active'), // §С3: deprecate вместо удаления (§А10-3)
    over: jsonb('over'), // §Б6-3: Q map-действия; у одиночного его нет
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('action_definitions_builtin_uniq').on(t.id).where(sql`${t.graphId} IS NULL`),
    uniqueIndex('action_definitions_custom_uniq')
      .on(t.graphId, t.id)
      .where(sql`${t.graphId} IS NOT NULL`),
    // Имя тула действия собирается из `key` (аналог attach_*): два действия с одним ключом дали бы
    // неразрешимое имя. Уникальность частичная — как у `key` свойств (индексы `*_key` выше).
    uniqueIndex('action_definitions_builtin_key').on(t.key).where(sql`${t.graphId} IS NULL`),
    uniqueIndex('action_definitions_custom_key')
      .on(t.graphId, t.key)
      .where(sql`${t.graphId} IS NOT NULL`),
    check('action_definitions_status', sql`${t.status} IN ('active','deprecated')`),
  ],
);

/**
 * §А3-2: пользовательские изменения встроенных записей — ДЕЛЬТЫ, а не правка. Системное
 * определение неизменяемо и приезжает сидом; дельта лежит отдельной строкой, эффективное
 * определение = система ⊕ дельта. `base_version` нужен для трёхстороннего слияния при
 * обновлении системы (§А3-3): конфликтная пара становится единицей пачки D42, а не молча
 * затирается.
 *
 * Одна дельта на (владелец, род, цель) — накопления версий здесь нет: дельта это ТЕКУЩЕЕ
 * отличие от системы, а история правок живёт в журнале операций.
 */
export const registryDeltas = pgTable(
  'registry_deltas',
  {
    id: uuid('id').primaryKey(),
    graphId: uuid('graph_id')
      .notNull()
      .references(() => graphs.id, { onDelete: 'no action' }),
    targetKind: text('target_kind').notNull(),
    targetId: text('target_id').notNull(),
    baseVersion: integer('base_version').notNull(),
    delta: jsonb('delta').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('registry_deltas_uniq').on(t.graphId, t.targetKind, t.targetId),
    check(
      'registry_deltas_target_kind',
      sql`${t.targetKind} IN ('property','aspect','contract','relation_role','subscription','action')`,
    ),
  ],
);

/**
 * §А10-1: глобальная версия SYSTEM-реестров — та половина версии, которую двигает сид, а не
 * владелец (его половина — `user_settings.registry_version`). Кеш эффективных определений
 * держится за обе.
 *
 * Ровно ОДНА строка, и это выражено constraint'ом `id = 1`, а не соглашением: таблица без
 * ограничения на число строк однажды получает вторую и молча раздваивает версию.
 * Из `truncateAll` тестов она исключена намеренно — иначе пришлось бы пересевать реестр
 * между сьютами.
 */
export const registrySystem = pgTable(
  'registry_system',
  {
    id: smallint('id').primaryKey(),
    version: integer('version').notNull().default(0),
    seededAt: timestamp('seeded_at', { withTimezone: true }),
  },
  (t) => [check('registry_system_singleton', sql`${t.id} = 1`)],
);

/**
 * §Б5-5: кэш `spent` конверта — ОБЫЧНАЯ таблица под RLS владельца, а не MATERIALIZED VIEW
 * (его нельзя обновить частично и он живёт вне политик — П2 §11-3).
 *
 * Ключ — ПАРА `(envelope_id, as_of)`, и второй его половиной закрыт четвёртый путь мимо
 * бюджет-хука: ведомость `spent` фильтрует движения условием `occurred_on <= today`, то есть
 * в полночь её состав меняется БЕЗ единой мутации. Со строкой на день полночь просто даёт
 * промах по новому ключу, а не тихо устаревший ответ.
 *
 * Обе половины версии реестра (§А10-1) лежат В СТРОКЕ: читатель сравнивает их со своими и
 * строку чужой версии не видит — это и есть «смена registry_version инвалидирует» (§С8-16).
 * Отдельного сноса при пересеве не нужно, а `reset-world` сносит таблицу целиком.
 *
 * `spent numeric`, а НЕ `text`: агрегат отдаёт `sum(...)::text`, и хранение строкой однажды
 * разошлось бы с ним в округлении и в масштабе. На выходе — снова `::text` (§Б3-5: decimal
 * пересекает границу только строкой).
 */
export const envelopeSpentCache = pgTable(
  'envelope_spent_cache',
  {
    envelopeId: uuid('envelope_id')
      .notNull()
      .references(() => entities.id, { onDelete: 'cascade' }),
    graphId: uuid('graph_id')
      .notNull()
      .references(() => graphs.id, { onDelete: 'no action' }),
    asOf: date('as_of').notNull(),
    spent: numeric('spent').notNull(),
    ownerVersion: integer('owner_version').notNull(),
    systemVersion: integer('system_version').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.envelopeId, t.asOf] }),
    // Снос по владельцу (property_merge, undo) и отчёт `reset-world` ходят по graph_id.
    index('envelope_spent_cache_graph').on(t.graphId, t.asOf),
  ],
);

// §3.1 спеки «граф как единица владения» (D44): граф — вещь со своим владельцем в записи.
// Личный граф — частный случай: owner_kind = 'person' и id = owner_ref = id аккаунта; это тождество
// держит CHECK, а «один личный граф на аккаунт» (И-3) следует из PK. У organization owner_ref
// допускает NULL — на что он ссылается, решает ступень 2. FK на auth.users не объявляем (см. шапку файла).
export const graphs = pgTable(
  'graphs',
  {
    id: uuid('id').primaryKey(),
    ownerKind: text('owner_kind').notNull(), // person | organization (v1 — только person)
    ownerRef: uuid('owner_ref'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('graphs_owner_kind', sql`${t.ownerKind} IN ('person','organization')`),
    // `owner_ref IS NOT NULL` обязателен: без него выражение для person с пустым owner_ref даёт
    // NULL, а CHECK на NULL проходит — личный граф без тождества id (эррата Э-3 плана среза Г).
    check(
      'graphs_personal_identity',
      sql`(${t.ownerKind} = 'person' AND ${t.ownerRef} IS NOT NULL AND ${t.id} = ${t.ownerRef}) OR ${t.ownerKind} = 'organization'`,
    ),
  ],
);

// §3.2: грант аккаунта на граф. id — суррогатный: история отзывов не затирается повторной выдачей.
// Не сливается с agent_grants (там OAuth-механика); общая надстройка — ступень 2.
export const graphMembers = pgTable(
  'graph_members',
  {
    id: uuid('id').primaryKey(),
    graphId: uuid('graph_id')
      .notNull()
      .references(() => graphs.id, { onDelete: 'no action' }),
    accountId: uuid('account_id').notNull(), // аккаунт Supabase; FK на auth не объявляем
    grantKind: text('grant_kind').notNull(), // owner | operator | observer (`grant` — слово SQL)
    issuedAt: timestamp('issued_at', { withTimezone: true }).notNull().defaultNow(),
    issuedBy: uuid('issued_by').notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('graph_members_active_uniq')
      .on(t.graphId, t.accountId)
      .where(sql`${t.revokedAt} IS NULL`),
    index('graph_members_account').on(t.accountId),
    check('graph_members_grant_kind', sql`${t.grantKind} IN ('owner','operator','observer')`),
  ],
);
