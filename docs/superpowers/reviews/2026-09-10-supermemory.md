# Разбор рынка: Supermemory — «память и контекст-движок для AI»

| Поле | Значение |
|---|---|
| Дата | 2026-09-10 (факты сняты вечером 10.09; записано 11.09) |
| Источник | вопрос владельца: `github.com/supermemoryai/supermemory` — «какие идеи можем взять себе» |
| Статус | разбор + вердикт «как зависимость — нет, как источник конструкций — да», семь идей к перенятию (И1–И7), пять подтверждений (П1–П5), «что не берём»; **в спеки не внесено** — у каждой идеи адрес-кандидат, решение за владельцем |
| Проверено | репозиторий `supermemoryai/supermemory` (README, `CLAUDE.md`, `apps/mcp`, `apps/docs` — концепты, recall, профили, правила, биллинг, SMFS), репозиторий плагина `supermemoryai/claude-supermemory` (хуки, агент, README), пост основателя «Memory on the harness level» (06.2026), GitHub API — на 2026-09-10; формулировки в кавычках — дословные |
| Индекс | все разборы рынка и их адреса — `docs/superpowers/reviews/market-scan-index.md` |
| Оговорка | **движок памяти в открытом репозитории отсутствует**: там консоль, MCP-сервер, доки, SDK и визуализация графа; модель памяти описана по документации, а не по коду — все утверждения о «как оно внутри» опровергаемы. Раунд 5 (20.08) упоминал Supermemory одной строкой («рынок памяти $50M+»), это первый полный разбор |

---

## Что это

**Supermemory** (`supermemory.ai`, MIT, 29,6k★, 2,6k форков, репозиторий с 27.02.2024, последний
пуш 10.09.2026) — «State-of-the-art memory and context engine for AI»: хостинговый API (плюс
бинарник `supermemory local` на `localhost:6767`), который принимает сырые документы и переписки,
**сам извлекает факты**, строит из них «живой граф фактов поверх фактов», держит профиль
пользователя (static + dynamic) и отдаёт гибридный поиск «RAG + память». Самоописание —
«research lab building the engine, plugins and tools around it»; заявляет #1 на LongMemEval,
LoCoMo и ConvoMem («95% Recall@15 при 99,4% сокращении контекста», «~50ms user profiles») —
цифры вендора, бенчмарк-фреймворк MemoryBench тоже его.

