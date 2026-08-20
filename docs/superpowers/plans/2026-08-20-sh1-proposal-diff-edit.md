# Ш1 «Дифф предложения и правка до принятия» — план реализации

> **Для агентных исполнителей:** ОБЯЗАТЕЛЬНЫЙ САБ-СКИЛЛ — `superpowers:subagent-driven-development`
> (рекомендуется) либо `superpowers:executing-plans`. Шаги размечены чекбоксами (`- [ ]`).
> Исполнитель задачи видит ТОЛЬКО свою задачу — каждый бриф самодостаточен, имена и типы
> соседних задач продублированы в блоке «Интерфейсы». Модели: имплементеры и разведка — opus,
> гейт-ревью задачи и финальное ревью ветки — fable; sonnet/haiku не использовать.
> Вместе с брифом имплементеру передаются конспекты разведки
> `.superpowers/sdd/2026-08-20-sh1-proposal-diff-edit/recon-*.md` и `facts.md`.

**Цель:** владелец видит предложение рутины диффом (свёрнутым в карточке, полным на записи),
правит предложенный текст и значения полей прямо в слое предложения и жмёт «Принять» — правка
порождает новое предложение с детерминированным id, исходное гасится причиной `'edited'`,
предусловия не переснимаются, применение остаётся работой прогона и откатывается.

**Архитектура:** ни одной миграции БД — `edited_from` едет optional-полем в `.strict()`-объекте
`proposal` аспекта прогона (пересев реестра) и в не-strict `metadata.pending`. Дифф — новый
ЛИСТОВОЙ модуль `packages/shared/src/doc/diff.ts` (только type-импорты, свой сабпат
`./doc/diff`): сервер считает его для показа в `proposalView`, клиент пересчитывает в режиме
правки. Правка — лестница транзакций в `routines/lifecycle.ts` поверх нового tx-варианта
`rejectPendingTx`; вход `decideProposal` расширяется обязательным `pendingId` и `edits`
(тело — документом, Ш1.11). Запрос «открытые предложения по записи» — containment-проба по
существующему GIN `chat_messages.metadata`. Web: проброс `pendingId` в `ProposalCard`
(данные его уже несут), слой предложения на `DetailScreen` соседним узлом при `noticeHost`,
редактор слоя — через `EditorShell` без `useBodySave` и черновиков.

**Стек:** Bun 1.2.7, Hono, tRPC 11, drizzle-orm/postgres (Supabase Postgres 17), zod + ajv
(реестр аспектов из БД), TipTap 3.30 (`@orbis/shared/doc`), React 19 + TanStack Query,
`bun:test` (server/shared), vitest 4 (web), biome.

**Спека:** `docs/superpowers/specs/2026-08-19-proposal-diff-edit-design.md`, ревизия 2
(`ea58692`): решения Ш1.1–Ш1.11, инварианты 1–9, приёмка 1–18, «Открытые вопросы к
планированию» 1–6 — все закрыты разделом «Развилки» ниже. Фон: ревью
`reviews/2026-08-19-proposal-diff-edit-design-review.md` и ответ
`reviews/2026-08-19-proposal-diff-edit-review-response.md` (противоречить им нельзя); спека V1
`2026-08-18-v1-routines-internal-runner-design.md` — «Уточнения по факту реализации» и рулинги
финального ревью. Предусловие: V1 в проде (main `01f8e81`), хвосты подчищены.

---

## Что установила разведка кода (2026-08-20, main `6f76110`)

Семь читателей (opus) прошли по коду ДО нарезки задач; полные конспекты — в леджере
`.superpowers/sdd/2026-08-20-sh1-proposal-diff-edit/recon-*.md`. Исполнителям: **каждый факт
опровергаем** — проверяй пробоем; в этом цикле ревью уже опровергло 2 из 10 фактов ревизии 1.
HEAD движется параллельными сессиями владельца — перед Задачей 0 перечитать свежий
`git rev-parse`.

### Ответы на открытые вопросы спеки (выход разведки)

1. **Где живёт дифф (вопрос 1) — ЗАМЕРЕНО сборкой.** `packages/shared/src/doc/diff.ts` за
   СВОИМ сабпатом `"./doc/diff"` в `packages/shared/package.json:6-9`, внутри — ни одного
   рантайм-импорта (только `import type { JSONContent }` и `import type { BodyDoc }`).
   Статический импорт такого модуля из чанка DetailScreen стоит **+0.85 кБ gzip**; любое
   рантайм-ребро на `convert.ts` или импорт через баррель `@orbis/shared/doc` — **+156 кБ
   gzip в чанк записи** (замеры вариантов A/B/C/E — `recon-shared-diff-bundle.md`). Сегодня
   чанк `doc-*.js` (155.5 кБ gz) статически импортируют только ленивые `BodyEditor` и
   `MarkdownToggle`; `DetailScreen-*.js` схемы документа не знает. Оба стража СЛЕПЫ к составу
   чанка (проверено прогоном на сломанной сборке: `scripts/check-lazy-chunks.ts:104-106`
   печатает ok, `save.test.tsx:1438-1447` знает фиксированные 8 файлов) — план добавляет
   третью проверку и дописывает файлы слоя в список.
2. **Tx-вариант rejectPending (вопрос 2) — ПРОВЕРЕНО на живой БД.** Форма —
   `rejectPendingTx(tx, args)` (как `createPending`, `pending.ts:116-117`), бросает
   `ExecError`; прежний `rejectPending(db, args)` становится обёрткой `withIdentity` +
   try/catch (`:445-484`) — семь существующих вызывателей не правятся (все вне открытых tx).
   Advisory-замок re-entrant: повторный `pg_advisory_xact_lock` того же ключа в той же tx —
   no-op (одна запись в `pg_locks`), флаг `lockHeld` не нужен; вложенный же `db.transaction`
   берёт ДРУГУЮ коннекцию и самоблокируется до `statement_timeout` (измерено: 2546 мс) —
   отсюда докблок-запрет. `acquirePendingLock` (`pending.ts:294-296`) — приватная, нужен
   экспорт. Возврат дополняется `threadId` (иначе P2 уедет в глобальный тред, `:160`).
3. **hash(edits) (вопрос 3).** `pendingMessageId` ЛОУЭРКЕЙСИТ ключ
   (`packages/shared/src/ids.ts:63-64`) — кодирование хеша обязано быть регистронезависимым:
   **sha256 в lowercase hex**, base64 схлопнул бы разные правки в один PK и
   `appendMessageIdempotent` вернул бы чужую карточку с ответом «applied». Каноническая форма —
   `canonicalJson` (уже есть, `packages/shared/src/aspect-registry.ts:243`) поверх
   нормализованных `edits` (массивы отсортированы по `(index, aspect??'', field)`).
4. **DecideProposalResult (вопрос 4).** Сегодня — union четырёх вариантов, объявлен только на
   сервере (`lifecycle.ts:900-904`), клиент выводит через RouterOutputs. Четыре теста сверяют
   `already`/`rejected` через `toEqual` (`routine.test.ts:473,:549-577`) — расширять НОВЫМ
   вариантом `{status:'replaced'; livePendingId; liveStatus; reason}`, не полем в `already`.
   `pendingId` уже есть и в данных карточки (`propose.ts:266`, `registry.ts:234`,
   `cards/types.ts:75` — теряется в одной строке `renderCards.tsx:111`), и в `ProposalView`
   (`lifecycle.ts:873`). Но обе карточки одного прогона делят кеш `routine.proposal({runId})` —
   карточка P1 не может показать свои операции; и лента треда (`['chatThread', threadId]`)
   после решения никем не инвалидируется — приёмка 9 без явной инвалидации не пройдёт.
5. **Слой на DetailScreen (вопрос 5).** Вкладки «Версии» НЕ СУЩЕСТВУЕТ (версии — карточка
   внутри «Деталей», `DetailScreen.tsx:345`) — предпосылка вопроса опровергнута. Вкладок три
   (`:424-440`), слой кладётся соседним узлом между `noticeHost` (`:410`) и обёрткой Tabs
   (`:420`). Второй редактор БЕЗ `useBodySave` возможен по построению: `BodyEditor`
   контролируемый (`{doc, onChange}`, с `useBodySave` не связан, `BodyEditor.tsx:108-136`),
   черновики пишет только `useBodySave`, фокус не забирается (`focusAt:null`), меню `/` и `@`
   пер-инстансные (`extensions.ts:26-30` — сделано ради нескольких редакторов). Точка
   подвески — через эагерный `EditorShell` (единственный ленивый импортёр `BodyEditor`,
   `EditorShell.tsx:9`). Правленый doc держать в РЕФЕ, дифф пересчитывать по паузе — иначе
   возвращаются замеренные +3 мс на нажатие (`DetailScreen.tsx:566-582`,
   `body-typing.perf.test.tsx`). Текущее тело для клиентского диффа уже на экране
   (`DETAIL_INCLUDE` тянет `body`+`bodyDoc`, `useEntityDetail.ts:28-34`).
