# ADE-срез 1 «круг» — план реализации

> **Для агентных исполнителей:** ОБЯЗАТЕЛЬНЫЙ САБ-СКИЛЛ — `superpowers:subagent-driven-development`
> (рекомендуется) либо `superpowers:executing-plans`. Шаги размечены чекбоксами (`- [ ]`).
> Исполнитель задачи видит ТОЛЬКО свою задачу — каждый бриф самодостаточен, все имена и типы
> соседних задач продублированы в блоке «Интерфейсы».

**Цель:** замкнуть круг «тикет → прогон → чекпойнт/отчёт → решение человека» для внешнего
исполнителя (Claude Code через MCP): проекты и тикеты как сущности, назначение исполнителю,
скоуп `worker`, пять глаголов исполнителя через executor, прогон-сущность с лентой шагов,
чекпойнт с кнопкой ответа, закреплённые версии тела, откат прогона.

**Архитектура:** ни одной новой подсистемы — четыре аспекта в реестре, одна таблица
(`entity_versions`), одно CAS-предусловие в `entity_update`, пять тулов-глаголов, которые
СОБИРАЮТ существующие операции executor'а в один batch (журнал §7.8, inverse, Undo — бесплатно),
идентичность гранта, протянутая от bearer до записи журнала, и скоуп `worker` как fail-closed
гейт в `dispatch`. Экраны — на трёх табах detail-экрана редактора (`DetailScreen.tsx:254-269`).

**Стек:** Bun 1.2.7, Hono, tRPC 11, drizzle-orm/postgres (Supabase Postgres 17), zod +
zod-to-json-schema + ajv (валидация аспектов по реестру ИЗ БД), `@modelcontextprotocol/sdk`,
React 19 + TanStack Query, Tiptap 3.30.1 (не трогаем), `bun:test` (server, shared), vitest 4 (web),
pgTAP (RLS), biome.

**Спека:** `docs/superpowers/specs/2026-08-14-orbis-ade-slice1-design.md` (решения Р1–Р4,
С1–С12, инварианты 1–9, приёмка 1–15). Ревью с решениями владельца —
`docs/superpowers/reviews/2026-08-14-ade-slice1-design-review.md` (постскриптум). Рамка D35 —
`docs/superpowers/specs/2026-08-17-vision-autonomous-spheres-design.md` (В3: машинерия прогонов
строится один раз; в план из V1–V3 ничего не тащим, кодовое — только в `orbis/repo`).

---

## Что установила разведка кода (2026-08-17, main `371adce`)

Шесть читателей прошли по коду ДО написания плана (седьмой, по CI/тредам/undo, упал по лимиту — его вопросы закрыты соседями и точечными проверками контроллера); ниже — факты, на которых план стоит, и
расхождения с дизайном 2026-08-14. Исполнителям: **каждый факт опровергаем** — проверяй
пробоем на живой БД, опровержение ценнее исполнения (в этом проекте разведка опровергала
факты контроллера 15+ раз).

### Подтверждено

- Detail-экран — **три таба** «Сущность · Детали · Тред» (`apps/web/src/features/entity-detail/DetailScreen.tsx:254-269`),
  первый таб собирается в `:141-191`: emoji+`NativeRow` (145-160) → `PlannedToFactCard` (162-164)
  → `GoalProgress` (165-170) → `EntityBody` (178-189). Точка вставки чекпойнт-блока и ленты
  прогона — между 170 и 178. Второй таб `:193-202`: `AspectCards` → `Subtasks` → `Blocks` → `Backlinks`.
- Тело: правда — `body_doc`, `body` — проекция; обе пишутся при КАЖДОЙ записи
  (`executor.ts:1136-1222`); чтение конвертирует лениво и в БД не пишет (`entity-read.ts:60-67`).
  Бэкфилл на проде НЕ выполнялся — строки с `body_doc IS NULL` существуют. Снимок версии обязан
  уметь обе формы. `entity_update` принимает `bodyDoc` только UI-схемой (`contracts/tools.ts:58-63`),
  модель/MCP шлют строку.
- Executor: стадии 1–4 в `prepare*`, стадия 5 — `apply` (`executor.ts:1-10`, `:207-271`); batch —
  одна транзакция, один action c `id = batchId`, `BatchState` делает эффекты op N видимыми op N+1
  (`:135-158`, `:276-411`); строчный замок `loadEntityForUpdate` (`:736-745`, `FOR UPDATE`).
  Единственный CAS сегодня — `expectedUpdatedAt`, и только при правке тела (`:1031-1045`).
  Merge аспектов: `null` поля удаляет, `null` аспекта — снимает аспект (`normalize.ts:33-51`).
- Журнал §7.8 — НЕ таблица: `chat_messages.metadata.actions[0]` (`journal.ts:74-120`), GIN
  `chat_messages_metadata_gin` (jsonb_path_ops) — containment-пробы работают (`undo.ts:23-36`).
  `ActionRecord` (`types.ts:94-120`) несёт `actor_user_id/actor_kind/source/operations/inverse`.
- Undo: `undoAction(db,{actorUserId,actionId})`, `undoLast` (`undo.ts:131-179`); режим `internalUndo`
  живёт в `ExecutorDeps` и ветвит executor (`executor.ts:1031,1053-1067`); отменённость —
  `NOT EXISTS` по `{type:'undo', undoes}`; undo неотменяем; серии undo нет.
- Реестр аспектов — три файла shared (`constants.ts:14-23`, `schemas/aspects.ts`, `aspect-registry.ts`)
  + счётчики в пяти тестах + `apps/web/src/lib/field-labels.ts` (прецедент `705c12e`); валидация —
  ajv по `aspect_definitions.schema` ИЗ БД (`aspects-validate.ts:2-3`), потому пересев обязателен.
  `attach_<aspect>` генерируются, дефис → `_` уже поддержан (`registry.ts:436-438`, тест на `user/sleep-log`).
- Политика §7.10 — по `kind`/`archives`/`isBatch`, имён не знает (`policy/confirmation.ts:42-51`);
  внешние гейты — `internalOnly × source` в `dispatch.ts:119-128` (код `VALIDATION`).
- MCP: `verifyBearer` → `{grantId, ownerId}` (`oauth/grants.ts:26-29,83-101`), транспорт отдаёт
  дальше ТОЛЬКО `ownerId` (`mcp/transport.ts:97`), `ToolCallCtx` без гранта (`dispatch.ts:72-86`).
  Колонка `agent_grants.scope` (`schema.ts:225`) не читается и не пишется нигде; `/oauth/token`
  отвечает `scope:'full'` литералом (`token-endpoint.ts:152-153`); параметр `scope` authorize
  игнорируется (`apps/web/src/features/oauth/authorize-request.ts:47-71`).
- Грамматика: `aspect=` можно повторять (AND), `children_of=this|<uuid>`, поля резолвятся
  каталогом, одноимённое поле в двух аспектах требует `aspect=` (`parse.ts:338-362`).
  Подпутевые формы `aspects->'A'->>'f'` GIN не покрыты, containment `aspects @> {...}` — покрыт
  (`compile.ts:299-311`).
- Миграции: журнал `_journal.json` кончается на idx 9 (`0009_body_before_doc`), следующий
  `drizzle-kit generate` выпустит **`0010_*`**, а файл `0010_drop_body_before_doc.sql` (НЕ
  зарегистрирован в журнале, ждёт снятия страховки редактора) занимает это имя и сам просит
  себя переименовать (`0010_drop_body_before_doc.sql:3-7`). Образец «таблица + RLS» — два файла:
  сгенерированная `0004` + рукописная `0005` без снимка (`8a26a0f`).
- CI (`.github/workflows/ci.yml`): `lint → typecheck → db:prepare (миграции + сид + pgTAP) → bun run test → build web → check-lazy-chunks`.
- Прод: `bun scripts/ops.ts migrate` ДО кода; после деплоя — `seed-aspects` → `check` →
  Restart (`docs/implementation/02-ops-runbook.md:248-302, 328-336`).

### Расхождения дизайна с кодом (и что план с ними делает)

| # | Дизайн говорит | Код говорит | Решение плана |
|---|---|---|---|
| Р-1 | С7/инвариант 3: все семь глаголов, включая `thread_post`, — операции executor'а с журналом и Undo | `thread_post` исполняется **мимо executor** (`dispatch.ts:730-756`), в batch не допускается (`:601-605`), action не пишет | **Вопрос владельцу (В1)**. По умолчанию план оставляет `thread_post` как есть (это запись в тред, не мутация графа; журнал §7.8 сам живёт в `chat_messages`) и сужает его для `worker` до тредов назначенных тикетов и их проектов. Инвариант 3 сужается до «шесть глаголов-мутаций графа» правкой спеки в Задаче 17 |
| Р-2 | С12/инвариант 7: откат прогона «существующей механикой Undo с проверкой, что сущности с тех пор не менялись» | Undo — осознанный LWW без проверки изменений (`undo.ts:1-7`, `types.ts:199-202`); отката списка действий нет | **Вопрос владельцу (В2)**. По умолчанию: новая tRPC-процедура `agentRun.rollback` делает журнальную ПРЕДпроверку («после прогона по тем же сущностям были чужие неотменённые действия» → отказ с перечнем), затем серию `undoAction` по одному на транзакцию. Механику самого Undo не трогаем |
| Р-3 | С7: захват — «CAS-расширение стадий 4–5» | Предусловий на значения аспектов в конвейере нет; есть только `expectedUpdatedAt` для тела | Строим ровно то, что сказано: `precondition` в exec-схеме `entity_update` (Задача 9), проверяется под `FOR UPDATE` в стадии 4 → `CONFLICT`. Глаголы = batch существующих операций с предусловием |
| Р-4 | С4: назначение и очередь сопоставляют предъявленный грант | Грант отбрасывается транспортом; в `ExecuteRequest`/`ActionRecord` поля гранта нет | Аддитивно: `GrantIdentity += scope,label` → `ToolCallCtx.grant` → `ExecuteRequest.actorGrantId/runId` → `ActionRecord.actor_grant_id/run_id` (Задача 6). Обратная ссылка `run_id` даёт откат прогона по журналу |
| Р-5 | С5: «прячутся по прецеденту D20» | D20 — клиентский `.filter` в трёх экранах бюджета; Browser и `entity_query` не фильтруют ничего; PRD 02 §3.9 «служебные сущности» не реализован | Серверное неявное исключение служебных аспектов в `compileWhere`, если запрос сам не назвал такой аспект через `aspect=` (Задача 2). Реализует §3.9 первым; `SERVICE_ASPECT_IDS = ['orbis/agent-run']` |
| Р-6 | «миграции нумеруются после редакторских» | 0010 занят незарегистрированным файлом | `entity_versions` — сгенерированная `0010`, RLS — рукописная `0011`, файл снятия страховки переименовывается в `0012_drop_body_before_doc.sql` (Задача 3) |
| Р-7 | С5: «прогон переживает журнал (RET-02, 90 дней)» | Retention не реализован нигде (`journal.ts:6-7`) — предела глубины отката сегодня нет | Ничего не строим; факт фиксируется в спеке (Задача 17) |
| Р-8 | С10: заготовка проекта с блоком «последние прогоны» | `this` есть только у `children_of/parents_of`; прогоны — внуки проекта | На прогоне денормализованное поле `project_id`; заготовка засевается сервером с ПОДСТАВЛЕННЫМ uuid проекта (Задача 4) |
| Р-9 | Ревью: «`entity_versions` — новая таблица» без формы | Формы нет | DDL в Задаче 3: снимок `body_doc` (nullable) + `body` (всегда), подпись, актор, дата; RLS по `owner_id` |
| Р-10 | С10: кнопка «Ответить и вернуть в работу» — одно действие | Обобщённого batch с web нет; `thread_post` в batch запрещён | Выделенная процедура `agentRun.answerCheckpoint`: один `execute`-batch из двух `entity_update` (тикет → `planned`, `waiting_for` снят; на прогоне `reply`). Ответ хранится на прогоне, не в треде — следующий `orbis_claim_task` отдаёт его в истории (Задача 13) |

## Развилки

### Решения плана (владелец может отменить, но план под них написан)

1. **Порог брошенного прогона — 30 минут** без шага (`RUN_STALE_AFTER_MS = 30 * 60_000`,
   `apps/server/src/agent-loop/constants.ts`). Довод: агент между `orbis_run_step` гоняет тесты
   (~5 мин), думает, читает; ложное срабатывание стоит внимания человека (тикет уходит в
   `waiting`), пропуск стоит только ожидания. Значение — константа сервера, тесты инжектируют
   `clock` и порог.
2. **Журнал наблюдений (В6 рамки D35) — отложен.** Дёшево только «считать вызовы read-тулов
   в памяти», а это не наблюдаемость. Чтобы наблюдение было полезно, его надо привязать к прогону
   (лишний запрос «активный прогон гранта» на КАЖДОЕ чтение) и где-то хранить (либо новая таблица
   с RLS/pgTAP/retention, либо запись через executor — шум в журнале действий на каждое чтение).
   V1 (внутренний исполнитель) будет читать in-process — дизайн хранилища наблюдений делать
   один раз с обоими потребителями в виду. **Шов оставлен:** единственная точка чтения в
   `dispatch.ts` (ветка `def.kind === 'read'`) уже получит `ctx.grant` (Задача 6) — перехват
   стоит одного `if`.
3. **Поле жизненного цикла проекта называется `stage`, не `status`** — второе поле `status`
   сделало бы каждый запрос `status=…` без `aspect=` неоднозначным (`parse.ts:349-358`), включая
   сохранённые владельцем блоки. То же для прогона: `outcome`, не `status`.
4. **Служебный аспект `orbis/agent-run` не получает `attach_*`-тула** — прогон создаёт и правит
   только сервер (глаголы). Итог реестра: было 19 (11 core + 8 attach) → станет **27** (11 core + 5 глаголов +
   11 attach: восемь прежних и три новых — `project`, `repo`, `assignment`).
5. **Закрепление версии — операция executor'а** (`entity_version_pin`, inverse — физическое
   удаление строки, прецедент `entity_origin_*`, `executor.ts:184-195, 1795`): журнал и Undo
   бесплатно, правило «один путь мутаций» не нарушается. В `CORE_TOOLS` не регистрируется —
   только tRPC владельца.
6. **Выдача скоупа `worker`** — выбор на экране согласия (радио «Полный доступ» / «Только
   исполнитель») + флаг `--scope worker` у `issue-pat`. Параметр `scope` из запроса клиента
   по-прежнему игнорируется (Claude Code его не задаёт). Альтернатива «переключатель в
   Настройки → Агенты» отклонена: скоуп фиксируется в момент выдачи, менять его на живом токене —
   лишняя ось.
7. **`may_close` необязателен в схеме, отсутствие = `false`**: на default'ы JSON Schema не
   опираемся (в конфиге ajv `useDefaults` не виден — `aspects-validate.ts:19-20`, сверить), а
   требовать поле от модели при каждом назначении — лишний повод ошибиться.
8. **Ответ на чекпойнт хранится на прогоне** (`orbis/agent-run.reply`), а не в треде: следующий
   прогон получает его структурно в истории `orbis_claim_task`, чекпойнт-блок на экране тикета
   показывает Q&A по прогонам. Тред остаётся человеческим разговором.
9. **Кто может звать глаголы:** любой MCP-грант (`agentOnly` — только с грантом; чат без гранта
   их не видит и не может вызвать). Скоуп `worker` — ТОЛЬКО глаголы + `thread_post` + чтение.
   Так «полный» грант владельца тоже может пройти круг, а `worker` не может ничего лишнего.

### Вопросы владельцу — РЕШЕНЫ 2026-08-17: оба «по умолчанию»

Владелец подтвердил оба варианта по умолчанию (В1 — `thread_post` остаётся мимо executor,
сужается для `worker`; В2 — откат прогона с журнальной предпроверкой конфликтов). План
исполняется как написан; ниже — формулировки развилок для истории.

**В1. `thread_post` — оставить мимо executor (по умолчанию) или переделать в операцию executor'а?**
Простыми словами: сегодня запись в тред — это просто строка в таблице сообщений, без записи в
журнал действий и без «отмени последнее». Дизайн (по итогам ревью Б2) записал `thread_post`
седьмым глаголом и потребовал, чтобы «каждый глагол проходил executor». Сделать это можно
(новый вид операции, обратная операция = удаление сообщения, снятие запрета на batch), но это
~день работы ради «отмени последнее» для реплики агента в треде — которую человек и так видит
и может ответить. Дизайн приёмки (п. 14) требует Undo для ШАГОВ прогона — они идут через
executor и так. **По умолчанию:** оставить как есть, сузить для `worker` (Задача 7), поправить
формулировку инварианта 3 в спеке (Задача 17). Если «переделать» — добавляется задача между 11 и 12.

