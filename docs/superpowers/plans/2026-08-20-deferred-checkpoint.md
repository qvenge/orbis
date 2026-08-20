# «Пачка решений» (отложенный чекпойнт, D42) — план реализации

> **Для агентных исполнителей:** ОБЯЗАТЕЛЬНЫЙ САБ-СКИЛЛ — `superpowers:subagent-driven-development`
> (рекомендуется) либо `superpowers:executing-plans`. Шаги размечены чекбоксами (`- [ ]`).
> Исполнитель задачи видит ТОЛЬКО свою задачу — каждый бриф самодостаточен, имена и типы
> соседних задач продублированы в блоке «Интерфейсы». Модели: имплементеры и разведка — opus,
> гейт-ревью задачи и финальное ревью ветки — fable; sonnet/haiku не использовать.
> Вместе с брифом имплементеру передаются конспекты разведки
> `.superpowers/sdd/2026-08-20-deferred-checkpoint/` (recon-*.md — дизайн-разведка,
> plan-recon-*.md — разведка HEAD перед планом) и `facts.md` леджера.

**Цель:** рутина задаёт вопросы (`orbis_ask`) и откладывает небезопасные действия
pending-единицами в своём треде, **продолжая прогон**; владелец разбирает пачку постфактум —
поштучно, «Принять все» или ответом на вопрос — и кнопкой «Продолжить сейчас» даёт рутине
прочитать решения; следующий прогон видит ответы в истории прогонов и гасит нерешённое.

**Архитектура:** ни одной миграции БД — единицы едут полями в не-strict `metadata.pending`
(`kind`/`question`/`options`), флажок `undecided` — optional-полем в `.strict()`-аспекте
прогона (пересев реестра), судьбы вопроса — append-only сообщениями с детерминированными PK.
`orbis_ask` — новый рутинный глагол по образцу `orbis_propose`: модуль `routines/ask.ts` +
своя ветка в `dispatchTool` ДО `runMutation` (ветка глаголов `verbs.ts` pending запрещает —
расхождение Р-1). Отложка — новая ветка в `runMutation`: объектный пре-чек → снятие
предусловий переиспользованными `loadTargets`/`buildUpdate` из `propose.ts` → существующий
`createPending`. Гашение — обобщение `closeOpenOfRun` до списка единиц. Доставка ответов —
расширение `RoutineHistoryItem` (`units`) и строк истории. Web — две новые карточки треда и
блок «Пачка решений» в `RunFeed`.

**Стек:** Bun 1.2.7, Hono, tRPC 11, drizzle-orm/postgres (Supabase Postgres 17), zod + ajv
(реестр аспектов из БД), React 19 + TanStack Query, `bun:test` (server/shared), vitest 4
(web), biome.

**Спека:** `docs/superpowers/specs/2026-08-20-deferred-checkpoint-design.md`, ревизия 2,
принята владельцем 2026-08-20 (решение **D42**; умолчания §14.В1–В4 подтверждены). План
решения спеки НЕ пересматривает. Фон: ревью `reviews/2026-08-20-deferred-checkpoint-design-review.md`
и ответ `reviews/2026-08-20-deferred-checkpoint-review-response.md` (противоречить им нельзя);
спека V1 `2026-08-18-v1-routines-internal-runner-design.md` (инварианты и рулинги); план Ш1
`docs/superpowers/plans/2026-08-20-sh1-proposal-diff-edit.md` — контракты трёх общих работ (§«Общие
работы со Ш1» ниже). Предусловие: V1 в проде (main `01f8e81`). **Реализация Ш1 НЕ начата** —
считать её несделанной, пока обратное не видно в `main`.

---

## Что установила разведка HEAD (2026-08-20, main `878613c`)

Семь читателей (opus) прошли по коду ПОСЛЕ принятия спеки и ДО нарезки задач; полные
конспекты — `.superpowers/sdd/2026-08-20-deferred-checkpoint/plan-recon-*.md` (dispatch,
registry-verbs-runner, pending-ids-ai, lifecycle-sweep, context-prompts, web,
schemas-seed-ops). Код на `878613c` идентичен коду на `b1eb3b0` (все коммиты между — только
docs), то есть адреса спеки и ревью действительны; ниже — уточнения и расхождения уровня
плана. Исполнителям: **каждый факт опровергаем** — перед работой перечитать свежий
`git rev-parse HEAD`, main движется параллельными сессиями владельца.

### Таблица расхождений (спека/разведка ↔ код HEAD; что план с ними делает)

| # | Спека/разведка говорит | Код на HEAD говорит | Решение плана |
|---|---|---|---|
| Р-1 | §13: «`agent-loop/verbs.ts` — глагол `orbis_ask`» | Ветка глаголов `dispatch.ts:300-361` ЗАПРЕЩАЕТ pending: любой уровень кроме `execute` → `VALIDATION` «инвариант 4» (`:313-323`). Прецедент рутинного глагола, кладущего pending, — `orbis_propose`: модуль `routines/propose.ts` + своя ветка `dispatch.ts:363-369` ДО `runMutation`, `routineOnly: true` (`registry.ts:613`) | `orbis_ask` — модуль `routines/ask.ts` + ветка `dispatchTool` рядом с propose; `routineOnly: true` (НЕ `agentOnly`: тот открыл бы тул MCP-гранту). Поведение спеки (ОЧ.5, ОЧ.12) не меняется — только файл (Задача 6) |
| Р-2 | §7: «Смарт-лист „Ждут ответа“ — два query-блока (+ пересев)» | Пересева ТЕЛА смарт-листа не существует: сид — `insert … onConflictDoNothing` (`seed/onboarding.ts:118-121`, бэкфиллы `:194-195`, `:215-216`), UPDATE-ветки нет ни одной; правка `ROUTINES_LIST_BODY` доедет только до НОВЫХ аккаунтов. В `ops.ts` команды для смарт-листов нет (белый список — 9 команд, `ops.ts:495-517`) | Третий блок `undecided=true` в конец `ROUTINES_LIST_BODY` + адресный бэкфилл guard-ветки онбординга: UPDATE тела ТОЛЬКО если оно байт-в-байт равно старому сиду (правки владельца не затираются); иначе — шаг runbook «добавить блок руками» (Задача 11, Решение плана 6) |
| Р-3 | §7: бейдж листа «Ждут ответа» покажет и `undecided`-пачки | Сайдбарный бейдж закреплённого листа считает ТОЛЬКО ПЕРВЫЙ query-блок (`browser/query.ts:87-89`, `PinnedList.tsx:19-26`, норма PRD 02 §3.2 `:258`); OR между клаузами грамматика не выражает (`parse.ts:470`, `:621-640`) | Принято: блок `undecided=true` — третий, сайдбарная цифра считает терминальные вопросы (первый блок), точное число пачек — на экране листа и прогона. Записывается в правку PRD §3.3 (Задачи 11, 15) |
| Р-4 | ОЧ.6: «снятие» флажка `undecided` | Грамматика не умеет предикат «поля нет» (`->>` по отсутствующему ключу = NULL; PRD 02 `:361`); патч аспекта ключи сливает | Снятие = запись `undecided: false` (не удаление ключа). Схема — `z.boolean().optional()`; смарт-лист/бейдж фильтруют `undecided=true`, false им невидим (Задачи 1, 10) |
| Р-5 | §5.3: «список единиц ведётся в памяти; финальная сверка — проба» | Терминальных путей закрытия рутинного прогона ТРИ: `closeRoutineRun` из settle (`runner.ts:465`), `closeRoutineRun` из терминального propose (`propose.ts:293` — а ask доступен и propose-режиму) и **`checkpoint()` → `closeRun` напрямую** (`verbs.ts:886-901`, минуя `closeRoutineRun`; в раннере это ветка `closed-by-verb`, settle дозаписывает только usage). Память раннера покрывает один путь из трёх | Пробу открытых единиц делают САМИ точки закрытия: `closeRoutineRun` (оба вызывателя бесплатно) И checkpoint-путь для рутинного субъекта — исход и флажок одним патчем; in-memory список не заводится (проба и есть «финальная сверка» спеки) (Задача 7) |
| Р-6 | ОЧ.9: «`canonical` — общая утилита, фиксируется этим срезом» | `canonicalJson` УЖЕ существует и экспортирована из `@orbis/shared` (`aspect-registry.ts:193-201`, реэкспорт `index.ts:1`); готового хеш-хелпера нет (sha256hex в shared приватная и async, серверный прецедент — `node:crypto` в `oauth/tokens.ts:8,34`) | Общая работа №3 Ш1 в части экспорта УЖЕ выполнена кодом; срез добавляет серверный `unitHash` = sha256 lowercase hex от `canonicalJson` (Задача 2). Правило одно на оба среза — как в Развилке 3 плана Ш1 |
| Р-7 | ОЧ.10: кап 10 единиц при `ROUTINE_MAX_STEPS = 12` | Шаг = вызов провайдера; несколько tool_use одним ответом — один шаг (`runner.ts:284-415`), но КАЖДЫЙ нетерминальный вызов пишет `orbis_run_step` (`:400-413`) и стоит записи в граф | Кап достижим, если модель группирует вызовы — промпт v2 прямо велит «группируй вопросы в один ход» (Задача 14). Сводку шага `orbis_ask: ok` делаем содержательнее (`runner.ts:403`, Задача 6) |
| Р-8 | ОЧ.2/§4: пробы единиц `{pending:{run_id, kind}}` | GIN `jsonb_path_ops` покрывает только `@>` (`rollback.ts:190`); отдельные containment-пробы на каждый `kind` работают; `storedProposal` — `{pending:{run_id}}` LIMIT 1 без ORDER BY (`lifecycle.ts:1287-1290`) — при >1 pending на прогон недетерминирован | Пробы единиц — два containment'а (`kind:'question'`, `kind:'action'`) одним SQL через OR; `storedProposal` переводится на `{pending:{id}}` ДО появления единиц (общая работа Ш1, Задача 2) |
| Р-9 | §6: «Продолжить сейчас» → существующий `runNow` | `runNow` есть (`routers/routine.ts:109-163`), пауза ему НЕ гейт («разрешён намеренно», `:97-98`); web-кнопка уводит на новый прогон (`openEntity(runId)`, `RoutineStatusBlock.tsx:115`). Отмены прогона нет нигде — и не нужна | «Продолжить сейчас» на пачке зовёт тот же `runNow` и так же уводит на новый прогон; при паузе кнопка скрыта (требование спеки §6 — новое поведение поверх «разрешён намеренно», гейт остаётся серверу не нужен: кнопки просто нет) (Задача 13) |
| Р-10 | §7: «решённые карточки сворачиваются в строку-итог» | Существующий приём другой: тело остаётся, кнопки уходят, снизу строка статуса С СЕРВЕРА (`ProposalCard.tsx:250-264`); `ConfirmationCard` хранит решение в useState — признанная ошибка (`ProposalCard.tsx:14-17`) | Свёртка — новый UI-приём, строится по спеке; статус ВСЕГДА с сервера, форма запроса — как `ProposalCard` (свой query + refetch), не useState (Задача 12) |
| Р-11 | ОЧ.7: бейдж «ждут» аспектным фильтром «как сегодняшний waiting» | `overview.waiting`/`openProposal` сервер считает, но web их НЕ читает нигде — мёртвые поля контракта (`routers/routine.ts:52-61`; grep по web пуст) | `overview` получает `undecided: number` тем же фильтром; web ОЖИВЛЯЕТ поле бейджем в `RoutineStatusBlock`/`RunsList` (Задачи 11, 13) |
| Р-12 | ОЧ.4: пре-чек читает цели «прецедент `actRoutineInstructionTargets`» | Прецедент подтверждён (`dispatch.ts:741-744`, `:1051-1071`); но чтения, нужного отложке (aspects + updated_at цели), на пути `runMutation` нет — оно ГОТОВО в `propose.ts`: `loadTargets` `:481-532`, `buildUpdate` `:545-591`, покрыто тестами | Снятие предусловий — экспорт и переиспользование `loadTargets`/`buildUpdate` из `propose.ts`, второй копии не заводим (Задача 5) |
| Р-13 | Разведка дизайна: «единиц из runMutation много» | Рутина упирается в инвариант 5 ровно в 4 сценариях; три (автономия ×3, инструкция act-рутины) убиваются и объектным пре-чеком — реальный кандидат отложки на пути `runMutation` сегодня ОДИН: архивация (`entity_update` c `archived:true`, `confirmation.ts:57`) | Принято как факт: пачку наполняют `orbis_ask` + архивация; отложка написана обобщённо (любой будущий explicit-ряд), но тесты — на архивации (Задача 5) |
| Р-14 | Адреса спеки (`§13`, ОЧ.*) | Мелкие сдвиги: `HISTORY_TEXT_CAP` — `context.ts:72` (не :71); `patchAspect` — `lifecycle.ts:171-208`; `ai.approve` `:76-85` / `ai.reject` `:94-101`; `catalog.ts`/`parse.ts` — в `packages/shared/src/query/` (в `apps/server/src/query/` только `compile.ts`/`context.ts`); `grantsRoutineAutonomy` — `confirmation.ts:122-137`; `routineUntouchableError` — `invariants.ts:444-450`; `gateRoutinesMax` вызов `:762-763`; `toolResultPayload` — `runner.ts:434-440` | Только адреса, выводы спеки верны; брифы ниже цитируют актуальные диапазоны |
| Р-15 | — (найдено разведкой) | Кап при ретрае: `createPending` «завёл/нашёл» не различает (`pending.ts:195`); наивный порядок «кап → запись» отверг бы РЕТРАЙ 10-й единицы («пачка полна» на replay) | Порядок постановки: PK-проба существования (по детерминированному id) → replay; иначе кап → запись (Задачи 5, 6; приём различения — SELECT по PK, образец `propose.ts:222-228`) |
| Р-16 | — (найдено разведкой) | Две НЕзависимые единицы по одному полю снимут предусловия с одного состояния; вторая на approve честно проиграет `stale` с расхождениями (`collides` защищает только операции ВНУТРИ одного pending) | Принято как поведение по построению (V1.7): вторая единица проигрывает громко, не молча; закрепляется тестом (Задача 10) |
| Р-17 | — (найдено разведкой) | `answerRoutineCheckpoint`/`readProposal` стоят на `runById` с `NOT archived` (`queries.ts:346`) — решения по единицам АРХИВНОГО (откаченного) прогона упёрлись бы в NOT_FOUND | Процедуры единиц адресуются `pendingId` и прогон через `runById` НЕ читают (спека §6); бухгалтерский патч `undecided` по архивному прогону может отказать — глотается как признанная цена лестницы §5 (Задача 10) |
| Р-18 | — (найдено разведкой) | `aspect-read.ts` web не умеет boolean (`:18-45`); аспект прогона спрятан из общей карточки свойств (`AspectCards.tsx:23`) | Чтение `run.undecided === true` явной сверкой; рисует `RunFeed`, не AspectCards (Задача 13) |

### Подтверждено пробоем (ключевые адреса для брифов; полные — в plan-recon-*.md)

- **runMutation** (`tools/dispatch.ts:703-822`): envelope `:717-722` → classify `:727-732` →
  `levelGate` `:733-734` → ops `:740` → `actRoutineInstructionTargets` `:741-744` → level `:745` →
  **гейт инварианта 5 `:752-758`** (обоснование-докблок `:747-751` — подлежит замене) →
  `gateRoutinesMax` `:762-763` → ветка `createPending` `:765-802` (возврат `:801` — РОВНО
  `{status:'pending_confirmation', pendingId, card}`) → execute|preview `:806-822`.
