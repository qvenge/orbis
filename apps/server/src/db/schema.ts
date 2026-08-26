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
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

// Схема 18 таблиц: одиннадцать исходных (docs/prd/01-architecture.md §4 — восемь §4.1–§4.8,
// две таблицы доступа внешних агентов §4.13–§4.14 D34 в конце файла, entity_versions
// ADE-среза 1) и семь таблиц реформы свойств (§С6 спеки «Реформа свойств»): пять реестров,
// таблица дельт и однострочная таблица версии system-реестра — они в конце файла, после
// исходных.
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
  /**
   * СТАРАЯ карта аспектов `{id аспекта: {поле: значение}}` — носитель, который реформа
   * снимает (§А1-1). Переименована из `aspects` миграцией 0015 и до миграции 0017 живёт
   * рядом с новой правдой: её пишет проекция `executor/legacy-form.ts`, а читают ещё не
   * переведённые запросы (доменные модули, компилятор §6, web через `wire.aspectsMap`).
   * Новый код в неё не смотрит — он читает `props`/`aspects`.
   */
  aspectsLegacy: jsonb('aspects_legacy').notNull().default({}),
  /**
   * НОВАЯ правда значений (§А1-1): плоская карта `{id свойства: значение}` — один
   * идентификатор на свойство независимо от того, сколько аспектов его носят (§А8/В1
   * слили `orbis/finance_category`, `orbis/currency`, `orbis/grant`).
   */
  props: jsonb('props').notNull().default({}),
  /** НОВАЯ правда интерпретаций: список id аспектов, а не карта (§А1-1, Р5). */
  aspects: text('aspects').array().notNull().default(sql`'{}'`),
  /**
   * Id сущностей, на которые ссылаются ссылочные свойства этой строки (§А1-1): обратный
   * индекс для «кто на меня ссылается» без обхода jsonb. Писателя заводит задача
   * «Ссылочные свойства», до неё колонка пуста — но заведена сразу, вместе с остальными
   * двумя: форма строки не должна меняться миграцией дважды.
   */
  queryRefs: text('query_refs').array().notNull().default(sql`'{}'`),
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

// §4.3 aspect_definitions — новая форма §А3-1: аспект есть ИНТЕРПРЕТАЦИЯ, а не владелец
// полей (Р5). Поля переехали в property_definitions, здесь остались ссылки на них
// (`properties`) с обязательностью и порядком. Без surrogate PK; уникальность — два
// partial unique index, как было.
export const aspectDefinitions = pgTable(
  'aspect_definitions',
  {
    id: text('id').notNull(), // namespaced: orbis/task, user/sleep
    ownerId: uuid('owner_id'), // NULL = встроенный аспект
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
    /**
     * JSON Schema СТАРОЙ формы (Р-24): по ней валидирует стадия 2 исполнителя и из неё
     * собирается вход `attach_*`-тула. Носитель переезжает на генерацию из реестра свойств
     * миграцией 0017, до тех пор сидер продолжает писать сюда `legacyAspectJsonSchema(id)`.
     * NOT NULL снят: строке реестра, заведённой уже по-новому, старая схема не нужна.
     */
    schema: jsonb('schema'),
    aiInstructions: text('ai_instructions'),
    tagMappings: text('tag_mappings').array().notNull().default(sql`'{}'`),
    aggregations: jsonb('aggregations').default({}),
    viewConfig: jsonb('view_config').default({}),
    module: text('module'), // модуль-владелец; NULL = ядро (§А2-1, №14/№15)
    // §А3-1/Р-П-5: служебность — колонка реестра, а не список в коде (сегодня их три копии).
    service: boolean('service').notNull().default(false),
    rank: integer('rank').notNull().default(0),
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
  /**
   * Версия реестров ВЛАДЕЛЬЦА (§А10-1, Б7): инкремент в той же транзакции, что любая его
   * мутация реестра; ключ процессного кеша эффективных определений — `(owner, version)`.
   * Имя колонки — snake_case ЯВНО (РП-16), вопреки camelCase соседей: те написаны так по
   * историческому совпадению с кодом (см. комментарий таблицы), и продлевать эту случайность
   * на новую колонку незачем.
   */
  registryVersion: integer('registry_version').notNull().default(0),
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
    index('agent_grants_owner').on(t.ownerId),
    check('agent_grants_kind', sql`${t.kind} IN ('oauth','pat')`),
  ],
);

// ---------------------------------------------------------------------------
// Реестры реформы свойств (§С6) — семь таблиц.
//
// Общая форма пяти реестров: `owner_id IS NULL` — встроенная запись из сида (общая для
// всех), иначе запись владельца. Уникальность — не PK, а пара partial unique index'ов
// (образец — aspect_definitions §4.3): своя запись с тем же `id`, что у встроенной,
// ЗАКОННА и перекрывает её при загрузке (ORDER BY owner_id NULLS FIRST) — на этом стоит
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
    ownerId: uuid('owner_id'), // NULL = встроенное
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
    mergedInto: text('merged_into'), // указатель слияния (Р10); резолвер идёт в один шаг
    module: text('module'), // модуль-владелец; NULL = ядро (№14/№15)
    // Порядок объявления — в каталоге промпта и в форме. Обязателен: jsonb порядок ключей
    // не хранит, и в проде обязательный start_at уже показывается четвёртым (П3 §7.2).
    rank: integer('rank').notNull(),
    // model_writable / system_writable / computed — §А2-1, гейт §А2-5.
    flags: jsonb('flags').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('property_definitions_builtin_uniq').on(t.id).where(sql`${t.ownerId} IS NULL`),
    uniqueIndex('property_definitions_custom_uniq')
      .on(t.ownerId, t.id)
      .where(sql`${t.ownerId} IS NOT NULL`),
    // key уникален отдельно от id: по нему адресуют запросы и параметры тулов, и два
    // свойства с одним key сделали бы текст запроса неоднозначным. «Уникален среди
    // ВИДИМОГО владельцу» (встроенные ∪ свои) индексом не выражается — эту половину
    // проверяет приложение при создании и переименовании key (Задача 15).
    uniqueIndex('property_definitions_builtin_key').on(t.key).where(sql`${t.ownerId} IS NULL`),
    uniqueIndex('property_definitions_custom_key')
      .on(t.ownerId, t.key)
      .where(sql`${t.ownerId} IS NOT NULL`),
    check('property_definitions_status', sql`${t.status} IN ('active','proposed','deprecated')`),
    check('property_definitions_storage', sql`${t.storage} IN ('props','core')`),
  ],
);