**В2. Откат прогона: строить предпроверку конфликтов (по умолчанию) или откатывать поверх (LWW, как весь Undo)?**
Простыми словами: дизайн обещает «если сущность с тех пор кто-то менял — показать конфликт, а не
затереть». Существующий Undo так не умеет и не хочет уметь по явному решению («LWW-откат
поверх текущего»). **По умолчанию:** предпроверка по журналу — «после последнего действия
прогона по тем же сущностям есть чужие неотменённые действия» → отказ с перечнем; если чисто —
серия `undoAction` в обратном порядке (по одной транзакции на действие, неатомарно между
собой). Альтернатива «без проверки» дешевле на пару часов, но ломает инвариант 7 и приёмку 13.

---

## Глобальные ограничения

- **Ветка `ade-slice1-loop` от свежего `origin/main`, работа только в отдельном worktree**
  (`.claude/worktrees/ade-slice1-loop`); основное дерево не трогать; в новом дереве — свой
  `bun install`. Параллельные имплементеры **в одном дереве запрещены**; параллельность —
  только по непересекающимся файлам и в отдельных worktree, иначе последовательно.
- **Мутации графа — ТОЛЬКО через executor** (`apps/server/src/executor/executor.ts`); роутеры и
  MCP-адаптер — трансляция (`docs/implementation/00-architecture.md:74-75`). Глаголы исполнителя
  собирают batch существующих операций; собственных `INSERT/UPDATE` в `entities`/`relations` нет.
- **Миграции forward-only**; сгенерированные — `cd apps/server && bun run db:generate` со
  снимком, рукописные (RLS) — отдельным файлом без снимка (образец `0005_oauth_rls.sql`);
  накат на прод — только `bun scripts/ops.ts migrate`; прод-операции — только белый список
  `scripts/ops.ts:487-503`.
- **Пересев реестра на проде — обязательный шаг деплоя** (`02-ops-runbook.md:122-166, 248-302`).
- **TDD.** Сначала падающий тест, потом код. Полный прогон — `bun run test` из корня (голый
  `bun test` из корня ЗАВИСАЕТ). Один серверный файл — `cd apps/server && bun test src/<путь>`
  (нужны `DATABASE_URL` и `DATABASE_URL_ADMIN`, локальный Supabase — `bunx supabase start`; см.
  `apps/server/test/helpers.ts:5-13`). Web — `cd apps/web && bunx vitest run <путь>`. Зелёный
  сьют считается **по коду возврата**, не по счётчику. `bun run lint` — отдельным вызовом, код
  возврата снимать без пайпа. `bun run typecheck` — перед каждым коммитом.
- **Серверные сьюты делят локальную БД** (`truncateAll()`) — не гонять два прогона одновременно.
- **Обвязка серверных тестов — по `executor.test.ts:15,54-60`:** `const { db, client } = appDb()`
  на модульном уровне, `afterAll(() => client.end())`, `requireEnv()`; `adminDb()` — один раз.
- **Моки web-тестов — функцией:** `renderWithProviders(ui, (path, input) => …)`
  (`apps/web/src/test/harness.tsx:107-135`), карта путей — строки процедур tRPC.
- **Страж ленивых чанков** (`scripts/check-lazy-chunks.ts`, CI): новые компоненты detail-экрана
  импортируются статически ТОЛЬКО из файлов внутри чанка `DetailScreen`; из них нельзя
  импортировать `@orbis/shared/doc`, `BodyEditor`, `MarkdownToggle`, ленивые экраны. Новых
  `lazy()`-маршрутов срез не заводит.
- **Тул-контракт модели не растёт ради сервера:** `precondition` и `bodyDoc` живут в
  exec-/UI-схемах, модель/MCP их не видят (тест «непротекание» обязателен).
- **Язык кода, комментариев, ошибок, коммитов — русский; комментарий объясняет «почему».**
- **Счётчики тулов после среза:** `registry.test.ts:108,114` — 27; `:249` — 28 (+ кастомный);
  `mcp.test.ts:409,446` — по факту (публичных = 27 − 2 internalOnly = 25); `seed-aspects.test.ts:10`
  — «12 builtin-строк».
- **Коммит после каждой задачи** — `git commit -- <пути>` (без pathspec запрещено); в сообщении
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`. Мерж в `main` (ff-only) и пуш —
  после закрытия задачи и зелёного CI — постоянное распоряжение владельца.

## Карта файлов

| Область | Создать | Изменить |
|---|---|---|
| shared | `packages/shared/src/contracts/agent-loop.ts` | `constants.ts` (`BUILTIN_ASPECT_IDS`, `SERVICE_ASPECT_IDS`, `GRANT_SCOPES`), `schemas/aspects.ts`, `aspect-registry.ts`, `contracts/tools.ts` (`entityUpdateExecInput`), `index.ts` (экспорт нового контракта), тесты |
| БД | `apps/server/src/db/migrations/0010_<gen>.sql` + `meta/0010_snapshot.json`, `0011_ade_versions_rls.sql` | `schema.ts` (`entityVersions`), `meta/_journal.json`, переименование `0010_drop_body_before_doc.sql → 0012_…`, `apps/server/test/rls/rls.pgtap.sql`, `apps/server/test/helpers.ts` |
| executor | — | `executor.ts` (precondition; инвариант назначения; засев проекта; ops `entity_version_pin/delete`), `types.ts` (`actorGrantId/runId`, `actor_grant_id/run_id`, типы action), `normalize.ts` (хелперы), `journal.ts` (запись новых полей), `undo.ts` (экспорт `isUndone`) |
| agent-loop | `apps/server/src/agent-loop/{constants,queries,verbs,sweep,rollback}.ts` + тесты, `apps/server/src/seed/project-body.ts` | — |
| tools/policy/mcp | — | `tools/registry.ts` (5 дефов, `agentOnly`, `WORKER_SCOPE_TOOLS`, пропуск attach для служебных), `tools/dispatch.ts` (`ctx.grant`, гейт скоупа, ветка глаголов, сужение `thread_post`), `mcp/transport.ts`, `mcp/server.ts`, `context.ts`, `ai/send-message.ts`, `policy/confirmation.test.ts` |
| oauth | — | `oauth/grants.ts` (`GrantIdentity`, `verifyBearer`, `issuePatGrant`, `createAuthorizationCode`, `listGrants`), `oauth/metadata.ts`, `oauth/token-endpoint.ts`, `routers/oauth.ts`, `wire.ts`, `scripts/issue-pat.ts`, `scripts/ops.ts` |
| tRPC | `routers/agent-run.ts`, `routers/version.ts` | `router.ts`, `wire.ts` |
| query | — | `query/compile.ts` (служебные аспекты), тесты компилятора |
| web | `features/entity-detail/{TicketWaitingBlock,AssignmentCard,RunsList,RunFeed,VersionsCard}.tsx`, `features/entity-detail/useTicketRuns.ts` | `DetailScreen.tsx`, `AspectCards.tsx`, `lib/field-labels.ts`, `features/oauth/ConsentScreen.tsx`, `features/settings/ConnectedAgents.tsx`, `features/chat/cards/renderCards.tsx`, тесты |
| docs | `docs/superpowers/plans/2026-08-17-ade-slice1-loop.md` (этот файл) | `docs/prd/01-architecture.md` (§2.2, §3.8, §3.12–3.15, §4.14, §7.8, §7.10, §9.2, §9.3), `02-core-os.md` (§3.5, §3.9, §5 сценарий 9), `04-decision-log.md` (D36), `docs/implementation/02-ops-runbook.md`, `00-architecture.md` §5, спека среза |

## Порядок и параллельность

```
Веха A (данные):    0 → 1 → { 2 ‖ 3 } → 4 → 5
Веха B (грант):     6 → { 7 ‖ 8 }
Веха C (глаголы):   9 → 10 → 11 → 12 → 13
Веха D (экраны):    14 → 15 → 16          (‖ с 13 при отдельном worktree — файлы не пересекаются)
Веха E (документы): 17 → 18
```
`‖` — можно параллельно ТОЛЬКО в отдельных worktree (файлы не пересекаются); всё остальное —
строго последовательно (общие файлы: `executor.ts`, `types.ts`, `dispatch.ts`, `registry.ts`,
`DetailScreen.tsx`).

---

### Задача 0: Подготовка дерева и базовая линия

**Файлы:** — (git/worktree)

- [ ] **Шаг 1:** из основного дерева: `git fetch origin && git worktree add -b ade-slice1-loop .claude/worktrees/ade-slice1-loop origin/main`.
- [ ] **Шаг 2:** в новом дереве `bun install`; проверить, что локальный Supabase поднят
  (`bunx supabase status`), в `apps/server/.env` есть `DATABASE_URL` и `DATABASE_URL_ADMIN`.
- [ ] **Шаг 3:** `bun run db:prepare` (миграции + сид реестра + pgTAP), затем `bun run test`,
  `bun run lint`, `bun run typecheck` — все с кодом возврата 0. Записать базовые счётчики сьютов
  (по последним данным: shared 321 / server 1130 / web 944).
- [ ] **Шаг 4:** коммитов нет; зафиксировать в отчёте задачи хеш `origin/main`, от которого ветка.

---

### Задача 1: Реестр аспектов — `orbis/project`, `orbis/repo`, `orbis/assignment`, `orbis/agent-run`

**Файлы:**
- Изменить: `packages/shared/src/constants.ts:14-23`, `packages/shared/src/schemas/aspects.ts`
  (после `goalAspectSchema:128`, реестр `ASPECT_SCHEMAS:149-158`, типы `:164-171`),
  `packages/shared/src/aspect-registry.ts` (после записи `orbis/goal:96-107`),
  `apps/web/src/lib/field-labels.ts:3-19,39-54`,
  `apps/server/src/tools/registry.ts:440-464` (пропуск служебных аспектов при генерации `attach_*`)
- Тесты: `packages/shared/src/schemas/aspects.test.ts`, `packages/shared/src/aspect-registry.test.ts:30-34`,
  `apps/server/src/tools/registry.test.ts:108-125,249`, `apps/server/src/mcp/mcp.test.ts:409-446`,
  `apps/server/test/seed-aspects.test.ts:10-16`, `apps/server/src/executor/aspects-validate.test.ts`

**Интерфейсы (produces):**
```ts
// packages/shared/src/constants.ts
export const BUILTIN_ASPECT_IDS = [
  'orbis/schedule','orbis/task','orbis/financial','orbis/note','orbis/budget','orbis/category',
  'orbis/memory','orbis/goal',
  'orbis/project','orbis/repo','orbis/assignment','orbis/agent-run',
] as const;
/** Служебные аспекты (02-core-os §3.9): не в основных выдачах, без attach_*-тула — их
 *  создаёт и правит только сервер. Одна константа на компилятор запросов и реестр тулов. */
export const SERVICE_ASPECT_IDS = ['orbis/agent-run'] as const satisfies readonly AspectId[];
export const GRANT_SCOPES = ['full', 'worker'] as const;
export type GrantScope = (typeof GRANT_SCOPES)[number];

// packages/shared/src/schemas/aspects.ts
export const RUN_OUTCOMES = ['running', 'checkpoint', 'finished', 'abandoned'] as const;
export const projectAspectSchema, repoAspectSchema, assignmentAspectSchema, agentRunAspectSchema;
export type ProjectAspect, RepoAspect, AssignmentAspect, AgentRunAspect, AgentRunStep;
```

- [ ] **Шаг 1: падающие тесты схем** — в `packages/shared/src/schemas/aspects.test.ts` дописать:

```ts
describe('аспекты ADE-среза 1 (С4)', () => {
  test('orbis/project: stage обязателен, лишние ключи отвергаются', () => {
    expect(projectAspectSchema.safeParse({ stage: 'active' }).success).toBe(true);
    expect(projectAspectSchema.safeParse({}).success).toBe(false);
    expect(projectAspectSchema.safeParse({ stage: 'active', status: 'x' }).success).toBe(false);
  });
  test('orbis/repo: url и default_branch', () => {
    expect(repoAspectSchema.safeParse({ url: 'https://github.com/qvenge/orbis', default_branch: 'main' }).success).toBe(true);
    expect(repoAspectSchema.safeParse({ url: '' }).success).toBe(false);
  });
  test('orbis/assignment: executor agent|human, grant_id — uuid, may_close необязателен', () => {
    expect(assignmentAspectSchema.safeParse({ executor: 'agent', grant_id: '019a0000-0000-7000-8000-000000000001' }).success).toBe(true);
    expect(assignmentAspectSchema.safeParse({ executor: 'human', assignee: 'Биржан', may_close: true }).success).toBe(true);
    expect(assignmentAspectSchema.safeParse({ executor: 'agent', grant_id: 'не-uuid' }).success).toBe(false);
  });
  test('orbis/agent-run: полный прогон с шагом валиден; steps > 500 отвергается', () => {
    const run = {
      grant_id: '019a0000-0000-7000-8000-000000000001', outcome: 'running',
      started_at: '2026-08-17T10:00:00.000Z', last_step_at: '2026-08-17T10:05:00.000Z',
      step_count: 1, steps: [{ seq: 1, at: '2026-08-17T10:05:00.000Z', summary: 'создал ветку', external: true }],
    };
    expect(agentRunAspectSchema.safeParse(run).success).toBe(true);
    const many = { ...run, steps: Array.from({ length: 501 }, (_, i) => ({ seq: i + 1, at: run.last_step_at, summary: 's', external: false })) };
    expect(agentRunAspectSchema.safeParse(many).success).toBe(false);
  });
  test('JSON Schema новых аспектов генерируется и не содержит refine-логики', () => {
    for (const id of ['orbis/project', 'orbis/repo', 'orbis/assignment', 'orbis/agent-run'] as const) {
      const js = aspectJsonSchema(id) as { additionalProperties?: boolean };
      expect(js.additionalProperties).toBe(false);
    }
  });
});
```
  В `aspect-registry.test.ts` сторож биекции (`:30-34`) уже покроет новые id — убедиться, что он
  падает, пока `BUILTIN_ASPECT_META` не дополнен.

- [ ] **Шаг 2: прогнать** `cd packages/shared && bun test src/schemas/aspects.test.ts` — FAIL
  («projectAspectSchema is not exported»).

- [ ] **Шаг 3: схемы** — в `packages/shared/src/schemas/aspects.ts` после `goalAspectSchema`:

```ts
// ─── ADE-срез 1 (спека 2026-08-14, С4) ────────────────────────────────────────
// Поле жизненного цикла названо `stage`, а не `status`: второе поле `status` в реестре сделало бы
// каждый запрос `status=…` без `aspect=` неоднозначным (query/parse.ts resolveField), включая
// сохранённые владельцем блоки. То же — `outcome` у прогона.
export const projectAspectSchema = z.object({ stage: z.enum(['active', 'paused', 'done']) }).strict();

// Кодовая специфика отдельно от общего понятия проекта (решение владельца 2026-08-17, D35).
export const repoAspectSchema = z
  .object({ url: z.string().min(1).max(512), default_branch: z.string().min(1).max(128) })
  .strict();

// Плоский объект вместо discriminatedUnion: каталог грамматики читает `properties` верхнего
// уровня, у oneOf их нет — поля стали бы невидимы для query-блоков. Условие
// «executor=agent ⇒ grant_id живого гранта владельца» держит инвариант executor'а
// (assertAssignment), потому что .refine исчезает при генерации JSON Schema, а валидирует ajv.
export const assignmentAspectSchema = z
  .object({
    executor: z.enum(['human', 'agent']),
    grant_id: z.string().uuid().optional(), // agent_grants.id; выставляет владелец, модель не выдумывает
    assignee: z.string().min(1).max(200).optional(), // executor=human: кто
    may_close: z.boolean().optional(), // отсутствует = false (С8): ajv default'ы не применяет
  })
  .strict();

export const RUN_OUTCOMES = ['running', 'checkpoint', 'finished', 'abandoned'] as const;
const runStepSchema = z
  .object({
    seq: z.number().int().positive(),
    at: timestampString,
    summary: z.string().min(1).max(500),
    external: z.boolean(), // «тронул внешнее»: ветка, файлы, сеть — вне Orbis (С5, С6)
    action_id: z.string().uuid().optional(), // action §7.8 этого шага (= batchId вызова)
  })
  .strict();
const runUsageSchema = z
  .object({
    input_tokens: z.number().int().nonnegative().optional(),
    output_tokens: z.number().int().nonnegative().optional(),
    cost_usd: z.number().nonnegative().optional(),
  })
  .strict();
