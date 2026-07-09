# Бэклог находок полного ревью репозитория (2026-07-09)

Ревью пяти срезов (security / executor+RLS / ops / AI-слой / web) пятью fable-агентами
плюс три адверсариальных верификатора, которым было поручено находки **опровергнуть**.
Опровергнуть не удалось ни одну значимую: вердикты 8/8 CONFIRMED (web), 8/8 CONFIRMED
(AI + security), 6 CONFIRMED + 2 PARTIAL (ops).

Всё исправленное — в коммитах `267dd8b..b68dd86` (merge `c3ec34a`), описания там же.
Этот файл фиксирует **то, что осталось**: иначе оно живёт только в транскрипте сессии.
Крупные архитектурные пункты продублированы в плане 1c-2, раздел «Осознанно НЕ починенное».

Формат: `[severity] [confidence ревьюера]` — место — суть — почему не чинили.

---

## Архитектурное (вход в слайс 2)

- **[Important] [high]** `apps/server/src/ai/send-message.ts:145-179` — **конкурентный ретрай
  во время первого прогона**. `appendMessageIdempotent` вернёт `replayed=true`, но
  `findAnswerByReplyTo` ещё пуст → запускается второй параллельный tool-цикл: двойное
  исполнение действий, двойной метеринг, два assistant-ответа с одним `replyTo` (`limit(1)`
  потом молча прячет второй). Окно — вся длительность цикла (десятки секунд), триггер —
  клиентский таймаут или повторный клик. *Нашли два ревьюера независимо.* Фикс требует либо
  advisory-lock на весь цикл (транзакция на минуты при пуле `max=3` — не годится), либо
  persist-маркера «in progress» и нового wire-статуса для UI. Тестов на конкурентный случай нет.
- **[Important] [high]** `send-message.ts` — **частичный цикл**. Сбой провайдера на шаге k+1
  после исполненных tool-шагов: действия применены, ответа нет. Легитимный ретрай §7.9 гонит
  новый полный цикл, и модель создаёт сущности повторно (`id` генерирует она сама).
  Митигация сейчас вероятностная: audit-строки прошлого прогона попадают в контекст. Тест
  `send-message.test.ts:504` **пиннит** текущее поведение — при фиксе его придётся переписать.
- **[Important] [med]** `apps/server/src/executor/executor.ts:799-861 (prepareAttach)` —
  **`attach orbis/budget` обходит «один budget-parent»** (§4.2/§13.7): инвариант энфорсится
  только в `relation_create`. Attach аспекта на сущность, уже являющуюся parent'ом финансовых
  транзакций, ретроспективно делает её вторым budget-parent'ом. Достижимо последовательно,
  публичным API.
- **[Important] [med]** `apps/server/src/llm/anthropic.ts:41-58` — **`refusal` → `end_turn`**.
  SDK мапит отказ модели в `content-filter`, мы сводим к `end_turn` + `console.warn`: отказ
  неотличим от успеха ни для кода, ни для UI. Осознанное решение Вехи 0 (трёхзначный
  `stopReason`), запиннено `anthropic.test.ts:108-123`. Расширение типа течёт по фикстурам.
- **[Minor] [med]** `executor.ts:672-686, 725` — **optimistic-check в пределах одной миллисекунды**.
  `updatedAt = clock()` не монотонен: два апдейта в один тик оставляют `updated_at` прежним,
  и stale-правка проходит проверку §5.2. Фикс: `max(now, prev+1ms)` либо целочисленный `version`.
- **[Minor] [med]** `db/migrations/0001_rls_and_indexes.sql:72-76,97` — **append-only
  `chat_messages` не энфорсится БД**: политика `FOR ALL` + `GRANT UPDATE, DELETE` позволяют
  владельцу под `authenticated` переписать audit-сообщения, undo-маркеры, receipts. Сейчас
  недостижимо (Data API off, tRPC-поверхности нет) — defense-in-depth.
- **[Minor] [med]** `executor/invariants.ts:84-129` — **экспоненциальный CTE ацикличности**:
  перечисляются все простые пути (`path`-массив вместо множества посещённых вершин).
  Ромбовидный blocks-граф из ~30 рёбер взрывает CPU/память Postgres и затыкает пул.

## Web-клиент (UI-хвосты)

- **[Important] [high]** `features/chat/ChatScreen.tsx:40-44` + `state/retry.ts:47-50` —
  контракт 02 §2.6 «тап по индикатору → список ожидающих, каждую можно отменить» **не
  реализован**: индикатор — некликабельный `div`, `cancel()` не привязан ни к какому UI.
- **[Important] [high]** `features/chat/useFastPath.ts:91-95` — **переход «⏳ ждёт отправки»
  → «⚡ без AI» после успешного flush не реализован**: ничто не патчит `fastPath.status`
  синтетического сообщения и не инвалидирует тред. Карточка живёт в кэше до первого refetch,
  а потом исчезает, пока запись ещё в буфере.
