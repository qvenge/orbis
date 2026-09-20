# Срез «Г — единица владения»: план реализации

> **Для агентных исполнителей:** ОБЯЗАТЕЛЬНЫЙ САБ-СКИЛЛ — `superpowers:subagent-driven-development`
> (рекомендуется) либо `superpowers:executing-plans`. Шаги размечены чекбоксами (`- [ ]`).
> Исполнитель задачи видит ТОЛЬКО свою задачу — имена и типы соседних задач продублированы в блоке
> «Интерфейсы». Модели: имплементеры, разведка и ре-ревью — Opus 5; гейт-ревью задачи и финальное ревью
> ветки — Fable 5.1; ниже Opus 5 — никогда (проверка по ID модели в транскрипте). Вместе с брифом
> имплементеру передаются `facts.md` и нужные `recon-*.md` из леджера
> `.superpowers/sdd/2026-09-20-graph-ownership/`. Каждый `file:line` плана — **опровергаем**: адрес снят на
> `main 877e13a`, перед правкой искать grep'ом по имени; опровержение факта плана ценнее его исполнения и
> пишется в `facts.md`.

**Цель:** единицей владения и изоляции становится граф, а не аккаунт: ключ строк `owner_id` переименован в
`graph_id`, появились таблицы `graphs` и `graph_members`, у каждой транзакции два идентификатора — аккаунт-актор
и текущий граф, а RLS читает «строка текущего графа ∧ актор держит грант». Всё работает при одном личном графе
на аккаунт; ни экранов, ни приглашений, ни графа компании срез не строит.

**Архитектура (как срез уложен в зелёные задачи):** Г-0 готовит ветку, базовую линию и пробу планов под новым
предикатом; Г-1 — переименование с классификацией «граф или аккаунт» отдельным коммитом при нулевом поведении
(миграция `0019`, греп-гейт навсегда); Г-2 — таблицы, бэкфилл, FK, политики новых таблиц, сид личного графа
первым шагом и тестовая обвязка (миграция `0020`); Г-3 — брендированные `AccountId`/`GraphId`, три резолвера
пары, `withIdentity` с парой и GUC текущего графа, замки/`$owner`/журнал/entitlements разведены по актору и
графу, поведенческий тест «граф ≠ аккаунт» — красный с пометкой; Г-4 — 35 политик на новый предикат, две
закрытые межграфовые дыры, pgTAP, перф против базовой линии, тест «граф ≠ аккаунт» зелёный (миграция `0021`);
Г-5 — доки и D44, слова миссии, версия клиента, финальное ревью, репетиция на бэкапе, прод с окном простоя,
приёмка живьём и `handoff-b2.md`. Порядок жёсткий: каждая задача мержится в `main` при выключенном автодеплое,
сломанного промежуточного состояния нет (старые политики GUC игнорируют, `sub` = граф по тождеству id).

**Стек:** Bun 1.2.7, Hono, tRPC 11, drizzle-orm 0.45 / drizzle-kit 0.31.10 (Supabase Postgres 17, RLS, pgTAP),
zod, React 19 + TanStack Query, `bun:test` (server/shared/scripts), vitest (web), biome, expect(1).

**Спека:** `docs/superpowers/specs/2026-09-19-graph-ownership-unit-design.md` — **ревизия 2.1** (`main 877e13a`).
Состав, порядок, швы, приёмка и границы — в спеке (§3, §5, §6, §8.1); план их не пересматривает, при
расхождении права спека. Расхождения спеки с кодом собраны в разделе «Эрраты спеки» — спеку правит только
владелец. Рулинги координатора Р-КГ-… и факты Ф-Г-… — `facts.md` леджера, действуют как часть плана.

**Нумерация:** задачи Г-0…Г-5 — как в спеке §8.1. Сверх спеки срез добавляет `handoff-b2.md` (Г-5) и то, без чего её
требования не исполнить или не проверить: проба планов (Г-0), операции только-чтения `ops.ts dump` и `ops.ts graphs` и пин
версий клиента (Г-5), индекс `graph_members_account`, `issued_by = auth.uid()` в INSERT-политике членства, проверка
«выдающий держит грант owner» в коде выдачи грантов агентам (Г-3), ключ отчёта пересева `graph → world` (Г-2).

---

## Что установила разведка HEAD (20.09.2026, `main 877e13a`)

Четыре читателя Opus 5 по зонам (база и RLS; идентичность; поверхность переименования; обвязка, перф, CI,
прод) и координатор (доки): конспекты `recon-1…5-*.md` в леджере. Все пять коммитов между `3a4332c` (адреса
спеки) и `877e13a` — docs-only, поэтому адреса спеки обязаны сходиться дословно; разошедшиеся — в «Эрратах».
Проба планов под новым предикатом не выполнена (Docker был выключен) — она шаг Г-0. Ниже — только то, что
определяет форму задач.

| # | Факт | Следствие для плана |
|---|---|---|
| Д-1 | Живых политик RLS 39, переписываются 35, не трогаются 4 (`server_manages_grants`, `server_manages_clients`, `scheduler_reads_owner_list`, `read_all`); `auth.uid()` — 66 вхождений в 7 миграциях (Ф-Г-5) | Г-4 — DROP/CREATE ровно 35; инвентарь — `recon-1-db-rls.md` §1.А |
| Д-2 | Дыр межграфовой строгости две: `chat_threads.entity_id` и `envelope_spent_cache.envelope_id` (Ф-Г-6) | Г-4 закрывает обе, по проверке pgTAP на каждую |
| Д-3 | `RENAME COLUMN` сам переписывает выражения политик и partial-индексов; не трогает пять ИМЁН с `owner` и тексты `sql.raw` (Ф-Г-7, Ф-Г-8) | `0019` — рукописная: 15 `RENAME COLUMN` + 5 `RENAME` имён; промежуток Г-1→Г-4 рабочий |
| Д-4 | drizzle-kit 0.31.10 без неинтерактивного режима, вопрос — на каждую колонку; прежняя expect-обёртка отвечает «create» (Ф-Г-18); снимок политик не хранит | снимок генерируется своей expect-обёрткой «rename», SQL — руками; сверка — повторный `generate` «No schema changes» |
| Д-5 | Весь накат неприменённых миграций — одна транзакция; хеш применённых не сверяется (Ф-Г-9) | прод получает `0019…0021` атомарно; расхождение файла и базы ловит только репетиция на бэкапе |
| Д-6 | Админ-роль `postgres` — BYPASSRLS, не superuser; `SET ROLE orbis_app` невозможен (Ф-Г-10) | группы pgTAP про `orbis_app` — структурные; поведение — серверным тестом под `appDb()`; тест бэкфилла — через `DROP/ADD CONSTRAINT` |
| Д-7 | Ширина переименования в коде — 2 167 строк в 204 файлах; второй golden — `surfaces.json` (18); механизма пересдачи golden нет; модели и внешнему агенту переименование не видно (Ф-Г-11…13) | Г-1: golden правится заменой имени в файле; байтовая неизменность `tool-registry.json` и фикстур промптов — гейт |
| Д-8 | Класс «по смыслу аккаунт» в вебе — один шов: черновики (`draft-storage.ts:78-79` ← `useBodySave.ts:229`); retry-буфер уже на сессии (`AuthProvider.tsx:29`) | Г-1 переводит черновики на сессию по образцу retry-буфера |
| Д-9 | `freshUserId()` — 578 вызовов, 117 синхронных; 36 файлов держат модульного владельца и `truncateAll()` в `beforeAll`; `truncateAll` — `TRUNCATE … CASCADE` (Ф-Г-14, Ф-Г-15) | Г-2: `mintGraph`/`freshGraph`/`ensureGraphs`, `truncateAll` восстанавливает личности процесса; `graphs` вне списка `CASCADE` (Р-КГ-3) |
| Д-10 | Сайтов рождения пары четыре (Bearer рождается дважды); по актору сегодня идут замки, ключ кеша реестра, `$owner`, владелец сообщения журнала, субъект entitlements (Ф-Г-16); брендов в репозитории нет | Г-3 шире, чем «сигнатура `withIdentity`»: бренды здесь заменяют тест, которого при одном графе на аккаунт написать нечем |
| Д-11 | Резолвер планировщика читает `graph_members` под `orbis_app`; сид идёт под `authenticated` | политики и гранты новых таблиц — в `0020` (Г-2), не в `0021` (Р-КГ-1, эррата Э-2) |
| Д-12 | Мест выдачи гранта агента два; вставка идёт под `orbis_app` мимо RLS (Ф-Г-17) | `issued_by`: `0020` nullable + бэкфилл → Г-3 писатели → `0021` NOT NULL (Р-КГ-2) |
| Д-13 | `perf/explain.test.ts` вне CI, пины стоят на `owner_owns_row`; `test:perf:volume` гонять первым; худший запас — `agenda:horizon` (Ф-Г-19) | Г-0 и Г-4 зовут `test:perf:explain` явно; сравнение — по Р-КГ-10 |
| Д-14 | Один сервис Render отдаёт API и веб; `ORBIS_ROUTINE_SCHEDULER` зашит в блюпринт; версия клиента — два файла без пина (Ф-Г-1, 2, 20) | `autoDeploy: false` закрывает обе половины; окно Г-5 гейтится `/health`; пин «APP ≥ MIN» заводит Г-5 |
| Д-15 | Живые доки несут `owner_id` (PRD 48 строк, implementation 53), ранбук §4.3 держит процедуру перепривязки владельца на 13 `UPDATE … owner_id` (Ф-Г-3) | Г-5 правит живые доки и процедуру ранбука; исторические `docs/superpowers/**` не трогаются (эррата Э-1) |

## Решения плана РП-1…РП-14 (владелец может отменить)

- **РП-1. Автодеплой Render выключен задачей Г-0** docs-коммитом в `main` (`autoDeploy: false` после `render.yaml:12`,
  образец `773a925`), возвращается Г-5 после прод-процедуры. Между ними каждый мерж в `main` — без деплоя.
- **РП-2. Ветка `graph-ownership-g`, worktree `.claude/worktrees/graph-ownership-g`**; мерж и пуш в `main` (ff-only) после
  закрытия каждой задачи (гейт Fable + зелёный CI) — постоянное распоряжение владельца; при АФК-прогоне — по распоряжению.
  План закоммичен в `main` (слово владельца 20.09); скрипты леджера читают его из ОСНОВНОГО дерева: docs-правки плана по
  опровержениям исполнителей идут в `main`, а в ветку приезжают только rebase'ом (Ф-Г-4).
- **РП-3. Миграций три: `0019_graph_key_rename` (Г-1), `0020_graphs_members` (Г-2), `0021_graph_rls` (Г-4); четвёртая = СТОП
  и доклад.** Все — рукописный SQL со сгенерированным снимком (образец `0015`/`0018`).
- **РП-4. Политики, гранты и триггеры И-1 новых таблиц — в `0020`** (Р-КГ-1); `0021` несёт 35 переписанных политик, функции
  политик, закрытие двух дыр и `issued_by SET NOT NULL` (Р-КГ-2).
- **РП-5. Греп-гейт кода — маркер `owner-key` в `scripts/check-legacy-form.ts`** (уже в CI); гейт доков — шаг Г-5 (Р-КГ-4).
- **РП-6. Переименовываются: колонка и поле (`owner_id`/`ownerId`), всё содержащее `OwnerId(s)`
  (`ownerIdsForScheduler` → `graphIdsForScheduler`), пять имён индексов/PK (Ф-Г-7), `GRAPH_TABLES` → `WORLD_TABLES`.**
  Не переименовываются: роль (`actorKind: 'owner'`, `ownerOnlyProcedure`, `ownerCaller`, `ownerOnly`), `seedOwnerGraph`,
  составные без `Id`, голое `owner` в тестах, `$owner` языка E, значения реестра `owner_default_*` (Р-КГ-8) — списком в
  `rename-ledger.md`.
- **РП-7. Тестовая обвязка** — Р-КГ-3: `mintGraph()` синхронно выдаёт id и регистрирует его, `freshGraph()` выдаёт и сразу
  заводит граф с грантом, `ensureGraphs()` доводит зарегистрированное до базы, `truncateAll()` сносит всё и зовёт `ensureGraphs()`.
- **РП-8. Форма идентичности** — Р-КГ-5: `Identity { actor, graph }` одним значением, поле `identity` вместо `actorUserId`
  у `Context`, `ExecuteRequest`, `ToolCallCtx`; бренды — `packages/shared/src/ids.ts`; резолверы — `apps/server/src/identity.ts`.
- **РП-9. Субъект entitlements — `AccountId`, расход `ai_usage` — на граф** (Р-КГ-6).
- **РП-10. Имена в SQL:** функции `public.current_graph_id()`, `public.actor_reads_current_graph()`,
  `public.actor_writes_current_graph()`, `public.actor_owns_current_graph()`; политики строк — по одной на команду: `current_graph_select`,
  `current_graph_insert`, `current_graph_update`, `current_graph_delete` (у всех 11 таблиц строк, включая `relations` и
  `chat_messages`), выданы `TO authenticated`; реестровые четыре имени не меняются; ключ GUC — `graph` внутри `request.jwt.claims`.
- **РП-11. CHECK личного графа — с `owner_ref IS NOT NULL`** (Р-КГ-9).
- **РП-12. Критерий «без регрессии» перфа** — Р-КГ-10.
- **РП-13. Версии `MIN_COMPATIBLE_CLIENT_VERSION` и `APP_VERSION` поднимаются до `0.2.0` в Г-5** одним коммитом с пином
  «APP ≥ MIN»; формат экспорта остаётся `version: 2` (Р-КГ-12).
- **РП-14. Порядок прод-процедуры:** репетиция на восстановленном дампе → планировщик выключен (гейт
  `/health.routineScheduler == "off"`) → бэкап → `migrate` (три миграции одной транзакцией) → деплой → `/health` →
  планировщик включён → автодеплой возвращён → приёмка живьём.

## Вопросы владельцу (план исполняется по умолчаниям)

- **В-ПГ-1. Откуда берётся дамп для репетиции Г-5.** Артефакт `backup.yml` зашифрован ключом владельца, а команды дампа в
  белом списке `scripts/ops.ts` нет. **Умолчание:** Г-5 добавляет операцию `dump` в белый список (обёртка над
  `scripts/backup.sh`, только чтение, секрет из Ключницы; файл — в `rehearsal/` леджера вне git, удаляется шагом уборки).
  Альтернатива: владелец сам расшифровывает артефакт (`gpg --decrypt`, ранбук §4.3) и кладёт файл в `rehearsal/` —
  тогда шаг с `ops.ts dump` пропускается, кода не добавляется.
- **В-ПГ-2. Чем выключается планировщик на окно простоя.** Переменная живёт и в Render UI, и в `render.yaml`
  (Ф-Г-2); MCP-тулом её менять нельзя — смена переменной деплоит HEAD `main`, то есть новый код ДО миграции; коммит в
  `render.yaml` перед окном тоже не годится — Blueprint-sync может выкатить тот же HEAD.
  **Умолчание:** владелец в Render UI ставит `ORBIS_ROUTINE_SCHEDULER=0` («Save only») и перезапускает сервис (Restart);
  гейт — `/health` отдаёт `routineScheduler: "off"`; `render.yaml` НЕ трогается (в нём остаётся `"1"`), после выкатки нового
  кода значение в UI возвращается на `"1"` (Blueprint-sync мог вернуть его сам) и сверяется тем же `/health`. Если рестарт
  переменную не подхватил — «Manual Deploy → Deploy a specific commit» на текущий прод-коммит.
  Альтернатива (отступление от В-Г-10): планировщик не выключать — тик старого кода падает на первом же запросе
  (`SELECT owner_id …`) и записей не делает.
- **В-ПГ-3. Рестарт локальной базы под репетицию.** Репетиция восстанавливает дамп прода в ЛОКАЛЬНЫЙ Supabase
  (`supabase db reset` → `psql -f`), то есть на время шага сносит общую для всех сессий локальную базу и кладёт на диск
  личные данные владельца. **Умолчание:** так, с уборкой (`db reset && db:prepare`, удаление дампа) тем же шагом.
  Альтернатива: отдельный Supabase-проект под репетицию (чище, но заводит владелец).

## Глобальные ограничения

- **Ветка `graph-ownership-g` от свежего `origin/main` (`877e13a` или новее), работа только в worktree**
  (`/Users/birzhan/projects/orbis/.claude/worktrees/graph-ownership-g`); основное дерево не трогать (владелец пушит
  параллельно); свой `bun install`; корневой `.env` копировать из `apps/server/.env`; абсолютные пути — только внутрь
  worktree; **каждый вызов Bash начинается со своего `cd`**; параллельные имплементеры в одном дереве запрещены;
  **серверные сьюты делят одну локальную БД — один прогон за раз**.
- **Спека — источник истины; требование спеки в шаге даётся ссылкой на §.** Спеку, план Б-2 и его леджер, `05-mission`
  (кроме слов §7 в Г-5) не править. Противоречие плана и спеки решается в пользу спеки с записью в `facts.md`.
- **Миграции — РП-3.** Три файла в `apps/server/src/db/migrations`, рукописный SQL по образцу
  `0018_spent_cache_modules.sql` (маркер `--> statement-breakpoint` между статементами), снимок — сгенерированный,
  регистрация в `meta/_journal.json` — генератором. Применённые `0000…0018` и их снимки не правятся. Четвёртая = СТОП.
  Локальная база с нуля — `bunx supabase db reset && bun run db:prepare`.
- **Прод-операции из `main` в промежутке Г-1 … прод-процедура Г-5.** `main` несёт новый код, прод — старую схему: операции
  `scripts/ops.ts`, называющие ключ строк (`check`, `seed-registries`, `reset-world`, `issue-pat`), против прода НЕИСПОЛНИМЫ
  (`column "graph_id" does not exist`); пригодны `ping`, `census`, `migrate` (и `dump` с Г-5). Нужен PAT или пересев на проде до
  закрытия среза — из checkout'а коммита «main@до Г» (хеш — Ф-Г-22), не из `main`.
- **Без обхода RLS.** Ни `SECURITY DEFINER`, ни `BYPASSRLS`, ни варианта `graph_id = auth.uid() OR …` (спека §3.6);
  функции политик — `SECURITY INVOKER`, `SET search_path = ''`, все имена в телах — с явной схемой.
- **Слова.** В коде ключ строк — `graphId`/`graph_id`, аккаунт — `accountId`/`AccountId`, пара — `identity`; «владелец» в
  коде остаётся только ролью (`actorKind: 'owner'`, `ownerOnlyProcedure`, грант `owner`). Новых терминов сверх §2 спеки
  не вводить. Приведение `GraphId` ↔ `AccountId` вне `apps/server/src/identity.ts` — дефект.
- **Экранов нет.** Правки `apps/web` — только переименование ключа провода, перевод скоупа черновиков на сессию (Г-1) и
  `APP_VERSION` (Г-5).
- **Никаких `TODO`/«потом»** внутри задач; долги ступени 2 называются в докблоке словами спеки §6.
- **TDD.** Полный прогон — `bun run test` из корня (голый `bun test` ЗАВИСАЕТ); `bun run lint`, `bun run typecheck` —
  отдельными вызовами; `bun run test:rls` (pgTAP) — после каждой миграции; `bun run test:perf` — отдельно, на
  незанятой машине; `bun run test:perf:volume` — ПЕРВЫМ из внеCI-скриптов, затем `test:perf:explain`, `test:perf:graph`;
  `bun scripts/check-legacy-form.ts --gate` — в CI. Точечный прогон: `cd apps/server && bun test src/path/file.test.ts`;
  shared — `cd packages/shared && bun test <файл>`; web — `cd apps/web && bunx vitest run <файл>`.
  `test.failing` в Bun 1.2.7 — только с синхронным телом (походы в БД — в `beforeAll`).
- **Golden-снимки правятся руками** (Ф-Г-12): замена имени в файле + `bunx biome check --write <файл>`; коммит называет это
  прямо. `tool-registry.json` и `apps/server/src/llm/prompts/*.fixture.txt` обязаны остаться байт-в-байт весь срез.
- **Язык кода, комментариев, ошибок, коммитов — русский; комментарий объясняет «почему».**
- **Коммит после каждой задачи** — `git commit -- <пути>`; в сообщении `Co-Authored-By: Claude Fable 5.1
  <noreply@anthropic.com>` (имплементер Opus пишет свою модель). Протокол закрытия: `git fetch` → rebase на чистом
  дереве → push ветки → CI → ff-push в `main` (автодеплой выключен — Г-0; флаг `get_service → autoDeploy: "no"`
  перечитывается перед КАЖДЫМ мержем).
- **Ревью-пакет и учёт ревью** — по `docs/superpowers/templates/orchestrator-prompt.md` (экземпляр в леджере);
  мутационная проверка деливеребла ревьюером обязательна; раздел отчёта имплементера «Пины и мутации» обязателен.

## Карта файлов

| Область | Создать | Изменить |
|---|---|---|
| shared | — | `src/ids.ts` (бренды `AccountId`/`GraphId`, Г-3; имена параметров формул, Г-1), `src/schemas/entity.ts:5` (ключ провода), `src/constants.ts:3` (Г-5), прочие 17 файлов с `ownerId` (Г-1) |
| server / БД | `db/migrations/0019_graph_key_rename.sql`, `0020_graphs_members.sql`, `0021_graph_rls.sql` (+ снимки, `_journal.json`) | `db/schema.ts` (15 колонок, 2 таблицы, FK, `issued_by`), `db/with-identity.ts`, `db/reset-world.ts`, `db/registry-drift.ts` (`sql.raw`) |
| server / идентичность | `identity.ts` (+ `identity.test.ts`), `test/graph-vs-account.test.ts` | `trpc.ts`, `context.ts`, `mcp/{server,transport}.ts`, `oauth/grants.ts`, `routers/oauth.ts`, `routines/{queries,scheduler,runner,lifecycle}.ts`, `executor/{types,executor,journal,relations,undo}.ts`, `tools/dispatch.ts`, `agent-loop/{verbs,sweep,rollback}.ts`, `registry/{ops,cache}.ts`, `budget/binding.ts`, `query/{context,compile-ast}.ts`, `expr/compile.ts`, `recurring/with-materialization.ts`, `entitlements.ts`, `chat/threads.ts`, `seed/{onboarding,world,gardener}.ts`, `export.ts`, `wire.ts`, остальные файлы из 36 с `withIdentity(` |
| server / тесты | `src/db/graphs.test.ts` (CHECK, И-1 с гонкой, бэкфилл), `src/db/graphs-policies.test.ts` (поведение под `orbis_app`) | `test/helpers.ts` (`mintGraph`, `freshGraph`, `ensureGraphs`, `personal`, `addMember`, `truncateAll`), `test/rls/rls.pgtap.sql`, `test/golden/{query-sql,surfaces}.json`, `test/surfaces.ts:335`, 85 файлов с `freshUserId`, 18 локальных `callerFor`, `src/db/{with-identity,reset-world}.test.ts`, `perf/explain.test.ts` (пины — только при изменении вердикта) |
| web | — | `features/entity-editor/{draft-storage,useBodySave}.ts`, `auth/AuthProvider.tsx`, `test/harness.tsx`, 5 тестов с ключом провода, `features/chat/useEnsuredThread.tsx` (докблок), `app/version.ts` (Г-5) |
| scripts | леджер: `drizzle-rename.exp`, `probe-rls-plan.sql` | `check-legacy-form.ts` (+`.test.ts`, маркер `owner-key`), `ops.ts` (`issue-pat`, `dump`), `issue-pat.ts`, `llm-smoke.ts`, `probe-p4.ts` |
| docs | леджер: `rename-ledger.md`, `handoff-b2.md`, `step-prod-g.md`, `acceptance-g.md` | `render.yaml`, `docs/prd/{00-product,01-architecture,02-core-os,03-budget,04-decision-log,05-mission}.md`, `docs/implementation/{00-architecture,02-ops-runbook,03-pending}.md` |

## Порядок и параллельность

Порядок строгий: Г-0 → Г-1 → Г-2 → Г-3 → Г-4 → Г-5 (спека §8.1 «порядок жёсткий»); каждая задача потребляет
Produces предыдущей, параллельных пар нет, один имплементер в дереве в каждый момент. После Г-1, Г-2, Г-3 и Г-4 —
мерж в `main` (автодеплой выключен); Г-3 мержится с двумя красными-с-пометкой сюжетами, Г-4 — только когда тест
«граф ≠ аккаунт» зелёный (гейт спеки Ш-3). Прод-процедура Г-5 и приёмка живьём — с владельцем, отдельным его словом.

## Задачи

### Задача Г-0: Ветка, worktree, базовая линия, проба планов, автодеплой off

**Зачем:** срез мержится в `main` после каждой закрытой задачи (РП-2), а `RENAME COLUMN` миграции `0019`
несовместим со старым кодом — с включённым автодеплоем первый же мерж Г-1 выкатил бы код, читающий `graph_id`,
на базу с `owner_id`. Поэтому автодеплой выключается ДО первого мержа. Тем же заходом срез получает базовую линию
(счётчики сьютов, pgTAP, семь медиан перфа, вердикты скрипта планов) — точку сравнения для Г-1 («счётчики равны»)
и Г-4 («без регрессии») — и пробу, которой не делал никто: планы запросов под предикатом §3.6 спеки. Задача не
пишет ни строки продуктового кода.

**Файлы:**
- Изменить (в ОСНОВНОМ дереве `/Users/birzhan/projects/orbis`, ветка `main`): `render.yaml` — вставка строки
  `autoDeploy: false` после `:12` `    branch: main` (ключа `autoDeploy` в файле сегодня НЕТ, `:13` —
  `dockerfilePath: ./Dockerfile`).
- Создать (леджер `.superpowers/sdd/2026-09-20-graph-ownership/`, вне git — `.gitignore:24`):
  `orchestrator-prompt.md`, `make-brief.sh`, `make-review-pack.sh`, `probe-rls-plan.sql`, `probe-rls-plan.log`.
- Дописать: `progress.md` и `facts.md` того же леджера — оба УЖЕ существуют: дописывать в конец, не перезаписывать.
- Тест: собственных тестов нет; мерка задачи — прогоны базовой линии (шаги 8–10) с EXIT=0 и вывод пробы (шаг 11).
- НЕ трогать: `docs/superpowers/templates/orchestrator-prompt.md` (общий шаблон) · план Б-2 и леджер
  `.superpowers/sdd/2026-09-14-properties-reform-b2/` · `.superpowers/sdd/2026-09-02-properties-reform-b1/`
  (источник копий, только чтение) · `docs/prd/**` (D44 и доки — Г-5).

**Интерфейсы:**

*Consumes* (открыто на `main 877e13a`):
```
render.yaml:7-14   - type: web / name: orbis / runtime: docker / plan: free / region: frankfurt /
                   branch: main / dockerfilePath: ./Dockerfile / healthCheckPath: /health
git log --oneline -4 -- render.yaml → 30b22db (возврат Б-1) · 773a925 (ВЫКЛЮЧЕНИЕ Б-1 — образец вставки)
package.json:13 "test" · :14 "test:rls" · :16 "db:prepare" · :17 "test:perf" · :18-21 "test:perf:graph|explain|volume"
apps/server/test/rls/rls.pgtap.sql:6  SELECT plan(97);
apps/server/perf/perf.test.ts:113-122  BUDGETS_MS — семь порогов 60/60/300/120/120/150/120 мс
apps/server/perf/explain.test.ts:164-166  форма пина `${index}: chosen=… usable=… admin=…`
apps/server/.env:3  DATABASE_URL_ADMIN=postgres://postgres:…@127.0.0.1:54322/postgres  (54322 — прямой порт, 54329 — пулер)
.superpowers/sdd/2026-09-02-properties-reform-b1/make-brief.sh — 27 строк (правятся :2, :6, :7, :14)
.superpowers/sdd/2026-09-02-properties-reform-b1/make-review-pack.sh — 72 строки (правятся :2, :9, :10, :11, :27, :45)
docs/superpowers/templates/orchestrator-prompt.md — 66 строк, 12 плейсхолдеров `{{…}}`
mcp__render__get_service / list_deploys — workspaceId tea-d93srfq8qa3s73bdfka0, orbis = srv-d9781kvavr4c73d85r60
ориентир счётчиков (итог Б-1): shared 505, server 2677, web 1188 (+1 skip), scripts 57
```

*Produces:* ветка `graph-ownership-g` от `origin/main` (ПОСЛЕ docs-коммита этой задачи) · worktree
`/Users/birzhan/projects/orbis/.claude/worktrees/graph-ownership-g` (свой `bun install`, свой `.env`) · прод Render с
`autoDeploy: "no"` (возврат — Г-5) · `<леджер>/progress.md` — запись «main@до Г» с базовой линией · `<леджер>/facts.md` —
Ф-Г-22…Ф-Г-25 · `<леджер>/probe-rls-plan.log` с вердиктом пробы · `orchestrator-prompt.md`, `make-brief.sh`,
`make-review-pack.sh`.

> **Ловушка cwd.** Каждый вызов Bash начинается со своего `cd` — рабочий каталог между вызовами сбрасывается.
> Пути ниже пишутся полностью. `WT` = `/Users/birzhan/projects/orbis/.claude/worktrees/graph-ownership-g`,
> `LED` = `/Users/birzhan/projects/orbis/.superpowers/sdd/2026-09-20-graph-ownership`.

- [ ] **Шаг 1: предпроверки в основном дереве.**
```
cd /Users/birzhan/projects/orbis && git status --short && git fetch origin && git rev-parse HEAD origin/main
cd /Users/birzhan/projects/orbis && ls docs/superpowers/plans/2026-09-20-graph-ownership-g.md
cd /Users/birzhan/projects/orbis && git branch --list graph-ownership-g && git worktree list
cd /Users/birzhan/projects/orbis && grep -n autoDeploy render.yaml || echo 'autoDeploy отсутствует — ожидаемо'
cd /Users/birzhan/projects/orbis && gh run list --branch main --limit 1
```
  Ожидание: `git status` — пусто либо только неотслеживаемый план Б-2 (`?? docs/superpowers/plans/2026-09-14-…` — его срез
  не трогает; план среза Г закоммичен, Ф-Г-4),
  `HEAD` = `origin/main` = `877e13a` или новее, файл плана на месте, ветки и worktree с таким именем нет, `autoDeploy`
  отсутствует, последний CI на `main` — `success`. Красный CI на `main` — СТОП: базовая линия с красного не снимается.

- [ ] **Шаг 2: `render.yaml` — автодеплой off (РП-1).** Вставить строкой 13, сразу после `:12` `    branch: main`
  (отступ ровно 4 пробела; форма — по образцу `773a925`):
```yaml
    autoDeploy: false # выключен на время среза «Г — единица владения» (D44, РП-1 плана): миграция 0019 переименовывает owner_id → graph_id и несовместима со старым кодом, а мерж в main после каждой задачи иначе выкатывал бы код на базу без переименования; вернуть прод-процедурой закрытия (задача Г-5)
```
  Проверка: `cd /Users/birzhan/projects/orbis && sed -n '11,15p' render.yaml` — строка стоит между `branch: main`
  и `dockerfilePath: ./Dockerfile`.

- [ ] **Шаг 3: docs-коммит ПРЯМО В `main` и пуш.** Правила ветки на него не распространяются: автодеплой обязан быть
  выключен ДО первого мержа, а `main` после пуша станет базой ветки (шаг 5).
```
cd /Users/birzhan/projects/orbis && git add render.yaml && git commit -m "$(printf 'ops(render): автодеплой сервиса orbis выключен на время среза «Г — единица владения» (D44, РП-1)\n\nСрез мержится в main после каждой закрытой задачи, а миграция 0019 (RENAME COLUMN owner_id → graph_id\nна 15 таблицах) несовместима со старым кодом: с включённым автодеплоем первый же мерж выкатил бы код,\nчитающий graph_id, на базу с owner_id. Миграции 0019–0021 идут на прод руками прод-процедурой закрытия\n(задача Г-5), возврат автодеплоя — её же docs-коммитом (образец 30b22db). Сам этот коммит вызовет\nбезвредный деплой текущего main: код тот же, что в проде.\n\nCo-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>')"
cd /Users/birzhan/projects/orbis && git push origin main && git rev-parse origin/main
```
  Ожидание: один коммит (`render.yaml | 1 +`), push принят. В индекс не должен попасть ни один другой файл — перед
  коммитом `git status --short` показывает `M render.yaml` и, возможно, неотслеживаемый план Б-2 — больше ничего.

- [ ] **Шаг 4: подтвердить прод машинно.** Пуш вызовет безвредный деплой текущего `main`. Каждый вызов — отдельным
  Render-MCP-вызовом, `workspaceId: tea-d93srfq8qa3s73bdfka0`, сервис `orbis` = `srv-d9781kvavr4c73d85r60`:
  (1) `mcp__render__list_deploys` → дождаться `live` у деплоя этого коммита; (2) `mcp__render__get_service` →
  **`autoDeploy: "no"`**; (3) если осталось `"yes"` — Blueprint-sync не подхватил: dashboard.render.com/web/srv-d9781kvavr4c73d85r60 →
  Settings → Build & Deploy → Auto-Deploy → No, затем повторить `get_service`. Ответ записать в `facts.md` (Ф-Г-24):
  он перечитывается перед КАЖДЫМ мержем задачи в `main`.

- [ ] **Шаг 5: ветка и worktree ОТ НОВОГО `origin/main`.** Только после шага 3.
```
cd /Users/birzhan/projects/orbis && git fetch origin && git worktree add -b graph-ownership-g .claude/worktrees/graph-ownership-g origin/main
cd /Users/birzhan/projects/orbis/.claude/worktrees/graph-ownership-g && git rev-parse HEAD && git status --short
```
  Ожидание: `HEAD` ветки = `origin/main` (хеш шага 3), дерево чистое.

- [ ] **Шаг 6: зависимости и окружение worktree.**
```
cd /Users/birzhan/projects/orbis/.claude/worktrees/graph-ownership-g && bun install
cd /Users/birzhan/projects/orbis/.claude/worktrees/graph-ownership-g && cp /Users/birzhan/projects/orbis/apps/server/.env apps/server/.env && cp apps/server/.env .env
cd /Users/birzhan/projects/orbis/.claude/worktrees/graph-ownership-g && grep -c '^[A-Z_]' .env apps/server/.env
```
  Корневой `.env` нужен `scripts/setup-db.ts` (`DATABASE_URL_ADMIN`, `ORBIS_APP_PASSWORD` читаются из cwd). Ожидание:
  одинаковое число ключей в обоих; обязаны быть `DATABASE_URL`, `DATABASE_URL_ADMIN`, `ORBIS_APP_PASSWORD`.

- [ ] **Шаг 7: локальная база С НУЛЯ.** Стек Supabase общий с основным деревом; на 20.09 Docker был выключен (Ф-Г-21).
```
cd /Users/birzhan/projects/orbis/.claude/worktrees/graph-ownership-g && docker info >/dev/null 2>&1 || open -a Docker
cd /Users/birzhan/projects/orbis/.claude/worktrees/graph-ownership-g && bunx supabase status || bunx supabase start
cd /Users/birzhan/projects/orbis/.claude/worktrees/graph-ownership-g && bunx supabase db reset && bun run db:prepare
```
  Ожидание `db:prepare`: EXIT=0, миграции `0000…0018` накачены с нуля, сид реестров печатает свои числа (записать —
  ориентир Б-1: свойств 77, ролей 11, аспектов 13, контрактов 6, подписок 2), в хвосте `test:rls` — `plan(97)` без строки
  «Looks like you planned». Пользователей нет (рулинг владельца 23.08) — локальную базу сносить можно без оговорок.

- [ ] **Шаг 8: базовая линия — полный сьют.** Голый `bun test` ЗАВИСАЕТ; серверные сьюты делят одну БД.
```
cd /Users/birzhan/projects/orbis/.claude/worktrees/graph-ownership-g && bun run test
```
  Ожидание EXIT=0. **Числа берутся из ЭТОГО прогона** (shared / server / web (+skip) / scripts) и пишутся в `progress.md`
  как базовая линия среза: приёмка Г-1 требует «счётчики тестов равны базовой линии Г-0» (спека Ш-1а). Расхождение с
  ориентиром Б-1 больше пары десятков тестов разбирается до продолжения. Известный класс флака под нагрузкой —
  таймаут 5000 мс у `routines/scheduler.test.ts`, `executor/relations.test.ts`, `recurring/post-due.test.ts`,
  `routers/agent-run.test.ts` (ранбук §8): перепрогнать точечно и записать оба числа.

- [ ] **Шаг 9: lint, typecheck, pgTAP, перф, греп-гейт, сборка веба — своими вызовами, на незанятой машине.**
  Объёмный сьют — ПЕРВЫМ (хрупкий пин `relations_source_role`, Ф-Г-19); `test:perf:graph` — дважды, в зачёт идёт
  прогретый прогон.
```
cd /Users/birzhan/projects/orbis/.claude/worktrees/graph-ownership-g && bun run test:perf:volume
cd /Users/birzhan/projects/orbis/.claude/worktrees/graph-ownership-g && bun run test:perf:explain
cd /Users/birzhan/projects/orbis/.claude/worktrees/graph-ownership-g && bun run test:perf:graph
cd /Users/birzhan/projects/orbis/.claude/worktrees/graph-ownership-g && bun run test:perf
cd /Users/birzhan/projects/orbis/.claude/worktrees/graph-ownership-g && bun run lint
cd /Users/birzhan/projects/orbis/.claude/worktrees/graph-ownership-g && bun run typecheck
cd /Users/birzhan/projects/orbis/.claude/worktrees/graph-ownership-g && bun run test:rls
cd /Users/birzhan/projects/orbis/.claude/worktrees/graph-ownership-g && bun scripts/check-legacy-form.ts --gate
cd /Users/birzhan/projects/orbis/.claude/worktrees/graph-ownership-g && bun run --filter @orbis/web build && bun scripts/check-lazy-chunks.ts
```
  Ожидание: все EXIT=0 (у `test:perf:explain` из семи проверок три зависят от наполнения корпуса — красный из них
  разбирается по содержимому вердикта, ранбук §8.1). Записать: **семь медиан** `test:perf` (строки `perf: …`),
  **вердикты `test:perf:explain` дословно** в форме `<index>: chosen=… usable=… admin=…` (на `877e13a` три GIN запинены как
  `chosen=false usable=false admin=true`), p95 `test:perf:graph`, числа `test:perf:volume`.

- [ ] **Шаг 10: единая команда счёта ширины переименования (Ф-Г-11).**
```
cd /Users/birzhan/projects/orbis/.claude/worktrees/graph-ownership-g && git grep -aP -c 'owner_?[Ii]d' -- apps/server/src apps/server/test apps/server/perf packages/shared/src apps/web/src scripts ':!*.snap' ':!apps/server/src/db/migrations/**' | awk -F: '{s+=$NF; f++} END {print s" строк в "f" файлах"}'
cd /Users/birzhan/projects/orbis/.claude/worktrees/graph-ownership-g && git grep -ac 'freshUserId(' -- apps/server | awk -F: '{s+=$NF; f++} END {print s" вызовов в "f" файлах"}'
```
  Ожидание: `2167 строк в 204 файлах` и `578 вызовов в 85 файлах` (± правки `main` после 20.09). Эти две команды —
  ЕДИНСТВЕННЫЙ способ счёта в срезе: числа спеки §3.4 считаны частью с тестами, частью без (эррата Э-7).

- [ ] **Шаг 11: проба планов под предикатом §3.6 (никем не запускалась — спека §10.2, хвост).** Создать
  `$LED/probe-rls-plan.sql` — всё в ОДНОЙ транзакции с `ROLLBACK`, существующие объекты базы не трогаются:
```sql
-- probe-rls-plan.sql — проба планов под предикатом «текущий граф ∧ членство» (спека §3.6).
-- Всё в одной транзакции; ROLLBACK в конце: база не мутируется. Прогон — админ-DSN (BYPASSRLS).
BEGIN;
CREATE TABLE probe_graph_members (graph_id uuid NOT NULL, account_id uuid NOT NULL,
  grant_kind text NOT NULL, revoked_at timestamptz);
CREATE TABLE probe_entities (id uuid PRIMARY KEY, graph_id uuid NOT NULL, title text NOT NULL,
  updated_at timestamptz NOT NULL);
-- близнец боевого entities_graph_updated (graph_id, updated_at DESC): упорядоченное чтение списка
CREATE INDEX probe_entities_graph_updated ON probe_entities (graph_id, updated_at DESC);
INSERT INTO probe_graph_members
  SELECT g, g, 'owner', NULL
  FROM (SELECT ('00000000-0000-4000-8000-' || lpad(to_hex(i), 12, '0'))::uuid AS g
        FROM generate_series(1, 50) i) s;
INSERT INTO probe_entities
  SELECT gen_random_uuid(),
         ('00000000-0000-4000-8000-' || lpad(to_hex(1 + (i % 50)), 12, '0'))::uuid, 'e' || i,
         now() - (i || ' seconds')::interval
  FROM generate_series(1, 50000) i;
ANALYZE probe_entities;
ANALYZE probe_graph_members;

CREATE FUNCTION probe_current_graph_id() RETURNS uuid
  LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $$
  SELECT (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'graph')::uuid
$$;
CREATE FUNCTION probe_actor_reads() RETURNS boolean
  LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $$
  SELECT EXISTS (SELECT 1 FROM public.probe_graph_members m
                 WHERE m.graph_id = public.probe_current_graph_id()
                   AND m.account_id = auth.uid() AND m.revoked_at IS NULL)
$$;
ALTER TABLE probe_entities ENABLE ROW LEVEL SECURITY;
ALTER TABLE probe_entities FORCE ROW LEVEL SECURITY;
ALTER TABLE probe_graph_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE probe_graph_members FORCE ROW LEVEL SECURITY;
-- РОВНО форма миграции 0021: по ОДНОЙ политике на команду (РП-10). Проба гоняет ТОЛЬКО эту форму и
-- ни с чем её не сравнивает: чем плоха пара «FOR SELECT + FOR ALL», сказано в 0021 и проверено
-- мутацией ревью Г-0 (Ф-Г-28) — портится план UPDATE, а не SELECT.
CREATE POLICY probe_select ON probe_entities FOR SELECT TO authenticated
  USING (graph_id = (SELECT public.probe_current_graph_id()) AND (SELECT public.probe_actor_reads()));
CREATE POLICY probe_insert ON probe_entities FOR INSERT TO authenticated
  WITH CHECK (graph_id = (SELECT public.probe_current_graph_id()) AND (SELECT public.probe_actor_reads()));
CREATE POLICY probe_update ON probe_entities FOR UPDATE TO authenticated
  USING (graph_id = (SELECT public.probe_current_graph_id()) AND (SELECT public.probe_actor_reads()))
  WITH CHECK (graph_id = (SELECT public.probe_current_graph_id()) AND (SELECT public.probe_actor_reads()));
CREATE POLICY probe_delete ON probe_entities FOR DELETE TO authenticated
  USING (graph_id = (SELECT public.probe_current_graph_id()) AND (SELECT public.probe_actor_reads()));
CREATE POLICY probe_member ON probe_graph_members FOR SELECT
  USING (account_id = (SELECT auth.uid()));
GRANT SELECT, INSERT, UPDATE, DELETE ON probe_entities TO authenticated;
GRANT SELECT ON probe_graph_members TO authenticated;

-- (1) актор 01 в своём графе 01
SELECT set_config('request.jwt.claims',
  '{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated","graph":"00000000-0000-4000-8000-000000000001"}', true);
SET LOCAL ROLE authenticated;
\echo '--- (1) свой граф: ожидание 1000'
SELECT count(*) AS visible FROM probe_entities;
EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF) SELECT count(*) FROM probe_entities;
EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF) SELECT title FROM probe_entities ORDER BY updated_at DESC LIMIT 50;
EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF) UPDATE probe_entities SET title = 'x' WHERE title = 'e77';
-- (2) текущий граф не выставлен — fail-closed
SELECT set_config('request.jwt.claims',
  '{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
\echo '--- (2) без текущего графа: ожидание 0'
SELECT count(*) AS visible FROM probe_entities;
-- (3) чужой граф без гранта
SELECT set_config('request.jwt.claims',
  '{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated","graph":"00000000-0000-4000-8000-000000000002"}', true);
\echo '--- (3) чужой граф без гранта: ожидание 0'
SELECT count(*) AS visible FROM probe_entities;
EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF) SELECT count(*) FROM probe_entities;
RESET ROLE;
ROLLBACK;
```
  Прогон (DSN — из `.env` worktree; значение в `.env` без кавычек):
```
cd /Users/birzhan/projects/orbis/.claude/worktrees/graph-ownership-g && psql "$(grep '^DATABASE_URL_ADMIN=' apps/server/.env | cut -d= -f2-)" -v ON_ERROR_STOP=1 -f /Users/birzhan/projects/orbis/.superpowers/sdd/2026-09-20-graph-ownership/probe-rls-plan.sql 2>&1 | tee /Users/birzhan/projects/orbis/.superpowers/sdd/2026-09-20-graph-ownership/probe-rls-plan.log
```
  Ожидание: счётчики `1000` / `0` / `0`; в планах (1) — ровно ДВА узла `InitPlan` с `loops=1` (у UPDATE допустимы четыре:
  политики SELECT и UPDATE соединяются через AND); у `count(*)` — доступ через `probe_entities_graph_updated`, а не `Seq Scan`
  по всем 50 000 строк; у `ORDER BY updated_at DESC LIMIT 50` — `Index Scan` по тому же индексу с `graph_id` в **`Index Cond`**
  и без узла `Sort`; в плане (3) — ноль строк на выходе. **Гейтового `One-Time Filter` / `never executed` у скана
  под RLS не ждать** (правка 21.09 по гейт-ревью Г-0, Ф-Г-28): security-qual политики планировщик Postgres
  НИКОГДА не поднимает в one-time гейт (`initsplan.c`, `process_security_barrier_quals` прижимает Var-free qual к
  отношению) — запрос в чужой граф всегда платит сканом по строкам чужого графа и отдаёт ноль. Это свойство RLS, а
  не форма политики: «чинить» его переписыванием политик бесполезно. **СТОП и доклад владельцу до Г-1**, если вместо `InitPlan`
  стоит `SubPlan` (подзапрос на каждую строку), вызов функции попал в построчный `Filter`, либо у упорядоченного чтения
  `graph_id` ушёл из `Index Cond` в `Filter`/`BitmapOr` + `Sort`: это опровергает несущее утверждение §3.6 («проверка гранта
  исполняется один раз на запрос») либо форму политик РП-10, на них стоят Г-2…Г-4. `Seq Scan` у `count(*)` при `InitPlan` —
  не СТОП, а запись в `facts.md`: на корпусе 2 % планировщик вправе выбрать что угодно, решает Г-4 на перфе.

- [ ] **Шаг 12: записать базовую линию в леджер.** В `progress.md` — запись «### Задача Г-0 закрыта (дата, время),
  main@до Г = `<хеш docs-коммита>`»: хеш коммита, база ветки, EXIT'ы и счётчики всех прогонов шагов 7–10, семь медиан,
  вердикты `explain` дословно, числа сева реестров, вердикт пробы. В `facts.md`, раздел «Факты исполнения»:
  - **Ф-Г-22. Базовая линия среза** — фактические числа шагов 8–10 плюс `plan(97)`; ориентир Б-1 назван ориентиром.
  - **Ф-Г-23. Проба планов** — три счётчика, наличие `InitPlan`, вид доступа к таблице, вывод «§3.6 держится / СТОП».
  - **Ф-Г-24. Автодеплой:** дата, id деплоя, ответ `get_service` (`autoDeploy: "no"`); перечитывать перед каждым мержем.
  - **Ф-Г-25. Операционка:** `cd` первой командой в каждом вызове Bash; голый `bun test` зависает; серверные сьюты — один
    прогон за раз; корневой `.env` обязателен; `test`/`test:perf`/`test:rls` — разными вызовами; прямой порт локального
    Postgres — 54322.

- [ ] **Шаг 13: `orchestrator-prompt.md` — экземпляр шаблона: сверить.** Экземпляр УЖЕ лежит в леджере (заведён
  планировщиком 20.09 по `docs/superpowers/templates/orchestrator-prompt.md`; шаблон в `docs/` НЕ править) — им и запущена
  сессия исполнения. Сверить: `grep -c '{{' /Users/birzhan/projects/orbis/.superpowers/sdd/2026-09-20-graph-ownership/orchestrator-prompt.md`
  → 0 (незаполненных плейсхолдеров нет); первая задача — Г-0; вопросы В-ПГ-1…В-ПГ-3 перечислены с умолчаниями; контрольная
  задача учёта ревью — Г-2; жёсткая остановка — после шага 8 Г-5 (прод-процедура и приёмка живьём — отдельным словом
  владельца); модели — оркестратор и имплементеры Opus 5, гейт задачи и финал ветки Fable 5.1, ниже Opus 5 никогда; план и
  спека читаются из основного дерева, код — из worktree. Дописать в экземпляр хеш docs-коммита шага 3 («main@до Г»).

- [ ] **Шаг 14: `make-brief.sh` и `make-review-pack.sh` — копии из леджера Б-1 с правкой путей.** Оба скрипта ищут
  разделы плана ПО ЗАГОЛОВКАМ (`^### Задача N:`, `^## Глобальные ограничения`, `^## Вехи и прогоняемые проверки`,
  `^## Самопроверка плана`) — заголовки этого плана им соответствуют; `N` передаётся как `Г-1`.
```
cd /Users/birzhan/projects/orbis && cp .superpowers/sdd/2026-09-02-properties-reform-b1/make-brief.sh .superpowers/sdd/2026-09-20-graph-ownership/make-brief.sh
cd /Users/birzhan/projects/orbis && cp .superpowers/sdd/2026-09-02-properties-reform-b1/make-review-pack.sh .superpowers/sdd/2026-09-20-graph-ownership/make-review-pack.sh
cd /Users/birzhan/projects/orbis && chmod +x .superpowers/sdd/2026-09-20-graph-ownership/make-brief.sh .superpowers/sdd/2026-09-20-graph-ownership/make-review-pack.sh
```
  `make-brief.sh`: `:2` → `# Извлекает текст Задачи N из плана среза Г в самодостаточный бриф (+ глобальные ограничения).` ·
  `:6` → `PLAN=/Users/birzhan/projects/orbis/docs/superpowers/plans/2026-09-20-graph-ownership-g.md` (ОСНОВНОЕ дерево, Ф-Г-4) ·
  `:7` → `LED=/Users/birzhan/projects/orbis/.superpowers/sdd/2026-09-20-graph-ownership` ·
  `:14` → `  echo "# Бриф — Задача $N (план docs/superpowers/plans/2026-09-20-graph-ownership-g.md, строки $START-$END)"`.
  `make-review-pack.sh`: `:2` → `# Сборка ревью-пакета по протоколу оркестратора (срез «Г — единица владения»).` ·
  `:9` → `WT=/Users/birzhan/projects/orbis/.claude/worktrees/graph-ownership-g` · `:10` → `LED=…/2026-09-20-graph-ownership` ·
  `:11` → `PLAN=/Users/birzhan/projects/orbis/docs/superpowers/plans/2026-09-20-graph-ownership-g.md` ·
  `:27` → ``  echo "Ветка \`graph-ownership-g\`, worktree \`$WT\` (файлы читай ТАМ; план и спека — в основном дереве)."`` ·
  `:45` → `  echo "### Строки маппинга спеки §3/§5/§8.1, упоминающие задачу $N"`.
  Проверка вхолостую:
```
cd /Users/birzhan/projects/orbis && .superpowers/sdd/2026-09-20-graph-ownership/make-brief.sh Г-1 && head -8 .superpowers/sdd/2026-09-20-graph-ownership/task-Г-1-brief.md && tail -5 .superpowers/sdd/2026-09-20-graph-ownership/task-Г-1-brief.md
```
  Ожидание: печатается `BRIEF=… (N строк)`, в начале брифа — заголовок «### Задача Г-1», в хвосте — раздел «Глобальные
  ограничения» целиком и без чужих строк.

- [ ] **Шаг 15: коммитов в ветке нет, доклад координатору.**
```
cd /Users/birzhan/projects/orbis/.claude/worktrees/graph-ownership-g && git status --short && git log --oneline origin/main..HEAD
```
  Ожидание: обе команды печатают пусто. Отчёт `task-Г-0-report.md` в леджере: хеш коммита `main`, база ветки, ответ
  `get_service`, EXIT'ы и счётчики всех прогонов, семь медиан, вердикты `explain`, вывод пробы, список созданных файлов
  леджера, расхождения с ожиданиями и рулинги, если пришлось решать.

### Задача Г-1: Переименование с классификацией — `owner_id → graph_id`, `ownerId → graphId | accountId` (Ш-1а)

**Зачем:** ключ строк перестаёт называться словом `owner` (спека §3.4, Р-Г-6): в схеме, коде, проводе, тестах, pgTAP и
golden. Это самая широкая правка среза (2 167 строк в 204 файлах, Ф-Г-11) и самая опасная по смыслу: ~1,5 % сайтов
называются `ownerId`, а значат аккаунт, и слепая замена зашила бы неверный смысл молча. Поэтому порядок — «руками класс
„аккаунт“ → механическая замена остатка → чтение докблоков → доказательство нулевого поведения». **Один коммит,
поведение нулевое** (спека Ш-1а): ни одного нового теста, счётчики равны базовой линии Г-0.

**Файлы:**
- Создать: `apps/server/src/db/migrations/0019_graph_key_rename.sql` (рукописный), `meta/0019_snapshot.json`
  (сгенерированный), запись в `meta/_journal.json` (генератором); леджер: `drizzle-rename.exp`, `rename-ledger.md`.
- Изменить: `scripts/check-legacy-form.ts` (маркер `owner-key`), `scripts/check-legacy-form.test.ts` (образец и имя маркера);
  `apps/server/src/db/schema.ts` (15 колонок, 2 имени индексов, докблок `:27-28`); `apps/web/src/features/entity-editor/
  {draft-storage.ts:64-80, useBodySave.ts:26,100,225-229}`, `apps/web/src/auth/AuthProvider.tsx:26-29`; все файлы pathspec гейта
  с `owner_id`/`ownerId` (204); `apps/server/perf/volume.test.ts:418,437,815,824,885` и `perf/explain.test.ts:33` (имя индекса); `apps/server/test/golden/{query-sql,surfaces}.json`; `apps/server/test/surfaces.ts:335`;
  `apps/server/test/rls/rls.pgtap.sql` (89 вхождений).
- НЕ трогать: применённые миграции `0000…0018` и 14 снимков `meta/*_snapshot.json`; `spikes/**`; `docs/**` (живые доки — Г-5);
  `apps/server/test/golden/tool-registry.json` и `apps/server/src/llm/prompts/*.fixture.txt` (байт-в-байт); роль
  (`actorKind: 'owner'`, `ownerOnlyProcedure`, `ownerCaller`, `ownerOnly`, литерал `'owner'`); `$owner` языка E
  (`packages/shared/src/expr/ast.ts:70`); значения реестра `owner_default_if_absent`/`owner_default_only`
  (`packages/shared/src/registry/subscription-type.ts:55`); составные без `Id` и голое `owner` (РП-6); `GRAPH_TABLES`
  (его переименовывает Г-2); имена пяти политик (`owner_owns_*`, `scheduler_reads_owner_list`) — их сносит Г-4.

**Интерфейсы:**

*Consumes:* базовая линия Г-0 (`progress.md`: счётчики сьютов, `plan(97)`, ширина `2167/204`) · `recon-3-rename-surface.md`
(корзины идентификаторов §2, класс «аккаунт» §3, провод §4, golden §5) · `recon-1-db-rls.md` §2, §6, §8.
```
scripts/check-legacy-form.ts:67-76    SEARCH_PATHSPEC (pathspec гейта — уже тот, что нужен)
scripts/check-legacy-form.ts:111      LEGACY_MARKERS: ReadonlyArray<LegacyMarker>  ({ id, pattern, exclude? })
scripts/check-legacy-form.ts:347-355  ALLOWLIST уже снимает сам гейт и его тест по ВСЕМ маркерам
scripts/check-legacy-form.test.ts:247 SAMPLES (образец на маркер, порядок = порядку маркеров) · :415 пин имён маркеров
apps/server/src/db/migrations/0015_entities_props.sql:20,23  прецедент RENAME COLUMN + ALTER INDEX … RENAME
apps/web/src/auth/AuthProvider.tsx:29  setRetryScope(session.userId)  — образец скоупа «по аккаунту сессии»
packages/shared/src/schemas/entity.ts:5  ownerId: z.string().uuid()   — ключ провода
apps/server/src/wire.ts:119              ownerId: row.owner_id        — единственный стык snake→camel
apps/server/src/query/compile-ast.ts:110 ENTITY_SELECT_COLUMNS = 'id, owner_id, title, …' (страж compile-ast.test.ts:607)
```

*Produces* (на это опираются Г-2…Г-5):
```
колонка  graph_id  на 15 таблицах (§3.4); drizzle-поле graphId: uuid('graph_id')
индексы  entities_graph_updated · chat_threads_graph · agent_grants_graph · envelope_spent_cache_graph
PK       ai_usage_graph_id_date_model_pk
провод   entity.graphId, WireThread.graphId, WireUserSettings.graphId; ключ дампа экспорта graphId
функция  graphIdsForScheduler(db: Db): Promise<string[]>        (была ownerIdsForScheduler; Г-3 заменит на identitiesForScheduler)
веб      setDraftScope(accountId: string): void — зовёт AuthProvider, не useBodySave
гейт     маркер 'owner-key' (pattern '[oO]wner_?[Ii]d') в LEGACY_MARKERS — НОЛЬ навсегда
леджер   rename-ledger.md — классификация «граф / аккаунт / роль / стык» + список непереименованных составных
```

- [ ] **Шаг 1: красный гейт — маркер `owner-key`.** В `scripts/check-legacy-form.ts` дописать В КОНЕЦ `LEGACY_MARKERS`:
```ts
  // owner-key — ключ строк больше не называется словом `owner` (срез «Г — единица владения», D44,
  // спека §3.4): колонка — `graph_id`, поле — `graphId`, а где по смыслу аккаунт — `accountId`.
  // Исключения `COMMENT_ONLY_LINE` НЕТ намеренно: докблок, называющий ключ старым именем, после
  // переименования — ложь, а не история; история живёт в применённых миграциях (они вне pathspec).
  // Роль «владелец» (`actorKind: 'owner'`, `ownerOnlyProcedure`, `ownerCaller`) маркер не ловит и
  // ловить не должен: это проверка транспорта, а не ключ строк (спека §2).
  { id: 'owner-key', pattern: String.raw`[oO]wner_?[Ii]d` },
```
  В `scripts/check-legacy-form.test.ts` дописать В КОНЕЦ `SAMPLES` (порядок обязан совпасть с маркерами, `:363`):
```ts
  {
    id: 'owner-key',
    lines: [
      'const a = row.owner_id;',
      'const b = input.ownerId;',
      'const c = ownerIdsForScheduler;',
      // составного имени с заглавной `O` в дереве сегодня нет — строка пинит ветку `[oO]` паттерна
      'const d = byOwnerId;',
    ],
  },
```
  и `'owner-key',` последней строкой списка в пине имён (`:415`, после `'exclude-blocked-literal'`).
  Прогон: `cd /Users/birzhan/projects/orbis/.claude/worktrees/graph-ownership-g && bun test scripts/check-legacy-form.test.ts` → зелёный; `cd /Users/birzhan/projects/orbis/.claude/worktrees/graph-ownership-g && bun scripts/check-legacy-form.ts --gate`
  → **EXIT 1**, маркер `owner-key` — `2167 строк в 204 файлах` (± базовая линия Г-0, шаг 10). Это и есть красный тест задачи.

- [ ] **Шаг 2: инвентарь идентификаторов — в `rename-ledger.md`.**
```
cd /Users/birzhan/projects/orbis/.claude/worktrees/graph-ownership-g && git grep -ohP '[A-Za-z0-9_$]*[oO]wner[A-Za-z0-9_$]*' -- apps/server/src apps/server/test apps/server/perf packages/shared/src apps/web/src scripts ':!*.snap' ':!apps/server/src/db/migrations/**' | sort | uniq -c | sort -rn > /Users/birzhan/projects/orbis/.superpowers/sdd/2026-09-20-graph-ownership/owner-tokens.txt
```
  Завести `/Users/birzhan/projects/orbis/.superpowers/sdd/2026-09-20-graph-ownership/rename-ledger.md` с четырьмя разделами (заполняется по ходу задачи): **(а) роль — остаётся**
  (`ownerCaller`, `ownerOnlyProcedure`, `ownerOnly`, литерал `'owner'`); **(б) содержит `OwnerId(s)` — переименовано** (на `877e13a`
  токенов под `[oO]wner_?[Ii]d` ровно три: `ownerId` — 1 741, `owner_id` — 627, `ownerIdsForScheduler` — 7; появившийся
  четвёртый — записать с новым именем); **(в) составные «на граф»
  без `Id` — НЕ переименованы, список для владельца** (`ownerVersion`, `bumpOwnerRegistryVersion`, `seedOwnerGraph`,
  `ownerTimeZone`, `ownerSets`, `lockOwnerRegistry`, `lockOwnerBudget`, `seedOwnerWorld`, `ownerCategories`, `ownerVersionMax`,
  `invalidateSpentCacheOfOwner`, SQL-алиасы `owner_version`/`owner_version_max`/`owner_definitions`, локальные `*Owner` тестов,
  голое `owner`); **(г) класс «аккаунт» и стыки** — таблица «сайт → граф | аккаунт | стык → обоснование в одну строку».

- [ ] **Шаг 3: РУКАМИ — класс «по смыслу аккаунт» (спека §3.4, строка 2 таблицы правил).** Единственный шов — скоуп
  черновиков веба; образец — retry-буфер, который уже скоупится от сессии (`AuthProvider.tsx:29` `setRetryScope(session.userId)` →
  `state/retry.ts:22` → `lib/retry-buffer/storage.ts:46` `setQueueScope(userId)`; `session.userId` — `string | null`). `apps/web/src/features/entity-editor/draft-storage.ts`
  — докблок `:64-75`, переменная `:76` и функция `:78-80`:
```ts
/**
 * Аккаунт, которому принадлежат черновики этой сессии.
 *
 * Скоуп — тот же приём и по той же причине, что у retry-буфера (`lib/retry-buffer/storage.ts`):
 * браузер бывает общим, и следующий залогинившийся аккаунт не должен видеть неотправленные
 * заметки предыдущего. Пустая строка — «аккаунт ещё не известен»; ветки на это нет намеренно,
 * она просто даёт свой, отдельный от всех аккаунтов ключ.
 *
 * Скоуп ставит `AuthProvider` из сессии (`session.userId`), рядом с `setRetryScope`. Из записи
 * (`entity.graphId`) его брать нельзя: ключ записи — ГРАФ, а черновик принадлежит человеку за
 * этим браузером; в личном графе значения совпадают, в графе компании — нет (D44). Модуль
 * остаётся ЛИСТОВЫМ: значение по-прежнему приходит параметром, рантайм-зависимостей нет.
 */
let scope = '';

export function setDraftScope(accountId: string): void {
  scope = accountId;
}
```
  `apps/web/src/auth/AuthProvider.tsx` — после `setRetryScope(session.userId);` (`:29`) добавить вызов и импорт:
```ts
import { setDraftScope } from '../features/entity-editor/draft-storage';
…
  // Скоуп черновиков — по тому же аккаунту сессии и по той же причине (общий браузер).
  setDraftScope(session.userId ?? '');
```
  `apps/web/src/features/entity-editor/useBodySave.ts`: снять вызов `setDraftScope(entity.ownerId)` (`:229`) вместе с его
  четырёхстрочным комментарием (`:225-228`) и импортом (`:26`); поле типа `BodySaveEntity` (`:100`) — если после снятия вызова
  его никто не читает, снять и поле, иначе оно станет `graphId` шагом 4. Тесты `draft.test.tsx` (12 строк) ставили скоуп
  через `entity.ownerId` фикстуры — теперь ставят его явным `setDraftScope('<id>')` в подготовке; тест изоляции двух
  аккаунтов переключает скоуп тем же вызовом. **Новых тестов не добавлять** (счётчик web обязан сойтись с Г-0).
  Файлов, зависящих от скоупа, ТРИ, а не один (правка 21.09 по исполнению Г-1, Ф-Г-31): кроме `draft.test.tsx` —
  `apps/web/src/features/entity-detail/detail.test.tsx` (тоже сеет черновик ключом от `entity.ownerId` фикстуры;
  без правки даёт 16 красных тестов веба) и `useBodySave`-фикстуры `save.test.tsx` (типизированы `BodySaveEntity`
  и не компилируются после снятия поля). Искать их надо не по списку, а грепом:
  `git grep -ln 'setDraftScope\|draft-storage' -- apps/web/src`.
  Прогон: `cd /Users/birzhan/projects/orbis/.claude/worktrees/graph-ownership-g/apps/web && bunx vitest run src/features/entity-editor` → зелёный. В `rename-ledger.md`, раздел (г):
  `draft-storage.ts:78` — аккаунт; `lib/retry-buffer/storage.ts:46` — аккаунт, уже `userId`, не правится;
  `features/import/namespace.ts:2-3` — комментарий про ключ `(owner_id, namespace, external_id)` таблицы `entity_origins`:
  ключ ГРАФОВЫЙ, `ownerId` в файле нет — не класс «аккаунт» (эррата Э-7).

- [ ] **Шаг 4: МЕХАНИЧЕСКИ — остаток, три замены.** Pathspec — тот же, что у гейта; миграции исключены им же.
```
cd /Users/birzhan/projects/orbis/.claude/worktrees/graph-ownership-g && git grep -alP '[oO]wner_?[Ii]d' -- apps/server/src apps/server/test apps/server/perf packages/shared/src apps/web/src scripts ':!*.snap' ':!apps/server/src/db/migrations/**' ':!scripts/check-legacy-form.ts' ':!scripts/check-legacy-form.test.ts' > /Users/birzhan/projects/orbis/.superpowers/sdd/2026-09-20-graph-ownership/g1-files.txt && wc -l /Users/birzhan/projects/orbis/.superpowers/sdd/2026-09-20-graph-ownership/g1-files.txt
cd /Users/birzhan/projects/orbis/.claude/worktrees/graph-ownership-g && xargs perl -pi -e 's/\bownerIdsForScheduler\b/graphIdsForScheduler/g; s/\bownerId\b/graphId/g; s/\bowner_id\b/graph_id/g' < /Users/birzhan/projects/orbis/.superpowers/sdd/2026-09-20-graph-ownership/g1-files.txt
cd /Users/birzhan/projects/orbis/.claude/worktrees/graph-ownership-g && bun scripts/check-legacy-form.ts | grep -A3 owner-key
```
  Остатка после трёх замен быть не должно (токенов три; маска golden `<ownerId>` берётся заменой `\bownerId\b`); появился —
  переименовать по тому же правилу (`…GraphId`) и записать в леджер. **Стыки актор↔граф
  переименовываются вместе со всеми и помечаются в разделе (г) как «стык, чинит Г-3»**, поведение не меняется:
  `apps/server/src/context.ts:37` (`actorUserId: identity?.graphId ?? null`), `apps/server/src/mcp/server.ts:51,102`, пять вызовов
  резолвера entitlements (`tools/dispatch.ts:637,2021`, `executor/executor.ts:992`, `routines/lifecycle.ts:879`,
  `mcp/server.ts:96,151-153`), три заполнения `CompileCtx` (`query/context.ts:66-70`, `executor/executor.ts:263-268`,
  `recurring/with-materialization.ts:50`), владелец сообщения журнала (`executor/executor.ts:719,1016`).
  Ожидание последней команды: `owner-key` — 0 строк.

- [ ] **Шаг 5: golden — заменой имени в файле, не пересдачей (Ф-Г-12).** Шаг 4 уже заменил имя в
  `apps/server/test/golden/query-sql.json` (54 вхождения `owner_id` в скомпилированном SQL) и `surfaces.json` (18: ключ
  `"graphId"` и маска `"<graphId>"`), а `apps/server/test/surfaces.ts:335` — в `MASKED_KEYS`. Привести файлы к форме biome и
  доказать, что дифф — одно имя:
```
cd /Users/birzhan/projects/orbis/.claude/worktrees/graph-ownership-g && bunx biome check --write apps/server/test/golden/query-sql.json apps/server/test/golden/surfaces.json
cd /Users/birzhan/projects/orbis/.claude/worktrees/graph-ownership-g && for f in apps/server/test/golden/query-sql.json apps/server/test/golden/surfaces.json; do diff <(git diff -U0 -- $f | grep -vE '^--- (a/|/dev/null)' | sed -n 's/^-//p' | sed 's/owner_id/graph_id/g; s/ownerId/graphId/g') <(git diff -U0 -- $f | grep -vE '^\+\+\+ (b/|/dev/null)' | sed -n 's/^+//p') && echo "$f: только имя"; done
cd /Users/birzhan/projects/orbis/.claude/worktrees/graph-ownership-g && git diff --stat -- apps/server/test/golden/tool-registry.json 'apps/server/src/llm/prompts/*.fixture.txt'
```
  Ожидание: обе строки «только имя»; третья команда печатает ПУСТО (поверхность модели не тронута, Ф-Г-13).

- [ ] **Шаг 6: `db/schema.ts` — имена индексов и докблок.** После шага 4 все 15 колонок уже `graphId: uuid('graph_id')`
  (`grep -c "graphId: uuid('graph_id')" apps/server/src/db/schema.ts` → **15**). Руками: `index('agent_grants_owner')` →
  `index('agent_grants_graph')` (`:348`), `index('envelope_spent_cache_owner')` → `index('envelope_spent_cache_graph')` (`:616`);
  докблок `:27-28` переписать:
```ts
// graph_id — ключ владения и изоляции (D44): строка принадлежит ГРАФУ. У личного графа id равен id
// аккаунта Supabase по построению (CHECK таблицы graphs, срез Г-2). FK на auth-схему не объявляем —
// она управляется Supabase, а не нашими миграциями; FK на graphs.id приезжает миграцией 0020.
```
  Читатели имени индекса `entities_owner_updated` — на `entities_graph_updated` (полный список — `git grep -n
  entities_owner_updated -- apps packages scripts`): три докблока (`agent-loop/queries.ts:251`, `routers/entity.ts:356`,
  `memory/select.ts:42`), докблоки `perf/volume.test.ts:418,437,815` и `perf/explain.test.ts:33`, и **два строковых литерала
  `perf/volume.test.ts:824` (аргумент `verdictFor`) и `:885` (пин сводки)** — без них `test:perf:volume` после `0019` красный,
  а сьют этот вне CI (Ф-Г-19). Замену `\bowner_id\b` эти имена не ловят.

- [ ] **Шаг 7: снимок `0019` — генератором, SQL — руками (Ф-Г-18).** Создать `/Users/birzhan/projects/orbis/.superpowers/sdd/2026-09-20-graph-ownership/drizzle-rename.exp` (`chmod +x`):
```tcl
#!/usr/bin/expect -f
# Отвечает «переименована» (вторая строка списка) на каждый вопрос drizzle-kit о КОЛОНКЕ.
# Прежняя обёртка (.superpowers/sdd/2026-08-26-properties-reform-a/drizzle-generate.exp) отвечает
# «create column» — для переименования она непригодна (Ф-Г-18).
#
# ОДИН ОТВЕТ НА ВОПРОС, И ЭТО НЕ СТИЛЬ (правка 21.09 по исполнению Г-1, Ф-Г-30). Список drizzle-kit
# ПЕРЕРИСОВЫВАЕТ себя после каждой нажатой стрелки, и текст вопроса печатается заново. Плоский
# `exp_continue` на образец вопроса отвечает и на перерисовку тоже: второй «вниз» в списке из двух
# строк возвращает выбор на «create column», и таблица молча уезжает в DROP+ADD — в первом прогоне
# Г-1 так ответились `agent_grants` и `contract_definitions` (13 renamed / 2 created) ПРИ EXIT 0.
# Поэтому после отправки клавиш обёртка ЖДЁТ ВЕРДИКТ по колонке и только потом слушает следующий
# вопрос, а вердикт «created» останавливает прогон кодом 4 — вместо тихо неверного снимка.
set timeout 180
cd /Users/birzhan/projects/orbis/.claude/worktrees/graph-ownership-g/apps/server
spawn bunx drizzle-kit generate --name graph_key_rename
set running 1
while {$running} {
  expect {
    -re {(schema|policy|role|enum|sequence|view) created or renamed} { puts "\nНЕОЖИДАННЫЙ ВОПРОС"; exit 3 }
    -re {column in [^\n]* table created or renamed} {
      send "\033\[B\r"
      expect {
        -re {column will be renamed} { }
        -re {column will be created} { puts "\nОТВЕТ УШЁЛ В create column"; exit 4 }
        timeout { puts "TIMEOUT"; exit 2 }
      }
    }
    eof { set running 0 }
    timeout { puts "TIMEOUT"; exit 2 }
  }
}
catch wait result
exit [lindex $result 3]
```
```
cd /Users/birzhan/projects/orbis/.claude/worktrees/graph-ownership-g && /Users/birzhan/projects/orbis/.superpowers/sdd/2026-09-20-graph-ownership/drizzle-rename.exp 2>&1 | tee /Users/birzhan/projects/orbis/.superpowers/sdd/2026-09-20-graph-ownership/drizzle-rename.log
cd /Users/birzhan/projects/orbis/.claude/worktrees/graph-ownership-g && ls apps/server/src/db/migrations/0019_graph_key_rename.sql apps/server/src/db/migrations/meta/0019_snapshot.json && tail -8 apps/server/src/db/migrations/meta/_journal.json
cd /Users/birzhan/projects/orbis/.claude/worktrees/graph-ownership-g && grep -c '"owner_id"' apps/server/src/db/migrations/meta/0019_snapshot.json; grep -c '"graph_id"' apps/server/src/db/migrations/meta/0019_snapshot.json
```
  Ожидание: файл и снимок созданы, в журнале запись `idx: 19, tag: "0019_graph_key_rename"`; в снимке `"owner_id"` — **0**,
  `"graph_id"` > 0. Число заданных вопросов записать в `facts.md` (спека §10.2: «никем не запускалось»). Ответы влияют на
  сгенерированный SQL (он следующим действием заменяется целиком) и на служебный раздел снимка `_meta.columns` (туда
  пишутся пары «старое → новое имя»; на сверку схемы он не влияет) — проверить, что в сгенерированном тексте стоят
  `RENAME COLUMN`, а не `DROP`/`ADD`: это признак ответа «переименована»; EXIT 2/3 обёртки →
  удалить созданные `0019_*` и запись журнала, разобрать лог, повторить; не вышло дважды — СТОП и доклад.
  **Заменить содержимое `0019_graph_key_rename.sql` целиком** (сгенерированный текст даёт DROP/CREATE и не знает индексов,
  созданных прямо в `0001`):
```sql
-- 0019_graph_key_rename.sql — срез «Г — единица владения» (D44), задача Г-1.
-- Файл РУКОПИСНЫЙ, снимок meta/0019_snapshot.json — сгенерированный (образец и довод —
-- 0015_entities_props.sql:3-10, 0018_spent_cache_modules.sql:3-5): drizzle-kit выражает
-- переименование колонки как DROP + ADD и не знает индексов, созданных прямо в 0001.
--
-- Ключ строк перестаёт называться словом owner: строка принадлежит ГРАФУ, а не аккаунту (спека
-- 2026-09-19-graph-ownership-unit-design §3.4). Значения не меняются: id личного графа равен id
-- аккаунта по построению. Выражения 35 политик RLS и 17 partial-предикатов индексов Postgres
-- переписывает сам (хранятся деревом, прецедент 0015:20,23) — политик и грантов здесь нет
-- намеренно, новый предикат приезжает миграцией 0021.
ALTER TABLE "entities" RENAME COLUMN "owner_id" TO "graph_id";
--> statement-breakpoint
ALTER TABLE "chat_threads" RENAME COLUMN "owner_id" TO "graph_id";
--> statement-breakpoint
ALTER TABLE "entity_versions" RENAME COLUMN "owner_id" TO "graph_id";
--> statement-breakpoint
ALTER TABLE "entity_origins" RENAME COLUMN "owner_id" TO "graph_id";
--> statement-breakpoint
ALTER TABLE "ai_usage" RENAME COLUMN "owner_id" TO "graph_id";
--> statement-breakpoint
ALTER TABLE "user_settings" RENAME COLUMN "owner_id" TO "graph_id";
--> statement-breakpoint
ALTER TABLE "agent_grants" RENAME COLUMN "owner_id" TO "graph_id";
--> statement-breakpoint
ALTER TABLE "envelope_spent_cache" RENAME COLUMN "owner_id" TO "graph_id";
--> statement-breakpoint
ALTER TABLE "registry_deltas" RENAME COLUMN "owner_id" TO "graph_id";
--> statement-breakpoint
ALTER TABLE "property_definitions" RENAME COLUMN "owner_id" TO "graph_id";
--> statement-breakpoint
ALTER TABLE "aspect_definitions" RENAME COLUMN "owner_id" TO "graph_id";
--> statement-breakpoint
ALTER TABLE "relation_role_definitions" RENAME COLUMN "owner_id" TO "graph_id";
--> statement-breakpoint
ALTER TABLE "contract_definitions" RENAME COLUMN "owner_id" TO "graph_id";
--> statement-breakpoint
ALTER TABLE "subscription_definitions" RENAME COLUMN "owner_id" TO "graph_id";
--> statement-breakpoint
ALTER TABLE "action_definitions" RENAME COLUMN "owner_id" TO "graph_id";
--> statement-breakpoint
-- Имена, в которых слово owner стоит само (RENAME COLUMN их не трогает). Первые два drizzle не
-- знает вовсе — они созданы прямо в 0001_rls_and_indexes.sql:112,118.
ALTER INDEX "entities_owner_updated" RENAME TO "entities_graph_updated";
--> statement-breakpoint
ALTER INDEX "chat_threads_owner" RENAME TO "chat_threads_graph";
--> statement-breakpoint
ALTER INDEX "agent_grants_owner" RENAME TO "agent_grants_graph";
--> statement-breakpoint
ALTER INDEX "envelope_spent_cache_owner" RENAME TO "envelope_spent_cache_graph";
--> statement-breakpoint
ALTER TABLE "ai_usage" RENAME CONSTRAINT "ai_usage_owner_id_date_model_pk" TO "ai_usage_graph_id_date_model_pk";
```
  Сверка «снимок = схема» — повторный генератор обязан не найти изменений:
```
cd /Users/birzhan/projects/orbis/.claude/worktrees/graph-ownership-g/apps/server && bunx drizzle-kit generate --name should_be_empty 2>&1 | tail -3
```
  Ожидание: `No schema changes, nothing to migrate`. Любой созданный файл `0020_should_be_empty*` — расхождение схемы и
  снимка: удалить его и запись журнала, найти причину (чаще всего — имя индекса в `schema.ts` против имени в снимке).

- [ ] **Шаг 8: база с нуля и pgTAP.**
```
cd /Users/birzhan/projects/orbis/.claude/worktrees/graph-ownership-g && bunx supabase db reset && bun run db:prepare
```
  Ожидание: EXIT=0, накат `0000…0019`, сид реестров — те же числа, что в Г-0, `test:rls` — `plan(97)` без «Looks like you
  planned» (файл pgTAP переименован шагом 4: `grep -c owner_id apps/server/test/rls/rls.pgtap.sql` → 0; `plan(97)` не двигается).

- [ ] **Шаг 9: докблоки — ПРОЧИТАТЬ, а не только переименовать.** Замена в комментарии верна по форме, но часть докблоков
  объясняет смысл «владельца» и после замены лжёт. Список строк с кириллицей, тронутых заменой:
```
cd /Users/birzhan/projects/orbis/.claude/worktrees/graph-ownership-g && git diff -U0 | grep -v '^+++' | grep '^+' | grep -E 'graphId|graph_id' | grep -E '[А-Яа-яЁё]' > /Users/birzhan/projects/orbis/.superpowers/sdd/2026-09-20-graph-ownership/g1-docblocks.txt; wc -l /Users/birzhan/projects/orbis/.superpowers/sdd/2026-09-20-graph-ownership/g1-docblocks.txt
```
  (`grep -P` не использовать: у BSD grep на macOS его нет.) Ориентир — 77 строк (`recon-3` §9.2). Каждую прочитать; переписать те, где фраза после замены неверна. Обязательные:
  `apps/server/src/wire.ts:49` («это владелец вызова» → «это текущий граф вызова»), `apps/server/src/query/compile-ast.ts:77-80`
  (поле называет граф, под которым снят снимок реестра), `apps/web/src/features/chat/useEnsuredThread.tsx:23,28-31`,
  `apps/server/src/chat/threads.ts:26-27` («Недостижимо при identity == graphId» — верно только для личного графа),
  `packages/shared/src/ids.ts:2` («Формулы с `graph_id` — на ключе графа (D44)»), `apps/server/src/goals/progress.ts:342`.
  Слова — по §2 спеки: «граф», «аккаунт», «актор», «держатель гранта»; «владелец» в прозе — человек, которому служит ассистент.

- [ ] **Шаг 10: форматирование, типы, линт.**
```
cd /Users/birzhan/projects/orbis/.claude/worktrees/graph-ownership-g && bunx biome check --write apps packages scripts
cd /Users/birzhan/projects/orbis/.claude/worktrees/graph-ownership-g && bun run typecheck
cd /Users/birzhan/projects/orbis/.claude/worktrees/graph-ownership-g && bun run lint
```
  Ожидание: typecheck — три пакета, EXIT=0; lint — EXIT=0. `ownerId → graphId`, `owner_id → graph_id`,
  `ownerIdsForScheduler → graphIdsForScheduler` — замены РАВНОЙ длины (7 → 7, 8 → 8, 20 → 20): biome не вправе сдвинуть ни
  один перенос, и любой хунк переформатирования вне ручных правок шагов 3, 6, 9 — дефект замены, а не шум.

- [ ] **Шаг 11: доказательство нулевого поведения — нормализованный дифф.** После замены старого имени на новое удалённые
  строки обязаны СОВПАСТЬ с добавленными; всё, что не совпало, — ручные правки задачи, и они перечисляются в отчёте.
```
cd /Users/birzhan/projects/orbis/.claude/worktrees/graph-ownership-g && diff <(git diff -U0 -- . ':!apps/server/src/db/migrations' | grep -vE '^--- (a/|/dev/null)' | sed -n 's/^-//p' | sed 's/ownerIdsForScheduler/graphIdsForScheduler/g; s/ownerId/graphId/g; s/owner_id/graph_id/g; s/entities_owner_updated/entities_graph_updated/g' | sort) <(git diff -U0 -- . ':!apps/server/src/db/migrations' | grep -vE '^\+\+\+ (b/|/dev/null)' | sed -n 's/^+//p' | sort) | grep '^[<>]' | tee /Users/birzhan/projects/orbis/.superpowers/sdd/2026-09-20-graph-ownership/g1-residual.txt | wc -l
```
  (Заголовки диффа снимаются ЦЕЛИКОМ — `^--- a/`, `^+++ b/`, `/dev/null`, — а не по второму или третьему символу: удалённый
  SQL-комментарий `-- …` в диффе выглядит как `--- …`, и фильтры `^-[^-]` или `^---` теряли бы его; таких строк с ключом в
  `rls.pgtap.sql` восемь.) Ожидание: остаток — только строки шагов 1, 3,
  6, 9 (маркер гейта, скоуп черновиков, имена двух индексов схемы, переписанные докблоки). Любая ДРУГАЯ строка в остатке —
  поведение: разобрать до коммита. Остаток целиком — `g1-residual.txt`, он идёт в отчёт.

- [ ] **Шаг 12: полный прогон и внеCI-скрипты.**
```
cd /Users/birzhan/projects/orbis/.claude/worktrees/graph-ownership-g && bun run test
cd /Users/birzhan/projects/orbis/.claude/worktrees/graph-ownership-g && bun scripts/check-legacy-form.ts --gate
cd /Users/birzhan/projects/orbis/.claude/worktrees/graph-ownership-g && bun run test:perf:volume
cd /Users/birzhan/projects/orbis/.claude/worktrees/graph-ownership-g && bun run test:perf:explain
cd /Users/birzhan/projects/orbis/.claude/worktrees/graph-ownership-g && bun run test:perf:graph
cd /Users/birzhan/projects/orbis/.claude/worktrees/graph-ownership-g && bun run --filter @orbis/web build && bun scripts/check-lazy-chunks.ts
```
  Ожидание: `bun run test` — EXIT=0, **счётчики shared / server / web (+skip) / scripts РАВНЫ базовой линии Г-0** (спека Ш-1а);
  гейт — EXIT=0 (маркер `owner-key` — ноль); три внеCI-скрипта — EXIT=0 и те же вердикты, что в Г-0 (они вне CI и ломаются
  молча — Ф-Г-19); сборка веба — EXIT=0.

- [ ] **Шаг 13: `rename-ledger.md` — закрыть.** Разделы (а)–(г) заполнены; в конце — три числа: строк до (Г-0, шаг 10),
  строк после (0), остаток нормализованного диффа шага 11 с перечнем ручных правок. Это приёмка спеки Ш-1а «классификация
  „граф или аккаунт“ записана в леджер».

- [ ] **Шаг 14: один коммит.**
```
cd /Users/birzhan/projects/orbis/.claude/worktrees/graph-ownership-g && git add -A && git status --short | head -30 && git commit -m "$(printf 'refactor(graph): ключ строк owner_id → graph_id, ownerId → graphId | accountId (срез Г, D44, Ш-1а)\n\nПоведение нулевое: строка принадлежит графу, а не аккаунту, и значения ключа не меняются — id личного\nграфа равен id аккаунта по построению. Миграция 0019 — RENAME COLUMN на 15 таблицах и пять имён\n(четыре индекса и PK ai_usage); выражения политик и partial-индексов Postgres переписывает сам.\nКласс «по смыслу аккаунт» разобран руками: скоуп черновиков веба переведён с поля записи на сессию\n(образец — retry-буфер). Golden query-sql.json и surfaces.json правлены ЗАМЕНОЙ ИМЕНИ в файле, не\nпересдачей: нормализованный дифф пуст. tool-registry.json и фикстуры промптов — байт-в-байт.\nГреп-гейт: маркер owner-key в check-legacy-form — ноль навсегда. Классификация — rename-ledger.md.\n\nCo-Authored-By: Claude Opus 5 <noreply@anthropic.com>')"
```
  `git add -A` допустим только в worktree (в основном дереве — никогда). Закрытие — протокол глобальных ограничений:
  ревью-пакет → гейт Fable → `git fetch` → rebase → push ветки → CI → ff-push в `main` (перед мержем перечитать
  `get_service → autoDeploy: "no"`).

### Задача Г-2: Таблицы `graphs` / `graph_members`, бэкфилл, FK, сид личного графа, тестовая обвязка (Ш-1б)

**Зачем:** граф становится вещью со своим владельцем в записи (спека §3.1–§3.3): появляются две таблицы, у 15 таблиц ключ
`graph_id` получает FK на `graphs.id`, а строки, уже лежащие в базе (прод НЕ пуст — §0 п. 6), получают свои графы бэкфиллом
внутри той же миграции. FK ломает всё, что создавало владельца «из воздуха»: сид (граф заводится первым шагом
`seedOwnerGraph`), 578 вызовов `freshUserId()`, фикстуры pgTAP, `truncateAll`. Задача меняет их ВМЕСТЕ с миграцией —
иначе между коммитами сьют красный. Политики, гранты и триггеры И-1 новых таблиц едут этой же миграцией (РП-4, эррата Э-2).

**Файлы:**
- Создать: `apps/server/src/db/migrations/0020_graphs_members.sql` (рукописный), `meta/0020_snapshot.json` (сгенерированный);
  `apps/server/src/seed/personal-graph.ts`; `apps/server/src/db/graphs.test.ts`; `apps/server/src/db/graphs-policies.test.ts`.
- Изменить: `apps/server/src/db/schema.ts` (две таблицы, 15 × `.references`, `agentGrants.issuedBy`);
  `apps/server/src/seed/onboarding.ts:149-156`; `apps/server/test/helpers.ts:39-67`; 85 файлов с `freshUserId(`; фикстуры с
  владельцем мимо хелпера (`test/surfaces.ts:57,64,458,459`, `src/test/graph-fixture.ts:27`, `src/test/volume-fixture.ts:35`,
  `test/seed-registries.test.ts:184,295,348,408`, `perf/perf.test.ts:352`); `apps/server/test/rls/rls.pgtap.sql`
  (фикстуры графов, группы 20–22, `plan`); `apps/server/src/db/reset-world.ts:14-18,41-63,74,87,109,119,163` и
  `reset-world.test.ts:60,326,352`; `apps/server/src/seed/onboarding.test.ts` (идемпотентность личного графа).
- НЕ трогать: `db/with-identity.ts`, `context.ts`, `oauth/grants.ts` (писатели `issued_by` — Г-3); политики 15 таблиц
  (Г-4); `apps/server/src/test/perf.ts:183` — там `await seedOwnerGraph(db, graphId)`, граф приедет сам (эррата Э-6);
  `apps/web/**`; `docs/**`.

**Интерфейсы:**

*Consumes* (Г-1): колонка `graph_id` на 15 таблицах; drizzle-поле `graphId`; `seedOwnerGraph(db, graphId, clock)`
(`seed/onboarding.ts:149`); `withIdentity(db, id, fn)` — сигнатура ЕЩЁ с одним id (пару вводит Г-3).
```
apps/server/test/helpers.ts:25 appDb() → роль orbis_app · :29 adminDb() → { db, client }, роль postgres (BYPASSRLS, не superuser)
apps/server/test/helpers.ts:50-67 truncateAll(): TRUNCATE <11 таблиц> RESTART IDENTITY CASCADE → DELETE по DEFINITION_TABLES → TRUNCATE registry_deltas
apps/server/src/db/reset-world.ts:32 export const DEFINITION_TABLES (шесть реестров) · :55 const GRAPH_TABLES (семь таблиц мира)
apps/server/src/db/migrations/0016_relations_role.sql — прецедент «DDL → DML → ужесточающий DDL» в одной миграции
apps/server/src/db/migrations/0013_routine_scheduler_rls.sql:25,35 — образец политики и гранта для orbis_app
apps/server/test/rls/rls.pgtap.sql:388-417 — группа 11: СТРУКТУРНЫЕ проверки роли orbis_app (SET ROLE из админа невозможен)
```

*Produces* (на это опираются Г-3…Г-5):
```ts
// apps/server/src/db/schema.ts
export const graphs: pgTable('graphs')        // id uuid PK · ownerKind text · ownerRef uuid NULL · createdAt
export const graphMembers: pgTable('graph_members') // id uuid PK · graphId FK→graphs · accountId uuid · grantKind text ·
                                                    // issuedAt · issuedBy uuid · revokedAt NULL
agentGrants.issuedBy: uuid('issued_by')       // NULLABLE до миграции 0021 (Р-КГ-2)
// apps/server/src/seed/personal-graph.ts
export async function ensurePersonalGraph(tx: Tx, accountId: string): Promise<void>  // идемпотентно, без RETURNING
// apps/server/test/helpers.ts
export function mintGraph(id?: string): string          // синхронно: выдаёт id личного графа и РЕГИСТРИРУЕТ его
export async function freshGraph(): Promise<string>      // mintGraph() + строки графа и гранта owner сразу
export async function ensureGraphs(ids?: Iterable<string>): Promise<void>  // доводит зарегистрированные id до базы
export async function truncateAll(): Promise<void>       // сносит всё, включая графы, и зовёт ensureGraphs()
// apps/server/src/db/reset-world.ts
export const WORLD_TABLES   // было GRAPH_TABLES; ключ отчёта `graph` → `world`
```
SQL: политики `member_reads_graph`, `person_creates_own_graph` (`graphs`); `account_reads_own_membership`,
`account_owns_personal_graph`, `scheduler_reads_members` (`graph_members`); триггеры `graphs_require_owner`,
`graph_members_keep_owner`; FK `<таблица>_graph_id_graphs_id_fk` ×16; pgTAP — `plan(125)`.

- [ ] **Шаг 1: красные тесты схемы — `apps/server/src/db/graphs.test.ts`.** Все проверки — под `adminDb()` (инварианты
  держит база, а не политика). Ошибку drizzle ловить через `e.code ?? e.cause?.code` (образец — `db/with-identity.test.ts:38-63`).
```ts
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { adminDb, mintGraph, truncateAll } from '../../test/helpers';

const pgCode = (e: unknown): string | undefined =>
  (e as { code?: string; cause?: { code?: string } }).code ??
  (e as { cause?: { code?: string } }).cause?.code;

async function codeOf(run: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await run();
    return undefined;
  } catch (e) {
    return pgCode(e);
  }
}

describe('graphs / graph_members — инварианты схемы (спека §3.1–§3.3)', () => {
  const admin = adminDb();
  beforeAll(truncateAll);
  afterAll(async () => {
    await truncateAll();
    await admin.client.end();
  });

  /** Граф с грантом owner одной транзакцией — иначе отложенный триггер И-1 откажет на коммите. */
  async function graphWithOwners(graph: string, owners: string[]): Promise<void> {
    await admin.db.transaction(async (tx) => {
      await tx.execute(
        sql`INSERT INTO graphs (id, owner_kind, owner_ref) VALUES (${graph}::uuid, 'person', ${graph}::uuid)`,
      );
      for (const account of owners) {
        await tx.execute(sql`INSERT INTO graph_members (id, graph_id, account_id, grant_kind, issued_by)
          VALUES (gen_random_uuid(), ${graph}::uuid, ${account}::uuid, 'owner', ${graph}::uuid)`);
      }
    });
  }

  test('CHECK §3.1: у личного графа id = owner_ref; NULL в owner_ref — отказ, у organization — можно', async () => {
    const id = crypto.randomUUID();
    const other = crypto.randomUUID();
    expect(
      await codeOf(() =>
        admin.db.execute(
          sql`INSERT INTO graphs (id, owner_kind, owner_ref) VALUES (${id}::uuid, 'person', ${other}::uuid)`,
        ),
      ),
    ).toBe('23514');
    expect(
      await codeOf(() =>
        admin.db.execute(sql`INSERT INTO graphs (id, owner_kind, owner_ref) VALUES (${id}::uuid, 'person', NULL)`),
      ),
    ).toBe('23514');
    expect(
      await codeOf(() =>
        admin.db.execute(sql`INSERT INTO graphs (id, owner_kind) VALUES (${id}::uuid, 'тенант')`),
      ),
    ).toBe('23514');
  });

  test('И-1: граф без действующего гранта owner не коммитится', async () => {
    const id = crypto.randomUUID();
    expect(
      await codeOf(() =>
        admin.db.execute(
          sql`INSERT INTO graphs (id, owner_kind, owner_ref) VALUES (${id}::uuid, 'person', ${id}::uuid)`,
        ),
      ),
    ).toBe('23514');
  });

  test('И-1: отзыв единственного гранта owner — отказ; при втором владельце — проходит', async () => {
    const graph = crypto.randomUUID();
    const second = crypto.randomUUID();
    await graphWithOwners(graph, [graph]);
    const revoke = (account: string) =>
      admin.db.execute(sql`UPDATE graph_members SET revoked_at = now()
        WHERE graph_id = ${graph}::uuid AND account_id = ${account}::uuid AND revoked_at IS NULL`);
    expect(await codeOf(() => revoke(graph))).toBe('23514');
    await admin.db.execute(sql`INSERT INTO graph_members (id, graph_id, account_id, grant_kind, issued_by)
      VALUES (gen_random_uuid(), ${graph}::uuid, ${second}::uuid, 'owner', ${graph}::uuid)`);
    expect(await codeOf(() => revoke(graph))).toBeUndefined();
    expect(await codeOf(() => revoke(second))).toBe('23514');
  });

  test('И-1, гонка: два параллельных отзыва двух владельцев — второй получает отказ, а не ноль владельцев', async () => {
    const graph = crypto.randomUUID();
    const second = crypto.randomUUID();
    await graphWithOwners(graph, [graph, second]);
    const other = adminDb(); // второе соединение: гонка — между транзакциями, не внутри одной
    let release!: () => void;
    const firstMayCommit = new Promise<void>((r) => {
      release = r;
    });
    let firstChecked!: () => void;
    const firstHoldsLock = new Promise<void>((r) => {
      firstChecked = r;
    });
    const revokeIn = (db: typeof admin.db, account: string, after?: Promise<void>, mark?: () => void) =>
      db.transaction(async (tx) => {
        await tx.execute(sql`UPDATE graph_members SET revoked_at = now()
          WHERE graph_id = ${graph}::uuid AND account_id = ${account}::uuid AND revoked_at IS NULL`);
        // IMMEDIATE исполняет отложенный триггер сейчас: он берёт замок строки графа и держит до коммита
        await tx.execute(sql`SET CONSTRAINTS ALL IMMEDIATE`);
        mark?.();
        if (after) await after;
      });
    const first = revokeIn(admin.db, graph, firstMayCommit, firstChecked);
    await firstHoldsLock;
    const secondTx = codeOf(() => revokeIn(other.db, second)); // упрётся в замок FOR NO KEY UPDATE
    await new Promise((r) => setTimeout(r, 150));
    release();
    await first;
    expect(await secondTx).toBe('23514');
    const left = await admin.db.execute(sql`SELECT count(*)::int AS n FROM graph_members
      WHERE graph_id = ${graph}::uuid AND grant_kind = 'owner' AND revoked_at IS NULL`);
    expect(left[0]?.n).toBe(1);
    await other.client.end();
  });

  test('история отзывов не затирается: повторная выдача — новая строка; второй ДЕЙСТВУЮЩИЙ грант пары — отказ', async () => {
    const graph = crypto.randomUUID();
    const member = crypto.randomUUID();
    await graphWithOwners(graph, [graph]);
    const grantOperator = () =>
      admin.db.execute(sql`INSERT INTO graph_members (id, graph_id, account_id, grant_kind, issued_by)
        VALUES (gen_random_uuid(), ${graph}::uuid, ${member}::uuid, 'operator', ${graph}::uuid)`);
    await grantOperator();
    expect(await codeOf(grantOperator)).toBe('23505');
    await admin.db.execute(sql`UPDATE graph_members SET revoked_at = now()
      WHERE graph_id = ${graph}::uuid AND account_id = ${member}::uuid`);
    await grantOperator();
    const rows = await admin.db.execute(sql`SELECT count(*)::int AS n FROM graph_members
      WHERE graph_id = ${graph}::uuid AND account_id = ${member}::uuid`);
    expect(rows[0]?.n).toBe(2);
  });

  test('truncateAll сносит графы и членство, а личности процесса восстанавливает', async () => {
    const stray = crypto.randomUUID(); // граф МИМО реестра хелпера — обязан исчезнуть
    const minted = mintGraph(); // зарегистрированная личность — обязана вернуться с грантом owner
    await graphWithOwners(stray, [stray]);
    await truncateAll();
    const rows = await admin.db.execute(sql`SELECT g.id::text AS id,
        (SELECT count(*)::int FROM graph_members m
          WHERE m.graph_id = g.id AND m.grant_kind = 'owner' AND m.revoked_at IS NULL) AS owners
      FROM graphs g WHERE g.id IN (${stray}::uuid, ${minted}::uuid)`);
    expect(rows.map((r) => r.id)).toEqual([minted]);
    expect(rows[0]?.owners).toBe(1);
  });

  test('FK: строка с graph_id несуществующего графа — отказ', async () => {
    const ghost = crypto.randomUUID();
    expect(
      await codeOf(() =>
        admin.db.execute(sql`INSERT INTO entities (id, graph_id, title)
          VALUES (gen_random_uuid(), ${ghost}::uuid, 'сирота')`),
      ),
    ).toBe('23503');
  });
});
```
  Прогон: `cd /Users/birzhan/projects/orbis/.claude/worktrees/graph-ownership-g/apps/server && bun test src/db/graphs.test.ts` → **красный**: `relation "graphs" does not exist`.
  (Если форма ответа `execute` у драйвера — не массив строк, привести чтение `rows[0]?.n` к форме соседних тестов
  `db/reset-world.test.ts`; смысл проверок не менять.)

- [ ] **Шаг 2: красный тест бэкфилла — в том же файле, второй `describe`.** Бэкфилл pgTAP'ом не проверить: `test:rls` идёт
  после всех миграций, базы «до» там нет (спека Ш-1б). Тест исполняет ТЕКСТ бэкфилла из файла миграции на базе без FK:
```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Текст бэкфилла — ровно тот, что в миграции: вторая копия разошлась бы с первой молча. */
function backfillStatements(): string[] {
  const file = join(import.meta.dir, 'migrations', '0020_graphs_members.sql');
  const text = readFileSync(file, 'utf8');
  const body = text.slice(text.indexOf('-- BACKFILL:BEGIN'), text.indexOf('-- BACKFILL:END'));
  return body
    .split('--> statement-breakpoint')
    .map((s) => s.replace(/^\s*--.*$/gm, '').trim())
    .filter((s) => s.length > 0);
}

class Rollback extends Error {}

describe('бэкфилл 0020 на непустой базе (спека Ш-1б)', () => {
  test('каждая из 15 таблиц даёт свой граф; встроенные строки реестров (NULL) графа не дают', async () => {
    await truncateAll();
    const admin = adminDb();
    // ПРОСТРАНСТВО, а не выборка: у КАЖДОЙ из 15 таблиц — свой id, которого нет больше нигде;
    // выпавшая из UNION таблица оставит свой id без графа, и возврат FK на шаге (6) упадёт.
    const TABLES = [
      'entities', 'chat_threads', 'entity_versions', 'entity_origins', 'ai_usage', 'user_settings',
      'agent_grants', 'envelope_spent_cache', 'registry_deltas', 'property_definitions',
      'aspect_definitions', 'relation_role_definitions', 'contract_definitions',
      'subscription_definitions', 'action_definitions',
    ] as const;
    const idOf = Object.fromEntries(TABLES.map((t) => [t, crypto.randomUUID()])) as Record<
      (typeof TABLES)[number],
      string
    >;
    try {
      await admin.db.transaction(async (tx) => {
        // (1) снять FK на graphs — имена из каталога, не из головы
        const fks = await tx.execute(sql`SELECT conrelid::regclass::text AS tbl, conname,
            pg_get_constraintdef(oid) AS def FROM pg_constraint
          WHERE contype = 'f' AND confrelid = 'public.graphs'::regclass`);
        expect(fks.length).toBe(16); // 15 таблиц с ключом владения + graph_members
        for (const fk of fks) {
          await tx.execute(sql.raw(`ALTER TABLE ${fk.tbl} DROP CONSTRAINT "${fk.conname}"`));
        }
        // После миграции 0021 колонка NOT NULL, а строка «до 0020» выдавшего не несёт: ограничение
        // снимается на время теста (до 0021 — no-op) и возвращается сверкой после бэкфилла.
        await tx.execute(sql`ALTER TABLE agent_grants ALTER COLUMN issued_by DROP NOT NULL`);
        // (2) база «до 0020»: графов нет
        await tx.execute(sql`TRUNCATE graph_members`);
        await tx.execute(sql`DELETE FROM graphs`);
        // (3) по строке на таблицу — минимальные наборы колонок взять из фикстур
        //     apps/server/test/rls/rls.pgtap.sql (там есть INSERT в каждую из 15 таблиц)
        await seedOneRowPerTable(tx, idOf);
        // (4) ТЕКСТ бэкфилла из файла миграции
        for (const stmt of backfillStatements()) await tx.execute(sql.raw(stmt));
        await tx.execute(sql`SET CONSTRAINTS ALL IMMEDIATE`); // И-1 сейчас, и снять отложенные события перед ALTER
        // (5) сверка
        const graphsRows = await tx.execute(sql`SELECT id::text AS id, owner_kind, owner_ref::text AS ref FROM graphs`);
        expect(graphsRows.map((r) => r.id).sort()).toEqual(Object.values(idOf).sort());
        expect(graphsRows.every((r) => r.owner_kind === 'person' && r.ref === r.id)).toBe(true);
        const members = await tx.execute(sql`SELECT graph_id::text AS g, account_id::text AS a, grant_kind,
            issued_by::text AS by FROM graph_members`);
        expect(members.length).toBe(15);
        expect(members.every((m) => m.a === m.g && m.by === m.g && m.grant_kind === 'owner')).toBe(true);
        const grant = await tx.execute(sql`SELECT issued_by::text AS by FROM agent_grants
          WHERE graph_id = ${idOf.agent_grants}::uuid`);
        expect(grant[0]?.by).toBe(idOf.agent_grants);
        // бэкфилл закрыл КАЖДУЮ строку грантов — иначе NOT NULL не встанет
        await tx.execute(sql`ALTER TABLE agent_grants ALTER COLUMN issued_by SET NOT NULL`);
        // (6) FK возвращается — значит, у каждой строки каждой таблицы граф есть
        for (const fk of fks) {
          await tx.execute(sql.raw(`ALTER TABLE ${fk.tbl} ADD CONSTRAINT "${fk.conname}" ${fk.def}`));
        }
        throw new Rollback();
      });
    } catch (e) {
      if (!(e instanceof Rollback)) throw e;
    } finally {
      await admin.client.end();
    }
  });
});
```
  `seedOneRowPerTable` — локальная функция того же файла (наборы колонок — те же, что у фикстур
  `apps/server/test/rls/rls.pgtap.sql:9-109`; строкам с FK на сущность даём сущность графа `idOf.entities` — межграфовую
  строгость держит политика, а не схема, тест идёт под админом; строка `agent_grants` — БЕЗ `issued_by`):
```ts
type BackfillTx = Parameters<Parameters<ReturnType<typeof adminDb>['db']['transaction']>[0]>[0];

async function seedOneRowPerTable(tx: BackfillTx, idOf: Record<string, string>): Promise<void> {
  const entity = crypto.randomUUID();
  const thread = crypto.randomUUID();
  const j = (o: unknown) => JSON.stringify(o);
  await tx.execute(sql`INSERT INTO entities (id, graph_id, title)
    VALUES (${entity}::uuid, ${idOf.entities}::uuid, 'бэкфилл')`);
  await tx.execute(sql`INSERT INTO chat_threads (id, graph_id) VALUES (${thread}::uuid, ${idOf.chat_threads}::uuid)`);
  await tx.execute(sql`INSERT INTO entity_versions (id, graph_id, entity_id, label, body, actor_user_id, actor_kind)
    VALUES (gen_random_uuid(), ${idOf.entity_versions}::uuid, ${entity}::uuid, 'до', 'тело',
            ${idOf.entity_versions}::uuid, 'owner')`);
  await tx.execute(sql`INSERT INTO entity_origins (id, graph_id, entity_id, namespace, external_id)
    VALUES (gen_random_uuid(), ${idOf.entity_origins}::uuid, ${entity}::uuid, 'backfill', 'ext-1')`);
  await tx.execute(sql`INSERT INTO ai_usage (graph_id, date, model)
    VALUES (${idOf.ai_usage}::uuid, '2026-09-01', 'backfill-model')`);
  await tx.execute(sql`INSERT INTO user_settings (graph_id) VALUES (${idOf.user_settings}::uuid)`);
  await tx.execute(sql`INSERT INTO agent_grants (id, graph_id, kind, label, access_hash)
    VALUES (gen_random_uuid(), ${idOf.agent_grants}::uuid, 'pat', 'бэкфилл', ${`hash-${idOf.agent_grants}`})`);
  await tx.execute(sql`INSERT INTO envelope_spent_cache (envelope_id, graph_id, as_of, spent, owner_version, system_version)
    VALUES (${entity}::uuid, ${idOf.envelope_spent_cache}::uuid, '2026-09-01', 100, 0, 1)`);
  await tx.execute(sql`INSERT INTO registry_deltas (id, graph_id, target_kind, target_id, base_version, delta)
    VALUES (gen_random_uuid(), ${idOf.registry_deltas}::uuid, 'property', 'orbis/priority', 1,
            ${j({ label: { ru: 'Своё' } })}::jsonb)`);
  const l = j({ ru: 'Б' });
  await tx.execute(sql`INSERT INTO property_definitions (id, graph_id, key, label, description, type, rank)
    VALUES ('backfill/p', ${idOf.property_definitions}::uuid, 'backfill/p', ${l}::jsonb, ${l}::jsonb,
            ${j({ kind: 'text' })}::jsonb, 900)`);
  await tx.execute(sql`INSERT INTO aspect_definitions (id, graph_id, key, label, description)
    VALUES ('backfill/a', ${idOf.aspect_definitions}::uuid, 'backfill/a', ${l}::jsonb, ${l}::jsonb)`);
  await tx.execute(sql`INSERT INTO relation_role_definitions
    (id, graph_id, key, label, description, source_label, target_label, rank)
    VALUES ('backfill/r', ${idOf.relation_role_definitions}::uuid, 'backfill/r', ${l}::jsonb, ${l}::jsonb,
            ${l}::jsonb, ${l}::jsonb, 900)`);
  await tx.execute(sql`INSERT INTO contract_definitions (id, graph_id, key, label, description, kind, rank)
    VALUES ('backfill/c', ${idOf.contract_definitions}::uuid, 'backfill/c', ${l}::jsonb, ${l}::jsonb, 'slots', 900)`);
  await tx.execute(sql`INSERT INTO subscription_definitions (id, graph_id, surface, definition, rank)
    VALUES ('backfill/s', ${idOf.subscription_definitions}::uuid, 'agenda', '{}'::jsonb, 900)`);
  await tx.execute(sql`INSERT INTO action_definitions (id, graph_id, key, label, description)
    VALUES ('backfill/d', ${idOf.action_definitions}::uuid, 'backfill/d', ${l}::jsonb, ${l}::jsonb)`);
}
```
  Прогон → **красный**: файла миграции нет. (Набор NOT NULL-колонок со временем дрейфует — при отказе `23502` сверить
  колонки со свежими фикстурами pgTAP; состав таблиц и правило «свой id на каждую» не менять.)

- [ ] **Шаг 3: `db/schema.ts` — две таблицы, FK, `issued_by`.** В конец файла (после `envelopeSpentCache`):
```ts
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
    uniqueIndex('graph_members_active_uniq').on(t.graphId, t.accountId).where(sql`${t.revokedAt} IS NULL`),
    index('graph_members_account').on(t.accountId),
    check('graph_members_grant_kind', sql`${t.grantKind} IN ('owner','operator','observer')`),
  ],
);
```
  Таблицы объявить ВЫШЕ первого использования в `.references` либо оставить внизу — `() => graphs.id` ленив. У 15 колонок
  ключа владения добавить ссылку: `graphId: uuid('graph_id').notNull().references(() => graphs.id, { onDelete: 'no action' })`
  (у шести реестров — без `.notNull()`, NULL по-прежнему = встроенное; у `userSettings` — `.primaryKey().references(…)`).
  У `agentGrants` добавить после `graphId`:
```ts
    // Аккаунт, выдавший грант (D44, спека §3.4–§3.5): актор путей без живого человека. NULLABLE до
    // миграции 0021 — писатели появляются задачей Г-3, NOT NULL ставит Г-4 (Р-КГ-2).
    issuedBy: uuid('issued_by'),
```
  Проверка: `cd /Users/birzhan/projects/orbis/.claude/worktrees/graph-ownership-g && grep -c "references(() => graphs.id" apps/server/src/db/schema.ts` → **16**.

- [ ] **Шаг 4: снимок `0020` — генератором (вопросов не будет: ничего не удалено), SQL — руками.**
```
cd /Users/birzhan/projects/orbis/.claude/worktrees/graph-ownership-g/apps/server && bunx drizzle-kit generate --name graphs_members 2>&1 | tail -5
cd /Users/birzhan/projects/orbis/.claude/worktrees/graph-ownership-g && ls apps/server/src/db/migrations/0020_graphs_members.sql apps/server/src/db/migrations/meta/0020_snapshot.json
```
  Из сгенерированного текста взять ДОСЛОВНО имена: 16 ограничений FK (`…_graph_id_graphs_id_fk`), два индекса, три CHECK —
  снимок уже несёт их, и рукописный SQL обязан совпасть с ним по именам (при расхождении с текстом ниже права генерация).
  **Заменить содержимое файла целиком**, порядок — «таблицы → бэкфилл → FK → триггеры → RLS» (спека §8.1: «таблицы →
  бэкфилл → FK»; триггеры — ПОСЛЕ бэкфилла, иначе отложенные события мешали бы `ALTER TABLE` той же транзакции):
```sql
-- 0020_graphs_members.sql — срез «Г — единица владения» (D44), задача Г-2.
-- Файл РУКОПИСНЫЙ, снимок meta/0020_snapshot.json — сгенерированный: бэкфилл обязан встать МЕЖДУ
-- созданием таблиц и FK, а политик, грантов и триггеров drizzle-kit не видит вовсе.
-- Bypass RLS не вводится (0013:7-8): функции триггеров — SECURITY INVOKER.
CREATE TABLE "graphs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_kind" text NOT NULL,
	"owner_ref" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "graphs_owner_kind" CHECK ("graphs"."owner_kind" IN ('person','organization')),
	CONSTRAINT "graphs_personal_identity" CHECK (("graphs"."owner_kind" = 'person' AND "graphs"."owner_ref" IS NOT NULL AND "graphs"."id" = "graphs"."owner_ref") OR "graphs"."owner_kind" = 'organization')
);
--> statement-breakpoint
CREATE TABLE "graph_members" (
	"id" uuid PRIMARY KEY NOT NULL,
	"graph_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"grant_kind" text NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"issued_by" uuid NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "graph_members_grant_kind" CHECK ("graph_members"."grant_kind" IN ('owner','operator','observer'))
);
--> statement-breakpoint
ALTER TABLE "graph_members" ADD CONSTRAINT "graph_members_graph_id_graphs_id_fk" FOREIGN KEY ("graph_id") REFERENCES "public"."graphs"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "graph_members_active_uniq" ON "graph_members" USING btree ("graph_id","account_id") WHERE "graph_members"."revoked_at" IS NULL;
--> statement-breakpoint
CREATE INDEX "graph_members_account" ON "graph_members" USING btree ("account_id");
--> statement-breakpoint
ALTER TABLE "agent_grants" ADD COLUMN "issued_by" uuid;
--> statement-breakpoint
-- BACKFILL:BEGIN — прод НЕ пуст (спека §0 п. 6). Текст между маркерами исполняет и тест
-- src/db/graphs.test.ts — второй копии у него нет.
-- У шести реестров NULL = встроенная строка: без `IS NOT NULL` NULL попал бы в PK. Дубли снимает UNION.
INSERT INTO "graphs" ("id", "owner_kind", "owner_ref")
SELECT s.g, 'person', s.g FROM (
	SELECT "graph_id" AS g FROM "entities"
	UNION SELECT "graph_id" FROM "chat_threads"
	UNION SELECT "graph_id" FROM "entity_versions"
	UNION SELECT "graph_id" FROM "entity_origins"
	UNION SELECT "graph_id" FROM "ai_usage"
	UNION SELECT "graph_id" FROM "user_settings"
	UNION SELECT "graph_id" FROM "agent_grants"
	UNION SELECT "graph_id" FROM "envelope_spent_cache"
	UNION SELECT "graph_id" FROM "registry_deltas"
	UNION SELECT "graph_id" FROM "property_definitions" WHERE "graph_id" IS NOT NULL
	UNION SELECT "graph_id" FROM "aspect_definitions" WHERE "graph_id" IS NOT NULL
	UNION SELECT "graph_id" FROM "relation_role_definitions" WHERE "graph_id" IS NOT NULL
	UNION SELECT "graph_id" FROM "contract_definitions" WHERE "graph_id" IS NOT NULL
	UNION SELECT "graph_id" FROM "subscription_definitions" WHERE "graph_id" IS NOT NULL
	UNION SELECT "graph_id" FROM "action_definitions" WHERE "graph_id" IS NOT NULL
) s;
--> statement-breakpoint
INSERT INTO "graph_members" ("id", "graph_id", "account_id", "grant_kind", "issued_by")
SELECT gen_random_uuid(), g."id", g."id", 'owner', g."id" FROM "graphs" g;
--> statement-breakpoint
UPDATE "agent_grants" SET "issued_by" = "graph_id" WHERE "issued_by" IS NULL;
--> statement-breakpoint
-- BACKFILL:END
ALTER TABLE "entities" ADD CONSTRAINT "entities_graph_id_graphs_id_fk" FOREIGN KEY ("graph_id") REFERENCES "public"."graphs"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
-- … ТАКИЕ ЖЕ 14 статементов — по одному на таблицу, имена дословно из сгенерированного текста:
-- chat_threads, entity_versions, entity_origins, ai_usage, user_settings, agent_grants,
-- envelope_spent_cache, registry_deltas, property_definitions, aspect_definitions,
-- relation_role_definitions, contract_definitions, subscription_definitions, action_definitions
--> statement-breakpoint
-- И-1 (спека §3.3): у графа всегда есть действующий грант owner. Декларативно не выражается —
-- отложенные constraint-триггеры. ГРАНИЦА v1: у роли authenticated пути отзыва нет вовсе
-- (ни политик, ни права UPDATE/DELETE), триггер отзыва работает на админских и ops-путях, где
-- видит все строки. ДОЛГ СТУПЕНИ 2: под SECURITY INVOKER и политикой account_id = auth.uid()
-- он видел бы только строки вызывающего — вместе с политикой отзыва ступень 2 обязана дать
-- владельцам видимость всех строк членства своего графа.
CREATE FUNCTION "public"."graphs_require_owner"() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM public.graph_members m
		WHERE m.graph_id = NEW.id AND m.grant_kind = 'owner' AND m.revoked_at IS NULL) THEN
		RAISE EXCEPTION 'граф % создан без действующего гранта owner (И-1)', NEW.id USING ERRCODE = '23514';
	END IF;
	RETURN NULL;
END $$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "graphs_require_owner" AFTER INSERT ON "graphs"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "public"."graphs_require_owner"();
--> statement-breakpoint
CREATE FUNCTION "public"."graph_members_keep_owner"() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
BEGIN
	-- Замок строки графа сериализует параллельные отзывы. FOR NO KEY UPDATE, а не FOR UPDATE:
	-- тот конфликтует с FK-замком (KEY SHARE) каждой записи строк графа.
	PERFORM 1 FROM public.graphs g WHERE g.id = OLD.graph_id FOR NO KEY UPDATE;
	IF NOT FOUND THEN
		RETURN NULL; -- граф снесён вместе с членством: проверять нечего
	END IF;
	IF NOT EXISTS (SELECT 1 FROM public.graph_members m
		WHERE m.graph_id = OLD.graph_id AND m.grant_kind = 'owner' AND m.revoked_at IS NULL) THEN
		RAISE EXCEPTION 'у графа % не осталось действующего гранта owner (И-1)', OLD.graph_id USING ERRCODE = '23514';
	END IF;
	RETURN NULL;
END $$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "graph_members_keep_owner" AFTER UPDATE OR DELETE ON "graph_members"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "public"."graph_members_keep_owner"();
--> statement-breakpoint
ALTER TABLE "graphs" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "graphs" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "graph_members" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "graph_members" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Политики новых таблиц (спека §3.6). У graphs и graph_members в v1 НЕТ политик UPDATE/DELETE
-- (И-2: неизменяемость отсутствием права; иначе — самовыдача членства в любой граф).
CREATE POLICY "member_reads_graph" ON "graphs" FOR SELECT TO authenticated
USING (EXISTS (SELECT 1 FROM "graph_members" m
	WHERE m."graph_id" = "graphs"."id" AND m."account_id" = (SELECT auth.uid()) AND m."revoked_at" IS NULL));
--> statement-breakpoint
-- INSERT — только свой личный граф. Сид вставляет БЕЗ RETURNING: пока нет строки членства, только
-- что вставленный граф SELECT-политику не проходит.
CREATE POLICY "person_creates_own_graph" ON "graphs" FOR INSERT TO authenticated
WITH CHECK ("owner_kind" = 'person' AND "id" = (SELECT auth.uid()) AND "owner_ref" = (SELECT auth.uid()));
--> statement-breakpoint
CREATE POLICY "account_reads_own_membership" ON "graph_members" FOR SELECT TO authenticated
USING ("account_id" = (SELECT auth.uid()));
--> statement-breakpoint
-- INSERT — только себя как owner собственного личного графа, РАВЕНСТВОМ id, без EXISTS по graphs
-- (курица и яйцо с политикой выше).
CREATE POLICY "account_owns_personal_graph" ON "graph_members" FOR INSERT TO authenticated
WITH CHECK ("graph_id" = (SELECT auth.uid()) AND "account_id" = (SELECT auth.uid())
	AND "grant_kind" = 'owner' AND "issued_by" = (SELECT auth.uid()));
--> statement-breakpoint
-- Планировщик рутин идёт под orbis_app БЕЗ идентичности (0013) и обязан получить пары
-- «граф, держатель гранта owner». Образец — scheduler_reads_owner_list (0013:25,35): поверхность
-- без идентичности расширена на одну таблицу без тел.
CREATE POLICY "scheduler_reads_members" ON "graph_members" FOR SELECT TO orbis_app USING (true);
--> statement-breakpoint
-- ЯВНЫЕ гранты: GRANT … ON ALL TABLES из 0001:97 на таблицы, созданные позже, не распространяется
-- (урок 0011/0014/0018). Сначала REVOKE: default ACL роли-владельца в разных окружениях разный
-- (локальный стек даёт anon/authenticated `Dxtm`, образ CI — ещё и SELECT; rls.pgtap.sql:298-322), а
-- TRUNCATE идёт мимо RLS. После него у authenticated ровно SELECT и INSERT.
REVOKE ALL ON "graphs", "graph_members" FROM anon, authenticated;
--> statement-breakpoint
GRANT SELECT, INSERT ON "graphs", "graph_members" TO authenticated;
--> statement-breakpoint
GRANT SELECT ON "graph_members" TO orbis_app;
```
  14 статементов FK выписать ПОЛНОСТЬЮ (комментарий-заглушка выше в файле миграции недопустим). Сверка «снимок = схема»:
  `cd /Users/birzhan/projects/orbis/.claude/worktrees/graph-ownership-g/apps/server && bunx drizzle-kit generate --name should_be_empty 2>&1 | tail -3` → `No schema changes, nothing to migrate`.

- [ ] **Шаг 5: сид — личный граф ПЕРВЫМ шагом `seedOwnerGraph`.** Создать `apps/server/src/seed/personal-graph.ts`:
```ts
import { sql } from 'drizzle-orm';
import { graphMembers, graphs } from '../db/schema';
import type { Tx } from '../db/with-identity';

/**
 * Личный граф аккаунта: строка `graphs` (id = id аккаунта — тождество держит CHECK таблицы) и
 * грант `owner` самому себе. Идемпотентно: повторный заход ничего не вставляет.
 *
 * Идёт под ролью `authenticated` с `sub` = аккаунт: INSERT-политики 0020 пускают ровно эту
 * пару строк — личный граф самого себя. БЕЗ `RETURNING`: пока нет строки членства, только что
 * вставленный граф SELECT-политику не проходит (спека §3.6). Обе вставки — в ОДНОЙ транзакции:
 * отложенный триггер И-1 (`graphs_require_owner`) проверяет грант на коммите.
 */
export async function ensurePersonalGraph(tx: Tx, accountId: string): Promise<void> {
  await tx
    .insert(graphs)
    .values({ id: accountId, ownerKind: 'person', ownerRef: accountId })
    .onConflictDoNothing({ target: graphs.id });
  await tx
    .insert(graphMembers)
    .values({
      id: crypto.randomUUID(),
      graphId: accountId,
      accountId,
      grantKind: 'owner',
      issuedBy: accountId,
    })
    .onConflictDoNothing({
      target: [graphMembers.graphId, graphMembers.accountId],
      // сырым текстом: колонка drizzle отрендерилась бы квалифицированным именем, а предикату
      // ON CONFLICT нужен ровно предикат частичного индекса graph_members_active_uniq
      where: sql`revoked_at IS NULL`,
    });
}
```
  (`id` строки членства — тем же генератором, каким сервер делает прочие id: если в `packages/shared/src/ids.ts` есть
  `newId()` — взять его вместо `crypto.randomUUID()`.) В `apps/server/src/seed/onboarding.ts` тело `seedOwnerGraph` (`:154-155`):
```ts
  // ГРАФ — ПЕРВЫМ (D44, спека Ш-1б): первая же запись мира (`seedOwnerWorld`) несёт FK на `graphs`,
  // и без строки графа упала бы на нём. Порядок «граф → мир → настройки»; стрелка «мир → настройки»
  // из докблока выше не нарушена: строка графа маркером «онбординг прошёл» не служит.
  await withIdentity(db, graphId, (tx) => ensurePersonalGraph(tx, graphId));
  await seedOwnerWorld(db, graphId, { clock });
  return withIdentity(db, graphId, (tx) => seedOnboarding(tx, graphId, clock));
```
  Докблок `seedOwnerGraph` (`:121-148`): дописать абзац «ПОРЯДОК: граф → мир → настройки» теми же словами. В
  `apps/server/src/seed/onboarding.test.ts` ПЕРЕПИСАТЬ существующий тест повторного захода так, чтобы он пинил и граф (новых
  тестов сид не получает — идемпотентность графа проверяется там же, где идемпотентность мира): аккаунт БЕЗ графа
  (`crypto.randomUUID()`, не `freshGraph()`), `seedOwnerGraph` дважды → `graphs` — ровно 1 строка с `owner_ref = id`,
  `graph_members` — ровно 1 строка `owner` с `issued_by = id`.

- [ ] **Шаг 6: `test/helpers.ts` — обвязка (Р-КГ-3).** Заменить `freshUserId` (`:39-42`) и тело `truncateAll` (`:50-67`):
```ts
/**
 * Личности тестового процесса: id личных графов (они же id аккаунтов), выданные хелперами ниже.
 *
 * ЗАЧЕМ РЕЕСТР. С FK `graph_id → graphs.id` (0020) владельца «из воздуха» больше не бывает: строка
 * графа обязана существовать до первой записи. Но 117 из 578 выдач id происходят СИНХРОННО — на
 * уровне модуля и в теле `describe`, где `await` невозможен, — а 36 файлов держат модульного
 * владельца И зовут `truncateAll()` в `beforeAll`: граф, заведённый при выдаче id, был бы снесён
 * до первого теста. Поэтому выдача id и появление строк разведены: `mintGraph()` только
 * регистрирует, а строки доводит до базы `ensureGraphs()` — его зовёт `truncateAll()` своим
 * последним действием («мир пуст, личности процесса на месте») и `freshGraph()` сразу.
 * Тело `describe` исполняется при СБОРЕ файла, раньше любого хука, — к первому `beforeAll` все
 * синхронные id уже зарегистрированы.
 */
const MINTED = new Set<string>();

/** Синхронно: id личного графа, строк в базе ещё нет — их заведёт `ensureGraphs()`/`truncateAll()`. */
export function mintGraph(id: string = crypto.randomUUID()): string {
  MINTED.add(id);
  return id;
}

/** Свежий личный граф с грантом owner — строки уже в базе. Форма по умолчанию для async-тел. */
export async function freshGraph(): Promise<string> {
  const id = mintGraph();
  await ensureGraphs([id]);
  return id;
}

/** Доводит id до базы: граф `person` и грант `owner` самому себе (админ-DSN, идемпотентно). */
export async function ensureGraphs(ids: Iterable<string> = MINTED): Promise<void> {
  const list = [...ids];
  if (list.length === 0) return;
  const { db, client } = adminDb();
  try {
    const rows = sql.join(
      list.map((id) => sql`(${id}::uuid)`),
      sql`, `,
    );
    // Одна транзакция: отложенный триггер И-1 проверяет грант owner на коммите.
    await db.transaction(async (tx) => {
      await tx.execute(sql`INSERT INTO graphs (id, owner_kind, owner_ref)
        SELECT v.g, 'person', v.g FROM (VALUES ${rows}) AS v(g) ON CONFLICT (id) DO NOTHING`);
      await tx.execute(sql`INSERT INTO graph_members (id, graph_id, account_id, grant_kind, issued_by)
        SELECT gen_random_uuid(), v.g, v.g, 'owner', v.g FROM (VALUES ${rows}) AS v(g)
        ON CONFLICT (graph_id, account_id) WHERE revoked_at IS NULL DO NOTHING`);
    });
  } finally {
    await client.end();
  }
}

/** Полная зачистка данных между сьютами (админ-DSN, обходит RLS); личности процесса восстанавливаются. */
export async function truncateAll(): Promise<void> {
  const { db, client } = adminDb();
  await db.execute(sql`TRUNCATE entities, relations, user_settings, chat_threads,
    chat_messages, ai_usage, entity_origins, entity_versions, agent_grants, oauth_clients,
    envelope_spent_cache
    RESTART IDENTITY CASCADE`);
  for (const table of DEFINITION_TABLES) {
    await db.execute(sql`DELETE FROM ${sql.raw(table)} WHERE graph_id IS NOT NULL`);
  }
  await db.execute(sql`TRUNCATE registry_deltas`);
  // Графы и членство — ПОСЛЕДНИМИ и НЕ в списке `TRUNCATE … CASCADE` выше: на `graphs` ссылаются
  // все шесть реестров, и CASCADE снёс бы их ЦЕЛИКОМ, вместе со встроенными строками. `TRUNCATE`
  // членства строковых триггеров И-1 не запускает; на `graphs` к этому моменту никто не ссылается.
  await db.execute(sql`TRUNCATE graph_members`);
  await db.execute(sql`DELETE FROM graphs`);
  // registry_system НЕ трогается НАМЕРЕННО … (существующий комментарий сохранить дословно)
  await client.end();
  await ensureGraphs();
}
```

- [ ] **Шаг 7: 578 вызовов `freshUserId()` — механически, три прохода.**
```
cd /Users/birzhan/projects/orbis/.claude/worktrees/graph-ownership-g && git grep -l 'freshUserId' -- apps/server > /Users/birzhan/projects/orbis/.superpowers/sdd/2026-09-20-graph-ownership/g2-files.txt && wc -l /Users/birzhan/projects/orbis/.superpowers/sdd/2026-09-20-graph-ownership/g2-files.txt
cd /Users/birzhan/projects/orbis/.claude/worktrees/graph-ownership-g && xargs perl -pi -e 's/^((?:export )?const \w+ = )freshUserId\(\)/$1mintGraph()/; s/\bfreshUserId\(\)/await freshGraph()/g; s/\bfreshUserId\b/freshGraph/g' < /Users/birzhan/projects/orbis/.superpowers/sdd/2026-09-20-graph-ownership/g2-files.txt
cd /Users/birzhan/projects/orbis/.claude/worktrees/graph-ownership-g && bun run typecheck 2>&1 | grep -E 'TS1308|TS1375|TS2304|TS2305' | head -80
```
  Первый проход — 56 модульных сайтов → `mintGraph()`; второй — остальные → `await freshGraph()`; третий — имя в импортах.
  Ошибки `TS1308`/`TS1375` («await вне async») — это 61 сайт в теле `describe` и ~14 прочих синхронных (аргумент литерала в
  sync-функции): на каждой такой строке `await freshGraph()` → `mintGraph()`, в импорт добавить `mintGraph`. Неиспользуемый
  импорт покажет biome. Проверка: `git grep -c 'freshUserId' -- apps/server` → пусто.
  Владельцы МИМО хелпера (Ф-Г-14, `recon-4` §2) — зарегистрировать тем же реестром: `test/surfaces.ts:57,64,458,459` и
  `src/test/graph-fixture.ts:27`, `src/test/volume-fixture.ts:35` → `mintGraph(uuidv5(…))` вокруг существующей формулы (id не
  меняется — golden-маски целы); `ensureGraphFixture()` и сев объёмной фикстуры первым действием зовут
  `await ensureGraphs([GRAPH_OWNER_ID])` / `([VOLUME_OWNER_ID])` (они живут вне `truncateAll`); `test/seed-registries.test.ts:184,295,
  348,408` и `perf/perf.test.ts:352` → `await freshGraph()`.

- [ ] **Шаг 8: pgTAP — строки графов в фикстурах и группы 20–22.** В `apps/server/test/rls/rls.pgtap.sql` ПЕРЕД первым
  `INSERT INTO entities` (`:9`) завести графы всех id, встречающихся в файле как `graph_id` (список —
  `grep -oE "'0{8}-0{4}-4000-8000-[0-9a-f]{12}'" apps/server/test/rls/rls.pgtap.sql | sort -u`):
```sql
-- Графы фикстур (0020): с FK на graphs владельца «из воздуха» не бывает. Весь файл — одна транзакция
-- с ROLLBACK, отложенные триггеры И-1 до проверки не доходят — гранты заведены ради политик.
INSERT INTO graphs (id, owner_kind, owner_ref) VALUES
  ('00000000-0000-4000-8000-00000000000a', 'person', '00000000-0000-4000-8000-00000000000a'),
  ('00000000-0000-4000-8000-00000000000b', 'person', '00000000-0000-4000-8000-00000000000b');
INSERT INTO graph_members (id, graph_id, account_id, grant_kind, issued_by) VALUES
  ('00000000-0000-7000-8000-0000000000ac', '00000000-0000-4000-8000-00000000000a',
   '00000000-0000-4000-8000-00000000000a', 'owner', '00000000-0000-4000-8000-00000000000a'),
  ('00000000-0000-7000-8000-0000000000bc', '00000000-0000-4000-8000-00000000000b',
   '00000000-0000-4000-8000-00000000000b', 'owner', '00000000-0000-4000-8000-00000000000b');
```
  Проверку «RLS ENABLE+FORCE» (список таблиц — `:113-121`, счёт `19` — `:123`) расширить на `'graphs','graph_members'`: `19` → `21`, подпись — «на всех двадцати
  одной таблице». Перед `SELECT finish();` добавить три группы и блок пинов имён — **28 проверок**,
  `SELECT plan(97);` → **`SELECT plan(125);`**.
  Правило файла (`:298-322`, `:411-415`): ОТСУТСТВИЕ права не пинится — default privileges различаются между локальным
  стеком и образом CI; пинится второй барьер: право выдаётся прямо в тесте, и всё равно ноль строк.
  Аккаунт В (`…00000000000c`) — без графа: на нём пинятся INSERT-политики.
```sql
-- ── Пины имён после 0019 (5 проверок; правка 21.09 по гейт-ревью Г-1, Р-ИГ-5) ────────────────
-- Пять имён, которых RENAME COLUMN не касается (Ф-Г-7), переименованы миграцией 0019 поимённо, и до
-- этого блока их не держало НИЧТО в CI: drizzle-kit generate CI не гоняет, perf-сьюты вне CI (Ф-Г-19),
-- а `chat_threads_graph` не пинил вообще никто. Ошибка в имени тиха: индекс остаётся, запрос работает,
-- расходится только docblock и пин перфа — и находится это через месяцы.
SELECT has_index('public', 'entities', 'entities_graph_updated', 'индекс упорядоченного чтения списка');
SELECT has_index('public', 'chat_threads', 'chat_threads_graph', 'индекс тредов по графу');
SELECT has_index('public', 'agent_grants', 'agent_grants_graph', 'индекс грантов агентов по графу');
SELECT has_index('public', 'envelope_spent_cache', 'envelope_spent_cache_graph', 'индекс кэша конвертов по графу');
SELECT col_is_pk('public', 'ai_usage', ARRAY['graph_id','date','model'], 'PK ai_usage — по графу, дате и модели');

-- ── Группа 20: graphs (спека §3.6) ─────────────────────────────────────────────────────────
RESET ROLE;
-- И-2 держит ОТСУТСТВИЕ ПОЛИТИК, а не отсутствие права: право выдаём здесь (транзакция откатится) и
-- требуем ноль задетых строк — такая проверка верна в любом окружении (урок группы 9, :298-322).
GRANT UPDATE, DELETE ON graphs, graph_members TO authenticated;
SELECT is((SELECT count(*)::int FROM pg_policies WHERE schemaname = 'public'
    AND tablename IN ('graphs','graph_members') AND cmd IN ('UPDATE','DELETE','ALL')),
  0, 'И-2: у graphs и graph_members нет ни одной политики UPDATE/DELETE/ALL');
SELECT throws_ok($$INSERT INTO graphs (id, owner_kind, owner_ref) VALUES
  ('00000000-0000-4000-8000-0000000000d1', 'person', '00000000-0000-4000-8000-0000000000d2')$$,
  '23514', NULL, 'CHECK: у личного графа id = owner_ref');
SELECT throws_ok($$INSERT INTO graphs (id, owner_kind, owner_ref) VALUES
  ('00000000-0000-4000-8000-0000000000d1', 'person', NULL)$$,
  '23514', NULL, 'CHECK: person с пустым owner_ref — отказ (без IS NOT NULL выражение дало бы NULL)');
SELECT lives_ok($$INSERT INTO graphs (id, owner_kind, owner_ref) VALUES
  ('00000000-0000-4000-8000-0000000000d3', 'organization', NULL)$$,
  'organization с NULL в owner_ref зарезервирован для ступени 2');
SELECT set_config('request.jwt.claims',
  '{"sub":"00000000-0000-4000-8000-00000000000a","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
SELECT results_eq('SELECT count(*)::int FROM graphs', ARRAY[1], 'A видит ровно свой граф');
SELECT results_eq($$SELECT count(*)::int FROM graphs WHERE id = '00000000-0000-4000-8000-00000000000b'$$,
  ARRAY[0], 'граф без гранта невидим');
WITH u AS (UPDATE graphs SET owner_kind = 'organization' RETURNING 1)
SELECT is((SELECT count(*)::int FROM u), 0, 'И-2: даже с правом UPDATE граф неизменяем — политики нет');
WITH d AS (DELETE FROM graphs RETURNING 1)
SELECT is((SELECT count(*)::int FROM d), 0, 'И-2: даже с правом DELETE граф не удалить — политики нет');
RESET ROLE;
SELECT set_config('request.jwt.claims',
  '{"sub":"00000000-0000-4000-8000-00000000000c","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
SELECT throws_ok($$INSERT INTO graphs (id, owner_kind, owner_ref) VALUES
  ('00000000-0000-4000-8000-0000000000d4', 'person', '00000000-0000-4000-8000-0000000000d4')$$,
  '42501', NULL, 'INSERT чужого личного графа — отказ политики');
SELECT throws_ok($$INSERT INTO graphs (id, owner_kind, owner_ref) VALUES
  ('00000000-0000-4000-8000-00000000000c', 'organization', '00000000-0000-4000-8000-00000000000c')$$,
  '42501', NULL, 'INSERT organization под authenticated — отказ политики (v1 — только person)');
SELECT lives_ok($$INSERT INTO graphs (id, owner_kind, owner_ref) VALUES
  ('00000000-0000-4000-8000-00000000000c', 'person', '00000000-0000-4000-8000-00000000000c')$$,
  'В заводит свой личный граф: id = owner_ref = auth.uid()');

-- ── Группа 21: graph_members ───────────────────────────────────────────────────────────────
SELECT throws_ok($$INSERT INTO graph_members (id, graph_id, account_id, grant_kind, issued_by) VALUES
  (gen_random_uuid(), '00000000-0000-4000-8000-00000000000c', '00000000-0000-4000-8000-00000000000c',
   'operator', '00000000-0000-4000-8000-00000000000c')$$,
  '42501', NULL, 'себя можно вписать только как owner');
SELECT throws_ok($$INSERT INTO graph_members (id, graph_id, account_id, grant_kind, issued_by) VALUES
  (gen_random_uuid(), '00000000-0000-4000-8000-00000000000a', '00000000-0000-4000-8000-00000000000c',
   'owner', '00000000-0000-4000-8000-00000000000c')$$,
  '42501', NULL, 'самовыдача членства в ЧУЖОЙ граф — отказ');
SELECT throws_ok($$INSERT INTO graph_members (id, graph_id, account_id, grant_kind, issued_by) VALUES
  (gen_random_uuid(), '00000000-0000-4000-8000-00000000000c', '00000000-0000-4000-8000-00000000000b',
   'owner', '00000000-0000-4000-8000-00000000000c')$$,
  '42501', NULL, 'вписать ДРУГОЙ аккаунт в свой граф — отказ (приглашения — ступень 2)');
SELECT lives_ok($$INSERT INTO graph_members (id, graph_id, account_id, grant_kind, issued_by) VALUES
  (gen_random_uuid(), '00000000-0000-4000-8000-00000000000c', '00000000-0000-4000-8000-00000000000c',
   'owner', '00000000-0000-4000-8000-00000000000c')$$,
  'В вписывает себя owner своего личного графа');
SELECT results_eq('SELECT count(*)::int FROM graph_members', ARRAY[1], 'В видит ровно свою строку членства');
SELECT results_eq('SELECT count(*)::int FROM graphs', ARRAY[1], 'после гранта свой граф виден');
WITH u AS (UPDATE graph_members SET revoked_at = now() RETURNING 1)
SELECT is((SELECT count(*)::int FROM u), 0, 'пути отзыва у authenticated в v1 нет: политики UPDATE нет');
WITH d AS (DELETE FROM graph_members RETURNING 1)
SELECT is((SELECT count(*)::int FROM d), 0, 'и политики DELETE нет — иначе самовыдача и самоотзыв членства');
RESET ROLE;
SELECT throws_ok($$INSERT INTO graph_members (id, graph_id, account_id, grant_kind, issued_by) VALUES
  (gen_random_uuid(), '00000000-0000-4000-8000-00000000000a', '00000000-0000-4000-8000-00000000000a',
   'owner', '00000000-0000-4000-8000-00000000000a')$$,
  '23505', NULL, 'второй ДЕЙСТВУЮЩИЙ грант той же пары — отказ частичной уникальности');

-- ── Группа 22: планировщик читает членство (структурно — образец группы 11, :388-417) ────────
SELECT policy_cmd_is('public', 'graph_members', 'scheduler_reads_members', 'SELECT',
  'политика планировщика — только SELECT');
SELECT policy_roles_are('public', 'graph_members', 'scheduler_reads_members', ARRAY['orbis_app']::name[],
  'политика планировщика выдана ровно orbis_app');
SELECT ok(has_table_privilege('orbis_app', 'public.graph_members', 'SELECT'),
  'orbis_app читает graph_members (без гранта — 42501 до всякой политики)');
-- Пиним НАЛИЧИЕ нужного права; отсутствие лишних не пиним (правило :411-415) — запрет записи под
-- orbis_app держит поведением серверный тест db/graphs-policies.test.ts.
```
  После группы 22 идентичность под следующие группы ставится заново (правило файла, `:424-426`). Если группы 20–22 встают
  НЕ в хвост файла — проследить, чтобы `RESET ROLE`/`set_config` перед следующей группой остались на месте.

- [ ] **Шаг 9: поведение под `orbis_app` — `apps/server/src/db/graphs-policies.test.ts`.** Из админ-DSN `SET ROLE orbis_app`
  невозможен (Ф-Г-10), поэтому поведение пинит серверный тест под `appDb()` (образец — `routines/queries.test.ts:79`):
```ts
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { appDb, freshGraph, truncateAll } from '../../test/helpers';
import { withIdentity } from './with-identity';

const { db, client } = appDb(); // { db, client } — как во всех сьютах (образец: db/with-identity.test.ts:10)
let a: string;
let b: string;
beforeAll(async () => {
  await truncateAll();
  a = await freshGraph();
  b = await freshGraph();
});
afterAll(async () => {
  await truncateAll();
  await client.end(); // незакрытый пул держит прогон
});

const pgCode = (e: unknown): string | undefined =>
  (e as { code?: string; cause?: { code?: string } }).code ??
  (e as { cause?: { code?: string } }).cause?.code;

test('orbis_app без идентичности читает пары членства (тик планировщика), но не пишет их', async () => {
  const rows = await db.execute(sql`SELECT graph_id::text AS g FROM graph_members
    WHERE grant_kind = 'owner' AND revoked_at IS NULL`);
  expect(rows.map((r) => r.g)).toEqual(expect.arrayContaining([a, b]));
  let code: string | undefined;
  try {
    await db.execute(sql`INSERT INTO graph_members (id, graph_id, account_id, grant_kind, issued_by)
      VALUES (gen_random_uuid(), ${a}::uuid, ${b}::uuid, 'owner', ${a}::uuid)`);
  } catch (e) {
    code = pgCode(e);
  }
  expect(code).toBe('42501');
});

test('под идентичностью аккаунт видит только своё членство и свой граф', async () => {
  const seen = await withIdentity(db, a, async (tx) => ({
    members: await tx.execute(sql`SELECT account_id::text AS a FROM graph_members`),
    graphs: await tx.execute(sql`SELECT id::text AS id FROM graphs`),
  }));
  expect(seen.members.map((r) => r.a)).toEqual([a]);
  expect(seen.graphs.map((r) => r.id)).toEqual([a]);
});
```

- [ ] **Шаг 10: `reset-world` — графы и членство ПЕРЕЖИВАЮТ пересев.** В `apps/server/src/db/reset-world.ts`: константа
  `GRAPH_TABLES` → **`WORLD_TABLES`** (`:55`, использования `:74,87,109,119,163`), ключ отчёта и снимка `graph` → `world`
  (типы `:74,87`; потребители — `grep -rn "\.graph\b\|graph:" apps/server/src/db/reset-world.ts scripts/ops.ts`), копия в тесте
  `GRAPH_TABLES_UNDER_TEST` → `WORLD_TABLES_UNDER_TEST` (`reset-world.test.ts:60,326,352`). Состав списка НЕ меняется (семь
  таблиц; позиционный пин `[0,0,0,0,0,0,0]` `reset-world.test.ts:356` остаётся). Докблок «ЧТО СОХРАНЯЕТСЯ ЦЕЛИКОМ» (`:14-18`) дополнить:
```ts
 * …а также `graphs` и `graph_members` (D44): граф — единица владения, пересев сносит МИР графа, а не
 * сам граф. Снос графа при живых `user_settings`, `agent_grants` и `ai_usage` упал бы на FK (TRUNCATE
 * здесь без CASCADE — см. ниже), а с CASCADE сломал бы контракт «те же ключи, пустой мир».
```
  Докблок константы (`:41-54`) — первая строка: «Мир графов и журнал — то, что сносится начисто (сами графы и членство
  пересев переживают)». Тем же словом поправить справку операции в `scripts/ops.ts` (`'reset-world'`, `help`): «снести граф и
  журнал владельцев» → «снести МИР графов и журнал (сами графы и членство сохраняются)» — прод-процедура сверяет, что
  `help` не врёт про состав. В `reset-world.test.ts`, тест `:318` («после пересева: граф пуст…»), дописать проверки ВНУТРЬ
  существующего теста: число строк `graphs` и `graph_members` до и после пересева равно, строка графа владельца теста жива.

- [ ] **Шаг 11: база с нуля, pgTAP, точечные тесты.**
```
cd /Users/birzhan/projects/orbis/.claude/worktrees/graph-ownership-g && bunx supabase db reset && bun run db:prepare
cd /Users/birzhan/projects/orbis/.claude/worktrees/graph-ownership-g/apps/server && bun test src/db/graphs.test.ts src/db/graphs-policies.test.ts src/db/reset-world.test.ts src/seed/onboarding.test.ts
```
  Ожидание: `db:prepare` — EXIT=0, накат `0000…0020`, `test:rls` — `plan(125)` без «Looks like you planned»; четыре файла — зелёные.
  Гонка И-1 (шаг 1) — обязательная мутация для отчёта: убрать `FOR NO KEY UPDATE` из `graph_members_keep_owner` (на
  локальной базе, `CREATE OR REPLACE FUNCTION`) → тест гонки КРАСНЫЙ (оба отзыва проходят, владельцев 0); вернуть.

- [ ] **Шаг 12: полный прогон; FK-отказы — по списку.**
```
cd /Users/birzhan/projects/orbis/.claude/worktrees/graph-ownership-g && bun run test 2>&1 | tee /Users/birzhan/projects/orbis/.superpowers/sdd/2026-09-20-graph-ownership/g2-test.log | tail -40
cd /Users/birzhan/projects/orbis/.claude/worktrees/graph-ownership-g && grep -c 'graph_id_graphs_id_fk' /Users/birzhan/projects/orbis/.superpowers/sdd/2026-09-20-graph-ownership/g2-test.log
```
  Отказ `23503 … _graph_id_graphs_id_fk` в файле — два диагноза. (а) Синхронный `mintGraph()` без хука, доводящего id до
  базы (файл не зовёт `truncateAll()` до первой записи). Правка — одна строка в `beforeAll` файла: `await ensureGraphs();` (если `beforeAll` нет —
  `beforeAll(ensureGraphs);`). (б) Владелец МИМО хелпера — `crypto.randomUUID()`/`newId()`, под которым тест пишет строку с
  ключом (подтверждённый пример — `src/db/registry-drift.test.ts:213,236`; поиск —
  `git grep -nE 'randomUUID\(\)|newId\(\)' -- 'apps/server/**/*.test.ts' apps/server/test apps/server/src/test apps/server/perf`):
  `ensureGraphs()` его не вылечит — id заменить на `await freshGraph()`. Повторять до нуля отказов. Ожидание финального прогона: EXIT=0; счётчики — базовая линия
  Г-0 **плюс новые тесты этой задачи** (`graphs.test.ts` — 8, `graphs-policies.test.ts` — 2); расхождение сверх этого разобрать.
  Время полного серверного прогона сравнить с Г-0 и записать: `truncateAll()` теперь доводит до базы ВСЕ личности процесса
  (до ~600 id двумя INSERT'ами на вызов, вызовов — сотни). Рост больше 15 % — сузить: `ensureGraphs()` в хвосте `truncateAll`
  получает только id, выданные ТЕКУЩИМ тест-файлом (реестр чистится в `afterAll` файла), и записать рулинг в `facts.md`.

- [ ] **Шаг 13: остальные гейты.**
```
cd /Users/birzhan/projects/orbis/.claude/worktrees/graph-ownership-g && bun run typecheck
cd /Users/birzhan/projects/orbis/.claude/worktrees/graph-ownership-g && bun run lint
cd /Users/birzhan/projects/orbis/.claude/worktrees/graph-ownership-g && bun scripts/check-legacy-form.ts --gate
cd /Users/birzhan/projects/orbis/.claude/worktrees/graph-ownership-g && bun run test:perf:volume
cd /Users/birzhan/projects/orbis/.claude/worktrees/graph-ownership-g && bun run test:perf:explain
cd /Users/birzhan/projects/orbis/.claude/worktrees/graph-ownership-g && bun run test:perf:graph
cd /Users/birzhan/projects/orbis/.claude/worktrees/graph-ownership-g && bun run test:perf
```
  Ожидание: все EXIT=0; вердикты `explain` — те же, что в Г-0 (FK на план чтения не влияет; иное — записать и разобрать);
  семь медиан — записать (`fastpath:create` получает проверку FK на вставке — ориентир для Г-4).

- [ ] **Шаг 14: коммит.**
```
cd /Users/birzhan/projects/orbis/.claude/worktrees/graph-ownership-g && git add -A && git status --short | head -30 && git commit -m "$(printf 'feat(graph): таблицы graphs и graph_members, бэкфилл, FK, сид личного графа, тестовая обвязка (срез Г, D44, Ш-1б)\n\nМиграция 0020: таблицы → бэкфилл (UNION по 15 таблицам, у реестров WHERE graph_id IS NOT NULL) → 16 FK →\nотложенные триггеры И-1 (замок строки графа FOR NO KEY UPDATE) → политики и явные гранты новых таблиц,\nвключая SELECT для orbis_app (тик планировщика). agent_grants.issued_by — nullable с бэкфиллом; писатели\nприходят задачей Г-3, NOT NULL — миграцией 0021. Личный граф заводится первым шагом seedOwnerGraph под\nauthenticated, без RETURNING. Обвязка: mintGraph / freshGraph / ensureGraphs; truncateAll сносит графы\n(НЕ через TRUNCATE … CASCADE — он снёс бы встроенные строки реестров) и восстанавливает личности процесса.\nreset-world графы и членство сохраняет; GRAPH_TABLES → WORLD_TABLES. pgTAP: plan(125).\n\nCo-Authored-By: Claude Opus 5 <noreply@anthropic.com>')"
```
  Закрытие — протокол глобальных ограничений (гейт Fable → rebase → push → CI → ff-push в `main`, флаг автодеплоя перечитан).

### Задача Г-3: Идентичность транзакции — «актор + текущий граф» (Ш-2)

**Зачем:** сегодня один uuid служит сразу `sub`, ключом строк, ключом реестра, замком и субъектом тарифа (спека §0 п. 3);
тождество id личного графа и аккаунта это слияние маскирует. Задача его разнимает: у транзакции два идентификатора разных
ТИПОВ, пара рождается ровно в трёх резолверах, `withIdentity` принимает только пару и кладёт текущий граф в GUC. При одном
графе на аккаунт значения совпадают, поэтому написать тест на «замок взят по актору вместо графа» нечем — **брендированные
типы здесь заменяют тест** (Ф-Г-16): всё, что ключуется графом, принимает `GraphId`, и подставить туда актора компилятор не
даст. Политики ещё старые (`graph_id = auth.uid()`), GUC они игнорируют — промежуточное состояние рабочее (спека §8.1).

**Файлы:**
- Создать: `apps/server/src/identity.ts`, `apps/server/src/identity.test.ts`, `apps/server/test/graph-vs-account.test.ts`.
- Изменить: `packages/shared/src/ids.ts` (бренды); `apps/server/src/db/with-identity.ts` (+ `.test.ts`); `trpc.ts:14-40,117-120`;
  `context.ts:34-58`; `oauth/grants.ts:26-45,108-142,153-177,304-370` (+ `routers/oauth.ts:122-160`); `mcp/server.ts:49-106,151-153`,
  `mcp/transport.ts:74`; `routines/queries.ts:8-30`, `routines/scheduler.ts:65-105`, `routines/runner.ts`, `routines/lifecycle.ts`;
  `executor/types.ts:50-52`, `executor/executor.ts:263-268,486-498,621-632,704-723,899-914,992,1004-1021`, `executor/journal.ts:83-97`,
  `executor/relations.ts:150-157`, `executor/undo.ts`; `tools/dispatch.ts:137-139` и сайты `ctx.actorUserId`; `agent-loop/{verbs,sweep,
  rollback}.ts`; `registry/cache.ts:103-114`, `registry/ops.ts:2728`; `budget/binding.ts:687`; `query/context.ts:41-70`,
  `query/compile-ast.ts:87-96`; `recurring/with-materialization.ts:50`; `entitlements.ts:14-23`; `chat/threads.ts:26-49`;
  `ai/{send-message,escalation,metering}.ts`; `import/review.ts`; `seed/{onboarding,world,gardener}.ts`; `export.ts:77-79`;
  остальные файлы из 36 с `withIdentity(`; `scripts/{ops.ts:549-593,issue-pat.ts,llm-smoke.ts:85-100,probe-p4.ts}`;
  `apps/server/test/helpers.ts`; 18 локальных `callerFor` и 2 модульных `ownerCaller`; тесты с `withIdentity(`/`actorUserId:`.
- НЕ трогать: миграции (в Г-3 миграции НЕТ); политики RLS (Г-4); `apps/web/**`; формулы `uuidv5` в `packages/shared/src/ids.ts`
  остаются на `string` (Р-КГ-5); ключи журнала `actor_user_id`/`actor_kind` (имя по D11); `actorKind: 'owner'`,
  `ownerOnlyProcedure` — проверка транспорта «человек по JWT», а не гранта (спека §2; долг ступени 2 — §6).

**Интерфейсы:**

*Consumes* (Г-2): таблицы `graphs`/`graph_members`, политика `scheduler_reads_members` и `GRANT SELECT … TO orbis_app`;
`agentGrants.issuedBy` (nullable); хелперы `mintGraph`/`freshGraph`/`ensureGraphs`; `graphIdsForScheduler` (Г-1).

*Produces* (на это опираются Г-4, Г-5 и будущая правка плана Б-2 — имена идут в `handoff-b2.md`):
```ts
// packages/shared/src/ids.ts
export type AccountId = string & { readonly [accountIdBrand]: true };  // кто действует
export type GraphId   = string & { readonly [graphIdBrand]: true };    // в чьих данных
// apps/server/src/identity.ts
export interface Identity { readonly actor: AccountId; readonly graph: GraphId }
export function parseAccountId(raw: string): AccountId          // UUID-проверка + нижний регистр; граница внешнего мира
export function parseGraphId(raw: string): GraphId
export function identityOfPerson(sub: AccountId): Identity      // резолвер 1: JWT; ЕДИНСТВЕННОЕ место тождества id
export function identityOfGrant(g: { accountId: AccountId; graphId: GraphId }): Identity   // резолвер 2: Bearer
export async function identitiesForScheduler(db: Db): Promise<Identity[]>                  // резолвер 3: тик
// apps/server/src/db/with-identity.ts
export async function withIdentity<T>(db: Db, who: Identity, fn: (tx: Tx) => Promise<T>): Promise<T>
//   claims = {"sub": who.actor, "role": "authenticated", "graph": who.graph}
// apps/server/src/trpc.ts           Context.identity: Identity | null      (было actorUserId: string | null)
// apps/server/src/executor/types.ts ExecuteRequest.identity: Identity      (было actorUserId: string)
// apps/server/src/tools/dispatch.ts ToolCallCtx.identity: Identity         (было actorUserId: string)
// apps/server/src/oauth/grants.ts
export interface GrantIdentity { grantId: string; accountId: AccountId; graphId: GraphId; scope: GrantScope; label: string }
// apps/server/src/entitlements.ts
export type EntitlementResolver = (subject: AccountId, key: string) => EntitlementDecision;
// apps/server/test/helpers.ts
export function mintGraph(id?: string): GraphId;  export async function freshGraph(): Promise<GraphId>
export function accountOf(graph: GraphId): AccountId          // тестовый близнец резолвера 1
export function personal(graph: GraphId): Identity            // { actor: accountOf(graph), graph }
export async function addMember(graph: GraphId, account: AccountId, kind: 'owner' | 'operator' | 'observer'): Promise<void>
```

- [ ] **Шаг 1: красные тесты резолверов — `apps/server/src/identity.test.ts`.**
```ts
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { adminDb, appDb, truncateAll } from '../test/helpers';
import {
  identitiesForScheduler,
  identityOfGrant,
  identityOfPerson,
  parseAccountId,
  parseGraphId,
} from './identity';

const { db, client } = appDb(); // { db, client } — как во всех сьютах (db/with-identity.test.ts:10)
const ACCOUNT = '0aa00000-0000-4000-8000-0000000000a1';
const GRAPH = '0bb00000-0000-4000-8000-0000000000b1'; // НЕ равен аккаунту намеренно

test('границы внешнего мира: не-UUID отклоняется, регистр нормализуется', () => {
  expect(() => parseAccountId('не uuid')).toThrow(/UUID/);
  expect(() => parseGraphId('')).toThrow(/UUID/);
  expect(parseAccountId(ACCOUNT.toUpperCase())).toBe(ACCOUNT);
  expect(parseGraphId(GRAPH.toUpperCase())).toBe(GRAPH);
});

test('резолвер 1 (JWT): граф человека — его личный граф; тождество id живёт только здесь', () => {
  const who = identityOfPerson(parseAccountId(ACCOUNT));
  expect(who.actor).toBe(ACCOUNT);
  expect(who.graph).toBe(ACCOUNT);
});

test('резолвер 2 (Bearer): оба id — из строки гранта, и они НЕ обязаны совпадать', () => {
  const who = identityOfGrant({ accountId: parseAccountId(ACCOUNT), graphId: parseGraphId(GRAPH) });
  expect(who).toEqual({ actor: ACCOUNT, graph: GRAPH });
});

beforeAll(truncateAll);
afterAll(async () => {
  await truncateAll();
  await client.end(); // незакрытый пул держит прогон
});

test('резолвер 3 (тик): пара берётся из graph_members, а не из равенства id', async () => {
  // Граф, у которого держатель гранта owner — ДРУГОЙ uuid: в бою такого в v1 нет (личный граф),
  // но только так видно, что актор приходит из строки членства, а не копируется из id графа.
  const admin = adminDb();
  await admin.db.transaction(async (tx) => {
    await tx.execute(sql`INSERT INTO graphs (id, owner_kind, owner_ref) VALUES (${GRAPH}::uuid, 'organization', NULL)`);
    await tx.execute(sql`INSERT INTO graph_members (id, graph_id, account_id, grant_kind, issued_by)
      VALUES (gen_random_uuid(), ${GRAPH}::uuid, ${ACCOUNT}::uuid, 'owner', ${ACCOUNT}::uuid)`);
    await tx.execute(sql`INSERT INTO user_settings (graph_id) VALUES (${GRAPH}::uuid)`);
  });
  await admin.client.end();
  const pairs = await identitiesForScheduler(db); // под orbis_app, без идентичности
  expect(pairs).toContainEqual({ actor: ACCOUNT, graph: GRAPH });
  const graphs = pairs.map((p) => p.graph);
  expect(graphs).toEqual([...graphs].sort()); // порядок обхода детерминирован (два деплоя Render)
  expect(new Set(graphs).size).toBe(graphs.length); // один актор на граф
});

test('резолвер 3: граф без строки настроек (онбординг не пройден) тик не обходит', async () => {
  const pairs = await identitiesForScheduler(db);
  // truncateAll восстановил личности процесса как графы БЕЗ user_settings — их в обходе быть не должно
  expect(pairs.every((p) => p.graph === GRAPH)).toBe(true);
});
```
  Прогон: `cd /Users/birzhan/projects/orbis/.claude/worktrees/graph-ownership-g/apps/server && bun test src/identity.test.ts` → **красный**: модуля `./identity` нет.

- [ ] **Шаг 2: бренды — `packages/shared/src/ids.ts`.** В начало файла, после шапки (экспорт наружу идёт через
  `packages/shared/src/index.ts` — проверить, что `ids` реэкспортируется целиком):
```ts
// Два идентификатора транзакции (D44, спека «граф как единица владения» §3.5). БРЕНДЫ, а не алиасы:
// в личном графе значения совпадают, смысл — нет, и перепутать их компилятор обязан не дать.
// Значение бренда рождается только на границе внешнего мира (parseAccountId / parseGraphId в
// apps/server/src/identity.ts); переход AccountId → GraphId — только резолвер личного графа там же.
declare const accountIdBrand: unique symbol;
declare const graphIdBrand: unique symbol;
/** id аккаунта (`auth.users`) — КТО действует: актор транзакции, субъект тарифа, `actor_user_id` журнала. */
export type AccountId = string & { readonly [accountIdBrand]: true };
/** id графа — В ЧЬИХ ДАННЫХ идёт транзакция: ключ строк, реестра, замков, формул `uuidv5`. */
export type GraphId = string & { readonly [graphIdBrand]: true };
```

- [ ] **Шаг 3: резолверы — `apps/server/src/identity.ts`.**
```ts
// apps/server/src/identity.ts
// Идентичность транзакции: аккаунт-актор и текущий граф (D44, спека §3.5).
//
// Пара рождается РОВНО в трёх резолверах этого файла; любое приведение GraphId ↔ AccountId вне
// него — дефект (греп-гейт — identity.test / шаг 12 задачи Г-3). Файл лежит в корне src, а не в
// db/: резолверы знают про гранты и членство, а db/with-identity.ts обязан оставаться листом —
// его тип Tx импортирует весь сервер (обязательство «изоляция auth от type-графа router»).
import type { AccountId, GraphId } from '@orbis/shared';
import { sql } from 'drizzle-orm';
import type { Db } from './db/client';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface Identity {
  /** Аккаунт, от чьего имени идёт транзакция: `sub` claims, `actor_user_id` журнала. */
  readonly actor: AccountId;
  /** Граф, в котором идёт транзакция: ставит СЕРВЕР, не клиент и не политика. */
  readonly graph: GraphId;
}

/** Граница внешнего мира (JWT `sub`, строка БД, аргумент CLI) → аккаунт. Регистр — нижний, как у `sub`. */
export function parseAccountId(raw: string): AccountId {
  if (!UUID_RE.test(raw)) throw new Error(`parseAccountId: не UUID: ${JSON.stringify(raw)}`);
  return raw.toLowerCase() as AccountId;
}

/** Граница внешнего мира → граф. Тот же регистр, что у аккаунта: иначе GUC графа и `auth.uid()` разойдутся. */
export function parseGraphId(raw: string): GraphId {
  if (!UUID_RE.test(raw)) throw new Error(`parseGraphId: не UUID: ${JSON.stringify(raw)}`);
  return raw.toLowerCase() as GraphId;
}

/**
 * Личный граф аккаунта. ЕДИНСТВЕННОЕ место в коде, где живёт тождество id: его держит CHECK
 * `graphs_personal_identity` (id = owner_ref), а «один личный граф на аккаунт» следует из PK.
 */
function personalGraphOf(account: AccountId): GraphId {
  return account as string as GraphId;
}

/** Резолвер 1 — JWT человека: актор — `sub`, граф — его личный граф. */
export function identityOfPerson(sub: AccountId): Identity {
  return { actor: sub, graph: personalGraphOf(sub) };
}

/** Резолвер 2 — Bearer агента: актор — аккаунт, выдавший грант (`issued_by`), граф — `graph_id` гранта. */
export function identityOfGrant(grant: { accountId: AccountId; graphId: GraphId }): Identity {
  return { actor: grant.accountId, graph: grant.graphId };
}

/**
 * Резолвер 3 — тик планировщика: пары «граф, держатель гранта owner».
 *
 * Идёт под `orbis_app` БЕЗ идентичности (0013). Список графов — по-прежнему `user_settings`
 * («онбординг пройден»; политика `scheduler_reads_owner_list`), актор — из `graph_members`
 * (политика `scheduler_reads_members`, 0020). В v1 владелец у графа один; при нескольких берётся
 * самый ранний грант — кто актор рутины в графе с несколькими владельцами, решает ступень 2.
 * Порядок по графу фиксирован намеренно: два сосуществующих деплоя Render обходят одинаково.
 */
export async function identitiesForScheduler(db: Db): Promise<Identity[]> {
  const rows = await db.execute(sql`
    SELECT DISTINCT ON (us.graph_id) us.graph_id::text AS graph, gm.account_id::text AS actor
    FROM user_settings us
    JOIN graph_members gm
      ON gm.graph_id = us.graph_id AND gm.grant_kind = 'owner' AND gm.revoked_at IS NULL
    ORDER BY us.graph_id, gm.issued_at, gm.id`);
  return rows.map((r) => ({
    actor: parseAccountId(String(r.actor)),
    graph: parseGraphId(String(r.graph)),
  }));
}
```
  Прогон: `cd /Users/birzhan/projects/orbis/.claude/worktrees/graph-ownership-g/apps/server && bun test src/identity.test.ts` → зелёный.

- [ ] **Шаг 4: красные тесты `withIdentity` — дописать в `apps/server/src/db/with-identity.test.ts`.** Существующие пять
  кейсов переводятся на пару (шаг 8); новые — близнец interleaved-теста (`:81`) на граф и тип-пины:
```ts
test('interleaved: текущий граф A и B на одном пуле не путается (близнец теста identity)', async () => {
  const graphOf = sql`SELECT (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'graph') AS graph`;
  const [a, b] = await Promise.all([
    // pg_sleep в ПЕРВОЙ ветке обязателен: именно он заставляет соединения пересечься
    withIdentity(db, personal(userA), (tx) =>
      tx.execute(sql`SELECT (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'graph') AS graph,
                            pg_sleep(0.05)`),
    ),
    withIdentity(db, personal(userB), (tx) => tx.execute(graphOf)),
  ]);
  expect(a[0]?.graph).toBe(userA);
  expect(b[0]?.graph).toBe(userB);
});

test('текущий граф умирает вместе с транзакцией: снаружи GUC пуст на каждом соединении пула', async () => {
  await withIdentity(db, personal(userA), async () => undefined);
  for (let i = 0; i < 5; i++) {
    const rows = await db.execute(
      sql`SELECT (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'graph') AS graph`,
    );
    expect(rows[0]?.graph ?? null).toBeNull();
  }
});

test('актор и граф — разные значения claims: sub = актор, graph = граф', async () => {
  const who = { actor: accountOf(userB), graph: userA };
  const rows = await withIdentity(db, who, (tx) =>
    tx.execute(sql`SELECT auth.uid()::text AS uid,
      (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'graph') AS graph`),
  );
  expect(rows[0]).toEqual({ uid: userB, graph: userA });
});

test('сигнатура: один id вместо пары не компилируется (спека Ш-2)', () => {
  // @ts-expect-error — GraphId вместо Identity
  void (() => withIdentity(db, userA, async () => 1));
  // @ts-expect-error — актор обязан быть AccountId, граф на его месте — ошибка типа
  void (() => withIdentity(db, { actor: userA, graph: userA }, async () => 1));
  expect(true).toBe(true);
});
```
  `@ts-expect-error` пинит `bun run typecheck`: если сигнатура ослабнет, директива станет неиспользуемой (`TS2578`) и типы
  покраснеют. Прогон файла → **красный** (старая сигнатура, хелперов `personal`/`accountOf` нет).

- [ ] **Шаг 5: `withIdentity` с парой и GUC текущего графа — `apps/server/src/db/with-identity.ts`.**
```ts
import type { Identity } from '../identity'; // import type — стирается: db/ остаётся листом

export async function withIdentity<T>(
  db: Db,
  who: Identity,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  if (!UUID_RE.test(who.actor)) {
    throw new Error(`withIdentity: actor не UUID: ${JSON.stringify(who.actor)}`);
  }
  if (!UUID_RE.test(who.graph)) {
    throw new Error(`withIdentity: graph не UUID: ${JSON.stringify(who.graph)}`);
  }
  return db.transaction(async (tx) => {
    // Текущий граф — ключом ВНУТРИ тех же claims (спека §3.5): один set_config, одно время жизни с
    // `sub` (is_local = true: умирает на commit И на rollback). Регистр — нижний, как у `sub`: иначе
    // `current_graph_id()` политик и `auth.uid()` разошлись бы на UUID в верхнем регистре.
    const claims = JSON.stringify({
      sub: who.actor.toLowerCase(),
      role: 'authenticated',
      graph: who.graph.toLowerCase(),
    });
    await tx.execute(sql`SELECT set_config('request.jwt.claims', ${claims}, true)`);
    await tx.execute(sql`SET LOCAL ROLE authenticated`);
    return fn(tx);
  });
}
```
  Докблок файла: добавить абзац «у транзакции два идентификатора (D44): `sub` — аккаунт-актор, `graph` — текущий граф;
  политики до миграции 0021 ключ `graph` игнорируют».

- [ ] **Шаг 6: тестовые хелперы — `apps/server/test/helpers.ts`.** `mintGraph`/`freshGraph` отдают `GraphId`
  (`parseGraphId` — граница внешнего мира для тестов); добавить близнеца резолвера 1 и фикстуру членства:
```ts
import type { AccountId, GraphId } from '@orbis/shared';
import { type Identity, parseAccountId, parseGraphId } from '../src/identity';

export function mintGraph(id: string = crypto.randomUUID()): GraphId {
  MINTED.add(id);
  return parseGraphId(id);
}
export async function freshGraph(): Promise<GraphId> { /* тело прежнее */ }

/** Аккаунт — держатель личного графа: тестовый близнец резолвера `identityOfPerson`. */
export function accountOf(graph: GraphId): AccountId {
  return parseAccountId(graph);
}
/** Пара «человек в своём личном графе» — чем в тестах был голый id владельца. */
export function personal(graph: GraphId): Identity {
  return { actor: accountOf(graph), graph };
}
/** Фикстура «граф ≠ аккаунт»: второй аккаунт получает грант в чужом графе (админ-DSN; у authenticated такого пути нет). */
export async function addMember(
  graph: GraphId,
  account: AccountId,
  kind: 'owner' | 'operator' | 'observer',
): Promise<void> {
  const { db, client } = adminDb();
  try {
    await db.execute(sql`INSERT INTO graph_members (id, graph_id, account_id, grant_kind, issued_by)
      VALUES (gen_random_uuid(), ${graph}::uuid, ${account}::uuid, ${kind}, ${graph}::uuid)`);
  } finally {
    await client.end();
  }
}
```

- [ ] **Шаг 7: транспорт — `trpc.ts`, `context.ts`, `oauth/grants.ts`, `mcp/`.**
  `trpc.ts`: в `Context` поле `actorUserId: string | null` → `identity: Identity | null` (`import type { Identity } from
  './identity'`); комментарий `:8` — «Identity течёт только через request-контекст: пара „актор + текущий граф“ (D44); ключ
  журнала по-прежнему `actor_user_id` (D11)»; `protectedProcedure` (`:117-120`):
```ts
export const protectedProcedure = publicProcedure.use(({ ctx, next }) => {
  if (!ctx.identity) throw new TRPCError({ code: 'UNAUTHORIZED' });
  return next({ ctx: { identity: ctx.identity } });
});
```
  `oauth/grants.ts`: `GrantIdentity` (`:26-33`) → форма из блока Produces; докблок `GrantRef` (`:35-40`) переписать — «минус
  ПАРА: актор и граф ниже транспорта едут одним значением `identity`, и второй их экземпляр в гранте стал бы второй
  правдой» (`GrantRef` НЕ расширять). `verifyBearer` (`:120-141`) — `returning` и сборка:
```ts
    .returning({
      id: agentGrants.id,
      graphId: agentGrants.graphId,
      issuedBy: agentGrants.issuedBy,
      scope: agentGrants.scope,
      label: agentGrants.label,
    });
  const row = rows[0];
  if (!row) return null;
  // issued_by NULLABLE до миграции 0021 (Р-КГ-2): грант без выдавшего аккаунта — не «актор = граф»,
  // а отказ (fail-closed). После 0021 ветка недостижима и снимается задачей Г-4.
  if (row.issuedBy === null) return null;
  return {
    grantId: row.id,
    accountId: parseAccountId(row.issuedBy),
    graphId: parseGraphId(row.graphId),
    scope: row.scope as GrantScope,
    label: row.label,
  };
```
  Места выдачи — пишут `issued_by` (спека §3.4): `createAuthorizationCode(db, input: { identity: Identity; clientId; label;
  redirectUri; codeChallenge; scope })` → `graphId: input.identity.graph, issuedBy: input.identity.actor`;
  `issuePatGrant(db, input: { identity: Identity; label; scope? })` — так же. **Обе функции первым действием проверяют, что
  выдающий держит грант `owner`** (спека §3.4: «иначе operator выписал бы агенту full-грант»): политика `agent_grants` для
  `authenticated` (Г-4) боевой путь не закрывает — выдача идёт под `orbis_app` с `server_manages_grants USING(true)` (Ф-Г-17),
  и условие обязан держать код:
```ts
/**
 * Грант агенту выписывает ТОЛЬКО держатель гранта owner (D44, спека §3.4): иначе operator выдал бы
 * агенту full-доступ шире собственного. RLS здесь не помощник — выдача идёт под `orbis_app`
 * (`server_manages_grants`, 0005:35), поэтому условие держит код. Читает `graph_members` той же
 * служебной ролью (политика `scheduler_reads_members`, 0020). В v1 владелец личного графа — всегда
 * сам аккаунт, и отказ недостижим; он станет достижим с первым грантом `operator` (ступень 2).
 */
export class NotGraphOwnerError extends Error {
  constructor(graph: string) {
    // Две причины под одним отказом, и текст называет обе: у `ops.ts issue-pat` достижима первая
    // (аккаунт ещё не заходил — личного графа нет), вторая — с первым грантом operator (ступень 2).
    super(`нет действующего гранта owner в графе ${graph}: граф не заведён либо грант выдающего — не owner`);
    this.name = 'NotGraphOwnerError';
  }
}

async function assertHoldsOwnerGrant(db: Db, who: Identity): Promise<void> {
  const rows = await db.execute(sql`SELECT 1 FROM graph_members
    WHERE graph_id = ${who.graph}::uuid AND account_id = ${who.actor}::uuid
      AND grant_kind = 'owner' AND revoked_at IS NULL LIMIT 1`);
  if (rows.length === 0) throw new NotGraphOwnerError(who.graph);
}
```
  Красный тест — в `apps/server/src/oauth/grants.test.ts`: `const A = await freshGraph(); const B = await freshGraph(); await
  addMember(A, accountOf(B), 'operator');` → `issuePatGrant(db, { identity: { actor: accountOf(B), graph: A }, label: 'x' })` и
  `createAuthorizationCode(…)` с той же парой — `rejects.toBeInstanceOf(NotGraphOwnerError)`, строк в `agent_grants` с
  `graph_id = A` — ноль; с `personal(A)` — выдаётся, строка несёт `issued_by = accountOf(A)`. В `routers/oauth.ts:122-129`
  (`consent`) отказ переводится в `TRPCError({ code: 'FORBIDDEN' })`, а не уходит 500; `scripts/ops.ts issue-pat` и
  `scripts/issue-pat.ts` печатают текст отказа и выходят с кодом 1.
  **ОБЯЗАТЕЛЬНЫЙ второй кейс — аккаунт БЕЗ графа** (правка 21.09 по гейт-ревью Г-2, Important-1, Р-ИГ-7). Миграция
  `0020` завела FK `agent_grants.graph_id → graphs.id`, и путь «согласие OAuth до онбординга» стал падать сырым
  `23503` → 500: экран согласия рендерится ВНЕ `OnboardingGate` (`apps/web/src/main.tsx:31-43`, «согласие не требует
  онбординга»), то есть личного графа у аккаунта может ещё не быть. `assertHoldsOwnerGrant` закрывает это
  типизированным отказом — именно его первая причина («граф не заведён»), — но ТОЛЬКО если он проверяется тестом:
  прежний пин `oauth.e2e.test.ts` после Г-2 берёт граф из `mintGraph()` и дыру больше не видит. Поэтому в
  `grants.test.ts` завести кейс на `const noGraph = parseAccountId(crypto.randomUUID())` (аккаунт, у которого строки в
  `graphs` НЕТ): `issuePatGrant` и `createAuthorizationCode` с `identityOfPerson(noGraph)` → `NotGraphOwnerError`, в
  `agent_grants` ноль строк, `23503` наружу НЕ уходит; в `routers/oauth.ts` тот же кейс даёт `FORBIDDEN`, а не 500.
  Этим же закрывается `ops.ts issue-pat` (Minor-3 гейта Г-2): он сверяет аргумент с `auth.users`, но не с `graphs` —
  после правки незасиденный аккаунт получает текст отказа и код 1 вместо сырого `23503`.
  ЧЕГО ЗДЕСЬ НЕ ДЕЛАТЬ: заводить личный граф неявно на пути согласия — прод-код графы сам не создаёт (спека §3.5,
  Р-КГ-3); и не трогать `apps/web` — порядок экранов согласия и онбординга решает владелец (строка в `03-pending`, Г-5). Вызывающие: `routers/oauth.ts:124` →
  `identity: ctx.identity`; `scripts/issue-pat.ts:22` и `scripts/ops.ts:580` (вызовы `issuePatGrant`; разбор аргумента — `issue-pat.ts:10,19`) — аргумент
  CLI есть id АККАУНТА (в `ops.ts:571-579` он сверяется с `auth.users`): `identityOfPerson(parseAccountId(arg))`, справку скриптов уточнить («uuid аккаунта; грант
  выдаётся на его личный граф»). `listGrants(db, graph: GraphId)`, `revokeGrant(db, { grantId, graph: GraphId })` — предикат
  остаётся на `graph_id` («грант текущего графа»); докблок `revokeGrant` (`:347-359`): «условие на `graph_id` — единственное,
  что не даёт отозвать грант чужого графа; RLS под `orbis_app` не подстрахует».
  `context.ts` (`:34-58`) — оба транспортных сайта рождения пары зовут резолверы:
```ts
      const grant = await verifyBearer(db, token);
      return {
        identity: grant === null ? null : identityOfGrant(grant),
        actorKind: 'agent',
        ...(grant !== null && { grant: { id: grant.grantId, scope: grant.scope, label: grant.label } }),
        db, clientVersion, ...aiDeps,
      };
    }
    const sub = token ? await verifyAccessToken(token) : null;
    return {
      identity: sub === null ? null : identityOfPerson(parseAccountId(sub)),
      actorKind: 'owner',
      db, clientVersion, ...aiDeps,
    };
```
  `mcp/server.ts` (`:49-106`): строка слияния `const ownerId/graphId = identity.…` (`:51`) заменяется одной —
  `const who = identityOfGrant(identity);` — и расходится по ролям явно: `withIdentity(deps.db, who, (tx) =>
  buildToolRegistry(tx, who.graph))` (`:59`), `gateAgentRequest(resolve, who.actor)` (`:96`, субъект тарифа — аккаунт, Р-КГ-6),
  `dispatchTool({ db, identity: who, actorKind: 'agent', grant: {…}, … })` (`:102`). Это ЧЕТВЁРТЫЙ сайт рождения пары при трёх
  резолверах (Ф-Г-16): оба Bearer-сайта обязаны звать один `identityOfGrant`, собирать пару руками нельзя.

- [ ] **Шаг 8: исполнитель, диспатч, планировщик — поле `identity` и ужесточённые листья.** Сначала листья — всё, что
  ключуется графом или аккаунтом, получает бренд в сигнатуре:

| Лист | Было → стало |
|---|---|
| `executor/types.ts:51` | `actorUserId: string` → `identity: Identity` (докблок: «актор — аккаунт, граф — текущий; в личном графе значения равны») |
| `tools/dispatch.ts:139` | `actorUserId: string` → `identity: Identity` |
| `agent-loop/verbs.ts:82-88` `VerbCtx` | поле id → `identity: Identity` |
| `agent-loop/sweep.ts` `SweepArgs`, `routines/runner.ts:115` `RunRoutineRunArgs`, `routines/lifecycle.ts` аргументы с `withIdentity` | `graphId: string` → `identity: Identity` |
| `registry/ops.ts:2728` `lockOwnerRegistry`, `budget/binding.ts:687` `lockOwnerBudget`, `executor/relations.ts:150-157` | параметр ключа замка → `graph: GraphId` |
| `registry/cache.ts:103,114` `cacheKey`, `effectiveRegistry` | `(tx, graph: GraphId)` |
| `query/compile-ast.ts:87-96` `CompileCtx` | `graphId: GraphId` — источник `$owner` языка E (спека §2: `$owner` — id ТЕКУЩЕГО ГРАФА) |
| `query/context.ts:41,61` `ownerTimeZone`, `queryContext` | `(tx, graph: GraphId, …)` |
| `chat/threads.ts:32,38` `ensureGlobalThread`, `ensureEntityThread` | `(tx, graph: GraphId, …)`; сообщение ошибки `:26-27` — «тред не виден после вставки: текущий граф транзакции ≠ граф треда» |
| `executor/journal.ts` `JournalWrite` | поле ключа сообщения → `graphId: GraphId` |
| `entitlements.ts:14` | `(subject: AccountId, key: string)` |
| `ai/metering.ts:36` `recordUsage` | `{ identity: Identity, … }`: строка `ai_usage` — на `identity.graph` (расход на граф, В-Г-4) |
| `export.ts:77` `exportData` | `(tx, graph: GraphId, clock)` |
| `seed/*` `seedOwner`, `seedOwnerGraph`, `seedOwnerWorld`, `seedGardener` | `(db, who: Identity, …)`; `ensurePersonalGraph(tx, who.actor)` |

  Затем корни — где пара расходится по ролям (Ф-Г-16; в Г-1 эти сайты помечены «стык» в `rename-ledger.md`):
  `executor.ts:263-268` `compileCtxOf` → `graphId: ctx.req.identity.graph`; `:486,621,731` → `withIdentity(db, req.identity, …)`;
  `:496-498,630-632` замки → `req.identity.graph`; `:992` → `resolveEntitlement(ctx.req.identity.actor, …)`; журнал
  `:706-712,1004-1010` → `actor_user_id: req.identity.actor`; владелец сообщения `:719,1016` → `graphId: req.identity.graph`;
  `recurring/with-materialization.ts:50` и `query/context.ts:66-70` — граф; вызовы entitlements `tools/dispatch.ts:637,2021`,
  `routines/lifecycle.ts:879`, `mcp/server.ts:96,151-153`, `ai/send-message.ts:555-556`, `import/review.ts:86-87` — `identity.actor`.
  `routines/scheduler.ts:65-105`: `const owners = await identitiesForScheduler(deps.db)`; цикл `for (const who of owners)`;
  `sweepStaleRuns(deps.db, { identity: who, actorKind: 'ai', clock })`; `withIdentity(deps.db, who, …)`;
  `ownerTimeZone(tx, who.graph)`; тексты логов — «граф ${who.graph}». `routines/queries.ts`: `graphIdsForScheduler` снять
  целиком вместе с докблоком `:8-23` (его содержание переехало в докблок `identitiesForScheduler`); тест
  `routines/queries.test.ts:79` перевести на `identitiesForScheduler` (пары, порядок, уникальность графов).
  **Правило прохода — компилятор, не глаза:**
```
cd /Users/birzhan/projects/orbis/.claude/worktrees/graph-ownership-g && bun run typecheck 2>&1 | grep -c 'error TS'
```
  Каждая ошибка чинится ИЗМЕНЕНИЕМ ТИПА параметра/поля выше по цепочке (`string` → `GraphId` / `AccountId` / `Identity`) до
  ближайшего резолвера; **приведением (`as GraphId`, `as AccountId`, `as unknown as`, `parse*` от значения другого бренда) —
  никогда**. Функция, которая и зовёт `withIdentity`, и ключует строки, принимает `who: Identity` и берёт `who.graph`.
  Тесты — механически, затем по ошибкам типов:
```
cd /Users/birzhan/projects/orbis/.claude/worktrees/graph-ownership-g && git grep -lE 'withIdentity\(|actorUserId' -- 'apps/server/**/*.test.ts' apps/server/test apps/server/src/test apps/server/perf > /Users/birzhan/projects/orbis/.superpowers/sdd/2026-09-20-graph-ownership/g3-tests.txt
cd /Users/birzhan/projects/orbis/.claude/worktrees/graph-ownership-g && xargs perl -pi -e 's/\bactorUserId: null\b/identity: null/g; s/\bactorUserId: ([A-Za-z_][\w.]*)/identity: personal($1)/g; s/withIdentity\(([A-Za-z_][\w.]*), ([A-Za-z_][\w.]*),/withIdentity($1, personal($2),/g' < /Users/birzhan/projects/orbis/.superpowers/sdd/2026-09-20-graph-ownership/g3-tests.txt
```
  18 локальных `callerFor(user)` и 2 модульных `ownerCaller` (`recon-4` §1) собирают `Context` литералом — после замены
  дают `identity: personal(user)`; ожидания `ctx.actorUserId` в `context.test.ts:65-154` → `ctx.identity?.actor` и
  `ctx.identity?.graph` (кейс PAT `:83` — актор = `issued_by` гранта, граф = `graph_id` гранта; для этого фикстура гранта в
  `context.test.ts`/`src/test/agent-loop-helpers.ts:183` выдаётся через `issuePatGrant(db, { identity: personal(owner), … })`).
  Скрипты: `scripts/llm-smoke.ts:89-95` — `identityOfPerson(parseAccountId(process.env.ORBIS_SMOKE_OWNER_ID))`;
  `scripts/probe-p4.ts:491` — так же от `crypto.randomUUID()`.

- [ ] **Шаг 9: поведенческий тест «граф ≠ аккаунт» — `apps/server/test/graph-vs-account.test.ts` (спека §3.5).**
  `test.failing` в Bun 1.2.7 — только с синхронным телом, поэтому сюжеты снимаются в `beforeAll`, проверки синхронны
  (Р-КГ-11). Два сюжета из четырёх красны ДО миграции 0021 — они и есть гейт Г-4:
```ts
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { withIdentity } from '../src/db/with-identity';
import { execute } from '../src/executor/executor';
import { accountOf, addMember, adminDb, appDb, freshGraph, personal, truncateAll } from './helpers';

const { db, client } = appDb();

/** Код ошибки Postgres — у drizzle он лежит либо в `code`, либо в `cause.code`. */
const pgCode = (e: unknown): string =>
  (e as { code?: string }).code ?? (e as { cause?: { code?: string } }).cause?.code ?? 'THROW';

/**
 * До миграции 0021 старые политики отвечают на пару {actor: Б, graph: А} ИСКЛЮЧЕНИЕМ 42501, а не
 * структурированным отказом: исполнитель превращает в `{ ok: false }` только `ExecError`
 * (executor.ts:563-567), а `ensureThread` бросает обычный `Error` (chat/threads.ts:25-28). Каждый
 * сюжет снимается СВОИМ перехватом — иначе упавший первый съел бы три остальных, и два сюжета,
 * обязанных быть зелёными уже в Г-3, покраснели бы вместе с помеченными.
 */
async function capture<T>(run: () => Promise<T>, onThrow: (code: string) => T): Promise<T> {
  try {
    return await run();
  } catch (e) {
    return onThrow(`throw:${pgCode(e)}`);
  }
}
const seen = {
  graphA: '', accountB: '',
  bReadsA: -1, bWriteInA: 'не запускалось', journalActor: '', journalGraph: '',
  bInOwnGraphSeesA: -1, bUpdatesAById: 'не запускалось', withoutGraph: -1,
};

beforeAll(async () => {
  await truncateAll();
  const A = await freshGraph();
  const B = await freshGraph();
  await addMember(A, accountOf(B), 'operator'); // аккаунт Б — оператор в личном графе А
  seen.graphA = A;
  seen.accountB = accountOf(B);
  const created = await execute(db, {
    identity: personal(A), actorKind: 'owner', source: 'ui',
    operations: [{ tool: 'entity_create', input: { title: 'запись графа А' } }],
  });
  if (!created.ok) throw new Error(`фикстура не создана: ${created.error.message}`);
  const rowOfA = (created.results[0] as { id: string }).id;
  const bInA = { actor: accountOf(B), graph: A };

  // (1) Б в графе А: чтение, запись, журнал
  seen.bReadsA = await capture(
    async () =>
      Number((await withIdentity(db, bInA, (tx) => tx.execute(sql`SELECT count(*)::int AS n FROM entities`)))[0]?.n),
    () => -1,
  );
  seen.bWriteInA = await capture(async () => {
    const written = await execute(db, {
      identity: bInA, actorKind: 'owner', source: 'ui',
      operations: [{ tool: 'entity_create', input: { title: 'запись Б в графе А' } }],
    });
    return written.ok ? 'ok' : written.error.code;
  }, (code) => code);
  const admin = adminDb();
  const journal = await admin.db.execute(sql`
    SELECT m.metadata -> 'actions' -> 0 ->> 'actor_user_id' AS actor, t.graph_id::text AS graph
    FROM chat_messages m JOIN chat_threads t ON t.id = m.thread_id
    WHERE m.metadata -> 'actions' -> 0 ->> 'actor_user_id' = ${accountOf(B)}`);
  seen.journalActor = String(journal[0]?.actor ?? '');
  seen.journalGraph = String(journal[0]?.graph ?? '');
  // (2) Б в СВОЁМ графе строк А не видит
  seen.bInOwnGraphSeesA = await capture(
    async () =>
      Number((await withIdentity(db, personal(B), (tx) =>
        tx.execute(sql`SELECT count(*)::int AS n FROM entities WHERE id = ${rowOfA}::uuid`)))[0]?.n),
    () => -1,
  );
  // (3) мутация строки по id в НЕТЕКУЩЕМ графе
  seen.bUpdatesAById = await capture(async () => {
    const foreign = await execute(db, {
      identity: personal(B), actorKind: 'owner', source: 'ui',
      operations: [{ tool: 'entity_update', input: { id: rowOfA, title: 'перехват' } }],
    });
    return foreign.ok ? 'ok' : foreign.error.code;
  }, (code) => code);
  // (4) чтение БЕЗ текущего графа: claims с `sub`, но без ключа `graph`
  seen.withoutGraph = await capture(
    async () =>
      Number((await db.transaction(async (tx) => {
        const claims = JSON.stringify({ sub: accountOf(A), role: 'authenticated' });
        await tx.execute(sql`SELECT set_config('request.jwt.claims', ${claims}, true)`);
        await tx.execute(sql`SET LOCAL ROLE authenticated`);
        return tx.execute(sql`SELECT count(*)::int AS n FROM entities`);
      }))[0]?.n),
    () => -1,
  );
  await admin.client.end();
});

afterAll(async () => {
  await client.end();
});

describe('граф ≠ аккаунт (спека §3.5; гейт миграции 0021)', () => {
  // ПОМЕТКА Г-3 → Г-4: под старыми политиками `graph_id = auth.uid()` пара {actor: Б, graph: А}
  // упирается в RLS. Зелёным сюжет становится с миграцией 0021 — тогда `test.failing` → `test`.
  test.failing('под {actor: Б, graph: А} чтение и запись проходят, журнал пишет актора Б в треде графа А', () => {
    expect(seen.bReadsA).toBe(1);
    expect(seen.bWriteInA).toBe('ok');
    expect(seen.journalActor).toBe(seen.accountB);
    expect(seen.journalGraph).toBe(seen.graphA);
  });
  test('под {actor: Б, graph: Б} строки А не видны', () => {
    expect(seen.bInOwnGraphSeesA).toBe(0);
  });
  test('мутация строки по id в нетекущем графе — отказ', () => {
    expect(seen.bUpdatesAById).toBe('NOT_FOUND');
  });
  // ПОМЕТКА Г-3 → Г-4: старые политики читают только `sub` и отдают строки без текущего графа.
  test.failing('чтение без текущего графа — пусто (fail-closed)', () => {
    expect(seen.withoutGraph).toBe(0);
  });
});
```
  (Форму входа `entity_create`/`entity_update` и значение `source` сверить с `apps/server/src/executor/executor.test.ts:133-145` и типом
  `MutationSource`; код отказа чужой строки — тот, что даёт исполнитель на невидимую под RLS запись, сегодня `NOT_FOUND`.)
  Прогон: `cd /Users/birzhan/projects/orbis/.claude/worktrees/graph-ownership-g/apps/server && bun test test/graph-vs-account.test.ts` → 2 pass, 2 «expected fail» — и ни одного fail.
  В Г-3 `seen.bWriteInA` равен `throw:42501` (старая политика отвечает исключением) — это ожидаемое красное состояние
  помеченного сюжета, а не поломка теста; два непомеченных сюжета обязаны быть зелёными уже сейчас.

- [ ] **Шаг 10: типы, линт, точечные прогоны.**
```
cd /Users/birzhan/projects/orbis/.claude/worktrees/graph-ownership-g && bun run typecheck
cd /Users/birzhan/projects/orbis/.claude/worktrees/graph-ownership-g && bun run lint
cd /Users/birzhan/projects/orbis/.claude/worktrees/graph-ownership-g/apps/server && bun test src/identity.test.ts src/db/with-identity.test.ts src/context.test.ts src/oauth/grants.test.ts src/mcp/mcp.test.ts src/routines/queries.test.ts src/executor/journal.test.ts test/graph-vs-account.test.ts
```
  Ожидание: typecheck — EXIT=0 (включая оба `@ts-expect-error`); точечные — зелёные.

- [ ] **Шаг 11: пины «по графу, а не по актору» — там, где тест возможен.** Бренды закрывают сигнатуры; поведение пинится
  на паре с РАЗНЫМИ значениями (`bInA` из шага 9 недоступна до Г-4 из-за RLS, поэтому — модульные тесты без базы):
  в `apps/server/src/registry/cache.test.ts` — «ключ кеша реестра — граф: два актора одного графа делят снимок»
  (`cacheKey`/`effectiveRegistry` зовутся с одним `GraphId`, сигнатура актора не принимает — `@ts-expect-error` на
  `effectiveRegistry(tx, accountOf(g))`); в `apps/server/src/executor/journal.test.ts` — к существующему кейсу `:132` добавить
  ожидание `entry.graphId` = граф, `entry.action.actor_user_id` = актор на `InMemoryJournalSink` с парой `{actor: X, graph: Y}`
  (синк в базу не ходит — RLS не мешает). В отчёте «Пины и мутации» назвать мутацию на каждый: `graphId: req.identity.actor`
  в `executor.ts:719` → красный `journal.test.ts`; `subject` ← `identity.graph` в `executor.ts:992` → красный typecheck.

- [ ] **Шаг 12: греп-гейт приведений (спека Ш-2: «вне резолверов — ноль»).** Флаг — `-P`, и это не стиль
  (правка 21.09 по исполнению Г-3, Ф-Г-40): у `git grep -E` НЕТ словарной границы `\b`, и три команды ниже в
  прежней записи (`-nE`) были пусты при ЛЮБОМ коде — ложный пин того же класса, что Ф-Г-37. Прежде чем верить
  пустому выводу, проверь команду на заведомо ловимой строке.
```
cd /Users/birzhan/projects/orbis/.claude/worktrees/graph-ownership-g && git grep -nP 'as (GraphId|AccountId)\b|as unknown as (GraphId|AccountId|Identity)' -- apps/server/src packages/shared/src scripts ':!apps/server/src/identity.ts' ':!*.test.ts' ':!apps/server/src/test/**'
cd /Users/birzhan/projects/orbis/.claude/worktrees/graph-ownership-g && git grep -nP '\bparse(GraphId|AccountId)\(' -- apps/server/src scripts ':!apps/server/src/identity.ts' ':!*.test.ts' ':!apps/server/src/test/**'
cd /Users/birzhan/projects/orbis/.claude/worktrees/graph-ownership-g && git grep -nP '\bactorUserId\b' -- apps/server/src ':!*.test.ts' | grep -v 'actor_user_id' | head
```
  Ожидание: первая — ПУСТО; вторая — только границы внешнего мира: `context.ts` (JWT `sub`), `oauth/grants.ts` (строка гранта),
  `db/seed-registries.ts:416,421` (строка `registry_deltas`, прочитанная пересевом под админом: `bumpOwnerRegistryVersion` и
  `ensureGlobalThread` получают `parseGraphId(row.graphId)` — четвёртый законный источник id графа, строка БД),
  `scripts/{ops,issue-pat,llm-smoke,probe-p4}.ts` (аргумент CLI / env); третья — только поле `actorUserId` колонки
  `entity_versions` в `db/schema.ts` и его писатели (значение — `identity.actor`). Любая другая строка — дефект: значение
  бренда добывается из `identity`, а не изготавливается на месте. Списки — в отчёт и в `facts.md`.

- [ ] **Шаг 13: полный прогон и гейты.**
```
cd /Users/birzhan/projects/orbis/.claude/worktrees/graph-ownership-g && bun run test
cd /Users/birzhan/projects/orbis/.claude/worktrees/graph-ownership-g && bun run test:rls
cd /Users/birzhan/projects/orbis/.claude/worktrees/graph-ownership-g && bun scripts/check-legacy-form.ts --gate
cd /Users/birzhan/projects/orbis/.claude/worktrees/graph-ownership-g && bun run test:perf:volume
cd /Users/birzhan/projects/orbis/.claude/worktrees/graph-ownership-g && bun run test:perf:explain
cd /Users/birzhan/projects/orbis/.claude/worktrees/graph-ownership-g && bun run test:perf:graph
cd /Users/birzhan/projects/orbis/.claude/worktrees/graph-ownership-g && bun run test:perf
```
  Ожидание: `bun run test` — EXIT=0, ровно ДВЕ пометки во всём дереве
  (`git grep -c 'test\.failing(' -- apps/server packages scripts` → один файл, 2; считать вызовы, а не слово — оно есть и в
  комментарии) — обе в `graph-vs-account.test.ts`; pgTAP —
  `plan(125)` без изменений (миграции в задаче нет); внеCI-скрипты — EXIT=0 (они импортируют `withIdentity` и ломаются
  молча — Ф-Г-19); семь медиан — записать.

- [ ] **Шаг 14: коммит.**
```
cd /Users/birzhan/projects/orbis/.claude/worktrees/graph-ownership-g && git add -A && git status --short | head -30 && git commit -m "$(printf 'feat(identity): у транзакции два идентификатора — актор и текущий граф (срез Г, D44, Ш-2)\n\nБрендированные AccountId и GraphId; пара Identity рождается ровно в трёх резолверах\n(identityOfPerson — единственное место тождества id; identityOfGrant — оба Bearer-сайта;\nidentitiesForScheduler — user_settings ⋈ graph_members под orbis_app). withIdentity принимает только\nпару и кладёт текущий граф ключом graph в request.jwt.claims. По графу теперь идут замки реестра,\nбюджета и роли связи, ключ кеша реестра, $owner языка E, тред и сообщение журнала, расход ai_usage;\nпо аккаунту — sub, actor_user_id журнала и субъект entitlements. Грант агента несёт issued_by;\nGrantIdentity = { accountId, graphId, grantId, scope, label }. Поведенческий тест «граф ≠ аккаунт»:\nдва сюжета из четырёх красны С ПОМЕТКОЙ до миграции 0021 — они гейт задачи Г-4.\n\nCo-Authored-By: Claude Opus 5 <noreply@anthropic.com>')"
```
  Закрытие — протокол глобальных ограничений. Мерж в `main` допустим с двумя пометками: автодеплой выключен, старые
  политики GUC игнорируют, `sub` = граф по тождеству id (спека §8.1).

### Задача Г-4: RLS «текущий граф ∧ членство» — 35 политик, две закрытые дыры, pgTAP, перф (Ш-3)

**Зачем:** изоляция перестаёт держаться на равенстве `graph_id = auth.uid()` (оно даёт вечный доступ по тождеству id мимо
членства — спека §3.6) и становится «строка ТЕКУЩЕГО графа ∧ актор держит грант». Обе половины предиката не зависят от
строки и стоят в обёртке `(SELECT …)` — проверка гранта исполняется один раз на запрос (проба Г-0, Ф-Г-23). Без текущего
графа — пусто (fail-closed), кроме встроенных строк реестров. Гейт задачи — поведенческий тест «граф ≠ аккаунт» зелёный
без пометок; перф — против базовой линии Г-0.

**Файлы:**
- Создать: `apps/server/src/db/migrations/0021_graph_rls.sql` (рукописный), `meta/0021_snapshot.json` (сгенерированный).
- Изменить: `apps/server/src/db/schema.ts` (`agentGrants.issuedBy` → `.notNull()`); `apps/server/src/db/reset-world.test.ts:253-254`
  (вставка гранта получает `issued_by`); `apps/server/src/oauth/grants.ts` (снять ветку
  `issuedBy === null`); `apps/server/test/rls/rls.pgtap.sql` (claims с ключом `graph`, фикстуры членства, группа 23, `plan`);
  `apps/server/test/graph-vs-account.test.ts` (снять две пометки); докблоки-читатели имён `owner_owns%` — их два десятка
  (`memory/select.test.ts:203`, `agent-loop/queries.ts:249`, `db/registry-drift.ts:86`, `executor/executor.ts:2818`,
  `perf/volume.test.ts:447,504,793,853`, `perf/explain.test.ts:13,28,190,213`, `ai/metering.ts:5`, `executor/invariants.ts:60`,
  `memory/select.ts:36`, `registry/load.ts:273`, `rls.pgtap.sql:612,639,653` …; полный список — грепом шага 7); `apps/server/perf/explain.test.ts` — докблок `:11-44` (имя
  политики) и пины ТОЛЬКО при изменившемся вердикте (Р-КГ-10).
- НЕ трогать: четыре политики без `auth.uid()`/ключа (`server_manages_grants` `0005:35`, `server_manages_clients` `0005:44`,
  `scheduler_reads_owner_list` `0013:25`, `read_all` `0014:247`); политики `graphs`/`graph_members` (0020); применённые миграции.

**Интерфейсы:**

*Consumes:* Г-2 — `graph_members`, индекс `graph_members_active_uniq (graph_id, account_id) WHERE revoked_at IS NULL`; Г-3 —
claims `{sub, role, graph}`, `personal`/`accountOf`/`addMember`, тест `graph-vs-account.test.ts` с двумя `test.failing`;
Г-0 — семь медиан и вердикты `explain` (`progress.md`), вывод пробы (`probe-rls-plan.log`). Инвентарь 35 политик —
`recon-1-db-rls.md` §1.А (имя, таблица, адрес).

*Produces:*
```sql
public.current_graph_id()            RETURNS uuid     -- ключ graph из request.jwt.claims; NULL, если не выставлен
public.actor_reads_current_graph()   RETURNS boolean  -- действующий грант любого вида в текущем графе
public.actor_writes_current_graph()  RETURNS boolean  -- действующий грант owner | operator
public.actor_owns_current_graph()    RETURNS boolean  -- действующий грант owner
-- все четыре: LANGUAGE sql STABLE SECURITY INVOKER SET search_path = ''
политики строк:  current_graph_select / _insert / _update / _delete — по одной на команду, TO authenticated
реестры ×6:      read_builtin_or_own / write_own / update_own / delete_own — имена прежние, предикат новый
agent_grants.issued_by NOT NULL;  pgTAP — plan(148);  пометок test.failing в дереве — 0
```

- [ ] **Шаг 1: красный гейт — снять пометки.** В `apps/server/test/graph-vs-account.test.ts` оба `test.failing(` → `test(`,
  комментарии «ПОМЕТКА Г-3 → Г-4» снять. Прогон: `cd /Users/birzhan/projects/orbis/.claude/worktrees/graph-ownership-g/apps/server && bun test test/graph-vs-account.test.ts` → **2 fail**
  (`bReadsA` = 0, `bWriteInA` = `throw:42501`, `withoutGraph` = 1) — это красный тест задачи. После миграции `0021` ни один
  перехват `capture` срабатывать не должен: значение, начинающееся с `throw:`, — повод разбирать политику, а не править ожидание.
  **Тем же шагом вернуть сторож пометок** (правка 21.09 по исполнению Г-3, Ф-Г-43): живой сторож
  `apps/server/test/gate-c8-18.test.ts` запрещает в дереве ЛЮБУЮ пометку `test.failing`/`test.todo`, и Г-3
  научила его временно́му исключению ровно на два сюжета (исключение держит и адрес файла, и счёт = 2). Снимая
  пометки, ВЕРНИ ему прежнюю форму (`toEqual([])`) и убедись, что он краснеет на подсаженной пометке: иначе
  срез оставит в проде ослабленный сторож, а следующая забытая `test.failing` пройдёт молча.

- [ ] **Шаг 2: красный pgTAP — claims, фикстуры членства, группа 23.** В `apps/server/test/rls/rls.pgtap.sql`:
  (а) каждому `set_config('request.jwt.claims', …)` с непустым `sub` добавить ключ `graph` с ТЕМ ЖЕ uuid:
```
cd /Users/birzhan/projects/orbis/.claude/worktrees/graph-ownership-g && perl -pi -e 's/\{"sub":"([0-9a-f-]{36})","role":"authenticated"\}/{"sub":"$1","role":"authenticated","graph":"$1"}/g' apps/server/test/rls/rls.pgtap.sql
cd /Users/birzhan/projects/orbis/.claude/worktrees/graph-ownership-g && grep -c '"graph":' apps/server/test/rls/rls.pgtap.sql
```
  (точки переключения — `:126-128, :263, :335-337, :349-351, :382-383, :427-429` и группы 20–21 Г-2; «пустые claims»
  `:282-283`, `:693-694` НЕ трогать — это и есть fail-closed и «без идентичности видны встроенные строки»).
  (а′) `issued_by` станет NOT NULL — три вставки гранта без выдавшего упадут `23502`: фикстура pgTAP `rls.pgtap.sql:33-37`
  (добавить колонку `issued_by` со значением `graph_id` той же строки — иначе при `ON_ERROR_STOP` файл оборвётся на первой
  же фикстуре), `apps/server/src/db/reset-world.test.ts:253-254` (то же); тест бэкфилла `graphs.test.ts` уже снимает и
  возвращает NOT NULL сам (Г-2, шаг 2). Поиск остальных: `git grep -n 'INSERT INTO agent_grants' -- apps/server scripts`.
  (б) в блок фикстур графов (Г-2) дописать трёх держателей грантов в графе А и личный граф Е с сущностью:
```sql
-- Фикстуры «актор ≠ граф» (0021): Е — operator, Ж — observer, З — ОТОЗВАННЫЙ operator графа А; у Е есть свой личный граф.
INSERT INTO graphs (id, owner_kind, owner_ref) VALUES
  ('00000000-0000-4000-8000-00000000000e', 'person', '00000000-0000-4000-8000-00000000000e');
INSERT INTO graph_members (id, graph_id, account_id, grant_kind, issued_by, revoked_at) VALUES
  ('00000000-0000-7000-8000-0000000000e9', '00000000-0000-4000-8000-00000000000e',
   '00000000-0000-4000-8000-00000000000e', 'owner', '00000000-0000-4000-8000-00000000000e', NULL),
  ('00000000-0000-7000-8000-0000000000ea', '00000000-0000-4000-8000-00000000000a',
   '00000000-0000-4000-8000-00000000000e', 'operator', '00000000-0000-4000-8000-00000000000a', NULL),
  ('00000000-0000-7000-8000-0000000000fa', '00000000-0000-4000-8000-00000000000a',
   '00000000-0000-4000-8000-00000000000f', 'observer', '00000000-0000-4000-8000-00000000000a', NULL),
  ('00000000-0000-7000-8000-00000000001b', '00000000-0000-4000-8000-00000000000a',
   '00000000-0000-4000-8000-00000000001a', 'operator', '00000000-0000-4000-8000-00000000000a', now());
INSERT INTO entities (id, graph_id, title) VALUES
  ('00000000-0000-7000-8000-0000000000e1', '00000000-0000-4000-8000-00000000000e', 'Е: запись личного графа');
```
  (в) перед `SELECT finish();` — группа 23, **23 проверки**; `SELECT plan(125);` → **`SELECT plan(148);`**:
```sql
-- ── Группа 23: актор ≠ граф — «текущий граф ∧ членство» (спека §3.5–§3.6) ───────────────────
RESET ROLE;
-- Е — operator графа А; текущий граф — А
SELECT set_config('request.jwt.claims',
  '{"sub":"00000000-0000-4000-8000-00000000000e","role":"authenticated","graph":"00000000-0000-4000-8000-00000000000a"}', true);
SET LOCAL ROLE authenticated;
SELECT results_eq($$SELECT count(*)::int FROM entities WHERE id = '00000000-0000-7000-8000-0000000000a1'$$,
  ARRAY[1], 'operator читает строки текущего графа');
SELECT results_eq($$SELECT count(*)::int FROM entities WHERE id = '00000000-0000-7000-8000-0000000000e1'$$,
  ARRAY[0], 'строки СВОЕГО личного графа в чужом текущем графе не видны: «все мои графы» умолчанием не бывает');
SELECT lives_ok($$INSERT INTO entities (id, graph_id, title) VALUES
  ('00000000-0000-7000-8000-0000000000e2', '00000000-0000-4000-8000-00000000000a', 'Е пишет в граф А')$$,
  'operator пишет в текущий граф');
SELECT throws_ok($$INSERT INTO entities (id, graph_id, title) VALUES
  ('00000000-0000-7000-8000-0000000000e3', '00000000-0000-4000-8000-00000000000e', 'мимо текущего графа')$$,
  '42501', NULL, 'запись в НЕтекущий граф — отказ, даже если грант в нём есть');
SELECT throws_ok($$INSERT INTO agent_grants (id, graph_id, issued_by, kind, label, access_hash) VALUES
  ('00000000-0000-7000-8000-0000000000e7', '00000000-0000-4000-8000-00000000000a',
   '00000000-0000-4000-8000-00000000000e', 'pat', 'агент оператора', 'hash-e')$$,
  '42501', NULL, 'грант агенту выписывает только держатель гранта owner (иначе operator выдал бы full)');
-- Ж — observer графа А
RESET ROLE;
SELECT set_config('request.jwt.claims',
  '{"sub":"00000000-0000-4000-8000-00000000000f","role":"authenticated","graph":"00000000-0000-4000-8000-00000000000a"}', true);
SET LOCAL ROLE authenticated;
SELECT results_eq($$SELECT count(*)::int FROM entities WHERE id = '00000000-0000-7000-8000-0000000000a1'$$,
  ARRAY[1], 'observer читает');
SELECT throws_ok($$INSERT INTO entities (id, graph_id, title) VALUES
  ('00000000-0000-7000-8000-0000000000f2', '00000000-0000-4000-8000-00000000000a', 'observer пишет')$$,
  '42501', NULL, 'observer не вставляет');
WITH u AS (UPDATE entities SET title = 'перехват' WHERE id = '00000000-0000-7000-8000-0000000000a1' RETURNING 1)
SELECT is((SELECT count(*)::int FROM u), 0, 'observer не правит: UPDATE не задевает ни одной строки');
WITH d AS (DELETE FROM entities WHERE id = '00000000-0000-7000-8000-0000000000a1' RETURNING 1)
SELECT is((SELECT count(*)::int FROM d), 0, 'observer не удаляет: политика записи стоит и на DELETE');
-- Б — без гранта в графе А; З — с отозванным
RESET ROLE;
SELECT set_config('request.jwt.claims',
  '{"sub":"00000000-0000-4000-8000-00000000000b","role":"authenticated","graph":"00000000-0000-4000-8000-00000000000a"}', true);
SET LOCAL ROLE authenticated;
SELECT results_eq('SELECT count(*)::int FROM entities', ARRAY[0], 'текущий граф без гранта — пусто');
RESET ROLE;
SELECT set_config('request.jwt.claims',
  '{"sub":"00000000-0000-4000-8000-00000000001a","role":"authenticated","graph":"00000000-0000-4000-8000-00000000000a"}', true);
SET LOCAL ROLE authenticated;
SELECT results_eq('SELECT count(*)::int FROM entities', ARRAY[0], 'отозванный грант — пусто (revoked_at IS NULL в функциях)');
-- А без текущего графа: fail-closed, кроме встроенных строк реестров
RESET ROLE;
SELECT set_config('request.jwt.claims',
  '{"sub":"00000000-0000-4000-8000-00000000000a","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
SELECT results_eq('SELECT count(*)::int FROM entities', ARRAY[0], 'текущий граф не выставлен — пусто, даже у владельца');
SELECT results_eq($$SELECT count(*)::int FROM aspect_definitions WHERE id = 'orbis/pgtap-probe'$$,
  ARRAY[1], '…кроме встроенных строк реестров: стартовая проверка дрейфа читает их без идентичности');
SELECT results_eq($$SELECT count(*)::int FROM property_definitions WHERE id = 'pgtap/a'$$,
  ARRAY[0], 'своя строка реестра без текущего графа не видна');
-- А — owner в своём графе: грант агенту выписывается
RESET ROLE;
SELECT set_config('request.jwt.claims',
  '{"sub":"00000000-0000-4000-8000-00000000000a","role":"authenticated","graph":"00000000-0000-4000-8000-00000000000a"}', true);
SET LOCAL ROLE authenticated;
SELECT lives_ok($$INSERT INTO agent_grants (id, graph_id, issued_by, kind, label, access_hash) VALUES
  ('00000000-0000-7000-8000-0000000000a0', '00000000-0000-4000-8000-00000000000a',
   '00000000-0000-4000-8000-00000000000a', 'pat', 'агент владельца', 'hash-a0')$$,
  'держатель гранта owner выписывает грант агенту');
-- Межграфовая строгость: Е в СВОЁМ графе цепляет строки к сущности графа А (в нём у Е грант есть!)
RESET ROLE;
SELECT set_config('request.jwt.claims',
  '{"sub":"00000000-0000-4000-8000-00000000000e","role":"authenticated","graph":"00000000-0000-4000-8000-00000000000e"}', true);
SET LOCAL ROLE authenticated;
SELECT throws_ok($$INSERT INTO chat_threads (id, graph_id, entity_id) VALUES
  ('00000000-0000-7000-8000-0000000000e4', '00000000-0000-4000-8000-00000000000e',
   '00000000-0000-7000-8000-0000000000a1')$$,
  '42501', NULL, 'тред графа Е на сущности графа А — отказ (давняя дыра chat_threads.entity_id закрыта)');
SELECT throws_ok($$INSERT INTO envelope_spent_cache (envelope_id, graph_id, as_of, spent, owner_version, system_version) VALUES
  ('00000000-0000-7000-8000-0000000000a1', '00000000-0000-4000-8000-00000000000e', '2026-09-02', 1, 0, 1)$$,
  '42501', NULL, 'кэш графа Е на конверте графа А — отказ (вторая дыра того же класса)');
SELECT throws_ok($$INSERT INTO relations (id, source_id, target_id, role) VALUES
  ('00000000-0000-7000-8000-0000000000e5', '00000000-0000-7000-8000-0000000000e1',
   '00000000-0000-7000-8000-0000000000a1', 'mention')$$,
  '42501', NULL, 'связь между графами — отказ: оба конца в одном текущем графе до ступени 2');
SELECT throws_ok($$INSERT INTO entity_versions (id, graph_id, entity_id, label, body, actor_user_id, actor_kind) VALUES
  ('00000000-0000-7000-8000-0000000000e8', '00000000-0000-4000-8000-00000000000e',
   '00000000-0000-7000-8000-0000000000a1', 'чужое тело', 'т', '00000000-0000-4000-8000-00000000000e', 'owner')$$,
  '42501', NULL, 'версия графа Е на сущности графа А — отказ (строгость 0011 сохранена)');
SELECT throws_ok($$INSERT INTO entity_origins (id, graph_id, entity_id, namespace, external_id) VALUES
  ('00000000-0000-7000-8000-0000000000e6', '00000000-0000-4000-8000-00000000000e',
   '00000000-0000-7000-8000-0000000000a1', 'telegram', 'ext-e')$$,
  '42501', NULL, 'provenance графа Е на сущности графа А — отказ (строгость 0002 сохранена)');
-- Структурные пины
RESET ROLE;
SELECT is((SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname IN ('current_graph_id','actor_reads_current_graph','actor_writes_current_graph','actor_owns_current_graph')
    AND NOT p.prosecdef AND p.proconfig @> ARRAY['search_path=""']),
  4, 'четыре функции политик — SECURITY INVOKER с пустым search_path: обхода RLS нет (0013:7-8)');
SELECT is((SELECT count(*)::int FROM pg_policies WHERE schemaname = 'public'
    AND tablename NOT IN ('graphs','graph_members')
    AND (coalesce(qual, '') LIKE '%auth.uid()%' OR coalesce(with_check, '') LIKE '%auth.uid()%')),
  0, 'ни одна политика строк не сравнивает ключ с auth.uid(): вечного доступа по равенству id нет');
SELECT col_not_null('public', 'agent_grants', 'issued_by', 'у гранта агента всегда есть выдавший аккаунт');
```
  Прогон: `cd /Users/birzhan/projects/orbis/.claude/worktrees/graph-ownership-g && bun run test:rls` → **красный** (политики старые; колонка nullable).

- [ ] **Шаг 3: `schema.ts` и снимок `0021`.** `agentGrants.issuedBy` → `uuid('issued_by').notNull()`, комментарий — «аккаунт,
  выдавший грант (D44): актор путей без живого человека; NOT NULL с миграции 0021». В `oauth/grants.ts` (`verifyBearer`) снять
  ветку `if (row.issuedBy === null) return null;` с её комментарием — тип колонки больше не допускает NULL.
```
cd /Users/birzhan/projects/orbis/.claude/worktrees/graph-ownership-g/apps/server && bunx drizzle-kit generate --name graph_rls 2>&1 | tail -5
```
  Вопросов не будет (ничего не удалено). Сгенерированный текст — одна строка `ALTER TABLE "agent_grants" ALTER COLUMN
  "issued_by" SET NOT NULL;`; она переезжает в хвост рукописного файла (шаг 4).

- [ ] **Шаг 4: миграция `0021_graph_rls.sql` — заменить содержимое целиком.**
```sql
-- 0021_graph_rls.sql — срез «Г — единица владения» (D44), задача Г-4.
-- Файл РУКОПИСНЫЙ (drizzle-kit политик, грантов и функций не видит), снимок — сгенерированный.
-- Изоляция: «строка ТЕКУЩЕГО графа ∧ актор держит грант» (спека §3.6). Применённые файлы не правятся:
-- 35 политик снимаются и создаются заново здесь. Bypass RLS не вводится (0013:7-8): функции —
-- SECURITY INVOKER, им хватает SELECT-политики graph_members (0020); рекурсии политик нет.
-- Вариант `graph_id = auth.uid() OR …` исключён: вечный доступ по равенству id мимо членства.

-- Текущий граф — ключ `graph` тех же claims, что и `sub` (ставит withIdentity одним set_config).
-- NULLIF — по канону auth.uid() (scripts/setup-db.ts:12-22): после отката локальной настройки на
-- соединении из пула остаётся '', а не NULL. Не выставлен — NULL, и обе половины предиката ложны.
CREATE FUNCTION "public"."current_graph_id"() RETURNS uuid
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $$
	SELECT (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'graph')::uuid
$$;
--> statement-breakpoint
CREATE FUNCTION "public"."actor_reads_current_graph"() RETURNS boolean
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $$
	SELECT EXISTS (SELECT 1 FROM public.graph_members m
		WHERE m.graph_id = public.current_graph_id() AND m.account_id = auth.uid() AND m.revoked_at IS NULL)
$$;
--> statement-breakpoint
CREATE FUNCTION "public"."actor_writes_current_graph"() RETURNS boolean
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $$
	SELECT EXISTS (SELECT 1 FROM public.graph_members m
		WHERE m.graph_id = public.current_graph_id() AND m.account_id = auth.uid() AND m.revoked_at IS NULL
			AND m.grant_kind IN ('owner','operator'))
$$;
--> statement-breakpoint
CREATE FUNCTION "public"."actor_owns_current_graph"() RETURNS boolean
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $$
	SELECT EXISTS (SELECT 1 FROM public.graph_members m
		WHERE m.graph_id = public.current_graph_id() AND m.account_id = auth.uid() AND m.revoked_at IS NULL
			AND m.grant_kind = 'owner')
$$;
--> statement-breakpoint
-- ── Простые таблицы строк: entities, user_settings, ai_usage, registry_deltas ──────────────────
-- ЧЕТЫРЕ покомандные политики, как у реестров, а не одна FOR ALL и не пара «SELECT + ALL»:
-- (1) у FOR ALL на DELETE работает только USING — observer с «читающим» USING удалял бы строки;
-- (2) permissive-политики одной команды склеиваются через OR, а FOR ALL применяется и к SELECT:
--     пара дала бы security qual `(graph = $0 AND $1) OR (graph = $2 AND $3)`. План SELECT от этого
--     НЕ портится (общий член `graph_id = …` планировщик выносит за скобки OR и оставляет в
--     Index Cond — проверено мутацией пробы, Ф-Г-28), а вот UPDATE получает 8–10 InitPlan вместо
--     четырёх и считает обе половины предиката дважды. У каждой команды — ровно одна политика:
--     одно правило на команду читается и проверяется, склейка двух — нет.
-- `TO authenticated`, а не PUBLIC: тела функций разбираются при ВЫЗОВЕ, а у orbis_app нет USAGE на
-- схему auth — под PUBLIC тик планировщика падал бы на auth.uid(). Обе половины предиката в обёртке
-- (SELECT …): InitPlan, один раз на запрос, не на строку («решение 2», 0001:35).
DROP POLICY "owner_owns_row" ON "entities";
--> statement-breakpoint
CREATE POLICY "current_graph_select" ON "entities" FOR SELECT TO authenticated
USING ("graph_id" = (SELECT public.current_graph_id()) AND (SELECT public.actor_reads_current_graph()));
--> statement-breakpoint
CREATE POLICY "current_graph_insert" ON "entities" FOR INSERT TO authenticated
WITH CHECK ("graph_id" = (SELECT public.current_graph_id()) AND (SELECT public.actor_writes_current_graph()));
--> statement-breakpoint
CREATE POLICY "current_graph_update" ON "entities" FOR UPDATE TO authenticated
USING ("graph_id" = (SELECT public.current_graph_id()) AND (SELECT public.actor_writes_current_graph()))
WITH CHECK ("graph_id" = (SELECT public.current_graph_id()) AND (SELECT public.actor_writes_current_graph()));
--> statement-breakpoint
CREATE POLICY "current_graph_delete" ON "entities" FOR DELETE TO authenticated
USING ("graph_id" = (SELECT public.current_graph_id()) AND (SELECT public.actor_writes_current_graph()));
--> statement-breakpoint
-- … ТЕ ЖЕ пять статементов (DROP owner_owns_row + четыре политики) для user_settings, ai_usage, registry_deltas.
-- ── Производные строки: WITH CHECK у INSERT и UPDATE сверяет граф родителя (межграфовая строгость) ──
-- chat_threads.entity_id — давняя дыра: тред со своим graph_id и entity_id ЧУЖОЙ сущности проходил
-- (RI-проверка FK идёт мимо RLS).
DROP POLICY "owner_owns_row" ON "chat_threads";
--> statement-breakpoint
CREATE POLICY "current_graph_select" ON "chat_threads" FOR SELECT TO authenticated
USING ("graph_id" = (SELECT public.current_graph_id()) AND (SELECT public.actor_reads_current_graph()));
--> statement-breakpoint
CREATE POLICY "current_graph_insert" ON "chat_threads" FOR INSERT TO authenticated
WITH CHECK ("graph_id" = (SELECT public.current_graph_id()) AND (SELECT public.actor_writes_current_graph())
	AND ("entity_id" IS NULL OR EXISTS (SELECT 1 FROM "entities" e
		WHERE e."id" = "chat_threads"."entity_id" AND e."graph_id" = "chat_threads"."graph_id")));
--> statement-breakpoint
CREATE POLICY "current_graph_update" ON "chat_threads" FOR UPDATE TO authenticated
USING ("graph_id" = (SELECT public.current_graph_id()) AND (SELECT public.actor_writes_current_graph()))
WITH CHECK ("graph_id" = (SELECT public.current_graph_id()) AND (SELECT public.actor_writes_current_graph())
	AND ("entity_id" IS NULL OR EXISTS (SELECT 1 FROM "entities" e
		WHERE e."id" = "chat_threads"."entity_id" AND e."graph_id" = "chat_threads"."graph_id")));
--> statement-breakpoint
CREATE POLICY "current_graph_delete" ON "chat_threads" FOR DELETE TO authenticated
USING ("graph_id" = (SELECT public.current_graph_id()) AND (SELECT public.actor_writes_current_graph()));
--> statement-breakpoint
-- envelope_spent_cache.envelope_id — вторая дыра того же класса (0018:33): конверт чужого графа.
DROP POLICY "owner_owns_row" ON "envelope_spent_cache";
--> statement-breakpoint
CREATE POLICY "current_graph_select" ON "envelope_spent_cache" FOR SELECT TO authenticated
USING ("graph_id" = (SELECT public.current_graph_id()) AND (SELECT public.actor_reads_current_graph()));
--> statement-breakpoint
CREATE POLICY "current_graph_insert" ON "envelope_spent_cache" FOR INSERT TO authenticated
WITH CHECK ("graph_id" = (SELECT public.current_graph_id()) AND (SELECT public.actor_writes_current_graph())
	AND EXISTS (SELECT 1 FROM "entities" e
		WHERE e."id" = "envelope_spent_cache"."envelope_id" AND e."graph_id" = "envelope_spent_cache"."graph_id"));
--> statement-breakpoint
CREATE POLICY "current_graph_update" ON "envelope_spent_cache" FOR UPDATE TO authenticated
USING ("graph_id" = (SELECT public.current_graph_id()) AND (SELECT public.actor_writes_current_graph()))
WITH CHECK ("graph_id" = (SELECT public.current_graph_id()) AND (SELECT public.actor_writes_current_graph())
	AND EXISTS (SELECT 1 FROM "entities" e
		WHERE e."id" = "envelope_spent_cache"."envelope_id" AND e."graph_id" = "envelope_spent_cache"."graph_id"));
--> statement-breakpoint
CREATE POLICY "current_graph_delete" ON "envelope_spent_cache" FOR DELETE TO authenticated
USING ("graph_id" = (SELECT public.current_graph_id()) AND (SELECT public.actor_writes_current_graph()));
--> statement-breakpoint
-- entity_origins (0002:10-16) и entity_versions (0011:22-28): DROP "owner_owns_row_and_entity" + те же четыре
-- политики с хвостом WITH CHECK `AND EXISTS (… e."id" = <таблица>."entity_id" AND e."graph_id" = <таблица>."graph_id")`.
-- ── Таблицы без своего ключа ──────────────────────────────────────────────────────────────────
-- relations: оба конца — в одном ТЕКУЩЕМ графе до ступени 2 (связи между графами — §6 спеки).
DROP POLICY "owner_owns_both_ends" ON "relations";
--> statement-breakpoint
CREATE POLICY "current_graph_select" ON "relations" FOR SELECT TO authenticated
USING ((SELECT public.actor_reads_current_graph())
	AND EXISTS (SELECT 1 FROM "entities" e WHERE e."id" = "relations"."source_id" AND e."graph_id" = (SELECT public.current_graph_id()))
	AND EXISTS (SELECT 1 FROM "entities" e WHERE e."id" = "relations"."target_id" AND e."graph_id" = (SELECT public.current_graph_id())));
--> statement-breakpoint
CREATE POLICY "current_graph_insert" ON "relations" FOR INSERT TO authenticated
WITH CHECK ((SELECT public.actor_writes_current_graph())
	AND EXISTS (SELECT 1 FROM "entities" e WHERE e."id" = "relations"."source_id" AND e."graph_id" = (SELECT public.current_graph_id()))
	AND EXISTS (SELECT 1 FROM "entities" e WHERE e."id" = "relations"."target_id" AND e."graph_id" = (SELECT public.current_graph_id())));
--> statement-breakpoint
CREATE POLICY "current_graph_update" ON "relations" FOR UPDATE TO authenticated
USING ((SELECT public.actor_writes_current_graph())
	AND EXISTS (SELECT 1 FROM "entities" e WHERE e."id" = "relations"."source_id" AND e."graph_id" = (SELECT public.current_graph_id()))
	AND EXISTS (SELECT 1 FROM "entities" e WHERE e."id" = "relations"."target_id" AND e."graph_id" = (SELECT public.current_graph_id())))
WITH CHECK ((SELECT public.actor_writes_current_graph())
	AND EXISTS (SELECT 1 FROM "entities" e WHERE e."id" = "relations"."source_id" AND e."graph_id" = (SELECT public.current_graph_id()))
	AND EXISTS (SELECT 1 FROM "entities" e WHERE e."id" = "relations"."target_id" AND e."graph_id" = (SELECT public.current_graph_id())));
--> statement-breakpoint
CREATE POLICY "current_graph_delete" ON "relations" FOR DELETE TO authenticated
USING ((SELECT public.actor_writes_current_graph())
	AND EXISTS (SELECT 1 FROM "entities" e WHERE e."id" = "relations"."source_id" AND e."graph_id" = (SELECT public.current_graph_id()))
	AND EXISTS (SELECT 1 FROM "entities" e WHERE e."id" = "relations"."target_id" AND e."graph_id" = (SELECT public.current_graph_id())));
--> statement-breakpoint
DROP POLICY "owner_owns_thread" ON "chat_messages";
--> statement-breakpoint
CREATE POLICY "current_graph_select" ON "chat_messages" FOR SELECT TO authenticated
USING ((SELECT public.actor_reads_current_graph())
	AND EXISTS (SELECT 1 FROM "chat_threads" t WHERE t."id" = "chat_messages"."thread_id" AND t."graph_id" = (SELECT public.current_graph_id())));
--> statement-breakpoint
CREATE POLICY "current_graph_insert" ON "chat_messages" FOR INSERT TO authenticated
WITH CHECK ((SELECT public.actor_writes_current_graph())
	AND EXISTS (SELECT 1 FROM "chat_threads" t WHERE t."id" = "chat_messages"."thread_id" AND t."graph_id" = (SELECT public.current_graph_id())));
--> statement-breakpoint
CREATE POLICY "current_graph_update" ON "chat_messages" FOR UPDATE TO authenticated
USING ((SELECT public.actor_writes_current_graph())
	AND EXISTS (SELECT 1 FROM "chat_threads" t WHERE t."id" = "chat_messages"."thread_id" AND t."graph_id" = (SELECT public.current_graph_id())))
WITH CHECK ((SELECT public.actor_writes_current_graph())
	AND EXISTS (SELECT 1 FROM "chat_threads" t WHERE t."id" = "chat_messages"."thread_id" AND t."graph_id" = (SELECT public.current_graph_id())));
--> statement-breakpoint
CREATE POLICY "current_graph_delete" ON "chat_messages" FOR DELETE TO authenticated
USING ((SELECT public.actor_writes_current_graph())
	AND EXISTS (SELECT 1 FROM "chat_threads" t WHERE t."id" = "chat_messages"."thread_id" AND t."graph_id" = (SELECT public.current_graph_id())));
--> statement-breakpoint
-- ── agent_grants: грант агенту выписывает ТОЛЬКО держатель гранта owner (иначе operator выдал бы full).
-- Боевая выдача идёт под orbis_app мимо этой политики (server_manages_grants) — там то же условие
-- держит код (assertHoldsOwnerGrant, oauth/grants.ts); политика закрывает путь под authenticated.
DROP POLICY "owner_owns_row" ON "agent_grants";
--> statement-breakpoint
CREATE POLICY "current_graph_select" ON "agent_grants" FOR SELECT TO authenticated
USING ("graph_id" = (SELECT public.current_graph_id()) AND (SELECT public.actor_reads_current_graph()));
--> statement-breakpoint
CREATE POLICY "current_graph_insert" ON "agent_grants" FOR INSERT TO authenticated
WITH CHECK ("graph_id" = (SELECT public.current_graph_id()) AND (SELECT public.actor_owns_current_graph()));
--> statement-breakpoint
CREATE POLICY "current_graph_update" ON "agent_grants" FOR UPDATE TO authenticated
USING ("graph_id" = (SELECT public.current_graph_id()) AND (SELECT public.actor_owns_current_graph()))
WITH CHECK ("graph_id" = (SELECT public.current_graph_id()) AND (SELECT public.actor_owns_current_graph()));
--> statement-breakpoint
CREATE POLICY "current_graph_delete" ON "agent_grants" FOR DELETE TO authenticated
USING ("graph_id" = (SELECT public.current_graph_id()) AND (SELECT public.actor_owns_current_graph()));
--> statement-breakpoint
-- ── Шесть реестров — СВОЯ форма: встроенные строки (graph_id IS NULL) читаемы без текущего графа ──
-- Шаблон «… AND членство» поверх всей политики спрятал бы их от стартовой проверки дрейфа, которая
-- читает под authenticated с пустыми claims (db/registry-drift.ts:101-126) — /health ушёл бы в дрейф.
DROP POLICY "read_builtin_or_own" ON "aspect_definitions";
--> statement-breakpoint
DROP POLICY "write_own" ON "aspect_definitions";
--> statement-breakpoint
DROP POLICY "update_own" ON "aspect_definitions";
--> statement-breakpoint
DROP POLICY "delete_own" ON "aspect_definitions";
--> statement-breakpoint
CREATE POLICY "read_builtin_or_own" ON "aspect_definitions" FOR SELECT TO authenticated
USING ("graph_id" IS NULL OR ("graph_id" = (SELECT public.current_graph_id()) AND (SELECT public.actor_reads_current_graph())));
--> statement-breakpoint
CREATE POLICY "write_own" ON "aspect_definitions" FOR INSERT TO authenticated
WITH CHECK ("graph_id" = (SELECT public.current_graph_id()) AND (SELECT public.actor_writes_current_graph()));
--> statement-breakpoint
CREATE POLICY "update_own" ON "aspect_definitions" FOR UPDATE TO authenticated
USING ("graph_id" = (SELECT public.current_graph_id()) AND (SELECT public.actor_writes_current_graph()))
WITH CHECK ("graph_id" = (SELECT public.current_graph_id()) AND (SELECT public.actor_writes_current_graph()));
--> statement-breakpoint
CREATE POLICY "delete_own" ON "aspect_definitions" FOR DELETE TO authenticated
USING ("graph_id" = (SELECT public.current_graph_id()) AND (SELECT public.actor_writes_current_graph()));
--> statement-breakpoint
-- … ТЕ ЖЕ восемь статементов для property_definitions, relation_role_definitions, contract_definitions,
-- subscription_definitions, action_definitions.
-- ── issued_by: писатели есть с Г-3, бэкфилл — 0020 ─────────────────────────────────────────────
ALTER TABLE "agent_grants" ALTER COLUMN "issued_by" SET NOT NULL;
```
  Строки-комментарии «… ТЕ ЖЕ …» в файле миграции недопустимы: выписать ВСЕ статементы. Сверка состава — после шага 5:
  снято **35** (7 × `owner_owns_row`, `owner_owns_both_ends`, `owner_owns_thread`, 2 × `owner_owns_row_and_entity`, 24
  реестровые), создано **68** (11 таблиц строк × 4 + 24 реестровые).

- [ ] **Шаг 5: накат, сверка состава, pgTAP.**
```
cd /Users/birzhan/projects/orbis/.claude/worktrees/graph-ownership-g && bunx supabase db reset && bun run db:prepare
cd /Users/birzhan/projects/orbis/.claude/worktrees/graph-ownership-g && psql "$(grep '^DATABASE_URL_ADMIN=' apps/server/.env | cut -d= -f2-)" -At -c "SELECT count(*) FROM pg_policies WHERE schemaname='public'" -c "SELECT count(*) FROM pg_policies WHERE schemaname='public' AND policyname LIKE 'owner_owns%'" -c "SELECT policyname FROM pg_policies WHERE schemaname='public' AND roles = '{public}' ORDER BY 1"
cd /Users/birzhan/projects/orbis/.claude/worktrees/graph-ownership-g/apps/server && bunx drizzle-kit generate --name should_be_empty 2>&1 | tail -3
```
  (Каждый запрос — своим `-c`: локальный psql 14 при нескольких командах в одном `-c` печатает результат только последней.)
  Ожидание: `db:prepare` — EXIT=0, накат `0000…0021`, `test:rls` — `plan(148)` без «Looks like you planned»; политик всего
  **77** (39 живых до среза − 35 + 68 + 5 политик `0020`); с именем `owner_owns%` — **0**; под `{public}` остались ровно
  `read_all` (остальные три нетронутые — `TO orbis_app`); генератор — `No schema changes`. Четвёртой миграции нет (РП-3).

- [ ] **Шаг 6: гейт — «граф ≠ аккаунт» зелёный.**
```
cd /Users/birzhan/projects/orbis/.claude/worktrees/graph-ownership-g/apps/server && bun test test/graph-vs-account.test.ts src/db/with-identity.test.ts src/db/registry-drift.test.ts src/db/graphs-policies.test.ts src/routines/queries.test.ts src/identity.test.ts
cd /Users/birzhan/projects/orbis/.claude/worktrees/graph-ownership-g && git grep -c 'test.failing' -- apps/server packages scripts
```
  Ожидание: все зелёные; четыре сюжета «граф ≠ аккаунт» — `pass` без пометок; тест дрейфа зелёный БЕЗ идентичности (приёмка
  §3.6); вторая команда печатает ПУСТО — сторож «ноль пометок». Мутации для отчёта «Пины и мутации» (на локальной базе,
  `CREATE OR REPLACE`/`ALTER POLICY`, затем `db reset`): (1) в `actor_reads_current_graph` убрать `m.revoked_at IS NULL` →
  красная проверка «отозванный грант — пусто»; (2) `current_graph_delete` на `entities` → USING с `actor_reads…` → красная
  «observer не удаляет»; (3) снять хвост `EXISTS` у `chat_threads` → красная «давняя дыра закрыта»; (4) у реестра снять
  `"graph_id" IS NULL OR` → красный `registry-drift.test.ts`.

- [ ] **Шаг 7: докблоки-читатели старых имён.** `git grep -n 'owner_owns' -- apps/server/src apps/server/perf apps/server/test`
  → каждое упоминание политики переписать на новое имя и новый смысл («политика `current_graph_select` — security qual
  „текущий граф ∧ грант“»). В `perf/explain.test.ts:11-44` довод про GIN остаётся верным (security qual + non-leakproof
  операторы — любая политика), меняется только имя политики. Имён `owner_owns%` вне применённых миграций — ноль.

- [ ] **Шаг 8: полный прогон.**
```
cd /Users/birzhan/projects/orbis/.claude/worktrees/graph-ownership-g && bun run typecheck
cd /Users/birzhan/projects/orbis/.claude/worktrees/graph-ownership-g && bun run lint
cd /Users/birzhan/projects/orbis/.claude/worktrees/graph-ownership-g && bun run test
cd /Users/birzhan/projects/orbis/.claude/worktrees/graph-ownership-g && bun scripts/check-legacy-form.ts --gate
```
  Ожидание: все EXIT=0. Красные серверные тесты после смены политик — почти всегда тест, который ходит в базу мимо
  `withIdentity` с самодельными claims без ключа `graph` (`git grep -n "request.jwt.claims" -- 'apps/server/**/*.test.ts'
  apps/server/src/test apps/server/perf`): такие claims получают `graph` — кроме тех, что нарочно проверяют fail-closed.

- [ ] **Шаг 9: перф против базовой линии Г-0 (спека Ш-3, Р-КГ-10) — на незанятой машине.**
```
cd /Users/birzhan/projects/orbis/.claude/worktrees/graph-ownership-g && bun run test:perf:volume
cd /Users/birzhan/projects/orbis/.claude/worktrees/graph-ownership-g && bun run test:perf:explain
cd /Users/birzhan/projects/orbis/.claude/worktrees/graph-ownership-g && bun run test:perf:graph
cd /Users/birzhan/projects/orbis/.claude/worktrees/graph-ownership-g && bun run test:perf
```
  Критерий «без регрессии»: (1) семь медиан ≤ `BUDGETS_MS` — жёсткий гейт (он же в CI); (2) каждая медиана ≤
  max(1,3 × базовой Г-0, базовая + 5 мс); первым смотреть `agenda:horizon` — худший запас (Ф-Г-19); (3) вердикты
  `test:perf:explain` дословно равны вердиктам Г-0 (`<index>: chosen=… usable=… admin=…`) — пины файла и есть «вердикт
  запинен тестом». **Известное расхождение, которое НЕ считать регрессией Г-4** (правка 21.09, Р-ИГ-10): вердикт
  `relations_source_role` сменился уже между Г-0 и Г-1 — `chosen=true usable=true admin=true` (`baseline-logs/
  g0-perf-explain.log:23`) → `chosen=false usable=false admin=false` (`run-logs-g1/g1-perf-explain.log:23`), и с тех пор
  устойчив в Г-2 и Г-3. Сьют при этом зелёный: его пины покомандные, а не «равно Г-0». Задача Г-4 сверяет вердикты с
  логами Г-3 (`run-logs-g3/`), а этот один — ОБЪЯСНЯЕТ: сменилась форма запроса (тогда виновата не Г-4) или наполнение
  корпуса (тогда это шум порядка прогона, Ф-Г-19). Объяснение — в `facts.md`; «не знаю» не принимается, потому что
  ровно этот индекс обслуживает рекурсивный обход `descendants_of:subtree`, по которому идёт гейт П6. ЛЮБОЕ другое
  расхождение вердиктов — СТОП и разбор. Превышение по (2) или сдвиг вердикта по (3) — НЕ подгонка порога и НЕ правка пина, а разбор: снять
  `EXPLAIN (ANALYZE, BUFFERS)` запроса под `withIdentity` и сравнить с `probe-rls-plan.log` — ищется `SubPlan` вместо
  `InitPlan`, потерянный индекс по `graph_id`, построчный вызов функции. Пин `explain` меняется только с записанной
  причиной в `facts.md` и в докблоке теста. (4) **`test:perf:graph` (П6) — три прогона подряд** после `volume` и
  `explain` (правка 21.09 по гейт-ревью Г-0, Р-ИГ-2 и Ф-Г-26: на НЕИЗМЕНЁННОМ коде Г-0 этот гейт взял порог лишь
  1 раз из 3 — решают выбросы хвоста, медианы устойчивы). Гейт: хотя бы ОДИН прогретый прогон с EXIT=0 (порог
  теста p95 < 100 мс не трогать). Регрессия: медиана `descendants_of:subtree` лучшего прогона > max(1,3 × 64,9;
  64,9 + 5) = **84,4 мс** либо p95 `recompute:subtree5k` > 1,3 × 639,4 = **831 мс**. Все три p95 обхода — в таблицу.
  Результаты — таблицей «сценарий / Г-0 / Г-4 / отношение» в `progress.md`.

- [ ] **Шаг 10: коммит.**
```
cd /Users/birzhan/projects/orbis/.claude/worktrees/graph-ownership-g && git add -A && git status --short | head -30 && git commit -m "$(printf 'feat(rls): изоляция «текущий граф ∧ членство» — 35 политик, две закрытые межграфовые дыры (срез Г, D44, Ш-3)\n\nМиграция 0021: четыре функции политик (SECURITY INVOKER, пустой search_path; обхода RLS нет), 35 политик\nсняты и созданы заново: у таблиц строк — по одной политике на команду (FOR ALL оставила бы observer право\nDELETE, а склейка пары через OR портит план UPDATE — Ф-Г-28), у шести реестров — своя форма с `graph_id IS NULL OR …`, чтобы стартовая проверка дрейфа читала\nвстроенные строки без идентичности. Политики выданы authenticated, а не PUBLIC: тела функций зовут\nauth.uid() при вызове, а у orbis_app нет USAGE на схему auth. Закрыты chat_threads.entity_id и\nenvelope_spent_cache.envelope_id; грант агенту выписывает только держатель гранта owner;\nagent_grants.issued_by — NOT NULL. Без текущего графа — пусто. pgTAP: plan(148). Поведенческий тест\n«граф ≠ аккаунт» зелёный без пометок, сторож пометок вернулся к форме toEqual([]). Перф — против базовой\nлинии Г-0 по семи медианам и против Г-3 по вердиктам скрипта планов (Р-ИГ-10).\n\nCo-Authored-By: Claude Opus 5 <noreply@anthropic.com>')"
```
  Закрытие — протокол глобальных ограничений; мерж в `main` — ТОЛЬКО при зелёном `graph-vs-account.test.ts` (гейт спеки Ш-3).

### Задача Г-5: Доки и D44, версия клиента, финальное ревью, репетиция, прод с окном простоя, приёмка, `handoff-b2.md` (Ш-4)

**Зачем:** решение «единица владения — граф» записывается в PRD одним заходом с D44, чтобы миссия не ссылалась на граф
компании раньше, чем записано решение о нём (спека §7); живые доки перестают называть ключ `owner_id`. Затем срез едет на
прод — и это первая в проекте выкатка с НЕаддитивной миграцией: `RENAME COLUMN` несовместим со старым кодом, между
миграцией и выкаткой прод падает на каждом запросе (спека §8.1). Окно простоя принято владельцем (В-Г-10); до прода —
репетиция на восстановленном дампе, потому что хеш применённых миграций drizzle не сверяет (Ф-Г-9) и бэкфилл на настоящих
данных не видел никто. Последним шагом срез оставляет `handoff-b2.md` — факты для будущей правки плана Б-2 (спека §8.2).
**Прод-процедура и приёмка живьём (шаги 9–15) — только отдельным словом владельца и вместе с ним.**

**Файлы:**
- Изменить (ветка): `packages/shared/src/constants.ts:3`, `apps/web/src/app/version.ts:2`; `scripts/ops.ts` (операции `dump`,
  `graphs`); `docs/prd/{00-product,01-architecture,02-core-os,03-budget,04-decision-log,05-mission}.md`;
  `docs/implementation/{00-architecture,02-ops-runbook,03-pending}.md`.
- Создать: `scripts/client-version.test.ts`; леджер — `step-prod-g.md`, `acceptance-g.md`, `handoff-b2.md`, `rehearsal/` (дамп,
  удаляется шагом 10).
- Изменить (в ОСНОВНОМ дереве, `main`, шагом 14): `render.yaml` — снять строку `autoDeploy: false`.
- НЕ трогать: спеку среза; план Б-2 и его леджер (правка — ПОСЛЕ мержа, отдельным словом владельца, §8.2); спеку реформы
  свойств (смысл `$owner` в §Б3-5 вносит владелец ревизией — в `03-pending`); `docs/superpowers/**` (протокол
  исполненного); в `05-mission` — НИ СЛОВА сверх двух фраз §7.

**Интерфейсы:**

*Consumes:* Г-1…Г-4 в `main` (`0019…0021`, `plan(148)`, ноль пометок `test.failing`, маркер `owner-key`); базовая линия Г-0;
`recon-5-docs.md` (адреса доков), `recon-4-harness-prod.md` §6–§7, §10 (прод-процедура Б-1/Б-2, 22 шага; ранбук §4.3; смоук 7/7).
```
.superpowers/sdd/2026-09-02-properties-reform-b1/step-prod-b1.md, acceptance-b1.md:20-30 — образцы сценария и таблицы приёмки
scripts/ops.ts:73-99 readDsn()/redact() · :101 withDb · :595-629 const OPS (белый список, десять операций)
scripts/backup.sh — читает ADMIN_DSN и BACKUP_DIR, последняя строка вывода `dump: <путь>`; плейн-SQL, схемы public + drizzle
docs/implementation/02-ops-runbook.md §4.3 (:1182+) — восстановление: чистая база, `\restrict` (psql ≥ 17.6), блок «Про права»
apps/server/src/app.ts:216-228 — /health: { status, registryDrift?, routineScheduler: 'off' | ISO | 'pending' }
Render: workspaceId tea-d93srfq8qa3s73bdfka0, orbis = srv-d9781kvavr4c73d85r60, https://orbis-64q4.onrender.com
```

*Produces:* D44 в `04-decision-log.md`; PRD и implementation-доки на словах §2 спеки; `MIN_COMPATIBLE_CLIENT_VERSION =
APP_VERSION = '0.2.0'` с пином; операции `ops.ts dump` и `ops.ts graphs`; срез в проде; `acceptance-g.md`; `handoff-b2.md`.

#### Часть А — код и доки в ветке

- [ ] **Шаг 1: версия клиента — красный пин, затем подъём (спека §8.1 Г-5, Ф-Г-20).** Поле провода `ownerId → graphId`
  сменилось в Г-1, а service worker и immutable-кеш держат старый клиент: сервер обязан отказать ему `412 CLIENT_OUTDATED`.
  Констант две, и связаны они только комментарием. Создать `scripts/client-version.test.ts`:
```ts
import { expect, test } from 'bun:test';
import { APP_VERSION } from '../apps/web/src/app/version';
import { MIN_COMPATIBLE_CLIENT_VERSION } from '../packages/shared/src/constants';

const parts = (v: string): number[] => v.split('.').map(Number);
function less(a: string, b: string): boolean {
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0);
  }
  return false;
}

test('свежий клиент проходит собственный версионный гейт: APP_VERSION ≥ MIN_COMPATIBLE_CLIENT_VERSION', () => {
  // Подняв минимум и забыв версию клиента, сервер отказал бы 412 каждому запросу только что
  // выкаченного веба. Константы живут в разных пакетах и связаны были одним комментарием.
  expect(less(APP_VERSION, MIN_COMPATIBLE_CLIENT_VERSION)).toBe(false);
});

test('срез Г: клиент со старым полем провода (ownerId) отсекается — минимум не ниже 0.2.0', () => {
  expect(less(MIN_COMPATIBLE_CLIENT_VERSION, '0.2.0')).toBe(false);
});
```
  Прогон `cd /Users/birzhan/projects/orbis/.claude/worktrees/graph-ownership-g && bun test scripts/client-version.test.ts` → второй тест **красный**. Затем
  `packages/shared/src/constants.ts:3` → `'0.2.0'` (комментарий: «0.2.0 — срез Г (D44): ключ провода `graphId`; клиент 0.1.x
  держит `ownerId`»), `apps/web/src/app/version.ts:1,2` → `'0.2.0'` (и комментарий `:1`). Пины старого значения:
  `cd /Users/birzhan/projects/orbis/.claude/worktrees/graph-ownership-g && git grep -n "0\.1\.0" -- apps packages scripts` даёт 10 строк — переводятся СЕМЬ (две константы с комментарием,
  `apps/server/src/context.test.ts:155,156`, `apps/web/src/trpc.test.tsx:21,24`); три НЕ трогать: `apps/web/package.json:31`
  (`react-markdown ^10.1.0` — совпадение по подстроке), `apps/server/src/router.test.ts:155` и `apps/server/src/trpc.ts:84`
  (заведомо невалидный формат `'v0.1.0'`). Прогон → зелёный.

- [ ] **Шаг 2: две операции только-чтения в `scripts/ops.ts`.** `dump` — В-ПГ-1 (умолчание); `graphs` — сверка бэкфилла на
  проде (произвольного SELECT в белом списке нет, и не будет). Функции — рядом с `ping` (`:526`), записи — в `OPS` (`:595`):
```ts
/**
 * Дамп прода в локальный каталог — вход репетиции миграций на настоящих данных (срез Г, D44).
 * Только чтение: обёртка над scripts/backup.sh (тот же pg_dump, что у ночного backup.yml), секрет —
 * из Ключницы и в вывод не попадает. Артефакт backup.yml зашифрован ключом владельца и без него
 * не читается, поэтому санкционированный путь к плейн-дампу — здесь. В файле ЛИЧНЫЕ ДАННЫЕ:
 * каталог обязан быть вне git, файл удаляется сразу после репетиции.
 */
async function dumpOp(args: string[]): Promise<number> {
  const dir = args[0];
  if (dir === undefined) {
    console.error('ops dump: укажи каталог ВНЕ git: bun scripts/ops.ts dump <каталог>');
    return 2;
  }
  const proc = Bun.spawnSync(['bash', 'scripts/backup.sh'], {
    env: { ...process.env, ADMIN_DSN: readDsn(), BACKUP_DIR: dir },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  console.log(redact(proc.stdout.toString()).trim());
  if (proc.exitCode !== 0) console.error(redact(proc.stderr.toString()).trim());
  return proc.exitCode ?? 1;
}

/** Только чтение: состояние владения после миграций 0019–0021 — графы, членство, гранты агентов. */
async function graphsCensus(): Promise<number> {
  return withDb(async (sql) => {
    const [g] = await sql<{ n: number; person: number }[]>`
      SELECT count(*)::int AS n, count(*) FILTER (WHERE owner_kind = 'person')::int AS person FROM graphs`;
    const [ownerless] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM graphs g WHERE NOT EXISTS (
        SELECT 1 FROM graph_members m
        WHERE m.graph_id = g.id AND m.grant_kind = 'owner' AND m.revoked_at IS NULL)`;
    const members = await sql<{ grant_kind: string; active: number; revoked: number }[]>`
      SELECT grant_kind, count(*) FILTER (WHERE revoked_at IS NULL)::int AS active,
             count(*) FILTER (WHERE revoked_at IS NOT NULL)::int AS revoked
      FROM graph_members GROUP BY 1 ORDER BY 1`;
    const [grants] = await sql<{ n: number; no_issuer: number }[]>`
      SELECT count(*)::int AS n, count(*) FILTER (WHERE issued_by IS NULL)::int AS no_issuer FROM agent_grants`;
    const [settings] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM user_settings`;
    console.log(`графов: ${g?.n} (личных ${g?.person}); без действующего гранта owner: ${ownerless?.n}`);
    for (const m of members) console.log(`членство ${m.grant_kind}: действующих ${m.active}, отозванных ${m.revoked}`);
    console.log(`грантов агентов: ${grants?.n}; без issued_by: ${grants?.no_issuer}`);
    console.log(`строк user_settings (графы с пройденным онбордингом): ${settings?.n}`);
    return ownerless?.n === 0 && grants?.no_issuer === 0 ? 0 : 1;
  });
}
```
```ts
  dump: { run: dumpOp, help: 'только чтение: плейн-дамп прода в <каталог> вне git (личные данные — удалить после репетиции)' },
  graphs: { run: graphsCensus, help: 'только чтение: графы, членство, гранты агентов; код 1 — есть граф без owner или грант без issued_by' },
```
  Проверка без прода: `cd /Users/birzhan/projects/orbis/.claude/worktrees/graph-ownership-g && bun scripts/ops.ts 2>&1 | grep -E '^  (dump|graphs) '` → обе строки в списке; `bun run typecheck`.

- [ ] **Шаг 3: PRD — `01-architecture.md`.** Слова — строго §2 спеки («граф», «аккаунт», «актор», «текущий граф», «грант на
  граф», «держатель гранта»); `owner_id` → `graph_id` везде, где описана ЖИВАЯ схема (38 строк, 45 вхождений; описания применённых
  миграций не трогать). Обязательные места:
  - `:39` (Принцип 1) — после «поверх одного графа» чтение тезиса: «(одна жизнь — один личный граф; работа лежит в графе
    компании, общая картина собирается запросом по нескольким графам — ступень 2, D44)».
  - §4.10, `:715` — принцип: «Принцип один: **каждая строка принадлежит ровно одному графу, и видит/меняет её только актор,
    держащий грант на ТЕКУЩИЙ граф транзакции** (D44). У транзакции два идентификатора — аккаунт-актор (`sub`) и текущий
    граф (ключ `graph` тех же claims); текущий граф ставит сервер. Без текущего графа — пусто (fail-closed), кроме встроенных
    строк реестров.»; шаблон `:717-722` — четыре покомандные политики `current_graph_select` / `_insert` / `_update` / `_delete` из `0021` с обеими
    функциями в обёртке `(SELECT …)` и фразой, почему по одной на команду, а не одна `FOR ALL` (у `FOR ALL` на DELETE
    работает только USING — observer удалял бы строки; склейка пары через OR портит план UPDATE, Ф-Г-28).
  - §4.10, «Особые случаи» (`:726-734`): `relations` — оба конца в одном ТЕКУЩЕМ графе; `chat_messages` — через тред
    текущего графа; реестры — форма `graph_id IS NULL OR (…)` и довод про проверку дрейфа; `entity_versions`,
    `entity_origins`, `chat_threads`, `envelope_spent_cache` — межграфовая строгость WITH CHECK (две последние — закрытые
    дыры); `agent_grants` — грант выдан НА ГРАФ, несёт `issued_by`, пишет его только держатель гранта `owner`;
    `user_settings` и планировщик — абзац о расширенной поверхности без идентичности: «к `scheduler_reads_owner_list`
    добавлена `scheduler_reads_members` (`graph_members FOR SELECT TO orbis_app`, `0020`): тик получает пары „граф,
    держатель гранта owner“; поверхность расширена на одну таблицу без тел».
  - §4.10, новые абзацы: таблицы `graphs` (CHECK тождества id личного графа, И-2, И-3) и `graph_members` (частичная
    уникальность, И-1 отложенными триггерами, у `authenticated` нет UPDATE/DELETE); функции политик — `SECURITY INVOKER`.
  - `:736` — «Политики генерируются из одного шаблона — переход owner→membership, предвиденный D11, исполнен D44».
  - `:738` — «все девятнадцать таблиц» → «все двадцать одну таблицу».
  - `:643`, `:908` — формулы `uuidv5`: «`<graph_id>:global-thread`… формула стоит на ключе ГРАФА (D44; у личного графа он
    равен id аккаунта, значения не изменились)»; слова про `workspace_id` снять.
  - `:1235` — резолвер entitlements: субъект — аккаунт (тариф на аккаунт), расход `ai_usage` — на граф (D44, В-Г-4).
  - `:1394` — «Планировщику нужны пары „граф, держатель гранта owner“ — единственное, что он делает без identity: читает
    `user_settings` и `graph_members` под служебной ролью (`0013`, `0020`), дальше — `withIdentity(пара)` и обычная RLS».

- [ ] **Шаг 4: PRD — `00-product`, `02-core-os`, `03-budget`, `04-decision-log`.**
  - `00-product.md:50` — к тезису «Один граф» дописать чтение §2 спеки: «одна жизнь — один личный граф; работа лежит в графе
    компании (ступень 2)»; `:75` — «**Multi-user-ready схема.** Каждая запись принадлежит графу, у графа есть владелец в
    записи — человек или организация (D44); аккаунт держит гранты на графы, личный граф создаётся при первом заходе»;
    `:238` — «Графы компаний, приглашения и гранты людей (ступень 2), организация как юридический субъект (ступень 3) — поверх
    единицы владения „граф“ (D44)»; глоссарий (`:258+`) — строки терминов §2 спеки ДОСЛОВНО по колонке «Значение»: **Граф**,
    **Владелец графа**, **Аккаунт**, **Актор**, **Текущий граф**, **Грант на граф**, **Личный граф / граф компании**,
    **Принципал**, **Ступень 1 / 2 / 3**; у строки «Грант доступа (`agent_grants`)» дописать «выдаётся на граф». `:33`
    («данные принадлежат пользователю») — продуктовая проза, остаётся.
  - `02-core-os.md:143,756`, `03-budget.md:378,402,407` — `owner_id` → `graph_id` в формулах и ключах уникальности.
  - `04-decision-log.md`: заголовок D36 (`:351`) не переписывать — в тело D36 добавить строку направления ДОСЛОВНО из §7
    спеки: «B2B — параллельный канал на том же ядре; ступень 2 — основатели и малые команды» и чтение «над одним графом» =
    «над личным графом человека; граф компании — ступень 2 (D44)»; таблица чек-листа `:466` — «Нейминг `graph_id` /
    `actor_user_id` | … | D44 (заменяет п. 1 D11)». Текст D11 (`:102-108`) НЕ править. После D43 — запись **D44** по форме
    D43 (`:447-455`): «Решение» — текст §7 спеки ДОСЛОВНО («Единица владения и изоляции — граф с владельцем в записи… Не
    отменяет D34/D37 (гранты агентов — на граф), D36, D38»); «Статус» — «направление принято владельцем 19.09.2026, решения
    В-Г-1…В-Г-10 — 20.09.2026; срез „Г — единица владения“ исполнен <дата мержа Г-4>, в проде — <заполняет шаг 16>»;
    «Обоснование» — §1 спеки (Р-Г-1…Р-Г-8, абзац «Почему привязка к логину не годится»); «Заменяет» — п. 1 чек-листа D11 и
    принцип §4.10; снимает отвергнутую D11 альтернативу `workspace_id`; уточняет D40; «Отложено этим же решением» — §6
    спеки списком; «Детали» — спека, план, `01-architecture` §4.10.

- [ ] **Шаг 5: `05-mission.md` — РОВНО слова §7 спеки, принятые владельцем 20.09 (В-Г-9).**
  `:74`, анти-цель 4 — заменить фразу «Граф принадлежит человеку: экспорт — всегда, данные переживают любое приложение и
  любого агента, уход — без потерь.» на: «Граф принадлежит своему владельцу: личный — человеку, граф компании — компании.
  Экспорт — всегда, данные переживают любое приложение и любого агента, уход — без потерь: личный граф компании не виден и
  уходит вместе с человеком.» (хвост пункта «Удержание — доверием, не замком.» остаётся). `:71`, анти-цель 1 — в конец пункта
  дописать чтение: «В графе компании: ассистент принадлежит человеку; рабочее место — компании. Компания получает свой
  процесс, свой журнал и нижнюю границу уровней в своём графе, но не человека: его личный граф, его приоритеты и память
  его ассистента работодателю не видны.» В шапке-таблице (`:6`) статус — «Принят владельцем (D40); анти-цели 1 и 4 уточнены D44».
  Проверка «ни слова сверх»: `cd /Users/birzhan/projects/orbis/.claude/worktrees/graph-ownership-g && git diff --stat -- docs/prd/05-mission.md` → `3 insertions(+), 3 deletions(-)`;
  в диффе нет ни одной строки, кроме `:6`, `:71`, `:74`.

- [ ] **Шаг 6: implementation-доки и реестр отложенного.**
  - `docs/implementation/00-architecture.md`: `:352` «Девятнадцать таблиц» → «Двадцать одна таблица»; ER-диаграмма `:358-607` —
    15 × `uuid owner_id` → `uuid graph_id` (строки `:362-580`), две новые сущности `graphs` и `graph_members` с колонками
    §3.1–§3.2 и 16 линий FK к `graphs` в блоке связей `:590-606`; `:613-621` — «Владение — `graph_id` на каждой таблице, где оно применимо…».
  - `docs/implementation/02-ops-runbook.md`: `:96`, `:648` — имя колонки; §4.3: список `\dt public.*` — 21 таблица (добавить
    `envelope_spent_cache`, `graphs`, `graph_members`) и фраза `:1204` «все 18 таблиц прод-схемы (одиннадцать исходных плюс
    семь реформы)» → «все 21 (одиннадцать исходных, восемь реформы, две — владения)»; блок «Владелец получит НОВЫЙ UUID» (`:1220-1278`; соседний блок про `agent_grants` — `:1280-1292`) переписать по
    существу — личный граф равен id аккаунта (CHECK), поэтому перепривязка = новый граф + перевод строк:
```sql
\set old '<старый-uuid>'
\set new '<новый-uuid-из Authentication → Users>'
BEGIN;
-- (1) личный граф нового аккаунта и его грант owner — одной транзакцией (И-1 проверяется на COMMIT)
INSERT INTO graphs (id, owner_kind, owner_ref) VALUES (:'new', 'person', :'new');
INSERT INTO graph_members (id, graph_id, account_id, grant_kind, issued_by)
  VALUES (gen_random_uuid(), :'new', :'new', 'owner', :'new');
-- (2) строки четырнадцати таблиц — в новый граф (agent_grants намеренно нет: см. ниже)
UPDATE entities                  SET graph_id = :'new' WHERE graph_id = :'old';
UPDATE aspect_definitions        SET graph_id = :'new' WHERE graph_id = :'old';
UPDATE user_settings             SET graph_id = :'new' WHERE graph_id = :'old';
UPDATE chat_threads              SET graph_id = :'new' WHERE graph_id = :'old';
UPDATE ai_usage                  SET graph_id = :'new' WHERE graph_id = :'old';
UPDATE entity_origins            SET graph_id = :'new' WHERE graph_id = :'old';
UPDATE entity_versions           SET graph_id = :'new' WHERE graph_id = :'old';
UPDATE envelope_spent_cache      SET graph_id = :'new' WHERE graph_id = :'old';
UPDATE property_definitions      SET graph_id = :'new' WHERE graph_id = :'old';
UPDATE relation_role_definitions SET graph_id = :'new' WHERE graph_id = :'old';
UPDATE contract_definitions      SET graph_id = :'new' WHERE graph_id = :'old';
UPDATE subscription_definitions  SET graph_id = :'new' WHERE graph_id = :'old';
UPDATE action_definitions        SET graph_id = :'new' WHERE graph_id = :'old';
UPDATE registry_deltas           SET graph_id = :'new' WHERE graph_id = :'old';
COMMIT;
```
    с тремя пояснениями: (а) формулы `uuidv5` стоят на ключе графа — id глобального треда и сидовых сущностей останутся
    от СТАРОГО ключа, это допустимо (id стабильны, `ensureGlobalThread` нового графа заведёт новый тред; старый остаётся
    читаемым) — записать как известное следствие; (б) старый граф НЕ удаляется: на него ссылаются погашенные `agent_grants`
    (их перепривязывать нельзя — воскресили бы доступ), он остаётся пустым надгробием со своим грантом owner; (в) прежние
    абзацы про `registry_deltas`, `entity_versions`, `relations`/`chat_messages` сохраняются с новым именем колонки.
    **Этот SQL проверяется пробой в шаге 10 (репетиция), а не выводится из PRD** — урок самого ранбука (`:1268-1278`).
    Блок «Про права» (`:1296-1335`) привести к миграциям ДОСЛОВНО — он отстал (три строки времён `0005`, «40 pgTAP-проверок»),
    а после среза ещё и молча снимал бы `REVOKE` миграции `0020` (строка `ON ALL TABLES` вернула бы `authenticated` UPDATE и
    DELETE на `graphs`/`graph_members`) и не выдавал бы тику `SELECT` на членство:
```sql
GRANT USAGE ON SCHEMA public TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON agent_grants, oauth_clients TO orbis_app;   -- 0005:47
GRANT SELECT, INSERT, UPDATE, DELETE ON entity_versions TO orbis_app;               -- 0011:41
GRANT SELECT ON user_settings TO orbis_app;                                         -- 0013:35
GRANT SELECT, INSERT, UPDATE, DELETE ON envelope_spent_cache TO orbis_app;          -- 0018:41
-- ПОСЛЕ строки ON ALL TABLES — владение (0020): у authenticated ровно SELECT и INSERT
REVOKE ALL ON graphs, graph_members FROM anon, authenticated;
GRANT SELECT, INSERT ON graphs, graph_members TO authenticated;
GRANT SELECT ON graph_members TO orbis_app;
```
    и число проверок в тексте рядом — `plan(148)`. Сверка блока с миграциями: `grep -n '^GRANT\|^REVOKE' apps/server/src/db/migrations/*.sql`.
  - `docs/implementation/03-pending.md` §2.2а: статус — «срез Г исполнен, в проде <дата>»; новые строки «при планировании
    ступени 2»: `user_settings` смешивает настройки аккаунта (`timezone`, `plan`) и графа — таймзона рутины в графе
    компании окажется таймзоной графа; составные имена «на граф» без `Id` и голое `owner` в тестах (список —
    `rename-ledger.md`) — переименовывать ли; строка «владельцу, ревизией 5 реформы свойств»: §Б3-5 — `$owner` есть id
    ТЕКУЩЕГО ГРАФА (в коде исполнено Г-3); строка «ступень 2»: формулы `uuidv5` после перепривязки владельца;
    строка «владельцу, при планировании страниц» (правка 21.09, Р-ИГ-7): экран согласия OAuth рендерится ВНЕ
    `OnboardingGate` (`apps/web/src/main.tsx:31-43`), поэтому аккаунт может дойти до согласия раньше, чем у него
    появится личный граф; срез отвечает на это типизированным отказом (`NotGraphOwnerError` → `FORBIDDEN`, Г-3),
    а правильный ли это ответ продуктово — «сначала онбординг» или «завести граф прямо на согласии» — решает владелец;
    `apps/web` срез не трогает;
    строка «ступень 2» (правка 21.09, Ф-Г-28): запрос в граф, где у актора нет гранта, отдаёт ноль строк, но
    платит сканом по строкам ЧУЖОГО графа — security-qual RLS в гейтовый `One-Time Filter` Postgres не поднимает;
    это тайминговый канал размера чужого графа для того, кто умеет назвать чужой `graph_id` (в v1 текущий граф
    выставляют резолверы сервера, путь недостижим). Формой политики не лечится — нужен отказ ДО запроса.

- [ ] **Шаг 7: гейты доков и коммиты ветки.**
```
cd /Users/birzhan/projects/orbis/.claude/worktrees/graph-ownership-g && git grep -nE 'принадлежит( ровно одному)? пользовател' -- docs/prd
cd /Users/birzhan/projects/orbis/.claude/worktrees/graph-ownership-g && git grep -anP '[oO]wner_?[Ii]d' -- docs/prd docs/implementation
cd /Users/birzhan/projects/orbis/.claude/worktrees/graph-ownership-g && bun run test && bun run lint && bun run typecheck && bun scripts/check-legacy-form.ts --gate
```
  Ожидание: первая — ПУСТО (спека Ш-4); вторая — только исторические записи: `04-decision-log.md` D11 (`:104`), D34, D39,
  D43 (записи принятых решений не переписываются), новая запись D44 (называет заменяемое имя), `03-pending.md` (строка
  решения В-Г-1) и абзацы ранбука, цитирующие СТАРУЮ ошибку с `relations`/`chat_messages` дословно; любая ДРУГАЯ строка —
  живой док со старым именем: дочинить. Третья — EXIT=0. Два коммита: `feat(ops): версия клиента 0.2.0 с пином, операции dump
  и graphs (срез Г, Г-5)` — `git commit -- packages/shared/src/constants.ts apps/web/src/app/version.ts
  scripts/client-version.test.ts scripts/ops.ts` (+ тронутые пины версии); `docs(prd): D44 — единица владения граф; §4.10,
  глоссарий, миссия (слова В-Г-9), ранбук §4.3, ER-диаграмма` — `git commit -- docs/`. Закрытие — гейт Fable → rebase → push →
  CI → ff-push в `main`.

- [ ] **Шаг 8: финальное ревью ветки.** По экземпляру `orchestrator-prompt.md` и образцу Б-1 (`…-b1/final/`): ревьюеры
  Fable 5.1 по измерениям — (1) идентичность: «id графа и id актора нигде не смешаны; `withIdentity` — только парой; пара
  рождается только в резолверах»; (2) RLS и миграции: состав 35/68 (по одной политике на команду), fail-closed, INVOKER, порядок `0020`; (3) обвязка и
  нулевое поведение Г-1 (нормализованный дифф, golden, счётчики); (4) доки против спеки §2/§7 («ни слова сверх» в миссии).
  В пакет — явный раздел «что уже проверено поштучно гейтами задач». Находки → по два опровергателя Opus 5 на находку →
  ОДНА фикс-волна → ре-ревью тем же ревьюером. Итог — `/Users/birzhan/projects/orbis/.superpowers/sdd/2026-09-20-graph-ownership/final/` (пакет, отчёты, мутации, APPROVE).

#### Часть Б — репетиция и прод (только отдельным словом владельца)

> **Три ловушки обвязки.** (1) cwd сбрасывается между вызовами Bash — в каждом `git`/`gh` свой `cd`. (2) Голый
> `bun scripts/ops.ts …` идёт БЕЗ `cd &&`, пайпов и `echo EXIT=` — allow-правило матчит только голую команду; он
> исполняется в каталоге сессии (основное дерево, `main` = ветка после ff-мержа). (3) Каждая прод-команда — отдельный вызов.

- [ ] **Шаг 9: сценарий и предпроверки (прода не касаются).** Скопировать `…-b1/step-prod-b1.md` в `/Users/birzhan/projects/orbis/.superpowers/sdd/2026-09-20-graph-ownership/step-prod-g.md` и
  переписать под шаги 10–16 этого плана ДО первой команды (`grep -c 'reset-world' step-prod-g.md` → 0: пересев не нужен).
```
cd /Users/birzhan/projects/orbis && git status --short && git fetch origin && git rev-parse HEAD origin/main
cd /Users/birzhan/projects/orbis && git log --oneline origin/main..graph-ownership-g | wc -l && git log --oneline graph-ownership-g..origin/main | wc -l
cd /Users/birzhan/projects/orbis && gh run list --branch main --limit 3
cd /Users/birzhan/projects/orbis/.claude/worktrees/graph-ownership-g && bun run test:perf:volume
cd /Users/birzhan/projects/orbis/.claude/worktrees/graph-ownership-g && bun run test
cd /Users/birzhan/projects/orbis/.claude/worktrees/graph-ownership-g && bun run test:rls
cd /Users/birzhan/projects/orbis/.claude/worktrees/graph-ownership-g && bun run test:perf
cd /Users/birzhan/projects/orbis/.claude/worktrees/graph-ownership-g && bun run --filter @orbis/web build && bun scripts/check-lazy-chunks.ts
```
  Ожидание: оба счётчика коммитов — 0 (ветка целиком в `main`), CI на HEAD `main` — `success`, все прогоны EXIT=0,
  `ls /Users/birzhan/projects/orbis/.superpowers/sdd/2026-09-20-graph-ownership/final/` — финальное ревью закрыто (APPROVE). Основное дерево перевести на свежий `main` (`git pull --ff-only`) —
  прод-операции берут `scripts/ops.ts` и миграции ОТТУДА; `git status --short` — пусто либо только неотслеживаемый план Б-2.

- [ ] **Шаг 10: репетиция на восстановленном дампе (спека §8.1 Г-5; В-ПГ-1, В-ПГ-3).** Локальная база общая для всех
  сессий — на время шага она занята; в дампе личные данные владельца.
```
bun scripts/ops.ts dump /Users/birzhan/projects/orbis/.superpowers/sdd/2026-09-20-graph-ownership/rehearsal
```
```
cd /Users/birzhan/projects/orbis/.claude/worktrees/graph-ownership-g && bunx supabase db reset && bun scripts/setup-db.ts
cd /Users/birzhan/projects/orbis/.claude/worktrees/graph-ownership-g && grep -vE '^\\(un)?restrict ' "$(ls -t /Users/birzhan/projects/orbis/.superpowers/sdd/2026-09-20-graph-ownership/rehearsal/orbis-backup-*.sql | head -1)" | psql "$(grep '^DATABASE_URL_ADMIN=' apps/server/.env | cut -d= -f2-)" -v ON_ERROR_STOP=1 > /Users/birzhan/projects/orbis/.superpowers/sdd/2026-09-20-graph-ownership/rehearsal/restore.log 2>&1; echo EXIT=$?
cd /Users/birzhan/projects/orbis/.claude/worktrees/graph-ownership-g && psql "$(grep '^DATABASE_URL_ADMIN=' apps/server/.env | cut -d= -f2-)" -At -c "SELECT count(*) FROM drizzle.__drizzle_migrations" -c "SELECT count(DISTINCT owner_id) FROM entities" -c "SELECT count(*) FROM agent_grants"
```
  Роли создаются ДО восстановления (`setup-db.ts` — дамп несёт политики `TO orbis_app`). Локальный `psql` — 14.19, мета-команд
  `\restrict`/`\unrestrict` дампа pg_dump 17.6+ он не знает — поэтому они отсеиваются `grep -v` (серверу они не нужны);
  запасной путь — `docker run --rm -i postgres:17-alpine psql` (ранбук §4.3). Каждый запрос сверки — своим `-c`: psql 14 при
  нескольких командах в одном `-c` печатает результат только последней. Ожидание: EXIT=0; журнал миграций —
  **17** записей; колонка ещё `owner_id` (дамп снят ДО среза). Права после восстановления — ЯВНЫМ SQL, до `db:migrate`
  (дамп — `--no-privileges`, а журнал миграций в нём: гранты `0000…0018` никто не переприменит; блок ранбука §4.3 на
  `877e13a` устарел — в нём нет грантов `orbis_app` из `0011:41`, `0013:35`, `0018:41`, которые пинит pgTAP `:416`, `:682-685`):
```
cd /Users/birzhan/projects/orbis/.claude/worktrees/graph-ownership-g && psql "$(grep '^DATABASE_URL_ADMIN=' apps/server/.env | cut -d= -f2-)" -v ON_ERROR_STOP=1 -c "GRANT USAGE ON SCHEMA public TO authenticated" -c "GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO authenticated" -c "GRANT SELECT, INSERT, UPDATE, DELETE ON agent_grants, oauth_clients TO orbis_app" -c "GRANT SELECT, INSERT, UPDATE, DELETE ON entity_versions TO orbis_app" -c "GRANT SELECT ON user_settings TO orbis_app" -c "GRANT SELECT, INSERT, UPDATE, DELETE ON envelope_spent_cache TO orbis_app"
```
  Гранты новых таблиц (`REVOKE` + `SELECT, INSERT` + `SELECT … TO orbis_app`) выдаст сама миграция `0020` следующим действием. Отказ `schema "public" already exists` — пересоздать схему по тому же §4.3
  («восстанавливать в чистую БД») и повторить. Затем — накат трёх миграций среза на настоящих данных и сверка:
```
cd /Users/birzhan/projects/orbis/.claude/worktrees/graph-ownership-g && bun run --filter @orbis/server db:migrate
cd /Users/birzhan/projects/orbis/.claude/worktrees/graph-ownership-g && psql "$(grep '^DATABASE_URL_ADMIN=' apps/server/.env | cut -d= -f2-)" -At -c "SELECT count(*) FROM drizzle.__drizzle_migrations" -c "SELECT count(*) FROM graphs" -c "SELECT count(*) FROM graph_members WHERE grant_kind='owner' AND revoked_at IS NULL" -c "SELECT count(*) FROM graphs g WHERE NOT EXISTS (SELECT 1 FROM graph_members m WHERE m.graph_id=g.id)" -c "SELECT count(*) FROM agent_grants WHERE issued_by IS NULL" -c "SELECT count(*) FROM pg_policies WHERE schemaname='public'"
cd /Users/birzhan/projects/orbis/.claude/worktrees/graph-ownership-g && bun run test:rls
```
  Ожидание: журнал — **20**; графов = числу различных ключей до миграции (у владельца-одиночки — 1, плюс графы прочих
  строк, если есть); действующих `owner` = графов; графов без членства — 0; грантов без `issued_by` — 0; политик — **77**;
  pgTAP на восстановленной базе — `plan(148)` зелёный (файл — одна транзакция с ROLLBACK, данные не трогает). Любой отказ
  миграции здесь — СТОП до прода: это ровно то, ради чего репетиция. Проба процедуры ранбука (шаг 6) — в транзакции с
  откатом: подставить в SQL перепривязки `:old` = uuid владельца, `:new` = `gen_random_uuid()`, заменить `COMMIT` на
  `SET CONSTRAINTS ALL IMMEDIATE; ROLLBACK;` — EXIT=0 доказывает, что текст ранбука исполним. Уборка — тем же шагом:
```
cd /Users/birzhan/projects/orbis && rm -rf .superpowers/sdd/2026-09-20-graph-ownership/rehearsal
cd /Users/birzhan/projects/orbis/.claude/worktrees/graph-ownership-g && bunx supabase db reset && bun run db:prepare
```
  В `progress.md` — числа репетиции (без содержимого данных).

- [ ] **Шаг 11: картина прода ДО.** `main` уже несёт новый код, а прод — старую схему: операции белого списка, которые
  называют ключ строк (`check`, `seed-registries`, `reset-world`, `issue-pat`), до миграции НЕИСПОЛНИМЫ — упадут на
  `column "graph_id" does not exist` (`db/registry-drift.ts:67-78,97-99`). Пригодны `ping`, `census`, `dump`, `migrate`.
  «Реестры чисты ДО» подтверждает `/health` без `registryDrift` — его считает ещё старый, работающий код. Каждая — отдельным вызовом:
```
bun scripts/ops.ts ping
```
```
bun scripts/ops.ts census
```
```
curl -s https://orbis-64q4.onrender.com/health
```
  Ожидание: `PostgreSQL 17.x`; `census` — `тел всего: N` (контрольная точка шага 13); `/health` — `status: ok` БЕЗ ключа `registryDrift` (дрейф здесь — СТОП и разбор: срез реестров не трогал), `routineScheduler` — ISO. Числа экрана
  Бюджета и `mcp__orbis__budget_status` — записать ДО (сверка приёмки).

- [ ] **Шаг 12: ОКНО ПРОСТОЯ — начало. Планировщик выключен (В-ПГ-2), страховочный бэкап.** Владелец: Render → orbis →
  Environment → `ORBIS_ROUTINE_SCHEDULER` = `0` → **Save only** → Manual Deploy → **Restart service**.
  `mcp__render__update_environment_variables` НЕ использовать: смена переменной деплоит HEAD `main` — новый код ДО миграции.
  `render.yaml` не трогать. Гейт:
```
curl -s https://orbis-64q4.onrender.com/health
```
  Ожидание: `"routineScheduler":"off"`. Не `off` — рестарт переменную не подхватил: «Manual Deploy → Deploy a specific
  commit» на текущий прод-коммит (id — из `mcp__render__list_deploys`, деплой со статусом `live`), затем повторить гейт.
  Keep-warm (`.github/workflows/keep-warm.yml`, cron 10 мин) во время окна может покраснеть — это шум, не отказ. Бэкап:
```
cd /Users/birzhan/projects/orbis && gh workflow run backup.yml
```
```
cd /Users/birzhan/projects/orbis && gh run list --workflow=backup.yml --limit 1
```
  До `success` (~1 мин). Красный бэкап — СТОП: миграция без страховки не идёт.

- [ ] **Шаг 13: миграция — три файла одной транзакцией (Ф-Г-9) и сверка.**
```
bun scripts/ops.ts migrate
```
```
bun scripts/ops.ts graphs
```
```
bun scripts/ops.ts check
```
```
bun scripts/ops.ts census
```
  Пины: `migrate: применено 3 (в журнале 20)` — иное число — СТОП; `graphs` — EXIT 0, числа равны числам репетиции (графов
  без действующего `owner` — 0, грантов без `issued_by` — 0); `check` — шесть `✓`; `census` — `тел всего` = N шага 11.
  **С этого момента и до конца шага 14 прод отвечает ошибкой на каждый запрос** — старый код не знает `graph_id`.

- [ ] **Шаг 14: выкатка кода, конец окна, автодеплой обратно.** `mcp__render__get_service` → `autoDeploy: "no"`;
  `mcp__render__trigger_deploy` (`clearCache: false`) → `mcp__render__get_deploy` до `live`; затем:
```
curl -s https://orbis-64q4.onrender.com/health
```
  Ожидание: `{"status":"ok", …}` БЕЗ ключа `registryDrift`. **Деплой не поднялся** (`build_failed`/`update_failed`, либо
  `/health` не отвечает): окно продолжается, старый инстанс на новой схеме неработоспособен — чинить ВПЕРЁД
  (`mcp__render__list_logs` → причина → коммит → `trigger_deploy`); обратная миграция (три `ALTER … RENAME` назад плюс снос
  таблиц) не предусмотрена и делается только словом владельца — страховка на этот случай есть: бэкап шага 12. Планировщик: если `routineScheduler` всё ещё `"off"` — владелец
  возвращает в Render UI `ORBIS_ROUTINE_SCHEDULER` = `1` (Save only → Restart); гейт — `routineScheduler` = `pending` либо
  ISO-метка, через минуту — свежая ISO-метка (тик прошёл под парой из `identitiesForScheduler`). Значение в UI обязано
  совпасть с `render.yaml` (`"1"`). Окно закрыто — записать длительность. Автодеплой — docs-коммитом в `main`:
```
cd /Users/birzhan/projects/orbis && sed -i '' '/autoDeploy: false/d' render.yaml && grep -c autoDeploy render.yaml; git add render.yaml && git commit -m "$(printf 'ops(render): автодеплой сервиса orbis возвращён после прод-процедуры среза «Г — единица владения» (D44)\n\nМиграции 0019–0021 на проде, код выкачен, /health без дрейфа, планировщик рутин тикает под парой\n«актор + текущий граф». Образец — 30b22db.\n\nCo-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>')" && git push origin main
```
  Проверять ФЛАГ (`mcp__render__get_service` → `autoDeploy: "yes"`), а не факт деплоя (ловушка Б-1); `grep -c` → 0.

- [ ] **Шаг 15: приёмка живьём → `/Users/birzhan/projects/orbis/.superpowers/sdd/2026-09-20-graph-ownership/acceptance-g.md`.** Таблица по образцу `acceptance-b1.md:20-30`; «зелёный» без
  носителя (скриншот, вывод, id) не засчитывается. MCP-клиент сессии ПЕРЕПОДКЛЮЧИТЬ (кеширует список тулов).

| # | Сценарий | Что смотрим | Ожидание |
|---|---|---|---|
| 1 | вход | открытая ДО выкатки вкладка (клиент 0.1.0) | экран «требуется обновление» (412 `CLIENT_OUTDATED`), после перезагрузки — клиент 0.2.0, сессия жива |
| 2 | Повестка | экран Agenda, DevTools → Network | один `agenda.list`, список непуст, ошибок нет |
| 3 | запись | создать заметку в вебе, поправить тело, отменить правку (Undo) | запись создана; в ленте — действие владельца; черновик тела не всплывает после сохранения |
| 4 | Бюджет | экран Overview + `mcp__orbis__budget_status` | числа равны зафиксированным в шаге 11 |
| 5 | агент | `mcp__orbis__entity_query` и `mcp__orbis__entity_create` грантом, выданным ДО среза | оба проходят: у гранта `issued_by` из бэкфилла; в ленте — `actor_kind = agent`; новый грант («Настройки → Агенты») выписывается |
| 6 | планировщик | `/health` с интервалом в две минуты | `routineScheduler` — свежие ISO-метки; в логах Render нет `42501` и `column … does not exist` |
| 7 | экспорт | «Настройки → Экспорт» | файл скачан, у сущностей ключ `graphId`, ключа `ownerId` нет |
| 8 | владение | `bun scripts/ops.ts graphs` | EXIT 0; графов ≥ строк `user_settings`, разница объяснена числами репетиции (ключи без онбординга); у каждого графа — действующий `owner` |
| 9 | `/health` | `curl` | `status: ok`, без `registryDrift` |

  Сценарий «граф ≠ аккаунт» живьём НЕ снимается: второго аккаунта и пути выдачи гранта человеку в v1 нет (§6 спеки) — его
  держит `graph-vs-account.test.ts` и группа 23 pgTAP; в таблицу записать это одной строкой.

- [ ] **Шаг 16: статусы.** `04-decision-log.md`, D44 «Статус» — дата прода и итог приёмки (9/9); `03-pending.md` §2.2а — «в
  проде <дата>»; docs-коммит в `main`. `progress.md` леджера — итог среза четырьмя блоками: что сделано (хеши задач),
  цифры (счётчики сьютов, `plan(148)`, семь медиан Г-0 → Г-4, длительность окна, расход токенов), находки ревью
  (Critical/Important/Minor, ложных), остатки владельцу.

- [ ] **Шаг 17: `/Users/birzhan/projects/orbis/.superpowers/sdd/2026-09-20-graph-ownership/handoff-b2.md` — факты для правки плана Б-2 (спека §8.2; правка — отдельным словом владельца).**
  Только факты, снятые с `main` ПОСЛЕ среза, каждая строка — с командой, которой снята:
  1. **HEAD:** `git rev-parse --short origin/main`; дата; «план Б-2 и его леджер срезом Г не тронуты».
  2. **Миграции:** заняты `0019_graph_key_rename`, `0020_graphs_members`, `0021_graph_rls`; следующий свободный — `0022`
     (⇒ у Б-2 `0019` → `0022`, резерв `0020` → `0023`, «третья = СТОП» — `0024`; правило Р-18 по смыслу не меняется); в
     `_journal.json` — 20 записей (⇒ пин прод-шага Б-2 «применено 1 (в журнале 18)» → «(в журнале 21)»); снимок, от которого
     Б-2 строит миграцию, — `meta/0021_snapshot.json`.
  3. **pgTAP:** `SELECT plan(148);` (`rls.pgtap.sql:6`) — пять мест плана Б-2 с `plan(97)` (`:225, :321, :355, :3421, :3592`);
     таблиц под ENABLE+FORCE — 21; claims в pgTAP несут ключ `graph`.
  4. **API идентичности (итоговые имена, дословно из блока Produces задачи Г-3):** `AccountId`, `GraphId`
     (`packages/shared/src/ids.ts`); `Identity`, `parseAccountId`, `parseGraphId`, `identityOfPerson`, `identityOfGrant`,
     `identitiesForScheduler` (`apps/server/src/identity.ts`); `withIdentity(db, who: Identity, fn)`; `Context.identity`,
     `ExecuteRequest.identity`, `ToolCallCtx.identity`; `GrantIdentity { grantId, accountId, graphId, scope, label }`;
     `EntitlementResolver(subject: AccountId, key)`; `CompileCtx.graphId` (`$owner` = текущий граф). Правило для сниппетов
     Б-2 (59 `withIdentity(` и 52 `actorUserId` — НЕ механически): ключ строк/реестра/замка/формулы — `identity.graph`; `sub`,
     журнал `actor_user_id`, entitlements — `identity.actor`.
  5. **Тестовая обвязка:** `freshUserId` снят → `await freshGraph()` / `mintGraph()` / `ensureGraphs()`; `personal(graph)`,
     `accountOf(graph)`, `addMember(…)`; `truncateAll` восстанавливает личности процесса; `GRAPH_TABLES` → `WORLD_TABLES`.
  6. **Гейт имён:** маркер `owner-key` (`[oO]wner_?[Ii]d`) в `scripts/check-legacy-form.ts` — любой сниппет Б-2 с
     `ownerId`/`owner_id` (251 вхождение) уронит CI; счётчики по задачам пересчитать командой `git grep -c` на черновиках.
  7. **Базовая линия после Г:** счётчики сьютов, семь медиан, вердикты `explain`, числа сида — из шага 9 этой задачи
     (⇒ задача 0a Б-2 снимает свою линию заново, эти числа — ориентир).
  8. **Адреса разведки Б-2, сдвинутые срезом:** файлы, которые Г-2…Г-4 меняли существенно — `db/with-identity.ts`,
     `context.ts`, `trpc.ts`, `seed/onboarding.ts`, `test/helpers.ts`, `executor/{types,executor,journal}.ts`,
     `tools/dispatch.ts`, `oauth/grants.ts`, `routines/{queries,scheduler}.ts`, `registry/{ops,cache}.ts`, миграции, pgTAP —
     раздел плана Б-2 «Что установила разведка HEAD» (`:45-69`) переснять.
  9. **Прод:** версия клиента `0.2.0`; операции `ops.ts dump`, `ops.ts graphs`; ранбук §4.3 переписан; чек-лист финального
     ревью Б-2 получает линзу «id графа и id актора не смешаны; `withIdentity` — только парой».
  10. **Не меняется в Б-2:** задача 15 («пол политики», Р-27) и задача 0b (новых кодов отказа срез Г не ввёл).

- [ ] **Шаг 18: уборка.** Worktree снимается, ветка остаётся:
```
cd /Users/birzhan/projects/orbis && git worktree remove .claude/worktrees/graph-ownership-g && git worktree list && git branch --list graph-ownership-g
```
  Отчёт `task-Г-5-report.md` в леджере; доклад владельцу — итог среза, остатки, напоминание: правка плана Б-2 по
  `handoff-b2.md` — отдельным его словом.

## Вехи и прогоняемые проверки

| Веха | Задачи | Проверки при закрытии |
|---|---|---|
| 0 | Г-0 | базовая линия: `bun run test`, `lint`, `typecheck`, `test:rls` (`plan(97)`), `test:perf` (семь медиан), `test:perf:volume` → `explain` → `graph`, `check-legacy-form --gate`, сборка веба; проба планов §3.6 (`InitPlan`, fail-closed); прод `autoDeploy: "no"` |
| I | Г-1 | гейт `owner-key` = 0; нормализованный дифф = только ручные правки; golden «только имя»; `tool-registry.json` и фикстуры промптов байт-в-байт; счётчики сьютов РАВНЫ Г-0; `plan(97)`; снимок `0019` = схема |
| II | Г-2 | `graphs.test.ts` (CHECK, И-1 с гонкой и мутацией замка, бэкфилл по 15 таблицам, `truncateAll`), `graphs-policies.test.ts`, `reset-world.test.ts`; `plan(125)`; ноль FK-отказов в полном прогоне; снимок `0020` = схема |
| III | Г-3 | `typecheck` с двумя `@ts-expect-error`; греп-гейт приведений пуст; `identity.test.ts`, близнец interleaved-теста; ровно ДВЕ пометки `test.failing` (обе — «граф ≠ аккаунт»); внеCI-скрипты зелёные |
| IV | Г-4 | **гейт: `graph-vs-account.test.ts` зелёный без пометок**; `plan(148)`; политик 77, `owner_owns%` — 0; тест дрейфа зелёный без идентичности; четыре мутации политик; перф по Р-КГ-10, вердикты `explain` = Г-0 |
| V | Г-5 | гейты доков (фраза PRD — 0, `owner_id` в живых доках — только исторические записи); пин версий; финальное ревью APPROVE; репетиция на дампе (журнал 17 → 20, политик 77, `plan(148)`); прод; приёмка 9/9; `handoff-b2.md` |

## Порядок деплоя (кратко; подробно — задача Г-5, шаги 9–15)

предпроверки и гейты → `ops.ts dump` → репетиция на локальной базе (восстановление → `0019…0021` → сверка → уборка) →
`ops.ts ping` / `census`, `/health` без дрейфа (`check` до миграции неисполним — новый код против старой схемы) → **окно:** планировщик `0` в Render UI + рестарт, гейт `/health.routineScheduler
== "off"` → `gh workflow run backup.yml` → `ops.ts migrate` (`применено 3 (в журнале 20)`) → `ops.ts graphs` / `check` /
`census` → `mcp__render__trigger_deploy` → `/health` без `registryDrift` → планировщик `1`, гейт — свежая ISO-метка →
**конец окна** → `render.yaml` автодеплой обратно (флаг `"yes"`) → приёмка живьём. `reset-world` и `seed-registries` не
нужны: реестры срез не трогает.

## Маппинг нормативных утверждений спеки (§3, §5, §8.1) → задача и шаг

| § спеки | Утверждение | Задача, шаг |
|---|---|---|
| §3.1 | `graphs`: `id` PK, `owner_kind` ∈ {person, organization}, `owner_ref`, `created_at` | Г-2, ш. 3–4 |
| §3.1 | несущий CHECK «у person id = owner_ref»; «один личный граф на аккаунт» — из PK | Г-2, ш. 1, 3–4, 8 (гр. 20); эррата Э-3 |
| §3.1 | у `organization` `owner_ref` допускает NULL; INSERT-политика v1 пускает только person | Г-2, ш. 4, 8 (гр. 20) |
| §3.1 | у обеих таблиц ENABLE и FORCE RLS | Г-2, ш. 4, 8 (проверка 21 таблицы) |
| §3.1 | FK на `auth.users` не объявляется | Г-1, ш. 6 (докблок схемы); Г-2, ш. 3 |
| §3.2 | `graph_members`: суррогатный `id` (история отзывов не затирается), `graph_id` FK NO ACTION, `account_id` без FK, `grant_kind` ∈ {owner, operator, observer}, `issued_at`, `issued_by`, `revoked_at` | Г-2, ш. 1 (тест истории), 3–4 |
| §3.2 | частичная уникальность `(graph_id, account_id) WHERE revoked_at IS NULL` | Г-2, ш. 1, 4, 8 (гр. 21) |
| §3.2 | в v1 — только строки `owner` личных графов; не сливается с `agent_grants` | Г-2, ш. 3 (докблок), 4 (бэкфилл, INSERT-политика), 5 (сид) |
| §3.3 И-1 | DEFERRABLE constraint trigger + замок строки графа `FOR NO KEY UPDATE`; тест гонки под админ-DSN | Г-2, ш. 1, 4, 11 (мутация замка) |
| §3.3 И-1 | граница v1 (у `authenticated` пути отзыва нет) и долг ступени 2 записаны | Г-2, ш. 4 (докблок миграции), 8 (гр. 20–21: политик UPDATE/DELETE нет — даже с выданным правом ноль строк) |
| §3.3 И-2 | у `graphs` нет политик UPDATE/DELETE | Г-2, ш. 4, 8 (гр. 20) |
| §3.3 И-3 | один личный граф на аккаунт | Г-2, ш. 1, 3 |
| §3.4 | колонка переименовывается на 15 таблицах; `relations` владеет через оба конца, `chat_messages` — через тред | Г-1, ш. 7; Г-4, ш. 4 |
| §3.4 | FK `graph_id → graphs.id ON DELETE NO ACTION`; у реестров NULL = встроенное | Г-2, ш. 3–4 |
| §3.4 | D44 заменяет п. 1 чек-листа D11; запрет `user_id` остаётся | Г-5, ш. 4 |
| §3.4 | `ownerId` по смыслу граф → `graphId`/`graph_id` | Г-1, ш. 4 |
| §3.4 | `ownerId` по смыслу аккаунт → `accountId`, источник — сессия; каждый сайт классифицируется | Г-1, ш. 2, 3, 13 (`rename-ledger.md`); entitlements — Г-3, ш. 8; эрраты Э-7, Э-10 |
| §3.4 | `GraphId` и `AccountId` — бренды; `withIdentity(db, graphId)` не компилируется | Г-3, ш. 2, 4, 5 |
| §3.4 | роль «владелец» остаётся; составные имена — решение плана, список в леджер | Г-1 , «НЕ трогать», ш. 2 (разделы а, в); РП-6 |
| §3.4 | провод и веб: поле меняется, старый клиент ломается | Г-1, ш. 3–4; Г-5, ш. 1 |
| §3.4 | golden, фикстуры, pgTAP; свежий drizzle-снимок с expect-обёрткой | Г-1, ш. 4, 5, 7, 8; эррата Э-8 |
| §3.4 | экспорт: ключ дампа меняется, тест обновляется | Г-1, ш. 4; Г-5, ш. 15 (сценарий 7); Р-КГ-12 |
| §3.4 | применённые миграции не правятся; греп-гейт — ноль | Г-1, ш. 1, 12; Г-5, ш. 7; эррата Э-1 |
| §3.4 | `chat_threads`: формула `uuidv5` на ключе графа работает; общий тред графа компании не предрешается | Г-1, ш. 9 (докблок `ids.ts`); Г-3, ш. 8 (`ensureGlobalThread` по `GraphId`) |
| §3.4 | `agent_grants`: грант на граф; `issued_by` той же миграцией с бэкфиллом; пишут четыре места выдачи | Г-2, ш. 3–4; Г-3, ш. 7; Р-КГ-2 |
| §3.4 | `agent_grants` WITH CHECK — только держатель гранта `owner` | Г-4, ш. 2 (гр. 23), 4 (политика); Г-3, ш. 7 (`assertHoldsOwnerGrant`: боевая выдача идёт под `orbis_app` мимо политики) |
| §3.4 | `user_settings` — PK `graph_id`; смешение настроек аккаунта и графа — долг | Г-1, ш. 7; Г-5, ш. 6 (`03-pending`) |
| §3.4 | `ai_usage` — расход на граф; реестры и дельты — на граф, загрузчик фильтрует по ключу | Г-3, ш. 8 (`recordUsage`, `effectiveRegistry`) |
| §3.5 | `withIdentity(db, { actor, graph }, fn)`: `sub` = актор + транзакционно-локальный GUC графа | Г-3, ш. 5 |
| §3.5 | пара рождается ровно в трёх резолверах; приведение брендов вне них — дефект | Г-3, ш. 3, 7, 12; эррата Э-5 |
| §3.5 | JWT → `{sub, личныйГраф(sub)}` — единственное место тождества id | Г-3, ш. 1, 3, 7 |
| §3.5 | Bearer (`context.ts`, `/mcp`) → `{issued_by, graph_id}` из строки гранта | Г-3, ш. 1, 7 |
| §3.5 | тик и раннер рутин → пары из `graph_members` | Г-3, ш. 1, 3, 8 |
| §3.5 | прочие входы (сиды, `import/review`, `ai/metering`, `agent-loop/sweep`, экспорт, OAuth) получают пару от резолверов | Г-3, ш. 8 (таблица листьев) |
| §3.5 | `registry-drift` ходит без идентичности намеренно | Г-4, ш. 4 (форма реестров), 6 |
| §3.5 | граф — ключом внутри `request.jwt.claims`; чтение — через `NULLIF(current_setting(…, true), '')` | Г-3, ш. 5; Г-4, ш. 4 (`current_graph_id`) |
| §3.5 | близнец interleaved-теста на граф | Г-3, ш. 4 |
| §3.5 | актор путей без человека: агент — `issued_by`, рутина и тик — держатель гранта `owner`; значения — из своих источников | Г-3, ш. 1 (резолвер 3 на паре с разными id), 7, 8 |
| §3.5 | тик идёт под `orbis_app` без идентичности — нужна политика | Г-2, ш. 4, 8 (гр. 22), 9; эррата Э-2 |
| §3.5 | идентичность гранта `{ accountId, graphId, grantId, scope, label }` | Г-3, ш. 7 |
| §3.5 | обязательный тест «граф ≠ аккаунт» (четыре проверки) | Г-3, ш. 9; Г-4, ш. 1, 6 |
| §3.6 | шаблон строк: `graph_id = (SELECT текущий_граф()) AND (SELECT актор_читает())`, обе половины в `(SELECT …)` | Г-0, ш. 11 (проба); Г-4, ш. 4 |
| §3.6 | WITH CHECK — «пишет»: owner, operator; observer — только чтение; `revoked_at IS NULL`; без текущего графа — «нет» | Г-4, ш. 2 (гр. 23), 4, 6 (мутации); эррата Э-12 |
| §3.6 | функции политик — `SECURITY INVOKER`, `SET search_path = ''`; DEFINER не вводится | Г-4, ш. 2 (структурный пин), 4 |
| §3.6 | реестры — своя форма `graph_id IS NULL OR (…)`; тест дрейфа зелёный без идентичности | Г-4, ш. 2, 4, 6 |
| §3.6 | планировщик: `graph_members FOR SELECT TO orbis_app` + GRANT; группа pgTAP по образцу 11; абзац в §4.10; `scheduler_reads_owner_list` не переписывается | Г-2, ш. 4, 8 (гр. 22), 9; Г-5, ш. 3; эррата Э-11 |
| §3.6 | вариант `graph_id = auth.uid() OR …` исключён | Г-4, ш. 2 (пин `pg_policies`), 4 |
| §3.6 | «все мои графы» умолчанием не бывает | Г-4, ш. 2 (гр. 23: свой личный граф не виден в чужом текущем) |
| §3.6 | `graphs`: SELECT — по действующему гранту; INSERT — person и `id = owner_ref = auth.uid()`, без RETURNING; UPDATE/DELETE нет | Г-2, ш. 4, 5, 8 (гр. 20) |
| §3.6 | `graph_members`: SELECT — своё; INSERT — себя `owner` личного графа равенством id, без EXISTS; UPDATE/DELETE нет; сид под `authenticated` | Г-2, ш. 4, 5, 8 (гр. 21) |
| §3.6 | межграфовая строгость: `entity_versions`, `entity_origins`, `envelope_spent_cache`, `chat_messages`, `chat_threads.entity_id`; у `relations` оба конца в текущем графе | Г-4, ш. 2 (гр. 23), 4; эррата Э-4 |
| §3.6 | механика: новая миграция DROP/CREATE, применённые не правятся, 35 политик; новым таблицам — явные GRANT | Г-2, ш. 4; Г-4, ш. 4, 5 |
| §3.7 | ассистент, память, журнал, уровни — без швов сейчас | не делается (ступень 2); журнал «актор — аккаунт, граф — из строки» — Г-3, ш. 8, 9 |
| §5 Ш-1а | отдельным коммитом, поведение нулевое; дифф golden — одно имя; счётчики равны базовой линии; классификация в леджере; снимок; греп-гейт | Г-1, ш. 5, 7, 11, 12, 13, 14 |
| §5 Ш-1б | бэкфилл внутри миграции: графы из 15 таблиц + строки `owner` → затем FK; у реестров `WHERE graph_id IS NOT NULL`, дубли снимает `UNION` | Г-2, ш. 4 |
| §5 Ш-1б | граф и грант — первым шагом `seedOwnerGraph`, до `seedOwnerWorld` | Г-2, ш. 5 |
| §5 Ш-1б | `freshUserId()` заменяется хелпером «свежий граф с грантом»; `truncateAll` + `graphs`, `graph_members`; INSERT'ы pgTAP и фикстуры перфа получают строки графа | Г-2, ш. 6, 7, 8; Р-КГ-3; эррата Э-6 |
| §5 Ш-1б | `reset-world`: графы и членство переживают пересев | Г-2, ш. 10 |
| §5 Ш-1б | бэкфилл — тест на админ-DSN (снять FK → очистить → текст бэкфилла → вернуть FK → сверить) плюс репетиция на бэкапе | Г-2, ш. 2; Г-5, ш. 10 |
| §5 Ш-1б | проверки: личный граф идемпотентен; CHECK; И-1 с гонкой; `reset-world` оставляет графы; `truncateAll` сносит | Г-2, ш. 1, 5, 8, 10; эррата Э-13 |
| §5 Ш-2 | `withIdentity(db, graphId)` не компилируется; резолверы — единственные места рождения пары; греп-гейт приведений; близнец interleaved; журнал пишет актора | Г-3, ш. 3, 4, 9, 11, 12 |
| §5 Ш-2 | тест «граф ≠ аккаунт» в Г-3 красный с пометкой, зелёным становится в Г-4 и служит её гейтом | Г-3, ш. 9, 13; Г-4, ш. 1, 6; Р-КГ-11 |
| §5 Ш-3 | pgTAP по §3.6 целиком, включая группу планировщика и тест дрейфа без идентичности | Г-2, ш. 8; Г-4, ш. 2, 5, 6 |
| §5 Ш-3 | перф: семь медиан базовой линии и вердикт скрипта планов — без регрессии, вердикт запинен тестом | Г-0, ш. 9; Г-4, ш. 9; Р-КГ-10 |
| §5 Ш-4 | `01-architecture` §4.10 (принцип; 19 → 21), `:643`, `:908`, `:1235`, `:39`; абзац о поверхности планировщика | Г-5, ш. 3 |
| §5 Ш-4 | `00-product` §3 `:75`, §10 `:238`, глоссарий, чтение тезиса `:50`; заголовок D36; D44 с отношением к D11 | Г-5, ш. 4 |
| §5 Ш-4 | реформа §Б3-5 — смысл `$owner` (ревизией владельца) | Г-5, ш. 6 (`03-pending`); код — Г-3, ш. 8 |
| §5 Ш-4 | греп-гейт «принадлежит (ровно одному) пользователю» в PRD — ноль; в `05-mission` — ровно слова §7 | Г-5, ш. 5, 7 |
| §8.1 Г-0 | ветка, worktree, базовая линия (счётчики, pgTAP, семь медиан, вердикт скрипта планов), автодеплой off | Г-0, ш. 2–5, 8–9, 12 |
| §8.1 Г-1 | отдельный коммит, поведение нулевое; сервер, shared, провод, веб, тесты, pgTAP; миграция `RENAME COLUMN` | Г-1, ш. 4, 7, 8, 14 |
| §8.1 Г-2 | бэкфилл проверяется на непустой базе | Г-2, ш. 2; Г-5, ш. 10 |
| §8.1 Г-3 | гейт — типы, время жизни GUC, журнал пишет актора; поведенческий тест красный с пометкой | Г-3, ш. 4, 9, 10, 13 |
| §8.1 Г-4 | гейт — тест «граф ≠ аккаунт» зелёный; порядок Г-3 → Г-4 при мерже после каждой задачи выполним | Г-4, ш. 6, 10; «Порядок и параллельность»; Г-3, ш. 14 |
| §8.1 Г-5 | окно простоя; `ORBIS_ROUTINE_SCHEDULER` выключается на окно; `MIN_COMPATIBLE_CLIENT_VERSION` поднимается; репетиция на восстановленном бэкапе; в `05-mission` — только принятые слова | Г-5, ш. 1, 5, 8 (финальное ревью), 10, 12–14, 15 (приёмка живьём); В-ПГ-1…3 |
| §8.1 | миграций ожидаемо три; порядок второй — таблицы → бэкфилл → FK; бюджет и «СТОП» назначает план; экранов нет, правки `apps/web` — только ключ | РП-3; Г-2, ш. 4; «Глобальные ограничения» (веб: ключ провода, скоуп черновиков по §3.4, `APP_VERSION` по §8.1 Г-5) |
| сверх спеки | `handoff-b2.md` — факты для правки плана Б-2 (§8.2); проба планов; `ops.ts dump`/`graphs`; пин версий клиента; индекс `graph_members_account` и `issued_by = auth.uid()` в INSERT-политике членства; `assertHoldsOwnerGrant`; ключ отчёта пересева `graph → world`; блок прав ранбука §4.3 | Г-5, ш. 17; Г-0, ш. 11; Г-5, ш. 1–2; Г-2, ш. 3–4; Г-3, ш. 7; Г-2, ш. 10; Г-5, ш. 6 |

## Эрраты спеки (спеку правит владелец; план уже написан по предложенным правкам)

| # | Адрес в спеке | Что не так (проверка — конспект разведки) | Предлагаемая правка |
|---|---|---|---|
| Э-1 | §3.4, строка «Применённые миграции» (греп-гейт) | буквально невыполним: 985 строк `owner_id`/`ownerId` в исторических планах, 57 — в спеках, 25 — в ревью, `spikes/**`, 5 `.sql` вне миграций; сама миграция `0019` обязана назвать старое имя; неотслеживаемый план Б-2 делает гейт на `git grep` зависимым от `git add` (`recon-3` §1.6) | «ноль вхождений в pathspec гейта `scripts/check-legacy-form.ts` (маркер `owner-key`); в `docs/prd` и `docs/implementation` — только исторические записи решений; `docs/superpowers/**`, `spikes/**`, миграции и снимки — вне гейта» |
| Э-2 | §5 Ш-3 («политики новых таблиц»), §3.6 (политика планировщика), §8.1 Г-4 | сид Г-2 идёт под `authenticated` и без INSERT-политик падает `42501`; резолвер планировщика Г-3 читает `graph_members` под `orbis_app` (`recon-2` §3.1) | политики, гранты и триггеры И-1 `graphs`/`graph_members` — в Ш-1б / Г-2; в Ш-3 / Г-4 остаются 35 политик, функции, дыры, перф |
| Э-3 | §3.1, CHECK | `(owner_kind = 'person' AND id = owner_ref) OR owner_kind = 'organization'` при `person` и `owner_ref IS NULL` даёт NULL, а CHECK на NULL проходит | `(owner_kind = 'person' AND owner_ref IS NOT NULL AND id = owner_ref) OR owner_kind = 'organization'` |
| Э-4 | §3.6 «Механика», «Межграфовая строгость» | живых политик 39, не 40 (`0002:8` снимает одну); реестровые — `0014:181-231`; `envelope_spent_cache` (`0018:33`) родителя НЕ сверяет — это вторая дыра, а не уже строгая таблица (`recon-1` §1, §3) | «35 из 39»; `envelope_spent_cache` — в перечень дыр рядом с `chat_threads.entity_id` |
| Э-5 | §0 п. 3, §3.5, §5 Ш-2 «Где» | `executor.ts:262-266` — не замок, а источник `$owner` (`compileCtxOf`); журнал — `:704-723`, `:999-1021`; сайтов рождения пары четыре (Bearer рождается в `context.ts` и в `mcp/transport.ts → server.ts`); по актору идут ещё замки, ключ кеша реестра, `$owner` (3 сайта), владелец сообщения журнала (`recon-2` §6–§7); «(**не** `trpc.ts`)» в «Где» Ш-2 верно про СБОРКУ контекста, но тип `Context` и `protectedProcedure` живут в `trpc.ts:14-40,117-120` и правятся | «три резолвера, четыре сайта рождения»; в «Где» Ш-2 добавить `registry/{ops,cache}.ts`, `budget/binding.ts`, `executor/relations.ts`, `query/context.ts`, `recurring/with-materialization.ts`, `executor/journal.ts`, `trpc.ts` (тип `Context`) |
| Э-6 | §5 Ш-1б | `test/perf.ts:183` не существует — это `apps/server/src/test/perf.ts:183`, и там `seedOwnerGraph`: правка не нужна; `truncateAll` — `helpers.ts:50-67`; `seedOwnerGraph` — `:149-156`, граф заводится перед `:154`; из 62 INSERT pgTAP ключ несут 56; 117 вызовов `freshUserId()` синхронны, 36 файлов держат модульного владельца и `truncateAll()` в `beforeAll` (`recon-4` §1) | поправить адреса; «заменяется хелпером» → «парой хелперов (синхронная выдача id + доведение до базы); `truncateAll` сносит графы и восстанавливает личности тестового процесса» |
| Э-7 | §3.4 (ширина, класс «аккаунт»), §10.2 Н-4 | ширина в коде — 2 167 строк в 204 файлах (спека считала только `apps/server/src`, причём часть чисел — с тестами, часть — без); `golden/surfaces.json` — 18 вхождений, не 0; `features/import/namespace.ts` — `ownerId` нет, комментарий `:2-3` называет ключ `(owner_id, namespace, external_id)` таблицы `entity_origins` — графовый; `useEnsuredThread.tsx:23` — докблок; retry-буфер уже на сессии (`recon-3` §1, §3, §5) | одна команда счёта (Г-0, ш. 10); из класса «аккаунт» убрать `namespace.ts`; добавить `surfaces.json` и `test/surfaces.ts:335` |
| Э-8 | §3.4, строка «Golden, фикстуры, снапшоты» | expect-обёртка по ссылке плана Б-2 `:3441` отвечает «create column» (DROP + ADD); сгенерированный SQL переименования непригоден и не видит индексов из `0001:112,118` (`recon-4` §6, `recon-1` §8) | «снимок — генератором со своей обёрткой „rename“, SQL — рукописный (образец `0015`/`0018`); сверка — повторный `generate` без изменений» |
| Э-9 | §5 Ш-4 | не названы живые доки с `owner_id`: `docs/implementation/00-architecture.md` (`:352` «Девятнадцать таблиц» + ER-диаграмма), ранбук §4.3 (`:1220-1285`, перепривязка владельца — после FK и CHECK меняется по существу), `01-architecture:734,:1394`, `02-core-os:143,756`, `03-budget:378,402,407` (`recon-5`) | добавить в перечень Ш-4 |
| Э-10 | §3.4 (entitlements), ревизия 2 п. 3 | «параметры entitlements сняты как бесплатно добавляемые» — но брендирование трогает сигнатуру и 5 сайтов, а субъект сегодня противоречив: три вызова шлют актора, два — ключ строк (`recon-3` §3.1) | «сигнатура резолвера получает `AccountId` в Г-3; субъект — аккаунт» |
| Э-11 | §3.6, пункт «Планировщик» | `scheduler_reads_owner_list` — `USING (true)`, колонок в тексте нет: `RENAME` её не касается вовсе | снять слова «(колонку переименует `RENAME`)» |
| Э-12 | §3.6, «Шаблон строк с `graph_id`» | одна политика `FOR ALL` оставляет `observer` право DELETE (на DELETE работает только USING); функции политик зовут `auth.uid()` при ВЫЗОВЕ, а у `orbis_app` нет `USAGE` на схему `auth` (`routines/queries.test.ts:66-69`) — под `PUBLIC` тик планировщика падал бы | «по одной политике на команду (SELECT — читает; INSERT, UPDATE, DELETE — пишет), как у реестров: пара „SELECT + ALL“ склеилась бы для SELECT через OR и сломала бы простой Index Cond по `graph_id`; политики выданы `TO authenticated`» |
| Э-13 | §5 Ш-1б, перечень «pgTAP: …» | идемпотентность сида, гонка И-1, `reset-world` и `truncateAll` — серверные тесты (pgTAP сид и TS-хелперы не зовёт, гонке нужны два соединения); в pgTAP остаются CHECK и политики | «pgTAP: CHECK §3.1, политики новых таблиц; серверные тесты: идемпотентность личного графа, И-1 с гонкой, `reset-world`, `truncateAll`» |

## Самопроверка плана

Проведена 20.09.2026 по скиллу `writing-plans` (покрытие спеки, заглушки, согласованность типов) координатором (Fable 5.1);
черновики шести задач писал координатор по конспектам четырёх читателей Opus 5 (`recon-1…4`) и своему (`recon-5`).

- **Покрытие спеки.** Каждое нормативное утверждение §3, §5, §8.1 имеет строку маппинга с задачей и шагом; пустых строк нет.
  §3.7 и §6 нормативных требований к срезу не несут («без швов сейчас», «не делается») — их долги названы в докблоках
  (И-1, `GrantRef`, `identitiesForScheduler`) и в `03-pending` (Г-5, ш. 6). Сверх спеки — то, что перечислено в «Нумерации» шапки и в последней строке
  маппинга: `handoff-b2.md`, проба планов, две операции только-чтения в `ops.ts`, пин версий клиента, индекс
  `graph_members_account`, `issued_by = auth.uid()` в INSERT-политике, `assertHoldsOwnerGrant`, ключ отчёта `graph → world`,
  блок прав ранбука.
- **Заглушки.** Скан по «TBD / TODO / реализовать позже / аналогично задаче / добавить обработку ошибок» — ноль в разделах
  задач. Места, где SQL дан шаблоном со списком таблиц (FK ×14 в `0020`; простые таблицы ×3, `entity_origins`/`entity_versions` и
  реестры ×5 в `0021`),
  сопровождаются прямым требованием выписать все статементы в файле миграции и пином состава (16 FK; снято 35, создано 68,
  всего 77) — счёт ловит пропуск.
- **Согласованность типов.** Сверены имена и формы между задачами: `graphId`/`graph_id` (Г-1 → все); `mintGraph`/`freshGraph`/
  `ensureGraphs`/`truncateAll` (Г-2 отдаёт `string`, Г-3 — `GraphId`, сигнатуры вызовов не меняются); `ensurePersonalGraph(tx,
  accountId)` (Г-2) ← `who.actor` (Г-3); `Identity { actor, graph }`, `identityOfPerson`/`identityOfGrant`/
  `identitiesForScheduler`, `personal`/`accountOf`/`addMember` (Г-3 → Г-4, Г-5 ш. 17); `issued_by` nullable (Г-2) → писатели и
  fail-closed ветка (Г-3) → NOT NULL и снятие ветки (Г-4); имена политик и функций `0020`/`0021` — в РП-10 и в pgTAP одни и те
  же; `plan(97)` → `plan(125)` (Г-2, +28) → `plan(148)` (Г-4, +23); журнал миграций 17 → 20 записей; политик 39 → 44 (Г-2) → 77 (Г-4).
- **Ревью двумя линзами (20.09, после сборки) и ре-ревью.** Opus 5 («исполнимость, адреса, команды»): Critical 1, Important 5,
  Minor 29; Fable 5.1 («спека, маппинг, приёмки, порядок»): Critical 0, Important 6, Minor 10; ре-ревью тем же ревьюером
  Fable: всё закрыто, регрессий от правок нет, новые — Important 1, Minor 4; ложных находок — 0. Закрыто координатором до
  сдачи плана: политики строк — по одной на команду вместо пары «SELECT + ALL» (OR на SELECT), 68/77 вместо 46/55, проба Г-0
  той же формы; сюжеты «граф ≠ аккаунт» снимаются с перехватом (исполнитель пробрасывает `42501`); пины прав pgTAP — второй
  барьер + `REVOKE` в `0020`; `issued_by NOT NULL` и три вставки гранта; `ops.ts check` неисполним до миграции;
  `assertHoldsOwnerGrant` на боевом пути выдачи; блок прав ранбука; литералы имени индекса в `perf/volume.test.ts`;
  нормализованный дифф Г-1; `{ db, client } = appDb()`; `psql` с отдельными `-c`. Отчёты — `review-plan-opus.md`,
  `review-plan-fable.md`; рулинги — Р-КГ-13…Р-КГ-15 в `facts.md`.
- **Известные ограничения плана.** Численные базовые линии (сьюты, семь медиан, вердикты `explain`, число вопросов
  drizzle-kit) не проставлены — их снимают Г-0 и Г-1 и пишут в леджер. Проба планов под новым предикатом — шаг Г-0 со
  стоп-условием: если вместо `InitPlan` выйдет построчный `SubPlan`, срез останавливается до Г-1 (на этом утверждении §3.6
  стоят Г-2…Г-4). Г-3 даёт точный код ядра (бренды, резолверы, `withIdentity`, транспорт, тесты) и таблицу ужесточаемых
  листьев, а сами ~120 сайтов чинит проход по ошибкам компилятора с правилом «тип выше по цепочке, приведение — никогда»:
  перечислить их поимённо значило бы переписать `recon-2` §1.3. Механика Render (подхватывает ли рестарт переменную,
  сохранённую «Save only») не проверена — у шага есть машинный гейт `/health` и запасной путь.
- **Объём:** 6 задач, 85 шагов (Г-0 — 15, Г-1 — 14, Г-2 — 14, Г-3 — 14, Г-4 — 10, Г-5 — 18); блоков кода — 111.