export const agentRunAspectSchema = z
  .object({
    grant_id: z.string().uuid(),
    project_id: z.string().uuid().optional(), // денормализация: `this` грамматики не достаёт внуков
    outcome: z.enum(RUN_OUTCOMES),
    started_at: timestampString,
    finished_at: timestampString.optional(),
    last_step_at: timestampString, // отметка живости = время последнего шага (С6)
    step_count: z.number().int().nonnegative(), // CAS-счётчик для конкурентных шагов + фильтруемая длина
    steps: z.array(runStepSchema).max(500),
    session_url: z.string().url().optional(),
    report: z.string().max(20000).optional(), // «готово, проверь» (С8)
    checkpoint: z.object({ question: z.string().min(1).max(4000), asked_at: timestampString }).strict().optional(),
    reply: z.object({ text: z.string().min(1).max(4000), at: timestampString }).strict().optional(), // ответ владельца
    usage: runUsageSchema.optional(),
    abandon_note: z.string().max(2000).optional(), // подметание С6
  })
  .strict();
```
  Дописать четыре записи в `ASPECT_SCHEMAS` и типы `ProjectAspect`, `RepoAspect`,
  `AssignmentAspect`, `AgentRunAspect`, `AgentRunStep = z.infer<typeof runStepSchema>` (экспорт
  `runStepSchema` не нужен). В `constants.ts` — четыре id, `SERVICE_ASPECT_IDS`, `GRANT_SCOPES`.

- [ ] **Шаг 4: мета реестра** — в `aspect-registry.ts` после `orbis/goal` (форма — как у соседей,
  `BuiltinAspectMeta:7-16`; `aiInstructions` попадёт и в системный промпт чата, и в описание
  `attach_*` — писать как инструкцию модели):

```ts
  {
    id: 'orbis/project', name: 'Проект', namespace: 'orbis', icon: '📁',
    description: 'Затея с жизненным циклом; тикеты — дочерние задачи',
    aiInstructions:
      'orbis/project — проект: затея с жизненным циклом (stage: active|paused|done). Тикеты проекта — ' +
      'дочерние сущности с orbis/task (relation parent от проекта к тикету). «Сделай A, B, C» в треде ' +
      'проекта = создать по тикету на пункт (status inbox), детьми проекта. Тело проекта с живыми ' +
      'блоками сервер засевает сам при пустом теле — не пиши его вручную. Кодовое (репозиторий, ' +
      'ветка) — в orbis/repo на той же сущности, не здесь.',
    tagMappings: ['project', 'проект'], viewConfig: { keyFields: ['stage'] },
  },
  {
    id: 'orbis/repo', name: 'Репозиторий', namespace: 'orbis', icon: '🗂️',
    description: 'Адрес репозитория и ветка по умолчанию',
    aiInstructions:
      'orbis/repo — репозиторий код-проекта: url и default_branch. Ставится на ту же сущность, что ' +
      'orbis/project, только если проект — про код.',
    tagMappings: ['repo', 'репозиторий'], viewConfig: { keyFields: ['url', 'default_branch'] },
  },
  {
    id: 'orbis/assignment', name: 'Назначение', namespace: 'orbis', icon: '🎯',
    description: 'Исполнитель тикета: человек или агент по гранту; may_close',
    aiInstructions:
      'orbis/assignment — исполнитель тикета. executor=agent требует grant_id — uuid доступа из ' +
      '«Настройки → Агенты»; его выставляет владелец (обычно кнопкой на экране тикета) — НИКОГДА не ' +
      'выдумывай uuid и не подставляй чужой. executor=human — assignee текстом. may_close (по ' +
      'умолчанию false) разрешает исполнителю закрывать тикет самому — включай только по прямой просьбе.',
    tagMappings: ['assignee', 'исполнитель'], viewConfig: { keyFields: ['executor', 'may_close'] },
  },
  {
    id: 'orbis/agent-run', name: 'Прогон исполнителя', namespace: 'orbis', icon: '🤖',
    description: 'Служебная сущность прогона агента: шаги, исход, расход',
    aiInstructions:
      'orbis/agent-run — прогон исполнителя по тикету (дочерняя сущность тикета). Создаётся и ' +
      'обновляется ТОЛЬКО глаголами orbis_claim_task / orbis_run_step / orbis_checkpoint / ' +
      'orbis_finish; вручную не создавай и не правь. Служебный: в основных выдачах не показывается, ' +
      'запрашивай явно через aspect=orbis/agent-run.',
    tagMappings: [], viewConfig: { keyFields: ['outcome', 'step_count'] },
  },
```

- [ ] **Шаг 5: служебные аспекты без `attach_*`** — в `apps/server/src/tools/registry.ts`
  `buildToolDefs` (`:462-464`) фильтровать строки реестра: `rows.filter((r) => !SERVICE_ASPECT_IDS.includes(r.id))`
  перед `attachToolDef`, с комментарием «прогон правит только сервер (С5/С7); модель без тула не
  сможет создать прогон мимо глаголов». Тест в `registry.test.ts`: `defs.find(d => d.name === 'attach_orbis_agent_run')` — `undefined`;
  `attach_orbis_assignment`, `attach_orbis_project`, `attach_orbis_repo` — есть.

- [ ] **Шаг 6: подписи web** — `apps/web/src/lib/field-labels.ts`: `ASPECT_LABELS` +
  «Проект», «Репозиторий», «Назначение», «Прогон исполнителя»; `FIELD_LABELS` + `stage: 'Стадия'`,
  `url: 'Адрес'`, `default_branch: 'Ветка по умолчанию'`, `executor: 'Исполнитель'`,
  `grant_id: 'Доступ агента'`, `assignee: 'Кто'`, `may_close: 'Может закрывать'`, `outcome: 'Исход'`,
  `started_at: 'Начало'`, `finished_at: 'Конец'`, `last_step_at: 'Последний шаг'`,
  `step_count: 'Шагов'`, `session_url: 'Сессия'`, `report: 'Отчёт'`, `project_id: 'Проект'`.

- [ ] **Шаг 7: счётчики** — `registry.test.ts:108,114` → 22 (11 core + 11 attach; глаголы
  добавит Задача 10 → тогда 27), `:249` → 23; `mcp.test.ts:409,446` — переписать заголовок и
  комментарий по факту (`publicDefs.length` считается динамически); `seed-aspects.test.ts:10` —
  «12 builtin-строк»; в `aspects-validate.test.ts` — один тест «`orbis/assignment` валидируется
  ajv по строке реестра из БД» по образцу теста `orbis/goal` из `705c12e`.

- [ ] **Шаг 8: локальный пересев и прогон** — `bun scripts/seed-aspects.ts` (нужен
  `DATABASE_URL_ADMIN`), затем `bun run test`, `bun run lint`, `bun run typecheck` → 0.

- [ ] **Шаг 9: коммит** — `git commit -- packages/shared apps/server/src/tools apps/server/src/mcp apps/server/test apps/server/src/executor/aspects-validate.test.ts apps/web/src/lib/field-labels.ts -m "feat(registry): четыре аспекта ADE-среза 1 — project, repo, assignment, agent-run (С4)"`.

---

### Задача 2: Служебные сущности не попадают в основные выдачи

**Файлы:**
- Изменить: `apps/server/src/query/compile.ts:169-177` (`compileWhere`)
- Тест: `apps/server/src/query/compile.dataset.test.ts` (живая БД) — новый `describe`

**Интерфейсы:** потребляет `SERVICE_ASPECT_IDS` из `@orbis/shared` (Задача 1).

- [ ] **Шаг 1: падающий тест** — в `compile.dataset.test.ts` (обвязка как у соседних тестов
  файла: `appDb()`, `truncateAll()`, сущности через `execute`):

```ts
describe('служебные сущности (02-core-os §3.9): прогоны вне основных выдач', () => {
  test('запрос без aspect=orbis/agent-run не возвращает прогонов; с ним — возвращает', async () => {
    // тикет + прогон-ребёнок с orbis/agent-run
    const ticketId = newId(); const runId = newId();
    await create(ticketId, 'Тикет', { 'orbis/task': { status: 'in_progress' } });
    await create(runId, 'Прогон', { 'orbis/agent-run': { grant_id: newId(), outcome: 'running', started_at: T, last_step_at: T, step_count: 0, steps: [] } });
    const all = await runQuery('sortBy=updated_at:desc');
    expect(all.map((e) => e.id)).toContain(ticketId);
    expect(all.map((e) => e.id)).not.toContain(runId);
    const runs = await runQuery('aspect=orbis/agent-run');
    expect(runs.map((e) => e.id)).toEqual([runId]);
    // search= тем же путём
    const found = await runQuery('search=Прогон');
    expect(found).toHaveLength(0);
  });
});
```
  (`create`/`runQuery` — локальные хелперы файла: `execute(entity_create)` и `compileQuery` +
  `db.execute`, как в соседних тестах; при отсутствии — написать по их образцу.)

- [ ] **Шаг 2:** `cd apps/server && bun test src/query/compile.dataset.test.ts` — FAIL (прогон в выдаче).

- [ ] **Шаг 3: реализация** — в `compileWhere` после условия `NOT archived`:

```ts
  // Служебные аспекты (02-core-os §3.9): прогоны исполнителя поднимались бы в топ «свежего» на
  // каждый orbis_run_step (С5). Прячем неявно — пока запрос сам не назвал такой аспект через
  // aspect=. Оператор ?| по колонке покрыт GIN entities_aspects_gin (в отличие от подпутевых форм).
  const named = [...aspects];
  if (!SERVICE_ASPECT_IDS.some((id) => named.includes(id))) {
    conds.push(sql`NOT (aspects ?| ${textArray([...SERVICE_ASPECT_IDS])})`);
  }
```
  (`textArray` уже используется для `tags`; `aspects: Set<string>` — множество `aspect=` запроса.)
  Убедиться, что `entity.count` (`routers/entity.ts:318-323`) идёт через тот же `compileWhere`.

- [ ] **Шаг 4:** тест PASS; golden-тесты компилятора (`compile.golden.test.ts`) — обновить
  эталоны SQL, если они пинят полный WHERE (появится `NOT (aspects ?| …)`), с пояснением в коммите.

- [ ] **Шаг 5:** `bun run test` → 0; коммит `feat(query): служебные аспекты вне основных выдач (§3.9, С5)`.

---

### Задача 3: Таблица `entity_versions` — схема, миграции 0010/0011, RLS, pgTAP

**Файлы:**
- Изменить: `apps/server/src/db/schema.ts` (после `entityOrigins:190-203`), `apps/server/src/db/migrations/meta/_journal.json`,
  `apps/server/test/rls/rls.pgtap.sql:6,40-47` (+ новые проверки), `apps/server/test/helpers.ts:35-41`,
  `docs/implementation/02-ops-runbook.md:632-634` (список таблиц — можно отложить до Задачи 17, но не забыть)
- Создать: `apps/server/src/db/migrations/0010_<имя от генератора>.sql` + `meta/0010_snapshot.json`,
  `apps/server/src/db/migrations/0011_ade_versions_rls.sql`
- Переименовать: `0010_drop_body_before_doc.sql` → `0012_drop_body_before_doc.sql` (+ поправить в его
  шапке упоминание номера; файл в журнале НЕ регистрируется, как и раньше)

**Интерфейсы (produces):**
```ts
export const entityVersions = pgTable('entity_versions', {
  id: uuid('id').primaryKey(),                       // uuidv7, генерит сервер (newId)
  ownerId: uuid('owner_id').notNull(),
  entityId: uuid('entity_id').notNull().references(() => entities.id, { onDelete: 'cascade' }),
  label: text('label').notNull(),                    // подпись версии (С11: версия — по решению человека, с подписью)
  body: text('body').notNull(),                      // markdown-проекция на момент снимка — ВСЕГДА
  bodyDoc: jsonb('body_doc'),                        // документ, если у сущности он уже был; NULL — не бэкфиллена
  actorUserId: uuid('actor_user_id').notNull(),
  actorKind: text('actor_kind').notNull(),           // owner | agent (агент — со среза 4)
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('entity_versions_entity_created').on(t.entityId, t.createdAt.desc())]);
```

- [ ] **Шаг 1: падающий pgTAP** — в `rls.pgtap.sql`: `plan(38)` → `plan(42)`; в группе 1 (`:40-47`)
  добавить `'entity_versions'` в `IN (...)`, `10 → 11`, текст «на всех одиннадцати таблицах»;
  в конце (перед `ROLLBACK`) четыре проверки по образцу `:113-142`:
  (a) под identity A `SELECT count(*) FROM entity_versions` = 1 (фикстура: одна версия A, одна B,
  вставленные под админом); (b) `INSERT` с `owner_id` B под identity A → `throws_ok … '42501'`;
  (c) `INSERT` своей → `lives_ok`; (d) без identity — 0 строк. Запустить `bun run test:rls` — FAIL
  (таблицы нет).

- [ ] **Шаг 2: схема + генерация** — дописать `entityVersions` в `schema.ts` (стиль как у
  `entityOrigins`, `references … onDelete: 'cascade'` — при удалении сущности версии не нужны);
  `cd apps/server && bun run db:generate` → появится `0010_<случайное>.sql` со снимком и запись
  `idx: 10` в `_journal.json`. Переименовывать сгенерированный файл НЕ надо (ревью M плана редактора).
  **До генерации** переименовать `0010_drop_body_before_doc.sql` → `0012_drop_body_before_doc.sql`
  (`git mv`), иначе два файла `0010_*`. В шапке этого файла (`:3-7`) заменить упоминание номера и
  добавить строку «переименован планом ADE-среза 1: 0010 занял entity_versions, 0011 — его RLS».

- [ ] **Шаг 3: рукописная RLS** — `0011_ade_versions_rls.sql` по образцу `0005_oauth_rls.sql` и
  `0001_rls_and_indexes.sql:35-38`:

```sql
-- entity_versions (§2.2, ADE-срез 1, С11): владение прямое, по owner_id — как у entity_origins.
ALTER TABLE entity_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE entity_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_owns_row ON entity_versions FOR ALL
  USING (owner_id = (SELECT auth.uid()))
  WITH CHECK (owner_id = (SELECT auth.uid()));
-- GRANT ... ON ALL TABLES из 0001 на таблицы, созданные позже, не распространяется (см. 0005:47-49)
GRANT SELECT, INSERT, UPDATE, DELETE ON entity_versions TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON entity_versions TO orbis_app;
```
  Запись в `_journal.json`: `idx: 11`, `tag: '0011_ade_versions_rls'`, `when` строго больше
  `when` записи 0010, `breakpoints: true` (как у 0005). Снимка у рукописной миграции нет — норма.

- [ ] **Шаг 4: тест-хелпер** — `helpers.ts:37-38`: добавить `entity_versions` в `TRUNCATE`.
- [ ] **Шаг 5:** `bun run db:prepare` (накат + pgTAP) → 0; `bun run test:rls` → 0; повторный
  `bun run db:generate` печатает «No schema changes».
- [ ] **Шаг 6:** `bun run test` → 0 (регрессий нет); коммит `feat(db): таблица entity_versions — миграции 0010/0011, RLS, pgTAP (С11)` с `git mv`.

---

### Задача 4: Инварианты executor'а — живой грант в назначении, засев заготовки проекта

**Файлы:**
- Создать: `apps/server/src/seed/project-body.ts`
- Изменить: `apps/server/src/executor/executor.ts` (`prepareEntityCreate` ~`:820-960`, `prepareEntityUpdate` ~`:1046-1110`,
  prepare для `attach_*` ~`:1290-1340`), `apps/server/src/executor/normalize.ts` (хелперы)
- Тест: `apps/server/src/executor/executor.test.ts` (новый `describe`), `apps/server/src/seed/project-body.test.ts`

**Интерфейсы (produces):**
```ts
// apps/server/src/seed/project-body.ts
export function projectBodyTemplate(projectId: string): string; // markdown с {{query:…}}-блоками
// apps/server/src/executor/normalize.ts
export function needsProjectSeed(prev: AspectsMap | undefined, next: AspectsMap, currentBody: string, bodyInInput: boolean): boolean;
export async function assertAssignment(tx: Tx, ownerId: string, next: AspectsMap): Promise<void>; // бросает ExecError
```

- [ ] **Шаг 1: падающие тесты** — в `executor.test.ts`:

```ts
describe('ADE-срез 1: инварианты назначения и засев проекта', () => {
  test('executor=agent без grant_id → VALIDATION; с чужим/отозванным грантом → NOT_FOUND', async () => {
    const id = newId();
    const bad = await execute(db, req([{ tool: 'entity_create', input: { id, title: 'Т', tags: [], aspects: { 'orbis/task': { status: 'inbox' }, 'orbis/assignment': { executor: 'agent' } } } }]));
    expect(bad.ok).toBe(false); if (!bad.ok) expect(bad.error.code).toBe('VALIDATION');
    const foreign = await execute(db, req([{ tool: 'entity_create', input: { id, title: 'Т', tags: [], aspects: { 'orbis/task': { status: 'inbox' }, 'orbis/assignment': { executor: 'agent', grant_id: newId() } } } }]));
    expect(foreign.ok).toBe(false); if (!foreign.ok) expect(foreign.error.code).toBe('NOT_FOUND');
  });
  test('executor=agent с живым грантом владельца — ок; executor=human с grant_id → VALIDATION', async () => {
    const token = await issuePatGrant(db, { ownerId: userA, label: 'исполнитель' });
    const grantId = (await verifyBearer(db, token))!.grantId;
    const ok = await execute(db, req([{ tool: 'entity_create', input: { id: newId(), title: 'Т', tags: [], aspects: { 'orbis/task': { status: 'inbox' }, 'orbis/assignment': { executor: 'agent', grant_id: grantId } } } }]));
    expect(ok.ok).toBe(true);
    const human = await execute(db, req([{ tool: 'entity_create', input: { id: newId(), title: 'Т', tags: [], aspects: { 'orbis/task': { status: 'inbox' }, 'orbis/assignment': { executor: 'human', grant_id: grantId } } } }]));
    expect(human.ok).toBe(false);
  });
  test('создание сущности с orbis/project и пустым телом засевает заготовку с блоками; непустое тело не трогается', async () => {
    const id = newId();
    const r = await execute(db, req([{ tool: 'entity_create', input: { id, title: 'Проект', tags: [], aspects: { 'orbis/project': { stage: 'active' } } } }]));
    expect(r.ok).toBe(true);
    const row = await withIdentity(db, userA, (tx) => readEntity(tx, /* сигнатуру сверить: entity-read.ts:48 */ { id, include: new Set(['body']) }));
    expect(row.entity.body).toContain(`{{query: aspect=orbis/agent-run, project_id=${id}`);
    expect(row.entity.body).toContain('children_of=this, aspect=orbis/task, status=waiting');
    // канон: повторная канонизация не меняет тело
    expect(canonicalizeBody(row.entity.body).body).toBe(row.entity.body);
  });
  test('attach_orbis_project на заметку с пустым телом засевает; с телом — нет', async () => { /* attach_orbis_project через execute; проверить body */ });
});
```
  `req(ops)` — локальная фабрика `ExecuteRequest` файла (`actorUserId: userA, actorKind:'owner', source:'ui', operations`).

- [ ] **Шаг 2:** `cd apps/server && bun test src/executor/executor.test.ts` — FAIL.

- [ ] **Шаг 3: шаблон** — `apps/server/src/seed/project-body.ts`:

```ts
/**
 * Заготовка тела проекта (С10): проза процесса + живые query-блоки. Засевается executor'ом,
 * когда на сущность приходит orbis/project при пустом теле — путь один для чата, MCP и UI.
 * `children_of=this` достаёт тикеты; прогоны — внуки, `this` их не достаёт, поэтому на прогоне
 * есть project_id, а сюда подставляется реальный uuid проекта.
 */