| Факт | Значение |
|---|---|
| Что в открытом репозитории | `apps/web` (консоль, Next.js), `apps/mcp` (Hono на Cloudflare Workers, MCP `2026-07-28`, OAuth, MCP Apps-виджеты), `apps/docs` (Mintlify), плейграунды, SDK-обёртки (Vercel AI SDK, LangChain, Mastra, OpenAI Agents, Pipecat, Cartesia…), `packages/memory-graph` (canvas-визуализация), `skills/supermemory`. **Не там**: сам API/движок — `CLAUDE.md` описывает API на Workers с Hyperdrive/AI/KV/Workflows, но каталога `apps/api` нет |
| Движок (по докам) | «custom learning model and a graph database that we built internally… Fact-based temporal graph that has Vector, FTS, and graph built in»; на облаке модель извлечения не настраивается, при self-host — своя через env |
| Единицы | **document** (сырой ввод: переписка, PDF, URL, файл коннектора) → пайплайн `queued → extracting → chunking → embedding → indexing → done` → три выхода в одном `containerTag`: **chunks** (для RAG), **memories** (извлечённые факты), **profile** |
| Dreaming | вторая фаза — «когда содержимое проходит через модель памяти и сливается, раскладывается и организуется на будущее». `dynamic` (по умолчанию: связанные документы группируются, «memories form from coherent units», извлечение может продолжаться **после** `done`) и `instant` (документ «снится» сам по себе, сразу; +1 платная операция) |
| Связи между фактами | `updates` (новый факт **заменяет** старый для поиска, история остаётся, `isLatest`), `extends` (дополняет, оба валидны), `derives` (движок **выводит** факт, который нигде не сказан; помечен `isInference`, **занижен в поиске до подтверждения**) |
| Типы | facts («persists until updated»), preferences («strengthens with repetition»), episodes («decays unless significant») |
| Забывание | «time-based» (временные факты выпадают после даты: «exam tomorrow»), «contradiction» (updates побеждают), «noise filtering»; ручное — soft-delete `isForgotten` + `forgetReason`; **forget-matching**: запрос → семантические кандидаты → «an LLM decides which memories are genuinely about your target» → `dryRun` → применить **по id** из превью; `threshold`, `maxForget` (100 по умолчанию, ≤500), `forgetBatchId` на каждой забытой |
| Очередь ревью | `GET …/inferred` — выведенные факты, ждущие решения, сортировка по `parentCount` (сколько родителей — «higher = stronger signal»); `approve` / `decline` / `undo`; «no separate skip action… the memory simply stays in the queue»; UI-рекомендация — swipe с undo |
| Профиль | **static** («always true», имя, роль, «prefers dark mode») + **dynamic** (что делает сейчас) + **buckets** — третья ось «по теме» (`preferences`, `goals`, `work`…), классификатор раскладывает факты по описанию бакета; org-уровень + space-уровень (add-only, при коллизии побеждает org); пресеты 12 бакетов; старые факты периодически сворачиваются в `[Summary]`, новые — `[Recent]` с датой |
| Изоляция | `containerTag` — «hard isolation boundary», хешируется в отдельный vector namespace, одновременно **граница авторизации** (scoped API keys, member restrictions: чужой тег → 403); внутри тега — `metadata`-фильтры; теги можно **merge** |
| Настройка извлечения | org-уровень: `filterPrompt` (≤750 симв., «Index: … Skip: …»), `categories`, include/exclude; per-tag: `entityContext` (≤1500 симв., «picture a third person watching a conversation between two people: what do they remember, and about whom?») |
| Поиск | `searchMode` memories / hybrid / documents; `threshold` 0,5; `rerank` (+100 ms); `rewriteQuery`; `include: {documents, summaries, relatedMemories, forgottenMemories}` |
| SMFS | «Memory your agent can grep»: контейнер монтируется каталогом (NFSv3/FUSE) или виртуальным bash-тулом; `grep` без флагов — семантический, с флагами — настоящий; виртуальный `profile.md` в корне; заявка «3,0× fewer tokens on Claude» на их же xAFS |
| Биллинг | метры: токены **новые** (diff billing по `customId`: повторно присланный префикс переписки бесплатен), поисковые запросы, «операции» (`instant` dreaming и прочее); $0,005/1K memory-токенов текста, $0,10/1K операций; месячные кредиты без переноса |
| MCP-сервер | тулы, **видимые модели**: `search_memory`, `listDocuments`, `getDocument`, `listMemories`, `listSpaces`, `whoAmI`, `add_memory` (save/forget); лаунчеры MCP Apps: `select-space`, `memory-graph`, `guided-save`, `upload-file`; **app-only, скрытые от модели**: `set-active-tag`, `save-memory`, `prepare-file-upload`, `fetch-graph-data`; ресурсы `supermemory://profile`, `supermemory://spaces`; промпт `context`. Свежий `McpServer` на каждый HTTP-запрос, без протокольной сессии; активный space — в Durable Object по `organizationId + userId`; явный `containerTag` в вызове «applies only to that call. It does not mutate the active space» |
| Плагин Claude Code | `claude-supermemory` (MIT, последний коммит 05.09.2026) — четыре хука: `SessionStart` → профиль (static/dynamic, по 5 строк) + «welcome back — last session here 3h ago»; `UserPromptSubmit` → **поиск делает сам хук**, не модель («recall happens on every substantive prompt instead of only when the model chooses to spend a tool call»): top-5, порог 0,55, ≤300 символов на строку, дедуп по хешу в пределах сессии, пропуск промптов короче 12 символов и начинающихся с `/ ! #`; `PreToolUse` → автоодобрение read-only тулов; `Stop` → асинхронный захват новых реплик транскрипта (маркер последней захваченной записи на сессию, `customId = sessionId`, `entityContext` про агента, метка `sm_scope` personal/project); опционально «signal extraction» — захват только вокруг ключевых слов (`remember`, `decision`, `bug`, `fix`) с N репликами до. Контейнер — хеш нормализованного git remote (общий для Claude Code/Codex/OpenCode). Агент `context-gatherer`: веер поисков с разных углов, бриф ≤300 слов с относительным возрастом («[3d ago, repo] chose Drizzle over Prisma»), «every claim you return must come from a retrieved memory» |

