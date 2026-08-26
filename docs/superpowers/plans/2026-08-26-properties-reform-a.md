# Реформа свойств, аспектов и ролей рёбер — срез А (0-серия + часть А): план реализации

> **Для агентных исполнителей:** ОБЯЗАТЕЛЬНЫЙ САБ-СКИЛЛ — `superpowers:subagent-driven-development`
> (рекомендуется) либо `superpowers:executing-plans`. Шаги размечены чекбоксами (`- [ ]`).
> Исполнитель задачи видит ТОЛЬКО свою задачу — каждый бриф самодостаточен, имена и типы
> соседних задач продублированы в блоке «Интерфейсы». Модели: имплементеры и разведка — opus,
> гейт-ревью задачи и финальное ревью ветки — fable; sonnet/haiku не использовать.
> Вместе с брифом имплементеру передаются конспекты разведки
> `.superpowers/sdd/2026-08-26-properties-reform-a/plan-recon-*.md` (девять зон, HEAD `fd385c1`)
> и `facts.md` леджера. Каждый `file:line` плана — **опровергаем**: перед правкой перечитать
> `git rev-parse HEAD`, адрес — ориентир, искать grep'ом по имени.
> **Ревизия 2 (2026-08-26):** после адверсариального ревью плана (3 линзы: fable + 2× opus; 4 Critical,
> 31 Important, 21 Minor — все 56 приняты, 0 ложных): задачи 4/9/13 разрезаны на 4a/4b, 9a/9b,
> 13a/13b/13c; SQL эвристики 0016 переписан (EXISTS/функция, чтение `aspects_legacy`); внутренняя
> форма входа — с 4b; старая грамматика живёт до 21; PRD — одним коммитом по спеке (В-5); приёмки
> §С8-4/12 блокирующие; EXPLAIN-вердикт снимается в 9a до написания 0017.

**Цель:** структура системы переезжает из кода в данные — реестры свойств, аспектов и ролей
рёбер (таблицы с циклом «код → сид → drift → дельта → кеш»), сущность хранит `props` по id +
`aspects[]`, ребро несёт `role`, запрос хранится каноническим Q-AST по id; тулы LLM, wire,
предусловия CAS, журнал/undo, `ref`, документ и все читатели переводятся на новую форму; срез
завершается задачей «Пересев мира» и приёмкой §С8 пп. 1–13 (включая п. 11 — класс подтверждения
мутаций реестра). Часть Б (контракты, подписки, правила, язык E, действия, генератор промпта,
модули) — **не в этом плане**: планируется отдельно после гейта П5 (§С8-14, порог 324).

**Архитектура (как срез уложен в зелёные задачи):** четыре миграции вместо одной — 0014
аддитивная (реестры), 0015/0016 **expand** (`props`/`aspects text[]`/`query_refs`,
`relations.role`; старые носители переименованы в `aspects_legacy`/оставлен `relation_type`
и пишутся *проекцией* из новой истины), 0017 **contract** в задаче пересева (старое снимается,
`rel_uniq` пересобирается). Между expand и contract исполнитель (с Задачи 4b) пишет только новую форму, а
не переведённые читатели получают проекцию из одного модуля `executor/legacy-form.ts`, который
задача пересева удаляет — ноль его импортов и ноль совпадений греп-гейта §А12-2 есть
доказательство завершения. Это не compat-слой продукта (пользователей и старых данных нет —
рулинг 23.08), а carried-решение журнала «expand/contract для несовместимых изменений схемы»,
применённое внутри одной ветки ради ревьюируемых диффов. Q-AST заводится рядом со старым
разбором (новый парсер/печать/схема), компилятор и потребители переключаются следующей задачей.
Мутации реестра — только через исполнителя (журнал, inverse, undo); класс подтверждения §7.10
для них — до пересева. Автодеплой Render на время среза выключен (Решение плана РП-1).

**Стек:** Bun 1.2.7, Hono, tRPC 11, drizzle-orm/postgres (Supabase Postgres 17, RLS, pgTAP),
zod + ajv (+ zod-to-json-schema), React 19 + TanStack Query + tiptap, `bun:test`
(server/shared), vitest 4 (web), biome.

**Спека:** `docs/superpowers/specs/2026-08-26-properties-reform-design.md` (ревизия 2, принята
владельцем 2026-08-26 — **D43**, `docs/prd/04-decision-log.md`). План решения спеки НЕ
пересматривает; противоречие документов решается в пользу спеки. Фон при сомнениях:
`reviews/2026-08-26-properties-reform-design-review.md` и
`reviews/2026-08-26-properties-reform-review-response.md`; точные `file:line` по зонам —
`reviews/2026-08-23-aspect-coupling-inventory.md` (приложения Z1–Z5; счёт мест — §С1-4 спеки);
решения — `specs/2026-08-23-properties-model-notes.md` (Р1–Р20, Ч1–Ч11, §8 Б1–Б7),
`specs/2026-08-23-property-ref-type-notes.md`, `specs/2026-08-25-properties-formal-properties.md`.

---

## Что установила разведка HEAD (2026-08-26, main `fd385c1`)

Девять читателей (opus) прошли по коду ПОСЛЕ принятия спеки и ДО нарезки задач; 583
утверждения спеки/инвентаря пробиты чтением: 527 подтверждены, 34 сдвинуты по строкам, 22
опровергнуты по существу; отдельные верификаторы (opus) перепроверили каждое опровержение и
21 раз поправили самих читателей — в таблицу ниже вошло только то, что устояло. Полные
конспекты — `.superpowers/sdd/2026-08-26-properties-reform-a/plan-recon-{db-seeds-ops,
shared-schemas, executor, query-doc, tools-llm-mcp, policy-routines, domain-modules, web,
tests-probes-prd}.md`; машинная сводка — `plan-recon-summary.json` там же. Код на `fd385c1`
идентичен коду на `b0d502a` (37 коммитов между ними — только docs), то есть адреса спеки
действительны.

### Таблица расхождений (спека/инвентарь ↔ код HEAD; что план с ними делает)

| # | Спека/инвентарь говорит | Код на HEAD говорит | Решение плана |
|---|---|---|---|
| Р-1 | §А12-1: «Сиды идут через исполнителя» — как будто есть единый сидер, куда «добавить реестры» | Сидов физически два: `scripts/seed-aspects.ts` (реестр, шаг `db:prepare`, админ-DSN) и `seed/onboarding.ts` (граф, per-user через tRPC `user.seedOnboarding` ← `OnboardingGate.tsx:10`, прямой `insert(entities)` мимо ajv/инвариантов/журнала — `:122-125`). Тело проекта сеет executor (`needsProjectSeed`, `project-body.ts:2-3`) | Два режима остаются: реестры сеет **админский** `scripts/seed-registries.ts` (Задача 3; system-строки, `owner_id IS NULL`), граф — онбординг через `execute()` с `mechanism: 'seed'` под identity владельца (Задача 23). «Через исполнителя» относится к сущностям, не к system-строкам реестров |
| Р-2 | §А4-4/§А2-5: «`MutationSource` операции — закрытый перечень `hook/rule/materialize/seed/action-seed/verb/import`» | `MutationSource` УЖЕ существует и означает **канал**: `'chat'|'fast_path'|'quick_capture'|'mcp'|'ui'|'system'|'routine'` (`executor/types.ts:16-23`); `'system'` читают пять мест с разной семантикой (`undo.ts:74`, `journal.ts:41-44`, `invariants.ts:412/:439`, `rollback.ts:107-109/:158-164`) | Перечень спеки заводится **второй осью** `mechanism: MutationMechanism` (`'user'` по умолчанию + семь значений §А4-4) в `ExecuteRequest` и `ActionRecord`; ось канала не переименовывается и не переосмысляется (пять читателей `'system'` не трогаются). Гейты `system_writable` (§А2-5) и `created_by: system` (§А4-4) смотрят на `mechanism` (Задачи 4b, 7a) |
| Р-3 | §С2-1: «минимальная правка §7.10 … образец готов, ряд `grantsAutonomy`»; в срезе А реестр мутируют `proposed`, слияние, дельты, садовник | Реестровых тулов сегодня **нет вовсе**: `routers/aspect.ts` — 20 строк, только `list`; ни одного INSERT/UPDATE в `aspect_definitions` из приложения; `classifyToolCall` (`confirmation.ts:54-64`) — чистая функция по имени тула и форме input | Порядок §С9 верен: сначала операции реестра через исполнителя и их тулы (Задача 15), затем минимальная правка §7.10 (Задача 16) по именам ЭТИХ тулов и объектам. Объём Задачи 16 — классификация + запрет по объекту для фона + отложенная единица + `worker` без реестровых тулов + тест на каждый ряд |
| Р-4 | §А4-5: «~десяток точек создания рёбер» | Точек-источников операций `relation_*` — восемь (5 создающих + 3 удаляющих): `budget/binding.ts:349-352` (parent), `:329-332`/`:342-345` (delete), `recurring/materialize.ts:365-366` (derived_from), `agent-loop/verbs.ts:470-471` (parent), `routines/lifecycle.ts:912-913` (parent), `routers/relation.ts:29/:44`, `tools/dispatch.ts:1441`; единственный INSERT — `executor.ts:1814`. Зеркала рёбер из тела в `doc/convert.ts` НЕТ (только `body_refs`) | Задача 7a проставляет роль ровно в восьми точках (таблица в брифе); `doc/convert` не трогается |
| Р-5 | §А4-3: `instance-of` заменяет `derived_from`; направление не зафиксировано | Сегодня `source` = ШАБЛОН → `target` = инстанс (`materialize.ts:363-367`); читателей четыре (`aggregates.ts:431,448`, `plan-to-fact.ts:62`, `post-due.ts:55`) | **Направление сохраняется** (source = шаблон, target = экземпляр): так работает пробник Е-1 `has_relation(role)` по `(target_id, role)` для `$self`-экземпляра (§Б3-2а) и так же устроен `envelope-binding` (конверт → транзакция). Читаемость даёт `source_label`/`target_label` роли («шаблон»/«экземпляр»). Решение плана РП-5 |
| Р-6 | §А4-3: `category-parent` — `acyclic` | Циклы в дереве категорий сегодня НЕ запрещены; единственная защита — visited-set в `aggregates.ts:213-223`; `assertAcyclicBlocks` (`invariants.ts:83-133`) стоит только на `blocks` (`executor.ts:1756-1767`); рёбер дерева категорий не создаёт никто (сид кладёт 12 плоских категорий) | `acyclic` — generic-ограничение роли по реестру (Задача 7a): обобщение `assertAcyclicBlocks` на `role`, advisory-lock по образцу `invariants.ts:90` (`<owner>:<role>`); для `category-parent` это новое поведение, приёмка — тест |
| Р-7 | §А7-3: «носитель отложенных единиц D42 (`policy/pending.ts`) переводится на форму `{property, in|absent}`» | В `pending.ts` предусловий нет (payload — непрозрачный `input: z.record(z.unknown())`, `:108`). Предусловия единицы СНИМАЮТСЯ в `tools/dispatch.ts:1101-1188` (`snapshotDeferredUnit` через `propose.ts` `loadTargets`/`buildUpdate`) и СВЕРЯЮТСЯ в `executor.ts:880-910` | Задача 5 правит `dispatch.ts:1171-1174` (псевдо-аспект `orbis/entity` → `orbis/archived`) и `propose.ts:551-597`; `pending.ts` не трогается. Писателей предусловий — 18 (17 литеральных + генератор), список в брифе |
| Р-8 | §А5-3е: алиас `due` уходит — «пересев тел В9» | `due=` в продовом коде и сидах НЕ используется вообще — только тесты `parse.test.ts:119`, `serialize.test.ts:107`, `txQuery.test.ts:115`; сам алиас — `parse.ts:344` + `:347` (фильтр по `orbis/task`) | Снимается в Задаче 8 вместе с резолвом имён; три теста переписываются; пересев тел из-за `due` не нужен |
| Р-9 | §С8-2: «снимок реестра тулов совпадает с эталоном» | Эталона не существует: реестр пиннят счётчики 31/32 (`registry.test.ts:123,139,304`), парность zod↔JSON Schema (`:340-354`), сверка MCP (`mcp.test.ts:486-495`) | Эталон заводится Задачей 12: `apps/server/test/golden/tool-registry.json` — снимок при чистом сиде (13 встроенных, без дельт), сравнение по `canonicalJson`; счётчики становятся производными от эталона |
| Р-10 | §С8-4: рекурсивная JSON Schema проходит на OpenAI Responses при `strict:false` | Рекурсивного `$ref` нет нигде (`aspects.ts:330-332` — `$refStrategy:'none'`; `contracts/import.ts:189`); `openai.test.ts` офлайн (подмена `fetch`); теста живого прогона нет | Задача 9a даёт `scripts/probe-openai-schema.ts` (живой прогон при `OPENAI_API_KEY`, вне CI) — результат записывается в `progress.md`; приёмка 4 закрывается этим прогоном, не тестом, и она БЛОКИРУЮЩАЯ (без ключа — стоп и вопрос владельцу) |
| Р-11 | §Б7-6-2: «`buildContext` (`context.ts:355`) дописывает секции после промпта» | Суть верна, строка — комментарий; дописки `:352-353` (инструкции аспектов), `:358` (память), `:363` (якорь), склейка `:369`; гард «продолжения последние» стоит на СТРОКЕ промпта (`v4.test.ts:178-183`), а не на канале | Задача 0b: порядок сборки + гард на собранном канале; текст промпта не правится (иначе — v5 + фикстура + ~20 тестов) |
| Р-12 | §С1-4: «648 мест» (Z3 = 106) | Прямой счёт строк-мест по приложениям инвентаря: Z1 112, Z2 108, **Z3 100** (номера 1..100 без разрывов), Z4 141, Z5 181 = **642**; таблица покрытия Z3 в спеке несёт 106 строк при максимуме номера 100 и дубле 86 | Не в скоупе среза А (гейт П5 — после); вынесено владельцу как наблюдение В-3: при 642 порог П5 = 321, не 324 |
| Р-13 | Инвентарь В7/§А8: «`parseRuleTitle` и четыре независимых парсера удаляются» | Реализация парсера ровно одна (`memory/rule.ts:53-60`, `RULE_SEPARATOR :35`); четыре — ВЫЗОВЫ (`fast-path/index.ts:136`, `ai/escalation.ts:248`, `MemoryScreen.tsx:38`, `NativeRow.tsx:162`) плюс формат прозой в `MemoryScreen.tsx:56`, `NativeRow.tsx:163`, `MemoryRuleCard.tsx:6,99`, `registry.ts:233`, `cards/types.ts:32`; селекторов с копией условия `kind='rule' AND scope='orbis/financial'` — четыре (`import/review.ts:348-359`, `escalation.ts:235-255`, `memoryRules.ts:12`, `MemoryRuleCard.tsx:101`) + читатель без фильтра `llm/context.ts:112-136`; правил памяти в сидах нет | Задача 18 переписывает пять читателей и четыре вызова разом, удаляет парсер; «последний разбор» §А12-6 — одноразовая функция конверсии с приватной копией разделителя, удаляемая в Задаче 23 |
| Р-14 | §А12-2: греп-гейт «ноль совпадений» | `budget/aggregates.ts` содержит два NUL-байта (`:904-905`) — `grep -r` считает файл бинарным и МОЛЧА пропускает 51 строку `aspects->` и 60 строк `->>'`; маркер `\.meta\b` ловит `import.meta`; в shared старая форма живёт только в докблоках | Задача 0c: гейт — скрипт `scripts/check-legacy-form.ts` на `git grep` с точными паттернами и списком исключений (докблоки, `relations.meta`, `import.meta`, миграции); NUL-байты заменяются видимым разделителем |
| Р-15 | §А11-2: «черновик … после выкатки не досылается молча» (обязательство) | Сегодня досылается молча: `useBodySave.ts:677-729` — сверка `base.bodyDoc.v === draft.doc.v` (`:690`) после поднятия версии не срабатывает никогда (сервер пересобирает `bodyDoc` до текущей версии — `entity-read.ts:67`, `convert.ts:555-567`), ветка `:715-724` шлёт старый черновик → `VALIDATION` → `rejected`; `parseDraft` версию не сверяет (`draft-storage.ts:162`) | Задача 20 (контракт черновиков) идёт СТРОГО ДО Задачи 21 (поднятие версии) — иначе интервал массового молчаливого досыла |
| Р-16 | §А2-1 `rank`, §А3-1 форма аспекта — инвентарь Z4-44 «12 списков keyFields» | Списков 13 (пропущен `orbis/note`, `aspect-registry.ts:61`); `orbis/agent-run` — 20 полей (спека §А8 права, инвентарь «22» — нет) | Задача 1 переносит все 13 `keyFields` и 13 `tagMappings`; страж полноты `aspect-registry.test.ts:30-34` заменяется эквивалентом ДО переноса |
| Р-17 | §А8: таблица типов | Спека молча теряет `min(1)` у шести text-полей (`bank_txn_id`, `unit`, `repo.url`, `default_branch`, `assignee`, элемент `allowed_tools[]`: `aspects.ts:78,146,160,171,303`); добавляет непомеченные ужесточения `timezone {format: iana-tz}` и `currency {format: currency}`; `default:false` у `planned`/`may_close` при том, что ajv default'ы не применяет (докблок `:172`) | Решение плана РП-8: конфиг `text` получает границу `minLength?` (В8 перечисляет границы как класс; это не новый kind) и сиды сохраняют `min 1` там, где он есть в коде; `format: iana-tz|currency` реализуются как в спеке и попадают в список ожидаемых расхождений golden-корпуса (Задача 2); `default` в определении — семантика ЧТЕНИЯ (отсутствие = default), на записи не материализуется (РП-9) |
| Р-18 | §А1-4: «EXPLAIN-приёмка индексов» | Исполняемого EXPLAIN в репозитории нет как жанра (четыре упоминания — комментарии); jsonb-пробы под RLS индекс не берут (долг D41: `jsonb_contains` не leakproof) | Задача 23: EXPLAIN-приёмка в `apps/server/perf/explain.test.ts` (отдельный шаг CI), **под ролью приложения через `withIdentity`**; вердикт по каждому GIN — по факту плана; неиспользуемый снимается той же задачей (§А1-4); LEAKPROOF-решение остаётся за владельцем (D41) |
| Р-19 | §А12: «база пересоздаётся начисто» | Механизма нет ни локально (`setup-db.ts` не дропает), ни на проде (`ops.ts` — белый список из 9 операций без truncate/SQL; runbook §4.3 — только восстановление дампа) | Решение плана РП-7: новая операция `bun scripts/ops.ts reset-world` (Задача 23; явное подтверждение, список таблиц, реестры пересеваются) + чек-лист runbook §1; `chat_messages` (журнал, единицы D42, эскалация) сносятся вместе с графом — названо вслух |
| Р-20 | §С8-3: golden «AST → SQL → результат» | Настоящий golden — `apps/server/test/golden/query-sql.json` (27 ручных эталонов «текст → SQL», докблок запрещает «записать что вышло»); `packages/shared/src/query/fixtures.ts` golden'ом не является; «→ результат» даёт `compile.dataset.test.ts` (21 тест, живая БД) | Один файл эталонов с двумя проверками (Задача 9a): `query` → ожидаемый `ast` (парсер) и `ast` → ожидаемый `sql`/`params` (компилятор); 27 эталонов пересчитываются вручную + новые конструкции; мутационная проверка обязательна |
| Р-21 | §А9-2: «`entity_query` печатает по key» | `toWireEntity` печатает модели ВСЁ (`meta`, всю карту аспектов) без фильтра (`wire.ts:31-47`, `dispatch.ts:619-639`) | Задача 12: LLM/MCP-проекция печатает `props` по key; `system_writable`-свойства печатаются (модель читает прогоны рутин), `meta` исчезает |
| Р-22 | Инвентарь Z1-84/§А8: `nearest_ancestor` заменяет `project_id` | `parentProject` (`queries.ts:203-217`) — одноуровневый JOIN; `project_id` пишется ровно в одном месте (`verbs.ts:456-458`) и на сервере читается только запросом в теле сида `project-body.ts:43` (`project_id=…`) | `orbis/parent_project`/`orbis/root_project` — новая функция, не перевод: код-движок в Задаче 7b (пересчёт затронутого поддерева в tx правки рёбер, системная строка журнала без inverse — §Б4-3 «пересчёт»), декларация правила — Б-2; тело проекта → `orbis/parent_project=` в Задаче 21 (названный интервал); П6 (§С8-13) меряется в Задаче 9a |
| Р-23 | §С8-10 «drift/`/health`/`ops.ts check` знают все пять реестров» | `diffBuiltinAspects` обходит только `BUILTIN_ASPECT_META`, лишние строки БД дрейфом не считает (`aspect-registry.ts:233-248`); `/health` отдаёт снимок, снятый на старте (`index.ts:31-34`, `app.ts:203-225`) | Задача 3: двусторонняя сверка (лишняя system-строка — дрейф), пять реестров, `/health` и `ops.ts check` на одной функции |
| Р-24 | §А3-1: JSON Schema аспекта — производная | Валидатор executor'а читает `aspect_definitions.schema` из БД (`aspects-validate.ts:35-44`), `attach_*` отдаёт `row.schema` монолитом (`registry.ts:1000`) | Колонка `schema` остаётся **носителем старой формы** до пересева: Задача 3 продолжает писать в неё старую zod-схему; Задача 4b переводит валидацию на реестр свойств, Задача 12 — `attach_*` на генерацию; 0017 колонку снимает |
| Р-25 | — (найдено разведкой) | Тесты вне инвентаря: 182 файла (server 92 c `perf/`, shared 16, web 72) / 2946 блоков; 960 вхождений `aspects` в 89 тест-файлах, 104 `relationType` в 31; `test/helpers.ts` `truncateAll` перечисляет 10 таблиц; `agent-loop-helpers.ts` `link()` зашивает `parent` (`:97`), `aspectsOf()` читает карту (`:104-110`) — 157 вызовов в 15 файлах; web-фикстуры не типизированы (`harness.tsx:59` → красный рантайм, не tsc) | Каждая задача переводит свои тесты; хелперы получают пары нового образца (`propsOf()`/`link(role)`) в Задачах 4a/7a; фикстуры web переводятся в 13b/13c с греп-тестом; базовая линия счётчиков — Задача 0 |
| Р-26 | — (найдено разведкой) | `WireEntity.meta`/`aspects` обязательны (`types.ts:78-79`), `entitySchema` даёт `meta` default (`entity.ts:18`); web не имеет своего типа сущности — всё `RouterOutputs` (`trpc.ts:13-14`); кастов `… as Record<…>` вне тестов — 15 (`AspectCards.tsx:84`, `NativeRow.tsx:183`, `DetailScreen.tsx:258`, `EntityRow.tsx:36`, `CategoryScreen.tsx:134,346`, `TransactionsScreen.tsx:320,339`, `usePlanToFactPrompt.ts:21`, `useAgenda.ts:55`, `categories.ts:62`, `QuickAddBar.tsx:82`, `MemoryScreen.tsx:37`, `EnvelopeCreateSheet.tsx:120`, `EnvelopeCard.tsx:110`), чтений `.aspects` ≈43 | Смена wire — единственный вход реформы в web: Задача 4a переименовывает карту в `aspectsMap` и чинит ВСЕ ошибки tsc (приёмка шага — `bun run typecheck`), 13b/13c переводят чтения на `props` по id |
| Р-27 | — (найдено разведкой) | `touchesBudgetContour` (`executor.ts:507-519`) нюхает СЫРОЙ вход тула на ключи `'orbis/financial'`/`'orbis/budget'` и имена `attach_orbis_*` — после перехода на props/генерируемые имена замок контура молча перестанет браться (дедлок E9, страж `binding.test.ts:941-980`) | Задача 4b переписывает предикат контура на резолвленный патч свойств (множество id свойств financial/budget по реестру) |
| Р-28 | — (найдено разведкой) | `materialize.ts:336,351` копирует аспект спредом `{...schedule}`/`{...fin}` — в плоской модели спред унесёт ВСЕ props шаблона в инстанс | Задача 10b: явный перечень наследуемых property-id (§Б4-3 «явный перечень, не spread») с тестом «инстанс не получил чужих свойств» |
| Р-29 | — (найдено разведкой) | `planned` читается тремя несовместимыми способами (`='true'` текстом, `coalesce(boolean,false)`, `!== true`) | Решение плана РП-9: единая трактовка «отсутствие = false» — `COALESCE((props->>'orbis/planned')::boolean, false)` в SQL, `=== true` в JS |
| Р-30 | — (найдено разведкой) | `binding.ts:571` `IS NOT DISTINCT FROM` — единственное намеренное нарушение правила «нет валюты ⇒ дефолт» (уникальность конверта) | Сохраняется как есть при переводе (Задача 10a) — приёмка A7 дубля конверта (`currency-normalize.test.ts:125-214`) |
| Р-31 | — (найдено разведкой) | `psevdo-аспектов` ДВА разной природы: `'orbis/entity'` (адресация колонки в CAS) и `''` (маркер расхождения тела по `STALE_VERSION`, `lifecycle.ts:2468-2472`, `proposal-text.ts:95-97`) | Задача 5: первый → core-свойство `orbis/archived`; второй — НЕ поле, заменяется явным флагом `bodyChanged: true` в расхождениях предложения (вне пространства свойств) |
| Р-32 | — (найдено разведкой) | `ExecErrorCode` — закрытый union из 8 кодов + обязательный `Record` в TRPC (`errors.ts:15-23`, `:48-60`); кодов реформы нет | Задача 3 заводит семейство кодов реформы разом: `COMPUTED_WRITE`, `ROLE_SYSTEM_ONLY`, `SCOPE_NOT_STATIC`, `QUERY_JOIN`, `QUERY_MULTI_ROLE`, `REGISTRY_LIMIT` (кап `proposed`), `REGISTRY_CONFLICT` (слияние ждёт пачки); TRPC-маппинг: `COMPUTED_WRITE`/`ROLE_SYSTEM_ONLY` → `FORBIDDEN`, `SCOPE_NOT_STATIC`/`QUERY_JOIN`/`QUERY_MULTI_ROLE` → `BAD_REQUEST`, `REGISTRY_LIMIT` → `TOO_MANY_REQUESTS`, `REGISTRY_CONFLICT` → `CONFLICT` (таблица Задачи 3 — единственная) |
| Р-33 | — (найдено разведкой) | Реестр тулов пересобирается на КАЖДЫЙ вызов в четырёх точках (`dispatch.ts:174-175`, `mcp/server.ts:59`, `send-message.ts:307`, `runner.ts:238`); `loadCatalog` компилятора без кеша (`compile.ts:149-156`) | Кеш эффективных определений (Задача 14) встаёт под все четыре сборки и под каталог компилятора |
| Р-34 | Спека §А5-3е и Z4-67 | Помимо алиаса, парсер и компилятор держат один инвариант резолва двумя копиями (`compile.ts:295-298, :309-311` считает ошибки резолва «недостижимыми») | Задача 9a: компилятор доверяет AST по id и валидирует по реестру ОДИН раз при разборе/сохранении; недостижимость снимается по построению |
| Р-35 | — (найдено разведкой) | `progress.test.ts:609-614` пиннит точные счётчики запросов (6/10) и наличие строки `'aspect_definitions'`; `binding-batch.test.ts:333-337` распознаёт SQL по тексту (`READS`) | Оба переписываются в задачах перевода SQL (10a/10b) — не «чинить число», а пересчитать |

### Подтверждено пробоем (ключевые адреса для брифов; полные — в plan-recon-*.md)