export function projectBodyTemplate(projectId: string): string {
  return [
    '## Процесс',
    '',
    'Опишите, как исполнитель работает над тикетами проекта: стадии, где остановиться и спросить (чекпойнт), что считать готовым. Исполнитель читает этот раздел при захвате тикета (orbis_claim_task).',
    '',
    '## В работе',
    '',
    '{{query: children_of=this, aspect=orbis/task, status=in_progress, sortBy=updated_at:desc, display=list, title=В работе}}',
    '',
    '## Ждут меня',
    '',
    '{{query: children_of=this, aspect=orbis/task, status=waiting, sortBy=updated_at:asc, display=list, title=Ждут меня}}',
    '',
    '## Бэклог',
    '',
    '{{query: children_of=this, aspect=orbis/task, status=inbox|planned, sortBy=priority:desc|created_at:asc, display=list, title=Бэклог}}',
    '',
    '## Последние прогоны',
    '',
    `{{query: aspect=orbis/agent-run, project_id=${projectId}, sortBy=created_at:desc, limit=10, display=compact, title=Последние прогоны}}`,
    '',
  ].join('\n');
}
```
  Тест `project-body.test.ts`: `canonicalizeBody(projectBodyTemplate(id)).body === projectBodyTemplate(id)`
  (шаблон канонический — иначе первый же пересчёт сдвинет тело) и `parseBlock`/`parseQuery`
  разбирает все пять блоков без ошибок (каталог — из `BUILTIN_ASPECT_META`/схем).

- [ ] **Шаг 4: инвариант назначения** — `normalize.ts`:

```ts
/** С4/С7: назначение агенту указывает на ЖИВОЙ грант владельца; jsonb FK не даёт — проверяем сами. */
export async function assertAssignment(tx: Tx, ownerId: string, next: AspectsMap): Promise<void> {
  const a = next['orbis/assignment'];
  if (!a) return;
  if (a.executor === 'agent') {
    if (typeof a.grant_id !== 'string') throw new ExecError('VALIDATION', 'назначение агенту требует grant_id', { aspect: 'orbis/assignment' });
    const rows = await tx.select({ id: agentGrants.id }).from(agentGrants)
      .where(and(eq(agentGrants.id, a.grant_id), eq(agentGrants.ownerId, ownerId), isNull(agentGrants.revokedAt)));
    if (rows.length === 0) throw new ExecError('NOT_FOUND', 'грант исполнителя не найден или отозван', { grant_id: a.grant_id });
  } else if (a.grant_id !== undefined) {
    throw new ExecError('VALIDATION', 'grant_id допустим только при executor=agent', { aspect: 'orbis/assignment' });
  }
}
```
  Вызывать в стадии 4 `prepareEntityCreate` (рядом с `applyTaskCompletion`, `:846`) и
  `prepareEntityUpdate` (после merge, `:1067-1071`, только в НЕ-`internalUndo` ветке — undo
  восстанавливает состояние как было), и в prepare `attach_*` (там аспект тоже сливается).
  Чтение `agent_grants` под `SET LOCAL ROLE authenticated`: RLS таблицы — `owner_owns_row` +
  политика `orbis_app` (`0005:35-36`) — под identity владельца строка видна.

- [ ] **Шаг 5: засев** — хелпер `needsProjectSeed(prev, next, currentBody, bodyInInput)`:
  `next['orbis/project'] !== undefined && prev?.['orbis/project'] === undefined && currentBody.trim() === '' && !bodyInInput`.
  В трёх prepare (create/update/attach), когда он истинен: положить в патч результат
  `canonicalizeBody(projectBodyTemplate(entityId))` ТЕМ ЖЕ кодом, что ветка строкового `body`
  (`executor.ts:1214-1222`, у create — `:836-839,906-931`): вынести ветку в хелпер
  `applyBodyString(patch, md)` и вызвать его — чтобы `body_refs`, `body_before_doc` и канон
  заполнились одинаково. Гейт `expectedUpdatedAt` не срабатывает: он смотрит на `input.body`, а
  не на патч.

- [ ] **Шаг 6:** тесты PASS; `bun run test`; коммит `feat(executor): живой грант в назначении и засев заготовки проекта (С4, С10)`.

---

### Задача 5: Закреплённые версии — операции executor'а и tRPC `version.*`

**Файлы:**
- Изменить: `apps/server/src/executor/executor.ts` (ветка `prepareOp:486-505`; новые
  `prepareVersionPin`/`prepareVersionDelete` по образцу `prepareOriginCreate`/`prepareOriginDelete`
  `:184-195` и `:1780-1810`), `apps/server/src/executor/types.ts:106-113` (`ActionRecord.type` +
  `'version_pinned' | 'version_deleted'`), `apps/server/src/wire.ts` (`WireEntityVersion`),
  `apps/server/src/router.ts`
- Создать: `apps/server/src/routers/version.ts`, `apps/server/src/routers/version.test.ts`
- Тест: `apps/server/src/executor/executor.test.ts` (undo закрепления)

**Интерфейсы (produces):**
```ts
// wire.ts
export interface WireEntityVersion { id: string; entityId: string; label: string; hasDoc: boolean; actorKind: 'owner'|'ai'|'agent'; createdAt: string; }
// executor: внутренние операции (в CORE_TOOLS не регистрируются, как entity_origin_*)
//   entity_version_pin    { id?: uuid, entity_id: uuid, label: string(1..200) } → WireEntityVersion
//   entity_version_delete { id: uuid }                                           → { id }
// tRPC (ownerOnlyProcedure):
//   version.pin({ entityId, label }) → WireEntityVersion
//   version.list({ entityId }) → WireEntityVersion[]           (created_at desc)
//   version.restore({ versionId, expectedUpdatedAt }) → WireEntity  (409 при расхождении)
```

- [ ] **Шаг 1: падающие тесты** — `routers/version.test.ts` (caller через
  `createCallerFactory(appRouter)` как в `apps/server/test/e2e.slice1a.test.ts:27-29`):

```ts
test('pin → list → правка тела → restore: тело канонично эквивалентно снимку, аспекты и связи не тронуты (инвариант 8)', async () => {
  const id = newId();
  await a.entity.create({ input: { id, title: 'Док', tags: [], body: '# Раз\n\n- два\n', aspects: { 'orbis/task': { status: 'planned' } } }, source: 'quick_capture' });
  const v = await a.version.pin({ entityId: id, label: 'до правки' });
  expect(v.hasDoc).toBe(true);
  const e1 = await a.entity.get({ id, include: ['body', 'bodyDoc'] });
  await a.entity.update({ id, expectedUpdatedAt: e1.entity.updatedAt, body: '# Совсем другое', aspects: { 'orbis/task': { status: 'waiting' } } });
  const e2 = await a.entity.get({ id, include: ['body', 'bodyDoc'] });
  const restored = await a.version.restore({ versionId: v.id, expectedUpdatedAt: e2.entity.updatedAt });
  expect(restored.body).toBe(canonicalizeBody('# Раз\n\n- два\n').body);
  expect(restored.aspects['orbis/task']).toEqual({ status: 'waiting' }); // аспекты не откатываются (С11)
});
test('restore со стухшим expectedUpdatedAt → CONFLICT (409), тело не изменилось', async () => { /* … */ });
test('снимок сущности без body_doc (легаси-строка) хранит только body; restore идёт строкой', async () => {
  // строка «до бэкфилла»: вставить через adminDb: INSERT entities (id, owner_id, title, body) без body_doc
  // pin → hasDoc=false; restore → тело = canonicalizeBody(body).body
});
test('«отмени последнее» после pin удаляет версию (undo как у entity_origin_*)', async () => {
  const v = await a.version.pin({ entityId: id, label: 'x' });
  await a.ai.undoLast();
  expect((await a.version.list({ entityId: id })).find((x) => x.id === v.id)).toBeUndefined();
});
```

- [ ] **Шаг 2:** прогон — FAIL (`version` не в роутере).

- [ ] **Шаг 3: операции executor'а** — по образцу `entity_origin_create` (`executor.ts:184-195`
  схемы; `:1780-1810` prepare): `prepareVersionPin` — стадия 3: `select` сущности под RLS
  (`NOT_FOUND` если нет), стадия 5: `insert entityVersions { id, ownerId, entityId, label,
  body: current.body, bodyDoc: current.bodyDoc /* как лежит: null у небэкфилленных */,
  actorUserId, actorKind }`; журнал `type: 'version_pinned'`, `entity_id`, `inverse: [{ op:
  'entity_version_delete', payload: { id } }]`, карточка «Закреплена версия «label»».
  `prepareVersionDelete` — физическое удаление строки, `inverse: []` с комментарием «достижимо
  только как inverse закрепления; undo самого undo в Orbis не существует (undo.ts:4-5)».
  Ветки в `prepareOp`; варианты типа в `ActionRecord.type`.

- [ ] **Шаг 4: роутер** — `routers/version.ts`: `pin` → `execute(entity_version_pin)` с
  `source:'ui'`, `actorKind:'owner'`; `list` → `select` под `withIdentity` c `hasDoc = body_doc IS NOT NULL`;
  `restore` → прочитать версию (RLS), затем `execute({ tool: 'entity_update', input: { id: entityId,
  expectedUpdatedAt, ...(v.bodyDoc && v.bodyDoc.v === DOC_SCHEMA_VERSION ? { bodyDoc: v.bodyDoc } : { body: v.body }) } })`
  — тем же конвейером и конвертером, что запись редактора (С11); `bodyDoc` допустим, потому что
  executor парсит `entityUpdateUiInput` (`executor.ts:1014`). Ошибки → `execErrorToTRPC`.
  Зарегистрировать в `router.ts` (`version: versionRouter`).

- [ ] **Шаг 5:** тесты PASS; `bun run test`; коммит `feat(versions): закрепление и откат версии тела через executor (С11)`.

---

### Задача 6: Идентичность гранта — от bearer до записи журнала

**Файлы:**
- Изменить: `apps/server/src/oauth/grants.ts:26-29,83-101` (`GrantIdentity += scope,label`;
  `verifyBearer` возвращает их из `.returning`), `apps/server/src/mcp/transport.ts:97`,
  `apps/server/src/mcp/server.ts:43,72-86` (`makeMcpServer(deps, identity)`), `apps/server/src/tools/dispatch.ts:72-86,488-500`
  (`ToolCallCtx.grant?`), `apps/server/src/executor/types.ts:11-19,114-118` (`ExecuteRequest.actorGrantId?/runId?`,
  `ActionRecord.actor_grant_id?/run_id?`), `apps/server/src/executor/executor.ts:380-389,543-546`
  (запись полей в action), `apps/server/src/context.ts:34-43` (симметрично: `ctx.grant`)
- Тесты: `apps/server/src/oauth/grants.test.ts`, `apps/server/src/executor/journal.test.ts`, `apps/server/src/mcp/mcp.test.ts`

**Интерфейсы (produces):**
```ts
export interface GrantIdentity { grantId: string; ownerId: string; scope: GrantScope; label: string; }
export interface GrantRef { id: string; scope: GrantScope; label: string; }
export interface ToolCallCtx { …; grant?: GrantRef; }                        // есть только у MCP
export interface ExecuteRequest { …; actorGrantId?: string; runId?: string; }
export interface ActionRecord  { …; actor_grant_id?: string; run_id?: string; }
export function makeMcpServer(deps: McpDeps, identity: GrantIdentity): Server;
```

- [ ] **Шаг 1: падающие тесты** — `grants.test.ts`: `verifyBearer` возвращает `scope: 'full'` и
  `label` у PAT; `journal.test.ts`: `execute` с `actorGrantId`/`runId` пишет `actor_grant_id`/`run_id`
  в `metadata.actions[0]`; без них — полей нет (не `null`, а отсутствуют — контейнмент-пробы
  `@> {"actions":[{"run_id":…}]}` должны работать); `mcp.test.ts`: `tools/call entity_create`
  через SDK-клиента → audit-сообщение в глобальном треде несёт `actor_kind:'agent'` и `actor_grant_id`
  = id гранта.

- [ ] **Шаг 2:** прогон — FAIL.

- [ ] **Шаг 3: реализация** — `verifyBearer`: `.returning({ id, ownerId, scope, label })`;
  транспорт: `makeMcpServer(deps, identity)`; сервер: `dispatchTool({ …, actorUserId: identity.ownerId,
  grant: { id: identity.grantId, scope: identity.scope as GrantScope, label: identity.label } }, …)`;
  `dispatch.runMutation` (`:488-500`) и все `execute(...)` в dispatch — `actorGrantId: ctx.grant?.id`;
  executor — при сборке `ActionRecord` (одиночный `:543-546`, batch `:380-389`) добавлять поля
  только если заданы (`...(req.actorGrantId !== undefined && { actor_grant_id: req.actorGrantId })`).
  `context.ts` — `grant` из `verifyBearer` для агентского Bearer в tRPC (используется позже
  проверками; сейчас — симметрия и тест).

- [ ] **Шаг 4:** тесты PASS; `bun run test`, `bun run typecheck`; коммит `feat(mcp): грант доходит до контекста тулов и журнала (actor_grant_id, run_id)`.

---

### Задача 7: Скоуп `worker` — fail-closed гейт, `tools/list`, сужение `thread_post`

**Файлы:**
- Изменить: `apps/server/src/tools/registry.ts:17-29` (`OrbisToolDef.agentOnly?`), там же константы
  `WORKER_SCOPE_TOOLS`, `AGENT_VERB_NAMES`; `apps/server/src/tools/dispatch.ts:117-128` (гейт),
  `:173-197,730-756` (`thread_post`), `apps/server/src/mcp/server.ts:54-60` (`tools/list`),
  `apps/server/src/ai/send-message.ts:299-305` (чат не видит `agentOnly`)
- Создать: `apps/server/src/agent-loop/queries.ts` (`isWorkerThreadTarget`)
- Тесты: `apps/server/src/tools/dispatch.test.ts` (рядом с `:505-513,599-606`), `apps/server/src/mcp/mcp.test.ts`

**Интерфейсы (produces):**
```ts
// tools/registry.ts
export const AGENT_VERB_NAMES = ['orbis_my_queue','orbis_claim_task','orbis_run_step','orbis_checkpoint','orbis_finish'] as const;
/** Что доступно скоупу worker сверх read-тулов (С7): глаголы + thread_post. Всё прочее — отказ. */
export const WORKER_SCOPE_TOOLS: ReadonlySet<string> = new Set([...AGENT_VERB_NAMES, 'thread_post']);
export interface OrbisToolDef { …; agentOnly?: boolean; }  // только при наличии ctx.grant (MCP); чат не видит
// agent-loop/queries.ts
export async function isWorkerThreadTarget(tx: Tx, ownerId: string, grantId: string, entityId: string): Promise<boolean>;
```
  Гейт скоупа встаёт ДО политики §7.10 (рядом с `internalOnly`): скоуп — ось доступа, а
  классификатор сознательно не смотрит на актора (`confirmation.ts:3-5`). Код ошибки —
  `FORBIDDEN_LEVEL` (→ 403; `errors.ts:51`): в отличие от `internalOnly`, это не «внутренний
  тул», а «нет права» — и MCP-клиент видит `isError:true`, `error.code:'FORBIDDEN_LEVEL'`.

- [ ] **Шаг 1: падающие тесты** — `dispatch.test.ts`:

```ts
const worker = () => ctxFor({ actorKind: 'agent', source: 'mcp', grant: { id: grantId, scope: 'worker', label: 'w' } });
test('worker: entity_update / attach_orbis_task / batch_execute → FORBIDDEN_LEVEL, ничего не записано', async () => {
  for (const [name, input] of [['entity_update', { id: eid, aspects: { 'orbis/task': { status: 'done' } } }], ['attach_orbis_task', { entity_id: eid, data: { status: 'done' } }], ['batch_execute', { batch_id: newId(), operations: [] }]] as const) {
    const r = await dispatchTool(worker(), name, input);
    expectError(r, 'FORBIDDEN_LEVEL');
  }
  // статус тикета не изменился
});
test('worker: entity_get / entity_query / budget_status исполняются', async () => { /* status ok */ });
test('worker: thread_post в тред назначенного тикета и его проекта — ок; в тред чужой заметки — FORBIDDEN_LEVEL', async () => { /* тикет с orbis/assignment.grant_id = grantId, parent проект; заметка без назначения */ });
```
  Гейт `agentOnly` (см. Шаг 3) в этой задаче остаётся без дефов с флагом — его тест
  («глагол без `ctx.grant` → VALIDATION») пишет Задача 12, когда глаголы появятся.
  `mcp.test.ts`: `issuePatGrant(db, { ownerId, label, scope: 'worker' })` (сигнатура появится в
  Задаче 8; ДО неё в тесте — `UPDATE agent_grants SET scope='worker'` через `adminDb`) →
  `tools/list` не содержит `entity_update`/`attach_*`/`batch_execute`, содержит `entity_get`,
  `thread_post`; `tools/call entity_update` → `isError`, `FORBIDDEN_LEVEL`.

- [ ] **Шаг 2:** прогон — FAIL.

- [ ] **Шаг 3: реализация** — в `dispatchTool` после гейта `internalOnly` (`:119-128`):

```ts
    // Скоуп worker (С7, §4.14): фоновому исполнителю открыты только глаголы, thread_post и чтение.
    // Гейт стоит здесь, а не в классификаторе §7.10: тот сознательно не смотрит на актора, а
    // скоуп — ось доступа. Отказ структурированный (§7.10 «forbidden»), до любой записи.
    if (ctx.grant?.scope === 'worker' && def.kind !== 'read' && !WORKER_SCOPE_TOOLS.has(def.name)) {
      return { kind: 'done', out: errorResult('FORBIDDEN_LEVEL', `тул «${name}» недоступен скоупу worker (§4.14)`, { tool: name, scope: 'worker' }) };
    }
    if (def.agentOnly === true && ctx.grant === undefined) {
      return { kind: 'done', out: errorResult('VALIDATION', `тул «${name}» — глагол исполнителя, доступен только внешнему агенту с грантом (§9.3)`, { tool: name }) };
    }