- **createPending** (`policy/pending.ts:116-196`): принимает чужой `tx`; args
  `{threadId?, actor, tool, input, level, dedupeKey?, clock?, card?, summary?, content?}`;
  id = `pendingMessageId(owner, dedupeKey)` либо `newId()` (`:158-159`); пишет
  `metadata.pending {id, tool, input, actor_kind, source, [actor_grant_id], [run_id], created_at}`
  + `metadata.cards [card]`; «завёл/нашёл» не различает. `pendingRecord` БЕЗ `.strict()`
  (`:68-90`, `tool` `:70` и `input` `:71` сегодня ОБЯЗАТЕЛЬНЫ — ослаблять refine'ом).
- **approvePending**: batchId = pendingId (`:372`), атрибуция сквозь одобрение `:361-373`,
  эскалация только `source==='chat'` (`:401-407`). **rejectPending** (`:440-490`): свой
  `withIdentity`, замок `:447`, «уже исполнено» `:454-465`, повтор с исходной причиной
  `:466-474`, текст `:479` (`REJECT_CONTENT` `:251-255` — `Record<RejectReason,string>`,
  компилятор ловит забытый текст). `rejectPendingTx` на HEAD НЕ существует.
- **ids.ts**: конвенция `uuidv5(\`<префикс>:<owner.toLowerCase()>:<части>\`, ORBIS_NAMESPACE)`;
  `pendingMessageId` `:63-65` ЛОУЭРКЕЙСИТ ключ целиком; `rejectMessageId` `:53-55`;
  `batchAuditMessageId` `:23-25`; `answerMessageId` НЕ существует — заводить с нуля, префикс
  обязан быть новым (урок докблока `:184-188`).
- **closeOpenOfRun** (`lifecycle.ts:262-353`): берёт СНИМОК `args.run`, ветка предложения
  `:278-323` с безусловным `return out` на `:322` (снять!), ветка вопроса `:325-351`;
  системная заметка `{type:'routine_stale', routine_id, run_id}` `:343-350`. Вызыватели —
  ровно два: `supersedeOpen` (`lifecycle.ts:230-238` ← `runner.ts:192`, первый шаг прогона) и
  `rollbackRun` (`rollback.ts:418-428`).
- **closeRoutineRun** (`verbs.ts:960-998`): args `{runId, outcome:'finished'|'failed', report?,
  failNote?, usage?, proposal?, id?}` → `closeRun` с `runPatch()`; CAS `runStillMine`
  (`verbs.ts:783`); вызыватели: `runner.ts:465` (settle), `propose.ts:293`.
- **sweep** (`sweep.ts:104-134`): свой CAS-патч `{outcome:'failed', fail_note, finished_at}`
  под предусловием `outcome in ['running']` + `last_step_at`; точка встраивания пробы — между
  `:107` и `:109`, флажок — тем же патчем.
- **runner**: `TERMINAL_TOOLS` `:51` (НЕ трогать — `orbis_ask` нетерминален); поток вызова
  `:374-414`; `toolResultPayload` `:434-440` (ветка pending даёт `{status:'pending_confirmation',
  pendingId}` — camelCase на верхнем уровне; ok-ветка — `{status:'ok', result:{…}}`);
  `MAX_AGENT_STEPS` проверка `:355-370`, замена на `ROUTINE_MAX_STEPS` трогает `runner.ts:13,
  :20, :355` и тесты `runner.test.ts:286, :367`; чат (`send-message.ts:384`) не трогается.
- **registry**: `ROUTINE_BASE_TOOLS` `:73`; `routineToolAllowed` `:131-152`; `routineOnly`-гейт
  — три места уже работают от флага (`dispatch.ts:414-442`, `send-message.ts:315`,
  `mcp/server.ts:64-67`); `buildToolDefs` `:887-892` (одна строка на новый тул); описание
  `orbis_checkpoint` `:667-678` — «тикет уходит в waiting…» уже сегодня врёт рутине.
- **Тесты-счётчики тулов**: `registry.test.ts:130` (30→31), `:295` (31→32), заголовок `:121`;
  режимные пины `:393-403`, `:405-420`, `:469-475` (добавится `orbis_ask`); карта парности
  `ZOD_BY_TOOL` `:304-326` — вписать руками (тест итерируется по карте — тихая дыра);
  `dispatch.test.ts:1682-1699` — литерал `['orbis_propose']` для routineOnly; страховка
  `send-message.test.ts:1069` (`orbis_*` не в чате) — упадёт ГРОМКО, если забыть `routineOnly`.
  pgTAP `plan(46)` — 0 правок (только RLS таблиц).
- **История**: `routineHistory` (`lifecycle.ts:742-764`) → `RoutineHistoryItem`
  (`routines/context.ts:40-45`) → `historyLine` `:117-134` (строки единиц — новые `parts` в
  диапазоне `:129-132`) → `historyMessage` `:141-150`; `HISTORY_TEXT_CAP = 500` (`:72`),
  `quote`/`preview` `:103-110`; хвост `ROUTINE_HISTORY_TAIL = 7` (`constants.ts:32`).
  Прецедента «и ещё N» в истории НЕТ — образец текста `executor.ts:874-880`, склонение —
  `operationsNoun` (`pending.ts:53-60`).
- **Промпт**: `routine-v1.ts` подключён прямым импортом `routines/context.ts:28`; для v2 —
  новый файл + фикстура `routine-v2.fixture.txt` (**без завершающего перевода строки**, тест
  `toBe`) + тест по образцу `routine-v1.test.ts` + diff-гард «строки v1 не потеряны» по
  образцу `v3.test.ts:29-49` + переключение импорта (`context.ts:28` и `context.test.ts:9`).
- **Схема/реестр/грамматика**: `agentRunAspectSchema` `.strict()` (`aspects.ts:218-270`);
  optional-поле → пересев без миграции и бэкфилла (подтверждено генерацией: optional не
  попадает в `required`); каталог грамматики строится из `properties` автоматически
  (`shared/query/catalog.ts:82-102`, boolean `:171`) — `undecided=true` парсится (проверено
  запуском); в `catalog.ts` правок НЕ нужно. Читатели реестра из БД: валидация записи,
  каталог грамматики, стартовая сверка — все трое fail-closed на непересеянном реестре.
- **Сид/деплой**: `db:prepare` сеет ТОЛЬКО реестр аспектов; смарт-листы сеет `seedOnboarding`
  (`onboarding.ts:63-152`, insert-once + адресные бэкфиллы); `ops.ts` — 9 команд, из них
  `seed-aspects` есть; чек-лист V1-деплоя — `docs/implementation/02-ops-runbook.md:374-443`
  (ping → check → migrate → seed-aspects → check → Restart → /health). Без пересева блок
  `undecided=true` даёт КРАСНУЮ плашку «неизвестное поле» (громкий отказ, проверено).
- **Web**: экран прогона = `DetailScreen` + `RunFeed` (`DetailScreen.tsx:296-299`); структура
  `RunFeed` — «вопрос `:327-354` → предложение `:358` → отчёт → откат»; место блока пачки —
  между `:354` и `:358`; карточки — четыре шага (server union `registry.ts:164-240` → web
  `cards/types.ts:81-90` → `renderCards.tsx:100-140` → компонент), поля дословно совпадают;
  образец формы — `ProposalCard` (`{runId}`-вход, статус всегда с сервера, `busy` `:162`,
  `refetch` `:144`); тред НЕ инвалидируется `invalidateGraph` (`useChatThread.ts:10-12`,
  `invalidate.ts:57-66`); поллинг гаснет на терминальном исходе (`run-poll.ts:23-27`,
  пины исходов `run-poll.test.tsx:10-20`); харнесс `renderWithProviders`
  (`test/harness.tsx:107-135`), фикстуры рутинного прогона `detail.test.tsx:3681-3759`.
- **Конвенции**: `bun run test` из корня (голый `bun test` ЗАВИСАЕТ); один серверный файл —
  `cd apps/server && bun test src/<путь>` (нужны `DATABASE_URL`, `DATABASE_URL_ADMIN`,
  `bunx supabase start`); web — `cd apps/web && bunx vitest run <путь>`; `bun run lint` и
  `bun run typecheck` отдельно; гонный прецедент — `policy/pending.test.ts:330-368`
  (25 итераций `Promise.all`); сьюты делят БД (`truncateAll`) — не гонять параллельно.

## Общие работы со Ш1 (правило: «делается один раз, кто первым дойдёт»)

Реализация Ш1 не начата (подтверждено grep'ом на HEAD: `rejectPendingTx` — 0 совпадений,
`storedProposal` — по-прежнему `{pending:{run_id}}`). Для каждой работы действует условие:
**если к старту задачи N работа уже в `main` — использовать как есть; иначе задача N делает
её сама СТРОГО по контракту из плана Ш1 (продублирован ниже), без расхождений в сигнатурах.**

1. **Каноническая сериализация** (нужна Задаче 2). Контракт Ш1 (Развилка 3 и строка Р-12
   таблицы расхождений плана Ш1):
   канон — `canonicalJson` из `@orbis/shared` (рекурсивная сортировка ключей, порядок
   массивов сохраняется); хеши от канона — **sha256 lowercase hex** (иначе лоуэркейс
   `pendingMessageId` схлопнет разные ключи). Статус на HEAD: `canonicalJson` УЖЕ
   экспортирована (`aspect-registry.ts:193-201`) — часть «экспорт» выполнена; Задача 2
   добавляет только серверный `unitHash` (см. её Интерфейсы).
2. **Tx-вариант `rejectPending`** (нужен Задаче 8 условно). Контракт Ш1 (Развилка 2):
   `rejectPendingTx(tx, args: {ownerId, pendingId, reason?}): Promise<RejectPendingResult>`,
   бросает `ExecError`; `RejectPendingResult = {pendingId, alreadyRejected, reason, threadId}`;
   `rejectPending(db, args)` — обёртка с прежним поведением; экспорт `acquirePendingLock`
   с докблоком «замок до первого чтения состояния этого pendingId». **Сам этот срез
   tx-варианта не требует**: гашение зовёт `rejectPending`-обёртку последовательно, по
   единице за раз (атомарность между единицами не обещается — ОЧ.11). Задача 8 обязана лишь
   НЕ конфликтовать: `reason` остаётся enum'ом, новый optional-параметр `text?` добавляется
   в объект args (не ломает ни обёртку, ни будущий `rejectPendingTx`).
3. **Перевод `storedProposal` на `{pending:{id}}`** (обязательное предусловие ОБОИХ срезов —
   §8.5 спеки; делает Задача 2). Контракт Ш1 (Задача 4): проба
   `{pending:{id: run.proposal.pending_id}}` формой `findPendingMessage` (`pending.ts:216-235`);
   вызыватель один — `proposalView` (`lifecycle.ts:948`). Без перевода единицы на прогоне
   ломают `routine.proposal` (LIMIT 1 без ORDER BY вернёт случайную запись — Р-8).

## Решения плана (владелец может отменить; план написан под них)

1. **`orbis_ask` — не глагол verbs.ts, а модуль `routines/ask.ts`** + ветка `dispatchTool`
   (Р-1). `routineOnly: true`, вход в `ROUTINE_BASE_TOOLS`. Контракт ответа —
   `AskResult { run_id, pending_id, replayed }` (snake_case, по конвенции `ProposeResult`).
2. **Дедуп-ключи единиц**: `ask:{runId}:{unitHash({question, options: options ?? []})}` и
   `defer:{runId}:{unitHash({tool, input})}`, где `unitHash` = sha256 lowercase hex от
   `canonicalJson` (`node:crypto`, синхронный; прецедент `oauth/tokens.ts:34`).
3. **PK судеб вопроса** (`ids.ts`, новые префиксы): `answerMessageId(owner, pendingId)` =
   uuidv5 `answer:<owner>:<pendingId>`; `questionStaleMessageId(owner, pendingId)` = uuidv5
   `question-stale:<owner>:<pendingId>`. Форма сообщений — детерминированный PK и плоская
   metadata по образцу reject-сообщения (`pending.ts:475-481`), но роли РАЗНЫЕ по автору:
   **ответ — role `user` + `source:'ui'` в metadata** (автор — владелец; §6 и §9.5 спеки:
   «ответы — ui-сообщения»), гашение — role `system` (автор — система).
4. **Снятие `undecided` = запись `false`** (Р-4); схема `z.boolean().optional()`.
5. **Проба открытых единиц — одна функция** `listRunUnits` в `policy/pending.ts`,
   используется везде (close-патч, sweep, гашение, история, кап, decideAll, runUnits).
6. **Смарт-лист** (Р-2, Р-3): третий блок
   `{{query: aspect=orbis/agent-run, undecided=true, sortBy=started_at:asc, display=list, title=Пачка решений}}`
   В КОНЕЦ `ROUTINES_LIST_BODY` (вставка не в конец сдвинула бы индексы `idsOfBlock` в
   тестах); доставка существующему владельцу — `backfillRoutinesListBody`: UPDATE тела только
   при байт-в-байт совпадении со СТАРЫМ сидом; сайдбарный бейдж продолжает считать первый
   блок (терминальные вопросы) — принятая цена, фиксируется в PRD.
7. **`decideAll` обходит единицы в детерминированном порядке** (`created_at, id`) — защита от
   взаимной блокировки advisory-замков при двух конкурентных «Принять все».
8. **Кап при ретрае** (Р-15): постановка = PK-проба по детерминированному id → если запись
   есть, это replay (капом не отвергается) → иначе счёт открытых единиц → кап → запись.
9. **«Продолжить сейчас»** (Р-9): зовёт `routine.runNow` и уводит на новый прогон (как
   существующая кнопка); при паузе рутины кнопка скрыта; при неотвеченном терминальном
   чекпойнте того же прогона — предупреждение-подтверждение СВОЕЙ разметкой (`Dialog`
   `RunFeed.tsx:454-485` — образец; `window.confirm` не использовать).
10. **Карточки пачки** — форма `ProposalCard`: вход-указатель, состояние всегда с сервера
    через собственный запрос `routine.runUnits({runId})`, решённая карточка сворачивается в
    строку-итог (Р-10); тексты полей — русскими подписями (`aspectLabel`/`fieldLabel`).
11. **`orbis_run_step` сводка** для `orbis_ask` — «спросил: „<обрезанный вопрос>“», для
    отложки — «отложено: <summary карточки>» (вместо бессодержательного `orbis_ask: ok`).
12. **Наблюдаемость промпта не строится**: `ROUTINE_PROMPT_VERSION` в прогон не пишется
    (сегодня тоже не пишется; отдельная работа вне среза).

## Вопросы владельцу

**Вопросов нет.** Все развилки, не закрытые спекой, закрываются «Решениями плана» выше —
каждое исполнимо без ответа и отменяемо точечной правкой (самое чувствительное — Решение 6:
условный UPDATE тела смарт-листа «Рутины»; при несогласии заменяется шагом runbook «добавить
блок руками», правится только Задача 11).

## Глобальные ограничения

- **Ветка `deferred-checkpoint` от свежего `origin/main`, работа только в worktree**
  (`.claude/worktrees/deferred-checkpoint`); основное дерево не трогать (владелец пушит
  параллельно); свой `bun install`; абсолютные пути — только внутрь worktree; параллельные
  имплементеры в одном дереве запрещены.
- **Ни одной миграции БД.** Обнаружил, что без миграции нельзя, — это БЛОКЕР ПЛАНА: стоп,
  доклад координатору, никаких тихих миграций. (Если владелец решит делать: номер **0014**,
  каталог `apps/server/src/db/migrations`, регистрация генерацией — файл `0012` в журнале
  отсутствует НАМЕРЕННО, не трогать.) pgTAP `plan(46)` не двигается.
- **Пересев реестра аспектов** — СРАЗУ после правки `schemas/aspects.ts` в Задаче 1
  (`bun run db:prepare` либо `DATABASE_URL_ADMIN=… bun scripts/seed-aspects.ts`); до пересева
  красные `aspect-drift.test.ts` и `seed-aspects.test.ts` — это НЕ твоя поломка. На проде —
  пересев ДО деплоя кода (Задача 16); зелёный CI пересев на проде НЕ доказывает (`ci.yml:36`).
- **Промпт рутины** — ТОЛЬКО новым файлом `routine-v2.ts` + фикстура `routine-v2.fixture.txt`;
  `routine-v1.ts` не правится ни байтом (правило `routine-v1.ts:2-4`).
- **Мутации графа — только через executor** (`createPending`/`approvePending`/`patchAspect`/
  `execute`); прямые записи — только сообщения тредов (`appendMessageIdempotent`).
- **Тул-контракт**: `orbis_ask` — единственный новый тул; счётчики реестра двигаются на +1
  (30→31, 31→32) с правкой заголовков тестов; `ZOD_BY_TOOL` пополняется руками.
- **TDD.** Полный прогон — `bun run test` из корня (голый `bun test` ЗАВИСАЕТ); `bun run lint`
  и `bun run typecheck` — отдельными вызовами. Серверные сьюты делят БД — не гонять два
  прогона одновременно.
- **Язык кода, комментариев, ошибок, коммитов — русский; комментарий объясняет «почему».**
- **Коммит после каждой задачи** — `git commit -- <пути>`; в сообщении
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`. Мерж в `main` (ff-only) и пуш
  после закрытия задачи (гейт-ревью fable + зелёный CI) — постоянное распоряжение владельца.
  Протокол: `git fetch` → rebase на чистом дереве до диспатча следующего имплементера →
  push ветки → CI → ff-push в `main`.
- **Имплементеру передаются** `facts.md` и нужные `plan-recon-*.md`/`recon-*.md` из леджера,
  не только бриф.

## Карта файлов

| Область | Создать | Изменить |
|---|---|---|
| shared | — | `packages/shared/src/schemas/aspects.ts` (+`undecided` в `agentRunAspectSchema`), `schemas/aspects.test.ts`, `src/contracts/agent-loop.ts` (`askInput`, `AskResult`, `RunSummary.undecided?`), `src/ids.ts` (`answerMessageId`, `questionStaleMessageId`) |
| policy | — | `apps/server/src/policy/pending.ts` (`kind`/`question`/`options`, условная обязательность `tool`/`input`, `unitHash`, дедуп-ключи, гейты `kind`, `text?` у reject, `listRunUnits`, `answerPendingQuestion`, `stalePendingQuestion`), `pending.test.ts` |
| dispatch | — | `apps/server/src/tools/dispatch.ts` (объектный пре-чек, отложка вместо `FORBIDDEN_LEVEL`, кап, ветка `orbis_ask`), `dispatch.test.ts` |
| routines | `apps/server/src/routines/ask.ts`, `ask.test.ts` | `routines/propose.ts` (экспорт `loadTargets`/`buildUpdate`), `routines/lifecycle.ts` (`storedProposal`→id, `closeOpenOfRun` списком, `routineHistory` единицами, `answerQuestion`/`decideDeferred`/`decideAll`-ядра), `lifecycle.test.ts`, `routines/context.ts` (строки единиц, потолки), `context.test.ts`, `routines/constants.ts` (`ROUTINE_MAX_STEPS = 12`, `MAX_RUN_UNITS = 10`), `routines/runner.ts` (потолок шагов, сводка шага) |
| agent-loop | — | `apps/server/src/agent-loop/verbs.ts` (`closeRoutineRun` + `undecided`), `apps/server/src/agent-loop/sweep.ts` (проба + флажок), `sweep.test.ts`, `agent-loop/queries.ts` (`runSummary` +`undecided`) |
| tools/registry | — | `apps/server/src/tools/registry.ts` (`ASK_TOOL`, `askJsonSchema`, `ROUTINE_BASE_TOOLS`, описание `orbis_checkpoint`, карточки `question_card`/`deferred_action_card` в union `Card`), `registry.test.ts` |
| tRPC | — | `apps/server/src/routers/routine.ts` (`decideDeferred`, `answerQuestion`, `decideAll`, `runUnits`, `overview.undecided`), `routine.test.ts`, `apps/server/src/routers/ai.ts` (гейт `kind` — через policy, тест), `ai.test.ts` |
| промпт | `apps/server/src/llm/prompts/routine-v2.ts`, `routine-v2.fixture.txt`, `routine-v2.test.ts` | `apps/server/src/routines/context.ts:28` (импорт v2), `routines/context.test.ts:9` |
| сиды | — | `apps/server/src/seed/smart-lists.ts` (третий блок), `apps/server/src/seed/onboarding.ts` (условный UPDATE-бэкфилл), `onboarding.test.ts` |
| web | `apps/web/src/features/chat/cards/QuestionCard.tsx`, `DeferredActionCard.tsx`, `apps/web/src/features/entity-detail/RunDecisionsBlock.tsx` | `features/chat/cards/types.ts`, `renderCards.tsx`, `cards.test.tsx`, `features/entity-detail/RunFeed.tsx`, `RunsList.tsx`, `RoutineStatusBlock.tsx`, `detail.test.tsx` |
| docs | `—` | `docs/prd/01-architecture.md` §7.10 (инвариант 5 + оговорка `orbis_ask`), `docs/prd/02-core-os.md` (экран пачки; §3.3 тело «Рутин» — в Задаче 11), `docs/prd/04-decision-log.md` (D42), `docs/implementation/02-ops-runbook.md` (чек-лист деплоя) |

## Порядок и параллельность

```
Веха A (контракты и носитель):   0 → 1 → 2 → 3
Веха B (диспатч и глагол):       4 → 5 → 6          (5 требует 2 и 4; 6 требует 1, 2, 5 — MAX_RUN_UNITS)
Веха C (раннер/гашение/история): 7 → 8 → 9          (7 требует 1, 2; 8 требует 2, 3; 9 требует 8)
Веха D (роутеры):                10 → 11             (10 требует 2, 3; 11 требует 1, 10)
Веха E (web):                    12 → 13             (12 требует 5, 6, 10; 13 требует 10, 11, 12)
Веха F (промпт, документы, деплой): 14 → 15 → 16    (14 требует 6; старт 15 — после 1–14)
```
**Все задачи — строго последовательно, параллельных нет** (Задача 2 потребляет PK-хелперы
`ids.ts` Задачи 1; дальше общие файлы: `dispatch.ts`, `lifecycle.ts`, `pending.ts`,
`routine.ts`, `RunFeed.tsx`). Один worktree, один имплементер за раз.

---

### Задача 0: Подготовка дерева и базовая линия

**Файлы:** — (git/worktree, леджер `.superpowers/sdd/2026-08-20-deferred-checkpoint/`)

- [ ] **Шаг 1:** из основного дерева: `git fetch origin && git worktree add -b deferred-checkpoint
  .claude/worktrees/deferred-checkpoint origin/main`. Зафиксировать хеш `origin/main`
  (ожидается `878613c` или новее — main движется параллельными сессиями владельца).
- [ ] **Шаг 2:** в новом дереве `bun install`; `bunx supabase status` (поднят); в
  `apps/server/.env` есть `DATABASE_URL` и `DATABASE_URL_ADMIN`.
- [ ] **Шаг 3:** `bun run db:prepare`, затем `bun run test`, `bun run lint`,
  `bun run typecheck` — код возврата 0 на незанятой машине. Базовые счётчики сьютов — в
  `.superpowers/sdd/2026-08-20-deferred-checkpoint/progress.md` (создать; там же завести
  `facts.md` для рулингов по ходу).
- [ ] **Шаг 4:** проверить статус общих работ Ш1 на свежем main: `grep -rn "rejectPendingTx"
  apps/server/src` и строку пробы `storedProposal` (`apps/server/src/routines/lifecycle.ts`,
  проба `{pending:{run_id}}` ≈ `:1287`). Результат («Ш1 в main: да/нет, что именно») — в
  `facts.md`: от него зависят условные части Задач 2 и 8.
- [ ] **Шаг 5:** коммитов нет.

---

### Задача 1: Схемы и контракты — `undecided`, `askInput`/`AskResult`, PK судеб

Флажок в `.strict()`-аспекте прогона (+ немедленный пересев), контракт нового тула и два
детерминированных PK. Всё — packages/shared + проекция `runSummary`; серверной логики нет.

**Файлы:**
- Изменить: `packages/shared/src/schemas/aspects.ts` (`agentRunAspectSchema`, диапазон
  `:218-270` — `undecided` рядом с `proposal`), `packages/shared/src/contracts/agent-loop.ts`
  (`askInput` + `AskInput` рядом с `checkpointInput` `:62-70`; `AskResult` рядом с
  `CheckpointResult` `:170-175`; `RunSummary` `:95-115` + `undecided?`),
  `packages/shared/src/ids.ts` (два новых хелпера по конвенции `:53-55`),
  `apps/server/src/agent-loop/queries.ts` (`runSummary` `:374-404` — проекция `undecided`)
- Тесты: `packages/shared/src/schemas/aspects.test.ts`, `packages/shared/src/ids.test.ts`
  (если файла нет — завести рядом с `ids.ts`), `apps/server/src/agent-loop/queries.test.ts`

**Интерфейсы (produces):**
```ts
// schemas/aspects.ts — внутрь agentRunAspectSchema (после proposal, до .strict() на :270):
undecided: z.boolean().optional(),
// «у прогона есть нерешённые единицы пачки (ОЧ.6 D42); снятие — ЗАПИСЬ false, не удаление
//  ключа: предиката "поля нет" у грамматики §6 не существует» — комментарий обязателен

// contracts/agent-loop.ts:
export const askInput = z.object({
  run_id: z.string().uuid(),
  question: z.string().min(1).max(4000),
  options: z.array(z.string().min(1).max(200)).max(4).optional(),
  // поля id НЕТ намеренно: «ключа идемпотентности во входе нет — выводится из содержимого»
  // (ОЧ.9); дедуп — askDedupeKey (Задача 2)
}).strict();
export type AskInput = z.infer<typeof askInput>;
export interface AskResult { run_id: string; pending_id: string; replayed: boolean }
// RunSummary: += undecided?: true   («этого нет» = отсутствие ключа — конвенция :166-168;
//   в сводку едет ТОЛЬКО true: false для читателей истории неотличим от отсутствия)

// ids.ts (конвенция uuidv5 + ORBIS_NAMESPACE, лоуэркейс uuid-частей, НОВЫЕ префиксы):
export function answerMessageId(ownerId: string, pendingId: string): string;        // `answer:<owner>:<pendingId>`
export function questionStaleMessageId(ownerId: string, pendingId: string): string; // `question-stale:<owner>:<pendingId>`

// agent-loop/queries.ts — runSummary: ...(r.undecided === true && { undecided: true as const })
```
- [ ] **Шаг 1: правка схемы + НЕМЕДЛЕННЫЙ пересев** (`bun run db:prepare`) — до пересева
  красные `aspect-drift.test.ts` и `seed-aspects.test.ts`, это ожидаемо и НЕ твоя поломка.
- [ ] **Шаг 2: падающие тесты**
```ts
// aspects.test.ts: agent-run с undecided:true и undecided:false — валиден; без поля — валиден
//   (старые прогоны живут); undecided:'yes' — отвергнут.
// ids.test.ts: answerMessageId детерминирован, регистронезависим по обоим аргументам,
//   НЕ равен questionStaleMessageId/rejectMessageId/pendingMessageId от тех же аргументов
//   (префиксы не пересекаются — урок ids.ts:184-188).
// queries.test.ts: runSummary отдаёт undecided:true когда поле true; при false и при
//   отсутствии — ключа в сводке НЕТ (обе ветки).
```
- [ ] **Шаг 3:** FAIL → реализация. — [ ] **Шаг 4:** PASS, `bun run test`, `bun run typecheck`;
  коммит `feat(shared): undecided на аспекте прогона, контракт orbis_ask, PK судеб вопроса (D42 ОЧ.5, ОЧ.6)`.

---

### Задача 2: Запись единицы в pending — `kind`, гейты, `unitHash`, `listRunUnits`, `storedProposal`→id

Носитель единиц (ОЧ.2, Б5 ревью): поле `kind` с условной обязательностью `tool`/`input`,
гейты в approve/reject, свои тексты судеб, хеш-ключи дедупа, единая проба открытых единиц —
и обязательное предусловие обоих срезов: перевод `storedProposal` на `{pending:{id}}`.

**Файлы:**
- Изменить: `apps/server/src/policy/pending.ts` (`pendingRecord` `:68-90`; `approvePending`
  `:299-407`; `rejectPending` `:440-490`; новые экспорты), `apps/server/src/routines/lifecycle.ts`
  (`storedProposal` `:1286-1304`)
- Тесты: `apps/server/src/policy/pending.test.ts`, `apps/server/src/routines/lifecycle.test.ts`

**Интерфейсы (produces):**
```ts
// policy/pending.ts — pendingRecord (БЕЗ .strict(), :68-90) расширяется:
kind: z.enum(['question', 'action']).optional(),   // у ЕДИНИЦ обязателен и явен (Б5);
                                                   // отсутствие = 'action' ТОЛЬКО при одиночном
                                                   // чтении по id (обратная совместимость)
question: z.string().min(1).max(4000).optional(),
options: z.array(z.string().min(1).max(200)).max(4).optional(),
// tool/input (:70-71) → .optional() + .superRefine: обязательны, когда kind !== 'question'
//   (то есть при kind:'action' И при отсутствии kind); при kind:'question' — ЗАПРЕЩЕНЫ.
//   Fail-closed: невалидная комбинация — прежний VALIDATION «pending-запись повреждена».

export function unitHash(value: unknown): string;
// sha256 LOWERCASE HEX от canonicalJson(value) (canonicalJson — из '@orbis/shared', уже
// экспортирована); node:crypto createHash — прецедент oauth/tokens.ts:34. Формат /^[0-9a-f]{64}$/.
// Общее правило со Ш1 (Развилка 3 плана Ш1): лоуэркейс-стойкость обязательна —
// pendingMessageId лоуэркейсит ключ целиком (ids.ts:63-65).
export function askDedupeKey(runId: string, question: string, options?: string[]): string;
//   `ask:${runId}:${unitHash({ question, options: options ?? [] })}`
export function deferDedupeKey(runId: string, tool: string, input: unknown): string;
//   `defer:${runId}:${unitHash({ tool, input })}`

export interface RunUnit {
  pendingId: string;
  kind: 'question' | 'action';
  createdAt: string;
  question?: string; options?: string[];       // kind:'question'
  tool?: string; input?: Record<string, unknown>; // kind:'action'
  card?: Card;                                  // карточка из metadata.cards[0]
  fate: 'open' | 'approved' | 'rejected' | 'answered' | 'stale';
  reason?: RejectReason;                        // fate:'rejected'
  answer?: string;                              // fate:'answered'
}
export async function listRunUnits(tx: Tx, ownerId: string, runId: string): Promise<RunUnit[]>;
// ЕДИНИЦЫ прогона (только записи с явным kind — предложение без kind НЕ попадает, Б5):
// один SELECT по containment'ам {pending:{run_id, kind:'question'}} OR {pending:{run_id,
// kind:'action'}} (оба по GIN jsonb_path_ops), ORDER BY created_at, id; судьбы — вторым
// SELECT по IN-списку детерминированных PK (batchAuditMessageId → approved, rejectMessageId →
// rejected+reason, answerMessageId → answered+answer, questionStaleMessageId → stale).
// Ответ важнее гашения: answered и stale одновременно → answered (правило ОЧ.8).
// ВАЖНО читателям RunUnit: fate:'stale' достижим ТОЛЬКО у вопросов; погашенное/протухшее
// ДЕЙСТВИЕ — это fate:'rejected' с reason: 'owner' → «отклонено», 'stale' → «устарело»,
// 'superseded' → «снято» (подписи выводятся из пары fate+reason — Задачи 9, 12).
// Форма сообщений судеб вопроса (пишет Задача 3; фикстуры тестов здесь строят ЭТУ форму):
//   ответ:   { id: answerMessageId(owner, pendingId), role: 'user',
//              content: `Ответ: «<answer>»`,
//              metadata: { type:'question_answered', answers: pendingId, answer,
//                          option?, source:'ui' } }        // автор — владелец (§9.5)
//   гашение: { id: questionStaleMessageId(owner, pendingId), role: 'system',
//              content: <текст гашения>,
//              metadata: { type:'question_stale', stales: pendingId } }

// createPending: args расширяются — kind?: 'question'|'action'; question?: string;
//   options?: string[]; tool/input становятся условными: при kind:'question' НЕ передаются
//   (в metadata.pending не пишутся), при kind:'action' и без kind — обязательны как сегодня.
//   При kind:'question' summary = args.summary ?? усечённый question — pendingSummary(tool,
//   input) НЕ зовётся (тула нет, упал бы на undefined); level передаётся ТОТ ЖЕ
//   'explicit-confirmation' (гейт уровня pending.ts:153-157 не ослабляется). Оба сегодняшних
//   вызывателя (dispatch.ts:771-799, propose.ts:245-272) не правятся.
// rejectPending: args += text?: string  → content: args.text ?? REJECT_CONTENT[reason].
//   УСЛОВИЕ Ш1 (общая работа 2): если на HEAD уже есть rejectPendingTx (распил Ш1 — тело с
//   записью reject-сообщения живёт в tx-форме), text? добавляется в args ОБЕИХ форм: content
//   считается в rejectPendingTx, обёртка rejectPending(db) прокидывает; сигнатуры Ш1
//   (RejectPendingResult, порядок аргументов) не менять.
//   reason ОСТАЁТСЯ enum'ом; metadata.reason не меняется; повтор возвращает исходную причину.
//   Сигнатура совместима с будущим rejectPendingTx Ш1 (поле добавляется в объект args).
// Гейты kind (внутри policy, НЕ в роутере — approvePending зовут и lifecycle.ts, и ai.ts):
//   approvePending / rejectPending: found.pending.kind === 'question' →
//     ExecError('VALIDATION', 'это вопрос — на него отвечают, а не принимают/отклоняют').
```
`storedProposal` (`lifecycle.ts:1286-1304`): проба `{pending:{run_id: runId}}` →
`{pending:{id: run.proposal.pending_id}}` (общая работа Ш1 — §«Общие работы», п. 3).
Сигнатура меняется: вызыватель `proposalView` (`:948`) передаёт `run.proposal.pending_id`
(он в снимке уже есть); если `pending_id` отсутствует — `null` без запроса. **Если к старту
задачи Ш1 уже перевёл `storedProposal` в main — этот кусок пропустить, использовать как есть.**
- [ ] **Шаг 1: падающие тесты** — `pending.test.ts`:
```ts
test('запись kind:question с question/options и БЕЗ tool/input — валидна; kind:question с tool — VALIDATION; kind:action без tool — VALIDATION; запись без kind с tool/input — валидна (сегодняшние чатовые)', …);
test('unitHash: перестановка ключей объекта не меняет хеш; другой input — другой хеш; формат /^[0-9a-f]{64}$/; deferDedupeKey от переставленных ключей JSON одинаков (приёмка 15)', …);
test('approvePending на kind:question → VALIDATION структурной ошибкой, граф не тронут; rejectPending на kind:question → VALIDATION', …);
test('rejectPending с text: в ленте текст единицы, metadata.reason прежний; повтор возвращает исходную причину; без text — прежние тексты байт-в-байт', …);
test('listRunUnits: прогон с вопросом, отложкой и ЧУЖИМ предложением (pending без kind, дедуп proposal:<runId>) → ровно две единицы, предложение не попало (Б5, приёмка 19-предусловие); порядок created_at,id', …);
test('listRunUnits судьбы: approved по audit-PK, rejected с причиной, answered по answer-PK, stale по question-stale-PK; answered+stale одновременно → answered (ОЧ.8)', …);
```
- [ ] **Шаг 2:** — `lifecycle.test.ts`:
```ts
test('storedProposal читает по pending_id: подложить ВТОРОЕ pending-сообщение (единицу) с тем же run_id — proposalView показывает операции того, на кого указывает прогон (Р-8)', …);
```
- [ ] **Шаг 3:** FAIL → реализация. — [ ] **Шаг 4:** PASS, `bun run test`, `bun run typecheck`;
  коммит `feat(policy): pending-единицы — kind, гейты, unitHash, listRunUnits; storedProposal по pending_id (D42 ОЧ.2, Б5; общая работа Ш1)`.

---

### Задача 3: Судьбы вопроса — ответ, гашение, единственность, идемпотентность

Реализует ОЧ.8/ОЧ.9 для вопросов: `answerPendingQuestion` и `stalePendingQuestion` под
`lock(pendingId)`, перечитка ОБЕИХ судеб, первая записанная финальна, ответ важнее гашения.

**Файлы:**
- Изменить: `apps/server/src/policy/pending.ts` (две новые процедуры рядом с `rejectPending`;
  переиспользуют приватные `findPendingMessage` `:216-235`, `acquirePendingLock` `:294-296`)
- Тесты: `apps/server/src/policy/pending.test.ts`

**Интерфейсы (produces; consumes — `answerMessageId`/`questionStaleMessageId` из Задачи 1,
`kind` из Задачи 2):**
```ts
export type AnswerQuestionResult =
  | { status: 'answered'; pendingId: string }                    // записан этот ответ
  | { status: 'already'; answer: string }                        // другой ответ уже применился (С5)
  | { status: 'stale' };                                         // вопрос погашен, ответ НЕ записан (В2)
export async function answerPendingQuestion(
  db: Db,
  args: { ownerId: string; pendingId: string; answer: string; option?: number },
): Promise<AnswerQuestionResult>;
// Порядок под withIdentity: acquirePendingLock → findPendingMessage (kind !== 'question' →
// ExecError VALIDATION «это действие — его принимают, а не отвечают») → перечитка ОБОИХ PK
// (answerMessageId, questionStaleMessageId):
//   есть stale-запись → { status:'stale' } БЕЗ записи;
//   есть answer-запись: тот же answer → replay { status:'answered' }; другой →
//     { status:'already', answer: применившийся } (молча не схлопывать — С5);
//   иначе → appendMessageIdempotent { id: answerMessageId(owner, pendingId), threadId (из
//     found), role:'user', content: `Ответ: «<answer>»`,
//     metadata: { type:'question_answered', answers: pendingId, answer,
//                 ...(option!==undefined && {option}), source:'ui' } }
//     → { status:'answered' }.
// role:'user' + source:'ui' — автор ответа ВЛАДЕЛЕЦ (§6/§9.5 спеки «ответы — ui-сообщения»);
//   гашение (stalePendingQuestion) — role:'system' (автор — система). Сообщения судеб не
//   несут metadata.actions → в журнал §7.8 и Undo не попадают.
// option — ИНДЕКС выбранного варианта (0..3); answer при этом = текст варианта (клиент шлёт оба).

export async function stalePendingQuestion(
  db: Db,
  args: { ownerId: string; pendingId: string; text: string },
): Promise<{ staled: boolean }>;   // staled:false — вопрос уже отвечен (ответ важнее гашения) или уже погашен
// Тот же замок и перечитка; text — свой текст гашения (у гашения вопроса нет RejectReason);
// metadata: { type:'question_stale', stales: pendingId }.
```
- [ ] **Шаг 1: падающие тесты** — `pending.test.ts`:
```ts
test('ответ на открытый вопрос → append с PK answerMessageId; повторный ТОТ ЖЕ ответ → replay answered, второй записи нет (приёмка 5)', …);
test('другой ответ после записанного → {already, answer: первый}; запись одна (С5, приёмка 5)', …);
test('ответ на погашенный → {stale}, записи нет (В2); гашение отвеченного → {staled:false}, ответ жив (ОЧ.8)', …);
test('гонка ответ vs гашение: 25 итераций Promise.all — судьба ровно одна, первая записанная финальна, обе стороны сходятся на ней (приёмка 17; прецедент pending.test.ts:330-368)', …);
test('answerPendingQuestion на kind:action → VALIDATION; на чужой/несуществующий pendingId — как у rejectPending (fail-closed)', …);
```
- [ ] **Шаг 2:** FAIL → **Шаг 3:** реализация. — [ ] **Шаг 4:** PASS, `bun run test`,
  `bun run typecheck`; коммит
  `feat(policy): судьбы вопроса — ответ и гашение под замком, первая судьба финальна (D42 ОЧ.8, ОЧ.9)`.

---

### Задача 4: Объектный пре-чек в `runMutation` — запрещённое не откладывается

Реализует строку 1 таблицы ОЧ.4 (Б2 ревью) и половину инварианта §9.1: цель в
`ROUTINE_UNTOUCHABLE_OBJECTS` ∪ `orbis/assignment`, любая форма `grantsAutonomy` или правка
инструкции act-рутины → `FORBIDDEN_LEVEL` агенту на диспатче, отложки нет. Отложку НЕ строит
(Задача 5) — в этой задаче гейт инварианта 5 остаётся, пре-чек встаёт ПЕРЕД ним.

**Файлы:**
- Изменить: `apps/server/src/tools/dispatch.ts` (новая функция-пре-чек + вызов между
  `:745` (level) и гейтом `:752-758`; `details.reason` у отказов)
- Тесты: `apps/server/src/tools/dispatch.test.ts`

**Интерфейсы (produces):**
```ts
// dispatch.ts — приватная, рядом с actRoutineInstructionTargets (:1051-1071):
async function routineDeferForbidden(
  tx или ctx.db, ctx, ops: Array<{tool: string; input: unknown}>, facts: ToolCallFacts,
  instructionOf: string[],
): Promise<string | null>;   // null = можно откладывать; строка = человекочитаемая причина отказа
// Проверки (все — ДО постановки, отказ агенту, не владельцу на кнопке — принцип propose.ts:19-22):
//   1) facts.grantsAutonomy === true → «выдача автономии из фона не откладывается» (В1 §14);
//      grantsRoutineAutonomy — confirmation.ts:122-137 (ровно mode/allowed_tools);
//   2) instructionOf.length > 0 → «правка инструкции act-рутины из фона не откладывается» (В1);
//   3) цели операций читаются одним SELECT id, aspects (образец actRoutineInstructionTargets
//      :1051-1071, containment не нужен — по id): цель с аспектом из
//      ROUTINE_UNTOUCHABLE_OBJECTS (['orbis/routine','orbis/agent-run'], invariants.ts:364)
//      или 'orbis/assignment' → «рутина не может менять рутины, прогоны и назначения» —
//      формулировка routineUntouchableError (invariants.ts:444-450), тот же смысл РАНЬШЕ;
//   4) relation_create/relation_delete с концом в untouchable-объекте — тоже отказ
//      (зеркало assertRoutineRelationUntouchable, invariants.ts:430-437).
// Вызов: только при ctx.source === 'routine' && level !== 'execute' (чат/MCP не трогаем).
// Отказ: errorResult('FORBIDDEN_LEVEL', <причина>, { tool, level, reason: 'routine_untouchable' })
//   — details.reason НОВЫЙ (сегодня инвариант 5 несёт только {tool, level} — код FORBIDDEN_LEVEL
//   перегружен шестью источниками, различать в тестах и UI больше нечем).
```
- [ ] **Шаг 1: падающие тесты** — `dispatch.test.ts` (субъект-рутина собирается как в
  существующих тестах гейта V1.10 — найти по строке `FORBIDDEN_LEVEL` + `routine`):
```ts
test('рутина act: entity_update {archived:true} по СУЩНОСТИ-РУТИНЕ → FORBIDDEN_LEVEL с reason routine_untouchable ещё на диспатче (приёмка 12)', …);
test('рутина act: entity_update с mode/allowed_tools чужой рутины (grantsAutonomy) → отказ на диспатче; attach_orbis_routine data.mode=act → отказ; entity_create с orbis/routine.mode=act → отказ (В1)', …);
test('рутина act: правка body инструкции act-рутины → отказ на диспатче (пере-использован actRoutineInstructionTargets)', …);
test('рутина act: архивация ОБЫЧНОЙ записи по-прежнему упирается в гейт инварианта 5 (отложки ещё нет — её строит Задача 5); чатовый путь не изменился байт-в-байт', …);
```
- [ ] **Шаг 2:** FAIL → **Шаг 3:** реализация. — [ ] **Шаг 4:** PASS, `bun run test`,
  `bun run typecheck`; коммит
  `feat(dispatch): объектный пре-чек рутинной мутации — запрещённое отклоняется до постановки (D42 ОЧ.4, Б2)`.

---

### Задача 5: Отложка на диспатче — предусловия, кап, карточка, `pending_confirmation`

Ядро оси Б (ОЧ.4/ОЧ.13): для `source:'routine'` уровень `explicit-confirmation` больше не
отказ, а pending-единица `kind:'action'` со снятыми предусловиями; модель получает честный
`{status:'pending_confirmation', pendingId}` и продолжает. Гейт инварианта 5 остаётся для
`forbidden` и пре-чека Задачи 4.

**Файлы:**
- Изменить: `apps/server/src/tools/dispatch.ts` (ветка `:752-758` + докблок `:747-751` —
  ПЕРЕПИСАТЬ под новый инвариант 5; новая ветка отложки перед сегодняшней веткой
  `createPending` `:765-802`), `apps/server/src/routines/propose.ts` (экспорт `loadTargets`
  `:481-532` и `buildUpdate` `:545-591` — тела не меняются), `apps/server/src/tools/registry.ts`
  (union `Card` `:164-240` + вариант `deferred_action_card`), `apps/server/src/routines/constants.ts`
  (`MAX_RUN_UNITS = 10` с докблоком-зеркалом `MAX_PROPOSAL_OPERATIONS` `:6-15`),
  `apps/server/src/routines/runner.ts` (докблок `:428-433` «для рутины недостижим» — снять)
- Тесты: `apps/server/src/tools/dispatch.test.ts`, `apps/server/src/policy/pending.test.ts`

**Интерфейсы (produces; consumes — `deferDedupeKey`/`listRunUnits`/`kind` из Задачи 2,
пре-чек из Задачи 4):**
```ts
// routines/constants.ts:
export const MAX_RUN_UNITS = 10;   // кап единиц на прогон (В4 §14); превышение — структурный
                                   // отказ агенту, не молчаливое усечение (§9.9)
// registry.ts — union Card += (поля ДОСЛОВНО дублируются в web/cards/types.ts — Задача 12):
| {
    kind: 'deferred_action_card';
    pendingId: string;
    runId: string;
    routineId: string;
    summary: string;                       // «Архивация: «<заголовок цели>»» и т.п.
    rows: Array<{ aspect?: string; field: string; before?: string; after: string }>;
    // «было → станет» из снятых предусловий (ОЧ.13); сервер шлёт СЫРЫЕ aspect/field —
    // русские подписи ставит web через aspectLabel/fieldLabel (приём ProposalCard
    // rowLabel :80-84; серверного словаря подписей нет); архивация → {field:'archived',
    // before:'false'|'(не было)', after:'true'}
  }
// dispatch.ts — новая ветка в runMutation (source==='routine' && level==='explicit-confirmation'):
//   1) пре-чек Задачи 4 (отказ — раньше всего);
//   2) withIdentity-tx: targets = loadTargets(tx, операции) — NOT_FOUND здесь, не на approve;
//      операции entity_update дополняются предусловиями buildUpdate (in:[текущее]/absent:true;
//      body → expectedUpdatedAt настоящего снимка; модельный отбрасывается — Ш1.6/ОЧ.13);
//      для архивации — archived absent/false + снимок заголовка цели в карточку;
//   3) pendingId = pendingMessageId(owner, deferDedupeKey(runId, tool, input С предусловиями? НЕТ:
//      хеш считается от ИСХОДНОГО payload модели (tool + envelope-input) — ретрай модели
//      побайтово тот же, а предусловия у второго снятия могли бы уже отличаться);
//   4) PK-проба существования (SELECT id по pendingId, образец propose.ts:222-228) →
//      есть → replay: вернуть pending_confirmation с тем же pendingId, второй карточки нет;
//   5) кап: listRunUnits(...).filter(u => u.fate === 'open').length >= MAX_RUN_UNITS →
//      errorResult('VALIDATION', 'пачка полна — заверши прогон', { reason:'run_units_cap',
//      limit: MAX_RUN_UNITS }) — структурный отказ, модель корректируется (ОЧ.10);
//   6) createPending(tx, { threadId: ensureEntityThread(tx, owner, routineId) — тред РУТИНЫ,
//      actor: {userId, kind:'ai', source:'routine', runId}, tool, input: <с предусловиями>,
//      level:'explicit-confirmation', dedupeKey: deferDedupeKey(...), kind:'action',
//      card: deferred_action_card {...}, content: `Отложено до решения: <summary>` })
//      — kind-расширение createPending сделала Задача 2;
//   7) возврат { status:'pending_confirmation', pendingId, card } — существующая форма (:801),
//      ветка toolResultPayload (runner.ts:436-438) доносит модели {status, pendingId}.
// Инвариант 5, новая формулировка — в докблок :747-751 (дословно из §9.1 спеки):
//   «В фоне небезопасное откладывается с продолжением работы; запрещённое — по уровню или
//    по объекту — отклоняется и не откладывается никогда».
```
В журнал §7.8 отложка следа не оставляет (pending невидим журналу — `pending.ts:107-109`);
`forbidden`-уровень и `unknown` — прежний отказ.
- [ ] **Шаг 1: падающие тесты** — `dispatch.test.ts`:
```ts
test('рутина act: архивация записи → pending kind:action с предусловием archived absent/false и снимком заголовка в карточке; модели вернулся pending_confirmation с pendingId; прогон-журнал §7.8 пуст (приёмка 2)', …);
test('ретрай того же вызова (в т.ч. с переставленными ключами JSON) → тот же pendingId, второй карточки нет, кап не мешает replay (приёмка 15, Р-15)', …);
test('11-я открытая единица → VALIDATION «пачка полна» с reason run_units_cap; прогон может продолжаться (приёмка 16)', …);
test('«Принять» отложенную архивацию после изменения цели → stale с mismatches (предусловия сняты при постановке и не переснимаются — ОЧ.13, §9.4; approvePending без правок)', …);
test('чат/MCP: ветка createPending байт-в-байт прежняя (dedupeKey batch-only, карточка confirmation_card)', …);
```
- [ ] **Шаг 2:** FAIL → **Шаг 3:** реализация (порядок: constants → карточка → экспорт
  loadTargets/buildUpdate → ветка → докблоки). — [ ] **Шаг 4:** PASS, `bun run test`,
  `bun run lint`, `bun run typecheck`; коммит
  `feat(dispatch): отложка небезопасного действия рутины — предусловия при постановке, кап, карточка (D42 ОЧ.4, ОЧ.13, Б3)`.

---

### Задача 6: `orbis_ask` — реестр, модуль, ветка диспатча, описания

Реализует ОЧ.5/ОЧ.12: нетерминальный вопрос как рутинный глагол по образцу `orbis_propose`
(Р-1 — НЕ через verbs.ts). Правит описание `orbis_checkpoint` (оно сегодня врёт рутине).

**Файлы:**
- Создать: `apps/server/src/routines/ask.ts`, `apps/server/src/routines/ask.test.ts`
- Изменить: `apps/server/src/tools/registry.ts` (`askJsonSchema` рядом с `checkpointJsonSchema`
  `:517-533`; `ASK_TOOL` рядом с `PROPOSE_TOOL` `:600-614`; `ROUTINE_BASE_TOOLS` `:73` +
  `'orbis_ask'`; `buildToolDefs` `:887-892`; описание `orbis_checkpoint` `:669-674`; union
  `Card` + `question_card`), `apps/server/src/tools/dispatch.ts` (ветка рядом с propose
  `:363-369`), `apps/server/src/routines/runner.ts` (`:403` — содержательная сводка шага;
  kind-расширение `createPending` сделала Задача 2 — здесь только использование)
- Тесты: `apps/server/src/tools/registry.test.ts`, `apps/server/src/tools/dispatch.test.ts`,
  `apps/server/src/ai/send-message.test.ts` (страховка `:1069` — прогнать), `apps/server/src/mcp/mcp.test.ts`

**Интерфейсы (produces; consumes — `askInput`/`AskResult` из Задачи 1, `askDedupeKey`/
`listRunUnits` из Задачи 2, `MAX_RUN_UNITS` из Задачи 5):**
```ts
// registry.ts:
const askJsonSchema = { /* зеркало askInput: run_id, question 1..4000, options ≤4×200 —
  БЕЗ id (ОЧ.9: ключ идемпотентности выводится из содержимого);
  additionalProperties:false, required:['run_id','question'] — иначе тест парности */ };
export const ASK_TOOL: OrbisToolDef = {
  name: 'orbis_ask', kind: 'mutate', routineOnly: true, inputJsonSchema: askJsonSchema,
  description: /* инструкция модели: нетерминальный вопрос — карточка владельцу, прогон
    ПРОДОЛЖАЕТСЯ; ответ придёт в историю следующего прогона; для «без ответа дальше
    бессмысленно» — orbis_checkpoint; не больше MAX_RUN_UNITS открытых единиц */,
};
// ROUTINE_BASE_TOOLS = new Set(['orbis_checkpoint', 'orbis_ask'])  — доступен ОБОИМ режимам
//   (инвариант 4 V1 переформулирован — ОЧ.5); routineOnly отсекает чат (send-message.ts:315)
//   и MCP (mcp/server.ts:64-67) без правок в них.
// Описание orbis_checkpoint: переписать под ДВА субъекта (у рутины нет тикета и claim_task;
//   «прогон закрывается, ответ — в истории следующего прогона»), грантовая половина остаётся.
// union Card += | { kind: 'question_card'; pendingId: string; runId: string; routineId: string;
//   question: string; options?: string[] }

// routines/ask.ts (скелет — runPropose, propose.ts:118-339, БЕЗ closeRoutineRun):
export async function runAsk(ctx: ToolCallCtx, input: AskInput): Promise<ToolDispatchResult>;
// 1) гейты: source==='routine' && ctx.routine !== undefined; ровно один субъект;
//    input.run_id === ctx.routine.runId (иначе VALIDATION «вопрос адресован не тому прогону»);
// 2) withIdentity: pendingId = pendingMessageId(owner, askDedupeKey(runId, question, options));
//    PK-проба существования → replayed:true (кап не мешает — Р-15);
//    кап MAX_RUN_UNITS по открытым listRunUnits → VALIDATION «пачка полна — заверши прогон»;
//    threadId = ensureEntityThread(tx, owner, routine.id);
//    createPending(tx, { threadId, actor: {userId, kind:'ai', source:'routine', runId},
//      kind:'question', question, options, level:'explicit-confirmation' (гейт уровня не
//      ослабляется — Задача 2), dedupeKey, card: question_card {…},
//      content: `Вопрос владельцу: «<question>»` });   // tool/input НЕ передаются
// 3) возврат ok({ run_id, pending_id: pendingId, replayed }) — модель увидит
//    [tool_result:orbis_ask] {"status":"ok","result":{"pending_id":…}} (snake_case в result).
// dispatch.ts — ветка: if (pre.def.name === 'orbis_ask') return await runAsk(ctx,
//   parseEnvelope(askInput, input, pre.def.name));  // рядом с propose :363-369, ДО runMutation
// runner.ts:403 — сводка шага: orbis_ask → `спросил: «<question ≤120>»`;
//   pending_confirmation → `отложено: <card.summary>`.
```
- [ ] **Шаг 1: падающие тесты**:
```ts
// ask.test.ts:
test('orbis_ask в act и в propose создаёт pending kind:question с карточкой в треде рутины; возврат {run_id, pending_id, replayed:false}; прогон НЕ закрыт (outcome running) (приёмка 1)', …);
test('повтор того же вопроса → тот же pending_id, replayed:true, второй карточки нет; 11-й открытый вопрос → VALIDATION «пачка полна» (приёмки 15, 16)', …);
test('run_id чужого прогона → VALIDATION; вызов из чата/MCP → routineGate VALIDATION «такого тула не существует» (dispatch.ts:418-426 — НЕ FORBIDDEN_LEVEL, пин dispatch.test.ts:1693-1697 не трогать); рутина вне контекста → FORBIDDEN_LEVEL (приёмка 14)', …);
// registry.test.ts: счётчики 30→31 (:130, текст заголовка :121) и 31→32 (:295); режимные пины
//   :393-403 (+'orbis_ask'), :405-420, :469-475; ZOD_BY_TOOL += orbis_ask: askInput (:304-326).
// dispatch.test.ts:1682-1699: литерал routineOnly → ['orbis_ask','orbis_propose'].
// mcp.test.ts: рядом с :480 — expect(names).not.toContain('orbis_ask'); комментарий :486 обновить.
// send-message.test.ts:1069 — прогнать без правок (страховка «orbis_* не в чате» зелёная).
```
- [ ] **Шаг 2:** FAIL → **Шаг 3:** реализация. — [ ] **Шаг 4:** PASS, `bun run test`,
  `bun run lint`, `bun run typecheck`; коммит
  `feat(routines): orbis_ask — нетерминальный вопрос владельцу из прогона (D42 ОЧ.5, ОЧ.12, Б6)`.

---

### Задача 7: `ROUTINE_MAX_STEPS = 12`; `undecided` во ВСЕХ трёх путях закрытия

Реализует ОЧ.10 (потолок шагов) и ОЧ.6/С1 (постановка флажка): флажок `undecided: true`
пишется, когда у прогона остались открытые единицы, — на ВСЕХ путях закрытия рутинного
прогона (Р-5): `closeRoutineRun` (settle раннера И терминальный propose), **checkpoint-путь**
(`checkpoint()` → `closeRun` напрямую, минуя `closeRoutineRun` — спека ОЧ.6: «или checkpoint —
тогда у прогона и терминальный вопрос, и пачка») и подметание (sweep).

**Файлы:**
- Изменить: `apps/server/src/routines/constants.ts` (`ROUTINE_MAX_STEPS = 12` рядом с
  `RUN_DEADLINE_MS` `:24`), `apps/server/src/routines/runner.ts` (`:13` комментарий, `:20`
  импорт, `:355` потолок — только рутинный раннер; чат `send-message.ts:384` НЕ трогать),
  `apps/server/src/agent-loop/verbs.ts` (`closeRoutineRun` `:960-998` — проба + `undecided`
  в `runPatch`; `checkpoint()` `:885-913` — та же проба для `ctx.subject.kind === 'routine'`,
  флажок в тот же патч, что `outcome:'checkpoint'`), `apps/server/src/agent-loop/sweep.ts`
  (проба между `:107` и `:109`, `undecided` в тот же CAS-патч `:121-132` ветки `isRoutineRun`)
- Тесты: `apps/server/src/routines/runner.test.ts` (`:286`, `:367` — скрипты длины потолка),
  `apps/server/src/agent-loop/verbs.test.ts` (либо где тестируются `closeRoutineRun`/`checkpoint`),
  `apps/server/src/agent-loop/sweep.test.ts`

**Интерфейсы (produces; consumes — `listRunUnits` из Задачи 2):**
```ts
// routines/constants.ts:
export const ROUTINE_MAX_STEPS = 12;  // шаг = вызов провайдера, не вызов тула (С9);
                                      // только рутинный раннер — чат живёт на MAX_AGENT_STEPS
// verbs.ts closeRoutineRun И checkpoint() (рутинная половина): перед сборкой патча —
//   const open = (await withIdentity(ctx.db, ctx.ownerId, (tx) =>
//     listRunUnits(tx, ctx.ownerId, runId))).filter(u => u.fate === 'open');
//   (VerbCtx несёт db, не tx — verbs.ts:70-78; своё withIdentity, как у соседних чтений)
//   runPatch: () => ({ outcome, …, ...(open.length > 0 && { undecided: true }) })
//   — исход и флажок ОДНИМ патчем (довод докблока verbs.ts:968-972 про proposal);
//   актор патча прежний ({ai, system} — actorOf verbs.ts:87-95, инвариант §9.6);
//   у ГРАНТОВОГО чекпойнта пробы нет (единиц у гранта не бывает — гейт ОЧ.12).
// sweep.ts: та же проба своим withIdentity (как ticketOfRun :91); undecided:true — в
//   существующий CAS-патч ветки isRoutineRun; у грантового прогона флажка нет.
```
- [ ] **Шаг 1: падающие тесты**:
```ts
// runner.test.ts: скрипты :286/:367 переводятся на ROUTINE_MAX_STEPS; тест «12-шаговый прогон
//   завершается steps, 13-го вызова провайдера нет» (замена констант, поведение прежнее).
// closeRoutineRun: прогон с открытым вопросом → close-патч finished несёт undecided:true;
//   прогон с ЕДИНСТВЕННОЙ решённой единицей → undecided НЕ пишется; прогон terminal-propose
//   с открытым вопросом (ask в propose-режиме) → undecided:true (путь propose.ts:293, Р-5).
// checkpoint-путь: рутинный прогон с открытой отложкой закрыт orbis_checkpoint →
//   патч {outcome:'checkpoint'} несёт undecided:true — терминальный вопрос и пачка
//   сосуществуют (ОЧ.6, приёмка 9); грантовый чекпойнт — патч прежний байт-в-байт.
// sweep.test.ts: рутинный running-прогон с открытой единицей, last_step_at старше порога →
//   sweep закрыл failed С undecided:true; единицы живы (карточки не тронуты) (приёмка 13);
//   без единиц → патч прежний байт-в-байт.
```
- [ ] **Шаг 2:** FAIL → **Шаг 3:** реализация. — [ ] **Шаг 4:** PASS, `bun run test`,
  `bun run typecheck`; коммит
  `feat(routines): ROUTINE_MAX_STEPS=12; undecided во всех путях закрытия прогона (D42 ОЧ.6, ОЧ.10, С1)`.

---

### Задача 8: Гашение списком — `closeOpenOfRun` над единицами; снятие `undecided`

Реализует ОЧ.8: новый прогон (supersedeOpen) и откат гасят ВСЕ нерешённые единицы прошлых
прогонов — действия через `rejectPending` со своими текстами, вопросы через
`stalePendingQuestion`; ранний `return out` («либо предложение, либо вопрос») снимается;
гашение снимает `undecided` с прогонов, чьи единицы погасило.

**Файлы:**
- Изменить: `apps/server/src/routines/lifecycle.ts` (`closeOpenOfRun` `:262-353`;
  `supersedeOpen` `:221-243` — тексты)
- Тесты: `apps/server/src/routines/lifecycle.test.ts`

**Интерфейсы (produces; consumes — `listRunUnits`/`rejectPending{text}` из Задачи 2,
`stalePendingQuestion` из Задачи 3):**
```ts
// closeOpenOfRun — расширение возврата (прежние поля живут, потребители не ломаются):
Promise<{ proposal: boolean; question: boolean; units: number }>   // units — сколько единиц погашено
// Порядок внутри (прежний принцип «сначала судьба pending, потом патч прогона» :252-256):
//   1) ветка предложения :278-323 — БЕЗ раннего return :322 (снять; чужая причина/CONFLICT
//      по-прежнему прерывают только СВОЮ ветку);
//   2) ветка терминального вопроса :325-351 — как была;
//   3) НОВОЕ: единицы = listRunUnits(...).filter(open), в порядке created_at, id:
//        kind:'action' → rejectPending(db, { ownerId, pendingId, reason,
//          text: reason === 'superseded' ? 'Отложенное действие снято новым прогоном'
//                                        : 'Отложенное действие устарело: прогон откачен' });
//          чужая причина уважается (alreadyRejected — пропуск), «уже исполнено» — пропуск
//          с логом (единица решена, гасить нечего);
//        kind:'question' → stalePendingQuestion(db, { ownerId, pendingId,
//          text: args.questionNote });   // staled:false (отвечен) — пропуск: ответ важнее
//   4) НОВОЕ: если гасили единицы ИЛИ у прогона undecided:true и открытых больше нет —
//      patchAspect { undecided: false } (снятие = запись false, Р-4), актор по умолчанию
//      ACCOUNTING_ACTOR {ai, system} + runId (§9.6: все писатели флажка — system);
//      CONFLICT глотается с логом (лестница §5 — пересчёт при следующем решении).
// supersedeOpen (:230-238): передаёт questionNote прежний; reason 'superseded'.
// rollbackRun (rollback.ts:418-428) наследует обобщение автоматически (reason 'stale').
```
**Условная часть (общая работа Ш1, п. 2):** если к старту задачи в `main` уже есть
`rejectPendingTx` — гашение действий МОЖЕТ остаться на обёртке `rejectPending(db, …)`
(атомарность между единицами не обещается — ОЧ.11); менять сигнатуры Ш1 запрещено, `text?`
добавляется в args обеих форм одинаково.
- [ ] **Шаг 1: падающие тесты** — `lifecycle.test.ts`:
```ts
test('closeOpenOfRun гасит СПИСОК: 2 вопроса + 1 отложка + pending-предложение того же прогона → предложение superseded (прежний путь), отложка rejected с текстом «снято новым прогоном» (НЕ «Предложение…» — С6), вопросы stale; порядок судьба→патч сохранён (приёмка 8)', …);
test('прогон с предложением И открытым вопросом: гасятся ОБА (ранний return снят — Р-5 lifecycle-разведки)', …);
test('гашение сняло undecided (запись false, source system); отвеченный вопрос гашение пережил (ответ важнее — приёмка 17-половина)', …);
test('решённая (approved) единица гашением не тронута; чужая причина отказа не перезаписана', …);
test('rollbackRun после отката гасит единицы reason stale с текстом отката (приёмка 3-хвост: откат прогона откатывает и применённое, и гасит открытое)', …);
```
- [ ] **Шаг 2:** FAIL → **Шаг 3:** реализация. — [ ] **Шаг 4:** PASS, `bun run test`,
  `bun run typecheck`; коммит
  `feat(routines): гашение пачки списком — свои тексты судеб, снятие undecided (D42 ОЧ.8, С6)`.

---

### Задача 9: История прогонов — единицы в `RoutineHistoryItem` и строках контекста

Реализует ОЧ.7 (Б1 ревью): ответы и судьбы единиц доезжают следующему прогону НОВЫМ слоем —
расширением истории. Потолки: текст ≤ `HISTORY_TEXT_CAP` (500), единиц на прогон в истории —
≤ `MAX_RUN_UNITS`; переполнение — «и ещё N» (новый приём — прецедента в истории нет,
образец текста `executor.ts:874-880`).

**Файлы:**
- Изменить: `apps/server/src/routines/lifecycle.ts` (`routineHistory` `:742-764` — сбор
  единиц), `apps/server/src/routines/context.ts` (`RoutineHistoryItem` `:40-45`,
  `historyLine` `:117-134`, `historyMessage` `:141-150`)
- Тесты: `apps/server/src/routines/lifecycle.test.ts`, `apps/server/src/routines/context.test.ts`
  (фикстурный набор `:136-179` — образец)

**Интерфейсы (produces; consumes — `listRunUnits` из Задачи 2):**
```ts
// routines/context.ts:
export interface RoutineHistoryUnit {
  kind: 'question' | 'action';
  text: string;              // вопрос ЛИБО summary действия (обрезка quote/HISTORY_TEXT_CAP)
  fate: 'open' | 'approved' | 'rejected' | 'answered' | 'stale';
  answer?: string;           // fate:'answered'
}
// RoutineHistoryItem += units?: RoutineHistoryUnit[];   // ≤ MAX_RUN_UNITS, старые прогоны без поля живут
// historyLine — новые части В ДИАПАЗОНЕ :129-132 (после «спрашивал:», до «причина сбоя:»),
//   по одной на решённую/открытую единицу:
//   question+answered → `спрашивал: «…» — ответ: «…»`;  question+stale → `спрашивал: «…» — снят`;
//   question+open → `спрашивал: «…» — без ответа`;
//   action+approved → `откладывал: «…» — принято`;  action+open → `откладывал: «…» — ждёт решения`;
//   action+rejected — подпись из ПАРЫ (fate, reason), fate:'stale' у действий недостижим
//   (контракт RunUnit Задачи 2): reason 'owner' → `— отклонено`; 'stale' → `— устарело`;
//   'superseded' → `— снято`;
//   свыше MAX_RUN_UNITS в item.units не кладём; при усечении — последняя часть `и ещё N решений`
//   (склонение — по образцу operationsNoun, pending.ts:53-60).
// routineHistory (lifecycle.ts:742-764): для каждого прогона хвоста — listRunUnits(tx, owner,
//   row.id); пустой список → ключа units нет. Хвост прежний — ROUTINE_HISTORY_TAIL = 7 (:32);
//   7 GIN-проб на сборку контекста — принятая цена (одна на прогон хвоста).
```
- [ ] **Шаг 1: падающие тесты**:
```ts
// lifecycle.test.ts: routineHistory отдаёт units с судьбами (ответ доезжает текстом);
//   прогон без единиц — без ключа units; предложение прогона в units не попало (Б5).
// context.test.ts: historyLine прогона с units печатает «спрашивал: … — ответ: …» и
//   «откладывал: … — принято» (приёмка 7-чтение); текст обрезан HISTORY_TEXT_CAP;
//   11+ единиц → «и ещё N решений»; прогон БЕЗ units — прежняя строка байт-в-байт.
```
- [ ] **Шаг 2:** FAIL → **Шаг 3:** реализация. — [ ] **Шаг 4:** PASS, `bun run test`,
  `bun run typecheck`; коммит
  `feat(routines): единицы пачки в истории прогонов — доставка ответов следующему прогону (D42 ОЧ.7, Б1)`.

---

### Задача 10: `decideDeferred`, `answerQuestion`, `runUnits` — решения владельца поштучно

Реализует §6 спеки (кроме `decideAll` — Задача 11): ядра в `lifecycle.ts` рядом с
`decideProposal`, тонкие процедуры в `routers/routine.ts`. Бухгалтерский патч `undecided`
после решающего действия. Гейты `kind` уже в policy (Задача 2) — здесь их сквозные тесты
через `ai.approve`/`ai.reject`.

**Файлы:**
- Изменить: `apps/server/src/routines/lifecycle.ts` (новые ядра рядом с `decideProposal`
  `:995-1006`; переиспользуют `preconditionMismatches` `:1210-1215`, `bodyMismatch`
  `:1226-1230`, `patchAspect` `:171-208`, `toExecError` `:924-926`),
  `apps/server/src/routers/routine.ts` (+3 процедуры рядом с `decideProposal` `:201-214`)
- Тесты: `apps/server/src/routers/routine.test.ts` (caller с инъекцией — образец
  `routine.test.ts:78-101`), `apps/server/src/routers/ai.test.ts`

**Интерфейсы (produces; consumes — `listRunUnits`/`RunUnit`/гейты `kind` из Задачи 2,
`answerPendingQuestion`/`AnswerQuestionResult` из Задачи 3):**
```ts
// lifecycle.ts:
export type DecideDeferredResult =
  | { status: 'applied'; actionId: string }
  | { status: 'stale'; mismatches: ProposalMismatchNote[] }   // предусловия разошлись (ОЧ.13)
  | { status: 'rejected' }
  | { status: 'already'; fate: RunUnit['fate'] };             // уже решена (в т.ч. повтор reject)
export async function decideDeferredUnit(
  deps: RoutineWriteDeps,
  args: { ownerId: string; pendingId: string; decision: 'approve' | 'reject' },
): Promise<DecideDeferredResult>;
// approve → approvePending (batchId = pendingId; replay даёт applied идемпотентно);
//   CONFLICT precondition_failed → stale с mismatches (разбор — образец approveProposal
//   :1092-1130); «уже отклонена» → already {fate:'rejected'}.
// reject → rejectPending({reason:'owner', text:'Отложенное действие отклонено владельцем'})
//   — свой текст единицы (тексты REJECT_CONTENT писаны про предложение — С6); повтор
//   возвращает исходную причину → маппится в already {fate:'rejected'}.
// После решающего действия — бухгалтерия: если открытых listRunUnits(run_id единицы) не
//   осталось → patchAspect { undecided: false } актором {ai,'system'}+runId (§9.6);
//   run_id берётся из pending-записи; отказ патча (архивный прогон — Р-17) глотается с логом.
export async function answerRunQuestion(
  deps: RoutineWriteDeps,
  args: { ownerId: string; pendingId: string; answer: string; option?: number },
): Promise<AnswerQuestionResult>;   // answerPendingQuestion + та же бухгалтерия undecided

// routers/routine.ts (все ownerOnly; отказы policy едут через execErrorToTRPC — образец ai.ts):
decideDeferred: .input(z.object({ pendingId: z.string().uuid(),
  decision: z.enum(['approve','reject']) }).strict()).mutation → DecideDeferredResult
answerQuestion: .input(z.object({ pendingId: z.string().uuid(),
  answer: z.string().min(1).max(4000), option: z.number().int().min(0).max(3).optional() })
  .strict()).mutation → AnswerQuestionResult
runUnits: .input(z.object({ runId: z.string().uuid() }).strict()).query → RunUnit[]
// runUnits прогон через runById НЕ читает (единицы адресуются pendingId — Р-17); отдаёт
//   listRunUnits как есть (порядок created_at, id).
```
- [ ] **Шаг 1: падающие тесты** — `routine.test.ts`:
```ts
test('«Принять» отложенную архивацию → applied; запись заархивирована source=routine + run_id; в журнале один action; откат прогона откатывает и её (приёмка 3)', …);
test('«Отклонить» → append-отказ с текстом единицы; повтор reject возвращает исходную причину already (приёмка 4)', …);
test('двойной клик «Принять» → replay, одна запись в журнале (приёмка 10)', …);
test('изменить цель после постановки → decideDeferred approve → stale с mismatches (ОЧ.13); вторая НЕЗАВИСИМАЯ единица по тому же полю после applied первой → stale честно, не молча (Р-16)', …);
test('answerQuestion: ответ → answered; тот же повторно → replay; другой → already с применившимся; на погашенный → stale без записи (приёмка 5, В2)', …);
test('после решения ПОСЛЕДНЕЙ открытой единицы аспект прогона получил undecided:false патчем source=system; «отмени последнее» после «Принять» отменяет ПРИМЕНЁННОЕ действие, а не патч флажка (приёмка 18; undo.ts:74 пропускает только system)', …);
test('runUnits отдаёт единицы с судьбами и карточками; предложение прогона в списке НЕТ (Б5)', …);
// ai.test.ts:
test('ai.approve/ai.reject на kind:question → структурный VALIDATION (гейт в policy — С7); на чатовый pending без kind — прежнее поведение', …);
```
- [ ] **Шаг 2:** FAIL → **Шаг 3:** реализация. — [ ] **Шаг 4:** PASS, `bun run test`,
  `bun run typecheck`; коммит
  `feat(routines): decideDeferred, answerQuestion, runUnits — поштучные решения пачки (D42 §6)`.

---

### Задача 11: `decideAll`, бейдж `undecided` в overview, смарт-лист-блок «Пачка решений»

Реализует ОЧ.11 («Принять все» — последовательно, не атомарно), бейдж по аспектному фильтру
(С8) и смарт-лист (Р-2/Р-3): третий query-блок в сид + условный UPDATE-бэкфилл + синхронная
правка PRD §3.3 (байт-в-байт тест).

**Файлы:**
- Изменить: `apps/server/src/routines/lifecycle.ts` (+`decideAllDeferred` рядом с ядрами
  Задачи 10), `apps/server/src/routers/routine.ts` (+`decideAll`; `RoutineOverview` `:53-61`
  и подсчёт `:254-261`), `apps/server/src/seed/smart-lists.ts` (`ROUTINES_LIST_BODY`
  `:78-84`), `apps/server/src/seed/onboarding.ts` (guard-ветка `:81-90` + новая функция
  рядом с `backfillRoutinesList` `:212-219`), `docs/prd/02-core-os.md` (§3.3, блок «Рутины»
  `:349-355` — синхронно с сидом, иначе красный `onboarding.test.ts:197-216`). Термин блока —
  «Пачка решений»: «ждёт ответа» занято терминальным вопросом, «ждёт решения» — предложением
  (`RunsList.tsx:20-28` прямо предупреждает не сливать) — третий вид ожидания получает своё имя
- Тесты: `apps/server/src/routers/routine.test.ts`, `apps/server/src/seed/onboarding.test.ts`
  (`expectedBlocks.routines` `:229` → 3; `:249-260` — исполнимость блока)

**Интерфейсы (produces; consumes — `decideDeferredUnit`/`listRunUnits` из Задач 2/10):**
```ts
// lifecycle.ts:
export type DecideAllItem = { pendingId: string } & DecideDeferredResult;
export async function decideAllDeferred(
  deps: RoutineWriteDeps, args: { ownerId: string; runId: string },
): Promise<DecideAllItem[]>;
// Открытые единицы kind:'action' (вопросы НЕ «принимаются» — ОЧ.11) в порядке created_at, id
// (детерминированный обход — защита от взаимной блокировки advisory-замков, Решение 7);
// каждая — decideDeferredUnit('approve'); одна протухшая НЕ блокирует остальные; повтор
// кнопки = N replay'ев; бухгалтерия undecided — внутри decideDeferredUnit.
// routers/routine.ts:
decideAll: .input(z.object({ runId: z.string().uuid() }).strict()).mutation → DecideAllItem[]
// RoutineOverview += undecided: number;   // прогонов с undecided===true среди live
//   (рядом с waiting :260: live.filter(r => r.run.undecided === true).length — С8:
//   аспектный фильтр, БЕЗ GIN-проб треда; точное число ЕДИНИЦ — только runUnits)
// seed/smart-lists.ts — ROUTINES_LIST_BODY += (В КОНЕЦ, после блока «Активные рутины» —
//   вставка не в конец сдвинула бы idsOfBlock-индексы в onboarding.test.ts:682-687):
//   {{query: aspect=orbis/agent-run, undecided=true, sortBy=started_at:asc, display=list, title=Пачка решений}}
// seed/onboarding.ts — в guard-ветку (:88-89, рядом с backfillRoutinesList):
async function backfillRoutinesListBody(tx, ownerId): Promise<void>;
// Литерал ПРЕЖНЕГО тела (двух-блочного) хранится константой рядом; UPDATE body = новое,
// body_doc = NULL (ленивая переконверсия — readBodyDoc падает на parseBody) ТОЛЬКО при
// байт-в-байт совпадении текущего body с прежним сидом; правленое владельцем тело НЕ
// трогается (принцип onboarding.ts:168-189 — сид не переписывает чужое). Идемпотентно:
// после первого UPDATE тело равно новому сиду, условие больше не совпадает.
```
- [ ] **Шаг 1: падающие тесты**:
```ts
// routine.test.ts:
test('«Принять все» при одной протухшей: N applied, 1 stale с mismatches; вопросы не тронуты; повтор кнопки — те же статусы replay (приёмка 6)', …);
test('overview.undecided считает прогоны с флажком; propose-прогон с ждущим предложением БЕЗ единиц в undecided не попал (приёмка 11-половина, Б5)', …);
test('decideAll не трогает предложение propose-прогона; decideProposal работает как прежде (приёмка 19)', …);
// onboarding.test.ts:
test('тело «Рутин» — три блока, третий undecided=true, байт-в-байт с PRD §3.3; блок исполняется entity.query: находит undecided-прогон, не находит решённый и checkpoint-прогон без флажка (приёмка 11-половина)', …);
test('бэкфилл: владелец со СТАРЫМ сид-телом получает новое (body_doc сброшен); владелец с правленым телом — не тронут; повтор бэкфилла — no-op', …);
```
- [ ] **Шаг 2:** FAIL → **Шаг 3:** реализация (сид + PRD §3.3 — ОДНИМ коммитом, тест
  байт-в-байт). — [ ] **Шаг 4:** PASS, `bun run test`, `bun run typecheck`; коммит
  `feat(routines): decideAll, бейдж undecided, смарт-лист-блок «Пачка решений» с бэкфиллом (D42 ОЧ.11, С8)`.

---

### Задача 12: Карточки треда — `QuestionCard` и `DeferredActionCard`

Реализует §7 спеки (карточки): два новых вида карточек по форме `ProposalCard` (состояние
ВСЕГДА с сервера — Р-10; не `useState`-приём `ConfirmationCard`, признанный ошибкой в
`ProposalCard.tsx:14-17`). Решённые сворачиваются в строку-итог.

**Файлы:**
- Создать: `apps/web/src/features/chat/cards/QuestionCard.tsx`, `DeferredActionCard.tsx`
- Изменить: `apps/web/src/features/chat/cards/types.ts` (два типа + union `Card` `:81-90` —
  поля ДОСЛОВНО как в server union `registry.ts` из Задач 5/6), `renderCards.tsx` (два `case`
  в `switch` `:100-140`, образец `proposal_card` `:107-111`)
- Тесты: `apps/web/src/features/chat/cards/cards.test.tsx` (хелпер `msg` `:10-19`, образец
  обработчика `proposalHandler` `:845-867`)

**Интерфейсы (produces; consumes — `routine.runUnits`/`RunUnit`, `routine.answerQuestion`/
`AnswerQuestionResult`, `routine.decideDeferred`/`DecideDeferredResult` из Задачи 10; типы
карточек из Задач 5/6):**
```ts
// types.ts (дословные зеркала серверных):
export type QuestionCardData = { kind: 'question_card'; pendingId: string; runId: string;
  routineId: string; question: string; options?: string[] };
export type DeferredActionCardData = { kind: 'deferred_action_card'; pendingId: string;
  runId: string; routineId: string; summary: string;
  rows: Array<{ aspect?: string; field: string; before?: string; after: string }> };

export function QuestionCard({ card }: { card: QuestionCardData }): JSX.Element;
export function DeferredActionCard({ card }: { card: DeferredActionCardData }): JSX.Element;
// Обе: свой запрос trpc.routine.runUnits.useQuery({ runId: card.runId }) → своя единица по
// card.pendingId (кэш ОДИН на все карточки прогона); судьба единицы — только с сервера.
// QuestionCard: открытый — текст + кнопки-варианты (card.options, шлют {answer: текст,
//   option: индекс}) + свободное поле (образец формы — RoutineQuestionBlock.tsx:100-129);
//   мутация routine.answerQuestion; исход already → показать применившийся ответ (С5);
//   stale → «Вопрос снят следующим прогоном», форма не принимает (В2).
//   Решённый/погашенный — СВЁРНУТ в строку-итог: «Вопрос: «…» — ответ: «…»» / «— снят»
//   (разворот по клику; «прячем всё, кроме требующего ответа» — §7).
// DeferredActionCard: открытая — summary + строки card.rows «было → станет» (before из
//   снятого предусловия — ОЧ.13; подписи строк — aspectLabel(row.aspect)/fieldLabel из
//   lib/field-labels, приём rowLabel ProposalCard.tsx:80-84) + «Принять»/«Отклонить»
//   (routine.decideDeferred); исход stale → mismatches списком (готовый рендер — образец
//   ProposalCard.tsx:149-154 + testid proposal-stale); решённая — строка-итог
//   «Отложено: «…» — принято» (fate approved) / «— отклонено/устарело/снято» (fate rejected,
//   подпись из reason: owner/stale/superseded — fate:'stale' у действий недостижим, Задача 2).
// onSuccess обеих мутаций: invalidateGraph(utils) + (applied → void utils.budget.invalidate())
//   + void units.refetch()  — тред НЕ инвалидируется invalidateGraph, карточка обновляет себя
//   сама (приём ProposalCard :137-144); busy = mutation.isPending || units.isFetching (:162).
// data-testid: "question-card", "deferred-action-card".
```
- [ ] **Шаг 1: падающие тесты** — `cards.test.tsx`:
```ts
test('question_card открытый: варианты кнопками + свободное поле; клик варианта шлёт {pendingId, answer: текст варианта, option: индекс}; после ответа — свёрнутая строка с ответом (сервер отдал fate answered)', …);
test('question_card погашенный (fate stale) → «снят следующим прогоном», формы нет (В2)', …);
test('deferred_action_card: строки «было → станет»; «Принять» шлёт decideDeferred; исход stale → mismatches видимы; решённая — строка-итог без кнопок', …);
test('ответ already → показан применившийся ответ (С5); onSuccess дёргает runUnits повторно (mock calls)', …);
```
- [ ] **Шаг 2:** FAIL → **Шаг 3:** реализация. — [ ] **Шаг 4:** PASS
  (`cd apps/web && bunx vitest run src/features/chat/cards/cards.test.tsx`), `bun run test`,
  `bun run typecheck`; коммит
  `feat(web): карточки вопроса и отложенного действия — судьба всегда с сервера (D42 §7)`.

---

### Задача 13: Экран прогона — блок «Пачка решений», кнопки, плашка паузы, бейджи

Реализует §7 спеки (экран): блок пачки в `RunFeed`, «Принять все», «Продолжить сейчас» с
предупреждением (В3), плашка паузы (С2), оживление бейджей `undecided`.

**Файлы:**
- Создать: `apps/web/src/features/entity-detail/RunDecisionsBlock.tsx`
- Изменить: `apps/web/src/features/entity-detail/RunFeed.tsx` (узел между вопросом `:354` и
  предложением `:358`, `key={`batch-${entity.id}`}` — экран монтируется без key роутером),
  `RunsList.tsx` (бейдж пачки рядом с `PROPOSAL_LABELS`-бейджем `:80-103`),
  `RoutineStatusBlock.tsx` (строка `undecided` из `overview`)
- Тесты: `apps/web/src/features/entity-detail/detail.test.tsx` (фикстуры рутинного прогона
  `:3681-3759`, блок `describe('V1: прогон рутины')` `:3761`)

**Интерфейсы (produces; consumes — `routine.runUnits`, `routine.decideAll`/`DecideAllItem[]`,
`routine.overview.undecided`, `routine.runNow` из Задач 10/11; карточки из Задачи 12):**
```ts
export function RunDecisionsBlock({ entity }: { entity: Entity }): JSX.Element | null;
// Рендер при run.undecided === true ЛИБО при непустом runUnits (флажок мог потеряться —
//   лестница §5; явная сверка === true: aspect-read.ts boolean не умеет, Р-18).
// Внутри: заголовок «Пачка решений» + список единиц (QuestionCard/DeferredActionCard по
//   kind — те же компоненты, что в треде; кэш runUnits общий);
// «Принять все» — routine.decideAll → сводка по каждой: applied/stale/rejected/already
//   (протухшие — с расхождениями; ОЧ.11); кнопка видна при ≥1 открытом kind:'action';
// «Продолжить сейчас» — routine.runNow({routineId}) + openEntity(runId) (существующее
//   поведение кнопки — Решение 9); СКРЫТА при паузе рутины (routine.overview: nextBucketAt
//   === null при stage paused — докблок RoutineOverview :53-61); при run.outcome ===
//   'checkpoint' && !reply — предупреждение-подтверждение СВОЕЙ разметкой (образец Dialog —
//   RunFeed.tsx:454-485; НЕ window.confirm): «Неотвеченный вопрос прогона будет снят» (В3);
// Плашка при паузе: «Рутина на паузе — ответы прочитает после возобновления» (С2).
// RunsList: бейдж <Badge tone={undecided ? 'accent' : 'default'}>пачка: N</Badge> у прогона
//   с undecided (число — не тянуть: у списка нет единиц; писать «пачка решений» без числа);
//   термин «пачка» — третий вид ожидания (не сливать с «ждёт ответа»/«ждёт решения» —
//   предупреждение RunsList.tsx:21-22).
// RoutineStatusBlock: строка «Пачка решений: N прогонов» из overview.undecided (оживление
//   мёртвого поля — Р-11), рядом с существующим nextBucketAt :140-144.
```
Поллинг `run-poll.ts` НЕ трогается (пины исходов `run-poll.test.tsx:10-20`): закрытый прогон
не поллится; карточки обновляют себя собственными запросами (Задача 12).
- [ ] **Шаг 1: падающие тесты** — `detail.test.tsx` (мок `routine.runUnits`/`decideAll`/
  `overview` в `routineRunHandler` `:3728-3759`):
```ts
test('прогон finished с undecided и двумя единицами → блок «Пачка решений» с двумя карточками (приёмка 1-UI)', …);
test('«Принять все» шлёт decideAll и показывает сводку N applied / 1 stale с расхождениями (приёмка 6-UI)', …);
test('«Продолжить сейчас» шлёт runNow; при outcome=checkpoint без reply — сперва предупреждение, подтверждение шлёт runNow (приёмка 9, В3); при паузе (nextBucketAt null) кнопки нет, есть плашка паузы (С2)', …);
test('терминальный вопрос и пачка сосуществуют: RoutineQuestionBlock и RunDecisionsBlock видны одновременно (приёмка 9)', …);
test('RunsList: бейдж «пачка решений» у undecided-прогона; RoutineStatusBlock: строка из overview.undecided', …);
```
- [ ] **Шаг 2:** FAIL → **Шаг 3:** реализация. — [ ] **Шаг 4:** PASS
  (`bunx vitest run src/features/entity-detail/detail.test.tsx`), `bun run test`,
  `bun run lint`, `bun run typecheck`; коммит
  `feat(web): блок «Пачка решений» на экране прогона — принять все, продолжить сейчас, плашка паузы (D42 §7, В3, С2)`.

---

### Задача 14: Промпт `routine-v2` + фикстура

Реализует ОЧ.5 (различие `orbis_ask` vs `orbis_checkpoint` объясняет промпт). ТОЛЬКО новый
файл + фикстура (правило `routine-v1.ts:2-4`); `routine-v1.ts` не правится ни байтом.

**Файлы:**
- Создать: `apps/server/src/llm/prompts/routine-v2.ts`, `routine-v2.fixture.txt`,
  `routine-v2.test.ts`
- Изменить: `apps/server/src/routines/context.ts:28` (импорт `'../llm/prompts/routine-v2'`),
  `apps/server/src/routines/context.test.ts:9` (тот же импорт — тест `system.startsWith` `:85`)

**Интерфейсы (produces):**
```ts
// routine-v2.ts: ROUTINE_PROMPT_VERSION = 'routine-v2'; export { TOOL_RESULT_MARKER } from './v1';
// ROUTINE_SYSTEM_PROMPT (новый текст); routineModeSection — как в v1 (пере-экспорт запрещён:
// v1 не трогаем импортами из v2 в обратную сторону тоже — скопировать с сохранением текста,
// если правок в секции нет).
```
Содержание v2 против v1 (структура v1 — 8 разделов, `plan-recon-context-prompts.md`, §Г):
- **Раздел 5 «Вопрос владельцу» — переписан**: `orbis_ask` — нетерминальный вопрос
  (карточка владельцу, прогон ПРОДОЛЖАЕТСЯ, ответ придёт в историю следующего прогона;
  результат — `pending_id` внутри `result`); `orbis_checkpoint` — только когда без ответа
  дальнейшая работа бессмысленна (терминален, прогон закрывается). Выбор делает модель.
- **Раздел 3 (propose), строка «:48»**: «если предлагать нечего — спроси `orbis_ask` и
  продолжай собирать; `orbis_checkpoint` — если без ответа предложение не составить».
- **Раздел 4 (act) — новая строка**: «небезопасное действие не исполняется сразу — оно
  откладывается карточкой владельцу (`pending_confirmation` с `pendingId`), это НЕ ошибка:
  продолжай остальную работу».
- **Кап**: «не больше 10 открытых вопросов и отложек на прогон — дальше структурный отказ
  „пачка полна“; группируй вопросы в один ход, не трать шаги» (Р-7).
- **Раздел 1, строка про историю**: история прогонов несёт и решения по пачке
  («спрашивал/откладывал — ответ/принято»).
- **Сохраняется дословно**: преамбула, раздел 2 «Правила» целиком (в т.ч. запрет
  `orbis/routine`/`orbis/assignment`), «orbis_propose ТЕРМИНАЛЕН», разделы 6–7.
- [ ] **Шаг 1: падающие тесты** — `routine-v2.test.ts` (образец построчно —
  `routine-v1.test.ts`; diff-гард «строки v1 не потеряны, кроме явно заменённых» — образец
  `v3.test.ts:29-49`):
```ts
// снимок: ROUTINE_SYSTEM_PROMPT === фикстура (Bun.file … toBe; фикстура БЕЗ завершающего \n
//   — проверить tail -c 1 = не 0x0a, иначе toBe красный невидимым диффом);
// версия 'routine-v2'; упоминает orbis_ask КАК нетерминальный и orbis_checkpoint КАК
//   терминальный; называет кап «10»; diff-гард против v1 с явным списком заменённых строк;
// routineModeSection — три случая как в v1.
```
- [ ] **Шаг 2:** FAIL → **Шаг 3:** реализация + переключение импорта. —
- [ ] **Шаг 4:** PASS, `bun run test`, `bun run typecheck`; коммит
  `feat(llm): routine-v2 — ask против checkpoint, «отложено — продолжай», кап пачки (D42 ОЧ.5)`.

---

### Задача 15: Документы к факту — PRD §15 и D42, runbook

Реализует §15 спеки. Правка §3.3 тела «Рутин» уже сделана Задачей 11 (байт-в-байт тест) —
здесь остальное.

**Файлы:**
- Изменить: `docs/prd/01-architecture.md` §7.10 — (а) абзац «В фоне небезопасное — отказ,
  а не отложенное действие [V1]» → новая формулировка инварианта 5 (дословно §9.1 спеки:
  «В фоне небезопасное откладывается с продолжением работы; запрещённое — по уровню или по
  объекту (`ROUTINE_UNTOUCHABLE_OBJECTS` ∪ `orbis/assignment`, `grantsAutonomy`, инструкция
  act-рутины) — отклоняется и не откладывается никогда [D42]»); (б) оговорка к «глагол
  исполнителя никогда не возвращает pending»: `orbis_ask` возвращает `{pending_id}` как
  честный id созданной карточки — это результат постановки вопроса, не pending-ответ глагола;
  `docs/prd/02-core-os.md` — экран пачки решений в раздел экранов рутин (блок на экране
  прогона, карточки в треде, бейджи, смарт-лист-блок «Пачка решений»; оговорка: сайдбарный
  бейдж «Рутин» считает первый блок — терминальные вопросы, Р-3);
  `docs/prd/04-decision-log.md` — запись **D42** (формулировка из шапки спеки; номер
  СВЕРИТЬ при мерже — журнал правится параллельными сессиями);
  `docs/implementation/02-ops-runbook.md` — чек-лист «Деплой D42» (по образцу V1
  `:374-443`: ping → check → seed-aspects → check → деплой → Restart → `/health`;
  миграций НЕТ; заметка: бэкфилл тела «Рутин» едет сам при первом заходе владельца
  через guard-ветку онбординга; если тело было правлено руками — блок «Пачка решений»
  добавить вручную в редакторе).
- [ ] **Шаг 1:** правки по списку. — [ ] **Шаг 2:** `bun run test` (сиды не тронуты этой
  задачей — байт-в-байт тесты зелёные). — [ ] **Шаг 3:** коммит
  `docs(prd): инвариант 5 в новой формулировке, экран пачки решений, D42, чек-лист деплоя`.

---

### Задача 16: Живой смоук по приёмке §12 (1–19) и деплой с пересевом

**Файлы:** — (стенд, прод)

- [ ] **Шаг 1: локальный стенд** — `bunx supabase start`, пересеянный реестр, сервер с
  `ORBIS_LLM_PROVIDER=anthropic` (или scripted-прогон), живые act- и propose-рутины.
- [ ] **Шаг 2: приёмка 1–19 по номерам спеки** (провал любого пункта — стоп, починка в
  задаче-владельце, повтор): 1 — два `orbis_ask` (в т.ч. в propose), прогон дошёл до
  `finished`, `undecided`, две карточки; 2 — архивация из act отложена карточкой с «было»,
  модель получила `pending_confirmation` и доработала, журнал §7.8 без следа отложки; 3 —
  «Принять» → `source:'routine'`+`run_id`, один action, откат прогона откатывает; 4 —
  «Отклонить» с текстом единицы, повтор — исходная причина; 5 — ответ/replay/другой ответ →
  `already` с показом применившегося; 6 — «Принять все» при одной протухшей → сводка; 7 —
  «Продолжить сейчас» → `runNow`, новый прогон видит ответы в истории, нерешённое погашено;
  8 — плановый прогон гасит так же, `undecided` снят; 9 — терминальный чекпойнт жив, пачка
  и вопрос сосуществуют (прогон, закрытый чекпойнтом при открытой пачке, несёт `undecided`),
  кнопка предупреждает и гасит; 10 — двойной клик «Принять» → одна
  запись; 11 — смарт-лист: `checkpoint`-прогоны И `undecided`-пачки видны, propose-прогон с
  предложением в пачку не попал; 12 — запрещённое по уровню и объекту → отказ агенту,
  карточки нет; 13 — крэш прогона (кильнуть процесс) → sweep закрыл `failed` с `undecided`,
  карточки живы, следующий прогон погасил; 14 — `orbis_ask` невидим чату и MCP
  (`tools/list`), тикетный чекпойнт не изменился; 15 — ретрай с переставленными ключами →
  тот же `pendingId`; 16 — 11-я единица → «пачка полна», прогон завершился штатно; 17 —
  гонка «ответ vs гашение» → первая судьба финальна (можно тестом, живьём — по случаю);
  18 — «отмени последнее» после «Принять» → отменено действие, не патч флажка; 19 —
  `decideAll` не тронул предложение, `decideProposal` прежний.
- [ ] **Шаг 3: деплой** (миграций НЕТ; `.strict()`-схема + смарт-лист-блок → пересев
  СТРОГО ДО кода, отказ без пересева громкий — красная плашка листа):
  1. `bun scripts/ops.ts ping` → `check`; 2. `bun scripts/ops.ts seed-aspects` (реестр с
  `undecided`; старый код optional-поле не пишет — безопасно) → `check`; 3. ff-merge
  `deferred-checkpoint` в `main` + push → CI зелёный → Render деплой; 4. Restart сервиса;
  5. `curl /health` — `aspectDrift` отсутствует; 6. первый заход владельца — guard-ветка
  онбординга бэкфиллит тело «Рутин» (проверить блок «Пачка решений» в сайдбар-листе; если
  тело было правлено — добавить блок руками по runbook); 7. прод-смоук подмножества:
  приёмки 1, 2, 3, 5, 7, 11, 12 живой рутиной.
- [ ] **Шаг 4:** финальное ревью ветки fable (5 измерений) + по 2 opus-опровергателя на
  Critical/Important; запись исхода в `progress.md`.

---

## Вехи и прогоняемые проверки

| Веха | После задач | Проверка (коды возврата 0, машина незанята) |
|---|---|---|
| A. Контракты и носитель | 0–3 | `bun run db:prepare` (пересев), `bun run test`, `bun run lint`, `bun run typecheck`; ревью fable: инварианты §9.7, §9.8; гонный тест 25 итераций зелёный |
| B. Диспатч и глагол | 4–6 | `bun run test`; ревью fable: инварианты §9.1, §9.4, §9.9; счётчики реестра 31/32 согласованы; `send-message.test:1069` и MCP-исключение зелёные |
| C. Раннер/гашение/история | 7–9 | `bun run test`; ревью fable: инварианты §9.5, §9.6, §9.8 (гашение), доставка ответов (приёмка 7-чтение) |
| D. Роутеры | 10–11 | `bun run test`; ревью fable: §9.2, §9.5, приёмки 3–6, 10, 18, 19; сид ↔ PRD §3.3 байт-в-байт |
| E. Web | 12–13 | web-сьют, `bun run --filter @orbis/web build`; ревью fable: приёмки 1, 6, 9 на стенде; свёртка решённых; предупреждение В3 |
| F. Промпт, документы, деплой | 14–16 | финальное ревью ветки fable + опровергатели; приёмка 1–19; деплой |

## Порядок деплоя (кратко; подробно — Задача 16)

`ops.ts ping` → `ops.ts check` → `ops.ts seed-aspects` (ДО кода — `.strict()`-схема и
query-блок) → `check` → мерж + push + CI → Render деплой → Restart → `/health` без
`aspectDrift` → заход владельца (авто-бэкфилл листа) → прод-смоук. Миграций нет.

## Маппинг приёмки спеки §12 → задачи

| Приёмка | Задачи |
|---|---|
| 1. Два вопроса, прогон продолжился, `undecided`, две карточки | 6 (ask), 7 (флажок), 12 (карточки), 16 (живьём) |
| 2. Архивация отложена с «было», `pending_confirmation`, журнал чист | 5 |
| 3. «Принять» → `routine`+`run_id`, один action, откат отката | 10 (тест), 8 (откат гасит открытое) |
| 4. «Отклонить» с текстом единицы; повтор — исходная причина | 10 (owner-текст), 2 (`text?` у reject) |
| 5. Ответ; тот же — replay; другой — `already` с показом | 3 (ядро), 10 (роутер), 12 (показ) |
| 6. «Принять все» при протухшей → сводка; вопросы не тронуты | 11 (ядро+роутер), 13 (UI) |
| 7. «Продолжить сейчас» → `runNow`; ответы в истории; нерешённое погашено | 13 (кнопка), 9 (история), 8 (гашение), 16 (живьём) |
| 8. Плановый гасит; `undecided` снят | 8 |
| 9. Терминальный чекпойнт жив; сосуществование; предупреждение | 7 (checkpoint-путь несёт undecided — тест), 8 (гашение вопроса), 13 (предупреждение В3), 16 (живьём) |
| 10. Двойной клик «Принять» → replay | 10 |
| 11. Смарт-лист: `checkpoint` И `undecided`; propose-прогон не попал | 11 (блок + тест исполнимости + Б5) |
| 12. Запрещённое по уровню И объекту → отказ на диспатче | 4 |
| 13. Крэш → sweep с `undecided`; карточки живы; следующий погасил | 7 (sweep), 8 (гашение), 16 (живьём) |
| 14. Грант/MCP: `orbis_ask` недоступен; тикетный путь не изменился | 6 (routineOnly + MCP-тест; тикетный путь не трогается по построению) |
| 15. Ретрай с переставленными ключами → тот же `pendingId` | 2 (unitHash), 5 (defer), 6 (ask) |
| 16. 11-я единица → «пачка полна», прогон штатно | 5 (defer), 6 (ask) |
| 17. Гонка «ответ vs гашение» → первая судьба финальна | 3 (гонный тест), 8 (гашение отвеченного — пропуск) |
| 18. «Отмени последнее» → отменено действие, не патч флажка | 10 |
| 19. `decideAll` не трогает предложение; `decideProposal` прежний | 11 |

## Маппинг инвариантов спеки §9 → задачи

| Инвариант | Задачи с проверяемым выходом |
|---|---|
| 1. Откладывается с продолжением; запрещённое — отказ навсегда | 4 (объектный пре-чек), 5 (отложка + новый докблок) |
| 2. Единица атомарна (один pending = один batch); пачка — нет и не претендует | 5 (один вызов = один pending), 10 (approve = один batch, тест журнала), 11 (последовательность, сводка) |
| 3. Зависимое — только внутри единицы; зависимостей между единицами нет | 5 (одиночный вызов = одна единица по построению; Р-16 — независимые честно проигрывают stale, тест в 10) |
| 4. Предусловия снимаются при постановке и не переснимаются | 5 (buildUpdate при постановке; approvePending без правок — тест stale) |
| 5. Применённое — `routine`+`run_id`; ответ — ui-запись; патчи флажка — `system` | 10 (тесты атрибуции и undo), 3 (append-ответ без actions) |
| 6. Живой прогон никогда не `undecided`; писатели — close/sweep/процедуры, все `system` | 7 (close+sweep), 8 (гашение), 10 (бухгалтерия) |
| 7. Идемпотентность всех рёбер; другой ответ — `already` с показом | 2 (hash), 3 (ответ), 5/6 (постановка), 10 (решения), 11 (decideAll = N replay'ев) |
| 8. Судьбы — append-only; первая финальна; ответ важнее гашения | 3 (правило под замком), 8 (гашение уважает ответ) |
| 9. Кап единиц; превышение — структурный отказ | 5, 6 (+ константа и промпт 14) |

## Самопроверка плана

- **Покрытие спеки:** ОЧ.1 (без симуляции) — не строится нигде, `pending_confirmation`-ветка
  переиспользована (5); ОЧ.2 → 2; ОЧ.3 → 5/10/11 (единица = один pending, «Принять все»
  последовательно); ОЧ.4 → 4, 5; ОЧ.5 → 1, 6, 14; ОЧ.6 → 1, 7, 8, 10; ОЧ.7 → 9, 13
  («Продолжить сейчас»); ОЧ.8 → 3, 8; ОЧ.9 → 2, 3, 5, 6; ОЧ.10 → 5, 6, 7 (константы),
  14 (промпт); ОЧ.11 → 11, 13; ОЧ.12 → 6 (routineOnly; условие снятия — шов §10.1, не
  строится); ОЧ.13 → 5; §4 (модель данных) → 1, 2, 3; §5 (поток) → 5, 6, 7; §6 → 10, 11,
  13; §7 (UI) → 11, 12, 13; §8 (Ш1) → «Общие работы» + Задачи 2, 8; §15 → 11 (тело §3.3),
  15. «Швы §10» и «Не входит §11» не нарушены: симуляция, групповой глагол, внешний
  исполнитель, правка единицы (`edited_from`), уведомления, таймауты, batch-undo UI,
  классификатор §7.10 — нигде не строятся; тикетный путь и терминальный `orbis_checkpoint`
  не меняются (правится только ОПИСАНИЕ тула в реестре — контракт и поведение прежние).
- **Плейсхолдеры:** «TBD/TODO/позже» нет; тесты в шагах — конкретные сценарии; интерфейсы —
  сигнатуры с типами.
- **Согласованность имён:** `undecided` (1) — используется в 7, 8, 10, 11, 13;
  `askInput`/`AskResult` (1) — в 6; `answerMessageId`/`questionStaleMessageId` (1) — в 2
  (чтение судеб) и 3 (запись судеб); `unitHash`/`askDedupeKey`/
  `deferDedupeKey`/`listRunUnits`/`RunUnit`/`kind`/`text?` (2) — в 3, 5, 6, 7, 8, 9, 10;
  `answerPendingQuestion`/`stalePendingQuestion`/`AnswerQuestionResult` (3) — в 8, 10, 12;
  `MAX_RUN_UNITS`/`deferred_action_card` (5) — в 6 (кап), 9, 12; `question_card`/`runAsk`
  (6) — в 12; `ROUTINE_MAX_STEPS` (7) — только раннер; `DecideDeferredResult`/
  `decideDeferredUnit`/`answerRunQuestion`/`runUnits` (10) — в 11, 12, 13; `decideAllDeferred`/
  `DecideAllItem`/`overview.undecided` (11) — в 13; `QuestionCard`/`DeferredActionCard` (12)
  — в 13; контракты общих работ Ш1 — процитированы в §«Общие работы» и не переопределяются.
- **Правила проекта:** ни одной миграции (обнаружение необходимости = блокер плана);
  мутации только через executor; промпт — новым файлом с фикстурой; пересев до деплоя;
  `bun run test`/lint/typecheck отдельно; коммит `git commit -- <пути>` после каждой задачи;
  русский язык.