- **Схема БД:** `entities.meta` — `schema.ts:72` (DDL `0000:53`), `aspects` jsonb — `:73`; `relations` — `schema.ts:80-99` (`relationType :90`, `rel_uniq :96`, `rel_no_self :97`); `aspect_definitions` — `:102-124` (partial unique `builtin_uniq :119`, `custom_uniq :120-122`); `user_settings` — `:127-138` (смешанный регистр колонок — новая колонка объявляется snake_case явно). Индексы `entities` — ровно 7 (`0001:100-112`: tags GIN :100, aspects GIN :102, meta GIN :104, body_refs GIN :106, два FTS :108/:110, btree owner_updated :112); `relations` — `(source_id, relation_type)`/`(target_id, relation_type)` (`0001:114-116`). RLS — 11 политик `0001:36-91`. `GRANT ON ALL TABLES` (`0001:97`) на новые таблицы НЕ распространяется — каждой нужен явный GRANT (образцы `0011:30-41`, `0013:27-35`). Журнал миграций: idx 0–7, 9–11, 13; следующая сгенерированная — **0014** (drizzle-kit `idx = last + 1`); `0012_drop_body_before_doc.sql` не зарегистрирована намеренно — не трогать. Рукописные миграции с RLS снимков не имеют (0005/0011/0013) — генерация от этого не ломается.
- **pgTAP:** `rls.pgtap.sql` — `SELECT plan(46)` на `:6`, проверка «RLS на всех 11 таблицах» со списком `:53-55` и ожиданием `:57`; группа-образец `:276-317`; раннер `scripts/test-rls.ts:16-19` ловит и `not ok`, и «Looks like you planned».
- **Тест-инфра:** `test/helpers.ts:35-41` `truncateAll` (10 таблиц + `DELETE aspect_definitions WHERE owner_id IS NOT NULL`); `src/test/agent-loop-helpers.ts:97` `link()` (`relation_type:'parent'`), `:104-110` `aspectsOf()`; перф-фикстура `src/test/perf.ts:167-344` пишет aspects/relation_type напрямую, сторож `perf/perf.test.ts:202-251`, бюджеты `:100-109`; golden `test/golden/query-sql.json` (27) ← `compile.golden.test.ts:39-50`; датасет `compile.dataset.test.ts` (21, TODAY=`2026-07-03`); `body-doc.test.ts:714` пиннит `DOC_SCHEMA_VERSION === 1`; `journal.test.ts:125-134, :141-158` пиннят форму записи побайтно; `undo.test.ts:141-189` (`:186`) пиннит «откат аспект-ключом»; `executor.test.ts:1051-1333` (CAS), `:1334-1565` (псевдо-аспект D42); `aspects.test.ts:384` пиннит «`orbis/entity` не аспект»; `tools.test.ts:89-140` — форма предусловия; `tools.test.ts:171` — `relationDeleteInput === relationCreateInput` через `toBe`.
- **Исполнитель:** `execute(db, req: ExecuteRequest, deps)` — `executor.ts:262`; `ExecuteRequest` — `types.ts:25-47` (`actorUserId`, `actorKind`, `source`, `threadId?`, `operations[]`, `batchId?`, `clock?`, `actorGrantId?`, `runId?`, `editedFrom?`); замок контура `:279-282`/`:383-384` (глобальный порядок: advisory первым), `lockBudgetContour :534-540`, реальный advisory — `binding.ts:519-523`, второй — `invariants.ts:90`; реестр аспектов грузится один раз на tx `:283`/`:385` (`loadAspectRegistry` — `aspects-validate.ts:35-44`); `mergeAspects` — `normalize.ts:33-51`, единственный вызов `executor.ts:1280`, ещё две ветки установки мимо merge: undo-замена `:1267-1278`, attach `:1557`; валидация ajv — `:1045` (create), `:1302` (update по touched), `:1554` (attach), кеш по тексту схемы `aspects-validate.ts:48-67`; CAS `assertPrecondition :880-934` (сравнение `JSON.stringify :898-901`, псевдо-аспект `:892-897`, отказ `CONFLICT`/`precondition_failed :914-933`); inverse аспектов — весь ключ (`:1485-1491` update, `:1619-1628` attach); `meta` пишется `:1131`, `:1475-1479`; INSERT relations — `:1814-1823`, `relations.meta` живая `:1731/:1820/:1890/:1941`; `internalUndo` пропускает семь проверок (`:1245, :1294, :1310, :1316, :1324, :1346, :1442`); `touchesBudgetContour :507-519`; резолв attach-тула `:568-573`; `DOC_SCHEMA_VERSION`-гейт записи `:1386-1392`; `body_refs` обход `:1374-1378`.
- **Инварианты/нормализации:** `normalize.ts` — `applyTaskCompletion :57-69`, `financialRecurringNeedsDerivedFrom :87`, `assertFinancialInvariant :99-120`, `needsProjectSeed :151`; `invariants.ts` — `assertAcyclicBlocks :83-133` (WITH RECURSIVE `:97,:110` — единственный образец CTE в репозитории), `assertSingleBudgetParent :208-244` (+ ретроспективный путь attach/update `executor.ts:1655-1685`, вызовы `:1328, :1579, :1767-1769`), `assertNoDuplicateRelation :260-275`, `assertAssignment :296-327`, `assertRunSubject :344-357`, `ROUTINE_UNTOUCHABLE_OBJECTS :369`, `assertRoutineUntouchable :408`, `routineUntouchableError :453-459`.
- **Журнал/undo/эскалация:** журнал — `chat_messages.metadata = {actions:[ActionRecord], cards, results?}` (`journal.ts:89-104`; `ActionRecord` — `types.ts:142-193`); `applyUndo` прогоняет inverse как обычные тулы (`undo.ts:97-138`, `InternalUndoMode` `types.ts:280-283`); откат прогона — containment-проба по `run_id` (`rollback.ts:204-217`, GIN `0001:123`), `TOUCHED_KEYS :220`; эскалация читает журнал по аспект-ключам (`escalation.ts:87-106, :138-157`), правила памяти — `:235-255`.
- **CAS/предусловия (18 писателей):** генератор `propose.ts:551-597` (`:570-577`); литералы `lifecycle.ts:363,380,643,1096,1833,2055`; `verbs.ts:310-315,439-443,627-631,807,830-835,976`; `sweep.ts:136-139,166`; `routers/agent-run.ts:130-136,151`; `dispatch.ts:1171-1174` (псевдо-аспект); `verbs.ts:186-192, :665-674, :855-859` различают провалы CAS по СТРОКОВОМУ имени поля (`step_count`/`outcome`); контракт — `contracts/tools.ts:105-141`.
- **Служебные аспекты в SQL/JS:** 15 сырых SQL по карте `aspects` в зоне рутин (`queries.ts:37-56,163-176,184-197,203-217,225-236,255-264,273-282,292-300,320-330,342-350,353-365`; `lifecycle.ts:1287-1289`; `rollback.ts:180-182`; `dispatch.ts:1363, :1512`); `runSummary` читает 16 полей поимённо (`queries.ts:374-411`); `patchAspect` — единая точка патча (`lifecycle.ts:204-241`, тип закрыт двумя id `:209`); `CORE_FIELD_LABELS` — `routines/constants.ts:47-54` (ключ `meta :53`; читатели `lifecycle.ts:2688`, `edits.ts:234/270/437`, `dispatch.ts:1164`); `updateRows` — `lifecycle.ts:2660-2721`.
- **Домен (SQL старой формы):** зона Z2 — 84 пути `aspects->` + 14 containment `aspects ?` + 10 JS-чтений = 108 мест (`budget/{aggregates,binding,plan-to-fact}.ts`, `import/review.ts`, `recurring/{materialize,post-due}.ts`, `goals/progress.ts`, `ai/escalation.ts`); `aspects ? 'orbis/…'` над `text[]` не определён — четыре горячих места (`invariants.ts:222`, `rollback.ts:182`, `escalation.ts:211, :241`); `decCmp` (`decimal.ts:60-65`) сравнивает по значению (`'10.0'` = `'10.00'`), `parseDec :19-23` бросает `RangeError`; `derived_from` создаётся в `materialize.ts:362-367`, читается в 4 местах; дерево категорий `aggregates.ts:194-210`.
- **Query/doc:** `QueryAst` — `grammar.ts:186-199` (`filters: QueryFilter[]` плоско; `sortBy/search/limit/display/title` уже отдельно); `QueryFilter` — 10 узлов `:154-164`; OR — только `anyOf` внутри поля, NOT — `noneOf`/`excludeTags`/`excludeBlocked`; reserved-ключи `parse.ts:36-49` и `serialize.ts:60-73`; date-токены — `grammar.ts:18`, `parse.ts:51` (ровно четыре), проверка типа `:657-672`; `propType` — `catalog.ts:166-195` (регэкспы `:174-179`); `aspect=` не валидируется (`parse.ts:469-478`, `compile.ts:233-235`); компилятор: SELECT-лист `:62`, `loadCatalog :149-156` (без кеша), скрытие служебных `:188-216`, `children_of/parents_of` через `'parent'` `:248/:250`, `excludeBlocked :254`, путь до значения `:300-321`, containment `:355-357`, касты `:496-515`, CASE по enum `:569-583`, сортировка `:595-625`; `materializationWindow` обходит `ast.filters` плоско (`materialize.ts:116-173`, `MATERIALIZABLE_FIELDS :43`) — считается ДО компиляции; `with-materialization.ts:13-59` каркас; нода `queryBlock` — один атрибут `query` (`query-block.ts:6-11, :16`), токенайзер `:33-41`; `{{query:…}}` разбирают четыре независимых пути (`query-block.ts:33-41`, `browser/query.ts:42`, `lib/query-blocks/parse.ts:7`, `convert.ts:51`); `KEY_ATTRS` диффа без `queryBlock` (`diff.ts:177-181`), `collectText :241`; `diff.ts` — листовой модуль (страж чанка `save.test.tsx:1363`); `DOC_SCHEMA_VERSION = 1` (`doc/types.ts:8`), три точки сверки (`convert.ts:555-567`, `executor.ts:1386-1392`, `routers/version.ts:34-37`); черновик — `localStorage` `orbis:body-draft:<owner>:<entity>`, TTL 30 дн, `draft-storage.ts:21-33, :50, :62, :84, :155-166`; `useBodySave.ts:677-729`; `progress_source.query` — строка (`aspects.ts:133, :137`); `entityQueryInput` — только строка (`contracts/tools.ts:181`); JSON Schema `entity_query` — `registry.ts:359-370`, tRPC `routers/entity.ts:97-99`, колбэк разбора `dispatch.ts:619-639`/`routers/entity.ts:82-95`.
- **Тулы/LLM/MCP:** реестр у чистого владельца — 31 деф (12 CORE + 5 глаголов + `orbis_propose` + `orbis_ask` + 12 `attach_*`), с кастомным аспектом — 32; генерация `attach_*` — `loadAspectToolRows :960-982`, `attachToolName :985-987` (заменяет `/` и `-`), `attachToolDef :989-1008` (`data = row.schema`), служебность `:1021-1032`; вторая нормализация `dispatch.ts:1517-1519` (только `/`); вход `entity_create` — `registry.ts:387-408` (`meta :399`), `entity_update :410-434` (`:423`); парность zod↔JSON Schema `registry.test.ts:340-354` по `ZOD_BY_TOOL :313-338`; `entity_card`/`keyFields` — `dispatch.ts:1611-1641`; `user_query.field` строкой — `registry.ts:473-476`, `dispatch.ts:659-679`; `relation_create` JSON Schema — `registry.ts:441-443`; порядок канала чата — `context.ts:349-370` (`:350` промпт, `:352-353` инструкции аспектов, `:356-359` память, `:362-364` якорь, склейка `:369`); рутины — `routines/context.ts:272-296`; `ownerTimeZone/today` готовы в `query/context.ts:13-50`, канал их не зовёт; два пина «канал начинается с промпта» — `llm/context.test.ts:78`, `send-message.test.ts:229`; фикстуры промптов — побайтный снимок константы (`v4.test.ts:24-27`, `routine-v2.test.ts:50-53`); линейка: правка текста = новый файл + фикстура (`v4.ts:2-4`, `routine-v2.ts:2-5`); MCP full — 26 тулов, worker — 9, фильтр `mcp/server.ts:61-79` (`:73` пускает любой `kind:'read'`); `routineToolAllowed :156-177` (`:160` — все read); `strict:false` — `openai.ts:37-51`, `store:false :52-58`; `toSdkTools` отдаёт схему как есть (`ai-sdk.ts:147-158`).
- **Политика §7.10:** `classifyToolCall` — `confirmation.ts:54-64` (ряды `:57` archives, `:58-60` batch>10, `:61` grantsAutonomy, `:62` isBatch, `:63` execute), факты `ToolCallFacts :15-30`, `factsFromToolCall :78-109`, `grantsRoutineAutonomy :122-137` (`attach_orbis_routine :124`, `aspects['orbis/routine'] :130`); страж «ряды 1–6 не сдвинулись» — `confirmation.test.ts:432-443`; запрет по объекту для фона — пре-чек `dispatch.ts:762-779, :1418-1479` (докблоки `:1373-1377, :1390-1396`) и стадия executor'а `invariants.ts:369, :418`; отложка `deferRoutineUnit dispatch.ts:815, :988-1070`; PRD §7.10 — `01-architecture.md:990-1027` (таблица `:994-999`, входы `:1001-1007`, запрет по объекту `:1019`), дубль `:1188`.
- **Web:** тип сущности — `RouterOutputs` (`trpc.ts:13-14`); касты `entity.aspects as Record<…>` — `AspectCards.tsx:9,84`, `NativeRow.tsx:10,183`, `DetailScreen.tsx:42,258`, `useEntityDetail.ts:17-18,56`, `EntityRow.tsx:36`, `useAgenda.ts:55`, `categories.ts:6,62`; реестр читают две точки (`useFieldCatalog.ts:23-33` ← `aspect.list`; `AspectsList.tsx:5-14`); статика shared — `NativeRow.tsx:1,167-169` (keyFields), `Subtasks.tsx:1,22-24` (SERVICE_ASPECT_IDS), `query-builder/model.ts:20,38` (CORE_FIELDS); `field-labels.ts` — 40 полей `:3-54`, `fieldLabel :56-58`, `AGGREGATE_LABELS :61-71` (остаётся), 14 аспектов `:74-103` (`orbis/entity :102`), `aspectLabel :105-107`; читатели: `unit-text.ts:100-101`, `EntityCard.tsx:104`, `proposal-text.ts:80,104`, `ProposalCard.tsx:130`, `FieldRows.tsx:81`, `NativeRow.tsx:266`, `QueryBuilderForm.tsx:224`, `AspectCards.tsx:122,185,245,298`; форма по данным `AspectCards.tsx:112-113, :135, :33-37`; пикер категории по имени `:139-145`; пять копий пикера (`AspectCards.tsx:176-227`, `QuickAddBar.tsx:237-252`, `EnvelopeCreateSheet.tsx:110-130` — без `toOption`, свой литерал `:55`, `TransactionsScreen.tsx:299-312`, `ReviewTable.tsx:232-245`); запросы категорий литералом — `categories.ts:8`, `EnvelopeCreateSheet.tsx:55`, `useFastPath.ts:17`; 15 боевых текстов запросов (`useAgenda.ts:38,45,52`; `browser/query.ts:13-18,24`; `QuickAddBar.tsx:29`; `txQuery.ts:53-67`; `CategoryScreen.tsx:117`; `memoryRules.ts:12`; `useTicketRuns.ts:45`; `slash/items.ts:29`; `MemoryScreen.tsx:25`; `SmartListSave.tsx:18`); `relationType` — `Subtasks.tsx:29,73`, `Blocks.tsx:61,176,276,277`, `QuickCapture.tsx:45`; `Blocks.tsx:13-15` `CLOSED` литералом, `:70-78` плоское `e.status` из `entity.resolveRefs`; `useEntityDetail.ts:55-62` оптимистичный shallow-merge (`null` снимает аспект); `NativeRow.tsx:253-259` «первый аспект» через `Object.keys(aspects)[0]`; `useBudgetTabVisible` — `useBudget.ts:39-42`; `run-poll.ts:9-12` — намеренный дубль литерала `'orbis/agent-run'`; `QueryWidget.tsx:14, :18-38` (`attrs.query`, барьер `:29-32`); `QueryBlock.tsx:46-48, :60-62, :72-86` (ошибка блока); `query-builder/model.ts:198-218`, `QueryBuilderForm.tsx:134-138` («печать не изменилась → исходная строка»); тесты web — 72 файла / 1052 блока, снимков нет, 25 файлов пиннят `aspects`, 25 — `meta: {}`; страж чанков — `scripts/check-lazy-chunks.ts` + `save.test.tsx`.
- **Сиды и каноны:** `smart-lists.ts` тела — `:10-11, :13-15, :17-18, :22-23, :25-26, :28-29, :52, :62, :95/:97/:99`, имя аспекта прозой `:48, :50`, докблок `:86-89`; `project-body.ts:31,35,39,43`; `onboarding.ts:99-118` сборка, `:122-125` insert, `:132-150` настройки, `BUDGET_VIEW_ID :46`, `ROUTINES_LIST_BODY_BEFORE_BATCH :239-243` (докблок `:226-238` «править нельзя никогда»), бэкфилл D42 `:275-285` (`:283` байт-в-байт); `onboarding.test.ts:197-238` — шесть тел байт-в-байт против `docs/prd/02-core-os.md` §3.3 (`:262-368`); `seed-canon.test.ts:14-31`; `project-body.test.ts:29-33`; `export.ts:32-42` (`version: 1`), `:70-74` (кастомные аспекты), `:82`.
- **Эталоны проб** (`.superpowers/probe/`, gitignored): `p1/registry.json` (58 свойств × 4 ключа `key/type/label/description` — НЕ форма §А2-1; 17 аспектов с `properties:[{property, required}]`; контракты 4, подписки 3, шаблоны 5), `p1/schemas.json` (draft-07, `orbis_declarations`, `$defs: locstr/proptype/expr`), `p1/mutation-check.ts` (читает `./schemas.json`), `p2/01-new-form.sql` (DDL прототипа: `props jsonb`, `roles text[]` — «та же колонка, что `aspects text[]`», `relations.role`, `rel_uniq(source,target,role)`, RLS дословно по 0001, девять индексов), `p2/07-indexes-{new,old,drop}.sql` (три экспрессионных btree и вердикт «не нужны»), `p2/05-materialize.sql`, `p2/subscription.budget.json` (151 строка), `p2/registry.json`; расхождения имён с §А8: `orbis/envelope_limit` (П1) vs `orbis/limit` (§А8; §А5-3а сама пишет `orbis/envelope_limit`), `orbis/grant_id`+`uuid` vs `orbis/grant`+`grant`, `orbis/category_ref` (П2) vs `orbis/finance_category`, `integer` vs `number{integer}`.
- **PRD/runbook адреса для §С10:** `01-architecture.md` — §2.1 `53-84`, §2.4 `104-146`, §3 `147-461` (§3.8 `:299`, §3.9 `:321`, §3.10 `:325`, §3.15 `:401`), §4.1 `468-486`, §4.2 `487-506`, §4.3 `507-525`, §4.9 `604-622`, §4.10 `623-644`, §6 `769-866` (§6.1 `773-839`, §6.3 `846-858`), §7.1 `869-891`, §7.6 `940-945`, §7.8 `958-980`, §7.10 `990-1030`, §9.2 `1084-1140`, §9.3 `1141-1192`, §10 `1199-1216`, §12 `1282-1298` (п.7 — `:1292`, п.10 — `:1297`), §13 `1299-1307`; `02-core-os.md` — §3.3 `262-368`, §3.4 `369-390`, §3.5 `391-524`, §3.6 `525-561`, §3.9 `582-593`, §4.1 `616-623`, §4.2 `624-634`, §7.1 `704-726`; `03-budget.md` — §2.2 `85-99`, §2.3 `100-113`, §2.4 `114-126`; `00-product.md` — §11 `242-255` (`:252`), глоссарий `256-276`; runbook `02-ops-runbook.md` — §1 чек-лист D42 `:527-601`, «сначала миграции, потом код» `:602-663`, §4.3 `:893-948` (список таблиц `:919-921`, перепривязка `:937-946`), §7 `:1115-1174`, §8 `:1175-1219` (устаревший путь `apps/server/src/perf.test.ts` на `:1177`, `:1186-1188`).
- **Базовая линия сьютов (ожидание по леджеру D42, перемерить в Задаче 0):** shared 371 / 16 файлов; web 1055 + 1 skip / 72 файла; server 1635 / 91 файл (+ `perf/perf.test.ts` отдельно, бюджеты `entity.query:list50=60`, `entity.count:badge=60`, `budget.overview=300`, `agenda:horizon=120`, `entity.backlinks=120`, `fastpath:create=150`, `goal.progress=120` мс); pgTAP `plan(46)`.

---

## Решения плана РП-1…РП-20 (владелец может отменить; план написан под них; Р-N выше — строки таблицы расхождений)

- **РП-1. Автодеплой Render на время среза выключен.** Каждый закрытый таск мержится в `main` (постоянное распоряжение), но миграции 0014–0017 внутри ветки несовместимы с прод-базой, а Render катит код по push в `main` (`render.yaml:12`, миграции — только `ops.ts migrate`). Механизм по умолчанию: Задача 0 добавляет `autoDeploy: false` сервису `orbis` в `render.yaml` (docs-коммит в `main` ДО мержа Задачи 3; Blueprint-sync подхватывает; если Render потребует ручного подтверждения синка — владелец подтверждает в UI, альтернатива — тумблер Auto-Deploy в Settings → Build & Deploy). Обратное включение — шаг чек-листа Задачи 23 ПОСЛЕ миграции, пересева и ручного `trigger deploy`. Прод на время среза живёт на последнем деплое до реформы (пользователей нет — рулинг 23.08).
- **РП-2. Expand/contract внутри ветки, без compat-слоя в продукте.** 0015 переименовывает `entities.aspects` → `aspects_legacy` и добавляет `props`/`aspects text[]`/`query_refs`; 0016 добавляет `relations.role`; исполнитель пишет ТОЛЬКО новую истину, а `aspects_legacy`/`relation_type` заполняются проекцией из `apps/server/src/executor/legacy-form.ts` (единственный модуль; заголовок «удаляется задачей «Пересев мира»»). Фикстуры/сиды с прямым INSERT пишут через ту же проекцию. Тест-инвариант после каждой мутации: `aspects_legacy === projectLegacyAspects(props, aspects)`. 0017 снимает старое; ноль импортов `legacy-form.ts` и ноль совпадений гейта §А12-2 — приёмка. Обоснование: carried-решение «expand/contract» журнала; один big-bang-таск (~10k строк диффа) не ревьюируем гейтом.
- **РП-3. Две формы входа исполнителя в переходный период.** Внутренняя форма `entityPropsPatch` (`props` по key|id, `unset`, `aspects: {attach, detach}`) появляется в exec-надмножествах контрактов уже в Задаче 4b (union со старой картой `aspects: {id: {field: value}}`), потому что inverse/undo (6), предложения (5), глаголы/материализация (10a/10b) пишут ею; старая карта переводится на границе адаптером `fromLegacyInput()` (`legacy-form.ts` ИМПОРТИРУЕТ `legacyFieldToProperty`/`propertyToLegacyField` из `@orbis/shared` Задачи 2 — второй таблицы соответствий нет). LLM-контракты тулов (JSON Schema + zod) переходят на новую форму в Задаче 12; tRPC/UI-надмножества принимают старую карту до Задачи 13c (web-отправители) и 18 (`MemoryRuleCard`), где union и адаптер входа снимаются; проекции `projectLegacyAspects`/`projectLegacyRelationType` живут до Задачи 23.
- **РП-4. `MutationMechanism` — вторая ось рядом с `MutationSource` (см. Р-2 таблицы расхождений).** Тип `'user' | 'hook' | 'rule' | 'materialize' | 'seed' | 'action-seed' | 'verb' | 'import'`; поле `mechanism?` в `ExecuteRequest` (default `'user'`) и `ActionRecord`; в журнал пишется; гейты `system_writable`/`created_by: system` — по нему. Спека называет этот перечень `MutationSource` — терминологически это он и есть, имя в коде другое из-за занятой оси.
- **РП-5. Направление роли `instance-of`: source = шаблон, target = экземпляр** (как сегодня `derived_from`). Обоснование — в таблице расхождений Р-5; `source_label` «шаблон», `target_label` «экземпляр».
- **РП-6. `registry_ref → contract` в срезе А резолвится против `contract_definitions ∪ CONTRACT_IDS_V1`.** Таблица контрактов в А создаётся пустой (§А12-1), а `orbis/rule_scope` обязан принимать `orbis/money-movement` уже в А (§А8, В7). Константа `CONTRACT_IDS_V1` (8 id из §Б1-2) живёт в `packages/shared/src/registry/contract-ids.ts` с заголовком «шим интервала А→Б-1: снимается первым актом Б-1 (сид контрактов), тест пиннит равенство множеству строк таблицы после сида».
- **РП-7. Прод-пересев — операция `bun scripts/ops.ts reset-world`** (белый список; требует `--confirm <PROD_REF>`; печатает список таблиц и просит второе подтверждение): `TRUNCATE entities, relations, chat_threads, chat_messages, entity_origins, entity_versions RESTART IDENTITY CASCADE`; `DELETE FROM {property,aspect,relation_role,contract,subscription,action}_definitions WHERE owner_id IS NOT NULL`; `DELETE FROM registry_deltas`; `UPDATE user_settings SET registry_version = 0`; затем сид трёх реестров (system-строки). **Сохраняются:** `user_settings` (кроме версии), `agent_grants`, `oauth_*`, `ai_usage`. Журнал (единицы D42, эскалация) сносится вместе с графом — это и есть «начисто»; названо вслух. Порядок прода: autodeploy off → зелёный полный сьют в ветке → мерж → `ops.ts ping` → `check` → `migrate` (0014–0017) → `reset-world` → `check` → ручной deploy → `/health` без drift → autodeploy on → заход владельца (онбординг сеет граф через исполнителя) → смоук.
- **РП-8. Словарь типов: конфиг `text` получает границу `minLength?`** (класс границ В8: `min/max/maxLength/maxItems`), чтобы не ослаблять валидатор там, где код держит `min(1)` (шесть полей, таблица расхождений Р-17). Расширения kind'ов — ноль.
- **РП-9. `default` в определении свойства — семантика чтения, не записи.** На записи не материализуется (иначе `has(orbis/planned)` стал бы истинным у каждой транзакции и «отсутствие = факт» В5 потеряло бы смысл); читатели трактуют отсутствие как default: SQL — `COALESCE((props->>'<id>')::boolean, false)`, JS — `=== true`. Три несовместимых чтения `planned` сводятся к этой одной форме (Задача 10a/10b). Слой применения default'ов для E — часть Б.
- **РП-10. Псевдо-аспект `''` (расхождение тела) заменяется явным флагом `bodyChanged: true`** в расхождениях предложения/единицы (не пункт предусловия): тело — не свойство, а маркер синтезируется из `STALE_VERSION`. Псевдо-аспект `orbis/entity` → core-свойство `orbis/archived` (§А1-3).
- **РП-11. Q-AST заводится рядом со старым разбором** (Задача 8: `query/ast.ts`, `parseQueryAst`, `printQueryAst`, JSON Schema, фикстуры), старый `QueryAst`/`parseQuery` живут дольше: Задача 9a строит новый компилятор рядом (golden, датасет), 9b переключает сервер (`entity_query`, `materializationWindow`, цели) и удаляет старый компилятор, 10c переводит web query-builder, а старая грамматика (`grammar/parse/serialize`, `buildFieldCatalog`, `propType`, переходный `legacy-bridge` для тел сидов) удаляется Задачей 21 вместе с телами сидов в key-форме.
- **РП-12. Golden запросов — один файл, две проверки** (`test/golden/query-sql.json`: `{name, query, ast, sql, params, countSql?, countParams?}`): парсер `query → ast` и компилятор `ast → sql`; 27 эталонов пересчитываются ВРУЧНУЮ по нормативной таблице семантики (докблок `compile.golden.test.ts:2-4` в силе), новые конструкции (`has`, OR-дерево, `via`, `descendants_of`, `has_children`, `has_relation`) добавляются; мутационная проверка (испорченный SQL/AST обязан упасть) — обязательна.
- **РП-13. Эталон реестра тулов (§С8-2) — снимок при чистом сиде** (`test/golden/tool-registry.json`, 13 встроенных аспектов, без дельт), сравнение `canonicalJson`; побайтный снимок генератора на мок-реестре — часть Б-3 (§Б7-4).
- **РП-14. `property_catalog` — read-тул с флагом `fullScopeOnly: true`**: §А9-4 относит его к скоупу `full`; общий фильтр «любой read — worker'у» получает исключение по флагу в ОБЕИХ линиях — список тулов (`mcp/server.ts:73`) и гейт вызова (`dispatch.ts:202-206`). Рутине (act/propose) тул доступен (чтение).
- **РП-15. Тулы операций реестра в срезе А (через исполнителя, с журналом и undo):** `property_create` (status `active|proposed`), `property_update` (label/description/scope/rank/status-переходы), `property_merge`, `aspect_delta_set`, `aspect_delta_remove`; все — `kind: 'mutate'`, `fullScopeOnly`. tRPC-зеркала в `routers/registry.ts`. Классы подтверждения — Задача 16 по таблице §С2-1.
- **РП-16. Где живёт `registry_version`:** `user_settings.registry_version integer NOT NULL DEFAULT 0` (snake_case явно) + однострочная таблица `registry_system(id smallint PK = 1, version integer, seeded_at)` для глобальной версии сидов; ключ кеша — `(ownerId, ownerVersion, systemVersion)`.
- **РП-17. PRD — одним коммитом с «Пересевом мира», как велит спека (§А12-7/§С10); подготовка и ревью — заранее.** Дифф PRD и runbook (включая фрагмент §7.10 из Задачи 16) готовится и проходит гейт-ревью fable в Задаче 22, хранится в леджере (`prd-reform.diff`) и применяется Задачей 23 в её единственный коммит. Так 315 строк §3 вычитываются не на хвосте ветки, а буква спеки цела. Разбивка на несколько коммитов — только решением владельца правкой §С10 (В-5).
- **РП-18. Промпты меняются один раз — новым файлом:** `prompts/v5.ts` + `v5.fixture.txt` + `v5.test.ts` и `routine-v3.*` (Задача 19), когда все имена тулов, параметры-key и грамматика уже существуют; 0-серия текст промптов не трогает (дата и порядок — динамика канала).
- **РП-19. Добавление варианта select дельтой в срезе А принимается без карты классов** (контрактов ещё нет, слотов нет — `VARIANT_UNMAPPED` §Б2-2 приходит с Б-1); интервал назван в докблоке валидатора дельт.
- **РП-20. Контракт черновиков Т8-в реализуется хранением в черновике `v` и `nodeTypes[]`**: при открытии, если `draft.v < DOC_SCHEMA_VERSION` и все `nodeTypes ⊆ известные ноды текущей схемы` → перештамповка `v` на клиенте и обычный поток сверки; иначе → предложение выбором («оставить черновик как текст / открыть серверное тело»); текст не теряется ни в одной ветке (черновик остаётся в хранилище до явного решения).

## Вопросы владельцу (план исполняется по умолчаниям)

- **В-1. Механизм паузы автодеплоя** — по умолчанию `autoDeploy: false` в `render.yaml` (РП-1). Если предпочтителен тумблер в Render UI — сказать до Задачи 3.
- **В-2. Судьба данных владельца в проде при пересеве** — по умолчанию граф и журнал сносятся (`reset-world`, РП-7); онбординг после захода сеет категории/смарт-листы/тело проекта заново. Если что-то из прод-графа нужно сохранить — нужен экспорт до пересева (`ops.ts` дампа §4.2) и ручной импорт после; план этого не делает.
- **В-3. Наблюдение по §С1-4 (вне скоупа среза А):** прямой счёт даёт 642 места, не 648 (Z3 = 100, не 106); порог П5 при 642 — 321. Пересчёт — к владельцу спеки до гейта.
- **В-5. PRD одним коммитом с пересевом** — умолчание по спеке (РП-17): дифф готовится в Задаче 22, ложится в Задаче 23. Если владелец предпочтёт мержить PRD по частям раньше — правка §С10 спеки, план исполнит.
- **В-4. Имена трёх таймстампов прогона** — спека даёт `orbis/run_started_at`, `orbis/run_finished_at`, но `orbis/last_step_at` (без `run_`). План сеет как в спеке; переименование key дёшево (Р3) — слово за владельцем.

## Глобальные ограничения

- **Ветка `properties-reform-a` от свежего `origin/main`, работа только в worktree**
  (`.claude/worktrees/properties-reform-a`); основное дерево не трогать (владелец пушит
  параллельно); свой `bun install`; корневой `.env` копировать из `apps/server/.env`
  (урок Ф-0 леджера D42); абсолютные пути — только внутрь worktree; параллельные имплементеры
  в одном дереве запрещены; **серверные сьюты делят одну локальную БД — один прогон за раз**
  (рулинг Р6-2 D42: параллельные агенты дали 11 ложных fail).
- **Миграции — ровно четыре, номера 0014, 0015, 0016, 0017** (каталог
  `apps/server/src/db/migrations`, регистрация в `meta/_journal.json` генерацией
  `bun run --filter @orbis/server db:generate` для таблиц из `schema.ts` + рукописный SQL для
  RLS/GRANT/индексов по образцу `0011`/`0013`); файл `0012` НЕ регистрировать. Каждой новой
  таблице — явный `GRANT SELECT, INSERT, UPDATE, DELETE … TO authenticated` (0001:97 не
  покрывает), политики RLS по шаблону `read_builtin_or_own`/`write_own`/`update_own`
  (`0001:80-90`), группа pgTAP (`rls.pgtap.sql`: `plan(N)` на `:6` + список `:53-55` + ожидание
  `:57`), строка в `truncateAll` (`test/helpers.ts:37-40`). 0017 пишется ОДИН раз — по готовому вердикту
  EXPLAIN Задачи 9a (правка накаченной миграции невозможна); локальная база с нуля —
  `bunx supabase db reset && bun run db:prepare`. Обнаружил, что нужна пятая миграция, — стоп,
  доклад координатору.
- **Пересев реестра** — после каждой правки сидов реестров: `bun run db:prepare` (Задача 3
  переводит его на `scripts/seed-registries.ts`); до пересева красные `seed-*.test.ts`,
  `aspect-drift.test.ts`, `registry-drift.test.ts` — не поломка имплементера. На проде —
  только по чек-листу Задачи 23 (РП-7).
- **Мутации графа и реестров — только через executor** (`execute()`); прямые записи в БД —
  только system-строки реестров из админского сида и сообщения тредов
  (`appendMessageIdempotent`).
- **Промпты** — текст `v4.ts`/`routine-v2.ts` и старше не правится ни байтом; новая линейка
  `v5`/`routine-v3` — только Задача 19 (РП-18).
- **Никаких `TODO`/«потом»** внутри задач; «остаток C» и named-future — только с записью
  «почему кодом» в докблоке (правило 5 §С1-4).
- **TDD.** Полный прогон — `bun run test` из корня (голый `bun test` ЗАВИСАЕТ); `bun run lint`
  и `bun run typecheck` — отдельными вызовами; `bun run test:perf` — отдельно (гейт D21);
  `bun run --filter @orbis/web build` + `bun scripts/check-lazy-chunks.ts` — после web-задач;
  `bun run test:perf:graph` (П6, 50k/150k) и `bun run test:perf:explain` (EXPLAIN под RLS) — отдельные
  скрипты ВНЕ CI, гоняются по вехам D и I с записью цифр в `progress.md`.
  Точечный прогон файла: `cd apps/server && bun test src/path/file.test.ts`.