- **[Important] [med]** `state/retry.ts:60-69` — **нет ручного «отправить сейчас» и backoff**:
  ретрай только по событию `online` и на старте. Транспортный сбой при живой сети (5xx,
  таймаут) оставляет запись висеть до следующего offline→online цикла.
- **[Important] [med]** `auth/AuthProvider.tsx:26-31` — **UNAUTHORIZED → мгновенный `signOut()`**
  без попытки `supabase.auth.refreshSession()`: протухший токен посреди мутации (пробуждение
  ноутбука) убивает сессию и незавершённые optimistic-мутации.
- **[Important] [high]** `useFastPath.ts:123`, `useEntityDetail.ts:61`, `SmartListSave.tsx:16` —
  **дыры инвалидации §5.1**: `entity.update` (архив, чекбокс, аспекты) инвалидирует только
  `entity.get` этого id. Списки Browser, бейджи пинов и QueryBlock показывают устаревшее до
  30 c (`staleTime`, `refetchOnWindowFocus:false`). *(Частично закрыто: успешный fast-path
  create теперь инвалидирует `entity.query`/`count`.)*
- **[Important] [med]** `useChatThread.ts:72-76` — ветка `res.replayed` инвалидирует только
  тред и возвращается **до** `utils.entity.query.invalidate()`, хотя replay означает, что
  исходный ответ с созданными сущностями был потерян.
- **[Important] [med]** `features/chat/ChatScreen.tsx:14-19` + `OnboardingGate` — `ensureThread`
  зовётся один раз (`started.current`); при любой ошибке (в т.ч. офлайн-старт) — вечное
  «Открываем тред…» без ретрая. Холодный офлайн-старт блокирует fast-path, хотя §2.5/§7.5
  обещают быстрый ввод офлайн.
- **[Important] [med]** `vite.config.ts` (VitePWA `autoUpdate`) + `AuthProvider.tsx:49-69` —
  при `CLIENT_OUTDATED` `location.reload()` с активным SW сперва отдаст **старый** precache →
  снова 412 → цикл до второй перезагрузки. Нужен `registration.update()` + ожидание
  `controllerchange`.
- **[Important] [med]** `useFastPath.ts:133-135` — `reparse`: `update.mutate({archived:true})`
  fire-and-forget без `onError`, `sendMessage` уходит независимо от успеха архивации.
- **[Important] [med]** `useFastPath.ts:60-81` — онлайн fast-path-карточка не несёт
  `undoActionId` → кнопки Undo нет, вопреки §2.5.
- **[Minor] [high]** `QuickCapture.tsx:25`, `Subtasks.tsx:24`, `SmartListSave.tsx:15` —
  `id = newId()` на **каждый сабмит**: ручной повтор после transport-сбоя даёт новый UUID →
  дубль. Идемпотентность «повтор с тем же UUID» (§5.3) для quick_capture-путей не соблюдена.
- **[Minor] [med]** `QuickCapture.tsx:32-38` — падение `relation.create` после успешного
  `entity.create` оставляет сироту без parent-связи.
- **[Minor] [med]** `lib/retry-buffer/index.ts:41-47` — `flush` итерирует снапшот
  `storage.load()`: `cancel` во время in-flight не остановит отправку; два конкурентных
  `flush` шлют одни записи дважды (сервер сходится по clientId, но трафик двойной).
- **[Minor] [med]** `features/entity-detail/AspectCards.tsx:76-78` — `useState(initial)` в
  `AspectField` без resync: после внешнего изменения blur сохранит устаревшее значение
  поверх нового. *(Тот же класс дефекта, что починен в `BodyEditor`.)*
- **[Minor] [med]** `features/browser/query.ts:13` + `Filters.tsx:35` — пользовательский тег
  вставляется в грамматику без экранирования: тег с `,` или `|` ломает запрос.
- **[Minor] [low]** `state/retry-send.ts:19` — любой `CONFLICT` → `confirmed`, включая конфликт
  за занятый **чужой** id (executor стадия 5). С UUIDv7 вероятность ничтожна.
- **[Minor] [low]** `useChatThread.ts:19-20` — `upsertNewest` дедупит только первую страницу.
- **[Minor] [low]** `features/chat/cards/ErrorCard.tsx:7-9` — `isRetryable` по regex кода:
  `INTERNAL_SERVER_ERROR` не матчится → «Повторить» скрыт для 500 на LLM-пути.
- **[Minor] [low]** `AspectCards.tsx:11-15` — `coerce`: `Number('abc')` → `NaN` → JSON `null` →
  невнятная серверная ошибка.