### Их собственные «правила» (страница `concepts/rules`, сжато)

- «**Send what you would send to a human for memory**… You should not be ingesting database records
  or CSVs». Таблица «где чему место»: «Sarah prefers async updates» → память + профиль; «the Q3
  planning doc» → документы; «Invoice #4821, total $1,340.50, status paid» → **ваша база**;
  «Answer in the user's language» → **системный промпт**.
- «**Supermemory is not your system of record.** There's no SQL over memories, no joins, no
  aggregates, no querying by primary key. Keep transactional data in your database, and ingest
  the narrative *around* it».
- «Embrace a little noise… it returns an average of 10 tokens per fact, so even 50 facts is just
  500 tokens of context, cheap enough to stay generous».
- Харнесс персонального агента: «Session start hook → load profile; On-message hook → enrich the
  prompt with search; On-stop hook → save the conversation».

### Матрица основателя («Memory on the harness level», 06.2026)

Две оси — **токены в окне** и **латентность хода**. Запоминание: explicit (тул `remember()`,
«blind write», модель не знает, что уже есть) против implicit (наблюдатель вне горячего пути,
«dreaming job», дорого и eventually-consistent). Recall: explicit (агент ищет сам, «searching
until it does» — качество за латентность) против implicit (харнесс ищет по сообщению до вызова
модели — «one fixed hop», ломается на «hi»). Профиль — «**push, don't pull**»: static + dynamic,
«stays extremely small… stable enough to be prompt-cacheable». Рекомендация по типам: личный
ассистент → implicit write + pushed profile + implicit recall; кодовый агент → explicit с обеих
сторон + файловая система.

---

## Что у Orbis на тех же местах (факты на 2026-09-10)