- **Язык кода, комментариев, ошибок, коммитов — русский; комментарий объясняет «почему».**
- **Коммит после каждой задачи** — `git commit -- <пути>`; в сообщении
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`. Мерж в `main` (ff-only) и пуш
  после закрытия задачи (гейт-ревью fable + зелёный CI) — постоянное распоряжение владельца.
  Протокол: `git fetch` → rebase на чистом дереве до диспатча следующего имплементера →
  push ветки → CI → ff-push в `main` (автодеплой выключен — РП-1).
- **Ревью-пакет и учёт ревью** — по `docs/superpowers/templates/orchestrator-prompt.md`
  (экземпляр — `.superpowers/sdd/2026-08-26-properties-reform-a/orchestrator-prompt.md`);
  мутационная проверка деливеребла ревьюером обязательна (урок D42: три Important — «не
  запинен»).
- **Имплементеру передаются** `facts.md` и нужные `plan-recon-*.md` из леджера, не только бриф.

## Карта файлов

| Область | Создать | Изменить |
|---|---|---|
| shared / реестр | `packages/shared/src/registry/{types,property-type,value-schema,builtin-properties,builtin-roles,builtin-aspects,contract-ids,index}.ts` + тесты; `packages/shared/src/query/{ast,ast-json-schema,parse-ast,print,static,ast-fixtures,legacy-bridge}.ts` + тесты (`legacy-bridge` — переходный до 21); `packages/shared/src/registry/{legacy-field-map,tool-schema,contract-ids}.ts` (`legacy-field-map` — переходный до 23) | `aspect-registry.ts` (новая форма `BUILTIN_ASPECT_META`, `diffBuiltinRegistries`), `constants.ts` (`AspectId → string`, `RELATION_TYPES` → роли, `SERVICE_ASPECT_IDS` уходит), `schemas/aspects.ts` (генератор, затем удаление zod-схем), `schemas/entity.ts`, `schemas/relation.ts`, `contracts/tools.ts` (предусловия, `props`, `relation role`, `entity_query {query|ast}`, без `meta`), `contracts/budget.ts:45`, `contracts/agent-loop.ts`, `query/{grammar,parse,serialize,catalog,fixtures}.ts`, `doc/nodes/query-block.ts`, `doc/{convert,diff,types}.ts`, `memory/rule.ts` (удаляется), `fast-path/index.ts`, `index.ts` |
| server / БД | `db/migrations/0014_registries.sql` (+snapshot), `0015_entities_props.sql`, `0016_relations_role.sql`, `0017_reform_contract.sql`; `db/registry-drift.ts`; `scripts/seed-registries.ts`; `scripts/check-legacy-form.ts`; `scripts/probe-openai-schema.ts`; `scripts/probe-p4.ts`; `perf/explain.test.ts`; `perf/graph.test.ts`; `src/test/graph-fixture.ts`; `src/seed/world.ts`; `src/memory/{rules,select}.ts` | `db/schema.ts`, `db/aspect-drift.ts` (→ registry-drift), `scripts/{seed-aspects,ops,setup-db}.ts`, `scripts/test-rls.ts`, `test/rls/rls.pgtap.sql`, `test/helpers.ts`, `src/test/{agent-loop-helpers,perf}.ts`, `app.ts` (/health), `index.ts` |
| server / реестр и исполнитель | `registry/{load,validate-props,cache,ops,deps-graph,version}.ts`; `executor/legacy-form.ts` (переходный, удаляется в 23); `routers/registry.ts`; `tools/registry-tools.ts`; `tools/property-catalog.ts` | `executor/{executor,normalize,invariants,aspects-validate,types,journal,undo}.ts`, `errors.ts`, `wire.ts`, `entity-read.ts`, `export.ts`, `routers/{entity,relation,aspect,ai,user}.ts`, `tools/{registry,dispatch}.ts`, `policy/confirmation.ts`, `agent-loop/{verbs,queries,sweep,rollback}.ts`, `routines/{propose,lifecycle,edits,context,constants,runner}.ts`, `ai/escalation.ts`, `llm/context.ts`, `llm/prompts/{v5,routine-v3}.ts` (новые), `mcp/server.ts` |
| server / домен | — | `budget/{aggregates,binding,plan-to-fact}.ts`, `goals/progress.ts`, `import/review.ts`, `recurring/{materialize,post-due}.ts`, `routers/budget.ts`, `seed/{onboarding,smart-lists,project-body,categories}.ts`, `query/{compile,context}.ts` |
| web | `apps/web/src/lib/registry/{useRegistry,labels,controls}.ts`, `apps/web/src/lib/entity-ref/RefField.tsx` | `lib/field-labels.ts` (оставить `AGGREGATE_LABELS`), `lib/query-blocks/*`, `features/entity-detail/*` (AspectCards, NativeRow, DetailScreen, useEntityDetail, Subtasks, Blocks, Backlinks, useTicketRuns, ProposalOverlay…), `features/browser/*`, `features/agenda/{useAgenda,AgendaScreen}` (механически), `features/budget/*`, `features/chat/**`, `features/import/*`, `features/query-builder/*`, `features/settings/{AspectsList,MemoryScreen}`, `features/entity-editor/{nodes/QueryWidget,useBodySave,draft-storage,slash/items}`, `test/harness.tsx` (фикстуры) |
| docs | `docs/superpowers/specs/assets/2026-08-26-properties-reform/*` | `docs/prd/{00-product,01-architecture,02-core-os,03-budget,04-decision-log}.md`, `docs/implementation/02-ops-runbook.md`, `render.yaml` (РП-1) |

## Порядок и параллельность

```
0-серия (вне гейтов):     0 → {0a ∥ 0b ∥ 0c}                (0a/0b/0c независимы, разные файлы; по одному имплементеру за раз)
Веха A (реестры):         1 → 2 → 3
Веха B (props/CAS/журнал): 4a → 4b → 5 → 6                   (4a требует 1–3; 4b требует 4a; 5 требует 4b; 6 требует 5)
Веха C (роли рёбер):      7a → 7b                             (7a требует 4b; 7b требует 7a)
Веха D (Q-AST):           8 → 9a → 9b → 10a → 10b → 10c       (8 требует 1; 9a требует 7b и 8; 9b требует 9a; 10a/10b требуют 9b; 10c требует 9b)
Веха E (ref):             11                                  (требует 9b, 10b)
Веха F (тулы/wire/web):   12 → 13a → 13b → 13c                (12 требует 5, 11; 13a требует 12, 10c; 13b требует 13a; 13c требует 13b, 11)
Веха G (кеш/реестр/§7.10): 14 → 15 → 16 → 17                  (14 требует 12; 15 требует 14; 16 требует 15; 17 требует 15, 16)
Веха H (память, промпты, документ): 18 → 19 → 20 → 21         (18 требует 11, 13c; 19 требует 12, 15, 18; 20 — web, требует 13c; 21 требует 9b, 10c, 14, 20)
Веха I (документы и пересев): 22 → 23 → 24                    (22 требует всех кодовых; 23 — строго последняя кодовая; 24 — приёмка и деплой)
```
**Все задачи — строго последовательно, один worktree, один имплементер за раз.** Задача 8
(shared Q-AST рядом со старым разбором) технически независима от вех B/C и может быть взята
раньше, если имплементер вехи B ждёт ревью, — но только в ОТДЕЛЬНОМ worktree и с мержем по
протоколу. `tools/dispatch.ts` трогают Задачи 4a, 5, 7a, 12, 15, 16 — только по очереди.

---


## 0-серия (до реформы, вне гейтов части А)

### Задача 0: Подготовка дерева, базовая линия, леджер, пауза автодеплоя

**Файлы:** — (git/worktree, леджер `.superpowers/sdd/2026-08-26-properties-reform-a/`,
`render.yaml`)

- [ ] **Шаг 1:** из основного дерева: `git fetch origin && git worktree add -b properties-reform-a
  .claude/worktrees/properties-reform-a origin/main`. Зафиксировать хеш `origin/main`
  (ожидается `8ff6e22` или новее — main движется параллельными сессиями владельца).
- [ ] **Шаг 2:** в новом дереве `bun install`; `cp apps/server/.env .env` (корневой `.env` нужен
  `setup-db.ts`, в индекс не попадёт — `.gitignore:3`); `bunx supabase status` (стек поднят);
  в `apps/server/.env` есть `DATABASE_URL` и `DATABASE_URL_ADMIN`.
- [ ] **Шаг 3:** `bun run db:prepare`, затем `bun run test`, `bun run lint`, `bun run typecheck`,
  `bun run test:perf`, `bun run --filter @orbis/web build && bun scripts/check-lazy-chunks.ts` —
  код возврата 0 на незанятой машине. Базовые счётчики (pass/файлы по трём пакетам, perf
  медианы, `plan(46)`) — в `progress.md` леджера тем же форматом, что D42
  (`.superpowers/sdd/2026-08-20-deferred-checkpoint/progress.md:14-22`). Ожидание: shared 371,
  web 1055 (+1 skip), server 1635.
- [ ] **Шаг 4:** леджер: `facts.md` (уже создан планом — дописывать рулинги), `progress.md`,
  `orchestrator-prompt.md` (экземпляр шаблона `docs/superpowers/templates/orchestrator-prompt.md`
  с путями этого среза), `make-review-pack.sh` (скопировать из леджера D42 и поправить пути).
- [ ] **Шаг 5 (РП-1, В-1):** в `render.yaml` сервису `orbis` добавить `autoDeploy: false` с
  комментарием «срез реформы свойств: миграции 0014–0017 несовместимы с прод-базой до задачи
  «Пересев мира»; включается обратно её чек-листом» — отдельным docs-коммитом ПРЯМО В `main`
  (не в ветке: правило должно действовать до первого мержа ветки). Убедиться в Render UI
  (владелец или по его слову), что Blueprint-sync применил флаг (Settings → Build & Deploy →
  Auto-Deploy: No). **Машинно-проверяемый исход (находка 52 ревью плана):** после docs-коммита в
  `main` — `mcp__render__get_service` сервиса `orbis` отдаёт `autoDeploy: false` (либо
  `mcp__render__list_deploys`: последний деплой СТАРШЕ коммита, нового не создано). Записать в
  `facts.md`: дата, результат проверки, id последнего деплоя, на котором прод заморожен. Тот же
  чек — первым пунктом перед ff-мержем Задачи 3 в `main`.
- [ ] **Шаг 6:** коммитов в ветке нет (Шаг 5 — в `main`).

---

### Задача 0a: Эталоны проб → репозиторий (`docs/superpowers/specs/assets/2026-08-26-properties-reform/`)

**Зачем:** спека называет jsonc-эталоны проб «отправной точкой» (§Б5-4, §Б3-5, §С9-0), а весь
`.superpowers/` в `.gitignore:24` — норматив не может жить вне git (В6 ревью).

**Файлы:**
- Создать: `docs/superpowers/specs/assets/2026-08-26-properties-reform/README.md`,
  `p1-registry.json`, `p1-schemas.json`, `p1-mutation-check.ts`, `p2-registry.json`,
  `p2-subscription.budget.json`, `p2-01-new-form.sql`, `p2-07-indexes-new.sql`,
  `p2-07-indexes-old.sql`, `p2-07-indexes-drop.sql`, `p2-05-materialize.sql`
- Источники (gitignored, копировать как есть): `.superpowers/probe/p1/{registry.json,
  schemas.json, mutation-check.ts}`, `.superpowers/probe/p2/{registry.json,
  subscription.budget.json, 01-new-form.sql, 07-indexes-new.sql, 07-indexes-old.sql,
  07-indexes-drop.sql, 05-materialize.sql}`.

- [ ] **Шаг 1:** скопировать файлы побайтно (`cp`), в `p1-mutation-check.ts` поправить
  единственный относительный путь `./schemas.json` → `./p1-schemas.json` (строка 4) и добавить
  шапку «исполняемый эталон мутационной проверки П1, 17/17; запуск: `bun p1-mutation-check.ts` из
  каталога assets».
- [ ] **Шаг 2:** `README.md` — провенанс каждого файла (проба, дата 2026-08-25, отчёт
  `reviews/2026-08-25-probe-pN.md`, что именно нормативно) и **перечень расхождений со спекой**,
  чтобы перенесённое не прочитали как норматив формы реестра:
  - `p1-registry.json`: `properties[]` несут ровно 4 ключа (`key/type/label/description`) —
    это НЕ форма `property_definitions` §А2-1 (нет `id/owner_id/status/scope/merged_into/
    module/rank/flags/created_at`); `aspects[].properties[].property` вместо `property_id`, без
    `rank`; kind'ы `integer`/`uuid` вместо `number{integer}`/`grant`; имена
    `orbis/envelope_limit` vs `orbis/limit` (§А8; §А5-3а сама приводит `orbis/envelope_limit` —
    расхождение внутри спеки, действует таблица §А8), `orbis/grant_id` vs `orbis/grant`.
    Нормативно в нём: словарь `type_dictionary` (10+6), состав контрактов/подписок/шаблонов
    как образец нотации для части Б.
  - `p1-schemas.json`: JSON Schema деклараций П1 (`$defs.locstr/proptype/expr`) — образец для
    схем деклараций части Б, не для схем среза А.
  - `p2-01-new-form.sql`: колонка `roles text[]` = `aspects text[]` спеки (оговорка в файле
    `:4-6`); нет `query_refs`, нет реестровых таблиц — DDL-прототип, на котором измерено 1,14×.
  - `p2-07-indexes-*.sql`: доказательство «экспрессионные btree по `props` не заводим» (§А1-4).
  - `p2-05-materialize.sql`: прототип `envelope_spent_cache` (§Б5-5, Б-1).
  - `p2-registry.json`: имена `orbis/category_ref` vs `orbis/finance_category` (§А8);
    `p2-subscription.budget.json` — нормативная подписка Budget §Б5-4 (Б-1).
- [ ] **Шаг 3:** проверить, что JSON парсится: `for f in *.json; do jq -e . "$f" >/dev/null && echo ok $f; done`;
  `bun p1-mutation-check.ts` даёт 17/17.
- [ ] **Шаг 4:** коммит `docs(specs): эталоны проб П1/П2 перенесены в assets реформы (В6 ревью) + README расхождений`.

---

### Задача 0b: Канал LLM — дата владельца и «блок продолжений последний» на собранном канале (§Б7-6 1–2)

**Файлы:**
- Изменить: `apps/server/src/llm/context.ts` (`buildContext` `:349-370`; новый экспорт
  `todaySection`), `apps/server/src/routines/context.ts` (`:272-296` — та же секция),
  `apps/server/src/llm/context.test.ts`, `apps/server/src/routines/context.test.ts` (пин порядка
  `:74`), `apps/server/src/llm/prompts/v4.test.ts` (`:178-183` — гард переезжает),
  `apps/server/src/llm/context.test.ts:78` и `apps/server/src/ai/send-message.test.ts:229` (оба пина
  `startsWith(SYSTEM_PROMPT_V4)` ПЕРЕПИСЫВАЮТСЯ осознанно на `startsWith(PROMPT_BODY)` + пин
  «канал содержит SYSTEM_PROMPT_V4 по частям и заканчивается блоком продолжений» — после split'а
  промпта `startsWith(SYSTEM_PROMPT_V4)` ложно по построению; находка 25 ревью плана).
  `v3.test.ts:147` — близнец гарда на замороженном снимке v3, не трогать.
- Готовый источник даты: `apps/server/src/query/context.ts:13-50` (`ownerTimeZone`, `today`).

**Интерфейсы (produces):**
```ts
// llm/context.ts
/** Строка даты в таймзоне владельца — динамическая секция канала (§Б7-6-1), НЕ часть промпта. */
export function todaySection(input: { today: string; timeZone: string }): string;
// формат: `Сегодня: 2026-08-26 (среда), таймзона владельца: Europe/Moscow.`
/** Заголовок блока продолжений — точная подстрока SYSTEM_PROMPT_V4; пиннится тестом. */
export const CONTINUATIONS_HEADING: string;
export const PROMPT_BODY: string;          // SYSTEM_PROMPT_V4 до CONTINUATIONS_HEADING
export const CONTINUATIONS_BLOCK: string;  // от CONTINUATIONS_HEADING до конца; PROMPT_BODY + CONTINUATIONS_BLOCK === SYSTEM_PROMPT_V4 (пин)
// buildContext: sections = [PROMPT_BODY, todaySection, инструкции аспектов, память, якорь, CONTINUATIONS_BLOCK] —
// текст v4.ts не правится ни байтом (РП-18): переставляется СБОРКА, не константа.
```
Позиция даты — ПОСЛЕ тела промпта; канал начинается с `PROMPT_BODY`.

- [ ] **Шаг 1: падающие тесты** (`llm/context.test.ts`, `routines/context.test.ts`):
```ts
test('канал несёт дату владельца в его таймзоне — после промпта, до инструкций аспектов', …)
// buildContext с timezone 'Asia/Bangkok' и clock 2026-08-26T18:30Z → секция содержит '2026-08-27'
test('блок продолжений — ПОСЛЕДНЯЯ секция собранного канала при непустых памяти и якоре', …)
// system.trimEnd().endsWith(<последняя строка блока продолжений>)
test('routine-канал: дата есть после ROUTINE_SYSTEM_PROMPT; блока продолжений нет (routine-v2.test.ts:95-101 остаётся)', …)
test('CONTINUATIONS_HEADING встречается в SYSTEM_PROMPT_V4 ровно один раз; PROMPT_BODY + CONTINUATIONS_BLOCK === SYSTEM_PROMPT_V4', …)
test('канал начинается с PROMPT_BODY (переписанные пины context.test.ts:78 и send-message.test.ts:229)', …)
```
- [ ] **Шаг 2:** FAIL. — [ ] **Шаг 3:** реализация: `todaySection`; порядок сборки в
  `buildContext` и в `routines/context.ts:272-296`; перенос гарда из `v4.test.ts:178-183` в
  `llm/context.test.ts` на собранный канал (в `v4.test.ts` остаётся пин «промпт содержит блок
  продолжений ровно один раз»).
- [ ] **Шаг 4:** PASS; `bun run test`, `bun run lint`, `bun run typecheck`; коммит
  `feat(llm): дата владельца в системном канале и блок продолжений последним на собранном канале (§Б7-6 1–2, задачи 0-серии)`.

---

### Задача 0c: Греп-гейт §А12-2 как скрипт (режим отчёта) + NUL-байты в `aggregates.ts`

**Зачем:** приёмка §С8-10 требует «ноль совпадений» по маркерам; голый `grep -r` молча
пропускает `budget/aggregates.ts` (два NUL-байта `:904-905` → файл «бинарный»), а маркер
`\.meta\b` ловит `import.meta` (Р-14 таблицы). Гейт заводится сейчас в режиме отчёта, чтобы у
среза была измеренная стартовая цифра, и становится падающим в Задаче 23.

**Файлы:**
- Создать: `scripts/check-legacy-form.ts`, `scripts/check-legacy-form.test.ts`
- Изменить: `apps/server/src/budget/aggregates.ts:904-905` (литеральный NUL в шаблонной
  строке → экранированный ``, как уже сделано в `:491, :506-507`), `package.json`
  (скрипт `check:legacy-form`)

**Интерфейсы (produces):**
```ts
// scripts/check-legacy-form.ts — `bun scripts/check-legacy-form.ts [--gate]`
// Источник — `git grep -na` (`-a`/`--text`: файлы с NUL-байтами сопоставляются С НОМЕРАМИ СТРОК; без флага git grep
// печатает «Binary file … matches» без строк, `-I` выбрасывает признанные двоичными). ПОПРАВКА ЗАДАЧИ 0c (пробой,
// подтверждён ре-ревью): исходное обоснование «`-I` пропустил бы `aggregates.ts`» НЕВЕРНО — git судит о двоичности по
// первым 8000 байтам, а NUL там на 42-килобайтном смещении, и `git grep -nI` находит все 51 строку; молча пропускал
// файл `grep -r` (ugrep 7.8.4 → 0 строк, rc 1). Выбор `-a` от этого не меняется. Отсев не-исходников — pathspec'ом:
// -- 'apps/server/src' 'apps/server/test' 'apps/server/perf' 'packages/shared/src' 'apps/web/src' 'scripts' ':!*.snap' ':!apps/server/src/db/migrations/**'.
export const LEGACY_MARKERS: ReadonlyArray<{ id: string; pattern: string; exclude?: RegExp[] }> = [
  { id: 'aspects-path',    pattern: String.raw`aspects(_legacy)?\s*->` },
  { id: 'aspects-legacy',  pattern: String.raw`aspects_legacy|aspectsLegacy|aspectsMap|legacy-form` },  // aspectsMap живёт 4a→13c: приёмка 13c (Шаг 3) требует его от гейта — рулинг Р-П-4
  { id: 'relation-type',   pattern: String.raw`relation_type|relationType|RELATION_TYPES` },
  // entity-meta — адресуемые формы КОЛОНКИ сущности, не голое слово (голое `\bmeta\b` давало 281 совпадение, из них 41 в миграциях
  // и живые `relations.meta` в executor.ts:182-187/:1154 — находка 26); allowlist Задачи 23 перечисляет места relations.meta с причиной
  { id: 'entity-meta',     pattern: String.raw`entities?\.meta\b|entity_meta_gin|\bmeta:\s*(row|input|values)\.meta\b|input\.meta\b|meta: \{\}` , exclude: [/import\.meta/, /relations?\.meta/, /\bmetadata\b/] },
  { id: 'due-alias',       pattern: String.raw`\bdue=` },
  // голое имя поля в тексте запроса — и в {{query:}}, и в строковых литералах web (useAgenda/txQuery/browser/query — находка 12)
  { id: 'bare-field',      pattern: String.raw`(\{\{query:|aspect=|sortBy=)[^}'"\n]*\b(status|stage|priority|kind|scope|outcome|undecided|due_date|start_at|occurred_on|planned|amount|direction|category_ref)=` },
  { id: 'rule-parser',     pattern: String.raw`parseRuleTitle|formatRuleTitle` },   // rulePatternFromTitle переезжает в server/memory/rules.ts как patternFromTransactionTitle — законен
  { id: 'pseudo-aspect',   pattern: String.raw`ENTITY_PSEUDO_ASPECT|'orbis/entity'` },
  { id: 'service-const',   pattern: String.raw`SERVICE_ASPECT_IDS` },
  { id: 'prop-type-heur',  pattern: String.raw`\bpropType\(` },
];
// Вывод: таблица «маркер → файлов/строк»; с --gate — exit 1 при любом совпадении вне
// allowlist (allowlist — список файлов с причиной внутри скрипта; в Задаче 23 в нём остаются
// тесты грамматики, проверяющие отказ старой формы, и перечисленные места `relations.meta`).
// Маркер `->>'` из §А12-2 НЕ заводится: после перевода `props->>'orbis/…'` — законная форма доступа;
// покрытие старой формы даёт `aspects(_legacy)?\s*->` (оговорка повторена в маппинге приёмки 10).
// Маркер на `aspect=orbis/…` НЕ заводится: `aspect=` — законная конструкция канона (§А5-3в, §А5-7).
```
- [ ] **Шаг 1:** тест скрипта: на синтетическом каталоге (временный git-репозиторий в
  scratch) файл с NUL-байтом и маркером находится; `import.meta.dir` не считается; `--gate`
  даёт exit 1 при совпадении и 0 на чистом дереве.
- [ ] **Шаг 2:** реализация; правка NUL-байтов; прогон отчёта на HEAD — цифры записать в
  `facts.md` как стартовую линию гейта (замер ревью плана по тем же путям: `aspects->` 124 строки /
  15 файлов, `relation_type|relationType` 216 / 68, `parseRuleTitle` 22 / 6 — ориентир, не пин).
- [ ] **Шаг 3:** `bun run test` (aggregates-тесты зелёные после замены разделителя),
  `bun run lint`; коммит `chore: греп-гейт старой формы данных (§А12-2) в режиме отчёта; NUL-байты в aggregates.ts заменены экранированным разделителем`.

---

## Часть А — Веха A: реестры и словарь типов (аддитивно, данные)

### Задача 1: shared — словарь типов, схемы деклараций, встроенные свойства/роли/аспекты новой формы

**Файлы:**
- Создать: `packages/shared/src/registry/types.ts`, `property-type.ts`, `builtin-properties.ts`,
  `builtin-roles.ts`, `builtin-aspects.ts`, `contract-ids.ts` (РП-6), `index.ts`; тесты
  `registry/{property-type,builtin}.test.ts`
- Изменить: `packages/shared/src/index.ts` (реэкспорт `registry`), `packages/shared/src/constants.ts`
  (добавить `RELATION_ROLE_IDS`, `HIERARCHICAL_ROLE_IDS`; `RELATION_TYPES` пока остаётся — снимет
  Задача 7a)
- НЕ трогать: `aspect-registry.ts` (старый `BUILTIN_ASPECT_META` живёт до Задачи 3),
  `schemas/aspects.ts` (zod-схемы — «старый валидатор» golden'а Задачи 2).

**Интерфейсы (produces — на них стоят Задачи 2–23):**
```ts
// registry/types.ts
export const PROPERTY_KINDS = ['text','number','decimal','boolean','date','timestamp','time',
  'select','ref','json','grant','registry_ref'] as const;                 // §А2-2: 10 базовых + время, registry_ref (остальные добавки В8 — конфиги)
export type PropertyKind = (typeof PROPERTY_KINDS)[number];
export type LocalizedText = Record<string, string>;                        // {ru, en, …}; хотя бы одна локаль
export const localizedTextSchema: z.ZodType<LocalizedText>;               // record(min 1 ключ, значения непустые)
export const TEXT_FORMATS = ['url','iana-tz','color','currency','email'] as const;
export const propertyTypeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), pattern?: string, format?: enum(TEXT_FORMATS),
             minLength?: int>=0 /*РП-8*/, maxLength?: int>=1, cardinality?: 'one'|'many', maxItems?: int>=1, minItems?: int>=0 }).strict(),
  z.object({ kind: 'number', min?: number, max?: number, integer?: boolean, cardinality?, maxItems?, minItems? }).strict(),
  z.object({ kind: 'decimal', min?: string, max?: string, exclusiveMin?: string, cardinality?, maxItems?, minItems? }).strict(), // границы — decimal-строки
  z.object({ kind: 'boolean', default?: boolean }).strict(),
  z.object({ kind: 'date' }).strict(), z.object({ kind: 'timestamp' }).strict(), z.object({ kind: 'time' }).strict(),
  z.object({ kind: 'select', options: z.array(z.object({ key: /^[a-z][a-z0-9_-]*$/, label: localizedTextSchema, rank: int }).strict()).min(1),
             cardinality?, maxItems?, minItems? }).strict(),
  z.object({ kind: 'ref', target?: z.unknown() /* Q-AST | Q-AST[] — сужает Задача 8 */, cardinality?: 'one'|'many', max?: int>=1 }).strict(),
  z.object({ kind: 'json', schema?: z.record(z.unknown()), maxItems?: int>=1 }).strict(),
  z.object({ kind: 'grant' }).strict(),
  z.object({ kind: 'registry_ref', target: z.enum(['contract','aspect','property','relation_role']) }).strict(),
]);
export type PropertyType = z.infer<typeof propertyTypeSchema>;
// property-type.ts
export function assertPatternRegular(pattern: string): void;   // отказ PATTERN_NOT_REGULAR на (?=, (?!, (?<=, (?<!, \1..\9 — класс RE2 (паспорт P)
export const propertyDefinitionSchema = z.object({
  id: z.string().min(1), ownerId: z.string().uuid().nullable(),
  key: z.string().regex(/^(orbis|user|[a-z][a-z0-9-]*)\/[a-z][a-z0-9_-]*$/), // namespaced ASCII-слаг (§А2-4)
  label: localizedTextSchema, description: localizedTextSchema,           // description ОБЯЗАТЕЛЕН (Р4)
  type: propertyTypeSchema,
  status: z.enum(['active','proposed','deprecated']),
  storage: z.enum(['props','core']).default('props'),                      // §А1-3 core-проекции
  scope: z.unknown().nullable().default(null),                              // статический Q-AST (сужает Задача 8)
  mergedInto: z.string().nullable().default(null),
  module: z.string().nullable().default(null),
  rank: z.number().int(),
  flags: z.object({ model_writable: z.boolean().optional(), system_writable: z.boolean().optional(),
                    computed: z.object({ rule: z.string() }).strict().optional() }).strict().default({}),
}).strict();
export type PropertyDefinition = z.infer<typeof propertyDefinitionSchema>;
export const aspectPropertyRefSchema = z.object({ propertyId: z.string(), required: z.boolean(), rank: z.number().int() }).strict();
export const aspectDefinitionSchema = z.object({
  id, ownerId, key, label, description,
  properties: z.array(aspectPropertyRefSchema),
  aiInstructions: z.string().nullable(), tagMappings: z.array(z.string()),
  implements: z.array(z.unknown()).default([]),                            // §Б2 — в части А пусто
  viewConfig: z.object({ keyFields: z.array(z.string()), icon: z.string().optional() }).strict(),
  module: z.string().nullable(), service: z.boolean(), rank: z.number().int(),
}).strict();
export type AspectDefinition = z.infer<typeof aspectDefinitionSchema>;
export const relationRoleDefinitionSchema = z.object({
  id, ownerId, key, label, description,
  sourceLabel: localizedTextSchema, targetLabel: localizedTextSchema,     // Ч10-С3
  hierarchical: z.boolean(),
  constraints: z.object({ target_max_incoming?: int>=1, acyclic?: boolean, source_contract?: string,
                          target_contract?: string, created_by?: z.enum(['any','system']) }).strict().default({}),
  symmetric: z.literal(false).default(false),                              // named-future Ч10-С2: поле описано, не реализуется
  module: z.string().nullable(), rank: z.number().int(),
}).strict();
export type RelationRoleDefinition = z.infer<typeof relationRoleDefinitionSchema>;
// builtin-properties.ts — 73 доменных + 4 core (storage:'core'): ТОЧНО по таблице §А8 спеки
// (строки 216–369) с уточнениями РП-8/Р-17 (minLength там, где код держит min(1)):
export const BUILTIN_PROPERTY_META: readonly PropertyDefinition[];
export const CORE_PROPERTY_IDS = ['orbis/archived','orbis/title','orbis/created_at','orbis/updated_at'] as const;
// builtin-roles.ts — 11 системных ролей §А4-3 (+ alternative-of/supersedes):
export const BUILTIN_RELATION_ROLE_META: readonly RelationRoleDefinition[];
export const RELATION_ROLE_IDS = ['subitem','ticket','run','envelope-binding','category-parent','dependency','mention','instance-of','ref','alternative-of','supersedes'] as const;
export const HIERARCHICAL_ROLE_IDS = ['subitem','ticket','run','category-parent'] as const; // envelope-binding НЕ иерархическая (§А4-3)
// builtin-aspects.ts — 13 аспектов новой формы: key = id, label/description ru+en, properties по §А8 (required, rank = порядок строк таблицы),
// aiInstructions/tagMappings/keyFields — перенесены из aspect-registry.ts:18-184 (все 13 keyFields, включая orbis/note :61), service: true только у orbis/agent-run,
// module: schedule/task → 'planner'; financial/budget/category → 'finance'; goal → 'goals'; project/repo → 'ade'; memory → 'memory'; note/assignment/agent-run/routine → null (ядро/ядро-исполнитель §Б8-2)
export const BUILTIN_ASPECT_DEFS: readonly AspectDefinition[];
// contract-ids.ts (РП-6): export const CONTRACT_IDS_V1 = ['orbis/completable','orbis/when','orbis/recurrence','orbis/sensitivity','orbis/money-movement','orbis/envelope','orbis/progress','orbis/categorizable'] as const;
```
Идентификаторы свойств (фиксируются здесь — на них ссылаются все последующие задачи):
`orbis/start_at`, `orbis/end_at`, `orbis/duration_min`, `orbis/all_day`, `orbis/recurrence`,
`orbis/location`, `orbis/timezone`; `orbis/task_status`, `orbis/priority`, `orbis/due_date`,
`orbis/completed_at`, `orbis/effort_min`, `orbis/waiting_for`; `orbis/amount`, `orbis/currency`,
`orbis/direction`, `orbis/finance_category`, `orbis/occurred_on`, `orbis/planned`,
`orbis/recurring`, `orbis/payment_method`, `orbis/counterparty`, `orbis/bank_txn_id`;
`orbis/content_type`, `orbis/pinned`; `orbis/limit`, `orbis/period_start`, `orbis/period_end`,
`orbis/carryover`; `orbis/icon`, `orbis/color`, `orbis/aliases`, `orbis/spend_class`;
`orbis/memory_kind`, `orbis/rule_scope`, `orbis/rule_pattern`, `orbis/rule_target`;
`orbis/progress_source`, `orbis/target_value`, `orbis/current_value`, `orbis/unit`;
`orbis/project_stage`; `orbis/repo_url`, `orbis/default_branch`; `orbis/executor`, `orbis/grant`,
`orbis/assignee`, `orbis/may_close`; `orbis/run_routine`, `orbis/run_bucket`, `orbis/run_attempt`,
`orbis/fail_note`, `orbis/run_proposal`, `orbis/undecided`, `orbis/run_outcome`,
`orbis/run_started_at`, `orbis/run_finished_at`, `orbis/last_step_at`, `orbis/step_count`,
`orbis/run_steps`, `orbis/session_url`, `orbis/run_report`, `orbis/run_checkpoint`,
`orbis/run_reply`, `orbis/run_usage`, `orbis/abandon_note`; `orbis/routine_stage`,
`orbis/routine_at`, `orbis/routine_days`, `orbis/routine_mode`, `orbis/allowed_tools`;
`orbis/parent_project`, `orbis/root_project` (ref, `flags.computed: {rule: 'nearest_ancestor'}`,
`model_writable: false`); core: `orbis/archived` (boolean), `orbis/title` (text), `orbis/created_at`,
`orbis/updated_at` (timestamp). Все свойства `orbis/agent-run` и `orbis/carryover`,
`orbis/bank_txn_id` — `system_writable: true`; `orbis/current_value` — `model_writable: false`.
`orbis/project_id` НЕ заводится (§А8: удаляется). Счёт: 73 = 73 поля − 3 слияния − 1 удаление
+ 4 новых; плюс 4 core = 77 строк.

- [ ] **Шаг 1: падающие тесты** (`registry/builtin.test.ts`, `registry/property-type.test.ts`):
```ts
test('словарь закрыт: неизвестный kind отвергается; известных ровно 12', …)
test('73 доменных свойства + 4 core; id/key уникальны; у всех label.ru, label.en, description.ru, description.en', …)
test('каждый property_id в BUILTIN_ASPECT_DEFS существует; required и порядок rank — по таблице §А8 (снимок ids+required по аспекту)', …)
test('слияния: orbis/finance_category у financial И budget; orbis/currency у обоих; orbis/grant у assignment и agent-run; orbis/project_id отсутствует', …)
test('select-варианты: ASCII key, порядок rank = порядок enum в schemas/aspects.ts (task_status, priority, direction, …)', …) // сортировка смарт-листов — норматив (compile.ts:569-583)
test('decimal: exclusiveMin вместо lookahead; assertPatternRegular отвергает (?= и \1', …)
test('роли: 11 id, hierarchical у subitem/ticket/run/category-parent, target_max_incoming:1 у envelope-binding, acyclic у dependency/category-parent, created_by system у run/envelope-binding/instance-of/ref', …)
test('все 13 keyFields перенесены (включая orbis/note) и равны aspect-registry.ts (пока он жив)', …)
test('CONTRACT_IDS_V1 — ровно 8 id §Б1-2', …)
```
- [ ] **Шаг 2:** FAIL → **Шаг 3:** реализация (ru-label/description — из сегодняшних `name`/
  `description`/`ai_instructions` и полей zod-схем; en — краткий перевод; description каждого
  свойства — одна фраза смысла, не тип).
- [ ] **Шаг 4:** PASS; `bun run test`, `lint`, `typecheck`; коммит
  `feat(shared): словарь типов В8, схемы деклараций реестров, встроенные свойства (73+4), роли (11) и аспекты новой формы (§А2–§А4, §А8)`.

---

### Задача 2: Генератор схем значений из реестра и golden-корпус «сущность → вердикт» (приёмка §С8-1)

**Файлы:**
- Создать: `packages/shared/src/registry/value-schema.ts` (+test),
  `packages/shared/src/registry/legacy-field-map.ts` (переходный; удаляется в Задаче 23),
  `apps/server/src/registry/validate-props.ts` (+test), `apps/server/test/golden/validator-verdicts.json`,
  `apps/server/src/registry/validator-golden.test.ts`
- Изменить: `packages/shared/src/schemas/aspects.ts` (экспорт `legacyAspectJsonSchema` = прежний
  `aspectJsonSchema`; сам `aspectJsonSchema` пока остаётся алиасом — потребители в 20 тестах не
  трогаются), `packages/shared/src/registry/index.ts`

**Интерфейсы (produces):**
```ts
// registry/value-schema.ts
/** JSON Schema значения ОДНОГО свойства по его типу; `x-orbis-type` — копия типа (ref Р1). */
export function propertyValueJsonSchema(type: PropertyType): Record<string, unknown>;
// text.format: url → {format:'uri'}, iana-tz → pattern IANA, color → ^#[0-9a-fA-F]{6}$, currency → ^[A-Z]{3}$;
// decimal → {type:'string', pattern:'^-?\\d+(\\.\\d+)?$'} + x-orbis-decimal {min,max,exclusiveMin} (числовые границы проверяет validate-props через decCmp, НЕ ajv);
// cardinality many → {type:'array', items, minItems, maxItems}; select → enum ключей; ref → uuid (many → array uuid);
// registry_ref/grant → string (существование — сервер); json → schema как есть либо {type:'object'}.
// registry/legacy-field-map.ts (переходный, РП-3)
export function legacyFieldToProperty(aspectId: string, field: string): string | undefined;    // ('orbis/task','status') → 'orbis/task_status'; ('orbis/budget','category_ref') → 'orbis/finance_category'; ('orbis/agent-run','project_id') → undefined
export function propertyToLegacyField(propertyId: string, aspectId: string): string | undefined;
export function legacyAspectsToProps(aspects: Record<string, Record<string, unknown>>):
  { ok: true; props: Record<string, unknown>; aspects: string[] } | { ok: false; conflict: { propertyId: string; values: unknown[] } };