```
  `runThreadPost` (`:730-756`): при `ctx.grant?.scope === 'worker'` — `isWorkerThreadTarget`
  (один SQL: `entity_id` — тикет с `aspects @> {"orbis/assignment":{"grant_id":G}}` ИЛИ
  проект-родитель такого тикета через `relations … relation_type='parent'`), иначе
  `FORBIDDEN_LEVEL` «worker пишет только в треды назначенных тикетов и их проектов (С7/С9)».
  `mcp/server.ts tools/list`: `.filter(d => d.internalOnly !== true && (identity.scope !== 'worker' || d.kind === 'read' || WORKER_SCOPE_TOOLS.has(d.name)))`.
  `send-message.ts:299-305`: `defs.filter(d => d.agentOnly !== true)` с комментарием «у чата нет
  гранта — глаголы исполнителя ему не адресованы».

- [ ] **Шаг 4:** тесты PASS; `bun run test`; коммит `feat(scope): скоуп worker — fail-closed гейт, tools/list, thread_post только в свои треды (С7)`.

---

### Задача 8: Выдача скоупа — экран согласия, PAT, `/oauth/token`, «Настройки → Агенты»

**Файлы:**
- Изменить: `apps/server/src/oauth/grants.ts:104-127` (`createAuthorizationCode({…, scope})`), `:240-253` (`issuePatGrant({ ownerId, label, scope? })`), `:261-275` (`listGrants` + `scope`),
  `apps/server/src/oauth/metadata.ts:186` (`scopes_supported: [...GRANT_SCOPES]`), `apps/server/src/oauth/token-endpoint.ts:152-153` (`scope` из гранта),
  `apps/server/src/routers/oauth.ts:100-121` (`consent` input `scope: z.enum(GRANT_SCOPES).default('full')`), `apps/server/src/wire.ts:180-201` (`WireAgentGrant.scope`),
  `apps/web/src/features/oauth/ConsentScreen.tsx:68` (радио), `apps/web/src/features/settings/ConnectedAgents.tsx:12-13,73` (подпись скоупа),
  `scripts/issue-pat.ts`, `scripts/ops.ts:448` (`issue-pat <owner> [метка] [--scope worker]`)
- Тесты: `apps/server/src/oauth/grants.test.ts`, `oauth.e2e.test.ts` (полный путь с `scope=worker` → токен → `/mcp` видит только worker-набор), `apps/server/src/routers/oauth.test.ts`, `apps/web/src/features/oauth/ConsentScreen.test.tsx`, `apps/web/src/features/settings/ConnectedAgents.test.tsx`

**Интерфейсы (produces):**
```ts
issuePatGrant(db, { ownerId, label, scope?: GrantScope }): Promise<string>;   // default 'full'
createAuthorizationCode(db, { …, scope: GrantScope }): …;
oauth.consent({ …, scope?: 'full'|'worker' });                                 // default full
WireAgentGrant { …; scope: 'full'|'worker' }
```

- [ ] **Шаг 1: падающие тесты** — `grants.test.ts`: `issuePatGrant(...scope:'worker')` →
  `verifyBearer(...).scope === 'worker'`; `oauth.e2e.test.ts`: consent с `scope:'worker'` →
  ответ `/oauth/token` содержит `scope: 'worker'` → `/mcp tools/list` без `entity_update`;
  `oauth.test.ts`: `listGrants` отдаёт `scope`; web: `ConsentScreen` — радио «Полный доступ»
  (по умолчанию) / «Только исполнитель (worker)»; выбор второго → `oauth.consent` вызван с
  `scope:'worker'`; `ConnectedAgents` — строка гранта показывает «исполнитель» при `scope==='worker'`.

- [ ] **Шаг 2:** прогон — FAIL.

- [ ] **Шаг 3: реализация** — сервер: колонка `scope` пишется при выдаче кода и PAT (сегодня —
  DEFAULT), `token-endpoint` отдаёт `scope` строки гранта (и на refresh тоже — одна ветка ответа),
  `metadata` — `scopes_supported: [...GRANT_SCOPES]`; web: радио в `ConsentScreen` с пояснением
  «исполнитель видит граф и пишет только через глаголы задач; закрыть тикет сам не может»;
  `ConnectedAgents` — бейдж «исполнитель»/«полный доступ». Скрипты: `--scope worker` (третий
  позиционный/флаг), help `ops.ts` дописать.

- [ ] **Шаг 4:** тесты PASS; `bun run test`; коммит `feat(oauth): выдача скоупа worker — согласие, PAT, token, экран агентов (§4.14)`.

---

### Задача 9: CAS-предусловие `entity_update` + тест на гонку

**Файлы:**
- Изменить: `packages/shared/src/contracts/tools.ts:26-63` (`entityUpdatePrecondition`, `entityUpdateExecInput`),
  `apps/server/src/executor/executor.ts:1005-1045` (парсить exec-схему; проверка предусловий после `loadEntityForUpdate`)
- Тесты: `apps/server/src/executor/executor.test.ts`, `apps/server/src/executor/body-doc.test.ts:951-1007` (соседи «непротекания»), `apps/server/src/tools/dispatch.test.ts`, `apps/server/src/routers/entity.test.ts`

**Интерфейсы (produces):**
```ts
// contracts/tools.ts
export const entityUpdatePrecondition = z.array(
  z.object({ aspect: z.string().min(1), field: z.string().min(1), in: z.array(z.unknown()).min(1) }).strict(),
).min(1);
export type EntityUpdatePrecondition = z.infer<typeof entityUpdatePrecondition>;
/** Надмножество для executor'а: UI-форма (bodyDoc) + серверное CAS-предусловие (С7). Тул и tRPC его не принимают. */
export const entityUpdateExecInput = entityUpdateInput
  .extend({ bodyDoc: bodyDocSchema.optional(), precondition: entityUpdatePrecondition.optional() })
  .refine((v) => !(v.body !== undefined && v.bodyDoc !== undefined), { message: 'body и bodyDoc одновременно недопустимы', path: ['bodyDoc'] });
// executor: не выполнено → ExecError('CONFLICT', 'предусловие не выполнено: <aspect>.<field>', { precondition, actual })
```
  Семантика: `actual = current.aspects[aspect]?.[field]` читается ПОД `FOR UPDATE`
  (`loadEntityForUpdate`, стадия 3), совпадение — `p.in.some(v => JSON.stringify(v) === JSON.stringify(actual))`
  (скаляры; отсутствующее поле ни с чем не совпадает). В `internalUndo` предусловий не бывает
  (inverse их не несёт). Именно это и есть «CAS-расширение стадий 4–5» из С7: проверка и запись
  в одной транзакции под строчным замком.

- [ ] **Шаг 1: падающие тесты** — `executor.test.ts`:

```ts
describe('CAS-предусловие entity_update (С7, инвариант 1)', () => {
  test('предусловие выполнено → запись; не выполнено → CONFLICT с details {precondition, actual}', async () => { /* status planned → in_progress при in:['planned']; повтор → CONFLICT actual 'in_progress' */ });
  test('гонка: два конкурентных перехода planned→in_progress с одним предусловием — ровно один ok', async () => {
    for (let round = 0; round < 5; round++) {
      const id = newId(); await create(id, { 'orbis/task': { status: 'planned' } });
      const op = () => execute(db, req([{ tool: 'entity_update', input: { id, precondition: [{ aspect: 'orbis/task', field: 'status', in: ['inbox', 'planned'] }], aspects: { 'orbis/task': { status: 'in_progress' } } } }]));
      const [a, b] = await Promise.all([op(), op()]);
      expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
      const loser = a.ok ? b : a; if (!loser.ok) expect(loser.error.code).toBe('CONFLICT');
    }
  });
  test('предусловие по отсутствующему аспекту → CONFLICT (actual undefined)', async () => { /* … */ });
});
```
  Непротекание: `dispatch.test.ts` — `entity_update` с `precondition` от модели/MCP →
  `VALIDATION` (strict-схема тула); `batch_execute` с операцией `entity_update{precondition}` →
  `VALIDATION` (`validateBatchOperations`); `routers/entity.test.ts` — tRPC `entity.update` с
  `precondition` → BAD_REQUEST (`entityUpdateUiInput` без него).

- [ ] **Шаг 2:** прогон — FAIL.
- [ ] **Шаг 3:** реализация по интерфейсу выше; `prepareEntityUpdate` парсит `entityUpdateExecInput`
  (`:1014`), проверка предусловий — сразу после загрузки под замком, ДО гейта тела.
- [ ] **Шаг 4:** тесты PASS (гонка — 5 раундов подряд зелёные); `bun run test`; коммит
  `feat(executor): CAS-предусловие entity_update под FOR UPDATE — фундамент захвата (С7)`.

---

### Задача 10: Глаголы I — реестр, ветка dispatch, `orbis_my_queue`, подметание, `orbis_claim_task`

**Файлы:**
- Создать: `packages/shared/src/contracts/agent-loop.ts` (+ экспорт из `packages/shared/src/index.ts`),
  `apps/server/src/agent-loop/constants.ts`, `apps/server/src/agent-loop/queries.ts` (дописать к Задаче 7),
  `apps/server/src/agent-loop/sweep.ts`, `apps/server/src/agent-loop/verbs.ts`,
  `apps/server/src/agent-loop/verbs.test.ts`, `apps/server/src/agent-loop/sweep.test.ts`
- Изменить: `apps/server/src/tools/registry.ts:295-391` (5 дефов, JSON Schema, `agentOnly: true`, `kind: 'mutate'`),
  `apps/server/src/tools/dispatch.ts:173-197` (ветка глаголов рядом с `thread_post`),
  `apps/server/src/tools/registry.test.ts` (парность zod↔JSON Schema `:288+`, счётчики 27/28)

**Интерфейсы (produces):**
```ts
// packages/shared/src/contracts/agent-loop.ts — envelope-схемы глаголов (парность с JSON Schema реестра — тестом)
export const myQueueInput   = z.object({}).strict();
export const claimTaskInput = z.object({ ticket_id: z.string().uuid(), id: z.string().uuid().optional(), session_url: z.string().url().optional() }).strict();
export const runStepInput   = z.object({ run_id: z.string().uuid(), summary: z.string().min(1).max(500), external: z.boolean().optional(), id: z.string().uuid().optional() }).strict();
export const checkpointInput= z.object({ run_id: z.string().uuid(), question: z.string().min(1).max(4000), usage: runUsageInput.optional(), session_url: z.string().url().optional(), id: z.string().uuid().optional() }).strict();
export const finishInput    = z.object({ run_id: z.string().uuid(), report: z.string().min(1).max(20000), usage: runUsageInput.optional(), session_url: z.string().url().optional(), id: z.string().uuid().optional() }).strict();
// `id` — ключ идемпотентности вызова (= batchId action'а): повтор с тем же id — replay, не вторая работа (С7)

// Формы ответов (wire; сервер `apps/server/src/agent-loop/verbs.ts`)
export interface QueueTicket { id: string; title: string; status: TaskStatus; priority?: string; due_date?: string; claimable: boolean; project?: { id: string; title: string }; last_run?: RunSummary }
export interface RunSummary  { id: string; outcome: RunOutcome; started_at: string; finished_at?: string; step_count: number; report?: string; checkpoint?: { question: string; asked_at: string }; reply?: { text: string; at: string }; abandon_note?: string; session_url?: string; last_steps: AgentRunStep[] /* ≤10 последних */ }
export interface MyQueueResult   { tickets: QueueTicket[]; swept: number }
export interface ClaimTaskResult { run_id: string; action_id: string; ticket: { id: string; title: string; body: string; aspects: Record<string, unknown> }; project: { id: string; title: string; body: string } | null; process: string | null; history: RunSummary[]; replayed: boolean }

// apps/server/src/agent-loop/constants.ts
export const RUN_STALE_AFTER_MS = 30 * 60_000; // порог брошенного прогона (решение плана 1)

// apps/server/src/agent-loop/sweep.ts
export async function sweepStaleRuns(db: Db, args: { ownerId: string; actorKind: ActorKind; actorGrantId?: string; clock?: () => Date; staleAfterMs?: number }): Promise<{ swept: number }>;