6. **Числа Ш1.10 (вопрос 6) — ЗАМЕРЕНО на 99 телах** (прод отдал только счётчики: 42 тела,
   23 без body_doc; корпус — сиды + docs/** + синтетика). Дорога НЕ там, где думала спека:
   Myers на худшем реальном теле — 1.9 мс, а `canonicalizeBody` — 1567–1860 мс (квадратичен
   лексер marked по (байты × топ-блоки)). Потолок обязан быть ДО-разборным (байты + непустые
   строки, 3.3 мс на 128 КБ), потолок по блокам защищает только дешёвое сравнение. Myers при
   D~N+M ПРОИГРЫВАЕТ наивному LCS (584 мс против 155 на N=M=4000) — нужна отсечка по D.
   Порог похожести: Дайс на мультимножестве слов ≥ 0.40 ИЛИ вложение (∩/min) = 1.0 →
   FN 0.04 % / FP 3.42 %; слова — `/[\p{L}\p{N}]+/gu` (одиночные цифры значимы: «18:00»).
   Конкретные константы — Развилки, решение 6.

### Подтверждено (ключевые адреса для брифов)

- **Pending**: `pendingRecord` БЕЗ `.strict()` — намеренно, форвард-совместимость
  (`policy/pending.ts:62-90`; `run_id` `:88`, `actor_grant_id` `:81`) → `edited_from` в
  `metadata.pending` без миграции и бэкфилла. `createPending(tx, args)` принимает tx и выводит
  id из `dedupeKey` (`:116-117`, `:158-159`); «завёл/нашёл» НЕ различает (`:195`) — приём
  различения: предварительный SELECT, как `propose.ts:225-229`. `approvePending` ключует
  `batchId = args.pendingId` (`:372`), `batch_id` из payload игнорирует (`:308-310`), эскалация
  только при `source==='chat'` (`:401-407`). Провод атрибуции pendingRecord → execute → action:
  шесть точек (`pending.ts:81/:88 → :187/:189 → :366/:369 → executor/types.ts:38,:40 →
  :177-178 → executor.ts:443-444, :608-609`) — прецедент для В-1.
- **Причина отказа**: `RejectReason` `pending.ts:246`, zod-enum `:248` (ЕДИНСТВЕННАЯ точка,
  где компилятор молчит), `REJECT_CONTENT` `:251-255`, fallback незнакомой строки к `'owner'`
  `:276`; `STATUS_BY_REJECT_REASON` `lifecycle.ts:1035-1039`. `closeOpenOfRun` типизирован
  `Extract<RejectReason,'superseded'|'stale'>` и пишет `status: reason` напрямую
  (`lifecycle.ts:269`, `:311`) — расширение enum НЕ должно расширить этот Extract.
- **Лестница физически не может быть одной транзакцией**: `execute` открывает собственный
  `withIdentity`-tx (`pending.ts:354`), `patchAspect` идёт через `execute`
  (`lifecycle.ts:183-203`) — правило возобновления обязательная часть работы. Перечитка
  статуса — `runById` (`agent-loop/queries.ts:342-350`) фильтрует `NOT archived` (`:346`).
- **decideProposal**: вход `.strict()` `{runId, decision}` (`routers/routine.ts:202`);
  результат `lifecycle.ts:900-904`; `approveProposal` `:1073-1131`; `bodyMismatch` из
  STALE_VERSION `:1226-1230`; `settleProposal` `:1184-1191` и `closeOpenOfRun` `:309-316`
  пересобирают `proposal` явным списком; ТРЕТЬЕ место пересборки — `runSummary`
  (`agent-loop/queries.ts:396-402`); `storedProposal` `:1286-1290` — проба
  `{pending:{run_id}}` LIMIT 1, единственный вызыватель `proposalView` (`:948`).
- **propose**: payload `{tool:'batch_execute', input:{batch_id, operations}}` (`propose.ts:253,
  :257`), `dedupeKey='proposal:'+runId` (`:181-182`), снятие предусловий по каждому полю патча
  (`:564-571`), `expectedUpdatedAt` только при `body` (`:574-581`), `collides` — правка тела
  единственная операция по своей сущности (`:435-444`, `:451`), потолок 50
  (`routines/constants.ts:15`), `entity_create` без предусловий (`:200-205`), операция хранит
  СЫРОЙ markdown модели (канонизирует executor на применении, `executor.ts:807-816`).
  Fail-closed валидация собранного — приём `propose.ts:586-589`.
- **XOR тела**: `entityUpdateExecInput` — refine, не union (`contracts/tools.ts:137-140`,
  `bodyDocSchema` `:45-48` НЕ экспортирована): замена `body`→`bodyDoc` обязана УДАЛИТЬ ключ
  `body`; гейт `expectedUpdatedAt` накрывает ОБА поля тела (`executor.ts:1206-1219`) — Ш1.11
  совместим с Ш1.6; ветка записи bodyDoc не теряет блочные id (`:1340-1399`, `:1390-1392`).
- **ProposalView**: уже несёт `pendingId` (`lifecycle.ts:873`, из указателя `:952`);
  `operations[]` — `index/tool/entity{id,title}/aspect?/field?/before?/after?/summary`
  (`:839-858`); ключ строки `(index, aspect??'', field??'')` уже реализован на клиенте
  (`:1347`, `ProposalCard.tsx:184`); `updateRows` — тело через общий цикл, after = весь
  markdown, before нет (`:1434-1451`, словарь `CORE_FIELD_LABELS` `:914-921`); на пути показа
  И составления тело записи НЕ читается (`titlesOf` `:1313-1325`, `propose.ts:498`) — Ш1.2
  требует нового чтения.
- **Запрос по записи**: GIN `chat_messages_metadata_gin (jsonb_path_ops)` существует с 0001
  (`0001_rls_and_indexes.sql:123`); прецедент containment с вложенными массивами —
  `escalation.ts:138-157`, EXPLAIN-заметка `rollback.ts:187-190`; `metadata.pending` несёт
  `source` всегда (`pending.ts:184`), у предложений `'routine'` (`propose.ts:250`); ключ `id`
  в операции сохраняется (`propose.ts:576`, `:590`). `entity.*` — protectedProcedure (доступен
  PAT-агенту), `routine.*` — ownerOnly (`routers/entity.ts:203,:225`, `trpc.ts:128-131`).
- **Web-карточка**: `ProposalCard({runId})` (`ProposalCard.tsx:115`), запрос `:118`, решения
  `:238,:245`, `STATUS_NOTES` `:38-42` («Заменено новым прогоном» для superseded),
  расхождение тела уже печатается по признаку `aspect===''&&field==='body'` (`:97-101`);
  RunFeed рисует карточку по аспекту (`RunFeed.tsx:180, :358`); лента треда — ключ
  `['chatThread', threadId]` (`useChatThread.ts:10-12`), `invalidateGraph` — только
  entity.query/get/count (`lib/invalidate.ts:53-60`); `staleTime 30 000` (`trpc.ts:18`).
- **AspectField**: НЕ экспортирован (`AspectCards.tsx:254-295`), `{aspectId, field, value,
  onSave(raw)}`, рендерит `<dt>/<dd>` под грид-`<dl>` (`:132`, `:279-280`), в `AspectCards`
  onSave немедленно мутирует (`:151-157`); `coerce` `:31-35`, `isScalar` `:45-53`,
  `readOnlyText` `:61-68`; `fieldLabel`/`aspectLabel` экспортированы (`field-labels.ts:50-52,
  :93-95`).
- **Редактор**: `sameDoc`/`stripIds`/`UNIQUE_ID_TYPES` — листовой `strip-ids.ts` (`:74`,
  `:21`); `onChange` отдаёт `{v: DOC_SCHEMA_VERSION, doc}` (`BodyEditor.tsx:178-184`);
  транзакцию простановки id отсекает sameDoc в onUpdate (`:180`); черновик — ключ
  `orbis:body-draft:<owner>:<entity>` (`draft-storage.ts:84`), пишет только `useBodySave`;
  тело записи на вкладке «Сущность» keepMounted и живое под `display:none` (`:425`,
  `Tabs.tsx:96`) — его `useBodySave` бампнет `updated_at` кликом (`useBodySave.ts:41`);
  `EditorShell` рисует живые query-виджеты и требует `ThisEntityProvider`
  (`EditorShell.tsx:135, :151-163`, `this-entity.tsx:30`).
- **Схема/пересев/журнал**: `proposal` `.strict()` — `schemas/aspects.ts:234-249`,
  `PROPOSAL_STATUSES` ровно пять (`:210-216`); между правкой схемы и пересевом локально
  краснеют РОВНО `aspect-drift.test.ts` и `seed-aspects.test.ts` (лечение —
  `bun run db:prepare` или `bun scripts/seed-aspects.ts`); CI пересевает сам (`ci.yml:36`) —
  зелёный CI НЕ доказывает пересев на проде. Живое место миграций —
  `apps/server/src/db/migrations` (каталога `apps/server/drizzle` НЕТ); журнал кончается
  idx 13 (`0013_routine_scheduler_rls`), следующий свободный — **0014** (Ш1 миграций не
  требует). pgTAP `plan(46)` не двигается; счётчики тулов 30/31 не двигаются
  (`registry.test.ts:130,:295`). D41 свободен (`04-decision-log.md:405-415`) — сверить при
  мерже. Грамматика не задета (`query/catalog.ts:82-102` читает только верхний уровень).
- **История рутины** — цепочка обещания Ш1.8 «принято с правками» из ПЯТИ мест:
  `contracts/agent-loop.ts:114` → `agent-loop/queries.ts:396-402` →
  `lifecycle.ts:752-763` → `routines/context.ts:40-45` → `historyLine :117-134`
  (+ `PROPOSAL_STATUS_LABEL :75-81` — «заменено новым прогоном» уехало бы в промпт).
- **Конвенции**: `bun run test` из корня (голый `bun test` ЗАВИСАЕТ); обвязка сервера —
  `test/helpers.ts:5-42` (`truncateAll` builtin-реестр не трогает); гонный прецедент —
  `policy/pending.test.ts:330-368` (25 итераций, `Promise.all`, победитель по факту графа);
  web — `renderWithProviders` (`test/harness.tsx:107-135`); caller с инъекцией —
  `routine.test.ts:78-101`.

### Расхождения спеки/дизайна с кодом (и что план с ними делает)

| # | Спека говорит | Код говорит | Решение плана |
|---|---|---|---|
| Р-1 | Вопрос 1: «там уже TipTap», дифф — вопрос границы пакета | TipTap НЕ в первом кадре и не в чанке записи; вес решает не пакет, а рантайм-ребро на `convert.ts` / импорт через баррель: +0.85 кБ против +156 кБ gzip (замер) | Листовой `doc/diff.ts` со своим сабпатом; ребро `convert.ts → diff.ts` (не наоборот); стражи дописать (Задачи 6, 11) |
| Р-2 | Ш1.1: «оба тела через `canonicalizeBody`» | Для клиента в режиме правки это +156 кБ и не нужно: Ш1.11 кладёт в БД сам bodyDoc | Клиентский дифф — по ДЕРЕВЬЯМ (bodyDoc редактора против `entity.bodyDoc`); канонизация — только серверная для markdown (Задачи 6, 7, 11) |
| Р-3 | Ш1.1: единица — «абзац, пункт списка, заголовок, строка таблицы» | listItem/taskItem/tableRow не топ-уровень схемы; не названы rawBlock/queryBlock/codeBlock/blockquote/horizontalRule; голый текст не различает `checked`, `level`, `language` | Явное правило развёртки контейнеров; ключ блока = тип + значимые атрибуты + нормализованный текст (Задача 6) |
| Р-4 | Ш1.10: узкое место — квадратичное сравнение блоков; «Myers, не наивный LCS»; потолок — число блоков | Сравнение — самая дешёвая часть (Myers 1.9 мс против канона 1.6–1.9 с); квадратичен лексер marked; при D~N+M Myers ПРОИГРЫВАЕТ LCS; число блоков известно только ПОСЛЕ дорогого разбора | ДО-разборный сторож (байты + непустые строки) на обе стороны; отсечка Myers по D → `skipped:'rewritten'`; потолок блоков остаётся вторым рубежом (Развилка 6; Задачи 6, 7) |
| Р-5 | Ш1.2: «сервер и так читает тело, чтобы снять предусловия» | На пути показа и составления body НЕ читается (`titlesOf`, `propose.ts:498`) | Новое чтение `body_doc`/`body`/`updated_at` целей body-операций в `proposalView` (Задача 7) |
| Р-6 | Ш1.3: «карточка получает свой pendingId» — как новая работа | `pendingId` уже в данных карточки и в ProposalView; теряется в одной строке `renderCards.tsx:111` | Проброс пропа + ветка рендера; без сервера, миграций, бэкфилла (Задача 9) |
| Р-7 | Ш1.3/приёмка 9: карточки P1 и P2 различимы сверкой pendingId | Обе делят кеш `routine.proposal({runId})` — оба получат view P2; карточка P1 показала бы ЧУЖИЕ операции | Ветка «заменено правкой владельца» рисует подпись и ссылку БЕЗ списка операций (Задача 9) |
| Р-8 | Приёмка 9: обе карточки в ленте треда | Лента (`['chatThread', threadId]`) после `decideProposal` никем не инвалидируется; staleTime 30 с | Явная инвалидация треда из onSuccess карточки; `threadId` — из `ctx.msg` (`renderCards.tsx:98-99`) (Задача 9) |
| Р-9 | Ш1.5: причины `'edited'` со своим текстом ленты достаточно | Подпись решённой карточки берётся из СТАТУСА (`STATUS_NOTES`: superseded → «Заменено новым прогоном»); то же в `PROPOSAL_STATUS_LABEL` уедет в промпт следующего прогона | `ProposalView.editedFrom` + вывод подписей из него; `historyLine` — «принято с правками» (Задачи 1, 5, 9) |
| Р-10 | Ш1.5: правило возобновления — только «decideProposal по P1» | Симметричный случай не покрыт: адресован P2, указатель ещё на P1 → «replaced → мёртвый P1», круг; `closeOpenOfRun` по мёртвому P1 с чужой причиной `'edited'` выходит БЕЗ записи — новый прогон оставит живого сироту P2 | Правило достраивается обеими половинами + самолечение в `closeOpenOfRun` (поиск дитяти по `edited_from`) (Задача 5) |
| Р-11 | «Замок первым statement'ом транзакции» | Первые два statement'а ставит `withIdentity` (`with-identity.ts:22-23`); замок третий | Контракт переформулирован: «замок до первого чтения состояния этого pendingId, не отпускать до коммита»; докблоки — в этой формулировке (Задача 2) |
| Р-12 | Вопрос 3: канонизация = порядок ключей + каноническая форма bodyDoc | Условия неполны: `pendingMessageId` лоуэркейсит ключ (`ids.ts:63-64`) | Хеш — sha256 lowercase hex; плюс сортировка массивов `edits` (Развилка 3; Задача 3) |
| Р-13 | Ш1.11: «операция меняет форму body → bodyDoc (XOR-схема допускает)» | XOR — refine, не union: оба ключа сосуществовать не могут; провал вылез бы у владельца на кнопке (executor `parseEnvelope`) | Сборка P2 УДАЛЯЕТ ключ `body`; каждая операция — fail-closed `safeParse` при сборке (Задача 3) |
| Р-14 | Инвариант 2: «набор precondition ПОБАЙТНО равен исходному» | jsonb нормализует порядок ключей объектов (проба на живой БД) — «побайтно» против присланного моделью не определено | Сравнение `canonicalJson`-формами, обе стороны из одного jsonb-представления (Задача 3) |
| Р-15 | Вопрос 5: «как плашка уживается с вкладкой „Версии“» | Вкладки «Версии» НЕТ — версии карточкой внутри «Деталей»; вкладок три | Слой — соседний узел между `noticeHost` и Tabs; с вкладками не взаимодействует (Задача 10) |
| Р-16 | Ш1.4: «значения полей — формой из AspectCards» | `AspectCards` непереиспользуем: привязан к `useEntityUpdate(entity.id)`, `AspectField` не экспортирован, рендерит `<dt>/<dd>` под конкретный грид, onSave немедленно мутирует | Экспорт/вынос `AspectField` + `coerce` + `isScalar` + `readOnlyText`; в слое onSave кладёт в буфер `edits`, не мутирует (Задача 10) |
| Р-17 | Ш1.3: проба `{pending:{input:{operations:[{input:{id}}]}}}` с отсевом по статусу прогона | Голая проба ловит чат-подтверждения и мёртвый P1 (его сообщение тоже содержит операции, а прогон снова pending — по P2) | + `source:'routine'` в пробу; + условие «`proposal.pending_id` прогона = id сообщения» (Задача 8) |
| Р-18 | Слой поверх записи; спека молчит о живом теле под ним | Вкладка «Сущность» keepMounted — `useBodySave` тела жив под слоем; клик в тело бампнет `updated_at` → предложение stale | Развёрнутый слой скрывает `EntityBody` классом (не размонтирует — flush не дёргается, клики невозможны) (Задача 10) |
| Р-19 | Ш1.8: «оба места, пересобирающие proposal» (settle, closeOpen); «в историю едет одно поле» | Мест ТРИ (`runSummary`); цепочка «принято с правками» — пять мест в трёх пакетах | Задача 1 протаскивает все три + всю цепочку истории |
| Р-20 | Ш1.5: `decideProposal` принимает `pendingId` | Обязательный `pendingId` на `.strict()`-входе ломает 13 вызовов серверного теста, два web-пина `toEqual` и старые вкладки PWA (immutable-кеш) до перезагрузки | Принято ценой: pendingId ОБЯЗАТЕЛЕН («принимаю то, что вижу» — обязательство сервера, Б2); тесты и клиент правятся той же задачей; старая вкладка получает громкий VALIDATION, не тихое применение чужого (Задача 4) |
| Р-21 | Адреса ревизии 2 (`pending.ts:243`, `:287-296`, `:361-366`, `:367-371`, `lifecycle.ts:1286-1289`, `propose.ts:555-567` и др.) | Съехали на 2–6 строк, всегда внутрь той же функции/докблока (точные — выше в «Подтверждено») | Только адреса; выводы спеки верны. Брифам цитировать диапазоны |

## Развилки

### Решения плана (владелец может отменить, но план под них написан)

1. **Дифф** (вопрос 1): `packages/shared/src/doc/diff.ts`, листовой (только type-импорты;
   листовость проверяется тестом и `verbatimModuleSyntax`), сабпат `"./doc/diff"` третьей
   строкой exports. Извлечение текста блока (`blockText`, правило `writtenText`:
   `node.text` + `rawBlock.attrs.markdown` + `queryBlock.attrs.query`) живёт в `diff.ts`,
   `convert.ts` ИМПОРТИРУЕТ его оттуда — двух копий предиката не заводим (урок
   `convert.ts:196-198`). Отдельный пакет отвергнут: вес решает ребро, не граница пакета.
2. **rejectPendingTx** (вопрос 2): `rejectPendingTx(tx, args)` бросает `ExecError`; замок
   берёт сам (re-entrant, no-op при внешнем захвате); `rejectPending(db, args)` — обёртка с
   прежним поведением; возврат обоих — `{pendingId, alreadyRejected, reason, threadId}`;
   экспорт `acquirePendingLock`; докблок-запрет «`rejectPending(db)` изнутри открытой tx =
   самоблокировка до statement_timeout».
3. **hash(edits)** (вопрос 3): `editsHash = sha256hex(canonicalJson(normalize(edits)))`,
   lowercase hex; `normalize` сортирует `body` по `index`, `fields` по
   `(index, aspect??'', field)` — порядок массивов во входе не меняет личность правки;
   `dedupeKey = 'edit:' + P1 + ':' + editsHash` → `pendingId(P2) = pendingMessageId(owner,
   dedupeKey)`.
4. **DecideProposalResult** (вопрос 4): пятый вариант
   `{status:'replaced'; livePendingId: string; liveStatus: ProposalStatus; reason: RejectReason}`
   (имя `replaced`, не `edited` — обслуживает и гашение новым прогоном); `applied` получает
   `editedFrom?: string`; `already`/`rejected`/`stale` не меняются (кроме `stale.pendingId?`).
   Вход: `pendingId` ОБЯЗАТЕЛЕН, `edits` — только при `approve`. Новый ProposalStatus
   `'edited'` НЕ заводится: судьба P1 — причина в reject-сообщении, признак на живом — поле
   `edited_from`.
5. **Слой** (вопрос 5): соседний узел между `noticeHost` и Tabs; редактор — через
   `EditorShell` без `useBodySave`/черновиков; правленый doc в рефе, клиентский дифф по паузе
   400 мс; развёрнутый слой скрывает `EntityBody` классом; слой оборачивается
   `ThisEntityProvider` (query-блоки предложенного текста исполняются — чтение, принято);
   deep-link `?proposal=` — шов, не строится (точка подвески: `nav/links.ts:38-85`,
   `navigation.ts:16-24`, `router.tsx:179-180`).
6. **Числа** (вопрос 6), константы `routines/constants.ts` + дефолты `diff.ts`:
   `PROPOSAL_DIFF_MAX_BODY_BYTES = 65536`, `PROPOSAL_DIFF_MAX_SOURCE_LINES = 400` (до-разборные,
   обе стороны), `PROPOSAL_DIFF_MAX_BLOCKS = 1000` (единиц развёртки; 1.8× максимума корпуса),
   `PROPOSAL_DIFF_MAX_EDIT_RATIO = 0.3` (бюджет D Myers; сверх → `skipped:'rewritten'`),
   `PROPOSAL_DIFF_MAX_BLOCK_WORDS = 400` (внутриблочный дифф только для пар короче),
   `PROPOSAL_DIFF_SIMILARITY = 0.4` (Дайс) + правило вложения (∩/min = 1.0), окно спаривания
   ±2, тип узла в ключе спаривания обязан совпадать (taskItem ≠ listItem: чеклист →
   маркированный список = замена). Числа выведены из корпуса репозитория и синтетики, НЕ из
   пользовательских тел (живых больших тел не существует) — двигаются правкой констант.
7. **Кеш серверного диффа не строится**: открытых предложений ≤ 1 на рутину (V1.8), дифф
   считается только для `pending` по запросу карточки/слоя; до-разборные потолки защищают
   худший случай. Бэкфилл `body_doc` на проде НЕ предусловие (потолки применяются и к
   «было») — вопрос В-3.
8. **Старые вкладки PWA**: обязательный `pendingId` означает, что вкладка, открытая до
   деплоя, на «Принять» получит VALIDATION до перезагрузки. Принято: громкий отказ безопаснее
   тихого применения чужого предложения (Б2).
9. **Ответ `replaced` при чужом pendingId до лестницы**: `reason` берётся из
   `rejectedReason(адресованного)` ?? `'superseded'`.
10. **Свёрнутый дифф в карточке**: счётчики (+добавлено/−удалено/~изменено) и до трёх первых
    не-`same` блоков; дальше — «открыть запись». Полный дифф — только на записи (Ш1.3).
11. **P2 в треде рутины**: `threadId` для `createPending(P2)` берётся из возврата
    `rejectPendingTx(P1)` (тред P1 и есть тред рутины) — `ensureEntityThread` не зовётся.
12. **`edits` пуст и `pendingId` совпал** — путь ровно сегодняшний (ни P2, ни лестницы);
    клиент не шлёт `edits.body`, если `sameDoc(edited, proposed)` (снятие блочных id).

### Вопросы владельцу — план написан под ответ «по умолчанию»

- **В-1** (задан спекой). `edited_from` в самом action журнала §7.8. **По умолчанию — нести**
  (рекомендация контроллёра и ревью совпала): Задача 5, шаги 6–7 (pendingRecord → execute →
  ActionRecord, шесть точек по прецеденту `run_id`). При ответе «нет» — эти шаги вычеркнуть,
  остальное не меняется.
- **В-2** (задан спекой). Кнопка «применить как свою правку» после `stale`. **По умолчанию —
  не входит**; план её нигде не строит. При ответе «да» — отдельная задача после Задачи 10
  (источник `ui`, свежий снимок, путь мимо прогона — потребует своего дизайн-абзаца).
- **В-3** (новый). Прогнать ли `bun scripts/ops.ts backfill-body-doc` на проде перед деплоем
  Ш1: 23 из 42 тел без `body_doc` платят полную цену `parseBody` на каждый показ диффа
  (сегодняшние тела крошечные — цена мала). **По умолчанию — нет**: потолки применяются к
  обеим сторонам, план от бэкфилла не зависит. При «да» — шаг в Задаче 13 перед деплоем.

## Глобальные ограничения

- **Ветка `sh1-proposal-edit` от свежего `origin/main`, работа только в worktree**
  (`.claude/worktrees/sh1-proposal-edit`); основное дерево не трогать (владелец пушит
  параллельно); свой `bun install`; абсолютные пути — только внутрь worktree; параллельные
  имплементеры в одном дереве запрещены.
- **Ни одной миграции БД.** Если вдруг понадобится — номер **0014**, живое место
  `apps/server/src/db/migrations` (каталога `apps/server/drizzle` не существует), запись в
  `meta/_journal.json` руками. pgTAP `plan(46)` не двигается.
- **Пересев реестра аспектов** — СРАЗУ после правки `schemas/aspects.ts` в Задаче 1
  (`bun run db:prepare` или `DATABASE_URL_ADMIN=… bun scripts/seed-aspects.ts`), иначе красные
  `aspect-drift.test.ts` и `seed-aspects.test.ts` — это НЕ твоя поломка. На проде — пересев
  ДО деплоя кода (Задача 13); зелёный CI пересев на проде НЕ доказывает (`ci.yml:36`).
- **Причина `'edited'` едет ОДНОЙ задачей с первым писателем** (Задача 5): enum + zod-enum +
  `REJECT_CONTENT` + `STATUS_BY_REJECT_REASON` — не размазывать по двум мержам (fallback
  `:276` молча превратит правку в «владелец отклонил»).
- **Мутации графа — только через executor**; лестница собирает pending и зовёт
  `approvePending`/`patchAspect`; собственных INSERT/UPDATE в `entities` нет. Прямые записи —
  только сообщения тредов (`createPending`, `rejectPendingTx`).
- **Листовость `diff.ts`** — закон: только `import type`; никакой импорт из `./convert`,
  `./schema`, `@tiptap/*` значением. Проверяется тестом листовости (Задача 6) и стражами web
  (Задача 11). Правило `useBodySave.ts:28-34` наследуется: упоминание `@orbis/shared/doc`
  (без `/diff`) — только в каталоге `features/entity-editor`.
- **TDD.** Полный прогон — `bun run test` из корня (голый `bun test` ЗАВИСАЕТ); один серверный
  файл — `cd apps/server && bun test src/<путь>` (нужны `DATABASE_URL`, `DATABASE_URL_ADMIN`,
  `bunx supabase start`); web — `cd apps/web && bunx vitest run <путь>`; `bun run lint` и
  `bun run typecheck` — отдельными вызовами. Серверные сьюты делят БД (`truncateAll`) — не
  гонять два прогона одновременно. Перф-гейт web флачит под нагрузкой — коды возврата снимать
  на незанятой машине.
- **Счётчики не двигаются**: тулов не добавляется (реестр 30/31, MCP самосчётный), tRPC-
  процедуры счётчиков не имеют.
- **Язык кода, комментариев, ошибок, коммитов — русский; комментарий объясняет «почему».**
- **Коммит после каждой задачи** — `git commit -- <пути>`; в сообщении
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`. Мерж в `main` (ff-only) и пуш после
  закрытия задачи (гейт-ревью fable + зелёный CI) — постоянное распоряжение владельца.
  Протокол: `git fetch` → rebase на чистом дереве до диспатча следующего имплементера → push
  ветки → CI → ff-push в `main`.
- **Имплементеру передаются** `facts.md` и нужные `recon-*.md` из леджера
  `.superpowers/sdd/2026-08-20-sh1-proposal-diff-edit/`, не только бриф.

## Карта файлов

| Область | Создать | Изменить |
|---|---|---|
| shared | `packages/shared/src/doc/diff.ts`, `doc/diff.test.ts` | `packages/shared/package.json` (exports `./doc/diff`), `src/doc/convert.ts` (writtenText → импорт из diff), `src/schemas/aspects.ts` (+`edited_from`), `schemas/aspects.test.ts`, `src/contracts/tools.ts` (экспорт `bodyDocSchema`), `src/contracts/agent-loop.ts` (RunSummary `proposal.edited_from?`), `src/aspect-registry.ts` (экспорт `canonicalJson`, если приватна) |
| policy | — | `apps/server/src/policy/pending.ts` (`rejectPendingTx`, экспорт `acquirePendingLock`, `RejectReason 'edited'`, `REJECT_CONTENT`, `pendingRecord.edited_from`), `pending.test.ts` |
| routines | `apps/server/src/routines/edits.ts`, `edits.test.ts` | `routines/lifecycle.ts` (`storedProposal` по id, `DecideProposalResult`, лестница, `STATUS_BY_REJECT_REASON`, `closeOpenOfRun` самолечение, `proposalView` дифф + `proposedDoc` + `bodyChanged`, `openProposalsForEntity`), `routines/constants.ts` (`PROPOSAL_DIFF_*`), `routines/context.ts` (`historyLine`, `PROPOSAL_STATUS_LABEL`), `lifecycle.test.ts`, `context.test.ts` |
| agent-loop | — | `apps/server/src/agent-loop/queries.ts` (`runSummary` +`edited_from`), `queries.test.ts` |
| executor (В-1) | — | `apps/server/src/executor/types.ts` (`ExecuteRequest.editedFrom?`, `ActionRecord.edited_from?`), `executor.ts` (две точки сборки action) |
| tRPC | — | `apps/server/src/routers/routine.ts` (вход `decideProposal`, `proposalsForEntity`), `routine.test.ts` |
| tools | — | `apps/server/src/tools/registry.ts:232-239` (union `proposal_card` +`editedFrom?`) |
| web-карточка | — | `features/chat/cards/renderCards.tsx`, `ProposalCard.tsx`, `useChatThread.ts` (экспорт ключа), `cards.test.tsx`, `features/entity-detail/RunFeed.tsx` |
| web-слой | `features/entity-detail/ProposalOverlay.tsx` | `features/entity-detail/DetailScreen.tsx`, `AspectCards.tsx` (экспорт `AspectField`/`coerce`/`isScalar`/`readOnlyText`), `detail.test.tsx`, `features/entity-editor/save.test.tsx` (список файлов), `scripts/check-lazy-chunks.ts` (третья проверка) |
| docs | `docs/superpowers/plans/2026-08-20-sh1-proposal-diff-edit.md` (этот файл) | `docs/prd/02-core-os.md` §3.5, `01-architecture.md` (:410, §9.3 :1179, §7.10 :1008), `04-decision-log.md` (D41 — номер сверить при мерже), `docs/implementation/02-ops-runbook.md` (чек-лист деплоя Ш1) |

## Порядок и параллельность

```
Веха A (серверный низ):    0 → 1 → { 2 ‖ 3 ‖ 6 } → 4 → 5
Веха B (дифф и запросы):   6 (‖ с 2/3) → 7 → 8
Веха C (web):              9 → 10 → 11   (старт — после 4: форма DecideProposalResult зафиксирована; 9 требует 5, 7)
Веха D (документы, деплой): 12 → 13
```
`‖` — только в отдельных worktree по непересекающимся файлам (2: `policy/pending.ts`;
3: `routines/edits.ts` + `contracts/tools.ts` + `aspect-registry.ts`; 6: `doc/*` +
`package.json` shared). Всё остальное — строго последовательно (общие файлы: `lifecycle.ts`,
`routine.ts`, `ProposalCard.tsx`, `DetailScreen.tsx`).

---

### Задача 0: Подготовка дерева и базовая линия

**Файлы:** — (git/worktree, леджер `.superpowers/sdd/2026-08-20-sh1-proposal-diff-edit/`)

- [ ] **Шаг 1:** из основного дерева: `git fetch origin && git worktree add -b sh1-proposal-edit
  .claude/worktrees/sh1-proposal-edit origin/main`. Зафиксировать хеш `origin/main` (ожидается
  `6f76110` или новее — ветка движется параллельными сессиями).
- [ ] **Шаг 2:** в новом дереве `bun install`; `bunx supabase status` (поднят); в
  `apps/server/.env` есть `DATABASE_URL` и `DATABASE_URL_ADMIN`.
- [ ] **Шаг 3:** `bun run db:prepare`, затем `bun run test`, `bun run lint`,
  `bun run typecheck` — код возврата 0 на незанятой машине. Базовые счётчики сьютов — в
  `.superpowers/sdd/2026-08-20-sh1-proposal-diff-edit/progress.md` (создать; там же завести
  `facts.md` для рулингов по ходу).
- [ ] **Шаг 4:** коммитов нет.

---

### Задача 1: `edited_from` сквозь схему, судьбу и историю прогона

Реализует Ш1.8 (оба-места-плюс-третье) и половину инварианта 7. Поле появляется в реестре и
ПРОТАСКИВАЕТСЯ всеми пересборщиками объекта `proposal` до того, как появится первый писатель
(Задача 5): забытое протаскивание — молчаливый отрыв цепочки, тип его не ловит
(`patchAspect` принимает `Record<string, unknown>`, `lifecycle.ts:177`).

**Файлы:**
- Изменить: `packages/shared/src/schemas/aspects.ts:234-249` (+`edited_from` в объект
  `proposal` после `mismatches`), `packages/shared/src/contracts/agent-loop.ts:114`
  (`RunSummary.proposal` +`edited_from?`), `apps/server/src/routines/lifecycle.ts:1184-1191`
  (`settleProposal`) и `:309-316` (`closeOpenOfRun`), `apps/server/src/agent-loop/queries.ts:396-402`
  (`runSummary`), `apps/server/src/routines/context.ts:117-134` (`historyLine`), `:40-45`
  (`RoutineHistoryItem`, если поле не выводится из RunSummary)
- Тесты: `packages/shared/src/schemas/aspects.test.ts:299-338`, `apps/server/src/routines/lifecycle.test.ts`,
  `apps/server/src/agent-loop/queries.test.ts`, `apps/server/src/routines/context.test.ts`

**Интерфейсы (produces):**
```ts
// schemas/aspects.ts — внутрь .strict()-объекта proposal (:234-249):
edited_from: z.string().uuid().optional(), // id ИСХОДНОГО pending, если предложение рождено правкой владельца (Ш1.8)
// contracts/agent-loop.ts — RunSummary.proposal += edited_from?: string
// routines/context.ts — historyLine: у прогона с proposal.status==='approved' && proposal.edited_from
//   строка истории дополняется «(принято с правками владельца)»
```
- [ ] **Шаг 1: правка схемы + НЕМЕДЛЕННЫЙ пересев** (`bun run db:prepare`) — до пересева
  красные `aspect-drift.test.ts` и `seed-aspects.test.ts`, это ожидаемо и НЕ твоя поломка.
- [ ] **Шаг 2: падающие тесты**
```ts
// aspects.test.ts: proposal с edited_from: uuid — валиден; edited_from: 'не-uuid' — отвергнут; без поля — валиден (старые прогоны живут)
// lifecycle.test.ts:
test('settleProposal сохраняет edited_from при пометке approved и stale', async () => { /* подложить patchAspect'ом proposal {pending_id, status:'pending', edited_from}; прогнать settleProposal; перечитать аспект — edited_from на месте */ });
test('closeOpenOfRun сохраняет edited_from при гашении superseded', async () => { /* аналогично через закрытие открытого */ });
// queries.test.ts: runSummary отдаёт proposal.edited_from, когда поле есть в аспекте
// context.test.ts: historyLine прогона approved+edited_from содержит «принято с правками»; без поля — прежняя строка байт-в-байт
```
- [ ] **Шаг 3:** FAIL → реализация (в обоих CAS-пересборщиках — `...(prior.edited_from !== undefined && { edited_from: prior.edited_from })`,
  по образцу существующих optional-полей). — [ ] **Шаг 4:** PASS, `bun run test`,
  `bun run typecheck`; коммит `feat(routines): edited_from в аспекте прогона, судьбе и истории (Ш1.8)`.

---

### Задача 2: `rejectPendingTx` — гашение в чужой транзакции

Реализует открытый вопрос 2 (Развилка 2) — фундамент шага 1 лестницы Ш1.5. Причину `'edited'`
НЕ вводит (она едет с первым писателем, Задача 5).

**Файлы:**
- Изменить: `apps/server/src/policy/pending.ts` (`acquirePendingLock` :294-296 — экспорт +
  докблок в формулировке Р-11; `rejectPending` :440-490 — распил на `rejectPendingTx(tx, …)`
  и обёртку)
- Тесты: `apps/server/src/policy/pending.test.ts`

**Интерфейсы (produces):**
```ts
export async function acquirePendingLock(tx: Tx, pendingId: string): Promise<void>;
// докблок: «замок до ПЕРВОГО чтения состояния этого pendingId; не отпускается до конца tx;
// повторный захват того же ключа в той же tx — no-op (advisory xact-замок re-entrant)»
export interface RejectPendingResult { pendingId: string; alreadyRejected: boolean; reason: RejectReason; threadId: string }
export async function rejectPendingTx(tx: Tx, args: { ownerId: string; pendingId: string; reason?: RejectReason }): Promise<RejectPendingResult>;
// бросает ExecError как сегодняшнее тело; замок берёт сам; identity tx обязана совпадать с ownerId (докблок, как у createPending)
export async function rejectPending(db: Db, args: { ownerId: string; pendingId: string; reason?: RejectReason }): Promise<RejectPendingResult>;
// обёртка: withIdentity + try/catch снаружи (:445-484 как было) → семь вызывателей не правятся;
// ДОКБЛОК-ЗАПРЕТ: «изнутри открытой транзакции НЕ звать — вложенный db.transaction берёт другую
// коннекцию и самоблокируется на advisory-замке до statement_timeout (измерено 2546 мс); только rejectPendingTx»
```
  `threadId` — из уже читаемого `findPendingMessage` (`:234`); нужен Задаче 5, чтобы P2 лёг в
  тред рутины (Развилка 11).
- [ ] **Шаг 1: падающие тесты** — `pending.test.ts`:
```ts
test('rejectPendingTx в чужой withIdentity-tx: гасит и пишет reject-сообщение той же транзакцией — искусственный rollback снаружи откатывает и гашение', async () => { /* withIdentity: rejectPendingTx + throw; после — pending всё ещё жив */ });
test('повторный acquirePendingLock того же pendingId в той же tx не блокирует (re-entrant)', async () => { /* withIdentity: замок, затем rejectPendingTx (берёт замок сам) — завершилось без таймаута */ });
test('rejectPendingTx возвращает threadId треда pending-сообщения', async () => { /* createPending с явным threadId → reject → threadId совпал */ });
test('обёртка rejectPending ведёт себя как раньше: alreadyRejected с ИСХОДНОЙ причиной, прежние тексты', async () => { /* существующие тесты :456-512 остаются зелёными без правок — прогнать */ });
```
- [ ] **Шаг 2:** FAIL → **Шаг 3:** реализация (перенос тела :447-481 в `rejectPendingTx`
  целиком: замок → `findPendingMessage` → проверка «уже исполнено» по `batchAuditMessageId`
  → `rejectedReason` → `appendMessageIdempotent`; эскалации в reject нет — не переносится).
- [ ] **Шаг 4:** PASS, `bun run test`, `bun run typecheck`; коммит
  `feat(policy): tx-вариант rejectPending для лестницы правки (Ш1.5, вопрос 2)`.

---

### Задача 3: Контракт `edits`, хеш и сборка payload P2 (чистые функции)

Реализует Ш1.4 (гранулярность «операция + аспект + поле»), Ш1.11 (тело документом) и
Развилку 3 (hash) как ЧИСТЫЕ функции без БД — их полностью покрывают unit-тесты, а Задача 5
только вызывает.

**Файлы:**
- Создать: `apps/server/src/routines/edits.ts`, `apps/server/src/routines/edits.test.ts`
- Изменить: `packages/shared/src/contracts/tools.ts:45-48` (экспорт `bodyDocSchema` — вторую
  модель дерева заводить запрещено комментарием `:35-38`),
  `packages/shared/src/aspect-registry.ts:243` (экспорт `canonicalJson`, если ещё приватна)

**Интерфейсы (produces):**
```ts
// routines/edits.ts
export const editsSchema = z.object({
  body: z.array(z.object({ index: z.number().int().min(0), bodyDoc: bodyDocSchema }).strict()).max(50).default([]),
  fields: z.array(z.object({
    index: z.number().int().min(0), aspect: z.string().min(1).optional(),
    field: z.string().min(1), value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
  }).strict()).max(200).default([]),
}).strict();                                  // скалярный union у value — граница Ш1.4 в контракте
export type ProposalEdits = z.infer<typeof editsSchema>;
export function isEmptyEdits(edits: ProposalEdits): boolean;
export function editsHash(edits: ProposalEdits): string;   // sha256 LOWERCASE HEX от canonicalJson
// нормализации: body сорт по index; fields сорт по (index, aspect??'', field) — порядок массивов
// во входе не меняет личность правки; hex обязателен: pendingMessageId лоуэркейсит ключ (ids.ts:63-64)
export function buildEditedOperations(operations: unknown[], edits: ProposalEdits): unknown[];
// бросает ExecError('VALIDATION', …, { reason }):
//   'edit_index_out_of_range' — index вне payload;
//   'edit_key_missing'       — (aspect?, field) нет в исходной операции: у аспектных — ключа в op.input.aspects[aspect],
//                              у core — поля из словаря CORE_FIELD_LABELS (lifecycle.ts:914-921) нет в op.input;
//   'edit_body_missing'      — body-правка там, где body не было (запись без CAS — Б3);
//   'edit_duplicate'         — два edits на один ключ (index, aspect??'', field) или два body на один index
```
  Сборка: body-правка кладёт `bodyDoc` и **УДАЛЯЕТ ключ `body`** (XOR — refine
  `contracts/tools.ts:139`), `expectedUpdatedAt` ПЕРЕНОСИТСЯ как есть (Ш1.6,
  `propose.ts:574-581`); field-правка меняет ровно значение; `precondition` каждой операции
  копируется без изменений. Пост-условия (инварианты 2, 3) проверяются в самой функции и
  дублируются тестами: `operations.length` равен; множество ключей `(index, aspect??'',
  field)` равно исходному; `canonicalJson(precondition)` равен исходному (сравнение
  канон-формами — jsonb нормализует порядок ключей, «побайтно» против присланного не
  определено, Р-14); каждая собранная операция проходит
  `entityUpdateExecInput.safeParse` fail-closed (приём `propose.ts:586-589`).
- [ ] **Шаг 1: падающие тесты** — `edits.test.ts` (всё без БД):
```ts
test('правка тела: body → bodyDoc, ключ body удалён, expectedUpdatedAt и precondition нетронуты, safeParse проходит', …);
test('правка поля аспекта и core-поля меняет ровно значение; остальное байт-в-байт', …);
test('новый ключ поля → VALIDATION edit_key_missing (Б3: запись без предусловия)', …);
test('body-правка в операции без body → VALIDATION edit_body_missing; index мимо → edit_index_out_of_range; дубль → edit_duplicate', …);
test('editsHash: перестановка элементов fields не меняет хеш; другая правка — другой хеш; формат /^[0-9a-f]{64}$/', …);
test('isEmptyEdits: {body:[],fields:[]} — пусто', …);
```
- [ ] **Шаг 2:** FAIL → **Шаг 3:** реализация (`node:crypto` createHash; `canonicalJson` из
  shared). — [ ] **Шаг 4:** PASS, `bun run test`, `bun run typecheck`; коммит
  `feat(routines): контракт edits, детерминированный хеш и сборка правленого payload (Ш1.4, Ш1.11)`.

---

### Задача 4: `decideProposal` адресуется `pendingId`; ответ `replaced`

Реализует адресацию Ш1.5 («принимаю то, что вижу» — обязательство сервера) и фиксирует форму
`DecideProposalResult` (Развилка 4) — после мержа этой задачи можно стартовать веху C.
Перевод `storedProposal` на `pending_id` (Б4) — здесь же.

**Файлы:**
- Изменить: `apps/server/src/routers/routine.ts:201-214` (вход), `apps/server/src/routines/lifecycle.ts:900-904`
  (union), `:995-1006` (сверка), `:1286-1290` (`storedProposal` → проба `{pending:{id}}`,
  форма `findPendingMessage` `pending.ts:216-222`; вызыватель один — `:948`),
  `apps/web/src/features/chat/cards/ProposalCard.tsx:238,:245` (клиент шлёт `view.pendingId` —
  он уже в кеше карточки `:118`)
- Тесты: `apps/server/src/routers/routine.test.ts` (13 вызовов `:461-773` — добавить
  `pendingId`), `apps/web/src/features/chat/cards/cards.test.tsx:1018-1021`,
  `apps/web/src/features/entity-detail/detail.test.tsx:3830-3833` (пины `toEqual` формы вызова)

**Интерфейсы (produces):**
```ts
// routers/routine.ts — вход:
z.object({ runId: z.string().uuid(), pendingId: z.string().uuid(), decision: z.enum(['approve','reject']) }).strict()
// (edits добавит Задача 5 — сюда же, отдельным полем)
// lifecycle.ts:
export type DecideProposalResult =
  | { status: 'applied';  actionId: string; editedFrom?: string }
  | { status: 'stale';    mismatches: PreconditionMismatch[]; pendingId?: string }
  | { status: 'rejected' }
  | { status: 'already';  proposalStatus: ProposalStatus }                      // НЕ менять: toEqual-пины
  | { status: 'replaced'; livePendingId: string; liveStatus: ProposalStatus; reason: RejectReason };