// конфликт — одно слитое свойство с разными значениями в двух аспектах (В1: невыразимо) → VALIDATION
// apps/server/src/registry/validate-props.ts
export interface PropsRegistry { properties: Map<string, PropertyDefinition>; aspects: Map<string, AspectDefinition>; }
export type PropsViolation =
  | { code: 'UNKNOWN_PROPERTY'; propertyId: string }
  | { code: 'TYPE'; propertyId: string; message: string }
  | { code: 'REQUIRED'; aspectId: string; propertyId: string }
  | { code: 'UNKNOWN_ASPECT'; aspectId: string }
  | { code: 'DEPRECATED'; propertyId: string };            // deprecated: запись нового значения — отказ, чтение живо (§А10-3)
export function validateEntityProps(reg: PropsRegistry, entity: { props: Record<string, unknown>; aspects: string[] }): PropsViolation[];
// ajv по propertyValueJsonSchema, кеш валидатора по тексту схемы (перенос aspects-validate.ts:48-67 дословно), decimal-границы — decCmp
```
- [ ] **Шаг 1: golden-корпус.** Собрать `validator-verdicts.json`: для каждого из 13 аспектов —
  позитивные фикстуры (из `schemas/aspects.test.ts`, `query/fixtures.ts` — 10 сущностей,
  `src/test/perf.ts` — по одной на аспект) и негативные (каждое `required` пропущено; каждый
  `enum` с чужим значением; `amount: '0'`, `'-1'`, `'abc'`; `aliases` из 51 элемента; `repo url`
  не-URL; `timezone` не-IANA; `currency 'rub'`; `days: []`; `bucket` не по паттерну; поле
  неизвестного имени). Каждая запись: `{name, aspects: <старая карта>, legacyVerdict: ok|reject,
  newVerdict: ok|reject, expectedDiff?: <причина из списка ниже>}`. Список **ожидаемых
  расхождений** (новые ужесточения §А8/М2, Р-17): `aliases > 50`, `repo_url` не URL, `timezone`
  не IANA, `currency` не `^[A-Z]{3}$`, `orbis/project_id` (неизвестное свойство — отказ вместо
  приёма). Всё остальное — вердикты ОБЯЗАНЫ совпасть.
- [ ] **Шаг 2: падающие тесты:**
```ts
test('golden: старый валидатор (zod ASPECT_SCHEMAS) и новый (validateEntityProps через legacyAspectsToProps) дают одинаковые вердикты на всём корпусе, кроме перечисленных expectedDiff', …)
test('мутационная проверка: испорченная фикстура (required убран) меняет вердикт нового валидатора', …)
test('legacyAspectsToProps: financial+budget с разной finance_category → conflict; с одинаковой → одно свойство', …)
test('propertyValueJsonSchema(decimal exclusiveMin 0): "0" → отказ через decCmp, "0.01" → ок; паттерн без lookahead', …)
test('unknown property / unknown aspect / deprecated — коды', …)
```
- [ ] **Шаг 3:** реализация. — [ ] **Шаг 4:** PASS; `bun run test`, `lint`, `typecheck`;
  коммит `feat(registry): схемы значений из словаря типов и валидатор props; golden-корпус «сущность → вердикт» на старом и новом валидаторе (приёмка §С8-1)`.

---

### Задача 3: Миграция 0014 — реестры; сидер трёх реестров; drift/`/health`/`ops.ts check` на пять реестров; коды ошибок реформы

**Файлы:**
- Создать: `apps/server/src/db/migrations/0014_registries.sql` (+ `meta/0014_snapshot.json`,
  журнал), `apps/server/src/db/registry-drift.ts` (+test), `scripts/seed-registries.ts`,
  `apps/server/test/seed-registries.test.ts`, `apps/server/src/registry/load.ts` (+test),
  хелпер `apps/server/test/helpers.ts: seedCustomAspect(ownerId, {key, label, properties: [{key, type, required?}]})`
  — пишет property-строки владельца И аспект новой формы (фикстуры кастомного аспекта
  `registry.test.ts:64-68`, `dispatch.test.ts:74-78`, `mcp.test` переводятся на него — находка 6
  ревью плана; Задачи 4b/12 на него ссылаются)
- Изменить: `apps/server/src/db/schema.ts` (новые таблицы + `aspect_definitions` новой формы +
  `user_settings.registry_version` + `registry_system`), `packages/shared/src/aspect-registry.ts`
  (`BUILTIN_ASPECT_META` → реэкспорт `BUILTIN_ASPECT_DEFS`; `diffBuiltinAspects` →
  `diffBuiltinRegistries` — двусторонняя), `packages/shared/src/constants.ts` (`AspectId`
  остаётся для констант, API принимают `string`), `scripts/seed-aspects.ts` (удалить; `db:prepare`
  зовёт `seed-registries.ts` — `package.json:15`), `scripts/ops.ts` (`check :94-114`,
  `seed-aspects :166-185` → `seed-registries`; белый список `:495-517`), `apps/server/src/db/aspect-drift.ts`
  (→ `registry-drift.ts`; `app.ts:203-225` поле `registryDrift`; `index.ts:31-34`),
  `apps/server/test/rls/rls.pgtap.sql` (`plan(N)`, список таблиц `:53-55`/`:57`, группы на 7
  таблиц по образцу `:276-317`), `apps/server/test/helpers.ts:35-41` (`truncateAll`: `DELETE … WHERE owner_id IS NOT NULL` для
  ШЕСТИ definition-таблиц + `TRUNCATE registry_deltas`; `registry_system` из очистки исключён
  намеренно — одна строка, PK=1),
  `apps/server/src/errors.ts:15-23, :48-60` (коды реформы), `apps/server/src/tools/registry.ts:960-1008`
  (`loadAspectToolRows` читает `schema` — колонка остаётся; `description` теперь jsonb — берётся
  `description.ru`), `apps/server/src/wire.ts:208-238` (`WireAspectDefinition` новой формы),
  `apps/server/src/routers/aspect.ts`, `apps/web/src/lib/query-blocks/catalog.ts:7-17` и
  `useFieldCatalog.ts` (читают `d.schema` — остаётся), `apps/web/src/features/settings/AspectsList.tsx:5-14`
  (`name` → `label.ru`), тесты: `aspect-drift.test.ts` → `registry-drift.test.ts`,
  `seed-aspects.test.ts` → `seed-registries.test.ts`, `aspect-registry.test.ts`, `export.test.ts`.

**Интерфейсы (produces):**
```sql
-- 0014_registries.sql (рукописная часть по образцу 0011/0013; таблицы — из schema.ts генерацией)
CREATE TABLE property_definitions (id text NOT NULL, owner_id uuid, key text NOT NULL, label jsonb NOT NULL,
  description jsonb NOT NULL, type jsonb NOT NULL, status text NOT NULL DEFAULT 'active'
  CHECK (status IN ('active','proposed','deprecated')), storage text NOT NULL DEFAULT 'props' CHECK (storage IN ('props','core')),
  scope jsonb, merged_into text, module text, rank integer NOT NULL, flags jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now());
CREATE UNIQUE INDEX property_definitions_builtin_uniq ON property_definitions (id) WHERE owner_id IS NULL;
CREATE UNIQUE INDEX property_definitions_custom_uniq  ON property_definitions (owner_id, id) WHERE owner_id IS NOT NULL;
CREATE UNIQUE INDEX property_definitions_builtin_key  ON property_definitions (key) WHERE owner_id IS NULL;
CREATE UNIQUE INDEX property_definitions_custom_key   ON property_definitions (owner_id, key) WHERE owner_id IS NOT NULL;
-- «уникален среди видимого владельцу» (встроенные ∪ свои) — проверка приложения при create/rename key (Задача 15)
CREATE TABLE relation_role_definitions (… id, owner_id, key, label, description, source_label jsonb, target_label jsonb,
  hierarchical boolean NOT NULL DEFAULT false, constraints jsonb NOT NULL DEFAULT '{}', symmetric boolean NOT NULL DEFAULT false,
  module text, rank integer NOT NULL, created_at …) + те же две partial-уникальности;
CREATE TABLE contract_definitions (id, owner_id, key, label, description, kind text NOT NULL CHECK (kind IN ('slots','facts')),
  slots jsonb, classes jsonb, sets jsonb, facts jsonb, module text, rank integer NOT NULL, created_at) — ПУСТАЯ в срезе А (§А12-1);
CREATE TABLE subscription_definitions (id, owner_id, surface text NOT NULL, definition jsonb NOT NULL, module, rank, created_at) — ПУСТАЯ;
CREATE TABLE action_definitions (id, owner_id, key, label, description, params jsonb, precondition jsonb, steps jsonb,
  sensitivity jsonb, offered_by jsonb, module, batch_cap integer, created_at) — ПУСТАЯ;
CREATE TABLE registry_deltas (id uuid PRIMARY KEY, owner_id uuid NOT NULL, target_kind text NOT NULL
  CHECK (target_kind IN ('property','aspect','contract','relation_role','subscription','action')), target_id text NOT NULL,
  base_version integer NOT NULL, delta jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, target_kind, target_id));
CREATE TABLE registry_system (id smallint PRIMARY KEY CHECK (id = 1), version integer NOT NULL DEFAULT 0, seeded_at timestamptz);
INSERT INTO registry_system (id, version) VALUES (1, 0);
ALTER TABLE user_settings ADD COLUMN registry_version integer NOT NULL DEFAULT 0;   -- snake_case явно (РП-16)
-- aspect_definitions → новая форма: DELETE FROM aspect_definitions (все строки; сид следом обязателен — как сегодня, drift кричит до сида);
-- DROP name, namespace, description, icon; ADD key text NOT NULL, label jsonb NOT NULL, description jsonb NOT NULL,
-- properties jsonb NOT NULL DEFAULT '[]', implements jsonb NOT NULL DEFAULT '[]', module text, service boolean NOT NULL DEFAULT false,
-- rank integer NOT NULL DEFAULT 0; schema jsonb → DROP NOT NULL (носитель старой формы до 0017, Р-24); ai_instructions/tag_mappings/aggregations/view_config/created_at — как были.
-- GRANT SELECT, INSERT, UPDATE, DELETE ON <каждая новая таблица> TO authenticated; RLS ENABLE + FORCE;
-- политики: read_builtin_or_own / write_own / update_own / delete_own (owner_id = auth.uid()) на пяти реестрах;
-- registry_deltas — owner-политики; registry_system — SELECT всем, записи только service-role (политик INSERT/UPDATE нет).
```
```ts
// apps/server/src/registry/load.ts
export interface RegistrySnapshot { properties: Map<string, PropertyDefinition>; aspects: Map<string, AspectDefinition>;
  roles: Map<string, RelationRoleDefinition>; ownerVersion: number; systemVersion: number; }
export async function loadRegistry(tx: Tx, ownerId: string): Promise<RegistrySnapshot>;   // system ⊕ свои строки (дельты — Задача 14); один раз на tx исполнителя (рядом с loadAspectRegistry — executor.ts:283/:385)
// packages/shared/src/aspect-registry.ts
export function diffBuiltinRegistries(db: { properties: Row[]; aspects: Row[]; roles: Row[]; contracts: Row[]; subscriptions: Row[]; actions: Row[] }):
  Record<'properties'|'aspects'|'roles'|'contracts'|'subscriptions'|'actions', { missing: string[]; drifted: { id: string; what: string[] }[]; extra: string[] }>;
  // ДВУСТОРОННЯЯ: лишняя system-строка — дрейф (Р-23); contracts/subscriptions/actions: ожидание — пусто («пять реестров» спеки + таблица действий)
// scripts/seed-registries.ts (админ-DSN): upsert 77 свойств, 11 ролей, 13 аспектов (schema := legacyAspectJsonSchema(id)), затем UPDATE registry_system SET version = version + 1, seeded_at = now()
// errors.ts: ExecErrorCode += 'COMPUTED_WRITE' | 'ROLE_SYSTEM_ONLY' | 'SCOPE_NOT_STATIC' | 'QUERY_JOIN' | 'QUERY_MULTI_ROLE' | 'REGISTRY_LIMIT' | 'REGISTRY_CONFLICT';
// TRPC: COMPUTED_WRITE/ROLE_SYSTEM_ONLY → FORBIDDEN; SCOPE_NOT_STATIC/QUERY_JOIN/QUERY_MULTI_ROLE → BAD_REQUEST; REGISTRY_LIMIT → TOO_MANY_REQUESTS; REGISTRY_CONFLICT → CONFLICT
```
- [ ] **Шаг 1: падающие тесты:**
```ts
// seed-registries.test.ts: множество id system-строк (owner_id IS NULL) = ровно BUILTIN_* (77/11/13), contract/subscription/action без system-строк; version ОТНОСИТЕЛЬНО: after === before + 1 (db:prepare уже сеял, truncateAll registry_system не трогает — находка 50); повторный сид идемпотентен (строки те же, version ещё +1)
// registry-drift.test.ts: (а) чистый сид → ok; (б) UPDATE label одного свойства → drifted; (в) лишняя system-строка `orbis/zzz` → extra; (г) system-строка в contract_definitions/action_definitions → extra; (д) БД недоступна → status 'unknown' (три состояния — как aspect-drift сегодня)
// registry.test/dispatch.test/mcp.test: фикстура кастомного аспекта — через seedCustomAspect (attach_user_sleep_log живёт)
// rls.pgtap.sql: на каждую новую таблицу — RLS ENABLE+FORCE, чужие строки невидимы, system-строки видимы всем, запись system-строки под authenticated — отказ; список «18 таблиц»
// load.test.ts: loadRegistry возвращает system ⊕ свои; своё свойство с тем же id, что system, — отказ уникальности
// errors.test: новые коды в TRPC_CODE_BY_EXEC (Record исчерпывающий — typecheck)
// web: AspectsList рендерит label.ru; useFieldCatalog по-прежнему строит каталог из d.schema
```
- [ ] **Шаг 2:** FAIL → **Шаг 3:** реализация; `bun run db:prepare` (пересев обязателен).
- [ ] **Шаг 4:** PASS; `bun run test`, `lint`, `typecheck`, `test:rls`; коммит
  `feat(db): миграция 0014 — реестры свойств/ролей/контрактов/подписок/действий, дельты, registry_version; сидер трёх реестров; drift, /health и ops.ts check на пять реестров; коды ошибок реформы`.

---

## Веха B: `props` + `aspects[]` (expand), предусловия по свойству, журнал/undo по свойству

### Задача 4a: Миграция 0015 (expand) и переходный модуль `legacy-form` — механическая часть: поведение не меняется

**Зачем разрезано:** смена формы колонки + переписанный конвейер в одном диффе не ревьюируемы
(ревью плана, находка 49). 4a меняет ТОЛЬКО носитель и имена — каждый сьют зелёный тем же
поведением; 4b меняет семантику исполнителя.

**Файлы:**
- Создать: `apps/server/src/db/migrations/0015_entities_props.sql` (+snapshot), `apps/server/src/executor/legacy-form.ts`
  (+test; переходный, удаляется в Задаче 23)
- Изменить: `apps/server/src/db/schema.ts` (`entities`: `aspectsLegacy: jsonb('aspects_legacy')`,
  `props: jsonb('props')`, `aspects: text('aspects').array()`, `queryRefs: text('query_refs').array()`),
  `apps/server/src/executor/types.ts:64-83` (`WireEntity`: `+props`, `+aspects: string[]`, `+queryRefs`,
  старая карта → `aspectsMap`), `packages/shared/src/schemas/entity.ts:18-19` (`entitySchema` переходной
  формы — см. «Интерфейсы»), `apps/server/src/wire.ts:31-47, :66-81`, `apps/server/src/entity-read.ts:109`,
  `apps/server/src/query/compile.ts` — **все 11 обращений к колонке `aspects`** (`:62` SELECT-лист
  `aspects_legacy AS aspects`, `:215` служебные `?|`, `:235` `aspect=` `?`, `:254` excludeBlocked,
  `:300-321` путь к полю, `:342-357` containment `@>`, `:517` numericExpr) — механически на
  `aspects_legacy`; `apps/server/src/llm/context.ts:113-136` (`loadMemory`: `entities.aspectsLegacy ?
  'orbis/memory'`, чтение карты), `apps/server/src/routers/entity.ts:126` (подсказки статуса —
  `row.aspectsLegacy`), `seed/onboarding.ts:99-125` (INSERT пишет три колонки через проекцию),
  `src/test/perf.ts` (то же), `src/test/agent-loop-helpers.ts:104-110` (`aspectsOf()` читает
  `aspectsLegacy`; новый `propsOf()` — пока проекция), все raw SQL `aspects` → `aspects_legacy`
  (`agent-loop/queries.ts` 11 SQL, `routines/lifecycle.ts:1287-1289`, `agent-loop/rollback.ts:180-182`,
  `ai/escalation.ts:211,:241`, `invariants.ts:222`, `import/review.ts`, `budget/*`, `recurring/*`,
  `goals/progress.ts`, `dispatch.ts:1363,:1512`), **все продовые и тестовые читатели `row.aspects`
  как карты** (приёмка шага — `bun run typecheck` без единой ошибки: `string[]` не индексируется
  строкой и не приводится к `Record`, компилятор найдёт каждое место), web: 15 кастов `… as Record<…>`
  (`AspectCards.tsx:84`, `NativeRow.tsx:183`, `DetailScreen.tsx:258`, `EntityRow.tsx:36`,
  `CategoryScreen.tsx:134,346`, `TransactionsScreen.tsx:320,339`, `usePlanToFactPrompt.ts:21`,
  `useAgenda.ts:55`, `categories.ts:62`, `QuickAddBar.tsx:82`, `MemoryScreen.tsx:37`,
  `EnvelopeCreateSheet.tsx:120`, `EnvelopeCard.tsx:110`) и ≈43 чтения `.aspects` в web вне тестов
  (приёмники `entity./e./c./category./loaded./run./next./last./f./created./card.`) → `aspectsMap`;
  фикстуры web (25 файлов `aspects: {…}` → `aspectsMap`) — поведение web НЕ меняется.

**Интерфейсы (produces):**
```sql
-- 0015_entities_props.sql
ALTER TABLE entities RENAME COLUMN aspects TO aspects_legacy;
ALTER INDEX entities_aspects_gin RENAME TO entities_aspects_legacy_gin;
ALTER TABLE entities ADD COLUMN props jsonb NOT NULL DEFAULT '{}', ADD COLUMN aspects text[] NOT NULL DEFAULT '{}',
  ADD COLUMN query_refs text[] NOT NULL DEFAULT '{}';
CREATE INDEX entities_props_gin ON entities USING gin (props);            -- §А1-4; судьба — EXPLAIN-приёмка (Задача 9a → 0017)
CREATE INDEX entities_aspects_gin ON entities USING gin (aspects);        -- text[] — тот же класс
CREATE INDEX entities_query_refs_gin ON entities USING gin (query_refs);
-- Данных не конвертируем (база пересевается; локальные строки — truncateAll/db:prepare). До 4b новые колонки пусты.
```
```ts
// packages/shared/src/schemas/entity.ts — ПЕРЕХОДНАЯ форма wire до Задачи 13c (находка 17 ревью плана):
export const entitySchema = z.object({ …, props: z.record(z.unknown()).default({}), aspects: z.array(z.string()).default([]),
  queryRefs: z.array(z.string()).default([]), aspectsMap: z.record(z.any()).default({}), meta: z.record(z.any()).default({}) /* до 13c */, … });
// executor/legacy-form.ts — ПЕРЕХОДНЫЙ (удаляется Задачей 23; ноль импортов = гейт). ИМПОРТИРУЕТ legacyFieldToProperty/
// propertyToLegacyField/legacyAspectsToProps из @orbis/shared (Задача 2) — второй таблицы соответствий НЕТ (находка 53).
export function projectLegacyAspects(reg: RegistrySnapshot, state: { props: Record<string, unknown>; aspects: string[] }): Record<string, Record<string, unknown>>;
//   для каждого аспекта из state.aspects — {legacyField: props[propertyId]} по propertyToLegacyField; свойства без носителя в карту не попадают
export function projectLegacyRelationType(role: string): 'parent' | 'blocks' | 'related_to' | 'derived_from' | 'ref';
//   ТОТАЛЬНО для всех 11 ролей: subitem/ticket/run/envelope-binding/category-parent → parent; dependency → blocks; mention/alternative-of/supersedes → related_to; instance-of → derived_from; ref → ref (находка 18); тест на все 11
export function rowFromLegacy(reg, legacyMap): { props; aspects; aspectsLegacy } // для фикстур/сидов с прямым INSERT: пишет ТРИ колонки
```
- [ ] **Шаг 1: падающие тесты** (`legacy-form.test.ts`, `wire.test.ts`):
```ts
test('projectLegacyRelationType тотальна на RELATION_ROLE_IDS (11)', …)
test('rowFromLegacy(financial+budget одной категории) → props по id, aspects[] и карта, равная входу', …)
test('wire: aspectsMap = карта из aspects_legacy; props/aspects/queryRefs едут (пока пустые); meta едет', …)
```
- [ ] **Шаг 2:** миграция 0015; `bun run db:prepare`; sed по raw SQL, переименование поля в Drizzle,
  починка ВСЕХ ошибок `bun run typecheck` (сервер + web) на `aspectsLegacy`/`aspectsMap`.
- [ ] **Шаг 3:** `cd apps/server && bun test src/query/` (golden 27 и датасет 21 — зелёные на
  `aspects_legacy`), затем `bun run test` (все три пакета), `test:perf`, web build, `lint`,
  `typecheck`; коммит `chore(db): миграция 0015 — props/aspects[]/query_refs рядом с aspects_legacy; переходный модуль legacy-form; wire.aspectsMap; читатели и raw SQL переведены механически (РП-2, поведение не изменено)`.

---

### Задача 4b: Исполнитель пишет `props`/`aspects[]`; валидация по реестру; гейты флагов; ось `mechanism`; внутренняя форма входа

**Файлы:**
- Создать: `apps/server/src/executor/props.ts` (+test)
- Изменить: `apps/server/src/executor/{executor,normalize,invariants,aspects-validate,types}.ts`,
  `executor/legacy-form.ts` (+`legacyPatchToProps`, +`fromLegacyInput`), `packages/shared/src/contracts/tools.ts`
  (exec-надмножества `entityCreateExecInput`/`entityUpdateExecInput` — union старой карты и новой
  формы; LLM-контракты `entityCreateInput`/`entityUpdateInput` НЕ меняются до Задачи 12),
  `seed/onboarding.ts`, `src/test/perf.ts`, `src/test/agent-loop-helpers.ts` (`propsOf()` читает
  `props`), `apps/server/test/helpers.ts` (`seedCustomAspect` из Задачи 3 — с property-строками),
  тесты executor (55), normalize, invariants, aspects-validate (6), relations (21), batch (12),
  `binding.test.ts:941-980` (страж контура), `journal.test.ts` (форма записи — `mechanism`).

**Интерфейсы (produces):**
```ts
// executor/types.ts
export type MutationMechanism = 'user' | 'hook' | 'rule' | 'materialize' | 'seed' | 'action-seed' | 'verb' | 'import'; // РП-4 (перечень §А4-4)
export interface ExecuteRequest { …; mechanism?: MutationMechanism /* default 'user' */ }
export interface ActionRecord { …; mechanism: MutationMechanism }         // пишется в журнал; пины journal.test обновляются
// contracts/tools.ts — ВНУТРЕННЯЯ форма входа (exec/UI-надмножества; с этой задачи — находки 1/2 ревью плана):
export const entityPropsPatch = z.object({ props?: z.record(z.unknown()) /* по id ИЛИ key — резолв на границе */, unset?: z.array(z.string()),
  aspects?: z.object({ attach?: z.array(z.string()), detach?: z.array(z.string()) }).strict() }).strict();
// entityCreateExecInput = old ∪ {props, aspects: string[] (attach)}; entityUpdateExecInput = old ∪ entityPropsPatch — union; старая карта `aspects: {id: {field}}`
// принимается через fromLegacyInput() до Задачи 13c (web) / 18 (MemoryRuleCard); внутренние вызыватели переводятся на новую форму по мере задач (5, 6, 7a, 10a/10b, 11)
// executor/props.ts — внутренняя модель исполнителя
export interface EntityState { props: Record<string, unknown>; aspects: string[] }
export type PropsPatch = { set?: Record<string, unknown>; unset?: string[]; attach?: string[]; detach?: string[] };
export function applyPropsPatch(cur: EntityState, patch: PropsPatch): EntityState;  // detach аспекта НЕ снимает значения (Р9); unset — явное снятие свойства
export function touchedProperties(patch: PropsPatch): Set<string>;
export function resolvePropertyRef(reg: RegistrySnapshot, keyOrId: string): PropertyDefinition | undefined;  // key среди system ∪ свои, затем id
// executor/legacy-form.ts
export function legacyPatchToProps(reg, patch: Record<string, Record<string, unknown> | null>): PropsPatch;
//   {aspect: null} → detach; {aspect: {field: null}} → unset(property); {aspect: {field: v}} → set + attach(aspect); неизвестная пара → VALIDATION UNKNOWN_PROPERTY
// aspects-validate.ts → validateEntityProps (Задача 2) по loadRegistry (Задача 3) вместо ajv по aspect_definitions.schema; кеш валидаторов — как был.
// Флаги (§А2-5/Б6): set свойства с flags.model_writable === false → ExecError 'COMPUTED_WRITE' при mechanism ∉ {rule, materialize};
// set свойства с flags.system_writable → допускается только при mechanism ∈ {hook, rule, materialize, seed, action-seed, verb, import}, иначе 'COMPUTED_WRITE' с details.reason='system_writable'.
// internalUndo эти гейты ПРОПУСКАЕТ (как семь проверок сегодня — executor.ts:1245…1442): откат законно записанного состояния обязан проходить.
```
Что переводится семантически: `mergeAspects` (`normalize.ts:33-51`) → `applyPropsPatch`; три ветки
установки (`executor.ts:1280`, undo-замена `:1267-1278`, attach `:1557`); валидация в трёх точках
(`:1045`, `:1302`, `:1554`); `applyTaskCompletion` (`normalize.ts:57-69` → `orbis/task_status`/
`orbis/completed_at`), `financialRecurringNeedsDerivedFrom :87`, `assertFinancialInvariant :99-120`
(`orbis/occurred_on`, `orbis/planned` — РП-9), `needsProjectSeed :151` (`aspects.includes('orbis/project')`);
`assertAssignment` (`invariants.ts:296-327` → `orbis/executor`/`orbis/grant`), `assertRunSubject :344-357`
(`orbis/grant` XOR `orbis/run_routine`), `assertRoutineUntouchable :408-442` (по `aspects[]`),
`assertSingleBudgetParent :208-244` (`'orbis/budget' = ANY(aspects)`; роль — Задача 7a);
`touchesBudgetContour :507-519` → по множеству property-id аспектов financial/budget из реестра +
attach/detach этих аспектов (Р-27); `resolveAttachAspect :568-573` — по key аспекта из реестра;
запись `meta` (`:1131`, `:1475-1479`) прекращается (колонка до 0017, всегда `{}`); исполнитель
пишет `props`/`aspects` И `aspects_legacy := projectLegacyAspects(...)` (дуальная запись до 23);
журнал/inverse — ПОКА аспект-ключом из проекции (единица «свойство» — Задача 6); CAS — ПОКА старая
форма над проекцией (Задача 5).

- [ ] **Шаг 1: падающие тесты:**
```ts
test('entity_create со старым патчем aspects → props по id, aspects[] и aspects_legacy = projectLegacyAspects(props, aspects)', …)
test('entity_create с новой формой {props:{"orbis/amount":"10",…}, aspects:["orbis/financial"]} (exec-вход) → та же строка; key и id принимаются', …)
test('инвариант проекции: после КАЖДОЙ мутации (create/update/attach/detach/undo) aspects_legacy === projectLegacyAspects(...) — property-тест на 50 случайных патчах', …)
test('financial+budget с разной category_ref в одном create → VALIDATION (В1)', …)
test('detach аспекта оставляет значения свойств (Р9); explicit unset снимает свойство', …)
test('запись orbis/current_value из тула → COMPUTED_WRITE; из mechanism rule — проходит', …)
test('запись orbis/run_report с mechanism user → COMPUTED_WRITE (system_writable); с mechanism verb — проходит', …)
test('internalUndo восстанавливает состояние с system_writable-свойствами без гейта', …)
test('touchesBudgetContour: патч orbis/amount берёт замок контура; патч orbis/priority — нет (страж binding.test.ts:941-980 зелёный)', …)
test('кастомный аспект (seedCustomAspect) с {hours: 7} проходит валидацию по property-строкам владельца; неизвестный key → UNKNOWN_PROPERTY', …)
test('validate: REQUIRED по аспекту, UNKNOWN_PROPERTY, TYPE — коды VALIDATION с details.violations', …)
```
- [ ] **Шаг 2:** FAIL → **Шаг 3:** реализация. — [ ] **Шаг 4:** PASS всех сьютов + `test:perf`;
  `lint`, `typecheck`; коммит
  `feat(executor): исполнитель пишет props по id и aspects[]; валидация по реестру свойств; гейты model_writable/system_writable; ось mechanism; внутренняя форма входа props/unset/aspects (§А1, §А2-5, §А7-1)`.

---

### Задача 5: Предусловия CAS по свойству `{property, in|absent}`, сравнение по типу, core-свойства, снятие псевдо-аспектов (приёмка §С8-6)

**Файлы:**
- Изменить: `packages/shared/src/contracts/tools.ts:82-141` (union, `PreconditionMismatch`,
  докблок), `apps/server/src/executor/executor.ts:858, :880-934` (`assertPrecondition` — по
  свойству над `props`; core через `CORE_PROPERTY_IDS`; сравнение `comparePropertyValue(type, a, b)`),
  `apps/server/src/executor/props.ts` (`comparePropertyValue`), 18 писателей: `routines/propose.ts:551-597`
  (генератор `:570-577` — по property-id; патчи предложения переводятся на новую внутреннюю форму
  `entityPropsPatch` Задачи 4b), `routines/lifecycle.ts:363,380,643,1096,1833,2055`,
  `agent-loop/verbs.ts:310-315,439-443,627-631,807,830-835,976`, `agent-loop/sweep.ts:136-139,166`,
  `routers/agent-run.ts:130-136,151`, `tools/dispatch.ts:1171-1174` (`orbis/entity`→`orbis/archived`);
  читатели провалов по имени поля `verbs.ts:186-192, :665-674, :855-859` (→ property-id
  `orbis/step_count`/`orbis/run_outcome`); `routines/lifecycle.ts:2468-2487` и
  `apps/web/src/features/chat/cards/proposal-text.ts:95-97`, `ProposalOverlay.tsx:705-712` (маркер
  `''` → `bodyChanged: true`, РП-10); `apps/web/src/lib/field-labels.ts:97-102` (`orbis/entity` уходит);
  `packages/shared/src/schemas/aspects.ts:307-313` + `aspects.test.ts:376-385` (пин «`orbis/entity`
  не аспект» снимается); тесты `executor.test.ts:1051-1333` (CAS), `:1334-1565` (D42 ОЧ.13),
  `tools.test.ts:89-140`, `routine.test.ts:819,:831,:2302`.

**Интерфейсы (produces):**
```ts
// contracts/tools.ts
export const entityUpdatePreconditionItem = z.union([
  z.object({ property: z.string().min(1), in: z.array(z.unknown()).min(1) }).strict(),
  z.object({ property: z.string().min(1), absent: z.literal(true) }).strict(),
]);
export interface PreconditionMismatch { property: string; expected: unknown[] | 'absent'; actual: unknown }
export interface ProposalDivergence { mismatches: PreconditionMismatch[]; bodyChanged: boolean }   // РП-10: тело — флаг, не пункт
// executor/props.ts
export function comparePropertyValue(type: PropertyType, a: unknown, b: unknown): boolean;
// decimal → decCmp(a,b) === 0 ('10.0' = '10.00'), RangeError → false (fail-closed); json → canonicalJson равенство; many → массивы поэлементно; остальное — строгое равенство после нормализации ISO-строк
// core-свойства: orbis/archived → row.archived; orbis/title → row.title; orbis/updated_at/created_at → ISO строки
```
- [ ] **Шаг 1: падающие тесты:**
```ts
test('{property:"orbis/amount", in:["10.0"]} совпадает с хранимым "10.00"; "10.01" — CONFLICT precondition_failed с mismatches [{property, expected, actual}]', …)
test('{property:"orbis/archived", in:[false]} на архивной цели → CONFLICT; на живой — проходит (замена D42 ОЧ.13; тест dispatch отложенной архивации)', …)
test('absent:true при отсутствующем значении — ок; при default:false у boolean отсутствие — всё равно absent (РП-9)', …)
test('неизвестный property-id в предусловии → VALIDATION (не CONFLICT): опечатка не выглядит как гонка', …)
test('verbs: CAS step_count проигрывается → retry-лестница различает property "orbis/step_count" (поведенческий тест конкурентного шага)', …)
test('proposal: предложение с расхождением тела даёт bodyChanged:true, mismatches без пунктов ""', …)
test('golden-близнец: 18 писателей — для каждого построенное предусловие содержит только известные property-id (снимок)', …)
test('web: proposal-text рисует «Тело изменилось» по bodyChanged', …)
```
- [ ] **Шаг 2:** FAIL → **Шаг 3:** реализация. — [ ] **Шаг 4:** PASS (в том числе сьюты
  Ш1 `routine.test.ts` 72 и D42 `dispatch.test.ts` 89 — приёмка 6); `lint`, `typecheck`; коммит
  `feat(executor): предусловия CAS по свойству {property, in|absent} со сравнением по типу; core-свойства ядра; псевдо-аспекты сняты (§А7-3, §А1-3, приёмка §С8-6)`.

---

### Задача 6: Журнал, inverse, undo, rollback — единица отката «свойство»; эскалация переписана

**Файлы:**
- Изменить: `apps/server/src/executor/executor.ts:1485-1491` (inverse update), `:1619-1628` (inverse
  attach), `:1267-1278` (применение inverse), `executor/types.ts:142-193, :274-279` (`ActionRecord`,
  операции inverse — в НОВОЙ внутренней форме Задачи 4b), `executor/journal.ts:67-78, :89-104`,
  `executor/undo.ts:97-138`, `agent-loop/rollback.ts:180-182` (сырой SQL по карте → `props`;
  **`TOUCHED_KEYS :220` НЕ трогать** — это список uuid-ключей payload'а для `operationIds`, к форме
  аспектов отношения не имеет — находка 23 ревью плана), `ai/escalation.ts:73-77, :87-106, :138-157`
  (журнал по property-id; `orbis/finance_category`; эвристика намерения остаётся кодом с докблоком
  «остаток C, §С1-4 Z2-89/90»), `executor/journal.test.ts:125-134, :141-158` (пины формы
  переписываются осознанно), `executor/undo.test.ts:141-189` (`:186` → `props['orbis/task_status']`),
  `agent-loop/undo.test.ts`, `rollback.test.ts`, `escalation.test.ts` (33).

**Интерфейсы (produces):**
```ts
// executor/types.ts — операции inverse (внутренний режим undo; форма — entityPropsPatch Задачи 4b):
export type InverseOp =
  | { tool: 'entity_update'; input: { id: string; props?: Record<string, unknown>; unset?: string[]; aspects?: { attach?: string[]; detach?: string[] }; title?; body?; tags?; archived? } }
  | { tool: 'relation_create' | 'relation_delete'; input: … };