// apps/server/src/agent-loop/verbs.ts
export type VerbCtx = { db: Db; ownerId: string; grant: GrantRef; clock: () => Date; sink: JournalSink };
export async function runAgentVerb(ctx: VerbCtx, name: (typeof AGENT_VERB_NAMES)[number], input: unknown): Promise<ToolDispatchResult>;
```

- [ ] **Шаг 1: падающие тесты `verbs.test.ts`** (живая БД, обвязка как в `dispatch.test.ts:24-34`;
  фикстура: владелец `owner`, PAT-грант `G` (`issuePatGrant`, scope `worker`), проект `P`
  (entity_create + `orbis/project`), тикет `T` (child of P, `orbis/task planned`,
  `orbis/assignment {executor:'agent', grant_id:G}`), контекст `worker()` как в Задаче 7):

```ts
test('orbis_my_queue: назначенные гранту тикеты; чужие/неназначенные не видны; claimable только inbox|planned', async () => {
  const r = await dispatchTool(worker(), 'orbis_my_queue', {});
  expect(r.status).toBe('ok');
  const q = (r as any).result as MyQueueResult;
  expect(q.tickets.map((t) => t.id)).toEqual([T]);
  expect(q.tickets[0].claimable).toBe(true);
  expect(q.tickets[0].project?.id).toBe(P);
});
test('orbis_claim_task: тикет → in_progress, прогон создан ребёнком, ответ несёт body проекта (процесс) и пустую историю', async () => {
  const r = await dispatchTool(worker(), 'orbis_claim_task', { ticket_id: T });
  expect(r.status).toBe('ok');
  const c = (r as any).result as ClaimTaskResult;
  expect(c.process).toContain('## Процесс');
  const t = await get(T); expect(t.aspects['orbis/task'].status).toBe('in_progress');
  const run = await get(c.run_id); expect(run.aspects['orbis/agent-run']).toMatchObject({ grant_id: G, outcome: 'running', step_count: 0, project_id: P });
  // связь parent тикет→прогон; журнал: один action типа batch с run_id и actor_grant_id
});
test('инвариант 1: два одновременных захвата одного тикета — ровно один получает работу, второй CONFLICT', async () => {
  for (let round = 0; round < 5; round++) {
    const ticket = await makeTicket();  // planned, назначен G
    const [a, b] = await Promise.all([dispatchTool(worker(), 'orbis_claim_task', { ticket_id: ticket }), dispatchTool(worker(), 'orbis_claim_task', { ticket_id: ticket })]);
    const oks = [a, b].filter((r) => r.status === 'ok');
    expect(oks).toHaveLength(1);
    const lost = [a, b].find((r) => r.status === 'error') as { error: { code: string } };
    expect(lost.error.code).toBe('CONFLICT');
    // ровно один прогон-ребёнок у тикета
  }
});
test('захват тикета, назначенного ДРУГОМУ гранту / не назначенного / в waiting|done → CONFLICT, ничего не создано', async () => { /* … */ });
test('повтор orbis_claim_task с тем же id — replay: тот же run_id, второй прогон не создан', async () => { /* … */ });
test('orbis_claim_task тикета с историей: history содержит прошлый прогон с reply', async () => { /* фикстура: прогон в checkpoint c reply (через adminDb или через глаголы Задачи 11) */ });
```
  `sweep.test.ts`:
```ts
test('прогон без шагов дольше порога: без external → тикет planned, прогон abandoned; с external → тикет waiting с waiting_for о разборе (С6, инвариант 6)', async () => {
  // два прогона running: last_step_at = T0-31мин; у второго шаг external:true
  const { swept } = await sweepStaleRuns(db, { ownerId, actorKind: 'owner', clock: () => T0, staleAfterMs: RUN_STALE_AFTER_MS });
  expect(swept).toBe(2);
  // тикет1 planned + waiting_for нет; тикет2 waiting + waiting_for содержит «оборван» и сводку последнего шага; оба прогона outcome abandoned c abandon_note
});
test('свежий прогон (last_step_at = T0-5мин) не трогается; тикет не в in_progress → помечается только прогон', async () => { /* … */ });
test('orbis_my_queue подметает по дороге: swept в ответе, тикет вернулся claimable', async () => { /* … */ });
```

- [ ] **Шаг 2:** прогон — FAIL (тулов нет).

- [ ] **Шаг 3: реестр** — в `CORE_TOOLS` пять дефов `kind:'mutate', agentOnly:true`,
  `inputJsonSchema` рукописно (как у соседей), описания — инструкции агенту (пример):

```ts
  {
    name: 'orbis_claim_task',
    description:
      'Атомарно взять назначенный мне тикет в работу: тикет → in_progress, создаётся прогон (сущность). ' +
      'Возвращает задание (title, body, аспекты), body проекта с описанием процесса и историю прошлых ' +
      'прогонов (их отчёты, вопросы и ответы владельца). Отказ CONFLICT — тикет уже в работе или не мой: ' +
      'не повторяй, возьми другой из orbis_my_queue. Передавай id (uuid) — повтор с тем же id безопасен. ' +
      'Работай над одним тикетом за раз; шаги фиксируй orbis_run_step, вопросы — orbis_checkpoint, ' +
      'итог — orbis_finish (тикет не закрывай сам).',
    inputJsonSchema: { type: 'object', additionalProperties: false, required: ['ticket_id'], properties: { ticket_id: { type: 'string', format: 'uuid' }, id: { type: 'string', format: 'uuid' }, session_url: { type: 'string', format: 'uri' } } },
    kind: 'mutate', agentOnly: true,
  },
```
  Парность в `registry.test.ts:288+`: добавить пары `orbis_*` ↔ схемы из `@orbis/shared`
  (`contracts/agent-loop.ts`). Счётчики: 27 / 28.

- [ ] **Шаг 4: ветка dispatch** — ДО общей ветки `runMutation` (иначе `validateMutationEnvelope`
  упадёт на «нет схемы envelope»), рядом с веткой `thread_post` (`:173-197`): для `AGENT_VERB_NAMES`:
  `parseEnvelope(schema)` → `classifyToolCall(facts)` → `levelGate` (уровень будет `execute` —
  Задача 12 закрепляет тестом) → `runAgentVerb({ db, ownerId: ctx.actorUserId, grant: ctx.grant!, clock, sink }, name, input)`.
  Гейт `agentOnly` без гранта уже стоит (Задача 7).

- [ ] **Шаг 5: `queries.ts`** — SQL под `withIdentity(owner)`:

```ts
/** Тикеты, назначенные гранту: containment по колонке — покрыт GIN entities_aspects_gin (compile.ts:299-311). */
export async function assignedTickets(tx: Tx, grantId: string): Promise<TicketRow[]> {
  return tx.execute(sql`SELECT id, title, aspects, updated_at FROM entities
    WHERE NOT archived AND aspects @> ${JSON.stringify({ 'orbis/assignment': { executor: 'agent', grant_id: grantId } })}::jsonb
      AND aspects ? 'orbis/task' ORDER BY updated_at DESC`) as unknown as TicketRow[];
}
export async function parentProject(tx: Tx, ticketId: string): Promise<{ id: string; title: string; body: string } | null>; // parents_of с orbis/project
export async function runsOfTicket(tx: Tx, ticketId: string): Promise<RunRow[]>;   // children_of с orbis/agent-run, created_at asc
export async function staleRuns(tx: Tx, before: Date): Promise<RunRow[]>;          // outcome running AND last_step_at < before (подпутевое сравнение — seq scan приемлем: running-прогонов единицы)
export async function ticketOfRun(tx: Tx, runId: string): Promise<TicketRow | null>; // parent-source прогона
export function runSummary(row: RunRow): RunSummary;                                // последние 10 шагов
```

- [ ] **Шаг 6: `sweep.ts`** — для каждого `staleRuns(now - staleAfterMs)`:
  `hasEffect = steps.some(s => s.external)`; `note = 'Прогон оборван (нет шагов ${мин} мин). Последний шаг: «${last?.summary ?? '—'}»; шагов с внешним эффектом: ${k}. Проверьте остатки работы (ветки, файлы) и верните тикет в работу.'`;
  операции: `entity_update(run, precondition [outcome in ['running'], last_step_at in [row.last_step_at]], aspects {'orbis/agent-run': {outcome:'abandoned', finished_at: now, abandon_note: note}})`
  + если тикет `in_progress`: `entity_update(ticket, precondition [status in ['in_progress']], aspects {'orbis/task': hasEffect ? {status:'waiting', waiting_for: note} : {status:'planned', waiting_for: null}})`;
  `execute(db, { actorUserId, actorKind, source:'system', actorGrantId, runId: run.id, batchId: newId(), operations }, { sink })`;
  `CONFLICT` → пропустить (поздний шаг успел / уже подметено). Комментарий: `source:'system'`,
  потому что это не решение актора, а обслуживание инварианта 6; «отмени последнее» такие
  записи пропускает (`undo.ts:58-79`), откат — по `run_id` в Задаче 13.

- [ ] **Шаг 7: `verbs.ts` — `orbis_my_queue`** — `sweepStaleRuns` → `assignedTickets` →
  для каждого: `project = parentProject`, `last_run = runSummary(последний из runsOfTicket)`,
  `claimable = status ∈ {inbox, planned}` → `{ tickets, swept }`.
  **`orbis_claim_task`** — прочитать тикет и его `orbis/assignment` (RLS: чужой → `NOT_FOUND`);
  `runId = newId()`, `batchId = input.id ?? newId()`, `now = clock()`:

```ts
  const ops = [
    { tool: 'entity_update', input: { id: ticketId,
        precondition: [
          { aspect: 'orbis/task', field: 'status', in: ['inbox', 'planned'] },
          { aspect: 'orbis/assignment', field: 'executor', in: ['agent'] },
          { aspect: 'orbis/assignment', field: 'grant_id', in: [ctx.grant.id] },
        ],
        aspects: { 'orbis/task': { status: 'in_progress' } } } },
    { tool: 'entity_create', input: { id: runId, title: `Прогон: ${ticket.title}`, tags: [],
        aspects: { 'orbis/agent-run': { grant_id: ctx.grant.id, ...(project && { project_id: project.id }), outcome: 'running',
          started_at: iso(now), last_step_at: iso(now), step_count: 0, steps: [], ...(input.session_url && { session_url: input.session_url }) } } } },
    { tool: 'relation_create', input: { source_id: ticketId, target_id: runId, relation_type: 'parent' } },
  ];
  const r = await execute(ctx.db, { actorUserId: ctx.ownerId, actorKind: 'agent', source: 'mcp', actorGrantId: ctx.grant.id, runId, batchId, operations: ops, clock: ctx.clock }, { sink: ctx.sink });
```
  `r.ok === false` → `{ status:'error', error }` (CONFLICT — «тикет уже в работе или не назначен
  этому исполнителю»); при `r.idempotentReplay` — `run_id` берётся из результатов replay
  (`results[1].id`), `replayed: true`. Затем собрать ответ: `ticket` (title, body, aspects),
  `project` + `process = project.body`, `history = runsOfTicket(...).filter(id !== runId).map(runSummary)`.
  Все `execute` — с `sink` из `makeChatJournalSink()` (как `dispatch.ts:70`).

- [ ] **Шаг 8:** тесты PASS (гонка — 5 раундов); `bun run test`; коммит
  `feat(agent-loop): orbis_my_queue, подметание брошенных прогонов, атомарный orbis_claim_task (С6, С7)`.

---

### Задача 11: Глаголы II — `orbis_run_step`, `orbis_checkpoint`, `orbis_finish`

**Файлы:**
- Изменить: `apps/server/src/agent-loop/verbs.ts`, `apps/server/src/agent-loop/verbs.test.ts`

**Интерфейсы (produces):**
```ts
// ответы
export interface RunStepResult   { run_id: string; step_count: number; action_id: string }
export interface CheckpointResult{ run_id: string; ticket_id: string; ticket_status: 'waiting'; action_id: string }
export interface FinishResult    { run_id: string; ticket_id: string; ticket_status: 'waiting' | 'done'; action_id: string }
```

- [ ] **Шаг 1: падающие тесты** — `verbs.test.ts` (после захвата `run` из Задачи 10):

```ts
test('orbis_run_step: шаг дописан, step_count и last_step_at растут, action_id = id вызова; шаг виден в журнале с actor_grant_id и run_id', async () => { /* … */ });
test('гонка шагов: два одновременных orbis_run_step на один прогон — оба ok, step_count 2, оба шага на месте (серверный ретрай CAS по step_count)', async () => { /* Promise.all */ });
test('orbis_checkpoint: тикет waiting, waiting_for = вопрос, прогон outcome checkpoint с checkpoint.question (С3)', async () => { /* … */ });
test('orbis_finish без may_close: тикет waiting «готово, проверь», НЕ done; report на прогоне (С8, приёмка 9)', async () => { /* … */ });
test('orbis_finish с may_close=true: тикет done, completed_at проставлен сервером', async () => { /* … */ });
test('терминальность (инвариант 5): после checkpoint/finish/подметания orbis_run_step и orbis_finish → CONFLICT со ссылкой на исход', async () => { /* … details.outcome */ });
test('orbis_finish по тикету не в in_progress (владелец вернул руками) → CONFLICT', async () => { /* … */ });
test('прогон другого гранта: orbis_run_step → CONFLICT «прогон другого исполнителя»', async () => { /* worker с грантом G2 */ });
```

- [ ] **Шаг 2:** прогон — FAIL.

- [ ] **Шаг 3: `orbis_run_step`** — до 3 попыток:

```ts
  for (let attempt = 0; attempt < 3; attempt++) {
    const run = await readRun(tx, input.run_id);               // NOT_FOUND под RLS
    if (run.grant_id !== ctx.grant.id) return err('CONFLICT', 'прогон принадлежит другому исполнителю', { run_id });
    if (run.outcome !== 'running') return err('CONFLICT', `прогон завершён (${run.outcome}) — новые шаги не принимаются`, { outcome: run.outcome, note: run.abandon_note });
    const now = ctx.clock(); const batchId = input.id ?? newId(); const n = run.step_count;
    const step = { seq: n + 1, at: iso(now), summary: input.summary, external: input.external === true, action_id: batchId };
    const r = await execute(ctx.db, { …, runId: run.id, batchId, operations: [{ tool: 'entity_update', input: { id: run.id,
      precondition: [
        { aspect: 'orbis/agent-run', field: 'outcome', in: ['running'] },
        { aspect: 'orbis/agent-run', field: 'grant_id', in: [ctx.grant.id] },
        { aspect: 'orbis/agent-run', field: 'step_count', in: [n] },   // CAS: конкурентный шаг → CONFLICT → перечитать
      ],
      aspects: { 'orbis/agent-run': { steps: [...run.steps, step], step_count: n + 1, last_step_at: iso(now) } } } }] }, { sink });
    if (r.ok) return ok({ run_id: run.id, step_count: n + 1, action_id: r.actionId });
    if (r.error.code === 'CONFLICT' && (r.error.details as any)?.precondition?.field === 'step_count') continue;
    return { status: 'error', error: r.error };
  }
