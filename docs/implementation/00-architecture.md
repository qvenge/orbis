# Orbis Implementation v3.1 — 00: Архитектура

| Поле | Значение |
|---|---|
| Версия | 3.1 |
| Дата | 2026-07-02 |
| Класс документа | Implementation-архитектура — обновляется при изменении контрактов PRD, а не при рефакторинге кода |
| Источник контрактов | `docs/prd/` (00–04), прежде всего `01-architecture.md` |

Этот документ показывает **структуру реализации** v3.1: карту модулей монорепо, правила направления зависимостей, потоки мутаций и чтения, ключевые sequence-диаграммы и ER-схему восьми таблиц. Он не дублирует PRD — каждая диаграмма цитирует конкретную секцию `docs/prd/01-architecture.md` как источник контракта и не вводит механизмов, которых там нет. Если деталь реализации не зафиксирована в PRD (например, конкретный формат ключа клиентского кэша), она здесь остаётся на уровне роли, а не выдуманной специфики.

Границу детализации см. в §6.

---

## §1. Карта модулей монорепо

Три workspace-пакета Bun-монорепо:

```
apps/web        — PWA (React): экраны (Browser, Budget, Agenda, чат),
                  переиспользуемый чат-компонент (используется и для
                  глобального треда, и для треда сущности, PRD 01 §7.3),
                  клиентский fast-path-парсер (PRD 01 §7.5, детерминированный,
                  без LLM, работает офлайн), retry-буфер неотправленных
                  fast-path-create мутаций (PRD 01 §5.3), TanStack Query
                  (server-state-кэш, PRD 01 §5.1) + Zustand (UI state),
                  tRPC-клиент

apps/server     — Hono + @hono/trpc-server: tRPC-роутеры entity/relation/
                  aspect/user/ai/chat (PRD 01 §9.1), executor — семистадийный
                  конвейер мутаций (PRD 01 §9.2), политика подтверждений
                  (PRD 01 §7.10), LLM-оркестрация за интерфейсом LLMProvider
                  поверх Vercel AI SDK (PRD 01 §7.7), MCP-сервер — тонкий
                  адаптер над тем же tool-executor'ом (PRD 01 §9.3),
                  SQL-компилятор query-движка (PRD 01 §6.2), entitlements-
                  резолвер (PRD 01 §8), экспорт (PRD 01 §9.4)

packages/shared — Zod-схемы wire-контрактов (вход/выход tRPC-процедур,
                  общие типы клиента и сервера, PRD 01 §9.1), AST-типы
                  грамматики query-движка (PRD 01 §6.1, используются парсером
                  и SQL-компилятором), константы (aspect id, relation types,
                  namespaces), типы реестра аспектов
```

**Примечание о размещении fast-path-парсера.** PRD 01 §7.5 называет его буквально «клиентским парсером» и требует офлайн-работы без сети — это возможно только при выполнении в `apps/web`. `apps/server` не содержит второй копии текстового парсера: он получает от клиента уже структурированный `entity_create` (через retry-буфер или напрямую) и валидирует его тем же executor-конвейером, что и любую другую мутацию (§2). `packages/shared` не хранит правил распознавания fast-path-паттернов — только контракты (Zod-схемы) полезной нагрузки, которую парсер формирует.

### §1.1 Правила направления зависимостей

Адаптировано из архивной карты `docs/implementation_old/01-application-architecture.md` под v3.1: убраны пакеты `client-db`/`server-db`/`sync` (собственной БД у клиента нет, синхронизации нет — PRD 01 §4.12, §5.1), добавлен retry-буфер как единственное персистентное клиентское состояние.

```mermaid
flowchart LR
    Web["apps/web"] --> Shared["packages/shared"]
    Server["apps/server"] --> Shared
    Web -. "tRPC (HTTPS, Zod-контракты)" .-> Server
```