// ActionRecord.payload для entity_update: { id, props: {changed only}, unset, aspects: {attach, detach}, … } — БЕЗ meta, БЕЗ aspects-карты; id-ключи payload'а (id/source_id/target_id/entity_id) — прежние
// escalation: extractRecategorizations читает payload.props['orbis/finance_category']; containment-проба по журналу — {"actions":[{"payload":{"props":{"orbis/finance_category":…}}}]}
```
- [ ] **Шаг 1: падающие тесты:**
```ts
test('update двух свойств одного аспекта: inverse несёт ТОЛЬКО прежние значения этих двух свойств; третье свойство аспекта не трогается', …)   // замена undo.test.ts:141-189
test('attach аспекта с новыми значениями: inverse = detach + unset ровно добавленных свойств; значения, существовавшие до attach, остаются', …)
test('golden apply → undo → байт-в-байт по props/aspects/aspects_legacy на корпусе validator-verdicts (позитивные)', …)
test('журнал: форма записи — props по id, без meta; пин ключей ActionRecord обновлён; mechanism в записи', …)
test('rollback прогона: operationIds по-прежнему собирает uuid затронутых сущностей (конфликт с чужим действием ловится — негативный тест); восстановление props', …)
test('escalation: исправление orbis/finance_category находится по новой форме журнала (позитив) и НЕ находится, если правили orbis/amount (негатив)', …)
```
- [ ] **Шаг 2:** FAIL → **Шаг 3:** реализация (журнал и эскалация — в одном коммите — подсказка
  разведки executor'а). — [ ] **Шаг 4:** PASS; `lint`, `typecheck`; коммит
  `feat(executor): журнал, inverse, undo и откат прогона по свойству; эскалация читает журнал по property-id (§А7-4)`.

---

## Веха C: роли рёбер

### Задача 7a: Миграция 0016 — `relations.role`; исполнитель связей на ролях; generic-ограничения реестра; восемь точек создания; web-отправители

**Файлы:**
- Создать: `apps/server/src/db/migrations/0016_relations_role.sql` (+snapshot), `apps/server/src/executor/relations.ts`
  (выделение из `executor.ts:1700-1963`)
- Изменить: `apps/server/src/executor/relations.test.ts` (СУЩЕСТВУЕТ, 21 тест — перевести на роли,
  не создавать заново), `apps/server/src/db/schema.ts:80-99` (`role: text('role').notNull()`;
  `relationType` остаётся до 0017 как производное), `packages/shared/src/schemas/relation.ts` (`role`;
  `relationType` переходно optional), `packages/shared/src/contracts/tools.ts:161-168` (`relationCreateInput
  = {source_id, target_id, role}`; `relationDeleteInput` — ОТДЕЛЬНЫЙ объект той же формы; тест
  `tools.test.ts:171` → `toEqual`), `packages/shared/src/constants.ts:11` (`RELATION_TYPES` удаляется),
  `apps/server/src/executor/executor.ts:1731-1963` (create/delete по `role`; `relation_type :=
  projectLegacyRelationType(role)`), `invariants.ts:17-41, :83-133` (`assertAcyclic(role)` generic по
  `constraints.acyclic`; замок `<owner>:<role>`), `:208-244` (`assertSingleBudgetParent` →
  `assertTargetMaxIncoming(role, n)` generic; ретроспективный путь attach/update конверта —
  `executor.ts:1655-1685` — СОХРАНЯЕТСЯ кодом с докблоком «ограничение роли смотрит на рёбра цели;
  смена аспекта источника при неизменных рёбрах — второй вход, остаток кода части А, перевод —
  правило Б-2»), `:260-275` (дубль — по `(source,target,role)`), `tools/registry.ts:441-443` (JSON
  Schema `relation_create`/`relation_delete`: `role` enum из реестра, описание — `label.ru` +
  `source_label → target_label`), `tools/dispatch.ts:1441`, `routers/relation.ts:21,29,44`, восемь
  точек: `budget/binding.ts:349-352` → `envelope-binding`, `:329-332`/`:342-345` (delete по роли),
  `recurring/materialize.ts:365-366` → `instance-of` (source = шаблон, РП-5), `agent-loop/verbs.ts:470-471`
  → `run`, `routines/lifecycle.ts:912-913` → `run`; `apps/server/src/wire.ts:83-93` (`WireRelation.role`;
  `relationType` переходно), **web-отправители — в этой же задаче** (иначе tsc красный между 7a и
  7b — находка 5): `QuickCapture.tsx:45` (`role: 'subitem'`), `Subtasks.tsx:73` (`subitem`),
  `Blocks.tsx:176,276,277` (`dependency`), тесты `Blocks.test.tsx`, `detail.test.tsx` (11 мест);
  `src/test/agent-loop-helpers.ts:97` (`link(role)`), `src/test/perf.ts` (рёбра с ролью).
- Mechanism-гейт `created_by: system` (§А4-4): `relation_create` роли с `constraints.created_by ===
  'system'` при `mechanism === 'user'` → `ROLE_SYSTEM_ONLY` (отказ 13 §С1-2); хук бюджета зовёт
  `execute` с `mechanism: 'hook'`, материализация — `'materialize'`, глаголы/lifecycle — `'verb'`.
- **Ограничение интервала 7a→23 (находка 55):** пока `rel_uniq` стоит на `(source, target,
  relation_type)`, две роли, проецирующиеся в один legacy-тип (`subitem`+`ticket`, `subitem`+
  `envelope-binding`…), на одной паре сущностей невыразимы — фикстуры и код интервала такие пары не
  создают; негативный тест фиксирует ожидаемый отказ, чтобы он не читался как дефект; снимает 0017.

**Интерфейсы (produces):**
```sql
-- 0016_relations_role.sql (форма проверена исполнением на PG 17: EXISTS, не `= ANY((SELECT…))` — находка 22; читаем aspects_legacy —
-- новая колонка aspects у строк, существовавших до 0015, пуста — находки 31/40)
CREATE FUNCTION reform_role_heuristic(rt text, src jsonb, tgt jsonb) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN rt = 'blocks' THEN 'dependency'
    WHEN rt = 'related_to' THEN 'mention'
    WHEN rt = 'derived_from' THEN 'instance-of'
    WHEN rt = 'parent' AND src ? 'orbis/budget' THEN 'envelope-binding'
    WHEN rt = 'parent' AND tgt ? 'orbis/category' THEN 'category-parent'
    WHEN rt = 'parent' AND tgt ? 'orbis/agent-run' THEN 'run'
    WHEN rt = 'parent' AND src ? 'orbis/project' AND tgt ? 'orbis/assignment' THEN 'ticket'
    ELSE 'subitem' END $$;
ALTER TABLE relations ADD COLUMN role text;
UPDATE relations r SET role = reform_role_heuristic(r.relation_type,
  (SELECT aspects_legacy FROM entities e WHERE e.id = r.source_id),
  (SELECT aspects_legacy FROM entities e WHERE e.id = r.target_id));
ALTER TABLE relations ALTER COLUMN role SET NOT NULL;
CREATE INDEX relations_source_role ON relations (source_id, role);
CREATE INDEX relations_target_role ON relations (target_id, role);
-- функция остаётся до 0017 (там DROP FUNCTION); тест 7a вызывает её напрямую на временных jsonb-значениях — миграцию перепрогонять не нужно.
-- rel_uniq и relation_type — до 0017 (Задача 23).
```
```ts
// executor/relations.ts
export interface RelationKey { sourceId: string; targetId: string; role: string }
export async function assertRoleConstraints(tx, reg: RegistrySnapshot, key: RelationKey, effects: VirtualGraphEffects, mechanism: MutationMechanism): Promise<void>;
// created_by:system + mechanism 'user' → ROLE_SYSTEM_ONLY; acyclic → assertAcyclic(role) (WITH RECURSIVE по (source_id, role), кап 32, advisory `<owner>:<role>`);
// target_max_incoming → assertTargetMaxIncoming; неизвестная роль → VALIDATION; deprecated роль — создание отказ, чтение живо
```
- [ ] **Шаг 1:** применить 0016 на локальной базе ДО кода (`bun run db:prepare` — миграция обязана
  накатиться на пустой и на непустой базе). **Падающие тесты** (`relations.test.ts` 21 → роли,
  `binding.test.ts:635-783, :895-940` → `envelope-binding`, `materialize.test`, `verbs.test`,
  `lifecycle.test`, `tools.test.ts:171`, web `Blocks.test`/`detail.test`):
```ts
test('relation_create role=dependency A→B, затем B→A → INVARIANT с путём цикла в тексте (остаток C — путь)', …)
test('category-parent: цикл в дереве категорий → отказ (новое поведение, Р-6)', …)
test('envelope-binding ×2 на одну транзакцию → отказ target_max_incoming (замена «один budget-parent»); ретроспективный путь attach конверта — прежний тест зелёный', …)
test('relation_create role=run из тула (mechanism user) → ROLE_SYSTEM_ONLY; из verbs (mechanism verb) — ок', …)
test('relation_type производится из role тотально (11 ролей)', …)
test('reform_role_heuristic: (parent, {orbis/budget:{}}, {orbis/financial:{}}) → envelope-binding; (derived_from, …) → instance-of; (parent, {}, {}) → subitem', …)
test('интервал до 0017: subitem + ticket на одной паре → отказ уникальности (ожидаемо, снимает 0017); subitem + mention — оба живут', …)
test('web: QuickCapture/Subtasks/Blocks шлют role; tsc зелёный', …)
```
- [ ] **Шаг 2:** FAIL → **Шаг 3:** реализация. — [ ] **Шаг 4:** PASS всех сьютов (`test:perf`
  с ролями, web build), `lint`, `typecheck`; коммит
  `feat(relations): миграция 0016 — relations.role; исполнитель связей на ролях, generic-ограничения реестра (acyclic, target_max_incoming, created_by:system), восемь точек создания и web-отправители на ролях (§А4)`.

---

### Задача 7b: Читатели ролей (сервер, web) и вычисляемые `orbis/parent_project`/`orbis/root_project`

**Файлы:**
- Создать: `apps/server/src/executor/ancestors.ts` (+test) — движок `nearest_ancestor` (код части А,
  декларация правила — Б-2; Р-22)
- Изменить (читатели `relation_type` → `role`): `apps/server/src/entity-read.ts:97-120` (backlinks:
  `mention` + `body_refs`; подписи сторон из `source_label`/`target_label`; рёбра `ref` — Задача 11),
  `agent-loop/queries.ts:17,53,209,231,359` (`run`/`ticket`/иерархические — из `reg.roles` с
  `hierarchical`, не из константы — находка 15), `budget/binding.ts:167-176` (`envelope-binding`),
  `budget/aggregates.ts:136-138, :194-210` (`category-parent`), `:431,:448` (`instance-of`),
  `budget/plan-to-fact.ts:62`, `recurring/post-due.ts:55`, `import/review.ts:499` (`envelope-binding`),
  `export.ts:55` (`role`; форма дампа — Задача 13c), `routines/lifecycle.ts:2638` (печать роли —
  `label.ru`), `agent-loop/verbs.ts:456-458` (`project_id` больше не пишется), `query/compile.ts:248-254`
  (`children_of/parents_of` через `role IN (иерархические из реестра)`, `excludeBlocked` через
  `dependency` — временно, до Задачи 9b), web: `Subtasks.tsx:29`, `Blocks.tsx:61` (чтения),
  `Backlinks.tsx:7` (`VIA_LABEL` → подписи из wire).
- **Названный интервал (находка 29):** тело проекта `seed/project-body.ts:43` сеет блок
  `project_id=${projectId}`; после этой задачи `project_id` никто не пишет — блок «Последние прогоны»
  у локальных проектов пуст до Задачи 21, где тело переписывается на `orbis/parent_project=${projectId}`
  (движок заполняет свойство у прогонов через роли `run`/`ticket`). Записать в `facts.md`.

**Интерфейсы (produces):**
```ts
// executor/ancestors.ts
export async function recomputeProjectAncestors(tx, ownerId: string, changedTargetIds: string[], reg: RegistrySnapshot): Promise<{ recomputed: number }>;
// для каждой затронутой цели — обход вниз по (source_id, role ∈ hierarchical(reg)) с капом 32; для каждой сущности поддерева — ближайший/корневой предок с 'orbis/project' ∈ aspects (обход вверх по (target_id, role ∈ hierarchical)); запись props прямым UPDATE (mechanism 'rule', без гейта model_writable) + aspects_legacy-проекция; одна системная строка журнала «пересчитано N сущностей по правилу nearest_ancestor» БЕЗ inverse; undo правки ребра триггерит пересчёт заново.
// executor.ts: после relation_create/relation_delete иерархической роли и после attach/detach 'orbis/project' — recomputeProjectAncestors.
```
- [ ] **Шаг 1: падающие тесты:**
```ts
test('проект → подпроект → задача → подзадача: parent_project = подпроект, root_project = проект; перенос подпроекта под другой проект пересчитывает всё поддерево в той же tx', …)
test('прогон под тикетом под проектом получает parent_project = проект (через роли run/ticket)', …)
test('undo relation_create иерархического ребра: parent_project возвращается (пересчёт по восстановленным рёбрам); inverse пересчёта не существует', …)
test('entity_update props.orbis/parent_project из тула → COMPUTED_WRITE', …)
test('backlinks: секция «Связанное» подписывает направление из реестра ролей', …)
test('очередь исполнителя: тикеты по роли ticket/run; parentProject → props.orbis/parent_project', …)
```
- [ ] **Шаг 2:** FAIL → **Шаг 3:** реализация. — [ ] **Шаг 4:** PASS всех сьютов + web build;
  коммит `feat(relations): читатели ролей на сервере и в web; вычисляемые parent_project/root_project с пересчётом поддерева в tx (Ч9, §А4-3, §А8)`.

---

## Веха D: Q-AST — канон, грамматика, компилятор, потребители

### Задача 8: shared — канонический Q-AST рядом со старым разбором: типы, JSON Schema, парсер, печать key/label, валидация по реестру, фикстуры

**Файлы:**
- Создать: `packages/shared/src/query/ast.ts` (типы узлов §А5-7 + `queryAstSchema` zod),
  `query/ast-json-schema.ts` (рекурсивный `$ref` для тула), `query/parse-ast.ts` (текст → AST по
  реестру), `query/print.ts` (AST → текст в key-форме и label-форме), `query/static.ts`
  (`assertStaticQuery` — `SCOPE_NOT_STATIC`), `query/ast-fixtures.ts` + тесты `ast.test.ts`,
  `parse-ast.test.ts`, `print.test.ts`, `static.test.ts`
- Изменить: `packages/shared/src/query/catalog.ts` (ДОБАВИТЬ `buildCatalogFromRegistry`; `propType`
  и `buildFieldCatalog` ОСТАЮТСЯ до Задачи 21 — их потребители: старый парсер, web-каталог, тесты
  сидов — находки 3/4 ревью плана), `parse.ts:344, :347` (снятие алиаса `due` в старом парсере —
  Р-8 таблицы; тесты `parse.test.ts:119`, `serialize.test.ts:107`, web `txQuery.test.ts:115`),
  `packages/shared/src/registry/types.ts` (`scope: queryAstSchema.nullable()`, `ref.target:
  queryAstSchema | queryAstSchema[]`), `packages/shared/src/index.ts`
- НЕ трогать: `query/grammar.ts` (старый `QueryAst`), `query/parse.ts` (кроме `due`), `serialize.ts`,
  `apps/server/src/query/compile.ts` — живут до Задач 9b/21 (РП-11).

**Интерфейсы (produces):**
```ts
// query/ast.ts — канон §А5-7 (имена узлов и операторы — ДОСЛОВНО по спеке; gte/lte НЕ вводятся — находка 8: `<=`/`>=` кодируются включающим range)
export type QueryFilterNode =
  | { and: QueryFilterNode[] } | { or: QueryFilterNode[] } | { not: QueryFilterNode }
  | { prop: string; op: 'eq'|'ne'|'gt'|'lt'|'range'|'in'|'contains'; value: unknown }
      // value: литерал типа | список (in) | {token: 'today'|'overdue'|'next_7d'|'after_7d'} | {from?, to?} (range, включающий: `x<=v` → {to: v}, `x>=v` → {from: v})
  | { has: string }                                   // props ? '<id>' (§А5-1)
  | { aspect: string }
  | { tag: string }
  | { search: string }
  | { rel: { kind: 'children_of'|'parents_of'|'has_relation'|'has_children'|'descendants_of'|'ancestors_of'; via?: string; of?: string | 'this' } }
  | { archived: 'true' | 'any' }
  | { class: { contract: string; set: string } };     // часть Б: парсер/компилятор среза А отвергают с кодом 'CLASS_NOT_AVAILABLE' (VALIDATION), узел в схеме есть