```
  Комментарий: почему массив шагов на прогоне (сводка переживает журнал, С5) и почему CAS по
  счётчику (агент вызывает тулы параллельно; без CAS второй шаг затирал бы первый).

- [ ] **Шаг 4: `orbis_checkpoint` / `orbis_finish`** — один batch из двух `entity_update`
  (прогон + тикет), `runId = run.id`, `batchId = input.id ?? newId()`, предусловия: прогон
  `outcome in ['running']` + `grant_id`; тикет `status in ['in_progress']`. Патчи: checkpoint —
  прогон `{outcome:'checkpoint', finished_at, last_step_at, checkpoint:{question, asked_at}, usage?, session_url?}`,
  тикет `{status:'waiting', waiting_for: question}`; finish — прогон
  `{outcome:'finished', finished_at, last_step_at, report, usage?, session_url?}`, тикет —
  `may_close === true ? {status:'done'} : {status:'waiting', waiting_for: report}`
  (`completed_at` ставит `applyTaskCompletion`, `normalize.ts:57-69`). Тикет прогона —
  `ticketOfRun` (parent-source).

- [ ] **Шаг 5:** тесты PASS; `bun run test`; коммит `feat(agent-loop): orbis_run_step с CAS по счётчику, orbis_checkpoint, orbis_finish без закрытия тикета (С3, С5, С8)`.

---

### Задача 12: Политика и чат — глаголы = `execute`, никогда не `pending`; MCP e2e worker; Undo шага

**Файлы:**
- Изменить: `apps/server/src/policy/confirmation.test.ts:110-115`, `apps/server/src/tools/dispatch.test.ts`,
  `apps/server/src/mcp/mcp.test.ts`, `apps/server/src/ai/send-message.test.ts` (если есть; иначе тест реестра тулов чата в `ai.test.ts`)

- [ ] **Шаг 1: тесты (они и есть деливерабл задачи — код уже написан Задачами 7, 10, 11):**
  - `confirmation.test.ts`: «все глаголы исполнителя (`AGENT_VERB_NAMES`) и `thread_post` при
    `kind:'mutate', archives:false, isBatch:false` → `'execute'`» — таблица §7.10, инвариант 4;
  - `dispatch.test.ts`: для каждого глагола с валидным входом результат `status !== 'pending_confirmation'`
    (прогон по кругу: my_queue → claim → step → checkpoint; затем claim → step → finish) — на уровне
    dispatch, а не только классификатора; и «глагол в `explicitCommand:false` всё равно execute»;
  - `mcp.test.ts`: worker-грант через настоящий SDK-клиент (`connectAgent`, `:86-93`):
    `tools/list` = read-тулы + `thread_post` + 5 глаголов; полный круг `orbis_my_queue → orbis_claim_task
    → orbis_run_step → orbis_finish` по проводу; `entity_update` → `isError`, `FORBIDDEN_LEVEL`
    (приёмка 4, 5, 9, 10);
  - «отмени последнее» (приёмка 14): после `orbis_run_step` владелец зовёт `ai.undoLast()` →
    прогон без этого шага (`step_count` назад), audit-запись шага в глобальном треде несёт
    `actor_kind:'agent'` и `actor_grant_id`;
  - чат: `send-message` — набор LLM-тулов не содержит `orbis_*` (флаг `agentOnly`).
- [ ] **Шаг 2:** прогон — всё зелёное без правок кода; если что-то красное — это дефект
  Задач 7/10/11, чинить там (в этой задаче код не пишется, кроме тестов).
- [ ] **Шаг 3:** `bun run test`; коммит `test(agent-loop): инварианты 3–4 и приёмка 4–5, 9–10, 14 закреплены тестами`.

---

### Задача 13: tRPC `agentRun` — ответ на чекпойнт, подметание с экранов, откат прогона

**Файлы:**
- Создать: `apps/server/src/routers/agent-run.ts`, `apps/server/src/routers/agent-run.test.ts`,
  `apps/server/src/agent-loop/rollback.ts`, `apps/server/src/agent-loop/rollback.test.ts`
- Изменить: `apps/server/src/router.ts`, `apps/server/src/executor/undo.ts` (экспорт `isUndone`, `findActionMessage`),
  `apps/server/src/wire.ts` (`WireRollbackResult`)

**Интерфейсы (produces):**
```ts
// tRPC (все ownerOnlyProcedure)
agentRun.answerCheckpoint({ ticketId, runId, answer: string(1..4000) }) → { ticket: WireEntity; run: WireEntity }
agentRun.sweep({}) → { swept: number }             // зовётся экранами проекта/тикета (С6: не зависеть от orbis_my_queue)
agentRun.rollback({ runId }) → WireRollbackResult
export type WireRollbackResult =
  | { ok: true; undone: string[] /* action ids в порядке отката */; note: string }
  | { ok: false; reason: 'conflict'; conflicts: Array<{ entityId: string; actionId: string; at: string; source: string }> }
  | { ok: false; reason: 'partial'; undone: string[]; failed: { actionId: string; error: { code: string; message: string } } };
// note — постоянный текст (С12): «Откачены изменения в Orbis (статусы тикета, прогон). Ветку и коммиты в репозитории откат не трогает — откатывайте их git'ом.»
// agent-loop/rollback.ts
export async function rollbackRun(db: Db, args: { actorUserId: string; runId: string }): Promise<WireRollbackResult>;
```

- [ ] **Шаг 1: падающие тесты** — `agent-run.test.ts` (caller владельца `a`, глаголы — через
  `dispatchTool` с worker-контекстом, как в `verbs.test.ts`):

```ts
test('answerCheckpoint: тикет planned, waiting_for снят, на прогоне reply; один action (undo одним движением); следующий claim видит reply в history (приёмка 8)', async () => { /* … */ });
test('answerCheckpoint по тикету не в waiting → CONFLICT', async () => { /* … */ });
test('sweep с экрана: тот же результат, что подметание в orbis_my_queue; actor owner, source system', async () => { /* … */ });
```
  `rollback.test.ts`:
```ts
test('откат прогона claim→step→finish: тикет вернулся в planned, прогон архивирован, undone = 3 action id в обратном порядке (приёмка 13)', async () => { /* … */ });
test('конфликт: владелец ответил на чекпойнт после прогона → ok:false, conflicts указывает тикет и action ответа; ничего не откачено (инвариант 7)', async () => { /* … */ });
test('шаг уже отменён вручную (ai.undo) → пропускается, остальное откатывается', async () => { /* … */ });
```

- [ ] **Шаг 2:** прогон — FAIL.

- [ ] **Шаг 3: `answerCheckpoint`** — под владельцем: прочитать тикет (waiting) и прогон;
  batch: `entity_update(run, precondition [outcome in ['checkpoint','finished','abandoned']], aspects {'orbis/agent-run': {reply: {text, at}}})`
  + `entity_update(ticket, precondition [status in ['waiting']], aspects {'orbis/task': {status:'planned', waiting_for: null}})`;
  `execute({ actorKind:'owner', source:'ui', runId, batchId: newId(), operations }, { sink })`; вернуть свежие wire-формы.
  `sweep` — `sweepStaleRuns(db, { ownerId, actorKind:'owner' })`.

- [ ] **Шаг 4: `rollbackRun`** —

```ts
  // 1. Все действия прогона (обратная ссылка run_id, Задача 6), в порядке журнала.
  const rows = await tx.execute(sql`SELECT id, created_at, metadata FROM chat_messages
      WHERE metadata @> ${JSON.stringify({ actions: [{ run_id: runId }] })}::jsonb ORDER BY created_at ASC`);
  const actions = rows.map(r => ({ at: r.created_at, action: r.metadata.actions[0] as ActionRecord }));
  const live = []; for (const a of actions) if (!(await isUndone(tx, a.action.id))) live.push(a);
  if (live.length === 0) return { ok: true, undone: [], note: NOTE };
  // 2. Затронутые сущности — id из payload операций и inverse.
  const touched = new Set(live.flatMap(a => [...a.action.operations, ...a.action.inverse].map(o => o.payload.id).filter(isString)));
  // 3. Чужие неотменённые действия ПОЗЖЕ последнего действия прогона по тем же сущностям — конфликт.
  const tLast = live[live.length - 1].at;
  const later = await tx.execute(sql`SELECT id, created_at, metadata FROM chat_messages
      WHERE created_at > ${tLast} AND metadata ? 'actions' ORDER BY created_at ASC`);
  const conflicts = [];
  for (const m of later) { const act = m.metadata.actions[0]; if (act.run_id === runId) continue; if (await isUndone(tx, act.id)) continue;
    const ids = [...act.operations, ...act.inverse].map(o => o.payload.id);
    for (const id of ids) if (touched.has(id)) conflicts.push({ entityId: id, actionId: act.id, at: m.created_at, source: act.source }); }
  if (conflicts.length) return { ok: false, reason: 'conflict', conflicts };
  // 4. Серия undo в обратном порядке — существующей механикой (undoAction), по транзакции на действие.
  const undone = []; for (const a of live.reverse()) { const r = await undoAction(db, { actorUserId, actionId: a.action.id });
    if (!r.ok) return { ok: false, reason: 'partial', undone, failed: { actionId: a.action.id, error: r.error } }; undone.push(a.action.id); }
  return { ok: true, undone, note: NOTE };