// §А4-2: реестр ролей рёбер (Ч7). Роль — единственная истина ребра (§А4-1).
export const relationRoleDefinitions = pgTable(
  'relation_role_definitions',
  {
    id: text('id').notNull(),
    ownerId: uuid('owner_id'), // NULL = системная роль; свои роли — v1.5 (Ч7)
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
    // В срезе А поля ЛЕЖАТ: target_max_incoming включает Задача 7a, контрактные — часть Б.
    constraints: jsonb('constraints').notNull().default({}),
    // named-future Ч10-С2: колонка описана, поведение не реализуется до второго кейса.
    symmetric: boolean('symmetric').notNull().default(false),
    module: text('module'),
    rank: integer('rank').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('relation_role_definitions_builtin_uniq').on(t.id).where(sql`${t.ownerId} IS NULL`),
    uniqueIndex('relation_role_definitions_custom_uniq')
      .on(t.ownerId, t.id)
      .where(sql`${t.ownerId} IS NOT NULL`),
  ],
);

/**
 * §Б1-1: реестр контрактов. В срезе А таблица создаётся и остаётся ПУСТОЙ (§А12-1): сид
 * трёх контрактов ядра — первый акт среза Б-1, после гейта П5. Пустая таблица здесь, а не
 * миграция в Б-1, потому что drift, `/health` и `ops.ts check` обязаны знать все пять
 * реестров уже в срезе А (§А12-1 п.4), а знать несуществующую таблицу они не могут.
 *
 * `kind`: `slots` — контракт со слотами/классами/наборами; `facts` — закрытый словарь
 * фактов чувствительности без слотов и привязок (§Б1-2).
 */
export const contractDefinitions = pgTable(
  'contract_definitions',
  {
    id: text('id').notNull(),
    ownerId: uuid('owner_id'), // v1 — только NULL: пользовательские контракты — v1.5 (Ч7)
    key: text('key').notNull(),
    label: jsonb('label').notNull(),
    description: jsonb('description').notNull(),
    kind: text('kind').notNull(),
    slots: jsonb('slots'), // [{name, type, required, label}]
    classes: jsonb('classes'), // [{key, label}] — классы значений слота-статуса
    sets: jsonb('sets'), // {имя: [классы] | E-предикат по слотам}
    facts: jsonb('facts'), // словарь фактов чувствительности (kind = 'facts')
    module: text('module'),
    rank: integer('rank').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('contract_definitions_builtin_uniq').on(t.id).where(sql`${t.ownerId} IS NULL`),
    uniqueIndex('contract_definitions_custom_uniq')
      .on(t.ownerId, t.id)
      .where(sql`${t.ownerId} IS NOT NULL`),
    check('contract_definitions_kind', sql`${t.kind} IN ('slots','facts')`),
  ],
);

/** §Б5-1: реестр подписок поверхностей. ПУСТАЯ в срезе А (§А12-1) — см. contract_definitions. */
export const subscriptionDefinitions = pgTable(
  'subscription_definitions',
  {
    id: text('id').notNull(),
    ownerId: uuid('owner_id'),
    surface: text('surface').notNull(), // поверхность-потребитель: agenda, budget, …
    definition: jsonb('definition').notNull(), // декларация подписки (§Б5)
    module: text('module'),
    rank: integer('rank').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('subscription_definitions_builtin_uniq').on(t.id).where(sql`${t.ownerId} IS NULL`),
    uniqueIndex('subscription_definitions_custom_uniq')
      .on(t.ownerId, t.id)
      .where(sql`${t.ownerId} IS NOT NULL`),
  ],
);

/** §Б6-1: реестр действий. ПУСТАЯ в срезе А (§А12-1) — см. contract_definitions. */
export const actionDefinitions = pgTable(
  'action_definitions',
  {
    id: text('id').notNull(),
    ownerId: uuid('owner_id'),
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
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('action_definitions_builtin_uniq').on(t.id).where(sql`${t.ownerId} IS NULL`),
    uniqueIndex('action_definitions_custom_uniq')
      .on(t.ownerId, t.id)
      .where(sql`${t.ownerId} IS NOT NULL`),
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
    ownerId: uuid('owner_id').notNull(),
    targetKind: text('target_kind').notNull(),
    targetId: text('target_id').notNull(),
    baseVersion: integer('base_version').notNull(),
    delta: jsonb('delta').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('registry_deltas_uniq').on(t.ownerId, t.targetKind, t.targetId),
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