1. `apps/*` зависят от `packages/shared`; обратной зависимости нет. `apps/web` и `apps/server` не импортируют друг друга напрямую — единственная связь между ними сетевая (tRPC), не через общий код.
2. `packages/shared` не импортирует React, Hono, Drizzle, Supabase, tRPC-сервер или AI SDK — это чистый слой контрактов и типов.
3. Типы Vercel AI SDK не выходят за пределы модуля LLMProvider внутри `apps/server` (PRD 01 §7.7): наружу — в tRPC-роутеры, в журнал действий, в MCP-адаптер — отдаются только собственные типы Orbis.
4. Клиент не знает о Drizzle или о Supabase Data API и не имеет собственной базы данных (PRD 01 §4.12): все чтения и мутации идут только через tRPC → executor — «один путь мутаций» (PRD 01 §9.1). Supabase на клиенте используется исключительно для Auth (получение JWT).
5. UI-компоненты `apps/web` не конструируют SQL и не содержат доменных правил — они вызывают tRPC-процедуры и рендерят их результат. Вся валидация инвариантов живёт в executor'е `apps/server` (7 стадий, §9.2), а не в роутерах и не в UI.
6. Единственное персистентное клиентское состояние — retry-буфер неотправленных fast-path-create мутаций (PRD 01 §5.3, §4.12): очередь ещё не подтверждённых сервером запросов, не серверная модель данных и не её слепок.
7. MCP-сервер — тонкий адаптер поверх того же реестра тулов и того же tool-executor'а, что и внутренний AI-чат (PRD 01 §9.3): он не содержит собственной бизнес-логики и не может дать внешнему агенту более широкие права, чем внутреннему AI.
8. tRPC-роутеры и MCP-адаптер не реализуют бизнес-правила сами — они транслируют вход во входной формат executor'а и возвращают его результат.

---

## §2. Поток мутаций

Источники мутаций, конвейер executor'а и точка инвалидации клиентского кэша — по PRD 01 §5.3, §7.10, §9.1–§9.2.

```mermaid
flowchart TD
    ChatFastPath["Chat fast-path (apps/web, §7.5)"]
    QuickCapture["quick-capture (apps/web)"]
    ChatToolCall["Chat LLM tool-call (apps/web → apps/server ai-роутер)"]
    MCPAgent["MCP-агент (внешний, через apps/server MCP-сервер, §9.3)"]

    Buffer["retry-буфер (apps/web, §5.3)"]

    ChatFastPath --> Buffer
    Buffer --> TRPC["tRPC-процедура (apps/server, §9.1)"]
    QuickCapture --> TRPC
    ChatToolCall --> TRPC
    MCPAgent --> TRPC

    TRPC --> IsToolCall{"источник — LLM tool-call\nили MCP-агент?"}
    IsToolCall -- "да" --> ConfirmPolicy["политика подтверждений (§7.10)\nexecute / preview / explicit-confirmation / forbidden"]
    IsToolCall -- "нет (fast-path/quick-capture)" --> Executor
    ConfirmPolicy --> Executor["executor: 7 стадий (§9.2)"]

    Executor --> TxWrite["журнал actions + Postgres\n(одна транзакция)"]
    TxWrite --> Response["ответ клиенту"]
    Response --> CacheInvalidate["инвалидация server-state-кэша\n(TanStack Query, apps/web, §5.1)"]
```

Пояснения к диаграмме:

- **Retry-буфер** стоит на стороне `apps/web` перед tRPC и участвует только в пути fast-path-create (Chat fast-path, §7.5) — офлайн-правки существующих сущностей и LLM-путь через него не идут (PRD 01 §5.3, §7.9). Quick-capture (PRD 02 §3.7) в буфер не заходит: это отдельный не-чатовый путь без AI и без fast-path-грамматики, идущий в tRPC напрямую — контракт буфера (PRD 01 §5.3) охватывает только fast-path-create.
- **Ветвление по политике подтверждений** относится только к путям LLM tool-call и MCP-агента; fast-path/quick-capture — прямая, детерминированная команда пользователя, политика §7.10 к ней не применяется. На диаграмме это показано на уровне потока; внутри самого семистадийного конвейера (§9.2) классификация уровня фактически происходит после стадий 1–2 (структурная валидация) и до стадии 5 (apply) — здесь показан только факт наличия этой проверки для LLM/MCP-путей.
- **Executor 7 стадий** (§9.2): validate envelope → validate aspects → load state → validate all before first write → apply in transaction → inverse ops + cards → audit. Все семь стадий выполняются в `apps/server`, вне зависимости от источника мутации.
- **Журнал actions + Postgres — одна транзакция**: карточка чата и запись в `chat_messages.metadata.actions` появляются только после успешного `apply` (§7.8).
- **Инвалидация server-state-кэша** — заключительный шаг на клиенте: TanStack Query перечитывает данные с сервера после успешной мутации (§5.1); сервер не хранит и не обязан знать состояние клиентского кэша.