```
  Комментарий в файле — почему предпроверка нужна (Undo — LWW по решению `undo.ts:1-7`) и
  почему серия неатомарна (Undo одного action = одна транзакция; общий откат — уровень UX, не
  инвариант БД). Шаги 1–3 — под `withIdentity(actorUserId)`.

- [ ] **Шаг 5:** тесты PASS; `bun run test`; коммит `feat(agent-run): ответ на чекпойнт, подметание с экранов, откат прогона с предпроверкой конфликтов (С10, С12)`.

---

### Задача 14: Web — экран тикета: чекпойнт-блок, назначение, прогоны

**Файлы:**
- Создать: `apps/web/src/features/entity-detail/useTicketRuns.ts`, `TicketWaitingBlock.tsx`, `AssignmentCard.tsx`, `RunsList.tsx`
- Изменить: `apps/web/src/features/entity-detail/DetailScreen.tsx:141-202` (вставки на обоих табах),
  `apps/web/src/features/entity-detail/AspectCards.tsx:98` (пропуск аспектов с выделенными карточками)
- Тесты: `apps/web/src/features/entity-detail/detail.test.tsx` (новый `describe('ADE: тикет')`)

**Интерфейсы (produces):**
```ts
export function useTicketRuns(ticketId: string, enabled: boolean): { runs: WireEntity[]; lastRun: WireEntity | undefined; isLoading: boolean };
//   → trpc.entity.query({ query: `children_of=${ticketId}, aspect=orbis/agent-run, sortBy=created_at:desc, limit=20` })
export function TicketWaitingBlock(props: { entity: WireEntity; lastRun: WireEntity | undefined }): JSX.Element | null;
export function AssignmentCard(props: { entity: WireEntity }): JSX.Element;
export function RunsList(props: { ticketId: string; runs: WireEntity[]; onOpen: (id: string) => void }): JSX.Element;
const HIDDEN_ASPECT_CARDS = new Set(['orbis/assignment', 'orbis/agent-run']); // AspectCards их не рисует — есть свои карточки
```
  Навигация к прогону — тем же способом, что `Subtasks.tsx` открывает подзадачу (найти
  `onOpen`/`EntityRef` там и переиспользовать). Стиль — `apps/web/src/ui/*` (Radix, Tailwind v4,
  Lucide), как у соседей.

- [ ] **Шаг 1: падающие тесты** — `detail.test.tsx` (обвязка `renderWithProviders`, моки по
  пути: `entity.get` → тикет `orbis/task {status:'waiting', waiting_for:'Какую БД брать?'}` +
  `orbis/assignment {executor:'agent', grant_id:G}`; `entity.query` → один прогон
  `outcome:'checkpoint', checkpoint:{question:'Какую БД брать?'}`; `oauth.listGrants` → `[{id:G,label:'worker-1',scope:'worker',…}]`; `aspect.list` → `[]`):

```ts
describe('ADE: тикет', () => {
  test('таб «Сущность»: виден вопрос чекпойнта и кнопка; ввод ответа → agentRun.answerCheckpoint с ticketId/runId/answer (приёмка 7–8)', async () => {
    const { calls } = renderWithProviders(<DetailScreen entityId="t1" />, handler);
    expect(await within(tabPanel('Сущность')).findByText('Какую БД брать?')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Ответ'), 'Postgres');
    await user.click(screen.getByRole('button', { name: 'Ответить и вернуть в работу' }));
    await waitFor(() => expect(calls.find((c) => c.path === 'agentRun.answerCheckpoint')?.input).toEqual({ ticketId: 't1', runId: 'r1', answer: 'Postgres' }));
  });
  test('таб «Детали»: карточка назначения показывает грант «worker-1» и may_close; смена may_close → entity.update с aspects.orbis/assignment', async () => { /* … */ });
  test('таб «Детали»: список прогонов с исходом и числом шагов; клик открывает прогон', async () => { /* … */ });
  test('тикет не в waiting → чекпойнт-блока нет; заметка без orbis/task → назначения и прогонов нет', async () => { /* … */ });
  test('открытие тикета зовёт agentRun.sweep один раз (С6: подметание с экранов)', async () => { /* calls.filter(path==='agentRun.sweep').length === 1 */ });
});
```

- [ ] **Шаг 2:** `cd apps/web && bunx vitest run src/features/entity-detail/detail.test.tsx` — FAIL.

- [ ] **Шаг 3: реализация** — `useTicketRuns` (query + `keepPreviousData`); в `useEntityDetail`
  или `DetailScreen`: `const isTicket = entity.aspects['orbis/task'] !== undefined && entity.aspects['orbis/assignment'] !== undefined`
  (чекпойнт/прогоны — только у назначенных тикетов; карточка назначения — у любого `orbis/task`);
  `useEffect` при монтировании тикета/проекта: `trpc.agentRun.sweep.useMutation().mutate({})` один
  раз, затем `invalidateGraph`. `TicketWaitingBlock`: если `task.status==='waiting' && lastRun && lastRun.outcome !== 'running'`
  → заголовок по исходу («Вопрос исполнителя» / «Готово, проверьте» / «Прогон оборван — разбор»),
  текст `waiting_for` (`Markdown`-компонент ленты чата, если он не тянет тяжёлых чанков; иначе `<pre>`),
  `textarea` «Ответ», кнопка «Ответить и вернуть в работу» → `trpc.agentRun.answerCheckpoint.useMutation`
  → `onSuccess: invalidateGraph(utils)`; при исходе `finished` — вторая кнопка «Закрыть тикет» →
  `useEntityUpdate(id).mutation.mutate({ id, expectedUpdatedAt, aspects: {'orbis/task': {status:'done'}} })`.
  Вставка в `DetailScreen` первого таба — между `GoalProgress` (`:170`) и `EntityBody` (`:178`).
  `AssignmentCard` (второй таб, перед `AspectCards`): текущее назначение или «Не назначен»;
  переключатель «человек / агент»; для агента — `<select>` из `trpc.oauth.listGrants` (не
  отозванные), чекбокс «Может закрывать сам»; «Сохранить» → `useEntityUpdate(entity.id).mutation.mutate({ id, expectedUpdatedAt: entity.updatedAt, aspects: {'orbis/assignment': {...}} })`;
  «Снять назначение» → `{ 'orbis/assignment': null }`. `RunsList` (второй таб, после `Subtasks`):
  строки «дата · исход · N шагов · грант», клик → открыть.

- [ ] **Шаг 4:** тесты PASS; `cd apps/web && bunx vitest run`, `bun run lint`, `bun run typecheck`;
  `bun run --filter @orbis/web build && bun scripts/check-lazy-chunks.ts` → 0; коммит
  `feat(web): экран тикета — чекпойнт с ответом, назначение исполнителя, прогоны (С10)`.

---

### Задача 15: Web — экран прогона: лента шагов, откат; маркер актора-агента в журнале

**Файлы:**
- Создать: `apps/web/src/features/entity-detail/RunFeed.tsx`
- Изменить: `apps/web/src/features/entity-detail/DetailScreen.tsx` (первый таб: `RunFeed` для сущностей с `orbis/agent-run`),
  `apps/web/src/features/chat/cards/renderCards.tsx:120-141`
- Тесты: `apps/web/src/features/entity-detail/detail.test.tsx` (`describe('ADE: прогон')`), `apps/web/src/features/chat/cards/cards.test.tsx:263`

**Интерфейсы (produces):**
```ts
export function RunFeed(props: { entity: WireEntity }): JSX.Element;
// renderCards: если meta.actions?.[0]?.actor_kind === 'agent' — обёртка SystemMessage (🤖 агент), как у author_kind
```

- [ ] **Шаг 1: падающие тесты** — прогон с тремя шагами (один `external:true`), `outcome:'finished'`,
  `report`, `usage`, `session_url`: лента показывает шаги по порядку с меткой «внешнее» у второго,
  исход, отчёт, ссылку на сессию; кнопка «Откатить прогон в Orbis» → `agentRun.rollback({runId})`;
  ответ `{ok:true, undone:[…], note}` → на экране `note` (текст про git); ответ `conflict` →
  список конфликтов и текст «ничего не откачено». `cards.test.tsx`: карточка действия с
  `actions[0].actor_kind:'agent'` рендерится в `SystemMessage` с «агент» (приёмка 14).

- [ ] **Шаг 2:** прогон — FAIL.
- [ ] **Шаг 3: реализация** — `RunFeed`: шапка (исход бейджем, начало/конец, грант, `usage`,
  ссылка `session_url` `rel="noopener"`), лента `<ol>` шагов (`seq`, время, `summary`, иконка
  «внешнее»), блоки `checkpoint`/`reply`/`report`/`abandon_note`, кнопка отката с подтверждением
  через диалог/лист из `apps/web/src/ui/` (как у `EnvelopeCreateSheet`; НЕ `window.confirm`),
  результат — инлайн-блок. Вставка в первый таб
  рядом с `TicketWaitingBlock`. `renderCards`: расширить условие на `actor_kind` из
  `meta.actions?.[0]`.
- [ ] **Шаг 4:** тесты PASS; web-сьют, lint, typecheck, build + страж чанков → 0; коммит
  `feat(web): экран прогона — лента шагов и откат; актор-агент виден в журнале (С5, С12, приёмка 14)`.

---

### Задача 16: Web — закреплённые версии

**Файлы:**
- Создать: `apps/web/src/features/entity-detail/VersionsCard.tsx`
- Изменить: `apps/web/src/features/entity-detail/DetailScreen.tsx:206-226,640-679` (`DetailMenu` + «Закрепить версию»), второй таб (`VersionsCard`)
- Тесты: `apps/web/src/features/entity-detail/detail.test.tsx` (`describe('ADE: версии')`)

- [ ] **Шаг 1: падающие тесты** — меню ⋮ содержит «Закрепить версию» → диалог с полем
  «Подпись» → `version.pin({entityId, label})`; таб «Детали» показывает список
  `version.list` (подпись, дата, «есть документ»); «Восстановить» → подтверждение →
  `version.restore({versionId, expectedUpdatedAt: entity.updatedAt})` → `invalidateGraph`; ответ
  409 → показать существующую плашку конфликта (`screenConflict`, `DetailScreen.tsx:443-465`)
  или инлайн «документ изменился — обновите экран».
- [ ] **Шаг 2:** прогон — FAIL.
- [ ] **Шаг 3:** реализация (диалоги — `ui/Dialog`, без `prompt()`/`confirm()`).
- [ ] **Шаг 4:** тесты PASS; web-сьют, lint, typecheck, build + страж → 0; коммит
  `feat(web): закрепление и восстановление версий тела (С11, приёмка 12)`.

---

### Задача 17: Документы к факту — PRD, D36, runbook, архитектура, спека среза

**Файлы:**
- Изменить: `docs/prd/01-architecture.md` (§2.2:87-98, §3:149,151, §3.8:299-312, новые §3.12–§3.15 после §3.11:331-347,
  §4.14:556, §7.8:826, §7.10:842-863, §9.2:920-930, §9.3:955,960,969), `docs/prd/02-core-os.md` (§3.5:369-469, §3.9:528-530, §5 сценарий 9:609-610),
  `docs/prd/04-decision-log.md` (D36 между 348 и 351), `docs/implementation/02-ops-runbook.md` (:200-205 список ops, :225-233 таблица релизов с пересевом, :469-553 §3 выдача worker, :632-634 таблицы),
  `docs/implementation/00-architecture.md` §5 ER (:332), `docs/superpowers/specs/2026-08-14-orbis-ade-slice1-design.md`

- [ ] **Шаг 1: PRD 01-architecture** —
  - §2.2 (`:94`): правая ячейка строки «Категории» → `Версии тела (\`entity_versions\`)`;
  - §3 (`:149`) «Восемь» → «Двенадцать»; §3.8 таблица `:301-312` — четыре строки (`orbis/project`,
    `orbis/repo`, `orbis/assignment`, `orbis/agent-run` — «служебный, §3.9 02-core-os»);
  - новые подразделы **§3.12 `orbis/project`**, **§3.13 `orbis/repo`**, **§3.14 `orbis/assignment`**,
    **§3.15 `orbis/agent-run`** — формат как §3.11 (таблица `| Поле | Тип | Req | Описание |`,
    `tag_mappings`, проза: С4, С5, С6, С8, решение «stage не status», «agent-run без attach_*»);
  - §4.14 (`:556`): `scope` — `'full' | 'worker'`; `worker` = глаголы исполнителя + `thread_post`
    в свои треды + чтение; выдаётся на экране согласия / `issue-pat --scope worker`; `:960` —
    убрать «скоупы остаются Future»;
  - §7.8 (`:826`): поле актора — `actor_user_id`, `actor_kind`, `actor_grant_id` (MCP-грант),
    `run_id` (прогон исполнителя — обратная ссылка для отката прогона);
  - §7.10 (`:842-863`): новый абзац «Глаголы исполнителя (`orbis_my_queue`, `orbis_claim_task`,
    `orbis_run_step`, `orbis_checkpoint`, `orbis_finish`) и `thread_post` — уровень `execute`;
    инвариант: глагол исполнителя никогда не возвращает `pending` — фоновому прогону некому
    подтверждать» + правило «скоуп `worker` — ось доступа ДО классификатора»; строку `:858`
    («внешние эффекты — в MVP таких тулов нет») дополнить: «`orbis_run_step` внешних эффектов не
    производит, а фиксирует флаг «тронул внешнее» — для С6»;
  - §9.2 (`:920-930`): таблица core-тулов + пять глаголов (`agentOnly`), + `precondition` как
    серверное расширение `entity_update` (не в контракте тула);
  - §9.3 (`:969`): шаг 4 → «`orbis_finish({run_id, report})` → тикет в `waiting` «готово,
    проверь»; в `done` — только при `may_close` в `orbis/assignment`»; `:955` — статус «ADE-срез 1»;
    добавить третий сценарий — круг исполнителя (queue → claim → step → checkpoint/finish).
- [ ] **Шаг 2: PRD 02-core-os** — §3.5: чекпойнт-блок и лента прогона на табе «Сущность»,
  назначение/прогоны/версии — на «Деталях»; §3.9: первый служебный аспект — `orbis/agent-run`,
  механизм — неявное исключение в компиляторе, пока `aspect=` не назвал его; §5 сценарий 9
  (`:610`): «двигает статусы задач по мере работы (`entity_update`)» → «двигает тикеты
  глаголами исполнителя (`orbis_claim_task` … `orbis_finish`); закрыть тикет сам не может (С8)».
- [ ] **Шаг 3: D36** — по формату D35 (`04-decision-log.md:341-347`): решение (круг как общий
  механизм; глаголы = batch операций executor'а с CAS-предусловием; скоуп `worker`; версии
  body-only; откат прогона с предпроверкой; служебные сущности; порог 30 мин; журнал наблюдений
  отложен), статус, обоснование, заменяет (D34 «скоупы остаются Future»), детали (спека, план).
- [ ] **Шаг 4: runbook и архитектура** — `02-ops-runbook.md`: список команд `ops.ts`
  (`:200-205`, дописать `census`, `audit-bodies`, `backfill-body-doc`, `issue-pat … --scope`),
  таблица релизов с пересевом (`:225-233`) — строка «ADE-срез 1: `orbis/project`, `orbis/repo`,
  `orbis/assignment`, `orbis/agent-run`», раздел деплоя среза (порядок ниже), §3 — выдача
  worker-гранта, `:632-634` — `entity_versions`; `00-architecture.md` §5 — таблица `entity_versions`.
- [ ] **Шаг 5: спека среза к факту** — таблица «Расхождения» этого плана переносится в спеку
  разделом «Уточнения по факту реализации (2026-08-…)»: инвариант 3 → «шесть глаголов-мутаций
  графа» (если В1 = по умолчанию); С12 — предпроверка конфликтов по журналу; С5 — прогоны прячутся
  неявным исключением служебных аспектов; С10 — блок «Последние прогоны» через `project_id`;
  открытый вопрос 2 — 30 минут; «Швы» — журнал наблюдений отложен, шов в `dispatch`; «Известные
  границы» — полный грант и чат технически могут создать прогон вручную (`entity_create` с
  `orbis/agent-run`), удерживает только `aiInstructions`; `worker` не может.
- [ ] **Шаг 6:** `grep -rn "значение пока одно" docs/prd` — пусто; коммит
  `docs(prd): ADE-срез 1 к факту — §2.2, §3.12–3.15, §4.14, §7.8, §7.10, §9.2–9.3, 02 §3.5/§3.9/§5.9, D36, runbook (приёмка 15)`.

---

### Задача 18: Живой смоук по приёмке 1–15 и деплой

**Файлы:** — (операции; отчёт — в `.superpowers/sdd/2026-08-17-ade-slice1-loop/smoke.md`)

- [ ] **Шаг 1: локальный стенд** — из `apps/server`:
  `PORT=3010 WEB_DIST_DIR=../web/dist SUPABASE_URL=http://127.0.0.1:54321 bun run src/index.ts`
  (иначе echo-провайдер вместо модели); собрать web; в браузере снять service worker
  (`getRegistrations().unregister()` + `caches.delete`), иначе смоук проверяет старый бандл.
- [ ] **Шаг 2: worker-грант** — второй MCP-конфиг Claude Code (`claude mcp add --transport http
  orbis-worker http://localhost:3010/mcp` из каталога репозитория-«подопытного»), `/mcp` → вход в
  браузере → радио «Только исполнитель» → в «Настройки → Агенты» строка со скоупом «исполнитель».
- [ ] **Шаг 3: приёмка 1–15** (полный текст — спека, раздел «Приёмка»), в порядке номеров, каждая
  (для п. 7 «ждут меня»: сохранить в Browser смарт-лист `aspect=orbis/task, aspect=orbis/assignment,
  status=waiting, sortBy=updated_at:asc` и закрепить — бейдж счётчика на закреплённом даёт `PinnedList`)
  — с указанием, что и где увидено; провал любого пункта = стоп и починка в задаче-владельце (см.
  маппинг ниже). Пункт 11 (прогон убит на середине): убить сессию Claude Code после
  `orbis_run_step{external:true}`; для локального смоука порог сузить переменной
  `ORBIS_RUN_STALE_MS` НЕ вводится — вместо этого открыть тикет после 30 минут ИЛИ временно
  подвинуть `last_step_at` через `adminDb` и обновить экран (записать в отчёт, что именно делалось).
- [ ] **Шаг 4: мерж и деплой** (после зелёного CI ветки):
  1. `bun scripts/ops.ts migrate` — накатывает `0010`, `0011` (аддитивны; старый код о них не знает);
  2. `git merge --ff-only ade-slice1-loop` в `main`, `git push` → CI → Render деплоит;
  3. после «Live»: `bun scripts/ops.ts seed-aspects` → `bun scripts/ops.ts check` (ждём `✓` по
     четырём новым аспектам) → Render «Restart service» → `curl /health` без `aspectDrift`;
  4. прод-смоук: приёмка 3–10, 12–14 на проде (worker-грант через `https://…/mcp`), с
     предварительным снятием service worker; отчёт в тот же `smoke.md`.
- [ ] **Шаг 5:** зафиксировать в `.superpowers/sdd/…/progress.md` итог, остаточные риски и
  хвосты; финальный коммит документов, пуш.

---

## Вехи и прогоняемые проверки

| Веха | После задач | Проверка (все — код возврата 0) |
|---|---|---|
| A «данные» | 0–5 | `bun run db:prepare` (миграции 0010/0011 + пересев + pgTAP с `entity_versions`); `bun run test`; повторный `bun run db:generate` → «No schema changes»; `bun scripts/seed-aspects.ts` идемпотентен |
| B «грант и скоуп» | 6–8 | `bun run test`; `mcp.test.ts`: worker-грант видит только worker-набор, `entity_update` → 403; `oauth.e2e.test.ts` с `scope=worker` |
| C «глаголы» | 9–13 | `bun run test` (гонка захвата и гонка шагов — по 5 раундов подряд); `confirmation.test.ts` — все глаголы `execute`; полный круг через SDK-клиент в `mcp.test.ts` |
| D «экраны» | 14–16 | `cd apps/web && bunx vitest run`; `bun run --filter @orbis/web build && bun scripts/check-lazy-chunks.ts` |
| E «документы и деплой» | 17–18 | `grep -rn "значение пока одно" docs/prd` пусто; CI ветки зелёный; прод: `ops.ts check` ✓ по четырём аспектам, `/health` без `aspectDrift`; смоук-отчёт с 15 пунктами |

## Порядок деплоя (кратко; подробно — Задача 18 и runbook)

```
ops.ts migrate  →  push main / Render Live  →  ops.ts seed-aspects  →  ops.ts check  →  Restart  →  смоук по приёмке 1–15
```
Почему так: миграции аддитивны — опережающий накат безопасен (`02-ops-runbook.md:330-346`); пересев
— после кода, потому что скрипт читает реестр из кода на деплоенном коммите, а сервер валидирует
аспекты по таблице (`:248-266`); рестарт нужен ловушке дрейфа, не фиче (`:280`).

## Маппинг приёмки дизайна → задачи

| Пункт приёмки | Что проверяется | Задачи |
|---|---|---|
| 1. Создан проект — видна заготовка с живыми блоками | засев тела при `orbis/project`, блоки парсятся и рендерятся | 1, 4, (14 — экран проекта = существующий detail) |
| 2. «сделай A, B, C» в треде проекта — три тикета `inbox`, дети проекта | `aiInstructions` `orbis/project`, существующие `entity_create` + `relation_create` (batch `preview` — приемлемо, владелец рядом) | 1 |
| 3. Назначение агенту — `orbis/assignment` заполнен | `AssignmentCard`, инвариант живого гранта, `oauth.listGrants` со `scope` | 1, 4, 8, 14 |
| 4. `orbis_my_queue` вернул три тикета | глагол, скоуп, MCP e2e | 7, 10, 12 |
| 5. `orbis_claim_task` — тикет `in_progress`, прогон создан; второй агент отклонён | CAS-предусловие, batch захвата, гонка | 9, 10 |
| 6. Шаги видны лентой на экране прогона | `orbis_run_step`, `RunFeed` | 11, 15 |
| 7. Чекпойнт — тикет `waiting`, вопрос виден, тикет в «ждут меня», бейдж | `orbis_checkpoint`, `TicketWaitingBlock`, блок «Ждут меня» в заготовке + закреп смарт-листа `aspect=orbis/task, aspect=orbis/assignment, status=waiting` (механизм `PinnedList` готов) | 11, 14, 4 |
| 8. Ответ кнопкой — `planned`; следующий прогон видит ответ и историю | `agentRun.answerCheckpoint`, `reply` в `history` `orbis_claim_task` | 13, 10, 14 |
| 9. `orbis_finish` — тикет `waiting`, не `done` | глагол, тест | 11, 12 |
| 10. `done` в обход — отклонён скоупом | гейт `worker`, `entity_update`/`attach_*`/`batch_execute` → 403 | 7, 12 |
| 11. Прогон убит: без эффекта — `planned`, с эффектом — `waiting` с описанием остатков | подметание, `external` флаг, `agentRun.sweep` с экранов | 10, 13, 14 |
| 12. Версия закреплена, документ изменён, откат — канонично, аспекты/связи не тронуты | `entity_version_pin`, `version.restore` через executor, `VersionsCard` | 3, 5, 16 |
| 13. Откат прогона — статусы вернулись; написано, что осталось в репозитории | `rollbackRun` + `note`, `RunFeed` | 13, 15 |
| 14. Шаги в журнале с актором-агентом; «отмени последнее» отменяет действие исполнителя | `actor_grant_id`, undo шага, маркер в карточках | 6, 12, 15 |
| 15. PRD к факту тем же изменением | §2.2, §3, §4.14, §7.10, §9.3, 02 §5.9 (+§7.8, §9.2, §3.5, §3.9, D36, runbook) | 17 |

Инварианты дизайна → тесты: 1 (гонка захвата) — Задачи 9, 10; 2 (скоуп не трогает чужое) — 7, 12;
3 (глаголы через executor, журнал, Undo) — 6, 10–12 (с оговоркой В1 по `thread_post`); 4 (не `pending`)
— 12; 5 (брошенный с эффектом не даёт `planned`, прогон терминален) — 10, 11; 6 (порог, подметание
с экранов) — 10, 13, 14; 7 (откат не затирает чужое) — 13; 8 (откат версии — канонично, только
тело) — 5; 9 (RLS поимённо) — 3.

## Самопроверка плана

- **Покрытие спеки:** С1 (только тикет — `orbis/task` без изменений) ✓ ничего не строим; С2
  (раннера нет) ✓; С3 (процесс прозой в body, чекпойнт = `waiting`+`waiting_for`) — 4, 11; С4 —
  1, 4; С5 — 1, 10, 11, 2; С6 — 10, 13, 14; С7 — 7, 9, 10, 11, 12; С8 — 11; С9 (агент не правит
  документы — скоуп; предлагает `thread_post`) — 7; С10 — 4, 14, 15, 16; С11 — 3, 5, 16; С12 — 13,
  15; «Швы» — только фиксация в спеке (17), ничего не строим ✓; «Что НЕ входит» — не тронуто ✓;
  открытый вопрос 2 — решение плана 1 ✓; приёмка 1–15 — таблица выше, дыр нет ✓.
- **Плейсхолдеры:** «TBD/TODO/similar to» отсутствуют; тела тестов, помеченные `/* … */`, — это
  сценарии, чей код исполнитель пишет по описанию рядом (обвязка и ассерты названы), а не «напиши
  тесты»; в каждой задаче есть хотя бы один тест полным кодом.
- **Согласованность имён:** `GrantRef {id, scope, label}` (6) = `ctx.grant` (7, 10, 11);
  `AGENT_VERB_NAMES`/`WORKER_SCOPE_TOOLS` (7) = реестр (10) = тесты (12); `entityUpdateExecInput`/`precondition`
  (9) = операции глаголов (10, 11, 13); `SERVICE_ASPECT_IDS` (1) = компилятор (2) = реестр (1);
  `RUN_OUTCOMES`/поля `orbis/agent-run` (1) = `verbs.ts` (10, 11) = `RunFeed` (15) = `answerCheckpoint`
  (13: `reply`); `WireRollbackResult` (13) = `RunFeed` (15); `version.pin/list/restore` (5) = `VersionsCard` (16).
- **Правило проекта:** параллельность отмечена только по непересекающимся файлам; каждый коммит с
  pathspec; лимиты «bun run test / lint отдельно» — в глобальных ограничениях.