```
  Сверка: `args.pendingId !== run.proposal.pending_id` → `replaced` с живым
  (`reason: rejectedReason(адресованного) ?? 'superseded'` — Развилка 9). Совпал — прежний
  путь без изменений.
- [ ] **Шаг 1: падающие тесты** — `routine.test.ts`:
```ts
test('decideProposal с чужим pendingId → replaced {livePendingId: живой, liveStatus: pending, reason}; граф не тронут', …);
test('совпавший pendingId — все прежние исходы байт-в-байт (approve/reject/already/stale)', /* правка 13 вызовов: pendingId из view */);
test('storedProposal читает payload по pending_id: подложить ВТОРОЕ pending-сообщение с тем же run_id — view показывает операции того, на кого указывает прогон', …);
```
  Web: пины `toEqual({runId, decision})` → `toEqual({runId, pendingId:'p1', decision})`;
  фикстуры уже несут `pendingId:'p1'` (`cards.test.tsx:806-820`).
- [ ] **Шаг 2:** FAIL → **Шаг 3:** реализация. — [ ] **Шаг 4:** PASS, `bun run test` (сервер
  и web), `bun run typecheck`; коммит
  `feat(routines): decideProposal по pendingId, ответ replaced, storedProposal по pending_id (Ш1.5, Б2, Б4)`.
  Цена решения 8 (старые вкладки PWA получают VALIDATION до перезагрузки) — записать в
  `facts.md`.

---

### Задача 5: Причина `'edited'` и лестница правки

Ядро Ш1.5 + Ш1.9 + Ш1.6 + Ш1.7: правка порождает P2 детерминированным id, P1 гаснет причиной
`'edited'` в ТОЙ ЖЕ транзакции, указатель переезжает CAS'ом, применение — прежний конвейер;
правило возобновления — обе половины; `closeOpenOfRun` самолечится. Здесь же — В-1 (по
умолчанию: нести `edited_from` в action журнала).

**Файлы:**
- Изменить: `apps/server/src/policy/pending.ts:246,:248` (`RejectReason` + `'edited'`; zod-enum
  — ЕДИНСТВЕННОЕ место без компиляторной страховки, не забыть), `:251-255` (`REJECT_CONTENT`
  + `'edited'` → «Предложение заменено правкой владельца»), `:62-90` (`pendingRecord` +
  `edited_from?: uuid`), `:352-378` (`approvePending` передаёт `editedFrom` в execute — В-1);
  `apps/server/src/routines/lifecycle.ts:1035-1039` (`STATUS_BY_REJECT_REASON` + `'edited'` →
  `'superseded'`; `Extract` в `closeOpenOfRun` `:269` НЕ расширять), `:995-1131` (лестница в
  `decideProposal`/`approveProposal`), `:278-316` (`closeOpenOfRun` самолечение);
  `apps/server/src/routines/context.ts:75-81` (`PROPOSAL_STATUS_LABEL` — superseded у прогона
  с `edited_from` формулируется «заменено правкой владельца»); В-1:
  `apps/server/src/executor/types.ts:38,:40,:177-178` (`ExecuteRequest.editedFrom?`,
  `ActionRecord.edited_from?` — условная запись, никогда null), `executor.ts:443-444,:608-609`
  (две точки сборки action); `apps/server/src/routers/routine.ts` (вход + `edits: editsSchema.optional()`);
  `apps/server/src/tools/registry.ts:232-239` и `apps/web/src/features/chat/cards/types.ts:73-80`
  (union карточки `proposal_card` +`editedFrom?: string` — Ш1.8 п.2, рендер — Задача 9)
- Тесты: `pending.test.ts`, `lifecycle.test.ts`, `routine.test.ts`

**Интерфейсы (consumes):** `rejectPendingTx`/`acquirePendingLock`/`RejectPendingResult`
(Задача 2), `editsSchema`/`editsHash`/`buildEditedOperations`/`isEmptyEdits` (Задача 3),
`DecideProposalResult.replaced` (Задача 4), `edited_from` протащен пересборщиками (Задача 1).

**Лестница** (P1 — адресованное, P2 — правленое; `edits` непуст и `decision==='approve'`;
пустые `edits` — путь ровно сегодняшний, Развилка 12; `edits` при `reject` → VALIDATION):
1. **Один tx** (`withIdentity`): `acquirePendingLock(P1)` → `findPendingMessage(P1)` →
   перечитка `runById(runId)` (фильтрует NOT archived → null трактовать как «прогон в
   архиве» → `already`). Случаи:
   - указатель на P1, P1 жив → `rejectPendingTx(P1, 'edited')` **и**
     `createPending(tx, { threadId: <из rejectPendingTx>, actor: { userId, kind:'ai',
     source:'routine', runId, editedFrom: P1 }, tool:'batch_execute',
     input:{ batch_id: P2id, operations: buildEditedOperations(…) },
     level:'explicit-confirmation', dedupeKey:'edit:'+P1+':'+editsHash(edits),
     card: proposal_card {runId, pendingId: P2id, editedFrom: P1, summary} }` — тем же tx.
     Атомарность закрывает сироту P2, потерю правок и гонку двух правок разом (Ш1.5);
   - P1 уже отклонён причиной `'edited'` → ветка возобновления (ниже);
   - P1 решён иначе / указатель на чужом id → `already`/`replaced` (Задача 4).
2. **Шаг 2**: `patchAspect` CAS на весь объект `proposal` → `{pending_id: P2, status:
   'pending', edited_from: P1}` (пересборка как `settleProposal`; отдельная транзакция —
   `execute` вкладываться не умеет, `pending.ts:354`).
3. **Шаг 3**: `approvePending(P2)` — прежний конвейер, ревалидация, `batchId = P2`
   (`pending.ts:372` берёт `args.pendingId`, `batch_id` payload игнорирует).
4. **Шаг 4**: `settleProposal` по исходу (`approved` → `applied {actionId, editedFrom: P1}` |
   `stale {mismatches, pendingId: P2}` — P2 гаснет `stale`, расхождения в аспект).
**Правило возобновления** (крэш-окно шаг 1 → шаг 2; ОБЕ половины, Р-10):
- адресован P1, он отклонён `'edited'` → найти дитя containment-пробой
  `{pending:{edited_from: P1}}` (дитя ЕДИНСТВЕННО by-construction: гонку за P1 выигрывает
  один, шаг 1 атомарен — докблок); довести шаг 2; если
  `pendingMessageId(owner,'edit:'+P1+':'+editsHash(edits)) === childId` — идемпотентно
  довести шаги 3–4 (replay двойного тапа); иначе → `replaced {livePendingId: child, …,
  reason:'edited'}`;
- адресован P2 (== дитя), а указатель прогона ещё на P1 → довести шаг 2 и продолжить как
  «совпавший» (иначе ответ `replaced → мёртвый P1` замыкает круг).
**`closeOpenOfRun` самолечение** (гашение новым прогоном): `rejectPendingTx(указатель)` дал
`alreadyRejected` с чужой причиной `'edited'` → найти дитя по `edited_from`, гасить ЕГО и
писать статус по нему (`edited_from` в пересборке сохранить — Задача 1); иначе новый прогон
оставил бы живого сироту P2 (Р-10).
- [ ] **Шаг 1: падающие тесты причины** — `pending.test.ts`:
```ts
test('rejectPendingTx reason edited: текст «Предложение заменено правкой владельца», metadata.reason=edited; rejectedReason возвращает edited (НЕ fallback owner)', …);
```
- [ ] **Шаг 2: падающие тесты лестницы** — `lifecycle.test.ts` / `routine.test.ts`:
```ts
test('правка тела и поля + approve: в записи ровно присланный bodyDoc (включая блок кода и ссылку с подписью — потери сериализации Ш1.11 не воспроизводятся) и правленое значение; P1 rejected edited; указатель на P2; статус approved; edited_from на прогоне; действия source=routine с run_id; action.edited_from=P1 (В-1)', /* приёмки 5, 6, 9 */);
test('replay: тот же edits дважды → один батч (журнал), второй ответ applied идемпотентно (приёмка 14)', …);
test('гонка двух РАЗНЫХ правок: 25 итераций Promise.all — ровно один applied, второй replaced с живым, сирот-P2 нет (прецедент pending.test.ts:330-368; приёмка 15, инвариант 5)', …);
test('крэш-окно: состояние «шаг 1 без шага 2» руками (rejectPendingTx+createPending в tx) → decideProposal по P1 с тем же hash доводит и применяет; с другим hash → replaced на дитя; по P2 → самолечение шага 2 и применяет (Р-10)', …);
test('closeOpenOfRun по состоянию «указатель на мёртвом P1» гасит дитя P2 и пишет статус по нему (приёмка 13: «решено без тебя»)', …);
test('правка + разошедшееся предусловие → stale с mismatches, P2 гашен stale, правки не применены (Ш1.6, приёмка 12)', …);
test('VALIDATION на шаге 3 (NaN от сырой формы) → P2 жив pending, указатель на P2 — владелец правит и жмёт ещё раз (цена §7.10)', …);
test('пустые edits + совпавший pendingId → сегодняшний путь: нового pending НЕТ (приёмка 7)', …);
test('reject правленого P2 → rejected, граф не тронут', …);
test('откат прогона после принятия правленого инвертирует батч P2 (source=routine+run_id под ROUTINE_POLICY.own; приёмка 11); undo_last снимает батч P2, а не пометку (приёмка 10)', …);
```
- [ ] **Шаг 3:** FAIL → реализация (порядок: причина → pendingRecord.edited_from → лестница →
  возобновление → closeOpenOfRun → В-1-провод шестью точками по прецеденту `run_id`).
- [ ] **Шаг 4:** PASS, `bun run test`, `bun run lint`, `bun run typecheck`; коммит
  `feat(routines): лестница правки предложения — причина edited, детерминированный P2, правило возобновления (Ш1.5, Ш1.9)`.
  При ответе «нет» на В-1 — вычеркнуть шаги про `ExecuteRequest.editedFrom`/`ActionRecord`
  (две точки executor + передача из approvePending), остальное без изменений.

---

### Задача 6: `doc/diff.ts` — листовой блочный дифф со словами

Реализует Ш1.1 (блочный дифф с внутриблочным сравнением) и Ш1.10 в форме Развилок 1 и 6.
Может идти ПАРАЛЛЕЛЬНО Задачам 2–3 (отдельный worktree, файлы не пересекаются).

**Файлы:**
- Создать: `packages/shared/src/doc/diff.ts`, `packages/shared/src/doc/diff.test.ts`
- Изменить: `packages/shared/package.json:6-9` (+`"./doc/diff": "./src/doc/diff.ts"` — без
  этой строки импорт не разрешится ни vite, ни tsc: `moduleResolution: "bundler"`),
  `packages/shared/src/doc/convert.ts:413-423` (`writtenText` → импорт `blockText` из
  `./diff`; ребро convert → diff безопасно, diff листовой; обратное ребро ЗАПРЕЩЕНО)

**Интерфейсы (produces):**
```ts
// diff.ts — ЛИСТОВОЙ модуль: рантайм-импортов НЕТ; только
//   import type { JSONContent } from '@tiptap/core'; import type { BodyDoc } from './types';
// (verbatimModuleSyntax заставит писать import type — листовость проверяет компилятор и тест ниже)
export interface DiffPart { kind: 'same' | 'added' | 'removed'; text: string }
export interface DiffUnit { kind: 'same' | 'added' | 'removed' | 'changed'; before?: string; after?: string; parts?: DiffPart[] }
export type BodyDiffSkipReason = 'too_large' | 'rewritten';
export type BodyDiffResult = { units: DiffUnit[] } | { skipped: BodyDiffSkipReason };
export interface DiffLimits { maxBlocks: number; maxBlockWords: number; maxEditRatio: number }
export const DIFF_LIMITS_DEFAULT: DiffLimits; // {maxBlocks: 1000, maxBlockWords: 400, maxEditRatio: 0.3} — Развилка 6
export function diffBodyDocs(before: JSONContent, after: JSONContent, limits?: Partial<DiffLimits>): BodyDiffResult;
export interface FlatBlock { kind: string; key: string; text: string }
export function flattenBlocks(doc: JSONContent): FlatBlock[];
export function blockText(node: JSONContent): string; // правило writtenText: node.text + rawBlock.attrs.markdown + queryBlock.attrs.query; ссылка не берётся (кеш заголовка)
```
  **Правило развёртки** (Р-3): спуск в `bulletList`/`orderedList`/`taskList` (единица —
  `listItem`/`taskItem`), `table` (единица — `tableRow`), `blockquote` (спуск в блоки);
  листья — `paragraph`, `heading`, `codeBlock`, `rawBlock`, `queryBlock`, `horizontalRule`.
  **Ключ блока** = `kind` + значимые атрибуты (`heading.level`, `taskItem.checked`,
  `codeBlock.language`) + нормализованный текст (trim + схлопнутые пробелы): щелчок чекбоксом
  при том же тексте — `changed`, не `same`. **Сопоставление**: Myers O(ND) по ключам с
  бюджетом `D ≤ maxEditRatio·(N+M)`; сверх бюджета → `{skipped:'rewritten'}` (при D~N+M Myers
  проигрывает наивному — Р-4; «перегенерируй план целиком» — рядовой ход рутины).
  **Спаривание** removed/added в `changed` (Ш1.10): внутри одной замены, кандидаты по
  смещению d ∈ [0, +1, −1, +2, −2], тип узла обязан совпасть (taskItem ≠ listItem —
  Развилка 6), лучший по Дайсу на мультимножестве слов; принятие — Дайс ≥ 0.4 ИЛИ вложение
  (∩/min) = 1.0 (ловит дописанный хвост: «Спорт» → «Спорт — заменить на бассейн», Дайс 0.25
  при вложении 1.0). **Слова** — `/[\p{L}\p{N}]+/gu` (одиночные цифры значимы: «18:00»;
  сознательное отличие от `WORD_RE` `convert.ts:186` — задокументировать в коде).
  **Внутриблочный дифф** — LCS по словам, только для спаренных пар с обеими сторонами ≤
  `maxBlockWords`; сверх — блок целиком `changed` без `parts`.
- [ ] **Шаг 1: падающие тесты** — `diff.test.ts`:
```ts
test('перенос «10:00 → 14:00» в пункте: changed с parts [removed 10:00, added 14:00, same хвост] (приёмка 4)', …);
test('вставка пункта НАД изменённым: окно спаривания находит пару, вставка — added (замер: сосед даёт Дайс 0.118, пара — 0.889)', …);
test('перестановка блоков → removed+added (известная граница спеки)', …);
test('чекбокс checked при том же тексте → changed; heading level 2→3 → changed; кодовый блок сменил language → changed', …);
test('дописанный хвост к короткому блоку: вложение 1.0 спаривает («Спорт» → «Спорт — заменить…»)', …);
test('чеклист переписан маркированным списком → замена (типы не спариваются)', …);
test('полная перезапись: D сверх бюджета → skipped rewritten; блоков сверх maxBlocks → skipped too_large', …);
test('same-тела → все same; пустые/horizontalRule/queryBlock/rawBlock единицы не теряются', …);
test('листовость: исходник diff.ts не содержит рантайм-импортов (только import type) и не упоминает ./convert|./schema', /* чтение файла — приём save.test.tsx */);
test('convert.ts использует blockText из diff (писаный текст один на всех — losesWord-урок)', /* существующие тесты convert идут зелёными */);
```
- [ ] **Шаг 2:** FAIL → **Шаг 3:** реализация (Myers ~70 строк — готовых дифф-библиотек в
  дереве нет, `bun.lock` проверен). — [ ] **Шаг 4:** PASS (`cd packages/shared && bun test src/doc`),
  `bun run test`, `bun run typecheck`; коммит
  `feat(shared): листовой блочный дифф тела с внутриблочным сравнением (Ш1.1, Ш1.10)`.

---

### Задача 7: Серверный дифф в `proposalView`

Реализует Ш1.2 (показ считает сервер) и серверную половину Ш1.1 (пометка «тело изменилось
после составления», дифф только для `pending`); инвариант 1а.

**Файлы:**
- Изменить: `apps/server/src/routines/lifecycle.ts` (`proposalView` :934-963, `updateRows`
  :1434-1451, `titlesOf` :1313-1325 — или соседнее чтение тел), `apps/server/src/routines/constants.ts`
  (+`PROPOSAL_DIFF_MAX_BODY_BYTES = 65536`, `PROPOSAL_DIFF_MAX_SOURCE_LINES = 400`)
- Тесты: `apps/server/src/routines/lifecycle.test.ts`, `apps/server/src/routers/routine.test.ts`

**Интерфейсы (produces; consumes — `diffBodyDocs`/`DiffUnit`/`BodyDiffResult` из Задачи 6):**
```ts
// ProposalOperationView — строка тела дополняется:
bodyDiff?: { units: DiffUnit[] } | { skipped: 'body_changed' | 'too_large' | 'rewritten' };
proposedDoc?: BodyDoc;   // канон предложенного тела — редактору слоя (Задача 11); только при status==='pending'
// after (полный markdown) ОСТАЁТСЯ — запасная форма показа при skipped (приёмка 16)
```
  Логика (только `status === 'pending'` — Ш1.1; для решённых поле отсутствует): для операции
  с `body` ИЛИ `bodyDoc` (правленое P2): (1) `updated_at` записи ≠ `expectedUpdatedAt`
  операции → `{skipped:'body_changed'}` — дифф против нового тела нарисовал бы согласие там,
  где «Принять» ответит отказом; (2) ДО-разборный сторож на ОБЕ стороны: байты > 64 КБ или
  непустых строк > 400 → `{skipped:'too_large'}` (сторож стоит 3.3 мс на 128 КБ; сам разбор —
  до секунд: квадратичен лексер marked — Р-4); (3) «до» — `readBodyDoc(entity)`
  (`convert.ts:570-582`; без body_doc — parseBody полной ценой, потолок уже защитил);
  «после» — `canonicalizeBody(markdown)` для P1 или сам `bodyDoc` для P2 (канонизировать не
  надо — Ш1.11); (4) `diffBodyDocs`. Тела целей body-операций читаются НОВЫМ запросом
  (`titlesOf` не расширять слепо — телá нужны только строкам тела; Р-5).
- [ ] **Шаг 1: падающие тесты**:
```ts
test('строка тела pending-предложения несёт bodyDiff.units и proposedDoc; изменённый блок — changed с parts (приёмки 1, 4)', …);
test('ИНВАРИАНТ 1а: канон применённого тела равен after-стороне серверного диффа — approve и сверка flattenBlocks(readBodyDoc(тела записи)) с after-склейкой units', …);
test('тело записи тронуто после составления → bodyDiff {skipped: body_changed}, диффа нет (приёмка 12, С1)', …);
test('тело сверх потолка (байты/строки) → {skipped: too_large}, after-форма на месте, кнопки живы (приёмка 16)', …);
test('решённое предложение — bodyDiff и proposedDoc отсутствуют (Ш1.1: дифф только для pending)', …);
test('правленое P2: после-сторона — присланный bodyDoc без канонизации (Ш1.11)', …);
```
- [ ] **Шаг 2:** FAIL → **Шаг 3:** реализация. — [ ] **Шаг 4:** PASS, `bun run test`,
  `bun run typecheck`; коммит `feat(routines): серверный дифф тела в proposalView с потолками и пометкой устаревания (Ш1.1, Ш1.2)`.

---

### Задача 8: `routine.proposalsForEntity` — открытые предложения по записи

Реализует запрос Ш1.3 (форма — containment-проба; ответ — СПИСОК: две рутины могут трогать
одну запись).

**Файлы:**
- Изменить: `apps/server/src/routines/lifecycle.ts` (+`openProposalsForEntity` рядом с
  `proposalView` :934), `apps/server/src/routers/routine.ts` (+процедура; ownerOnly — как весь
  `routine.*`: `entity.*` — protectedProcedure и утёк бы PAT-агенту, `trpc.ts:128-131`)
- Тесты: `apps/server/src/routers/routine.test.ts`

**Интерфейсы (produces):**
```ts
// routers/routine.ts:
proposalsForEntity: ownerOnly.input(z.object({ entityId: z.string().uuid() }).strict())
  .query(…): Promise<ProposalView[]>   // отсортированы по created_at сообщения; обычно 0–1
```
  Проба (Р-17): `metadata @> ${probe}::jsonb` где
  `probe = {pending: {source: 'routine', input: {operations: [{input: {id: entityId}}]}}}`
  — сырой `tx.execute(sql…)` под `withIdentity` (RLS); GIN `jsonb_path_ops` существует с 0001
  (`0001_rls_and_indexes.sql:123`), прецедент вложенных массивов — `escalation.ts:138-157`.
  `source:'routine'` отсекает чат-подтверждения. Для каждого сообщения: прогон по
  `metadata.pending.run_id` → живость: прогон не в архиве, `proposal.status === 'pending'`
  **и** `proposal.pending_id === chat_messages.id` (третье условие обязательно: после
  лестницы мёртвый P1 тоже содержит операции по записи при снова-pending прогоне). Сборка
  ответа — существующий `proposalView` по runId.
- [ ] **Шаг 1: падающие тесты**:
```ts
test('две рутины с открытыми предложениями по одной записи → обе, решение по каждому своё (приёмка 18)', …);
test('чат-подтверждение (source=chat) по той же записи НЕ попадает; решённое/архивный прогон НЕ попадает', …);
test('после правки: мёртвый P1 не попадает, живой P2 попадает (условие pending_id = id сообщения)', …);
test('предложение из нескольких записей находится по каждой из них (приёмка 17)', …);
```
- [ ] **Шаг 2:** FAIL → **Шаг 3:** реализация; в леджер `facts.md` — EXPLAIN пробы на
  локальной БД (ожидание: Bitmap Index Scan по `chat_messages_metadata_gin`; эмпирика этой
  формы в этом цикле не снималась — прецедент `rollback.ts:187-190`).
- [ ] **Шаг 4:** PASS, `bun run test`, `bun run typecheck`; коммит
  `feat(routines): запрос открытых предложений по записи (Ш1.3)`.

---

### Задача 9: Карточка — сверка `pendingId`, «заменено правкой владельца», свёрнутый дифф, живая лента

Реализует Ш1.3 (карточка — сводка; различение исходного и правленого) и клиентскую половину
инвариантов 6 и 8. Старт — после Задач 5 и 7 (форма ответов зафиксирована и реализована).

**Файлы:**
- Изменить: `apps/web/src/features/chat/cards/renderCards.tsx:111` (проброс
  `pendingId={card.pendingId}` — данные его УЖЕ несут, Р-6), `ProposalCard.tsx`
  (проп, ветки, дифф, инвалидация), `apps/web/src/features/chat/useChatThread.ts` (экспорт
  ключа ленты), `apps/web/src/features/entity-detail/RunFeed.tsx:358` (передать `pendingId`
  из `run.proposal` — прочитан на `:180`)
- Тесты: `apps/web/src/features/chat/cards/cards.test.tsx`

**Интерфейсы (produces):**
```ts
// ProposalCard.tsx:
export function ProposalCard({ runId, pendingId }: { runId: string; pendingId?: string });
// useChatThread.ts:
export const chatThreadKey = (threadId: string) => ['chatThread', threadId] as const; // существующий ключ :10-12, теперь экспортом
```
  Ветки рендера: (а) `pendingId` задан и ≠ `view.pendingId` → решённая карточка БЕЗ списка
  операций (кеш `routine.proposal({runId})` один на обе — список показал бы ЧУЖИЕ операции,
  Р-7): `view.editedFrom === pendingId` → «Заменено правкой владельца» + подпись «живое
  предложение ниже»; иначе → прежняя подпись гашения; кнопок нет (инвариант 6); (б) совпал →
  живое как сегодня; при `view.editedFrom` — пометка «правка владельца, исходное выше»
  (инвариант 8) и после решения «Принято (с правками)»; (в) свёрнутый дифф (Развилка 10): по
  `bodyDiff.units` — счётчики `+N −M ~K` и до трёх первых не-`same` блоков, «открыть запись»
  дальше; `skipped` → прежняя after-форма с пометками: `body_changed` → «Тело изменилось
  после составления», `too_large` → «Слишком большое тело — дифф не построен», `rewritten` →
  «Тело переписано целиком — дифф не построен»; (г) ответ `replaced` от `decideProposal` →
  подпись «Заменено правкой владельца — живое предложение обновлено» + `refetch()` (приёмка
  15: молча не проигрывает никто); (д) `onSuccess` решения: `invalidateGraph(utils)` +
  `queryClient.invalidateQueries({queryKey: chatThreadKey(threadId)})` — `threadId` из
  `ctx.msg` (`renderCards.tsx:98-99`); без этого карточка P2 не появится в ленте до смены
  вкладки (Р-8, приёмка 9); (е) строка записи в перечне операций — переход на запись
  (существующая навигация по entity id; приёмка 2).
- [ ] **Шаг 1: падающие тесты** — `cards.test.tsx` (фикстуры уже несут `pendingId:'p1'`
  `:806-820`):
```ts
test('карточка с pendingId≠view: «Заменено правкой владельца» (view.editedFrom совпал), БЕЗ операций и кнопок (приёмка 9, инвариант 6)', …);
test('живая карточка с view.editedFrom: пометка правки; после approve — «Принято (с правками)» (инвариант 8)', …);
test('свёрнутый дифф: счётчики и ≤3 блоков; skipped body_changed/too_large — прежняя форма с пометкой (приёмки 1, 12, 16)', …);
test('ответ replaced → подпись + refetch; onSuccess решения инвалидирует chatThreadKey (приёмки 9, 15)', …);
```
- [ ] **Шаг 2:** FAIL → **Шаг 3:** реализация. — [ ] **Шаг 4:** PASS
  (`cd apps/web && bunx vitest run src/features/chat/cards/cards.test.tsx`), `bun run test`,
  `bun run typecheck`; коммит `feat(web): карточка предложения — сверка pendingId, подписи правки, свёрнутый дифф, живая лента (Ш1.3)`.

---

### Задача 10: Слой предложения на DetailScreen — плашка, дифф, поля, кнопки

Реализует Ш1.3 (слой — не вкладка) и Ш1.4 в части полей. Режим правки тела — Задача 11.

**Файлы:**
- Создать: `apps/web/src/features/entity-detail/ProposalOverlay.tsx`
- Изменить: `apps/web/src/features/entity-detail/DetailScreen.tsx` (узел-сосед между
  `noticeHost` `:410` и обёрткой Tabs `:420` — НЕ в noticeHost: порядок двух порталов в один
  узел не определён; запрос предложений; скрытие тела), `AspectCards.tsx` (экспорт
  `AspectField` `:254-295`, `coerce` `:31-35`, `isScalar` `:45-53`, `readOnlyText` `:61-68`,
  `FIELD_CLASS` `:26-27`)
- Тесты: `apps/web/src/features/entity-detail/detail.test.tsx`

**Интерфейсы (produces; consumes — `proposalsForEntity` (Задача 8), `DecideProposalResult`
(Задачи 4–5), `bodyDiff`/`proposedDoc` (Задача 7), `AspectField {aspectId, field, value,
onSave(raw)}`):**
```ts
export function ProposalOverlay({ entity }: { entity: DetailEntity }): JSX.Element | null;
// внутри: trpc.routine.proposalsForEntity.useQuery({entityId: entity.id});
// onOverlayExpanded(open: boolean) → DetailScreen прячет обёртку EntityBody классом hidden
```
  Содержимое: по КАЖДОМУ предложению списка (две рутины — две плашки, выбор одной скрыл бы
  вторую; приёмка 18) — плашка «Предложение рутины „…“ — N правок»; разворот: дифф тела по
  `bodyDiff.units` (полный — это запись, не лента; `skipped` — as Задача 9), строки правок
  полей (`before` из снятого предусловия — view отдаёт готовым; правка значения —
  `AspectField` с `onSave`, кладущим в БУФЕР `edits.fields`, НЕ мутирующим — в `AspectCards`
  onSave мутирует немедленно, Р-16; нескалярные — `readOnlyText`, как на записи), кнопки
  «Принять»/«Отклонить» → `decideProposal({runId, pendingId, decision, edits})`; исходы:
  `applied` → инвалидация graph + сворачивание; `stale` → расхождения списком (готовый
  рендер mismatches — образец `ProposalCard.tsx:149-154`); `replaced` → подпись + перечитка
  списка. Развёрнутый слой: обёртка `ThisEntityProvider` (Развилка 5) и скрытие `EntityBody`
  классом — тело под слоем живое (keepMounted), случайный клик бампнул бы `updated_at` и
  сделал предложение stale (Р-18); скрытие классом, НЕ размонтирование — flush черновика не
  дёргается.
- [ ] **Шаг 1: падающие тесты** — `detail.test.tsx` (мок `routine.proposalsForEntity` в
  handler — образец `runHandler` `:2904-2918`):
```ts
test('обычное открытие записи с открытым предложением → плашка «Предложение рутины…» (приёмка 3)', …);
test('разворот: дифф тела блоками, поля строками before→after, кнопки; тело записи скрыто; сворачивание возвращает (приёмка 2)', …);
test('правка значения поля в строке → edits.fields в вызове decideProposal; применяется правленое (приёмка 6 — мок-ассерт входа)', …);
test('два предложения двух рутин → две плашки, решение по каждому своё (приёмка 18)', …);
test('skipped body_changed → пометка «тело изменилось после составления» вместо диффа (приёмка 12)', …);
test('запись без предложений → ни плашки, ни лишнего запроса маунта тела (приёмка 7 не задета)', …);
```
- [ ] **Шаг 2:** FAIL → **Шаг 3:** реализация. — [ ] **Шаг 4:** PASS
  (`bunx vitest run src/features/entity-detail/detail.test.tsx`), `bun run test`,
  `bun run typecheck`; коммит `feat(web): слой предложения на записи — плашка, дифф, правка полей, кнопки (Ш1.3, Ш1.4)`.

---

### Задача 11: Режим правки тела — редактор без `useBodySave`, клиентский дифф, стражи веса

Реализует Ш1.4 (тело правится редактором от ПРЕДЛОЖЕННОГО текста), клиентскую половину Ш1.2
и инвариант 1б; закрывает слепоту стражей (Р-1).

**Файлы:**
- Изменить: `apps/web/src/features/entity-detail/ProposalOverlay.tsx` (редактор),
  `apps/web/src/features/entity-editor/save.test.tsx:1438-1447` (+`ProposalOverlay.tsx` в
  список стража — он фиксированный и нетранзитивный, без этого регресс молчалив),
  `scripts/check-lazy-chunks.ts` (третья проверка состава: `DetailScreen-*.js` не импортирует
  `doc-*.js` — grep по dist; сегодня стражи проверяют только НАЛИЧИЕ файлов и печатают ok на
  сломанной сборке — замерено)
- Тесты: `apps/web/src/features/entity-detail/detail.test.tsx`

**Интерфейсы (consumes):** `EditorShell {doc, markdown, onChange}` (эагерный, единственный
ленивый импортёр BodyEditor — `EditorShell.tsx:9`; свой lazy на BodyEditor НЕ заводить: путь
сборкой не проверен), `sameDoc`/`stripIds` (`strip-ids.ts:74`), `diffBodyDocs` из
`@orbis/shared/doc/diff` (листовой: статический импорт из чанка DetailScreen стоит +0.85 кБ
gzip — замерено; импорт `@orbis/shared/doc` БЕЗ `/diff` из файлов слоя запрещён),
`proposedDoc` из view (Задача 7), `editsSchema.body` (Задачи 3, 5).

Механика: кнопка «Править» → `EditorShell` с `doc = proposedDoc` (личность стабильна —
`useMemo`; иначе эффект приезда `BodyEditor.tsx:227-263` гоняет sameDoc всего документа на
каждый штрих — замеренные +3 мс), БЕЗ `useBodySave` и черновиков (автосохранение записало бы
предложенный текст в запись и предложение само сделало бы себя stale — С8); правленый doc —
в РЕФЕ (приём `shownDocRef` `DetailScreen.tsx:575-582`), клиентский дифф — по паузе 400 мс:
`diffBodyDocs(asBodyDoc(entity.bodyDoc).doc, editedRef.current.doc)` (текущее тело уже на
экране — `DETAIL_INCLUDE`, второй сети нет); при `skipped body_changed` от сервера — редактор
без диффа, пометка (Ш1.1). «Принять»: `sameDoc(edited, proposedDoc)` → правки тела НЕТ (не
слать `edits.body` — иначе P2 плодился бы на каждое открытие редактора, Развилка 12); иначе
`edits.body = [{index, bodyDoc: edited}]` — документ редактора КАК ЕСТЬ, с блочными id
(исполнитель пишет их не теряя — `executor.ts:1390-1392`).
- [ ] **Шаг 1: падающие тесты** — `detail.test.tsx`:
```ts
test('открыть редактор слоя и уйти без «Принять»: НИ ОДНОЙ мутации в журнале вызовов, updated_at не сдвинут, нового предложения нет (приёмка 8)', /* renderWithProviders.calls пуст по entity.update/decideProposal */);
test('правка в редакторе + «Принять» → decideProposal с edits.body[0].bodyDoc === документ редактора (приёмка 5 — мок-ассерт; серверная половина — Задача 5)', …);
test('открыл редактор, ничего не менял, «Принять» → edits.body ПУСТ (sameDoc-гейт)', …);
test('клиентский дифф обновился после паузы ввода (fake timers), не на каждый штрих', …);
```
- [ ] **Шаг 2:** FAIL → **Шаг 3:** реализация. — [ ] **Шаг 4: сборка и стражи** —
  `bun run --filter @orbis/web build && bun scripts/check-lazy-chunks.ts` (включая НОВУЮ
  третью проверку; tsc/vitest молчат про состав чанков — только сборка ловит); размер
  `DetailScreen-*.js` до/после — в `facts.md` (ожидание: ≤ +3 кБ raw). PASS, `bun run test`,
  `bun run lint`, `bun run typecheck`; коммит
  `feat(web): правка предложенного тела в слое — редактор без автосохранения, клиентский дифф, стражи состава чанков (Ш1.2, Ш1.4)`.

---

### Задача 12: Документы к факту — PRD, D41, runbook

**Файлы:**
- Изменить: `docs/prd/02-core-os.md` §3.5 (:468-478 — блок «слой предложения» на экране
  записи: плашка, дифф, правка до принятия, предложений может быть несколько; :476/:478 —
  карточка-сводка, подписи «заменено правкой владельца», различение исходного и правленого),
  `docs/prd/01-architecture.md` (:410 — таблица полей `orbis/agent-run`: +`edited_from` в
  `proposal`, иначе единственный документ с перечнем полей противоречит реестру; §9.3 :1179 —
  булет «Предложение и его судьба»: правка до принятия; §7.10 :1008 — одно
  предложение-оговорка: «правка владельца порождает НОВЫЙ провалидированный pending с
  детерминированным id; каждый payload по-прежнему неизменяем»), `docs/prd/04-decision-log.md`
  (D41 — формулировка из спеки, раздел «Правки PRD»; НОМЕР СВЕРИТЬ ПРИ МЕРЖЕ — журнал правится
  параллельными сессиями, на 6f76110 свободен), `docs/implementation/02-ops-runbook.md`
  (чек-лист «Деплой Ш1»: пересев ДО кода, без миграций), спека Ш1 (раздел «Проверено по
  коду» — пометка о съехавших адресах не нужна, спека не переписывается; сверить «Правки PRD»)
- [ ] **Шаг 1:** правки по списку. — [ ] **Шаг 2:** `bun run test` (тела сидов не тронуты —
  байт-в-байт тест `onboarding.test.ts:195-213` зелёный). — [ ] **Шаг 3:** коммит
  `docs(prd): слой предложения, правка до принятия, D41, чек-лист деплоя Ш1`.

---

### Задача 13: Живой смоук по приёмке 1–18 и деплой

**Файлы:** — (стенд, прод)

- [ ] **Шаг 1: локальный стенд** — `bunx supabase start`, сервер с
  `ORBIS_LLM_PROVIDER=anthropic` (или scripted-прогон), живая рутина с телом «План дня».
- [ ] **Шаг 2: приёмка 1–18 по номерам спеки** (провал любого пункта — стоп, починка в
  задаче-владельце, повтор): 1 — свёрнутый дифф в карточке; 2 — тап по записи → слой; 3 —
  плашка при обычном открытии; 4 — «10:00» зачёркнуто, «14:00» добавлено; 5 — правка текста +
  «Принять» → ровно документ редактора (проверить блок кода и ссылку с подписью — потери
  Ш1.11); 6 — правка значения поля; 7 — принятие без правок, нового pending нет; 8 — уход без
  «Принять»: `updated_at` не сдвинут; 9 — исходное «заменено правкой владельца» без кнопок,
  новое «принято»; 10 — «отмени последнее» возвращает граф; 11 — откат прогона инвертирует;
  12 — расхождение графа → «устарело» с расхождениями; правка тела → пометка вместо диффа;
  13 — новый прогон погасил во время правки → «решено без тебя»; 14 — двойное «Принять» —
  одно применение; 15 — две вкладки с разными правками: одна применяется, вторая — «заменено»
  с указанием живого; 16 — тело сверх потолка → прежняя форма, кнопки работают; 17 —
  предложение из нескольких записей; 18 — две рутины по одной записи.
- [ ] **Шаг 3: деплой** (миграций НЕТ; порядок из-за `.strict()`-схемы — пересев ДО кода):
  1. `bun scripts/ops.ts ping` → `check`; 2. `bun scripts/ops.ts seed-aspects` (реестр с
  `edited_from`; старый код optional-поле не пишет — безопасно) → `check`; 3. ff-merge
  `sh1-proposal-edit` в `main` + push → CI зелёный → Render деплой; 4. Restart сервиса;
  5. `curl /health` — `aspectDrift` отсутствует; 6. при ответе «да» на В-3 —
  `bun scripts/ops.ts backfill-body-doc` (до шага 3); 7. прод-смоук подмножества: приёмки
  1, 2, 3, 5, 7, 9 живой рутиной.
- [ ] **Шаг 4:** финальное ревью ветки fable (5 измерений) + по 2 opus-опровергателя на
  Critical/Important; запись исхода в `progress.md`.

---

## Вехи и прогоняемые проверки

| Веха | После задач | Проверка (коды возврата 0, машина незанята) |
|---|---|---|
| A. Серверный низ | 0–5 | `bun run db:prepare` (пересев), `bun run test`, `bun run lint`, `bun run typecheck`; ревью fable: инварианты 2, 3, 5, 6, 7, 9; гонный тест 25 итераций зелёный в CI |
| B. Дифф и запросы | 6–8 | `bun run test`; ревью fable: инварианты 1а, 7; EXPLAIN пробы в `facts.md` |
| C. Web | 9–11 | web-сьют, `bun run --filter @orbis/web build` + `bun scripts/check-lazy-chunks.ts` (с третьей проверкой); ревью fable: инварианты 1б, 4, 8; смоук приёмок 1–4, 6–9 на стенде |
| D. Документы и деплой | 12–13 | финальное ревью ветки fable + опровергатели; приёмка 1–18; деплой |

## Порядок деплоя (кратко; подробно — Задача 13)

`ops.ts check` → `ops.ts seed-aspects` (ДО кода — `.strict()`-схема) → мерж + push + CI →
Render деплой → Restart → `/health` без `aspectDrift` → прод-смоук. Миграций нет.

## Маппинг приёмки спеки → задачи

| Приёмка | Задачи |
|---|---|
| 1. Карточка — свёрнутый дифф, не полный текст | 6 (дифф), 7 (view), 9 (рендер) |
| 2. Тап по записи из карточки → слой | 9 (переход), 8 (запрос), 10 (слой) |
| 3. Обычное открытие → плашка «есть предложение» | 8, 10 |
| 4. Внутриблочное различие «10:00 → 14:00» | 6, 7, 10 |
| 5. Правка текста + «Принять» → ровно документ редактора | 3 (bodyDoc-сборка), 5 (лестница), 11 (отправка), 13 (живьём с блоком кода и ссылкой) |
| 6. Правка значения поля → применяется правленое | 3, 5, 10 |
| 7. Принятие без правок — ровно как до работы, нового pending нет | 4, 5 (пустой путь), 10 |
| 8. Уход без «Принять» — запись не изменилась | 11 (без useBodySave + sameDoc-гейт) |
| 9. Исходное — «заменено правкой владельца» без кнопок; новое — «принято» | 5 (причина/статусы), 9 (рендер + инвалидация ленты) |
| 10. «Отменить последнее» возвращает граф | 5 (тест; Ш1.7 — атрибуция сохранена) |
| 11. Откат прогона инвертирует применённое | 5 (тест) |
| 12. Расхождение → «устарело»; правка тела → пометка вместо диффа | 5 (stale), 7 (body_changed), 9/10 (показ) |
| 13. Новый прогон погасил во время правки → «решено без тебя» | 5 (closeOpenOfRun + самолечение) |
| 14. Двойное «Принять» с правками — одно применение | 3 (хеш), 5 (replay-тест) |
| 15. Две вкладки, разные правки: молча не проигрывает никто | 5 (гонный тест), 9 (показ replaced) |
| 16. Тело сверх потолка → прежняя форма, кнопки работают | 7, 9, 10 |
| 17. Несколько записей: карточка перечисляет, слой у каждой | 8, 9, 10 |
| 18. Две рутины по одной записи: слой показывает оба | 8, 10 |

Инварианты спеки 1–9 → задачи: 1а → 7; 1б → 3, 5, 11; 2 → 3 (проверка), 5 (интеграция);
3 → 3, 5; 4 → 5 (тест отката); 5 → 3 (хеш), 5 (гонный тест); 6 → 5, 9; 7 → 1, 4 (storedProposal),
5 (одно живое); 8 → 9, 10; 9 → 3 (ключи неизменны), 5 (прежний конвейер применения).

## Самопроверка плана

- **Покрытие спеки:** Ш1.1 → 6, 7 (пометка/только pending); Ш1.2 → 7 (сервер), 11 (клиент в
  правке); Ш1.3 → 8, 9, 10; Ш1.4 → 3 (ключи), 10 (поля), 11 (тело от предложенного, sameDoc);
  Ш1.5 → 2, 3, 4, 5; Ш1.6 → 3 (перенос CAS/precondition как есть), 5 (stale-тест); Ш1.7 → 5
  (source routine + run_id, тесты отката/undo); Ш1.8 → 1, 5 (запись в двух местах + история);
  Ш1.9 → 4, 5 (три механизма + гонный тест); Ш1.10 → 6, 7 (потолки, спаривание); Ш1.11 → 3,
  5, 11. «Правки PRD» → 12. «Что НЕ входит» не нарушено: выборочное принятие, добавление
  операций, обучение, уведомления, дифф решённых/из журнала, тикетные прогоны, чат-pending,
  В-2-кнопка, сравнение версий — нигде не строятся. Открытые вопросы 1–6 → Развилки 1–6.
- **Плейсхолдеры:** «TBD/TODO/позже» нет; тесты в шагах — конкретные сценарии; интерфейсы —
  сигнатуры с типами.
- **Согласованность имён:** `rejectPendingTx`/`RejectPendingResult`/`acquirePendingLock` (2) —
  используются в 5; `editsSchema`/`ProposalEdits`/`editsHash`/`buildEditedOperations`/
  `isEmptyEdits` (3) — в 5, 10, 11; `DecideProposalResult.replaced`/`livePendingId` (4) — в 5,
  9, 10; `DiffUnit`/`BodyDiffResult`/`diffBodyDocs`/`flattenBlocks`/`blockText`/
  `DIFF_LIMITS_DEFAULT` (6) — в 7, 11; `bodyDiff`/`proposedDoc` (7) — в 9, 10, 11;
  `proposalsForEntity`/`ProposalView[]` (8) — в 10; `chatThreadKey` (9) — в 9;
  `AspectField`/`coerce`/`isScalar`/`readOnlyText` (10) — в 10; `edited_from` (1) — в 5, 7, 9,
  12; `PROPOSAL_DIFF_*` (Развилка 6) — в 6 (дефолты), 7 (до-разборные).
- **Правила проекта:** ни одной миграции; мутации только через executor; тул-контракт модели
  не растёт (edits — вход tRPC, не тул; счётчики 30/31 и pgTAP 46 на месте); причина
  `'edited'` одной задачей с первым писателем (5); пересев до деплоя (13); листовость диффа
  под тестом и стражами (6, 11).