| Место | Как устроено сегодня | Адрес |
|---|---|---|
| Единица памяти | `orbis/memory`-сущность: `memory_kind` fact\|rule, `rule_scope` (ссылка на **контракт**, пусто = глобально), `rule_pattern`, `rule_target` (ссылка на категорию; правило без цели незаписываемо, fail-closed) [D43] | `01-architecture.md` §3.7 |
| Видимость | обычные сущности: Browser, экран «Память AI» = Browser с фильтром по аспекту; архивация = исключение из контекста | `02-core-os.md` §2.7 |
| Инжекция | слой 2 из пяти: **все** активные записи, кап 50, сортировка `rule` → scoped → `updatedAt` desc → id; одна строка на запись с превью body 200 символов | `apps/server/src/llm/context.ts` (`loadMemory`, `memoryLine`, `MEMORY_CAP`) |
| Спека vs код | §7.4: при переполнении «приоритет правилам и **недавно использованным**» — сигнала использования в коде нет (grep `last_used`/`usedAt` по `memory/`, `llm/` — пусто); прокси — `updatedAt`, то есть время **правки**, не применения | §7.4; `context.ts:293-301` |
| Пополнение | только явно: «запомни» → карточка [Запомнить]/[Не надо]; AI предлагает факт из разговора по подтверждению; **эскалация** — два одинаковых исправления категории за 30 дней (скан журнала, без отдельного состояния) → предложение правила; отказ — новое сообщение `memory_rule_declined` | §7.2, §7.4, §7.8; `apps/server/src/ai/escalation.ts` |
| Принцип | «**Диалоги эфемерны, знания живут в графе**… По умолчанию — изоляция: содержимое треда никуда не утекает без явного действия» | §7.2 |
| Один селектор | предикат активной памяти один на четырёх потребителей (быстрый ввод, резолв импорта, гейт эскалации, слой промпта); правила применяются **детерминированно** в fast-path по границе токенов | `apps/server/src/memory/select.ts`; §7.5 |
| Срок и связи | память бессрочна; связей между записями нет; версии body — `entity_versions`; бэклог-идея `valid_until` (Semantica) ждёт «следующей работы над памятью» | `reviews/2026-08-16-memory-validity-backlog.md` |
| История треда | rolling-окно 30 сообщений, **summary не реализован** (решение 6 плана 1b, «до реального переполнения») | `context.ts:13-15` |
| Бюджет | слой 1 — **3 055** токенов, слой 5 (тулы) — **5 521** (замер 25.08, промпт v4); цель слоя 2 — 1–2K | §7.1 |
| Кэш промпта | явных меток кэша нет (grep `cache_control`/`cacheControl` по `apps/server/src/llm` — пусто; для Anthropic через AI SDK они обязательны, OpenAI кэширует префикс сам) | `apps/server/src/llm/ai-sdk.ts` |
| MCP | тонкий адаптер над `dispatchTool`: `capabilities: { tools: {} }` — **ни ресурсов, ни промптов**; внешний агент видит память владельца только если сам догадается спросить `entity_query` по аспекту | `apps/server/src/mcp/server.ts:52` |
| Пачка решений | D42: отложенный чекпойнт — предложения копятся и решаются пачкой; Ш1: правка предложения до принятия | D42, D41 |
| Рутины | V1: планировщик, прогоны, предложения с триггером, `ai_usage` — расход виден | `project-orbis-v1-routines` |
| Миссия | анти-цели: «не чёрный ящик» (каждое действие видно и обратимо), «не клетка для данных», «не ещё один трекер»; D36 — «захват бесплатно / понимание платно», AI только платно | `05-mission.md` §5; D36 |

---

## Использовать напрямую? Три точки входа и вердикт по каждой

**А. Supermemory как бэкенд памяти Orbis (вместо `orbis/memory`-сущностей).** — **Нет.**
У Orbis правило — не текст, а **структура**: `rule_pattern` + ссылка `rule_target`, которую
детерминированно читают fast-path, резолв импорта и гейт эскалации; ссылка переживает
переименование категории, а backlinks категории показывают её правила. У Supermemory memory —
строка «John prefers dark mode» без ссылок в чужой граф, и они сами пишут: «not your system of
record… no querying by primary key». Дальше — три анти-цели разом: движок закрыт и «сам решает,
что и когда забыть» (не чёрный ящик), данные уезжают в чужой namespace (не клетка для данных;
self-host существует, но бинарником), и второй счётчик стоимости поверх токенов модели (D36).
Пользователь один, память — десятки записей: инфраструктура для «10M memories per container»
здесь ничего не решает.

**Б. Наблюдатель над тредами (их «implicit write»/dreaming) — чтобы память росла сама.** —
**Нет как механизм по умолчанию**, и это решение спеки, а не вкус: §7.2 «по умолчанию —
изоляция», анти-цель 3. Их же пост честно называет цену: «costs real inference… reasoning over the
transcript every time», «freshness is eventually-consistent», «building the observer well is its
own hard problem». Ограниченная форма, совместимая с рамками, — И7 (рутина, opt-in, через пачку
решений).

**В. Обратное направление: Orbis как память для агентов владельца.** — **Да, шов дешёвый.**
Самое полезное в их MCP — не тулы, а **ресурс `supermemory://profile` и промпт `context`**:
агент получает «что должен знать всегда» без единого вызова. У Orbis MCP отдаёт только тулы, и
внутренний AI знает больше внешнего (слои 1–2 у него есть, у Claude Code — нет). Это И5, и он
ложится на «единый контур для внутреннего и внешнего AI» (Tana, раунд 5).

**Итог:** как зависимость и как «сам запоминает» — нет; как источник конструкций — семь идей,
из них три (И1, И3, И5) — правки в один-два файла без новой инфраструктуры.

---

## Идеи к перенятию