- **[Minor] [low]** `state/retry.ts:30-33` — нет синхронизации между вкладками (`storage` event).
- **[Minor] [low]** `trpc.ts:56-57` — `VITE_API_URL` с завершающим слэшем даст `...//trpc`.
- **[Minor] [low]** `packages/shared/src/fast-path/index.ts` — correction-правила памяти
  (§7.5, `orbis/memory` kind=rule) в клиентский `ctx` не загружаются (память — слайс 2).

## Executor / RLS / данные

- **[Minor] [high]** `executor.ts:254-259, 619-644, 992-995` — идемпотентность batch по
  `batch_id` работает только «после коммита»: при полностью конкурентных одинаковых batch'ах
  проигравший конфликтует раньше — на вставке сущности (`CONFLICT id_conflict`) или связи
  (`23505 rel_uniq` → `INVARIANT`), вместо сохранённого результата (§7.8/§13.4).
- **[Minor] [med]** `executor.ts:103-125, 335-348, 1049-1053` — `declaredDerivedFromTargets`
  собирается до исполнения и **не корректируется**, когда тот же batch удаляет объявленную
  `derived_from` → обход §3.3 одним атомарным вызовом.
- **[Minor] [med]** `test/rls/rls.pgtap.sql` — пробелы матрицы: нет негативных проверок INSERT
  `chat_threads` с чужим `owner_id`; UPDATE/DELETE чужих `entities`; UPDATE `chat_messages` /
  `user_settings` / `ai_usage`; видимости чужих кастомных `aspect_definitions`; DELETE чужой
  relation. Регресс политики на этих глаголах пройдёт CI зелёным.
- **[Minor] [low]** `chat/messages.ts:87-96` — идемпотентный replay по client-UUID **не сверяет
  `threadId`**: повтор id, занятого своим сообщением в другом треде, вернёт то сообщение как успех.
- **[Minor] [low]** `executor.ts:632-643` — replay одиночного `entity_create` возвращает текущую
  строку из БД, а не исходный результат первой попытки (§13.2 дословно требует исходный).
- **[Minor] [low]** `executor/normalize.ts:57-69` + `executor.ts:819` — `attach_orbis_task` со
  `{status:'done'}` поверх уже done-задачи молча теряет `completed_at`.
- **[Minor] [low]** `policy/pending.ts:119-146` — при `dedupeKey` повтор того же `batch_id` с
  **изменённым** payload вернёт pendingId исходной карточки, но `card.summary` соберётся из
  нового payload: агент видит «5 операций», approve исполнит сохранённые 3.
- **[Minor] [low]** `executor/normalize.ts:14` — `BODY_REFS_RE` принимает любые 36 символов
  `[0-9a-f-]` (например `------…`) → мусор в `body_refs`.
- **[Minor] [low]** `wire.ts:47-49` — `toDate` парсит PG-строку `timestamptz` через
  `new Date(String(v))`: поведение engine-dependent, для микросекундных строк возможна потеря
  точности. Латентный риск (сейчас все `entities` пишутся явными ms-таймстампами).
- **[Minor] [low]** `executor.ts:672-676` — в batch «create → update того же entity с body»
  невыполним: `expectedUpdatedAt` обязателен и равен серверному `clock()` виртуальной строки,
  который вызывающему неизвестен. Модель не может самокорректироваться.

## AI-слой

- **[Minor] [med]** `llm/prompts/v1.ts:25` + `llm/context.ts:67-69` — маркер `[tool_result:`
  спуфится: user-сообщение с этим префиксом неотличимо от настоящего результата тула (нет nonce).
- **[Minor] [high]** `llm/context.ts:31, 196-222` — `CONTEXT_HISTORY_LIMIT=30` считает и
  system/audit-строки: после пары tool-ёмких ходов окно почти целиком из «[действие: …]».
- **[Minor] [med]** `ai/send-message.ts:250-257` — throw не-`ExecError` из `dispatchTool`
  (инфраструктурные ошибки) вылетает из цикла сырым 500; карточки исполненных шагов теряются.
- **[Minor] [low]** `ai/send-message.ts:222-226` — `details.reason = e.message` провайдера
  уходит клиенту в TRPC-ошибке (может содержать тело ответа API/URL).
- **[Minor] [low]** `ai/send-message.ts:377-426` — TOCTOU-гонка гейта entitlements: конкурентные
  запросы читают счётчики до инкрементов друг друга. На плане `dev` неактуально.
- **[Minor] [low]** `llm/context.ts:118-127` — приоритет памяти: **все** scoped-правила выше
  глобальных без сверки scope с аспектами якоря; при переполнении капа 50 глобальные правила
  вытесняются нерелевантными чужими scoped (§7.4 приближен грубее, чем заявлено).