---

## §3. Поток чтения

Единая грамматика (PRD 01 §6.1), один SQL-бэкенд (Postgres, §6.2) и шесть потребителей (§6.3).

```mermaid
flowchart TD
    Browser["Browser (view, apps/web)"]
    BodyQuery["{{query:...}}-блоки в body\n(включая smart lists)"]
    Agenda["Agenda (view, apps/web)"]
    Budget["Budget (view, apps/web)"]
    AIEntityQuery["AI-тул entity_query\n(внутренний чат, apps/server)"]
    MCPEntityQuery["MCP entity_query\n(внешний агент, apps/server)"]

    Browser --> Grammar
    BodyQuery --> Grammar
    Agenda --> Grammar
    Budget --> Grammar
    AIEntityQuery --> Grammar
    MCPEntityQuery --> Grammar

    Grammar["парсер грамматики (packages/shared, §6.1)"] --> SQLCompiler["SQL-компилятор (apps/server, §6.2)"]
    SQLCompiler --> Postgres["PostgreSQL (Supabase)"]
    Postgres --> Render["рендеринг / ответ потребителю"]
```

Шесть потребителей на диаграмме — конкретизация строк PRD 01 §6.3 до уровня диаграммы: строка «Фильтры views» раскрыта в три отдельных узла (Browser / Budget / Agenda — три разных view с собственным UI-состоянием фильтра); строка «AI-тул `entity_query`» раскрыта в два узла по транспорту вызова (внутренний чат и MCP — оба вызывают один и тот же тул `entity_query` из единого реестра, §9.2, но входят в систему разными путями); Smart lists не показаны отдельным узлом — по PRD 01 §1.3 это сущности с query-блоками в body, то есть тот же механизм, что узел «`{{query:...}}`-блоки в body». Будущие потребители (прогресс целей, авто-чекины привычек, §11) на диаграмме MVP не показаны — они вне текущего слайсового скоупа, но используют тот же единственный парсер и компилятор без изменения ядра.

Все шесть потребителей компилируют запрос в один и тот же SQL и исполняют его на одном бэкенде — отдельного клиентского движка нет (§6.3): даже когда query-блок отображается в `apps/web`, сам запрос выполняется на сервере через tRPC.

---

## §4. Sequence-диаграммы ключевых флоу

Участники диаграмм — модули из §1: `apps/web` (и его внутренние роли — retry-буфер, чат-UI), `apps/server` (и его внутренние роли — tRPC, executor, LLMProvider, политика подтверждений, MCP-сервер), PostgreSQL. Имена tRPC-процедур на диаграммах (`ai.sendMessage`, `entity.get` и т.п.) иллюстративны; контракт сигнатур процедур в PRD не фиксируется и живёт в коде (PRD 01 §9.1).

### §4.1 Fast-path + retry-буфер

Контракт: PRD 01 §5.3 (retry-буфер), §7.5 (fast-path-парсер).