### И1. Слой 2 как кэшируемый префикс: стабильный порядок вместо `updatedAt`

**У них:** профиль обязан быть «stable enough to be prompt-cacheable, so you aren't re-billed for
it on every call» — это названо одним из пяти требований к профилю.

**У нас:** `loadMemory` сортирует записи `rule → scoped → updatedAt desc`; любая правка любой
записи памяти (а также принятие нового факта) **переставляет** слой 2, а за ним идут слои 3–4.
Постоянная часть промпта — слой 1 (3 055) + тулы (5 521) + память (до ~2K) — порядка **10K
токенов на каждый ход**, и явных меток кэша в `llm/` нет. Замечание к бюджету: их «10 токенов на
факт» против нашей строки с превью body до 200 символов — при капе 50 слой 2 может весить ~3K,
выше цели §7.1; это повод для замера, не для правки.

**Взять:** (а) сортировать слой 2 по стабильному ключу (`kind`, `scope`, `id`), а свежесть
применять только к **отсечке** при переполнении — все ≤50 записей всё равно инжектятся, порядок
внутри ничего модели не сообщает; (б) поставить точку кэша после слоя 2 (`providerOptions.anthropic.cacheControl`
в `ai-sdk.ts` — одна строка; у OpenAI префикс кэшируется автоматически, стабильный порядок нужен
обоим); (в) снять из `ai_usage` долю cache-read токенов до/после.

**Адрес-кандидат:** `apps/server/src/llm/context.ts` (`loadMemory`), `llm/ai-sdk.ts`; §7.1 —
примечание к бюджетам. **Цена:** часы; риск — только измеримый.

### И2. Срок годности и тип записи в карточке предложения

**У них:** три типа с разной судьбой — facts «persists until updated», preferences «strengthens
with repetition», episodes «decays unless significant»; «temporary facts drop after they expire
("exam tomorrow", "meeting at 3pm today")». Срок ставит **движок**.

**У нас:** память бессрочна; бэклог `valid_until` (Semantica) ждёт «следующей работы над
памятью»; карточка [Запомнить]/[Не надо] не несёт даты; «эпизоды» в спеке не различены.

**Взять:** (а) предлагающая сторона (модель в чате, эскалация, будущая рутина И7) заполняет
`valid_until`, когда факт временный («на этой неделе из дома» → воскресенье), владелец видит и
правит дату **в карточке до принятия** (Ш1 — правка до принятия уже есть); (б) фильтр
`valid_until IS NULL OR valid_until >= today` — в единый предикат `memoryEntitiesWhere()`, и все
четыре потребителя получают его разом; (в) правило для промпта предложения: **эпизод — не
память**: «встречался с Алексом во вторник» — сущность графа (событие, заметка), а не
`orbis/memory`; модель не предлагает эпизоды как факты. Полный bi-temporal по-прежнему не берём
(D11-довод бэклога держится).

**Адрес-кандидат:** `reviews/2026-08-16-memory-validity-backlog.md` (расширить), §3.7 (поле),
`memory/select.ts`, карточка `memory_rule_suggestion`, экран §2.7 (секция «истёкшие»).

### И3. «Заменяет» в предложении факта: `updates`-связь вместо соседства противоречий

**У них:** «"I just moved to SF" supersedes "I live in NYC"»; связь `updates`, `isLatest`,
«history can remain for audit»; ручной `PATCH` создаёт **новую версию**, старая — `isLatest=false`.

**У нас:** новый факт предлагается и создаётся рядом со старым; оба активны — **оба в слое 2**,
противоречие живёт в промпте, пока владелец не заметит его на экране «Память AI». При этом все
≤50 записей **уже в контексте модели** в момент предложения — искать заменяемую запись нечем не
нужно: модель может назвать её id прямо в вызове предложения.