export interface QueryAst {
  filter: QueryFilterNode | null;
  sortBy?: { field: string; dir: 'asc'|'desc' }[];      // field — property-id ИЛИ core-id (orbis/title, orbis/updated_at, …)
  limit?: number; display?: 'compact'|'list'|'table'; title?: string;
}
export const queryAstSchema: z.ZodType<QueryAst>;       // zod с z.lazy
export const QUERY_DEPTH_CAP = 32;                      // константа компилятора (не поле узла)
// query/ast-json-schema.ts
export const queryAstJsonSchema: Record<string, unknown>;   // draft-07 с $defs.node и рекурсивным $ref — вход entity_query (Задача 9b), проба провайдера (9a)
// query/parse-ast.ts
export interface ParseRegistry { properties: Map<string, PropertyDefinition>; aspects: Map<string, AspectDefinition>; roles: Map<string, RelationRoleDefinition>; locale: string }
export function toParseRegistry(snapshot: { properties: Map; aspects: Map; roles: Map }, locale: string): ParseRegistry;   // единственный адаптер RegistrySnapshot → ParseRegistry (находка 19)
export type ParseAstResult = { ok: true; ast: QueryAst } | { ok: false; error: { code: 'UNKNOWN_FIELD'|'UNKNOWN_ASPECT'|'UNKNOWN_ROLE'|'AMBIGUOUS_LABEL'|'TYPE'|'SYNTAX'|'QUERY_MULTI_ROLE'|'QUERY_JOIN'|'RESERVED'; message: string; position?: number } };
export function parseQueryAst(text: string, reg: ParseRegistry): ParseAstResult;
// грамматика §А5-3: имя поля — namespaced key (`orbis/limit>1000`) ИЛИ "закавыченный label" (резолв по локали; неоднозначность → AMBIGUOUS_LABEL с подсказкой aspect=); aspect= принимает key и label; has=<key>; children_of=<uuid|this>[ via=<role-key> ]; descendants_of/ancestors_of ТРЕБУЮТ via (иначе QUERY_MULTI_ROLE); has_relation=<role-key>; has_children[=via]; !has_children → {not:{rel:{has_children}}}; anyOf/noneOf значения → {or:[…]}/{not:{or}}; `x<=v`/`x>=v` → range; плоский текст = {and:[…]}; excludeBlocked=true → {not:{rel:{kind:'has_relation', via:'dependency'}}} — ВРЕМЕННО как сегодня (набор closed — Б-1); неизвестное имя/аспект/роль — ОШИБКА, не молчаливый ноль (§А5-3ж); алиаса due НЕТ; reserved-слова только у голых имён — `orbis/limit` однозначен по слэшу
// query/print.ts
export function printQueryAst(ast: QueryAst, reg: ParseRegistry, form: 'key' | 'label'): string;   // key-форма каноническая (детерминированный порядок узлов); label-форма — для человека; parse(print(a)) ≡ a на фикстурах
// query/static.ts
export function assertStaticQuery(ast: QueryAst): void;     // SCOPE_NOT_STATIC: date-токены, search, of:'this', sortBy/limit/display/title/archived — запрещены в ref.target и scope (§А6-1, §А2-1)
// query/ast-fixtures.ts — эталонные AST: все конструкции §А5-1/§А5-7 + невыразимое (две роли, соединение) + КЛЮЧ-ФОРМЫ трёх запросов Agenda (экспорт AGENDA_QUERY_TEXTS — Задача 10c подставляет их в useAgenda.ts дословно; находка 13) + фикстурный ParseRegistry по BUILTIN_* (для тестов без БД)
// query/catalog.ts
export function buildCatalogFromRegistry(reg: ParseRegistry): FieldCatalog;   // тип поля — из PropertyType; эвристик нет
```
- [ ] **Шаг 1: падающие тесты:**
```ts
test('parseQueryAst: `aspect=orbis/task orbis/task_status=!done&!cancelled orbis/due_date<=today sortBy=orbis/priority:desc limit=20` → and/not/or + range{to: today-token}; печать key-формы обратима', …)
test('label-форма: `"срок"<=today` → orbis/due_date; `"статус"=done` при task и project → AMBIGUOUS_LABEL; с aspect=orbis/task — однозначно', …)
test('has=orbis/recurrence → {has}; !has_children via=subitem → {not:{rel:{has_children, via:subitem}}}', …)
test('descendants_of без via → QUERY_MULTI_ROLE; предикат-соединение → QUERY_JOIN; aspect=orbis/tsk → UNKNOWN_ASPECT', …)
test('assertStaticQuery: {prop, value:{token:today}} → SCOPE_NOT_STATIC; {aspect}/{tag} — ок', …)
test('queryAstJsonSchema валидирует все фикстуры (ajv) и отвергает узел с неизвестным ключом и op gte', …)
test('AGENDA_QUERY_TEXTS (три key-формы) разбираются и печатаются обратимо', …)
test('старый парсер: алиас due снят — `due<=today` → UNKNOWN_FIELD', …)
test('buildCatalogFromRegistry: bucket — text (не timestamp), decimal — decimal; propType в новом каталоге не вызывается', …)
```
- [ ] **Шаг 2:** FAIL → **Шаг 3:** реализация. — [ ] **Шаг 4:** PASS; `lint`, `typecheck`;
  коммит `feat(query): канонический Q-AST §А5-7 — типы, JSON Schema, парсер по реестру, печать key/label, статическое подмножество, каталог из реестра (§А5-1…§А5-3, §А2-2)`.

---

### Задача 9a: Компилятор AST → SQL на `props`/`aspects[]`/`role` рядом со старым; golden и датасет; EXPLAIN-замер индексов; перф П6; проба OpenAI

**Файлы:**
- Создать: `apps/server/src/query/compile-ast.ts` (+ `compile-ast.test.ts`), `apps/server/perf/graph.test.ts`
  (П6; отдельный скрипт `test:perf:graph` — НЕ в `test:perf`/CI — находки 38/51), `apps/server/src/test/graph-fixture.ts`
  (генерация 50k/150k пачками ПРЯМЫМ INSERT под админ-DSN — докблок-исключение из правила «только
  через executor», как у `src/test/perf.ts`; корпус кешируется — пропуск, если счётчики строк
  совпали), `apps/server/perf/explain.test.ts` (отдельный скрипт `test:perf:explain`; под
  `withIdentity` ролью приложения — §А1-4/§С8-10; вердикт по каждому GIN печатается и пишется в
  `progress.md`; повторно гоняется в Задаче 23 как приёмка), `scripts/probe-openai-schema.ts` (Р-10)
- Изменить: `apps/server/test/golden/query-sql.json` (РП-12: `{name, query, ast, sql, params, countSql?,
  countParams?}` — 27 пересчитанных вручную + новые), `apps/server/src/query/compile.golden.test.ts`,
  `compile.dataset.test.ts` (21; два пользователя, `TODAY`) — оба гоняют НОВЫЙ компилятор; старый
  `compile.ts` и его потребители НЕ трогаются (переключение — 9b), `apps/server/package.json`
  (`test:perf:graph`, `test:perf:explain`), `docs/implementation/02-ops-runbook.md` §8 — строки
  двух новых скриптов (в диф Задачи 22).

**Интерфейсы (produces):**
```ts
// apps/server/src/query/compile-ast.ts — имена ОДНИ на все задачи (10a/10b/11/13c ссылаются на них; находка 14); возврат — drizzle SQL, как у старого компилятора
export interface CompileCtx { ownerId: string; today: string; timeZone: string; reg: RegistrySnapshot }
export function compileQueryAst(ast: QueryAst, ctx: CompileCtx): SQL;
export function compileCountAst(ast, ctx): SQL; compileSumAst(ast, propertyId, ctx): SQL; compileLatestAst(ast, propertyId, ctx): SQL;
// листья: {prop, op} → (props->>'<id>')::<каст по kind> оп $n (decimal → ::numeric; date/timestamp → ::date/::timestamptz; boolean → COALESCE((props->>'<id>')::boolean,false) (РП-9); select/text → props->>'<id>'; many → props->'<id>' ?| ARRAY[$n] / @>); range → BETWEEN/>=/<=
// {has} → props ? '<id>'; {aspect} → aspects @> ARRAY['<id>']; {tag} → tags @> ARRAY[$n]; {search} → FTS как сегодня; core-свойства → колонки;
// {rel children_of of via} → EXISTS (SELECT 1 FROM relations r WHERE r.target_id = e.id AND r.source_id = $n AND r.role = $via) (без via — role = ANY($hier), где $hier — роли с hierarchical из ctx.reg.roles — находка 15);
// parents_of — зеркально; has_relation → EXISTS по (target_id = e.id AND role = $via) — ТОЛЬКО ВХОДЯЩЕЕ ребро (правка по гейту Задачи 8: строка 75 плана, Р-5, опирается ровно на `(target_id, role)` для пробника Е-1, а «оба направления» сломали бы `excludeBlocked` — он начал бы вычёркивать и блокирующие сущности, регресс против `compile.ts:262`); has_children → EXISTS (source_id = e.id AND role …);
// descendants_of/ancestors_of via → WITH RECURSIVE walk(id, depth) … WHERE depth < 32 (QUERY_DEPTH_CAP), по индексу (source_id, role)/(target_id, role);
// ref-свойства в соединении — (props->>'<id>')::uuid ВСЕГДА (§А6-2);
// служебные аспекты: если filter не называет service-аспект явно — AND NOT (aspects && ARRAY[<service ids из ctx.reg.aspects>]) (§А5-6);
// archived: 'true' → archived, отсутствие → NOT archived, 'any' → без условия; sortBy по kind (select — CASE по rank вариантов из реестра, NULLS LAST; decimal — ::numeric); limit default 500 (DEFAULT_LIMIT сегодня — compile.ts:58).
// {class} → ExecError VALIDATION 'CLASS_NOT_AVAILABLE' (часть Б).
// scripts/probe-openai-schema.ts — живой прогон: регистрирует entity_query с queryAstJsonSchema через Responses API при strict:false, просит модель вернуть AST для трёх текстов; печатает валидность по схеме; при отсутствии OPENAI_API_KEY — exit 2 с сообщением
```
- [ ] **Шаг 1: golden.** Пересчитать ВРУЧНУЮ (по нормативной таблице семантики §6.1 PRD и
  §А5-7) 27 эталонов: `query` (текст) → `ast` → `sql`/`params`; добавить эталоны: `has`, OR-дерево
  двух полей, `via=subitem`, `descendants_of via`, `ancestors_of via`, `has_children`, `!has_children`,
  `has_relation=dependency`, `archived=any`, `sortBy` по select и decimal, `orbis/limit>1000`,
  label-форма, range для `<=`/`>=`. Порядок: 3–5 руками, сверить, затем остальные — и прочитать
  диффом. Мутационная проверка: тест портит `sql` каждого эталона (меняет оператор) и ожидает
  несовпадение.
- [ ] **Шаг 2: падающие тесты:**
```ts
test('golden: query → ast (парсер) и ast → sql/params (новый компилятор) на всех эталонах; мутация ломает', …)
test('датасет (живая БД, два владельца, TODAY): 21 прежний сценарий на новом компиляторе + descendants_of via=subitem глубина 3 + OR «просрочено по сроку ИЛИ по началу» + has(orbis/recurrence)', …)
test('descendants_of: кап 32 — цепочка из 40 не даёт бесконечного обхода, результат ограничен', …)
test('служебный аспект спрятан, пока не назван; список — колонка service реестра', …)
test('perf/graph.test.ts (П6, скрипт test:perf:graph): 50k сущностей / 150k рёбер subitem глубина 8 — descendants_of p95 ≤ 100 мс под RLS; recomputeProjectAncestors на поддереве 5k ≤ 1 с (§С8-13)', …)
test('perf/explain.test.ts (скрипт test:perf:explain): для entities_props_gin / entities_aspects_gin / entities_query_refs_gin — EXPLAIN (FORMAT JSON) горячего запроса под withIdentity(orbis_app); вердикт «используется / не используется под RLS» печатается по каждому', …)
```
- [ ] **Шаг 3:** реализация; `bun run test:perf:graph` и `bun run test:perf:explain` — цифры и
  вердикты по индексам в `progress.md` (**вердикт EXPLAIN — вход миграции 0017 Задачи 23**:
  неиспользуемые GIN снимаются там — находки 20/45); `bun scripts/probe-openai-schema.ts` при живом
  ключе — **блокирующая приёмка §С8-4** (находка 48): без прогона задача НЕ закрывается; ключа нет →
  стоп и вопрос владельцу (у него прод-провайдер OpenAI), не «остаток».
- [ ] **Шаг 4:** PASS (`bun run test` — старые сьюты на старом компиляторе живы, новые — на
  новом), `lint`, `typecheck`; коммит
  `feat(query): компилятор Q-AST → SQL на props/aspects[]/role рядом со старым (рекурсивный CTE, has, OR-дерево, служебность из реестра); golden 27+ пересчитан вручную; датасет; перф П6 и EXPLAIN-замер отдельными скриптами; проба схемы на OpenAI (§А5, приёмки §С8-3/4/13)`.

---

### Задача 9b: Переключение сервера на Q-AST — `entity_query` {query|ast}, окно материализации по дереву, цели, роутеры; старый компилятор удалён

**Файлы:**
- Изменить: `packages/shared/src/contracts/tools.ts:181` (`entityQueryInput = {query?: string, ast?: QueryAst}`
  — ровно одно), `apps/server/src/tools/registry.ts:359-370` (JSON Schema с `$defs` из
  `queryAstJsonSchema`; примеры в description `:829-849` — на namespaced-key форму; тест
  `registry.test.ts:250-257` — через `parseQueryAst` с реестром), `routers/entity.ts:82-99`,
  `tools/dispatch.ts:619-639` (ветка «ast пришёл готовым» — валидация схемой + по реестру; текст —
  `parseQueryAst`), `recurring/with-materialization.ts:13-59` (`parse` → `parseQueryAst`),
  `recurring/materialize.ts:116-173` (`materializationWindow` — обход ДЕРЕВА: окно = объединение
  диапазонов по `orbis/start_at`/`orbis/due_date`/`orbis/occurred_on` в ветках `and`/`or`; `not` окно
  не сужает), `materialize.test.ts:6,400,457,460` (тексты запросов — key-форма через `parseQueryAst`),
  `goals/progress.ts:254-301` (компиляция по AST; `progress_source.query` пока текст — парсится при
  чтении; хранение AST — Задача 10b), `apps/server/src/query/compile.ts` (УДАЛЯЕТСЯ; `compile.golden`/
  `compile.dataset` уже на `compile-ast`), `query/context.ts` (без изменений), `apps/server/src/tools/registry.ts:473-476`
  + `dispatch.ts:659-679` (`user_query.field` — key/id свойства), Agenda/Browser/смарт-листы — по
  прежним текстам через сервер: тексты сидов и Agenda ещё старой формы → **`parseQueryAst` их
  отвергнет**; поэтому в 9b серверный разбор текста ПРИНИМАЕТ ОБЕ ФОРМЫ: сначала `parseQueryAst`,
  при `UNKNOWN_FIELD/SYNTAX` — старый `parseQuery` с конвертацией плоского AST в дерево
  (`legacyAstToQueryAst` в `packages/shared/src/query/legacy-bridge.ts`, переходный, удаляется в
  Задаче 21 вместе со старой грамматикой) — иначе Agenda/смарт-листы/Browser красны до 10c/21.
- НЕ трогать: `packages/shared/src/query/{grammar,parse,serialize,catalog(buildFieldCatalog,propType),fixtures}.ts`
  — потребители: web (до 10c), `legacy-bridge` (до 21), тесты сидов `onboarding.test.ts:15,235`,
  `project-body.test.ts:9,39`, гард `v4.test.ts:16,71,73` (до 21 — находка 42).

**Интерфейсы (produces):**
```ts
// packages/shared/src/query/legacy-bridge.ts — ПЕРЕХОДНЫЙ (удаляется Задачей 21)
export function legacyAstToQueryAst(legacy: LegacyQueryAst /* grammar.ts QueryAst */, reg: ParseRegistry): QueryAst;   // плоские filters → {and:[…]}, имена полей → property-id по legacyFieldToProperty
export function parseQueryAny(text: string, reg: ParseRegistry): ParseAstResult;   // новая грамматика, затем старая через мост; ошибка — от новой грамматики
// apps/server: единая точка разбора текста — query/parse-text.ts: parseQueryText(tx, ownerId, text) → QueryAst (parseQueryAny + toParseRegistry(loadRegistry(tx, owner), locale))
```
- [ ] **Шаг 1: падающие тесты:**
```ts
test('entity_query: {ast} валиден по схеме и по реестру → результат; {query} и {ast} вместе → VALIDATION; неизвестный property-id в ast → VALIDATION UNKNOWN_FIELD', …)
test('entity_query {query: "orbis/task_status=inbox"} и {query: "aspect=orbis/task, status=inbox"} (старая форма через мост) дают один результат', …)
test('materializationWindow по дереву: {or:[start_at<=next_7d, due_date<=next_7d]} даёт окно; {not:{…}} окно не сужает; запрос без дат — окно по умолчанию', …)
test('goals: progress_source.query (текст) считается через compile-ast; паритет progress.test (19) на фикстурах', …)
test('e2e.slice1a: смарт-листы онбординга (тела старой формы) отдают результаты через мост', …)
```
- [ ] **Шаг 2:** FAIL → **Шаг 3:** реализация. — [ ] **Шаг 4:** PASS всех сьютов, `test:perf`,
  web build (web ещё на старом парсере — не трогается), `lint`, `typecheck`; коммит
  `feat(query): сервер на Q-AST — entity_query принимает текст ИЛИ AST, окно материализации по дереву, цели через compile-ast, старый компилятор удалён; переходный мост старой грамматики до Задачи 21 (§А5-4)`.

---

### Задача 10a: Механический перевод SQL Финансов на `props`/`role` (aggregates, binding, plan-to-fact) — без переписи на подписку (§С9-1, №35)

**Файлы:**
- Изменить: `apps/server/src/budget/aggregates.ts` (51 путь `aspects_legacy->` + 3 containment + 3
  JS-чтения; `planned` — РП-9 единая форма; `category-parent`/`instance-of` уже с 7b; `carryover`
  пишет `rolloverCreate` с `mechanism: 'rule'`), `budget/binding.ts` (селектор, уникальность
  `:567-575` — `:571 IS NOT DISTINCT FROM` СОХРАНЯЕТСЯ (Р-30); `normalizeEnvelopeCurrency`/
  `assertEnvelopeUnique` на props; лок `:519-523` — имя ключа из роли `envelope-binding`; бюджет-хук
  зовёт `execute` новой внутренней формой `entityPropsPatch`), `budget/plan-to-fact.ts:55-106`
  (`planned === true`), `routers/budget.ts`, `routers/user.ts:30-31`, `packages/shared/src/contracts/budget.ts`
  (`:44 direction` → enum из реестра; `:19,:41,:48` — `entitySchema` переходной формы Задачи 4a),
  тесты: `aggregates.test` (32), `binding.test` (30), `binding-batch.test.ts:333-337` (`READS` по
  новым строкам SQL: `'orbis/period_end'`, `'orbis/budget' = ANY(aspects)`), `rollover.test` (14),
  `recurring-template.test`, `currency-normalize.test`, `plan-to-fact.test`, `src/test/perf.ts`
  бюджетная фикстура (через `rowFromLegacy` → теперь props напрямую).
- **Golden паритета:** до перевода снять снимок `budget.overview` на фикстуре `perf.ts` в
  `test/golden/budget-overview-before.json` и после перевода сравнить посимвольно (decimal-строки).

- [ ] **Шаг 1:** снять golden паритета на HEAD (до правок); падающие тесты — READS, паритет,
  `planned` единой формы (`'true'`-текст → `true` boolean в props; отсутствие — факт).
- [ ] **Шаг 2:** перевод; `bun scripts/check-legacy-form.ts` — ноль `aspects_legacy` в `budget/*`.
  — [ ] **Шаг 3:** PASS, паритет 0 расхождений, `test:perf` `budget.overview ≤ 300`; коммит
  `refactor(budget): SQL агрегатов, привязки и план→факт на props/role — механический перевод без переписи на подписку (§С9-1, РП-9, Р-30)`.

---

### Задача 10b: Механический перевод остального сервера: импорт, повторы, цели, очередь исполнителя, рутины, откат, эскалация

**Файлы:**
- Изменить: `apps/server/src/import/review.ts` (пути — props; `:491-506` ПОКА по props — зеркало
  ref и `(target_id, role='ref')` — Задача 11), `recurring/materialize.ts:324-352` (ЯВНЫЙ перечень
  наследуемых свойств — Р-28: schedule без `orbis/recurrence` + financial `orbis/amount,
  orbis/currency, orbis/direction, orbis/finance_category, orbis/payment_method, orbis/counterparty`
  + `orbis/occurred_on := дата`, `orbis/planned := true`, `orbis/recurring := true`; `mechanism:
  'materialize'`; вход — `entityPropsPatch`), `recurring/post-due.ts:48-82` (`orbis/planned`,
  `instance-of`), `goals/progress.ts` (`progress_source` хранится AST: схема `orbis/progress_source`
  json-schema с `query: QueryAst`; конвертер старого текста не заводится — база пересевается),
  `agent-loop/queries.ts` (11 SQL: `aspects_legacy->'orbis/agent-run'->>'x'` → `props->>'orbis/run_x'`;
  `runSummary :374-411` 16 полей; `assignedTickets :163-176` — `'orbis/task' = ANY(aspects)` +
  containment по props назначения), `routines/lifecycle.ts:1287-1289, :204-241` (`patchAspect` →
  `patchRun(props)` новой внутренней формой; тип открыт по реестру), `:2660-2721` (`updateRows` —
  строки по property-id с label из реестра; `CORE_FIELD_LABELS` без `meta`), `routines/edits.ts:60-67`
  (`fieldEditSchema`: `{index, property, value}`), `routines/context.ts:118-126` (`OUTCOME_LABEL` —
  исчерпывающий `Record<RunOutcome, string>` по вариантам `orbis/run_outcome`), `routines/runner.ts:562`,
  `routines/scheduler.ts:124-125`, `agent-loop/verbs.ts` (все чтения `aspectsLegacy[...]` → props;
  патчи — `entityPropsPatch`), `ai/escalation.ts:207-213` (по props), `tools/dispatch.ts:1363, :1512`,
  `routers/routine.ts:412-440`, `routers/entity.ts:125-135` (`status` подсказок →
  `props['orbis/task_status']`), `routers/agent-run.ts`, `test/agent-loop-helpers.ts` (`aspectsOf()`
  удаляется, 157 вызовов → `propsOf()`), тесты зон (import 49+13, materialize 20, progress 19 —
  `:609-614` счётчики пересчитать, verbs 35, queries 9, lifecycle 43, routine 72, agent-run 8, sweep 8,
  rollback, escalation 33).

- [ ] **Шаг 1: падающие тесты:** материализация — «инстанс задачи-шаблона не получил финансовых
  свойств; инстанс транзакции получил ровно перечень» (Р-28); очередь — паритет `assignedTickets`
  на фикстуре; `runSummary` — 16 полей по id; `OUTCOME_LABEL` — typecheck на полноту; `progress` —
  `progress_source.query` как AST (фикстуры целей переписаны).
- [ ] **Шаг 2:** перевод; `bun scripts/check-legacy-form.ts` — ноль `aspects_legacy` в
  `apps/server/src` кроме `executor/legacy-form.ts`, `wire.ts` (проекция для web) и `llm/context.ts:113-136`
  (память — Задача 18).
- [ ] **Шаг 3:** PASS; коммит `refactor(server): импорт, повторы, цели, очередь исполнителя, рутины, откат и эскалация на props/role; явный перечень наследуемых свойств материализации (Р-28); progress_source хранит Q-AST`.

---

### Задача 10c: web — query-builder и каталог полей на Q-AST по id; тексты запросов модулей в key-форме

**Файлы:**
- Изменить: `apps/server/src/routers/aspect.ts` (+ процедура `aspect.properties` — `PropertyDefinition[]`
  и `RelationRoleDefinition[]`, видимые владельцу; `registry.effective` с версией приходит в 13a и
  заменит вызов), `apps/web/src/lib/query-blocks/{catalog,useFieldCatalog,parse}.ts` (каталог —
  `buildCatalogFromRegistry` по `aspect.properties`; разбор — `parseQueryAst`),
  `apps/web/src/features/query-builder/{model,FieldRows,QueryBuilderForm,QueryTextEditor,QueryBlockEditor}.tsx/.ts`
  (состояние формы — дерево `QueryAst`; операторы по kind; варианты select — `label` вариантов;
  `isReservedKey` уходит; рулинг «доступное имя контрола = имя поля» `FieldRows.tsx:143-152`
  СНИМАЕТСЯ явно), `QueryBlock.tsx:46-86` (ошибка блока — от `parseQueryAst`), 15 боевых текстов:
  Финансы — `budget/categories.ts:8`, `EnvelopeCreateSheet.tsx:55`, `QuickAddBar.tsx:29`, `txQuery.ts:53-67`,
  `CategoryScreen.tsx:117`; ADE — `useTicketRuns.ts:45`; Память — `memoryRules.ts:12`, `MemoryScreen.tsx:25`
  (`orbis/memory_kind`/`orbis/rule_scope`); Browser — `browser/query.ts:13-24` (мёртвые `status/priority`
  в `FilterState` удаляются — `Filters.tsx:6-13` их не ставит), `SmartListSave.tsx:18`, `slash/items.ts:29`;
  Agenda — `useAgenda.ts:38,45,52` ← `AGENDA_QUERY_TEXTS` из `ast-fixtures.ts` дословно (три
  запроса ОСТАЮТСЯ тремя до Б-1), тесты web (`query-builder.test`, `query-form.test` 46,
  `txQuery.test`, `useFastPath.test`, `detail.test` части).
- **Старая грамматика в shared остаётся** (потребители после 10c: `legacy-bridge` для тел сидов и
  гард v4 — до Задачи 21); **хранение AST в query-блоке — Задача 21**: блок по-прежнему несёт
  текст, форма парсит/печатает через `parseQueryAst/printQueryAst` в key-форме.

- [ ] **Шаг 1: падающие тесты:** пока блок хранит ТЕКСТ (до Задачи 21), форма ограничена плоским
  сахаром v1 (§А5-3д): OR допустим только внутри одного поля (`anyOf` → `{or}` по значениям),
  кнопка «ИЛИ между полями» недоступна с подсказкой «после перехода блока на AST» (Задача 21
  снимает); контрол select показывает label варианта, хранит key; неизвестное поле → ошибка блока
  с позицией; каждый из 15 текстов запросов разбирается новым парсером (снимок key-формы); Agenda
  тексты равны `AGENDA_QUERY_TEXTS`; `Filters.tsx` без мёртвых `status/priority`.
- [ ] **Шаг 2:** реализация. — [ ] **Шаг 3:** PASS web, build, `check-lazy-chunks`; коммит
  `feat(web): query-builder и каталог полей на Q-AST по id, тексты запросов модулей в namespaced-key форме (§А5-3, §С1-4 Z5)`.

---

## Веха E: `ref`

### Задача 11: Kind'ы `ref`/`registry_ref`/`grant` на сервере: проверка через движок, зеркало-ребро роли `ref`, архивация цели, обратный обход и backlinks (приёмка §С8-8)

**Файлы:**
- Создать: `apps/server/src/registry/ref.ts` (+test)
- Изменить: `apps/server/src/registry/validate-props.ts` (ссылочные kind'ы — серверная проверка
  существования: `ref` — компиляция `target` (`assertStaticQuery` при сохранении определения) +
  `AND id = $1` под RLS через `compileQueryAst`, `many` — `id = ANY($1)` + сверка числа; `registry_ref`
  — по таблице целевого реестра ∪ `CONTRACT_IDS_V1` для `contract` (РП-6); `grant` — существующий
  инвариант `invariants.ts:296-327`), `apps/server/src/executor/executor.ts` (после commit props —
  синхронизация зеркала: для каждого изменённого `ref`-свойства — `relation_create/delete` роли `ref`
  с `meta.property = <id>`, `mechanism: 'rule'` (`mirror_relation` — код части А); архивация цели
  (`archived: true`) — источники по `(target_id, role='ref')` получают тег `needs-review` в той же
  tx), `apps/server/src/import/review.ts:491-506` (обратный обход — по `(target_id, role='ref')`),
  `apps/server/src/entity-read.ts:97-120` (**backlinks видят источники `ref`** — находка 9: рёбра
  `(target_id, role='ref')` с подписью — label свойства из `meta.property`; спека §А8 «backlinks
  видят правила», §А6-2), `ai/escalation.ts:207-213` (валидность категории — через `ref` валидацию),
  тесты `ref.test.ts`, `executor.test`, `import.test`, `entity-backlinks.test.ts`.

**Интерфейсы (produces):**
```ts
// registry/ref.ts
export async function assertRefValue(tx, ctx: CompileCtx, type: Extract<PropertyType,{kind:'ref'}>, value: unknown): Promise<void>;   // VALIDATION 'REF_TARGET' с именем причины: «цель не в множестве target» / «цель архивна» / «не найдена»
export async function syncRefMirror(tx, ownerId, entityId, changed: { propertyId: string; before: unknown; after: unknown }[], reg): Promise<void>;
// истина — свойство; ребро — производное; при расхождении (ребро есть, значения нет) — пересоздаётся (правило 3 §10)
export async function markRefSourcesNeedsReview(tx, ownerId, archivedTargetId): Promise<number>;   // тег 'needs-review' на источниках
```
- [ ] **Шаг 1: падающие тесты:**
```ts
test('orbis/finance_category = id заметки (не категории) → VALIDATION REF_TARGET «цель не в множестве target»', …)
test('установка/смена/снятие orbis/finance_category создаёт/переносит/удаляет ребро role=ref с meta.property; истина — свойство; ребро пересоздаётся при расхождении', …)
test('архивация категории помечает транзакции тегом needs-review; повторная установка той же категории → отказ (архивная цель выпадает из target)', …)
test('orbis/run_routine = id не-рутины → отказ; orbis/rule_scope = "orbis/money-movement" → ок (CONTRACT_IDS_V1); "orbis/nope" → отказ', …)
test('компиляция ref в соединении — с ::uuid (golden строка)', …)
test('import/review: «кто ссылается на категорию» — по (target_id, role=ref), ручного jsonb-SQL нет', …)
test('backlinks категории показывают транзакции и правила памяти по ref с подписью «категория» (label свойства)', …)
```
- [ ] **Шаг 2:** FAIL → **Шаг 3:** реализация. — [ ] **Шаг 4:** PASS; коммит
  `feat(registry): kind ref — проверка значения через движок запросов, зеркало-ребро роли ref, needs-review при архивации цели, backlinks по ref; registry_ref и grant (§А6, приёмка §С8-8)`.

---

## Веха F: тулы LLM, wire, web

### Задача 12: Тулы из реестра свойств — `attach_*` по key, `props` в LLM-контрактах `entity_create`/`entity_update`, `property_catalog`, печать по key, эталон реестра тулов (приёмка §С8-2)

**Граница:** меняются ТОЛЬКО LLM-контракты тулов (JSON Schema + zod `entityCreateInput`/
`entityUpdateInput`) и fast-path; tRPC/UI-надмножества (`entityCreateUiInput`/`entityUpdateUiInput`,
`routers/entity.ts:152-153`) продолжают принимать старую карту через `fromLegacyInput` до Задачи 13c
(web) и 18 (`MemoryRuleCard`) — находка 1 ревью плана.

**Файлы:**
- Создать: `apps/server/src/tools/property-catalog.ts` (+test), `packages/shared/src/registry/tool-schema.ts`
  (+test; генератор JSON Schema `attach_*` из эффективного набора аспекта), `apps/server/test/golden/tool-registry.json`
  (РП-13), `apps/server/src/tools/registry-golden.test.ts`
- Изменить: `apps/server/src/tools/registry.ts:387-434` (`entity_create`/`entity_update` LLM-форма:
  `props` (объект по key ИЛИ id), `aspects: string[]` (create) / `aspects: {attach?, detach?}` +
  `unset?: string[]` (update); `meta` УДАЛЯЕТСЯ), `:960-1008` (`attachToolDef` — `data` из
  `aspectToolJsonSchema`; имена параметров — key; `description` параметра — `label.<locale> —
  description.<locale>` + варианты select), `:985-987` + `dispatch.ts:1517-1519` (единая
  `attachToolName(key)` в shared), `:1021-1032` (служебность — `service` реестра), `:441-443` (уже
  роли), `:473-476`/`dispatch.ts:659-679` (`user_query.field` — key свойства с резолвом в id),
  `tools/dispatch.ts:1559-1579` (attach-схема входа), `:1611-1641` (`entity_card`: `keyFields` по
  property-id, значения `props`), `:1195-1204` (`rowValue` — формат по kind), `:1147-1179`
  (`snapshotDeferredUnit` — по props), `:619-639` (печать результата `entity_query` — LLM-проекция),
  `dispatch.ts:202-206` (**вторая линия `fullScopeOnly`** — гейт вызова: `… && def.fullScopeOnly !==
  true` для скоупа `worker`; находка 47), `apps/server/src/wire.ts` (`toLlmEntity(row, reg)`: `props`
  по **key**, `aspects[]`, без `meta`/`aspectsMap`; `toWireEntity` — по id, для web),
  `packages/shared/src/fast-path/index.ts:216-229` (создание — `props` по id новой внутренней формой;
  `fast-path.test` 22), `routines/propose.ts:62-67` (форма предложения — `props`),
  `routines/constants.ts:47-54` (`CORE_FIELD_LABELS` без `meta`), `packages/shared/src/contracts/tools.ts:16-30`
  (LLM-контракты без `meta`; `entityPropsPatch` из 4b), `mcp/server.ts:61-79` (флаг `fullScopeOnly`
  — РП-14: действует на MCP-скоуп `worker`; `routineToolAllowed :156-177` не меняется — рутине
  `property_catalog` доступен как чтение), тесты `registry.test.ts:123,139,304` (счётчики —
  ПРОИЗВОДНЫЕ от эталона; ожидание 32 чистый / 33 с кастомным через `seedCustomAspect`), `:340-354`
  (парность zod↔JSON Schema, `ZOD_BY_TOOL`), `mcp.test.ts:429-499, :734-808` (full 27, worker 9 +
  тест «worker зовёт property_catalog напрямую → FORBIDDEN_LEVEL» по образцу `:768-774`),
  `dispatch.test.ts` (89), `executor.test.ts` (23 упоминания `attach_orbis`), `v4.test.ts:195-201, :232`
  (гарды про `meta` в промпте — промпт v4 ещё говорит о meta: гарды остаются до Задачи 19; расхождение
  промпта и тулов НАЗВАНО в facts.md и закрывается Задачей 19).

**Интерфейсы (produces):**
```ts
// packages/shared/src/registry/tool-schema.ts
export function attachToolName(aspectKey: string): string;                          // 'orbis/agent-run' → 'attach_orbis_agent_run' (единая нормализация)
export function aspectToolJsonSchema(aspect: AspectDefinition, reg: { properties: Map<string, PropertyDefinition> }, locale: string): Record<string, unknown>;
// {type:'object', properties: {<key>: {...propertyValueJsonSchema(type), description: `${label} — ${description}` (+ «варианты: a|b|c»)}}, required: [keys required], additionalProperties: false};
// порядок properties — по rank (§Б7-3; JSON сохраняет порядок вставки), x-orbis-type в каждом
// tools/registry.ts — новый CORE-тул (форма результата фиксируется здесь сразу с usage — находка 21; Задача 17 добавляет только фильтры orphans/olderThanDays)
{ name: 'property_catalog', kind: 'read', fullScopeOnly: true,
  input: { q?: string; aspect?: string; module?: string; status?: 'active'|'proposed'|'deprecated'; contract?: string /* инертен в А */ },
  result: { properties: { id, key, label, description, type, status, module, usage: { aspects: string[] /* носители */, entities: number } }[] } }