```mermaid
sequenceDiagram
    actor User as Пользователь
    participant Web as apps/web (fast-path-парсер)
    participant Buffer as apps/web: retry-буфер (§5.3)
    participant TRPC as apps/server: tRPC entity.create (§9.1)
    participant Executor as apps/server: executor (7 стадий, §9.2)
    participant DB as PostgreSQL

    User->>Web: вводит текст ("обед 340")
    Web->>Web: парсер уверен в паттерне (§7.5)
    Web->>Buffer: enqueue(clientId=UUIDv7)
    Web-->>User: оптимистичная карточка "ждёт отправки"
    Buffer->>TRPC: entity_create(id=clientId, ...)

    alt transport failure
        TRPC-->>Buffer: сетевая ошибка / таймаут
        Buffer->>Buffer: запись остаётся в очереди, ретрай с backoff
        Buffer->>TRPC: entity_create(id=clientId, ...) — повтор
    else business rejection
        TRPC->>Executor: конвейер, стадии 1-4 (валидация)
        Executor-->>TRPC: структурированная ошибка (доменный инвариант / entitlement)
        TRPC-->>Buffer: business-отказ
        Buffer->>Buffer: удалить запись из очереди
        Buffer-->>User: ошибка в UI
    else успех
        TRPC->>Executor: полный конвейер, идемпотентно по client-UUID
        Executor->>DB: apply in transaction (стадия 5)
        Executor->>DB: audit — запись в журнал actions (стадия 7)
        DB-->>Executor: OK
        Executor-->>TRPC: результат + inverse + карточка
        TRPC-->>Buffer: подтверждение сервера
        Buffer->>Buffer: удалить запись из очереди
        Buffer-->>User: карточка подтверждена
    end
```

Три обязательные ветки присутствуют: transport failure (остаётся в очереди, ретрай с backoff), business rejection (удаление из очереди + ошибка в UI), успех (executor идемпотентен по client-UUID → журнал → подтверждение → удаление из очереди).

### §4.2 Tool-call + политика подтверждений

Контракт: PRD 01 §7.10 (политика подтверждений, решение D6), §7.7 (транспорт чата — обычная мутация, ответ целиком, решение D7).

```mermaid
sequenceDiagram
    actor User as Пользователь
    participant Web as apps/web (чат)
    participant TRPC as apps/server: tRPC ai-роутер (§9.1)
    participant LLM as apps/server: LLMProvider (§7.7)
    participant Executor as apps/server: executor / реестр тулов (§9.2)
    participant Policy as apps/server: политика подтверждений (§7.10)
    participant DB as PostgreSQL

    User->>Web: сообщение
    Web->>TRPC: ai.sendMessage (tRPC-мутация, без стриминга — D7)
    TRPC->>LLM: chat(context, tools)
    LLM-->>TRPC: tool-call
    TRPC->>Executor: validate envelope + validate aspects (стадии 1-2)
    Executor->>Policy: классификация уровня после структурной валидации

    alt execute
        Policy-->>Executor: execute
        Executor->>DB: apply in transaction + audit (стадии 3-7)
        Executor-->>TRPC: карточка + запись в журнале — постфактум
    else preview
        Policy-->>Executor: preview
        Executor->>DB: apply in transaction + audit
        Executor-->>TRPC: результат + информационный diff-предпросмотр
    else explicit-confirmation
        Policy-->>Executor: explicit-confirmation
        Executor-->>TRPC: сохранённый immutable payload — ничего не записано в граф и в журнал
        TRPC-->>Web: карточка-запрос подтверждения
        Web-->>User: показывает запрос
        User->>Web: подтверждает
        Web->>TRPC: approve(payload_id)
        TRPC->>Executor: ревалидация текущего состояния сохранённого payload
        Executor->>DB: apply in transaction + audit — без повторного вызова модели
        Executor-->>TRPC: карточка + запись в журнале
    else forbidden
        Policy-->>Executor: forbidden
        Executor-->>TRPC: структурированная ошибка до исполнения
    end

    TRPC-->>Web: ответ целиком, одним пакетом (D7)
    Web-->>User: отображение ответа
```

Четыре ветки уровня присутствуют (execute / preview / explicit-confirmation / forbidden); ветка `explicit-confirmation` показывает сохранённый immutable payload → одобрение пользователя → ревалидацию состояния → исполнение без повторного вызова модели, как того требует §7.10. Ответ — целиком, одним пакетом, без стриминга (D7).

### §4.3 MCP-polling «что нового»