**Взять:** необязательное поле `supersedes: <id>` в payload предложения факта/правила; карточка
показывает «заменит: «…»»; по принятию — **одна пачка** `batch_execute`: создать новую запись +
архивировать старую (или `valid_until = сегодня` по И2) + ребро роли `supersedes` (память →
память, ацикличность §4.2), чтобы история была видна backlinks'ами; Undo пачки возвращает обе.
Для правил — тот же ход поверх сегодняшнего дедупа по `counterpartySimilarity`: «правило для
«бар» уже есть — заменить?». Это малая форма идеи Graphiti из раунда 5 (п. 6, «инвалидация
штампом вместо удаления»).

**Адрес-кандидат:** §7.4 «Пополнение», §4.2 (роль `supersedes`), `ai/escalation.ts`, типы
карточек. **Цена:** поле + роль + одна пачка; без новой инфраструктуры.

### И4. Учёт использования памяти — закрыть разрыв «недавно использованным»

**У них:** preferences «strengthen with repetition», episodes «decay unless significant», очередь
ревью ранжирована по `parentCount`; плагин просит модель помечать использованные воспоминания
префиксом ◪ («When one of these shapes your answer, credit it naturally»), статуслайн считает
загруженные/вспомненные.

**У нас:** §7.4 обещает приоритет «недавно использованным», код сортирует по `updatedAt`;
сигнала применения нет ни у правил, ни у фактов. Раунд 5 уже записал: «мы вбрасываем память в
треды и не мерим, использовалась ли она» (ревалидация, стр. 149) — адреса решения тогда не было.

**Взять:** два сигнала разной цены. (1) **Детерминированный, бесплатный** — правила: fast-path,
резолв импорта и LLM-путь знают, какое правило сработало; писать `applied_rule_ids` в запись
действия журнала (§7.8, журнал уже есть — новое поле, не новое состояние); из него — «применялось
N раз, последний раз 03.09» на экране §2.7 и реальный приоритет при переполнении. (2) **Самоотчёт
модели** для фактов — их ◪-конвенция: дёшево, но ненадёжно и стоит токенов ответа; брать только
если (1) окажется недостаточным. Побочный выигрыш: «мёртвые» факты становятся видны владельцу
(«не применялось 90 дней») — забывание **по решению человека**, не движка.

**Адрес-кандидат:** §7.4, §7.8 (`ActionRecord`), §2.7 (колонка «применялось»), `memory/select.ts`
(приоритет отсечки).

### И5. `orbis://context` — профиль владельца для внешних агентов (MCP-ресурс + промпт)

**У них:** ресурс `supermemory://profile`, промпт `context` («Profile and recent context»),
плагин инжектит профиль на `SessionStart`, команда `/context`; принцип «push, don't pull: what the
agent should always know, no matter how old it is».

**У нас:** MCP объявляет `capabilities: { tools: {} }`. Внутренний AI получает слои 1–2 (инструкции
аспектов, память), внешний Claude Code — ничего, пока не спросит сам; спросить `entity_query` по
`orbis/memory` он не догадается.

**Взять:** отдать **тот же рендер** слоёв 1–2 ресурсом `orbis://context` и MCP-промптом
`context` (хосты Anthropic показывают ресурсы и промпты) — под `withIdentity`, read-only, тем же
кодом `context.ts`. Внутренний и внешний AI начинают с одного «профиля»; это же закрывает
половину вопроса «MCP-клиент не знает правил владельца» без второй копии логики.

**Адрес-кандидат:** `apps/server/src/mcp/server.ts` (capabilities `resources`/`prompts` + два
обработчика), §9.3. **Цена:** часы. **Оговорка:** применяются ли memory-правила к записям через
MCP на стороне сервера — в этом разборе не проверялось.

### И6. Предварительный отбор сущностей по сообщению — «неявный recall» над графом, детерминированный

**У них:** хук `UserPromptSubmit` ищет **до** вызова модели по сырому промпту (top-5, порог
0,55, дедуп в сессии, пропуск коротких); пост: «one fixed hop instead of an open-ended loop…
For an assistant, fast and good-enough beats slow and perfect».

**У нас:** слой 3 — только открытая сущность/view; каждое упоминание сущности в чате («добавь
500 к бюджету на еду») стоит модели вызова `entity_query` — ход туда-обратно плюс токены вызова
и результата. При этом fast-path уже матчит токены детерминированно, а алиасы категорий
многоязычны (D36).