// LLM entity_create input: { id?, title, emoji?, body?, tags?, props?: Record<string /*key|id*/, unknown>, aspects?: string[] /* attach */ }
// LLM entity_update input: { id, expectedUpdatedAt?, title?, …, props?, unset?: string[], aspects?: { attach?: string[]; detach?: string[] }, archived?, precondition? }
// резолв key→id на границе (resolvePropertyRef из 4b); неизвестный key → VALIDATION UNKNOWN_PROPERTY с подсказкой ближайшего key
// wire.ts: export function toLlmEntity(row, reg): { id, title, emoji, body, bodyRefs, tags, props: Record<key, unknown>, aspects: string[], createdAt, updatedAt, archived }
```
- [ ] **Шаг 1: падающие тесты:**
```ts
test('attach_orbis_task: параметры orbis/task_status (required, enum по rank), orbis/priority, …; description параметра = label — description локали; служебный agent-run без тула', …)
test('entity_create {props:{"orbis/amount":"10", "orbis/direction":"expense", "orbis/finance_category": id}, aspects:["orbis/financial"]} → строка props по id; ключ id вместо key тоже принимается; неизвестный key → VALIDATION с подсказкой', …)
test('entity_update {unset:["orbis/waiting_for"]} снимает свойство; {aspects:{detach:["orbis/schedule"]}} снимает аспект, значения остаются', …)
test('meta в input LLM-тула entity_create → VALIDATION (additionalProperties:false); UI-роутер entity.create со старой картой aspects — по-прежнему принимается (до 13c)', …)
test('entity_query печатает props по key (пользовательский uuid-id не доезжает до модели), без meta и без карты аспектов', …)
test('property_catalog: q="катег" находит orbis/finance_category с usage.aspects [financial, budget]; status=proposed — пусто; worker-скоуп MCP тула не видит И не может вызвать; full — видит; рутине доступен', …)
test('fast-path «500 продукты» создаёт транзакцию props по id (аспект financial), без карты', …)
test('эталон реестра тулов: снимок при чистом сиде (13 аспектов, без дельт) равен test/golden/tool-registry.json по canonicalJson; счётчик тулов = длина эталона; с seedCustomAspect — +1', …)
test('две нормализации имени слиты: attachToolName в registry и dispatch — одна функция', …)
```
- [ ] **Шаг 2:** FAIL → **Шаг 3:** реализация; снять эталон. — [ ] **Шаг 4:** PASS (`dispatch.test`
  89, `registry.test`, `mcp.test`, `executor.test`, `fast-path.test` 22), `lint`, `typecheck`; коммит
  `feat(tools): attach_* из реестра свойств (параметры — key), props/aspects в LLM-контрактах entity_create/update, meta снят, property_catalog (fullScopeOnly в списке и на вызове), LLM-проекция по key, эталон реестра тулов (§А9, приёмка §С8-2)`.

---

### Задача 13a: Реестровый ответ `registry.effective` и подписи из реестра в web

**Файлы:**
- Создать: `apps/server/src/routers/registry.ts` (`registry.effective`), `apps/web/src/lib/registry/{useRegistry,labels}.ts`
  (+тесты)
- Изменить: `apps/server/src/routers/aspect.ts` (`aspect.properties` из 10c → `registry.effective`;
  `aspect.list` остаётся для `AspectsList`), `apps/server/src/wire.ts` (`entity.get` отдаёт
  `registryVersion`), `apps/web/src/lib/field-labels.ts` (остаётся ТОЛЬКО `AGGREGATE_LABELS :61-71`;
  `fieldLabel`/`aspectLabel` → `labels.ts` из реестра по локали), 8 читателей подписей
  (`unit-text.ts:100-101`, `EntityCard.tsx:104`, `proposal-text.ts:80,104`, `ProposalCard.tsx:130`,
  `FieldRows.tsx:81`, `NativeRow.tsx:266`, `QueryBuilderForm.tsx:224`, `AspectCards.tsx:122,185,245,298`),
  `lib/query-blocks/useFieldCatalog.ts` (каталог — из `registry.effective`).

**Интерфейсы (produces):**
```ts
// server routers/registry.ts
registry.effective: protectedProcedure.query → { version: `${systemVersion}.${ownerVersion}`, properties: WireProperty[], aspects: WireAspect[], roles: WireRole[] }
// WireProperty = PropertyDefinition (label/description — ПОЛНЫЕ per-locale карты; локаль выбирает клиент); дельты применяются с Задачи 14
// web lib/registry/useRegistry.ts
export function useRegistry(): { data: EffectiveRegistry | undefined; property(idOrKey: string): WireProperty | undefined; aspect(id): …; role(id): …; label(id, locale?): string; version: string };
// TanStack Query key ['registry', version] — версия приходит в entity.get как registryVersion и в ответе самого registry.effective; staleTime: Infinity, инвалидация по смене версии
```
- [ ] **Шаг 1: падающие тесты:** `registry.effective` отдаёт 77 свойств/13 аспектов/11 ролей
  владельцу; подписи 8 читателей — из реестра по локали ru; после смены label в реестре (мок
  ответа новой версии) подпись обновилась без перезагрузки; `field-labels.ts` содержит только
  `AGGREGATE_LABELS` (греп-тест).
- [ ] **Шаг 2:** реализация. — [ ] **Шаг 3:** PASS web, build; коммит
  `feat(web): registry.effective с версией и подписи свойств/аспектов из реестра (§А9-2)`.

---

### Задача 13b: web — форма свойств по реестру, контрол по типу, Detail/Browser/Agenda/чат на `props` по id, фикстуры

**Файлы:**
- Создать: `apps/web/src/lib/registry/{controls,format}.ts`, `apps/web/src/lib/registry/PropertyControl.tsx`
  (+тесты)
- Изменить: `features/entity-detail/AspectCards.tsx:33-70, :84-161` (форма ПО РЕЕСТРУ: секции по
  аспектам сущности, все свойства эффективного состава — незаполненные пустыми, контрол по kind
  (`PropertyControl`: text/number/decimal/boolean-чекбокс/date/timestamp/time/select/many),
  `system_writable` — только чтение, `model_writable:false` — только чтение с пометкой «вычисляется»,
  порядок — rank; свободные свойства — секция «Свойства»; отправка — новой формой `props`/`unset`/
  `aspects.attach|detach`), `NativeRow.tsx:113-149, :161-272` (props по id; `keyFields` из реестра;
  «первый аспект» — по rank аспекта), `EntityRow.tsx:37-85`, `DetailScreen.tsx:44-47, :162-175, :258-259`
  (гейты блоков — `aspects.includes`), `useEntityDetail.ts:28-64` (оптимистичный патч — `props`/`unset`/
  `aspects.attach|detach`), `useTicketRuns.ts`, `TicketWaitingBlock.tsx:143`, `AssignmentCard.tsx:33-44,
  :93-96, :103, :208` (`unset: ['orbis/grant','orbis/may_close']`), `RoutineStatusBlock.tsx:223`,
  `RunFeed/RunsList/RoutineQuestionBlock/RunDecisionsBlock` (`props['orbis/run_*']`), `aspect-read.ts:18-43`
  (ручной разбор — по props; вес первого кадра), `Subtasks.tsx:69` (создание подзадачи — `props`),
  `agenda/{useAgenda.ts:54-83, AgendaScreen.tsx:44-52,83-87}` (механически на props; три запроса
  остаются), `chat/cards/{EntityCard,QueryResultCard,ProposalCard,proposal-text,unit-text,types.ts:1-8,
  ConfirmationCard,DeferredActionCard,QuestionCard}`, `chat/useFastPath.ts:67-79`, `test/harness.tsx` +
  фикстуры `aspectsMap: {…}` в 25 тестовых файлах (→ `props`/`aspects[]`), `meta: {}` в 25 файлах (снять).
- **Не трогать** (род B): `AGGREGATE_LABELS`, `DATE_TOKEN_LABELS` (`FieldRows.tsx:33-38`), словари
  исходов прогона (`useTicketRuns.ts:22-32`, `unit-text.ts:37-57`), `moneyInput.ts`, `format.ts:20-67`,
  `run-poll.ts:9-12` (намеренный дубль литерала).

**Интерфейсы (produces):**
```ts
// web lib/registry/controls.tsx
export function PropertyControl(props: { def: WireProperty; value: unknown; onChange(v: unknown | undefined): void; readOnly?: boolean }): JSX.Element;
// контрол по kind; undefined = снять (→ unset); boolean — чекбокс (не слово 'true'); select many — чипы; decimal — moneyInput-стиль; ref — заглушка с id и title через EntityRef (RefField — Задача 13c)
```
- [ ] **Шаг 1: падающие тесты (vitest):**
```ts
test('AspectCards: у задачи без due_date поле «Срок» показано пустым и редактируемо; boolean — чекбокс; orbis/current_value — только чтение с пометкой', …)
test('NativeRow: keyFields из реестра; generic-строка берёт аспект с наименьшим rank', …)
test('useEntityDetail: снятие свойства шлёт unset, снятие аспекта — aspects.detach; оптимистичный патч не оставляет null в props', …)
test('Agenda: три запроса, чтения props по id — паритет состава на фикстуре (useAgenda.test)', …)
test('фикстуры: ни одного `aspectsMap:` и `meta:` в apps/web/src/features/{entity-detail,agenda,browser,chat}/**/*.test.tsx — греп-тест', …)
```
- [ ] **Шаг 2:** FAIL → **Шаг 3:** реализация. — [ ] **Шаг 4:** PASS web, build, `check-lazy-chunks`
  (контрол по типу — БЕЗ zod/ajv на клиенте), `lint`, `typecheck`; коммит
  `feat(web): форма свойств по реестру, контрол по типу, Detail/Browser/Agenda/чат на props по id (M2, §С1-4 Z5)`.

---

### Задача 13c: web — Финансы, импорт, настройки на `props`; пикер `ref` по kind (пять копий → одна); wire без `aspectsMap`/`meta`; дамп v2

**Файлы:**
- Создать: `apps/web/src/lib/entity-ref/RefField.tsx` (+test) — пикер по `ref.target` (запрос —
  `entity.query` с `ast = target` + `search`), `useRefTitle`
- Изменить: `features/budget/{categories.ts,EnvelopeCard,QuickAddBar,EnvelopeCreateSheet,TransactionsScreen,CategoryScreen,RolloverScreen,
  PlannedToFactCard,usePlanToFactPrompt,useBudget,BudgetScreen}` (props по id; отправка новой формой;
  пять копий пикера → `RefField`: `AspectCards.tsx:176-227`, `QuickAddBar.tsx:237-252`, `EnvelopeCreateSheet.tsx:110-130`,
  `TransactionsScreen.tsx:299-312`, `ReviewTable.tsx:232-245`; `TransactionsScreen.tsx:146-154` тост
  «Добавьте аспект Schedule…» → текст по label аспекта из реестра), `features/import/{ImportFlow,csv-parse,ReviewTable}`
  (маппинг колонок → property-id money-movement-полей; `direction` варианты из реестра),
  `features/settings/AspectsList.tsx` (остаётся списком аспектов на новом wire — `label.ru`, состав
  свойств по `properties[]`; **экран «Свойства» §С4-1 — срез Б-3**, находка 11), `apps/server/src/wire.ts`
  (`aspectsMap` и `meta` УДАЛЯЮТСЯ из `WireEntity` — находка 54; `compile-ast` SELECT-лист без
  `aspects_legacy`), `apps/server/src/executor/types.ts:64-83`, `packages/shared/src/schemas/entity.ts`
  (`props`, `aspects: string[]`, `queryRefs`; без `meta`/`aspectsMap`), `packages/shared/src/contracts/tools.ts`
  (UI-надмножества `entityCreateUiInput`/`entityUpdateUiInput` — старая карта `aspects` больше не
  принимается: все web-отправители переведены здесь, кроме `MemoryRuleCard.tsx:101` — он на новой
  форме с Задачи 18, до неё шлёт `props` напрямую (правка в этой задаче, одна строка) — итого
  union легаси-входа остаётся ТОЛЬКО во внутреннем exec-надмножестве до Задачи 23), `export.ts`
  (дамп `version: 2`: сущности новой формы + пользовательские строки `aspect/property/relation_role_definitions`
  — как сегодня кастомные аспекты; полный канон §С5 со снимком `id↔key↔label` — Б-3), `export.test.ts`.

- [ ] **Шаг 1: падающие тесты:** `RefField` на `orbis/finance_category` показывает категории (и
  ТОЛЬКО категории), на `orbis/run_routine` — рутины; конверт (`orbis/budget`) получает пикер
  автоматически (ref Р6); `EnvelopeCreateSheet` использует `RefField` (греп-тест: литерал
  `CATEGORIES_QUERY` остался в одном месте); импорт кладёт `props` по id; `WireEntity` без
  `aspectsMap`/`meta` — tsc web зелёный; UI-роутер со старой картой `aspects` → VALIDATION;
  `export` v2 читается обратно (round-trip на фикстуре).
- [ ] **Шаг 2:** реализация. — [ ] **Шаг 3:** PASS всех сьютов, web build, `check-lazy-chunks`;
  `bun scripts/check-legacy-form.ts`: `aspectsMap`/`aspects_legacy` — только `executor/legacy-form.ts`
  и его тест; коммит `feat(web): Финансы, импорт на props по id; пикер ref по kind — одна реализация; wire без карты аспектов и meta; UI-контракт без старой карты; дамп v2 (§А6-1, §А9-2)`.

---

## Веха G: кеш реестра, дельты, операции реестра, класс подтверждения

### Задача 14: `registry_version`, кеш эффективных определений, дельты (`registry_deltas`) и трёхстороннее слияние на drift (конфликты — в отчёт; единицы пачки — Задача 15)

**Файлы:**
- Создать: `apps/server/src/registry/cache.ts` (+test), `registry/deltas.ts` (+test), `registry/version.ts`
- Изменить: `registry/load.ts` (`loadRegistry` → через кеш `(ownerId, ownerVersion, systemVersion)`;
  система ⊕ дельты владельца = эффективное определение), четыре сборки реестра тулов
  (`dispatch.ts:174-175`, `mcp/server.ts:59`, `send-message.ts:307`, `runner.ts:238`) и `compile-ast`
  (каталог/служебность — через кеш), `db/registry-drift.ts` + `scripts/ops.ts check/seed-registries`
  (после сида — трёхстороннее слияние: для каждой дельты с `base_version < systemVersion` — правила
  §А3-3: label/description — дельта побеждает молча; новый системный вариант рядом с похожим
  пользовательским и скрытие свойства, ставшего обязательным, — **конфликты**: пишутся в отчёт
  drift (`/health.registryDrift.conflicts`, `ops.ts check`) и в системную заметку глобального треда;
  превращение в единицы пачки с тулами реестра — Задача 15 (у `createPending` нет system-актора —
  находка 46)), `routers/registry.ts` (`registry.effective` — с дельтами), `apps/web/src/lib/registry/useRegistry.ts`
  (версия — `system.owner`).

**Интерфейсы (produces):**
```ts
// registry/version.ts
export async function bumpOwnerRegistryVersion(tx, ownerId): Promise<number>;   // UPDATE user_settings SET registry_version = registry_version + 1 … RETURNING — В ТОЙ ЖЕ tx любой мутации реестра (§А10-1)
export async function readRegistryVersions(tx, ownerId): Promise<{ owner: number; system: number }>;
// registry/cache.ts
export async function effectiveRegistry(tx, ownerId): Promise<RegistrySnapshot>;   // процессный Map по ключу `${ownerId}:${owner}:${system}`; версии сверяются одним SELECT в tx; LRU на 64 владельцев
// registry/deltas.ts
export type AspectDelta = { label?: LocalizedText; description?: LocalizedText; icon?: string;
  properties?: { add?: { propertyId: string; required: boolean; rank: number }[]; hide?: string[]; relaxRequired?: string[]; rank?: Record<string, number> };
  selectOptions?: Record<string /*propertyId*/, { add?: { key: string; label: LocalizedText; rank: number }[] }>;   // РП-19: без карты классов в срезе А
};
export type PropertyDelta = { label?: LocalizedText; description?: LocalizedText };            // Р19 заметок: переопределение подписи встроенного
export function applyDeltas(system: RegistrySnapshot, deltas: RegistryDeltaRow[]): RegistrySnapshot;   // ⊕; двойное объявление (свойство и в дельте аспекта X, и со scope aspect=X) → VALIDATION 'SCOPE_DUPLICATE' (§А3-4)
export function threeWayMerge(prevSystem, nextSystem, delta): { merged: Delta; conflicts: RegistryConflict[] };  // §А3-3
export type RegistryConflict = { kind: 'variant-merge' | 'hidden-required'; targetKind; targetId; propertyId?; detail: string };
```
- [ ] **Шаг 1: падающие тесты:** версия инкрементируется в той же tx, что дельта; кеш
  инвалидируется по версии (два владельца независимы); `applyDeltas` — скрытое свойство исчезает
  из `attach_*` и формы, добавленное — появляется; `relaxRequired` только для свойств из белого
  списка null-толерантности (§А3-2: `orbis/finance_category` у `financial` — недопустим,
  `orbis/due_date` — допустим); `SCOPE_DUPLICATE`; drift с дельтой: label-конфликт — дельта
  побеждает молча, вариант-конфликт — `RegistryConflict` в `/health` и в заметке треда.
- [ ] **Шаг 2:** реализация. — [ ] **Шаг 3:** PASS; коммит
  `feat(registry): registry_version в tx мутации, процессный кеш эффективных определений, дельты аспектов/свойств, трёхстороннее слияние на drift с отчётом конфликтов (§А10-1, §А3-2, §А3-3)`.

---

### Задача 15: Операции реестра через исполнителя — `property_create` (active|proposed, кап 20), `property_update`, `property_merge` (один inverse, advisory-lock, компактация), дельты; граф зависимостей; тулы и tRPC; единицы пачки из конфликтов drift (приёмка §С8-5)

**Файлы:**
- Создать: `apps/server/src/registry/ops.ts` (+test), `registry/deps-graph.ts` (+test), `tools/registry-tools.ts`
  (дефы `property_create`, `property_update`, `property_merge`, `aspect_delta_set`, `aspect_delta_remove`
  — `kind: 'mutate'`, `fullScopeOnly: true`), `routers/registry.ts` (мутации — зеркала тулов через
  `execute`)
- Изменить: `executor/executor.ts` (операции конвейера `registry_*`: validate → apply → journal с
  inverse; замок `pg_advisory_xact_lock(hashtextextended(owner || ':registry', 0))` берётся ПЕРВЫМ —
  до `lockBudgetContour` (`executor.ts:279-284`)), `executor/types.ts` (`ActionRecord.payload` для
  операций реестра), `executor/undo.ts` (inverse `property_merge` = карта «сущность → старый id →
  значение» + возврат `merged_into`/`status`), `tools/registry.ts` (регистрация пяти тулов; эталон
  `tool-registry.json` обновляется), `mcp/server.ts`/`dispatch.ts:202-206` (`fullScopeOnly`),
  `policy/pending.ts` (**`createSystemPending`** — единица пачки от системы: `actor.kind: 'system'`,
  `source: 'system'`; `pendingRecord` и `pending.test.ts` расширяются — находка 46), `registry-drift.ts`/
  `ops.ts check` (конфликты `RegistryConflict` из Задачи 14 → единицы пачки в глобальном треде с
  тулами `aspect_delta_set`/`aspect_delta_remove` и предложением «слить/оставить»), `registry-drift.test`.
- **Экран «Свойства» с операциями (§С4) — срез Б-3** (находка 11); в А операции доступны AI
  (тулы) и tRPC.

**Интерфейсы (produces):**
```ts
// registry/ops.ts (все — внутри execute(); классы подтверждения — Задача 16)
export async function createProperty(tx, ownerId, input: { key?: string; label: LocalizedText; description: LocalizedText; type: PropertyType; status: 'active'|'proposed'; scope?: QueryAst|null; module?: null }): Promise<{ id: string /* uuid (Р3) */; key: string }>;
// key: из input, иначе транслит label.en/ru в `user/<slug>`; коллизия среди видимых (system ∪ свои) → суффикс -2; reserved-слово грамматики — разрешено (§А2-4); кап proposed 20 → REGISTRY_LIMIT «разберите пачку»; pattern → assertPatternRegular; scope → assertStaticQuery и только формы aspect=/tags= (№24)
export async function updateProperty(tx, ownerId, id, patch: { label?; description?; scope?; rank?; status?: 'active'|'deprecated' }): Promise<void>;   // тип/key НЕ меняются (Р3/Ч3); proposed → active/deprecated; proposed без значений и ссылок при отклонении — физическое удаление (§А10-3)
export async function mergeProperty(tx, ownerId, input: { source: string; into: string }): Promise<{ rewrittenEntities: number; rewrittenQueries: number }>;
// типы совпадают (иначе VALIDATION 'MERGE_TYPE'); под замком реестра: merged_into, UPDATE entities SET props = (props - source) || jsonb_build_object(into, props->source) WHERE props ? source; конфликт (оба с разными значениями) → REGISTRY_CONFLICT + единица пачки (createSystemPending), ничего не применено; переписать AST-ссылки (progress_source/scope/ref.target; тела — по query_refs с Задачи 21, до неё — обход body_doc владельца); компактация цепочки; один inverse
export async function setAspectDelta(tx, ownerId, aspectId, delta: AspectDelta): Promise<void>;  removeAspectDelta(...)
// policy/pending.ts
export async function createSystemPending(tx, args: { ownerId; threadId; tool; input; summary; card? }): Promise<{ id }>;   // actor {kind:'system'}, source 'system', level explicit-confirmation
// registry/deps-graph.ts
export function dependencyGraph(reg: RegistrySnapshot, usages: { queryRefs: Map<string, string[]> }): { edges: { from: string; to: string; kind: 'aspect'|'scope'|'ref.target'|'query'|'merged_into' }[] };
export function dependantsOf(graph, propertyId): string[];   // «честные зависимости» (§А3-5, §С1-3 п.10) — отдаётся tRPC `registry.dependants` (экран — Б-3)
export function assertAcyclicGraph(graph): void;             // REGISTRY_CYCLE (в срезе А циклов быть не может; проверка заведена для Б-2)
```
- [ ] **Шаг 1: падающие тесты:**
```ts
test('property_create proposed ×20 → ок, 21-е → REGISTRY_LIMIT; активация proposed → active; отклонение неиспользованного — строка удалена, использованного — deprecated', …)
test('property_merge: значения переписаны, merged_into проставлен, AST в progress_source/scope переписан; undo → байт-в-байт props/AST/merged_into (приёмка §С8-5)', …)
test('merge при конфликте значений: REGISTRY_CONFLICT, ничего не применено, единица пачки в глобальном треде (createSystemPending)', …)
test('drift-конфликт «вариант рядом с похожим» → единица пачки с aspect_delta_set; approve применяет дельту', …)
test('цепочка A→B, затем B→C: merged_into(A) = C (компактация)', …)
test('замок реестра берётся до замка контура (порядок statement\'ов в tx — тест через sql-лог)', …)
test('registry_version растёт на каждую операцию; кеш перечитывает', …)
test('dependantsOf(orbis/task_status) содержит orbis/task и сохранённые запросы, где он упомянут', …)
test('тулы: property_create/merge/aspect_delta_* в full-скоупе MCP есть, в worker — нет (список и вызов); рутине act в allowed_tools — допустимы (гейт уровня — Задача 16)', …)
```
- [ ] **Шаг 2:** реализация. — [ ] **Шаг 3:** PASS; коммит
  `feat(registry): операции реестра через исполнителя — создание (proposed, кап 20), правка, слияние с одним inverse под замком реестра, дельты; граф зависимостей; тулы и tRPC; единицы пачки от системы (§А10-2, §А2-7, §А3-2, §А3-3, приёмка §С8-5)`.

---

### Задача 16: Минимальная правка §7.10 — класс подтверждения мутаций реестра (§С2-1, приёмка §С8-11)

**Файлы:**
- Изменить: `apps/server/src/policy/confirmation.ts` (`ToolCallFacts` += `reconfigures: 'none' |
  'own-property' | 'behavior-delta' | 'system-object'`; `factsFromToolCall :78-109` — по имени тула
  и объекту: `property_create/property_update(label|description|scope|rank)` → `own-property`;
  `property_merge`, `aspect_delta_set/remove`, `property_update(status)` → `behavior-delta`;
  дельта/операция над встроенным `implements`, ролью `created_by: system`, чужим модулем →
  `system-object`; новые ряды в `classifyToolCall` НИЖЕ ряда 3 (страж `confirmation.test.ts:432-443`):
  `reconfigures === 'own-property' && actorKind !== 'owner'` → `preview`; `reconfigures ===
  'behavior-delta'` → `explicit-confirmation` для любого актора), `tools/dispatch.ts:1418-1479`
  (`routineDeferForbidden` += `system-object` — запрет по объекту для фона, не откладывается;
  `behavior-delta` от рутины → отложенная единица через `deferRoutineUnit :988-1070`), `mcp/server.ts`
  (worker: `fullScopeOnly` уже отсекает — тест), тесты `confirmation.test.ts` (30 → +ряды),
  `dispatch.test.ts`, `mcp.test.ts`.
- **PRD §7.10** (`docs/prd/01-architecture.md:1001-1007, :1015, :1019` — вход «перенастраивает
  поверхность или права», ряды §С2-1): правка ГОТОВИТСЯ здесь как часть диффа PRD в леджере
  (`ledger/prd-reform.diff`), а ложится в `main` одним коммитом с «Пересевом мира» (§А12-7/§С10;
  умолчание В-5).

- [ ] **Шаг 1: падающие тесты — по одному на ряд §С2-1:**
```ts
test('property_create proposed из чата (actor model) → preview; от владельца через UI-роутер → execute', …)
test('property_merge из чата → explicit-confirmation (карточка Ш1); от рутины (садовник) → отложенная единица пачки D42, прогон продолжается', …)
test('aspect_delta_set по встроенному implements / роли created_by:system от рутины → отказ по объекту (не откладывается)', …)
test('worker-грант: property_create невидим и на вызове — FORBIDDEN_LEVEL', …)
test('страж «ряды 1–6 не сдвинулись» зелёный; новые ряды — 4a/4b', …)
```
- [ ] **Шаг 2:** реализация. — [ ] **Шаг 3:** PASS; коммит
  `feat(policy): §7.10 — вход «перенастраивает поверхность или права»: preview/explicit-confirmation для операций реестра, запрет по объекту для фона, отложенная единица, worker без реестровых тулов (§С2-1, приёмка §С8-11)`.

---

### Задача 17: Садовник словаря (системная рутина-сид) и П4-замер (приёмка §С8-12)

**Файлы:**
- Создать: `apps/server/src/seed/gardener.ts` (+test) — тело и параметры рутины «Садовник
  словаря»: `orbis/routine_mode: propose`, раз в неделю (`orbis/routine_days: ['mo']`,
  `orbis/routine_at: '09:00'`), инструкция: через `property_catalog` найти дубли по label/description
  → предложить `property_merge` (отложенная единица — Задача 16); отчёт о сиротах
  (`usage.entities = 0` и `usage.aspects = []`) и о `proposed` старше 14 дней — сообщением в тред
  рутины; `scripts/probe-p4.ts` (П4: прогон корпуса сценариев П1 `p1-tasks.json` — перенести в
  assets в этой задаче — через `ai.sendMessage` с живым провайдером; считает `proposed`/день и долю
  несведённых дублей после прогона садовника; без ключа — exit 2)
- Изменить: `apps/server/src/seed/onboarding.ts` (садовник — первая сущность-рутина в сидах; порядок
  сева: категории → смарт-листы → садовник; сеется через `execute` с `mechanism: 'seed'`),
  `tools/property-catalog.ts` (фильтры `orphans`, `olderThanDays` — форма результата с Задачи 12 не
  меняется), **счётчики онбординга** (находка 43): `apps/server/test/e2e.slice1a.test.ts:69, :76,
  :284, :347` (18 → 19, 21 → 22), `seed/onboarding.test.ts` (счётчики состава), `export.test.ts`.

- [ ] **Шаг 1: падающие тесты:** сид садовника идемпотентен (детерминированный id); онбординг
  сеет 19 сущностей; `property_catalog` `orphans` находит свойство без носителя и без значений;
  прогон садовника на `ScriptedProvider` (два похожих `user/effort`/`user/усилие`) кладёт единицу
  `property_merge` в пачку; отчёт о `proposed` старше 14 дней — в треде.
- [ ] **Шаг 2:** реализация. — [ ] **Шаг 3:** PASS; П4 — **блокирующая приёмка §С8-12**
  (находка 48): прогон с живым ключом, цифры и вердикт по порогу в `progress.md`; при превышении
  порога (>1 `proposed`/день устойчиво или >20 % несведённых дублей) — стоп и решение владельца о
  сужении Р14 (план сам не сужает); без ключа — стоп и вопрос владельцу; коммит
  `feat(routines): садовник словаря — системная рутина (дубли, сироты, proposed >14 дней); onboarding 19 сущностей; проба П4 (§А2-7, Р17, приёмка §С8-12)`.

---

## Веха H: правила памяти, промпты, черновики, версия документа

### Задача 18: Правила памяти → свойства `rule_pattern`/`rule_target`/`rule_scope` (В7, §А8, §А12-6); парсер заголовка удалён; легаси-вход снят

**Файлы:**
- Создать: `apps/server/src/memory/rules.ts` (+test) — `formatRuleLabel(pattern, targetTitle)`
  (генерируемая подпись → `title`), `patternFromTransactionTitle(title)` (ПЕРЕНОС
  `rulePatternFromTitle` из shared — он про заголовок ТРАНЗАКЦИИ, не правила, и живёт после
  реформы: `escalation.ts:196, :338` — находка 30), `convertLegacyRules(tx, ownerId)` (одноразовый
  «последний разбор» с ПРИВАТНОЙ копией `RULE_SEPARATOR`; нераспознанные — тег `needs-review`;
  удаляется Задачей 23), `apps/server/src/memory/select.ts` (единый селектор правил:
  `aspects @> ['orbis/memory'] AND props->>'orbis/memory_kind' = 'rule' AND (props->>'orbis/rule_scope'
  = $1 OR NOT props ? 'orbis/rule_scope')`)
- Изменить: `packages/shared/src/memory/rule.ts` (УДАЛИТЬ вместе с `rule.test.ts`; три экспорта:
  `formatRuleTitle :44`, `parseRuleTitle :53` — уходят; `rulePatternFromTitle :78` — переезжает),
  `packages/shared/src/fast-path/index.ts:121-161` (отбор правил по `rule_pattern`/`rule_target`;
  приоритет правил над алиасами — параметр `RESOLVE_ORDER = ['rules','aliases']` с докблоком
  «остаток C: порядок шагов — именованный параметр (R24)»), `apps/server/src/import/review.ts:348-359,
  :382-392` (через `select.ts`), `ai/escalation.ts:196, :235-255, :338, :371-397, :497-502`
  (`hasEquivalentRule` — по `rule_pattern`+`rule_target`; предложение правила — `props`;
  `patternFromTransactionTitle`), `routers/ai.ts:109-135` (создание правила: `{pattern, targetId,
  scope?}` → `props`; `title` генерируется), `llm/context.ts:112-141` (слой памяти — `select.ts` над
  `props`; последнее чтение `aspectsLegacy` на сервере уходит), web: `chat/memoryRules.ts:12`,
  `chat/cards/MemoryRuleCard.tsx:6, :93-104` (шлёт `props` — уже с 13c; текст формата — убрать),
  `settings/MemoryScreen.tsx:25, :36-39, :56`, `entity-detail/NativeRow.tsx:161-165`, `chat/cards/types.ts:32`,
  `tools/registry.ts:233`; `packages/shared/src/contracts/tools.ts` + `executor/legacy-form.ts`
  (`fromLegacyInput` и union легаси-входа в exec-надмножествах СНИМАЮТСЯ — внутренних вызывателей
  старой карты больше нет; в `legacy-form.ts` остаются только проекции `projectLegacyAspects`/
  `projectLegacyRelationType`/`rowFromLegacy` до Задачи 23); `scripts/check-legacy-form.ts` (маркер
  `rule-parser` — без `rulePatternFromTitle`); тесты `fast-path.test` (22), `import.test`,
  `escalation.test`, `ai.test`, web `MemoryScreen`/`cards`.
- Класс «записанное, но молча мёртвое правило» исчезает: правило без `rule_pattern` или с
  `rule_target` вне множества категорий — незаписываемо (валидация реестра; §А8 «fail-closed»).

- [ ] **Шаг 1: падающие тесты:**
```ts
test('создание правила: props {orbis/memory_kind:"rule", orbis/rule_pattern:"пятёрочка", orbis/rule_target:<категория>, orbis/rule_scope:"orbis/money-movement"}; title = formatRuleLabel; без rule_pattern → VALIDATION', …)
test('fast-path: «500 пятёрочка» резолвит категорию по rule_pattern раньше aliases (RESOLVE_ORDER)', …)
test('переименование категории: правило живо (ref), подпись в контексте LLM показывает новое имя', …)
test('convertLegacyRules: "пятёрочка → Продукты" → свойства; "мусор без разделителя" → needs-review; второй прогон — no-op', …)
test('escalation: дубль правила ищется по (rule_pattern, rule_target); patternFromTransactionTitle("ЯНДЕКС.ТАКСИ 450") = "яндекс такси"', …)
test('web MemoryScreen/NativeRow/MemoryRuleCard: строка правила из свойств; parseRuleTitle в дереве отсутствует (греп-тест)', …)
test('exec-вход: старая карта aspects → VALIDATION (union снят); fromLegacyInput не экспортируется', …)
```
- [ ] **Шаг 2:** реализация. — [ ] **Шаг 3:** PASS всех сьютов; коммит
  `feat(memory): правило памяти — свойства rule_pattern/rule_target/rule_scope, title генерируется, один селектор вместо четырёх копий, парсер заголовка удалён; легаси-вход исполнителя снят (В7, §А8, §А12-6)`.

---

### Задача 19: Промпты `v5` и `routine-v3` под новую форму (props по key, namespaced-грамматика, без `meta`) + фикстуры (РП-18)

**Файлы:**
- Создать: `apps/server/src/llm/prompts/v5.ts`, `v5.fixture.txt`, `v5.test.ts`, `routine-v3.ts`,
  `routine-v3.fixture.txt`, `routine-v3.test.ts`
- Изменить: `apps/server/src/llm/context.ts:350` (`SYSTEM_PROMPT_V5`; `PROMPT_BODY`/`CONTINUATIONS_BLOCK`
  Задачи 0b — от v5), `routines/context.ts:28` (`ROUTINE_SYSTEM_PROMPT_V3`), `llm/context.test.ts`,
  `routines/context.test.ts:9`, `send-message.test.ts` (снимки канала), `v4.test.ts:195-201, :232`
  (гарды `meta` — остаются на замороженном v4 как история; на v5 — обратные: «слова meta нет»;
  гард «пример шпаргалки разбирается настоящей грамматикой» `v4.test.ts:16,71,73` — переезжает в
  `v5.test.ts` через `parseQueryAst`, на v4 остаётся литеральный снимок примеров — находка 42).
- Содержание правок (текст описывает УЖЕ существующие тулы и грамматику): абзацы `v4.ts:54`
  (meta) и `:69-70` (соглашение meta-ключей) — удалены; `:50` (перечень полей) → «поля — параметры
  `attach_*`, свободные свойства — `property_catalog`»; `:57-62`, `:78` (примеры грамматики) →
  namespaced key (`orbis/task_status=!done&!cancelled`, `orbis/due_date<=today`, `has=orbis/recurrence`,
  `children_of=<id> via=subitem`) и пример `{ast}` для `entity_query`; `routine-v2.ts:82-87`
  (шпаргалка грамматики) — то же; `routine-v2.ts:57, :69` (запреты по объекту) — через «служебные
  аспекты по реестру». Политика-проза, протоколы результатов и чипов — без изменений (законный
  остаток C, §Б7-1).

- [ ] **Шаг 1:** снять фикстуры новых промптов; тесты: побайтная сверка констант; 12 исполняемых
  гардов v4 переносятся на v5 (примеры key существуют в реестре; числа из констант; «продолжения
  последними» — на канале); `send-message.test` снимок канала обновлён осознанно (дифф прочитан
  построчно).
- [ ] **Шаг 2:** реализация. — [ ] **Шаг 3:** PASS; коммит
  `feat(llm): промпты v5 и routine-v3 — props по key, namespaced-грамматика, AST-вход entity_query, без meta (§А9-1, РП-18)`.

---

### Задача 20: Контракт офлайн-черновиков Т8-в (§А11-2) — до поднятия версии документа

**Файлы:**
- Изменить: `apps/web/src/features/entity-editor/draft-storage.ts:21-33, :48-62, :84, :155-166`
  (форма черновика += `v: number`, `nodeTypes: string[]`; `parseDraft` сверяет форму, не только
  `typeof v === 'number'`), `useBodySave.ts:677-729` (развилка при открытии: `draft.v <
  DOC_SCHEMA_VERSION` → если `nodeTypes ⊆ KNOWN_NODE_TYPES` — перештамповать `v` и идти обычной
  сверкой; иначе — предложение выбором («оставить черновик как текст (в заметку)» / «открыть
  серверное тело»); текст не теряется ни в одной ветке — черновик остаётся в `localStorage` до
  явного решения; молчаливый досыл `:715-724` только при `v === DOC_SCHEMA_VERSION`),
  `packages/shared/src/doc/schema.ts` (экспорт `KNOWN_NODE_TYPES` — имена нод текущей схемы),
  тесты `draft.test.tsx` (50), `save.test.tsx` (47).

- [ ] **Шаг 1: падающие тесты:** черновик `v=1` при `DOC_SCHEMA_VERSION=2` (мок константы) и
  известных нодах → перештампован, досыл штатный; черновик с нодой `unknownNode` → предложение
  выбором, ничего не отправлено; черновик без `nodeTypes` (старый формат) → «состав неизвестен» →
  предложение; `rejected` ветка прежняя.
- [ ] **Шаг 2:** реализация. — [ ] **Шаг 3:** PASS web; коммит
  `feat(editor): контракт офлайн-черновиков Т8-в — версия и состав нод в черновике, перештамповка вместо молчаливого досыла (§А11-2)`.

---

### Задача 21: `DOC_SCHEMA_VERSION` +1; query-блок хранит `ast`; `query_refs`; дифф по key-форме; редактор и сиды на AST; старая грамматика удалена (приёмка §С8-9)

**Файлы:**
- Изменить: `packages/shared/src/doc/types.ts:8` (`DOC_SCHEMA_VERSION = 2`), `doc/nodes/query-block.ts:6-16, :33-51`
  (атрибуты: `ast: QueryAst | null`, `text: string | null` — `text` только у неразобранного;
  markdown-проекция печатает `{{query: <key-форма>}}` из `ast`), `doc/convert.ts:45-77, :492-508, :555-567`
  (`readBodyDoc(stored, body, reg)` — v1 → v2: текст блока парсится по реестру → `ast`;
  `queryRefsFromDoc(doc)` — по образцу `bodyRefsFromDoc`), **все вызыватели `readBodyDoc`**
  (находки 10/44): `apps/server/src/entity-read.ts:67`, `routers/version.ts:34-37`,
  `routines/proposal-diff.ts:196` (реестр передаётся параметром из lifecycle — `effectiveRegistry(tx,
  ownerId)` Задачи 14, не второй загрузкой), `routers/routine.test.ts:1374`, `packages/shared/src/doc/convert.test.ts:1252,1254,1270`
  (+1) — фикстурный `ParseRegistry` из `query/ast-fixtures.ts`; `doc/diff.ts:177-181, :241`
  (`KEY_ATTRS` += `queryBlock:ast`; `collectText` печатает key-форму через `printQueryAst(ast, reg,
  'key')` — ребро `diff → query/print` НАЗВАНО в докблоке; страж чанка `save.test.tsx:1363`
  проверяется), `apps/server/src/executor/executor.ts:1374-1378, :1386-1392` (`query_refs` в обеих
  ветках записи; гейт версии — v2), `executor/body-doc.test.ts:714` (`toBe(2)` — осознанно, с
  правкой докблока), `apps/web/src/features/entity-editor/nodes/QueryWidget.tsx:14-38` (атрибут
  `ast`; барьер `}}` исчезает), `lib/query-blocks/QueryBlock.tsx:46-86` (ошибка — из `text`),
  `query-builder/{QueryBlockEditor.tsx:50-59, QueryBuilderForm.tsx:134-138, model.ts:198-218}`
  (развилка «печатается ли обратно» исчезает; OR между полями — разблокирован),
  `features/entity-editor/slash/items.ts:29, :81-90` (вставка блока = AST), `browser/query.ts:42,
  :52-86` и `lib/query-blocks/parse.ts:7` (разбор `{{query:}}` из body — только для markdown-проекции;
  истина — `ast` в `body_doc`), `seed/smart-lists.ts`, `seed/project-body.ts` (тела — markdown в
  key-форме; `project-body.ts:43`: `project_id=${projectId}` → `orbis/parent_project=${projectId}`
  — находка 29; при засеве парсятся в `ast`), `seed/onboarding.ts:226-243, :275-285` (бэкфилл D42 —
  по признаку «блок пачки присутствует в body_doc»; `ROUTINES_LIST_BODY_BEFORE_BATCH` удаляется вместе
  с докблоком «править нельзя» — предпосылка отменена §А12-3), `seed-canon.test.ts`, `project-body.test.ts:9,39`,
  `onboarding.test.ts:15,197-238` (пин тел — против PRD 02 §3.3 в новой форме: сравнение AST обеих
  сторон; PRD §3.3 правится в Задаче 23 тем же коммитом с сидами — до него тест сравнивает
  key-форму с константой сида), **старая грамматика УДАЛЯЕТСЯ** (потребителей больше нет — находка 4):
  `packages/shared/src/query/{grammar,parse,serialize,legacy-bridge}.ts`, `catalog.ts` (`buildFieldCatalog`,
  `propType`), `fixtures.ts` старой формы, их тесты; `apps/server/src/query/parse-text.ts`
  (`parseQueryAny` → `parseQueryAst`), `llm/prompts/v4.test.ts:16,71,73` (уже литеральный снимок с
  Задачи 19), `apps/server/src/registry/ops.ts` (`mergeProperty` — переписывание AST по `query_refs`).

**Интерфейсы (produces):**
```ts
// doc/nodes/query-block.ts — attrs: { ast: QueryAst | null; text: string | null }   // ровно одно из двух не null
// doc/convert.ts
export function readBodyDoc(stored: unknown, body: string, reg: ParseRegistry): BodyDoc;   // v1-документ/markdown → v2: блоки парсятся; не разобранный → {ast:null, text}
export function queryRefsFromDoc(doc: BodyDoc): string[];   // уникальные id свойств/аспектов/ролей + uuid сущностей из rel.of
// entities.query_refs — заполняется executor'ом при каждой записи тела (как body_refs)
```
- [ ] **Шаг 1: падающие тесты:**
```ts
test('тело без query-блоков: v1 → чтение даёт v2 байт-в-байт по содержанию (Т8-в: ничего не потеряно)', …)   // приёмка §С8-9
test('query-блок v1 с текстом старой формы → ast (по реестру через мост до удаления); с опечаткой → {ast:null, text} и ошибка в UI', …)
test('печать блока в markdown — key-форма; дифф Ш1 различает блоки по ast, переименование label ничего не меняет', …)
test('query_refs: блок с orbis/task_status и children_of=<uuid> → refs содержат оба; merge свойства переписывает ast блока и refs', …)
test('бэкфилл D42: тело владельца с блоком пачки — no-op; без блока — блок добавлен; текст владельца не затёрт', …)
test('сиды: шесть тел смарт-листов и тело проекта парсятся без rawBlock (seed-canon на AST); блок «Последние прогоны» — orbis/parent_project', …)
test('proposal-diff: дифф предложения с query-блоком читается через реестр из lifecycle', …)
test('web: QueryWidget правит ast; вставка блока слэшем — ast; QueryBlock показывает ошибку из text', …)
test('старая грамматика удалена: импорты grammar/parse/serialize/legacy-bridge отсутствуют (греп-тест)', …)
```
- [ ] **Шаг 2:** реализация. — [ ] **Шаг 3:** PASS всех сьютов, web build, `check-lazy-chunks`;
  коммит `feat(doc): DOC_SCHEMA_VERSION 2 — query-блок хранит Q-AST, text только у неразобранного; query_refs; дифф по key-форме; редактор и сиды на AST; бэкфилл D42 по признаку блока; старая грамматика удалена (§А11-1, §А5-2, §А12-3, приёмка §С8-9)`.

---

## Веха I: документы, пересев мира, приёмка

### Задача 22: Документы реформы — дифф PRD §С10 и runbook подготовлен и отревьюирован (ложится одним коммитом в Задаче 23)

**Умолчание В-5 (по спеке §А12-7/§С10):** правки PRD идут ОДНИМ коммитом с «Пересевом мира».
Чтобы 315 строк §3 не вычитывались на хвосте ветки, дифф готовится и ревьюится здесь, хранится
как `ledger/prd-reform.diff` (+ фрагмент §7.10 из Задачи 16) и применяется в Задаче 23.

**Состав диффа:**
- `docs/prd/01-architecture.md` — §2.1/§2.4 (пять слоёв без `meta`; пример «кроссовки» в новой
  форме), §3 целиком (`147-461` → таблица перевода §А8 + §3.8 «пять реестров», §3.9/§3.10 — отмена
  (Р14) с заменой на «свободные свойства + навесь аспект»), §4.1–§4.3 (колонки §С6, роли, форма
  `aspect_definitions`), §4.9/§4.10 (индексы и RLS новых таблиц, третья категория `<app>/`), §6
  (булево дерево, `has=`, `via=`, namespaced key, квалификация label, снятие `due` и §12-7; §6.3 —
  потребителей больше шести), §7.1 (бюджеты слоёв — измеренные П3: слой 1 — 3 055 факт / цель
  ≤ 2 000; слой 5 — 5 521), §7.6/§9.2 (реестр тулов: `attach_*` из свойств, `property_catalog`,
  AST-вход, предусловия `{property, …}`), §7.10 (фрагмент Задачи 16), §10 (правила реестра), §12
  (снять п.7 и п.10; границы Q как осознанные), §13 (п.8–18 §С7); терминологическая пометка «`mechanism`
  в коде = `MutationSource` спеки» (РП-4);
- `docs/prd/02-core-os.md` §3.3 (тела шести сидов — key-форма; байт-в-байт с `seed/smart-lists.ts`
  Задачи 21/23), §3.4–§3.6 (query-блок с `ast`; строки — M14 как норматив части Б), §3.9
  (служебность — колонка реестра), §4.1–§4.2 (Agenda одной подпиской — «исполнение Б-1»), §7.1
  (тело проекта — `orbis/parent_project`; сиды через исполнителя, N = 19 сущностей);
- `docs/prd/03-budget.md` §2.2–§2.4 (роль `envelope-binding`; формулы — «подписка §Б5-4 — Б-1»);
- `docs/prd/00-product.md` §11 (`:252`), глоссарий (+ свойство, контракт, привязка, подписка,
  действие, модуль, роль ребра);
- `docs/implementation/02-ops-runbook.md` §1 (чек-лист деплоя реформы — РП-7: автодеплой,
  миграции, `reset-world`, ручной deploy), §4.3 (список таблиц `:919-921` +7 и скрипт перепривязки
  `:937-946`), §7 (`registryDrift` на пять реестров, `conflicts`), §8 (устаревший путь перф-гейта
  `:1177, :1186-1188` → `apps/server/perf/perf.test.ts`; скрипты `test:perf:graph`/`test:perf:explain`
  вне CI).

- [ ] **Шаг 1:** черновик диффа (сабагент-писатель по спеке §С10 и §А8), вычитка против спеки
  построчно: каждое утверждение PRD либо повторяет решение спеки, либо помечено «часть Б».
- [ ] **Шаг 2:** гейт-ревью fable диффа (документы — тоже деливеребл: «ложные комментарии —
  отдельный класс дефекта», урок Ш1). Дифф — в леджер; коммита в `main` нет (В-5). Запись в
  `progress.md`.

---

### Задача 23: «Пересев мира» — миграция 0017 (contract), снятие старой формы, сиды через исполнителя, греп-гейт падающий, EXPLAIN-приёмка, `reset-world`, тела сидов и PRD одним коммитом (приёмка §С8-10)

**Строго последняя кодовая задача; не разрезается** (тела сидов, PRD, seed-canon, перф-фикстура,
greps и EXPLAIN держат друг друга).

**Файлы:**
- Создать: `apps/server/src/db/migrations/0017_reform_contract.sql` (+snapshot), `apps/server/src/seed/world.ts`
  (+test) — единая точка засева графа владельца через `execute()`
- Изменить/удалить: `apps/server/src/executor/legacy-form.ts` (УДАЛИТЬ + `packages/shared/src/registry/legacy-field-map.ts`,
  `legacyAspectJsonSchema`; `schemas/aspects.ts` zod-схемы аспектов УДАЛИТЬ — golden `validator-verdicts`
  замораживается: `legacyVerdict` становится литералом в JSON, тест сверяет только `newVerdict`),
  `db/schema.ts` (`aspectsLegacy`, `meta`, `relationType` — снять; `aspect_definitions.schema` — снять),
  `apps/server/src/wire.ts:207-238` + `export.ts` (`WireAspectDefinition.schema` снимается — находка 54),
  `scripts/seed-registries.ts` (без `schema`), `scripts/ops.ts` (`reset-world` — РП-7; `check`/
  `seed-registries`/`migrate` — сверить), `scripts/check-legacy-form.ts` (allowlist → тесты грамматики
  на отказ старой формы + перечисленные с причиной места `relations.meta`; `--gate` в CI: шаг после
  `bun run test`), `.github/workflows/ci.yml` (+ `bun scripts/check-legacy-form.ts --gate`),
  `seed/onboarding.ts:99-150` (категории, смарт-листы, садовник — через `world.ts` → `execute()`
  с `mechanism: 'seed'`, детерминированные id; порядок: категории → смарт-листы → садовник;
  бюджет-хук и инварианты работают на засеве), `seed/smart-lists.ts`, `seed/project-body.ts` (имена
  аспектов в прозе тел `:48, :50` и докблоках `:86-89` — по label), `seed-canon.test.ts`,
  `onboarding.test.ts:197-238` (пин тел — против PRD 02 §3.3 в новой форме), `docs/prd/**` и
  `docs/implementation/02-ops-runbook.md` — **применение `ledger/prd-reform.diff` Задачи 22 тем же
  коммитом** (§А12-7), `docs/prd/04-decision-log.md` (D43: статус), `src/test/perf.ts` и
  `perf/perf.test.ts` (фикстура и входы — новая форма; сторож `:202-251` на `props`/`role`;
  бюджеты — перезамер: при отклонении > 20 % — запись в `progress.md` и решение владельцу),
  `test/helpers.ts` (`truncateAll` — финальный список), `memory/rules.ts` (`convertLegacyRules` —
  удалить вместе с вызовом), `apps/web/src/test/harness.tsx` и фикстуры (`--gate` покрывает web),
  `render.yaml` (`autoDeploy` — обратно, отдельным docs-коммитом в `main` ПОСЛЕ прод-процедуры —
  Шаг 6).

**Интерфейсы (produces):**
```sql
-- 0017_reform_contract.sql — пишется ОДИН раз, по готовому вердикту EXPLAIN Задачи 9a (находки 20/45)
ALTER TABLE entities DROP COLUMN aspects_legacy;      -- entities_aspects_legacy_gin уходит с колонкой
ALTER TABLE entities DROP COLUMN meta;                -- entities_meta_gin — с колонкой (0001:104)
-- DROP INDEX <каждый GIN из entities_props_gin / entities_aspects_gin / entities_query_refs_gin, НЕ подтверждённый EXPLAIN-вердиктом 9a>;
ALTER TABLE relations DROP CONSTRAINT rel_uniq;
ALTER TABLE relations ADD CONSTRAINT rel_uniq UNIQUE (source_id, target_id, role);
DROP INDEX IF EXISTS relations_source_type; DROP INDEX IF EXISTS relations_target_type;   -- имена — 0001:114-116
ALTER TABLE relations DROP COLUMN relation_type;
DROP FUNCTION reform_role_heuristic(text, jsonb, jsonb);
ALTER TABLE aspect_definitions DROP COLUMN schema;    -- JSON Schema — генерируемая производная (§А3-1)
```
```ts
// scripts/ops.ts — новая операция (белый список; РП-7)
'reset-world': { help: 'РАЗРУШАЮЩАЯ: снести граф и журнал владельцев, пользовательские строки реестров и дельты; пересеять три реестра. Требует --confirm <PROD_REF> и повторного ввода слова RESET' }
// seed/world.ts
export async function seedOwnerWorld(db, ownerId, deps): Promise<{ created: number; skipped: number }>;   // категории (12), смарт-листы (6), садовник (1) = 19; всё через execute({ mechanism: 'seed', source: 'system' }); идемпотентно по детерминированным id
// perf/explain.test.ts — повторный прогон как ПРИЁМКА: вердикты обязаны совпасть с DROP-списком 0017 (пин)
```
- [ ] **Шаг 1: греп-гейт в режиме `--gate` на ветке** — список совпадений = план работ задачи;
  все — устранить (кроме allowlist). **Шаг 2:** миграция 0017 (DROP-список — из вердикта 9a) +
  удаление `legacy-form`/zod-схем/парсера правил; локальная база с нуля: `bunx supabase db reset &&
  bun run db:prepare` (0014–0017 накатываются последовательно на пустую базу — это и есть проверка
  комплекта); полный сьют зелёный. **Шаг 3:** `bun run test:perf:explain` — вердикты совпадают с
  0017 (пин). **Шаг 4:** сиды через исполнителя + тела в key-форме + применение `prd-reform.diff`
  тем же коммитом; `seed-canon`, `onboarding.test`, `e2e.slice1a` (онбординг 19 сущностей — число
  из Задачи 17) зелёные; `reset-world` с тестом на локальной базе (после — `check` ok, граф пуст,
  гранты целы). **Шаг 5:** `test:perf` (перезамер), `check-lazy-chunks`, `lint`, `typecheck`;
  коммит `feat: «Пересев мира» — миграция 0017 (contract), старая форма снята, сиды через исполнителя, греп-гейт §А12-2 падающий в CI, EXPLAIN-приёмка, ops reset-world, тела сидов и PRD §С10 одним коммитом (§А12, приёмка §С8-10)`.
- [ ] **Шаг 6 — прод (по чек-листу runbook §1; выполняет оркестратор с владельцем):**
  (0) ветка зелёная полным сьютом, ff-мерж в `main`, CI зелёный; проверка `autoDeploy` через
  `mcp__render__get_service`/`list_deploys` (деплоя на мерж НЕ было); (1) `bun scripts/ops.ts ping`;
  (2) `ops.ts check` (ожидаемо: drift — реестры новой формы ещё не засеяны — это не отказ);
  (3) `ops.ts migrate` — 0014…0017 (Supabase pooler, prepared statements: после миграции —
  Restart сервиса неизбежен); (4) `ops.ts reset-world --confirm <PROD_REF>`; (5) `ops.ts check` → ok;
  (6) ручной deploy `main` в Render (Manual Deploy → latest commit) и Restart; (7) `/health` без
  `registryDrift`; (8) `render.yaml`: `autoDeploy` обратно — docs-коммит в `main` (Blueprint-sync;
  проверка `get_service`); (9) заход владельца — онбординг сеет граф через исполнителя; (10)
  прод-смоук Задачи 24.

---

### Задача 24: Приёмка среза А живьём (§С8 пп. 1–13, включая 11), финальное ревью ветки, итог

**Файлы:** `.superpowers/sdd/2026-08-26-properties-reform-a/acceptance-a.md`, `prod-smoke.md`,
`progress.md` (итог), `docs/prd/04-decision-log.md` (D43 — статус «часть А реализована и в проде
<дата>, main <хеш>; гейт П5 — следующий шаг»).

- [ ] **Шаг 1:** финальное ревью ветки fable (дифф `main@до`…`main@после` по задачам; «что должно
  было измениться, но не изменилось»; мутационные пробы деливереблов 4b, 5, 9a, 15, 16, 23).
- [ ] **Шаг 2:** приёмка по маппингу ниже — каждый пункт: команда/сценарий → исход → ссылка на
  тест или запись прогона (пп. 4 и 12 — записи живых прогонов Задач 9a/17); прод-смоук: вход,
  онбординг (категории/листы/садовник), fast-path транзакция (props по id, зеркало ref),
  `entity_query` из чата с `has=`, правка свойства в Detail, недоступность `property_catalog`
  worker-гранту (список и вызов), `/health`.
- [ ] **Шаг 3:** сводный учёт ревью по срезу (по образцу D42), рулинги, остатки владельцу (в т.ч.
  В-3 — пересчёт 642/648, EXPLAIN-вердикты, перезамер бюджетов perf); коммит
  `docs: срез А реформы свойств — приёмка §С8 1–13, итог леджера, статус D43`.

---

## Вехи и прогоняемые проверки

| Веха | После задач | Проверка (коды возврата 0, машина незанята) |
|---|---|---|
| 0-серия | 0, 0a, 0b, 0c | `bun run test`, `lint`, `typecheck`; отчёт греп-гейта — стартовые цифры в `facts.md`; `autoDeploy: false` подтверждён через Render MCP |
| A. Реестры | 1–3 | `bun run db:prepare` (0014 + сид трёх реестров), `bun run test`, `test:rls` (plan поднят), `lint`, `typecheck`; ревью fable: 77/11/13 строк, drift двусторонний, `/health`; golden §С8-1 — 0 непредвиденных расхождений |
| B. props | 4a, 4b, 5, 6 | `db:prepare` (0015), `bun run test`, `test:perf`; ревью fable: инвариант проекции, гейты флагов, CAS по типу, undo байт-в-байт, эскалация «ноль по новой форме», `operationIds` не сломан; приёмка 6 на сьютах Ш1/D42 |
| C. Роли | 7a–7b | `db:prepare` (0016 на пустой и непустой базе), `bun run test`, web build; ревью fable: приёмка 7 (цикл, ×2 envelope-binding, ROLE_SYSTEM_ONLY), пересчёт предков, ограничение интервала `rel_uniq` названо |
| D. Q-AST | 8, 9a, 9b, 10a–10c | `bun run test`, `test:perf`, `test:perf:graph` (П6), `test:perf:explain` (вердикты), web build, `check-lazy-chunks`; ревью fable: golden 27+ вручную + мутация, датасет, окно материализации, мост старой грамматики; приёмки 3, 4 (живой прогон), 13 |
| E. ref | 11 | `bun run test`; ревью fable: приёмка 8, backlinks по ref |
| F. Тулы/web | 12, 13a–13c | `bun run test`, web build, `check-lazy-chunks`; ревью fable: приёмка 2 (эталон реестра тулов), MCP full/worker (список и вызов), формы по реестру, ноль `aspectsMap:`/`meta:` в фикстурах web |
| G. Реестр | 14–17 | `bun run test`; ревью fable: приёмки 5, 11, 12 (живой прогон П4); замок реестра первым; страж рядов §7.10; онбординг 19 |
| H. Память/промпты/документ | 18–21 | `bun run test`, web build; ревью fable: приёмка 9 (сценарий молчаливого досыла НЕ воспроизводится), фикстуры v5/routine-v3 прочитаны построчно, старая грамматика удалена |
| I. Пересев | 22–24 | docs-ревью fable диффа PRD (22); `bunx supabase db reset && bun run db:prepare` (0014–0017 с нуля), полный сьют, `test:perf` (перезамер), `check-legacy-form --gate` = 0, `test:perf:explain` = 0017; прод-процедура РП-7; финальное ревью ветки fable; приёмка 1–13 |

## Порядок деплоя (кратко; подробно — Задача 23 Шаг 6 и runbook §1 из диффа Задачи 22)

Автодеплой выключен с Задачи 0 (РП-1, проверка через Render MCP) → все задачи мержатся в `main`
без выкатки → после Задачи 23: зелёный полный сьют → `ops.ts ping` → `check` → `migrate`
(0014–0017) → `reset-world` → `check` → ручной deploy + Restart → `/health` → `autoDeploy` обратно
→ заход владельца → смоук (Задача 24). Пересев ТОЛЬКО после зелёного сьюта в ветке (§С9-6, урок D42).

## Маппинг приёмки спеки §С8 (срез А) → задачи

| Приёмка | Задачи |
|---|---|
| 1. Golden «сущность → вердикт»: старый и новый валидатор совпадают (13 аспектов + негативные) | 2 (корпус и сверка; ожидаемые расхождения перечислены), 23 (корпус заморожен, старый валидатор снят) |
| 2. `attach_*` из реестра свойств, параметры — key, description = label+description; снимок реестра тулов = эталон | 12 (генератор, эталон `tool-registry.json`), 15 (эталон обновлён тулами реестра) |
| 3. Q-AST golden «AST → SQL → результат» для всех конструкций §А5-1/§А5-7, `descendants_of via` кап 32, `has`, OR; невыразимое — ошибка разбора | 8 (парсер, QUERY_JOIN/QUERY_MULTI_ROLE, фикстуры), 9a (компилятор, golden, датасет) |
| 4. `entity_query` принимает AST; рекурсивная JSON Schema на OpenAI при `strict:false` | 9a (`probe-openai-schema.ts` — живой прогон, БЛОКИРУЮЩИЙ), 9b (`{query|ast}`) |
| 5. Слияние свойств: apply → undo → байт-в-байт; конфликт — единица пачки, частичного слияния нет | 15 |
| 6. CAS по `{property, in|absent}`; `"10.0"` = `"10.00"`; пути D42/Ш1 на новой форме | 5 (сьюты `routine.test` 72, `dispatch.test` 89 зелёные) |
| 7. Роли: `rel_uniq(source,target,role)`; цикл `dependency` — отказ с путём; `envelope-binding` ×2 — отказ; `ROLE_SYSTEM_ONLY` | 7a (ограничения; интервал `rel_uniq` назван), 23 (индекс `rel_uniq` пересобран) |
| 8. `ref`: вне множества — отказ; зеркало-ребро; архивация → `needs-review`; `::uuid`; backlinks видят источники | 11 (+ golden-строка компиляции в 9a) |
| 9. `DOC_SCHEMA_VERSION`: черновик перештампован без молчаливого досыла; тело без блоков — байт-в-байт | 20 (контракт черновиков), 21 (бамп, чтение v1 → v2) |
| 10. «Пересев мира»: §А12 п.1–7 (три сида, пять таблиц у drift/health/check, греп-гейты — ноль, сверки каноном переведены, роли рёбер, правило памяти В7, PRD одним коммитом); EXPLAIN-приёмка индексов | 3 (пять реестров у drift/health/check), 18 (В7), 21 (бэкфилл D42 по признаку, seed-canon на AST), 22 (дифф PRD подготовлен), 23 (0017, сиды через исполнителя, `--gate` в CI, EXPLAIN = 0017, `reset-world`, тела + PRD одним коммитом). Оговорки: маркер `->>'` §А12-2 не заводится — после перевода `props->>'…'` законен, покрытие даёт `aspects(_legacy)?\s*->` (0c); «снимки промптов по В10»: генератора промпта в А нет (§Б7 — часть Б), норма В10/§0.2-15 удовлетворяется побайтной фикстурой статических констант v5/routine-v3 (19); снимок ГЕНЕРАТОРА на мок-реестре — Б-3 |
| 11. Класс подтверждения мутаций реестра: `proposed` из чата — preview; слияние/дельта — explicit-confirmation; садовник — отложенная единица; фон по system-объектам — запрет; `worker` без реестровых тулов | 16 (ряды и тесты), 12 (`fullScopeOnly` — список и вызов), 15 (тулы), 17 (садовник как источник единиц) |
| 12. П4: прогон истории через Р14 с `proposed` и садовником; порог >1/день или >20 % дублей → сужение Р14 (решение владельцу) | 17 (`probe-p4.ts`, живой прогон, БЛОКИРУЮЩИЙ; цифры в progress) |
| 13. П6: `descendants_of via=subitem` 50k/150k глубина 8 — p95 ≤ 100 мс; пересчёт `nearest_ancestor` 5k — ≤ 1 с | 9a (`test:perf:graph`), 7b (движок пересчёта) |
| 14. П5-пересчёт — гейт части Б | вне плана (после приёмки 1–13; В-3 — порог 321/324) |

## Маппинг инвариантов §С7 (п.8–18) → задачи среза А

| Инвариант | Что делает срез А |
|---|---|
| 8. Паспорта родов | спека; план не строит |
| 9. Покрытие без пустых клеток | спека (В-3 — пересчёт владельцу) |
| 10. 20 канонических отказов с мутационной проверкой | часть Б (24); в А заведены и покрыты фикстурами: `COMPUTED_WRITE` (4b), `ROLE_SYSTEM_ONLY` (7a), `SCOPE_NOT_STATIC` (8, 11, 15), `QUERY_JOIN`/`QUERY_MULTI_ROLE` (8), `PATTERN_NOT_REGULAR` (1) |
| 11. Граф зависимостей на каждой записи реестра; честные зависимости из графа | 15 (`deps-graph.ts`, tRPC `registry.dependants`; экран — Б-3) |
| 12. Консервативность — снимки поверхностей | часть Б (20) |
| 13. Обратимость по шаблонам T | в А: golden «apply → undo → байт-в-байт» по props (6), слияние (15) |
| 14. Один язык — греп-гейт формул | часть Б; гейт §А12-2 — 0c/23 |
| 15. Тьюринг-тест наоборот | часть Б |
| 16. Операция реестра атомарна, один undo | 15 |
| 17. Мутация реестра не бывает молчаливой | 16 (тест на каждый путь: чат, рутина, MCP; сид — drift-отчёт 3/14/15) |
| 18. `registry_version` монотонен, кеши не переживают смену | 14 |

## Самопроверка плана

- **Покрытие спеки (часть А + сквозные, применимые к А):** §А1-1 → 4a/4b (props/aspects[]), 23
  (meta снят); §А1-2 (свободные свойства, proposed) → 12 (`property_catalog`), 15; §А1-3
  (core-проекции, псевдо-аспект) → 1, 5; §А1-4 (индексы, EXPLAIN) → 4a, 9a, 23; §А2-1 → 1, 3; §А2-2
  (словарь) → 1, 2 (propType — удалён в 21); §А2-3/§А2-4 (четыре имени, слаг) → 1, 15; §А2-5
  (system_writable по источнику) → 4b (mechanism), 7a; §А2-6 (default) → РП-9 (1, 10a/10b); §А2-7
  (proposed, кап 20, садовник) → 15, 17; §А3-1 → 1, 3, 12; §А3-2 (дельты) → 14, 15; §А3-3
  (трёхстороннее слияние) → 14, 15; §А3-4 (дельта vs scope) → 14; §А3-5 (честные зависимости) → 15;
  §А4-1 → 7a, 23; §А4-2 → 1, 3; §А4-3 → 1 (роли), 7a (ограничения), РП-5; §А4-4 → 4b (ось), 7a;
  §А4-5 → 7a (восемь точек, эвристика в 0016); §А5-1/§А5-7 → 8, 9a; §А5-2 (только AST, печать,
  дифф, query_refs) → 21; §А5-3 (грамматика) → 8; §А5-4 (`entity_query`) → 9a/9b; §А5-5 (Agenda) —
  не в А (тексты в key-форме — 10c, три запроса остаются); §А5-6 (служебность из реестра) → 9a;
  §А6-1…§А6-4 → 11 (+13c пикер); §А7-1 → 2, 4b; §А7-2 (инварианты кодом на props; «один
  budget-parent» → роль) → 4b, 7a; §А7-3 → 5; §А7-4 → 6; §А8 → 1 (+ РП-8/Р-17); §А9-1 → 12;
  §А9-2 → 12, 13a, 13b, 13c; §А9-3 → 12, 17 (фильтры); §А9-4 → 12 (fullScopeOnly — список и вызов),
  16; §А10-1 → 14; §А10-2 → 15; §А10-3 → 15; §А11-1 → 21; §А11-2 → 20; §А12-1…7 → 3, 18, 21, 22,
  23; §С2-1 (минимум) → 16; §С6 → 3, 4a, 7a, 23; §С8 1–13 → маппинг выше; §С9-0 → 0a/0b (+0c);
  §С9-6 → РП-1, 23. Не строится в А (и не должно): контракты, привязки, подписки, каталог правил,
  язык E, действия, генератор промпта-индекс, модули, семь гардов и снимок генератора,
  `envelope_spent_cache`, `class()` в компиляторе (узел есть, отказ с кодом), `VARIANT_UNMAPPED`
  (РП-19), Agenda одним запросом, поверхности реестра §С4 и канон экспорта §С5 (Б-3).
- **Плейсхолдеры:** «TBD/TODO/позже» нет; каждый код-шаг снабжён именованными тестами; сигнатуры
  в блоках «Интерфейсы»; где спека оставляет выбор — решение плана РП-N с обоснованием.
- **Согласованность имён:** `PropertyDefinition/AspectDefinition/RelationRoleDefinition`,
  `BUILTIN_PROPERTY_META/BUILTIN_RELATION_ROLE_META/BUILTIN_ASPECT_DEFS`, `RELATION_ROLE_IDS/
  HIERARCHICAL_ROLE_IDS`, `CONTRACT_IDS_V1` (1) — в 2, 3, 4a/4b, 7a, 8, 11, 12, 15;
  `propertyValueJsonSchema/validateEntityProps/legacyAspectsToProps/legacyFieldToProperty` (2) — в
  4a/4b, 5, 12, 23; `RegistrySnapshot/loadRegistry/diffBuiltinRegistries/seedCustomAspect` (3) — в
  4b, 7a, 9a, 12, 14; коды ошибок (3) — в 4b, 7a, 8, 11, 15; `projectLegacyAspects/
  projectLegacyRelationType/rowFromLegacy/WireEntity.aspectsMap` (4a) — в 4b, 7a, 10a, 13c, 23;
  `MutationMechanism/applyPropsPatch/PropsPatch/entityPropsPatch/resolvePropertyRef/legacyPatchToProps/
  fromLegacyInput` (4b) — в 5, 6, 7a, 10a/10b, 12, 13c, 18; `comparePropertyValue/PreconditionMismatch/
  ProposalDivergence.bodyChanged` (5) — в 6, 12, 13b; `InverseOp` (6) — в 15, 23;
  `assertRoleConstraints/RelationKey.role/reform_role_heuristic` (7a) — в 7b, 9a, 11, 23;
  `recomputeProjectAncestors` (7b) — в 9a (П6), 15; `QueryAst/QueryFilterNode/parseQueryAst/
  printQueryAst/queryAstJsonSchema/assertStaticQuery/QUERY_DEPTH_CAP/toParseRegistry/
  buildCatalogFromRegistry/AGENDA_QUERY_TEXTS` (8) — в 9a/9b, 10a–10c, 11, 15, 21;
  `compileQueryAst/compileCountAst/compileSumAst/compileLatestAst/CompileCtx` (9a) — в 9b, 10a/10b,
  11, 13c; `legacyAstToQueryAst/parseQueryAny/parseQueryText` (9b) — в 10c, 21 (удаление);
  `assertRefValue/syncRefMirror/markRefSourcesNeedsReview` (11) — в 12, 13c; `attachToolName/
  aspectToolJsonSchema/property_catalog(usage)/toLlmEntity/fullScopeOnly` (12) — в 13a, 15, 16, 17,
  19; `registry.effective/useRegistry` (13a) — в 13b, 13c, 14; `PropertyControl` (13b) — в 13c;
  `RefField` (13c) — в 18; `effectiveRegistry/applyDeltas/AspectDelta/bumpOwnerRegistryVersion/
  RegistryConflict` (14) — в 15, 16, 21; `createProperty/mergeProperty/setAspectDelta/dependantsOf/
  createSystemPending` и тулы `property_*`/`aspect_delta_*` (15) — в 16, 17; `reconfigures` (16);
  `formatRuleLabel/patternFromTransactionTitle/convertLegacyRules/select.ts` (18) — в 23;
  `KNOWN_NODE_TYPES` (20) — в 21; `readBodyDoc(…, reg)/queryRefsFromDoc` (21) — в 15, 23;
  `ledger/prd-reform.diff` (16, 22) — в 23; `seedOwnerWorld/reset-world/explain.test` (9a, 23) — в 24.
- **Правила проекта:** четыре миграции с явными номерами и GRANT/RLS/pgTAP/truncateAll на каждую
  таблицу; 0017 пишется один раз по готовому вердикту EXPLAIN; мутации только через executor
  (исключения — фикстуры `src/test/perf.ts` и `graph-fixture.ts` с докблоком); промпты — новой
  линейкой один раз; пересев локально после каждого сида; прод — по чек-листу с выключенным
  автодеплоем (проверка через Render MCP); `bun run test`/`lint`/`typecheck`/`test:perf` отдельно,
  `test:perf:graph`/`test:perf:explain` — вне CI по вехам; коммит `git commit -- <пути>` после
  каждой задачи; мерж и пуш после закрытия; русский язык; ревью-пакеты и мутационная проверка по
  шаблону оркестратора; PRD — одним коммитом с пересевом (В-5).