Контракт: PRD 01 §9.3 (второй эталонный сценарий MCP-агента).

```mermaid
sequenceDiagram
    actor Agent as MCP-агент (внешний)
    participant MCP as apps/server: MCP-сервер (§9.3)
    participant Executor as apps/server: executor / реестр тулов (§9.2)
    participant DB as PostgreSQL

    loop polling "что нового"
        Agent->>MCP: entity_query(updated_at > cursor) [аутентификация PAT]
        MCP->>Executor: entity_query
        Executor->>DB: SQL-запрос по updated_at (§6.1)
        DB-->>Executor: изменённые сущности
        Executor-->>MCP: список кандидатов
        MCP-->>Agent: изменённые задачи

        Agent->>MCP: entity_get(id, include:["thread"])
        MCP->>Executor: entity_get
        Executor->>DB: чтение сущности + сообщений треда
        DB-->>Executor: данные + история треда
        Executor-->>MCP: сущность + инструкции владельца из треда
        MCP-->>Agent: данные

        Agent->>Agent: выполняет работу (вне Orbis)

        Agent->>MCP: entity_update(id, aspects.status) + заметка в тред
        MCP->>Executor: конвейер 7 стадий (актор = агент)
        Executor->>DB: apply in transaction + audit
        Executor-->>MCP: карточка + запись в журнале (actor=agent)
        MCP-->>Agent: подтверждение

        Agent->>Agent: обновляет cursor у себя
    end
```

Обязательные элементы присутствуют: `entity_query(updated_at > cursor)` с PAT-аутентификацией, изменённые задачи, `entity_get(include:["thread"])`, инструкции владельца из треда, `entity_update(status)` + заметка в тред, прохождение через executor и запись в журнал с актором-агентом; курсор хранится у самого агента, не на сервере Orbis (§9.3).

### §4.4 Optimistic-check body

Контракт: PRD 01 §5.2 (конкурентность, optimistic-check по `updated_at`).

```mermaid
sequenceDiagram
    actor TabA as Вкладка A
    actor TabB as Вкладка B
    participant TRPC as apps/server: tRPC entity.update/get (§9.1)
    participant DB as PostgreSQL

    TabA->>TRPC: entity.get(id)
    TRPC->>DB: SELECT
    DB-->>TRPC: updated_at = t0
    TRPC-->>TabA: сущность (updated_at = t0)

    TabB->>TRPC: entity.get(id)
    TRPC->>DB: SELECT
    DB-->>TRPC: updated_at = t0
    TRPC-->>TabB: сущность (updated_at = t0)

    TabA->>TRPC: entity.update(body, updated_at = t0)
    TRPC->>DB: optimistic-check: серверный updated_at == t0?
    DB-->>TRPC: совпадает — применить, новый updated_at = t1
    TRPC-->>TabA: успех (updated_at = t1)

    TabB->>TRPC: entity.update(body, updated_at = t0)
    TRPC->>DB: optimistic-check: серверный updated_at == t0?
    DB-->>TRPC: не совпадает (сейчас t1)
    TRPC-->>TabB: 409, структурированная ошибка "устаревшая версия"

    TabB->>TRPC: entity.get(id) — перезагрузка сущности
    TRPC->>DB: SELECT
    DB-->>TRPC: updated_at = t1
    TRPC-->>TabB: сущность (updated_at = t1)

    TabB->>TRPC: entity.update(body, updated_at = t1) — повтор правки
    TRPC->>DB: optimistic-check: серверный updated_at == t1?
    DB-->>TRPC: совпадает — применить, новый updated_at = t2
    TRPC-->>TabB: успех (updated_at = t2)
```

Обязательная последовательность присутствует: обе вкладки читают `updated_at = t0`, первая правит успешно (`t1`), вторая получает 409 «устаревшая версия», перезагружает сущность и повторяет правку успешно.

---

## §5. ER-схема

Восемь таблиц — состав и колонки скопированы из PRD 01 §4 (Task 1) без добавлений и без пропусков; версионных или репликационных служебных полей на сущностях нет, владение — `owner_id` (PRD 01 §4.10).