**Взять:** перед вызовом модели сопоставить токены сообщения с заголовками и алиасами сущностей
владельца и положить до N кандидатов в слой 3 строками «id — title (аспекты)» — модель берёт id
без поиска. Без эмбеддингов: FTS/триграммы Postgres. **Сначала проба** по образцу P1–P3: сколько
ходов чата ведут к `entity_query` по заголовку (журнал/`ai_usage`); если редко — не строить.
Дедуп в пределах треда, как у плагина. Оговорка из `select.ts`: под RLS GIN-индексы не берутся
(не-leakproof операторы) — план надо мерить, а не предполагать.

**Адрес-кандидат:** §7.1 слой 3, `context.ts` (`anchorBlock`). **Цена:** проба — часы; реализация
— день.

### И7. «Сновидение» как рутина: дозревание памяти вне горячего пути, но через пачку решений

**У них:** dreaming — наблюдатель вне горячего пути: «the profile keeps getting better while
nobody's waiting on it»; цена названа ими же (инференс над транскриптом, eventual consistency,
чёрный ящик).

**У нас:** §7.2 — только явный перенос; V1 — рутины с прогонами и предложениями; D42 — пачка
решений; `ai_usage` — расход виден.

**Взять:** рутина «разбор недели» **по умолчанию выключена**; включение владельцем — то самое
«явное действие» §7.2. Прогон читает треды и журнал за N дней и кладёт в пачку решений
предложения: факты (с `valid_until` по И2), правила, `supersedes` (И3). В слой 2 ничего не
попадает до принятия; расход прогона виден. Три отличия от их dreaming, и все — из рамок:
opt-in, ревью до эффекта, **никаких `derives`** — каждое предложение ссылается на сообщение или
действие, из которого выведено (правило «предложение обязано ссылаться на триггер», Prime Agent,
раунд 1). Решение владельца: это добавляет к §7.2 четвёртый путь, пусть и выключенный.

**Адрес-кандидат:** каталог рутин V1, §7.2 (четвёртый путь, off by default), D42.

---

## Подтверждения (ничего не менять, отметить сходимость)

- **П1. Граф — система записи, память — маленькая.** Их же правило: «Supermemory is not your
  system of record… Keep transactional data in your database»; «give an agent tools to traverse
  the structure directly». Orbis стоит ровно в этом углу их матрицы — explicit recall тулами по
  графу плюс небольшой pushed-слой 2 — и это правильный угол для системы записи, а не отставание.
- **П2. Очередь ревью = D42, «identity is server-owned».** Approve/decline/undo, «skip… simply
  stays in the queue», «the LLM only ever references opaque handles for the memories a search
  returned, so it can never forget a memory outside the results it reviewed» — это §7.10
  «исполняется ровно то, что показали» и id из ответов тулов. Их forget-matching (`dryRun` →
  id → apply, `maxForget`, `forgetBatchId`) — независимо та же форма, что карточка подтверждения +
  `batch_execute` + Undo по `batch_id`.
- **П3. Область записи — ссылкой, а не классификатором.** Их buckets: третья ось «по теме»,
  классификатор по описанию, org → space add-only, при коллизии побеждает org. У Orbis
  `rule_scope` — ссылка на контракт, fail-closed, «пусто = глобально», и глобальные записи входят
  в любую область. Наследование «глобальное раньше локального» совпало; детерминизм — наш.
- **П4. Тулы, скрытые от модели.** `set-active-tag`, `save-memory`, `fetch-graph-data` — «available
  to the embedded MCP App and hidden from the model»; «explicit override applies only to that
  call» — это семейство `agentOnly` / `routineOnly` / `internalOnly` (§9.2, `user_query`).
  Усиливает П4 разбора A2UI: границы вызова — поле декларации с первого дня.
- **П5. `valid_until` — второй независимый источник.** Их «time-based forgetting» подтверждает
  бэклог 16.08 (Semantica): малая форма держится, полный bi-temporal по-прежнему не нужен.