- **[Наблюдение]** `@ai-sdk/anthropic@4.0.8` — `anthropicResponseSchema` закрытый
  discriminatedUnion типов блоков: новый тип блока будущих моделей → ZodError →
  `LLM_UNAVAILABLE` на каждый запрос до апдейта SDK. Fail-explicit, кода не требует; знать при
  следующем bump модели.

## Ops / деплой

- **[Important] [high]** `.github/workflows/backup.yml` + runbook §6 — **GitHub гасит cron
  после 60 дней без коммитов** в публичном репозитории (прогоны cron активностью не считаются).
  Тишина 60 дней → бэкапы прекращаются → ещё ~7 дней → пауза Supabase, а artifacts старше 30
  дней уже истекли. *(Задокументировано в runbook §6; механизма keepalive нет.)*
- **[Minor] [med]** `scripts/backup.sh:47-49` — проверка целостности пропускает **schema-only**
  дамп: `grep CREATE TABLE` + маркер завершения пройдут и на дампе с нулём данных. Стоит грепать
  `COPY public.entities`.
- **[Minor] [med]** `apps/server/src/app.ts:37` — нет DB-readiness: деплой с битым `DATABASE_URL`
  помечается Render как healthy (`/health` — liveness без БД), приёмка зелёная, данные мертвы.
  Нужен отдельный `/ready` с `select 1` для пост-деплой смоука (не для `healthCheckPath`).
- **[Minor] [med]** `Dockerfile:30-35` + `apps/web/src/auth/supabase.ts:4` — **пустая строка**
  build-arg проходит `??` и не откатывается на localhost: незаполненный `VITE_SUPABASE_URL` даёт
  бандл с `createClient('')` → белый экран прода без build-time сигнала.
- **[Minor] [low]** `scripts/setup-db.ts:71-76` — пароль роли уходит plaintext в SQL-стейтмент
  (`CREATE/ALTER ROLE … PASSWORD '…'`): при `log_statement=ddl` попадёт в логи Postgres, видимые
  в дашборде Supabase. Фикс: pre-hashed SCRAM-верификатор.
- **[Minor] [low]** `.github/workflows/ci.yml` — `db:prepare` прогоняется один раз на чистой БД;
  идемпотентность повторного прогона не проверяется, а restore (§4.3) — это ровно повторный прогон.
- **[Minor] [low]** `Dockerfile:11` — базовый образ запинен тегом `oven/bun:1.2.7`, не digest;
  контейнер работает от root (нет `USER bun`).
- **[Minor] [low]** `render.yaml` — нет `buildFilter.ignoredPaths: [docs/**]`: docs-only push
  триггерит пересборку и рестарт (обрыв in-flight агентной петли).
- **[Minor] [low]** `scripts/backup.sh:37` — DSN с паролем в `argv` `pg_dump` на локальном пути
  (виден в `ps`); docker-фолбэк уже передаёт через env.
- **[Minor] [low]** runbook §6 — **недоказано**, что `pg_dump` через пулер сбрасывает счётчик
  паузы Supabase Free: если критерий неактивности — трафик API-gateway (Data API у нас выключен),
  обе «профилактики» не работают.
- **[Minor] [low]** `apps/server/src/index.ts` — `server.stop()` без аргумента ждёт in-flight
  запросы; долгая агентная петля всё равно упрётся в 30-секундный SIGKILL Render.

---

## Проверено и признано чистым (не искать повторно)

Алгоритм-конфьюжн в JWKS-пути закрыт allowlist'ом (`RS256`/`ES256`) до резолва ключей; PAT —
sha256 + `timingSafeEqual`, fail-closed на любом дефекте env, токен не логируется; все мутации
tRPC под `ownerOnly`, `exportData` агенту закрыт; порядок гейтов `/mcp` 405→401→413; body-limit
считает фактические байты; `errorFormatter` не течёт SQL; SPA-fallback без path-traversal;
RLS + FORCE на всех 8 таблицах, `withIdentity` (`set_config` + `SET LOCAL ROLE`) умирает на
commit/rollback, путей мимо identity в серверном коде нет; write-skew approve∥reject закрыт
advisory-lock'ом и покрыт гоночным тестом; атомарность batch (prepare всех операций до первой
записи); двойной undo закрыт; decimal-деньги без `parseFloat` (сравнения через `::numeric`);
SQL-инъекции в query-компиляторе исключены (значения — параметрами, `sql.raw` только для
каталожных значений); политика §7.10 fail-closed на неизвестный тул, pending не пишет ни в граф,
ни в журнал; метеринг §4.7 атомарен и пишется в `finally`; типы AI SDK не текут через
`LLMProvider`; retry-буфер удаляет запись только на `confirmed`/`business_rejection`;
`authErrorLink` ключуется на `err.data.code`; серверный составной курсор строго лексикографичен.