```mermaid
erDiagram
    entities {
        uuid id PK
        uuid owner_id
        text title
        text emoji
        text body
        text_array body_refs
        text_array tags
        jsonb meta
        jsonb aspects
        timestamptz created_at
        timestamptz updated_at
        boolean archived
    }

    relations {
        uuid id PK
        uuid source_id FK
        uuid target_id FK
        text relation_type
        jsonb meta
        timestamptz created_at
        timestamptz updated_at
    }

    aspect_definitions {
        text id
        uuid owner_id
        text name
        text namespace
        text description
        text icon
        jsonb schema
        text ai_instructions
        text_array tag_mappings
        jsonb aggregations
        jsonb view_config
        timestamptz created_at
    }

    user_settings {
        uuid owner_id PK
        text plan
        text timezone
        text defaultCurrency
        text weekStartDay
        jsonb tagColors
        text_array installedViews
        jsonb pinnedEntities
        jsonb viewPreferences
        timestamptz updated_at
    }

    chat_threads {
        uuid id PK
        uuid owner_id
        uuid entity_id FK
        text title
        boolean archived
        timestamptz created_at
        timestamptz updated_at
    }

    chat_messages {
        uuid id PK
        uuid thread_id FK
        text role
        text content
        jsonb metadata
        timestamptz created_at
    }

    ai_usage {
        uuid owner_id PK
        date date PK
        text model PK
        bigint input_tokens
        bigint output_tokens
        integer request_count
    }

    entity_origins {
        uuid id PK
        uuid owner_id
        uuid entity_id FK
        text namespace
        text external_id
        timestamptz created_at
    }

    entities ||--o{ relations : "source_id"
    entities ||--o{ relations : "target_id"
    entities ||--o{ entity_origins : "entity_id"
    entities |o--o| chat_threads : "entity_id (nullable, глобальный тред = NULL)"
    chat_threads ||--o{ chat_messages : "thread_id"
```

Примечания к схеме:

- `aspect_definitions.id` не является surrogate PK: уникальность обеспечивают два partial unique index — `UNIQUE (id) WHERE owner_id IS NULL` для встроенных аспектов и `UNIQUE (owner_id, id)` для кастомных (PRD 01 §4.3). На диаграмме `id` намеренно не помечен `PK`.
- `ai_usage` — составной первичный ключ `(owner_id, date, model)`, без собственного суррогатного `id` (PRD 01 §4.7).
- `chat_threads.entity_id` — nullable: `NULL` означает глобальный тред пользователя (мессенджер-модель), не связанный ни с одной сущностью; связь `entities |o--o| chat_threads` на диаграмме относится только к тредам сущностей — не более одного треда на сущность (PRD 01 §4.5).
- Типы `text_array` на диаграмме соответствуют Postgres `text[]` (ограничение синтаксиса Mermaid ER на символы в имени типа); `date`, `jsonb`, `bigint`, `boolean`, `timestamptz` — типы колонок как в PRD 01 §4.
- Владение — `owner_id` на каждой таблице, где оно применимо (кроме `relations` и `chat_messages`, чьё владение резолвится транзитивно через связанные `entities`/`chat_threads` — RLS-политика PRD 01 §4.10).

---

## §6. Граница детализации

Этот документ фиксирует структуру: какие модули существуют, кто кого вызывает, где живёт каждый контракт PRD. Детализация до уровня классов, функций, сигнатур tRPC-процедур и конкретных файлов — задача implementation-плана каждого слайса, пишется just-in-time непосредственно перед стартом слайса (по образцу `docs/superpowers/plans/`), а не этого документа. Документ обновляется, когда меняется контракт PRD — состав таблиц (§4), поведение персистентности и конкурентности (§5), грамматика query-движка (§6), конвейер executor'а или реестр тулов (§9.2), политика подтверждений (§7.10) и т.п., — а не при рефакторинге кода, не меняющем наблюдаемое поведение системы. Если реализация слайса вскрывает несоответствие между этой картой и кодом при неизменном PRD, правится код, а не эта карта.