---

## Что не берём

- **Supermemory как бэкенд, SDK или MCP для памяти Orbis** — вердикт А: правило-структура со
  ссылками, детерминированные потребители, анти-цели 3–4, второй счётчик (D36), закрытый движок,
  один пользователь.
- **Наблюдатель над тредами и `derives`** — §7.2, анти-цель 3. Orbis выводит только из
  свидетельств журнала (два одинаковых исправления), а не из «паттернов»: «Alex likely works on
  Stripe's core payments product» — догадка, которую владельцу пришлось бы разгребать в очереди
  ревью. Ограниченная форма — И7.
- **Эмбеддинги и семантический поиск по памяти** — ≤50 записей помещаются в промпт целиком;
  векторная инфраструктура наперёд (D11-довод). И6 — без эмбеддингов.
- **SMFS (память как файловая система)** — для кодовых агентов с реальной ФС; у Orbis поверхность
  — тулы; единственная полезная деталь («`profile.md` в корне») — это И5.
- **Buckets-классификатор** — `rule_scope` ссылкой точнее и бесплатнее.
- **Signal keywords плагина** (захват вокруг «remember/decision/bug/fix») — это наблюдатель-лайт;
  у Orbis «запомни:» уже ведёт в карточку, а всё остальное — И7 через пачку.
- **Diff billing** как модель — заметить для D36 («платить только за новые токены» — честная
  единица для будущей тарифной сетки), но биллинг вне скоупа.

---

## Опровергаемые утверждения этого разбора

1. «Движок памяти в открытом репозитории отсутствует» — по дереву `apps/` и `packages/` на
   2026-09-10 и по `CLAUDE.md`, описывающему отсутствующий API; исходники бинарника
   `supermemory local` не искались.
2. «У Orbis нет сигнала использования памяти» — по grep `last_used`/`lastUsed`/`used_at`/`usedAt`
   в `apps/server/src/memory` и `llm`; под другим именем мог быть.
3. «Кэш промпта у Orbis не используется» — по grep `cache_control`/`cacheControl` в
   `apps/server/src/llm`; OpenAI кэширует префикс без меток, так что для второго провайдера
   утверждение слабее.
4. «MCP Orbis не отдаёт ресурсов и промптов» — по `capabilities: { tools: {} }` в
   `mcp/server.ts:52`.
5. Бенчмарки «#1» и «3,0× fewer tokens» — цифры вендора на его же фреймворках; независимых
   замеров не искалось.
6. README плагина говорит «Reasoned recall — Claude decides whether recalling memory would
   help»; код `recall-directive.js` говорит обратное («Recall is performed HERE, not delegated
   to the model») — README отстаёт от кода; описано по коду.
7. Применяются ли memory-правила к записям через MCP на сервере — не проверялось (оговорка И5).

## Источники

- `https://github.com/supermemoryai/supermemory` — README, `CLAUDE.md`, `CONTRIBUTING.md`,
  `apps/mcp/README.md`, `apps/mcp/src/server/tools/*`, `packages/memory-graph`, `skills/supermemory`
- `https://supermemory.ai/docs` (исходники в `apps/docs`): `concepts/how-it-works`,
  `concepts/graph-memory`, `concepts/user-profiles`, `user-profiles/buckets`, `concepts/rules`,
  `concepts/container-tags`, `concepts/customization`, `recall/memory-operations`,
  `recall/memory-review`, `recall/search`, `ingestion/add-memories`, `overview/billing`,
  `overview/comparison`, `smfs/overview`, `integrations/claude-memory`, `agents-and-mcp`
- `https://github.com/supermemoryai/claude-supermemory` — README, `plugin/hooks/hooks.json`,
  `recall-directive.js`, `session-start.js`, `capture.js`, `recall-approve.js`,
  `agents/context-gatherer.md`
- `https://dhravya.dev/writing/memory-on-the-harness-level/` — пост основателя (06.2026)
- GitHub API `repos/supermemoryai/supermemory` — звёзды, лицензия, даты (2026-09-10)
