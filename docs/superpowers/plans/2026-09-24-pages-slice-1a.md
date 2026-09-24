# Страницы, срез 1а «Страница и шаблон»: план реализации

> **Для агентных исполнителей:** ОБЯЗАТЕЛЬНЫЙ САБ-СКИЛЛ — `superpowers:subagent-driven-development`
> (рекомендуется) либо `superpowers:executing-plans`. Шаги размечены чекбоксами (`- [ ]`).
> Исполнитель задачи видит ТОЛЬКО свою задачу — бриф самодостаточен, имена и типы соседних задач
> продублированы в блоке «Интерфейсы». Модели: имплементеры, разведка и ре-ревью — Opus (`model: opus`),
> гейт-ревью задачи и финальное ревью ветки — Opus 5.5 (`model: opus`), Fable 5.1 — вторая линза по
> усмотрению оркестратора; sonnet и haiku — никогда (проверка по ID модели в транскрипте).
> Вместе с брифом имплементеру передаются `facts.md` и нужные `recon-plan-*.md` леджера
> `.superpowers/sdd/2026-09-23-pages-slice-1/`. Каждый `file:line` плана снят на `main 2d4f660` и
> **опровергаем**: перед правкой — `git rev-parse HEAD`, адрес — ориентир, искать grep'ом по имени.

**Цель:** экран записи и собственные страницы владельца становятся данными, а не кодом: страница — запись с
аспектом `orbis/page`, её тело — текст и блоки грамматики v3; любая запись показывается через шаблон (свой
шаблон владельца или шаблон хоста = сегодняшний экран записи); блоки данных получают данные одной пачкой; в
системном промпте чата и рутин вместо текстов `ai_instructions` — индекс аспектов.

**Архитектура:** первой идёт самостоятельная задача промпта (индекс аспектов, v7). Затем фиксируется эталон
сегодняшнего экрана записи — до любой правки web. Дальше слоями снизу вверх: реестр (аспект и два свойства),
чистые функции `@orbis/shared` (выбор шаблона, проекция блока данных, грамматика тела v3 с листовым
препроходом, матрица мест), сервер (пачка данных `entity.blocks`), web (единый механизм данных → примитивы
обвязки → рендерер показа → экран записи через шаблон хоста → меню и входы → настройка). Миграций нет. Закрытие,
финальное ревью, прод — последними; перед продом жёсткая остановка.

**Стек:** Bun 1.2.7, Hono, tRPC 11, drizzle-orm/postgres (Supabase Postgres 17, RLS), zod, `@tiptap/*` 3.30.1 +
`marked` 17 (модель документа), React 19 + TanStack Query, vitest 4 + jsdom + testing-library (web), `bun:test`
(server, shared, scripts), biome.

**Спека:** `docs/superpowers/specs/2026-09-23-pages-slice-1a-design.md` (принята владельцем 24.09, `main d54b9c1`;
правки концепции и реформы — `2d4f660`). Контекст: концепция `specs/2026-09-11-pages-and-apps-concept.md`,
ревизия 3 (§1 словарь, §4–§6, §9, §13); спека реформы `specs/2026-08-26-properties-reform-design.md`, ревизия 6
(§Б7-2, §С9 п. 5, §С8-30/35); протокол решений владельца — `.superpowers/sdd/2026-09-23-pages-slice-1/decisions.md`
(Р-1…Р-19). План решения спеки не пересматривает; расхождение спеки с кодом — раздел «Эрраты спеки».
**Словарь концепции обязателен**: один термин на понятие; «модуль» — только имя в коде; слов «view», «панель»,
«секция», «смарт-лист» в новых текстах интерфейса и документации нет.

**Нумерация:** задачи 1–19. План исполняется только после коммита в `main` по слову владельца (задача 1, шаг 1 это проверяет). Жёсткая остановка — после задачи 18; задача 19 (прод) — только отдельным словом
владельца и вместе с ним.

---

## Что установила разведка HEAD (24.09.2026, `main 2d4f660`)

Четыре читателя Opus 5.5 по зонам (shared, server, web, тесты/перф/прод) — конспекты `recon-plan-1-shared.md`,
`recon-plan-2-server.md`, `recon-plan-3-web.md`, `recon-plan-4-tests-prod.md` леджера; факты и рулинги —
`facts.md` (Ф-1а-1…22, РП-1…24). Ниже — только то, что определяет форму задач. Пробы 1–7 промпта планирования:

| Проба | Итог |
|---|---|
| 1. Правила §3.2 формами Б-2 | Оба выразимы без расширения языка E: `requires_when` + `not(empty(…))`; `forbidden_when` + `in($self, …)` — схема, чекер и интерпретатор проходят (Ф-1а-3). Условие: `minItems: 1` у `orbis/template_for` (`present([])` истинно). Правило самоссылки не лишнее: сегодня самоссылка `ref` — сырая ошибка БД, правило делает её именованным отказом |
| 2. `registry_ref` списком | `...listConfig` в ветку `types.ts:195` — сквозной конфиг, не новый kind (текст словаря `:4-9` сам называет `cardinality` сквозным); остальное подхватывается признаком `'cardinality' in type`, кроме `assertRegistryRefValue` (Ф-1а-4) и web-контролов (Ф-1а-19). `ref`-цель `{filter:{aspect:'orbis/page'}}` проходит `assertStaticQuery` |
| 3. Служебный аспект | `service: true` прячет записи из всех выдач (Ф-1а-1) — спека этого не хотела. РП-1: `service: false` + временный список кода. Навешивание из интерфейса — `entity.update {aspects:{attach}}` (процедуры `aspects.attach` нет). Пины «13 аспектов / 77 свойств» — shared и server, списком в задаче 4 |
| 4. Миграция | Не нужна (Ф-1а-5) |
| 5. Данные блоков | Сегодня N `entity.query` = N транзакций; первый кадр и редактор шлют разные ключи; пачка — новая процедура `entity.blocks` (РП-8), клиентский собиратель с ключом блока по тексту |
| 6. Приёмка С1а-5/6 | Снимков и web-перф-гейта нет (Ф-1а-17): структурный JSON-снимок экрана (РП-10) и четыре сторожа скорости (РП-11) |
| 7. Промпт | Нужна v7 (Ф-1а-12); стенд П3 мёртв и вне git (Ф-1а-14) — переписывается в `scripts/`; токены — при кредитах |

| # | Факт | Следствие для плана |
|---|---|---|
| Д-1 | `service: true` → `NOT (aspects && служебные)` во всех выдачах (`compile-ast.ts:795-800,851-862`) | РП-1, эррата Э-1, вопрос В-1 |
| Д-2 | Старый код строго разбирает строки реестра, `registry_ref` `.strict()` (`load.ts:188-235`, `types.ts:195`) | окно «сид → деплой» = простой (РП-2, задача 19) |
| Д-3 | `upgradeBodyDoc` умеет только v1 (`doc/types.ts:100-104`); потребители — `entity-read.ts:159`, `routers/version.ts:40-43`, `registry/ops.ts:1789`, `routines/proposal-diff.ts:208`, `useBodySave.ts:194-207` | цепочка v1→v2→v3 в задаче 7 |
| Д-4 | `parseBody` — потокенно по верхнему уровню (`convert.ts:350-391`); ленивое продолжение утаскивает маркер (Ф-1а-7) | листовой препроход `doc/page-grammar.ts` (РП-6) |
| Д-5 | Грамматика запроса не принимает `[…]`, `(…)` и голый флаг (Ф-1а-8); JSON Schema Q-AST вшита в `orbis/progress_source` и схему `entity_query` (Ф-1а-9) | РП-4; задача 6 пересдаёт эталон тулов (схема) и требует пересева |
| Д-6 | `display=list` в сиде смарт-листов и телах проектов (Ф-1а-10) | РП-5, В-3; операция корпуса считает и `list` |
| Д-7 | Абзац `{{query:…}}` при повторном разборе становится блоком (Ф-1а-11) | экранирование в `doc/manager.ts` (задача 7) |
| Д-8 | `v6.ts:70` ссылается «ниже» на секцию инструкций; вызывающих секции два (`llm/context.ts:548`, `routines/context.ts:301`); `loadAspectToolRows` — её единственный источник | v7, удалить `loadAspectToolRows` (задача 1) |
| Д-9 | `propose`-рутина `attach_*` не видит (Ф-1а-13) | В-6 |
| Д-10 | Материализация повторов — между транзакциями; `limit` без максимума; GET-вход в URL (Ф-1а-15) | РП-8, эррата Э-4 |
| Д-11 | `entity.update` без `actionId`; `execute` с `batchId` — один action (Ф-1а-16) | `entity.updateBatch` (РП-9, задача 10) |
| Д-12 | Связи экрана записи: `planToFact` ↔ чекбокс заголовка, `VersionsCard.active` ↔ вкладка, ключ `detailGetInput` (Ф-1а-18) | контекст хоста (задача 12), РП-13 |
| Д-13 | `check-lazy-chunks.ts:92` запрещает `DetailScreen → doc`; `save.test.tsx:1458-1500` сторожит вес редактора | рендерер и шаблон хоста — только через листовые модули |
| Д-14 | `EntityRow` без чекбокса-контрола; `controlKindOf` не различает `ref`-список (Ф-1а-19) | Р-13 по построению; контролы в задаче 4 |
| Д-15 | Корпус валидатора требует позитив и негатив на каждый аспект (Ф-1а-20) | РП-12 |
| Д-16 | Эталон тулов — 51; служебность либо список исключения его не меняют | задача 4 без пересдачи числа; задача 6 — пересдача схемы `entity_query` |
| Д-17 | Версия клиента 0.2.0; образец подъёма `5fb73ef` (Ф-1а-21) | РП-15, задача 7 |
| Д-18 | `ops.ts` не считает корпус под §5.9 (Ф-1а-22) | операция `census-v3` в задаче 7 |

## Решения плана РП-1…РП-29 (владелец может отменить; полный текст и цены — `facts.md`)

- **РП-1.** `orbis/page` — `service: false` + временный список `AUTHORING_DEFERRED_ASPECTS = ['orbis/page']`
  (`packages/shared/src/constants.ts`), исключающий аспект из `attach_*` и индекса промпта; снимается срезом 2.
- **РП-2.** Окно «пересев → деплой» принимается простоем (как Б-2); пересев и сразу ручной деплой.
- **РП-3.** Промпт чата → `v7` (правка `v6.ts:70`); `routine-v3` без изменений.
- **РП-4.** Проекция: `display=tile`, `aggregate=count|sum:<свойство>|latest:<свойство>`, `columns=<a>|<b>`,
  голый флаг `hide_empty`; AST-поля `aggregate`, `columns`, `hideEmpty` с адресами под ключом `field`.
- **РП-5.** `display` читается везде, где рисуется блок данных; корпус считает `list` и `table`.
- **РП-6.** Листовой препроход `@orbis/shared/doc/page-grammar` — единственная копия правил маркеров.
- **РП-7.** Шесть узлов: `columns`, `column`, `tabs`, `tab{label}`, `recordBlock{name}`, `aspectCard{aspect,text}`.
- **РП-8.** `entity.blocks` — POST-процедура пачки ≤ 30 блоков по тексту; SAVEPOINT на блок; `limit+1`.
- **РП-9.** `entity.updateBatch` — одна пачка правок, `{actionId, results}`; все новые входы меню через неё.
- **РП-10.** С1а-5 — структурный JSON-снимок экрана, снятый задачей 2 до правок web.
- **РП-11.** С1а-6 — `check-lazy-chunks`, множество запросов при открытии, серверные пороги, размер чанка ≤ +15 %.
- **РП-12.** Корпус валидатора: `POST_FREEZE_ASPECTS = ['orbis/page']`, `legacyVerdict = newVerdict`.
- **РП-13.** Запрос записи `this` — ОДИН `entity.get` с сегодняшним `DETAIL_INCLUDE` для любой записи и страницы;
  сужение включений по блокам шаблона не делается — оно стоило бы второго запроса на каждое открытие (Э-14, В-9).
- **РП-14.** Список шаблонов — `entity.query` параллельно с `entity.get`; ошибка списка → шаблон хоста + плашка.
- **РП-15.** Версия клиента → 0.3.0 вместе с форматом v3.
- **РП-16.** Строка индекса `- <id> — <подпись>: <описание>`, порядок `rank`.
- **РП-17.** Перезамер бюджетов промпта: байты сейчас, токены — при кредитах.
- **РП-18.** Undo пачки откатывает тело через `prior.body` (текст цел, оформление из канона).
- **РП-19.** Из остатков Б-2 «страницы-1» 1а закрывает только №39 (стейл-комментарии в переписываемых файлах).
- **РП-20.** Плитка суммы: `currencies` в ответе; несколько валют — плашка.
- **РП-21.** Запись выбора в споре чистит `template_wins_over` от id вне текущего списка шаблонов.
- **РП-22.** «Перестать быть страницей» снимает только аспект.
- **РП-23.** Задача 12 не меняет снимок задачи 2 (регрессионный сторож разреза).
- **РП-24.** Ветка `pages-slice-1a`, worktree `.claude/worktrees/pages-slice-1a`; мерж в `main` — один раз готовым срезом, вместе с владельцем (рулинг владельца 24.09, Ф-1а-23).
- **РП-25.** На показе страницы своим телом `{{cards}}` не рисует карточку самого аспекта `orbis/page` (иначе
  «Изменить вид только этой» не дала бы «как раньше» — С1а-8); через шаблон хоста («Открыть как запись») карточка
  «Страница» видна, как все.
- **РП-26.** Индекс аспектов несёт строку-границу для служебных аспектов (без описания и без `ai_instructions`):
  «Служебные — не навешивай и не правь сам: orbis/agent-run». Сегодня эту границу держит инструкция аспекта в секции
  (`tools/registry.ts:1441-1446`), индекс её снял бы (В-8). `orbis/page` в индекс не попадает (спека §3.1).
- **РП-27.** Контрол «несколько аспектов» соблюдает `minItems` генерически: последний аспект снять нельзя (подсказка —
  «сделать черновиком: ⋯ → «Сделать шаблоном для…» → снять все»); иначе карточка снимала бы «Шаблон для» без
  «Главнее, чем» и получала отказ правила (§3.2).
- **РП-28.** Узлы `column` и `tab` — в своих группах (`column`, `tab`), не `block`: часть вне контейнера схема
  отвергает, круг «печать → разбор» не меняет тип узла.
- **РП-29.** «Изменить вид только этой», случай 1: копия шаблона БЕЗ строки `{{body}}` (иначе на странице — плашка
  §5.5; Э-13); сравнение «до/после» — через поимённую функцию `bodyBecameText` (ориентир `body` → текст на его месте).

## Вопросы владельцу (исполнение идёт по умолчаниям; ответ «не по умолчанию» — правка плана до задетой задачи)

| # | Вопрос | Умолчание | Задевает |
|---|---|---|---|
| В-1 | Спека §3.1 хотела «служебный аспект», но флаг `service` прячет записи из всех выдач. Как не предлагать аспект модели? | временный список кода `AUTHORING_DEFERRED_ASPECTS` (РП-1); альтернативы — скрыть страницы из выдач (`service: true`) или дать модели `attach_orbis_page` | 1, 4 |
| В-2 | Окно между пересевом реестра и деплоем даёт простой (≈ минуты): старый код не разбирает `registry_ref` списком | принять простой, как в Б-2; альтернатива — отдельный ранний деплой одного расширения типа | 19 |
| В-3 | Блок данных начинает читать `display`: смарт-листы сида и тела проектов с `display=list` в заметках станут строками `EntityRow` вместо заголовков | читать везде (один механизм); число задетых тел — владельцу до прода | 11, 19 |
| В-4 | Выкатить индекс аспектов (закрывает прод-дефект §С8-35 п. 3) отдельно сразу после задачи 1? | нет: вместе со срезом (прод только с владельцем; `main` до конца среза не меняется) | 1, 19 |
| В-5 | Остатки Б-2 с адресатом «страницы-1» (14 строк `remainders-b2.md` §5) | 1а закрывает №39; остальные — в `handoff-1b.md` | 12, 17 |
| В-6 | Рутина в режиме `propose` после индекса не видит `ai_instructions` нигде (её тулов `attach_*` нет) | принять: индекс даёт описание аспектов; риск — в реестр остатков | 1 |
| В-7 | Перезамер токенов промпта требует живых вызовов провайдера (кредитов нет) | байты — сейчас, токены — строкой `03-pending.md` §1 рядом с §С8-30 | 3 |
| В-8 | После индекса инструкция служебного `orbis/agent-run` («вручную не создавай и не правь») не доходит до модели нигде | строка-граница в индексе без описания (РП-26); `orbis/page` — вне индекса по спеке | 1 |
| В-9 | Спека §6.4: «нет `{{backlinks}}` — обратные ссылки не грузятся». Узнать шаблон можно только прочитав запись — сужение стоит второго запроса на каждое открытие | один запрос с полными включениями, как сегодня (РП-13, Э-14) | 13, 14 |
| В-10 | Формы проекции отличаются от утверждённых в Р-10 (`columns=a\|b`, `aggregate=sum:x`) — скобки в грамматике зарезервированы за печатью невыразимого дерева | формы РП-4 (Э-2) | 6 |
| В-11 | Эрраты, меняющие смысл приёмки: С1а-6 проверяется четырьмя сторожами, а не «существующим перф-гейтом» (Э-7); С1а-8 случай 1 — копия шаблона без `{{body}}` (Э-13) | принять | 14, 15 |

## Глобальные ограничения

- **Ветка и дерево.** Ветка `pages-slice-1a` от свежего `origin/main`, работа только в worktree
  `/Users/birzhan/projects/orbis/.claude/worktrees/pages-slice-1a`; основное дерево не трогать (Ф-1а-23: `main` до
  задачи 19 не меняется). Свой `bun install`; `apps/server/.env` и корневой `.env` — копии из основного дерева.
  У ветки снять upstream (`git branch --unset-upstream`; Ф-Б2-2): иначе голый `git push` уйдёт в `main`.
- **`main` до конца среза не меняется; автодеплой Render не трогается** (рулинг владельца 24.09, Ф-1а-23: «нет смысла
  пушить в main, пока срез не готов»). Выключение автодеплоя было нужно только мержам после каждой задачи; при одном
  мерже порядок «пересев ДО кода» держит задача 19: пересев, затем пуш в `main` — автодеплой выкатывает сам
  (сервис `srv-d9781kvavr4c73d85r60`, workspace `tea-d93srfq8qa3s73bdfka0`).
- **Ручной деплой из `main` на время среза запрещён** (до задачи 19): код 1а на непересеянном реестре не работает.
- **Закрытие задачи** (Ф-1а-23): гейт-ревью APPROVE + зелёные локальные `test`/`lint`/`typecheck` → push ветки
  `pages-slice-1a` в `origin` ради CI (`git push origin pages-slice-1a`; `main` не трогается) → CI ветки зелёный.
  Мерж в `main` — только в задаче 19, вместе с владельцем. Один имплементер в дереве в каждый момент; серверные сьюты делят одну
  локальную БД — один прогон за раз.
- **Миграций нет (спека §12).** Любая найденная необходимость миграции — СТОП и доклад владельцу. Номер следующей
  миграции был бы `0023`.
- **Пересев реестров** после каждой правки сидов (задачи 4, 6): `bun run db:prepare` из worktree; до пересева красные
  `test/seed-registries.test.ts`, `registry-drift` — не поломка имплементера. На проде — только задача 19, **до кода**
  (урок D42).
- **Язык E не расширяется** (принцип владельца 14.09): правила аспекта «страница» — существующими формами (Ф-1а-3).
- **Грамматика — одна копия правил** (РП-6): маркеры `{{…}}` распознаёт только `packages/shared/src/doc/page-grammar.ts`;
  `bodySegments` и прочие регэкспы маркеров снимаются. Незнакомая форма `{{…}}` остаётся текстом (§5.7).
- **Вес экрана записи.** Из `DetailScreen` и его эагерных файлов нельзя статически дотянуться до баррели
  `@orbis/shared/doc` (сторож `scripts/check-lazy-chunks.ts:92`, `save.test.tsx:1458-1500`): рендерер, шаблон хоста,
  первый кадр импортируют только листовые сабпаты `@orbis/shared/doc/page-grammar`, `@orbis/shared/doc/types`.
  Новые эагерные файлы экрана — в список `save.test.tsx:1483-1493`.
- **Запись в граф (спека §11.1).** В 1а ничего нового не пишет в граф мимо существующих путей: правка экрана записи
  переносится как есть; новые входы меню — через `entity.updateBatch` (исполнитель, журнал, Undo). Чекбокса
  статуса в строках списка на странице нет (Р-13).
- **TDD и прогоны.** Полный прогон — `bun run test` из корня worktree (голый `bun test` ЗАВИСАЕТ); `bun run lint`,
  `bun run typecheck` — отдельными вызовами. Точечно: shared — `cd packages/shared && bun test src/<файл>`, server —
  `cd apps/server && bun test src/<файл>`, web — `cd apps/web && bun run test src/<файл>` (vitest), scripts — из корня
  `bun test scripts/<файл>`. **Вывод любого прогона — в файл** (`> /private/tmp/claude-501/pages-1a/<имя>.log 2>&1`),
  затем чтение файла; **никаких `| head`/`| tail` на `bun test`** (висит часами и держит БД — Ф-Б2-12). После отчёта
  сабагента — `ps aux | grep "bun test"`, зомби убить. Перф — строго `test:perf:volume` → `test:perf:explain` →
  `test:perf:graph` ×3 → `test:perf` (Ф-Г-75), не в цепочке с `test`.
- **Сторожа на `git grep` видят только отслеживаемое** (Ф-Б2-11): новые файлы — `git add` ДО полного прогона.
- **Тестовая обвязка.** Server: в теле теста граф — `await freshGraph()`, `mintGraph()` — только модульные константы
  (Ф-Б2-9); идентичность — `personal(g)`; роутер-тест — `createCallerFactory(appRouter)` с
  `{identity: personal(g), actorKind:'owner', db, clientVersion: null}` (образец `routers/chat.test.ts:18-24`).
  Web: `renderWithProviders(ui, handler)` (`apps/web/src/test/harness.tsx:149`, отдаёт `calls`), `wireEntity`
  (`:233`), `registryReply` (`test/registry.ts:45`), `installCrashTrap` на файл.
- **Эталоны пересдаются руками** (автообновления нет): `apps/server/test/golden/tool-registry.json` — схема
  `entity_query` (задача 6), число тулов остаётся 51; снимок экрана задачи 2 не перезаписывается никогда (три
  отличия §8.2 — функцией); фикстура промпта `v7.fixture.txt` — задача 1.
- **Мутационная проверка (С1а-10).** Каждая задача с деливераблом-сторожем держит шаг «порча → красный → откат»;
  мутируется деливерабл, пин не трогается («согласованная порча» — не мутация, Ф-Б2-6). Раздел отчёта
  имплементера «Пины и мутации» обязателен.
- **Никаких `TODO`/«потом»** в коде; временное — только с записью в докблоке «почему и кто снимает» (реестр §11.2
  спеки).
- **Язык кода, комментариев, ошибок, коммитов — русский; комментарий объясняет «почему».**
- **Коммит** — `git commit -m "<сообщение>" -- <пути>` (**сообщение ДО `--`**, Ф-Б2-7). Трейлер среза фиксирован:
  `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`; ID модели исполнителя — в `progress.md`.
- **Ревью-пакет и учёт ревью** — по `docs/superpowers/templates/orchestrator-prompt.md` (экземпляр в леджере, задача 1).

## Фокус ревью (пять входов, которые спека подразумевает, а тесты задач иначе не задели бы)

1. **Тело с `\r\n` и маркер с хвостовыми пробелами** (`{{tab: Тред}}  `) — препроход обязан узнать маркер и вернуть
   текст байт-в-байт при печати. Тест — задача 7, шаг 1.
2. **Маркер внутри забора кода** (```` ``` ```` / `~~~`, в том числе незакрытого до конца тела) — остаётся кодом,
   контейнер не открывается. Тест — задача 7, шаг 1.
3. **Страница с 31+ блоком данных** — клиент режет на пачки ≤ 30, каждый блок получает свой ответ. Тест — задача 11,
   шаг 1.
4. **Шаблон в чужом «Главнее, чем» заархивирован** — выбор в споре записывается без отказа (РП-21), функция выбора
   архивного не видит. Тест — задача 5, шаг 1, и задача 14, шаг 1.
5. **Старая вкладка браузера (клиент 0.2.0 / документ v2) сохраняет тело после выкатки** — отказ «перезагрузите», текст
   черновика не теряется. Тест — задача 8, шаги 3 (сервер) и 5 (web).

## Карта файлов

| Область | Создать | Изменить |
|---|---|---|
| shared / реестр | `pages/choose-template.ts` (+тест) | `constants.ts` (`orbis/page`, `AUTHORING_DEFERRED_ASPECTS`, версия клиента), `registry/types.ts` (`registry_ref` + `listConfig`), `registry/builtin-{aspects,properties,rules}.ts` (+тесты), `index.ts` |
| shared / запрос | `query/dates.ts` (`absoluteDateIn`, +тест) | `query/{ast,ast-json-schema,parse-ast,print,static}.ts` (+тесты), `query/ast-fixtures.ts` |
| shared / документ | `doc/page-grammar.ts` (+тест), `doc/nodes/{layout,record-blocks}.ts`, `doc/placement.ts` (+тест) | `doc/{types,schema,convert,manager,bind-query,diff,index}.ts` (+тесты), `package.json` (`exports`) |
| server / промпт | `llm/prompts/v7.ts`, `v7.fixture.txt`, `v7.test.ts`, `llm/aspect-index.ts` (+тест) | `llm/context.ts`, `routines/context.ts`, `tools/registry.ts` (`buildToolDefs`, снос `loadAspectToolRows`), `registry/load.ts` (докблок) |
| server / данные | `routers/entity-blocks.ts` (+тест), `db/census-v3.ts` (+тест) | `routers/entity.ts` (`blocks`, `updateBatch`), `registry/ref.ts` (`registry_ref` списком), `query/compile-ast.ts` (валюты суммы), `executor/executor.ts` (только тесты гейта v3), `perf/perf.test.ts` |
| server / тесты | — | `test/seed-registries.test.ts`, `routers/registry.test.ts`, `registry/load.test.ts`, `registry/validator-golden.test.ts` + `test/golden/validator-verdicts.json`, `test/golden/tool-registry.json`, `llm/context.test.ts`, `routines/context.test.ts`, `registry/modules.test.ts` |
| web / данные | `lib/query-blocks/batch.tsx` (+тест), `features/page/blocks/{DataBlock,ListForm,TableForm,TileForm,MoreRows}.tsx` | `lib/query-blocks/QueryBlock.tsx`, `lib/invalidate.ts`, `features/entity-editor/{EditorShell,nodes/QueryWidget}.tsx`, `features/browser/query.ts` (снос `bodySegments`), `lib/format.ts` (деньги с валютой) |
| web / экран | `features/page/{Renderer,Columns,TabsContainer,PageView,RecordView,host-template,usePageTemplates,TemplatePlaques,BaseRecordView,change-view,useUpdateBatch,ConfigureView,TemplateBanner,TemplatePreview}.tsx`, `features/page/blocks/*`, `features/entity-detail/{EntityBody,EntityThreadTab,AspectSection,TagsBlock,own-cards,record-host,record-blocks,intended-1a}.tsx`, `features/entity-detail/structure-snapshot.ts` + `golden/detail-structure.json` | `features/entity-detail/{DetailScreen,AspectCards,useEntityDetail,Subtasks}.tsx`, `Blocks.tsx` → `Blockers.tsx`, `ui/toast-store.ts` |
| web / редактор | `features/entity-editor/nodes/{LayoutFrame,RecordBlockStub}.tsx`, `lib/query-blocks/body-kind.tsx` | `features/entity-editor/{extensions,strip-ids,useBodySave,BodyEditor}.ts(x)`, `slash/{items,EditorSuggest}.ts(x)`, `lib/registry/{controls,PropertyControl}.tsx`, `app/version.ts` |
| scripts / docs | `scripts/probe-p3.ts` (+тест), `scripts/prompt-size.ts` (+тест) | `scripts/ops.ts` (`census-v3`), `scripts/check-legacy-form.ts` (`v6` → `FROZEN_PROMPTS`), `scripts/probe-p4.{ts,test.ts}`, `scripts/client-version.test.ts`, `render.yaml`, `docs/prd/{00-product,01-architecture,02-core-os,04-decision-log}.md`, `docs/implementation/{00-architecture,02-ops-runbook,03-pending}.md` |

Пути web — от `apps/web/src/`, server — от `apps/server/`, shared — от `packages/shared/src/`.

## Порядок и параллельность

Строго последовательно 1 → 19: одна локальная БД и правило «один имплементер в дереве». Логические зависимости
(для понимания, не для параллели): 1 → 3 (промпт и стенд над ним); 2 — эталон экрана, ОБЯЗАН идти до любой правки
web-экрана (задачи 11–16); 4 (имена аспекта и свойств) → 5 (выбор шаблона); 6 (проекция) → 9 (даты в матрице) и 10
(сервер разбирает проекцию); 7 (препроход) → 8 (узлы и формат v3) → 9 (матрица над деревом); 10 → 11 (web читает
пачку); 11 → 12 → 13 → 14 → 15 → 16 (web снизу вверх); 17 закрывает документы; 18 — финальное ревью ДО прода;
19 — прод с владельцем.

Промежуточные состояния, которые НЕ ломаются: до задачи 14 обычная запись открывается прежним экраном (задача 12 режет
его на примитивы без смены вида, РП-23; задача 13 переводит на рендерер только записи с аспектом `orbis/page`);
формат v3 вводится одной задачей 8 целиком (узлы, версия, цепочка подъёма, гейт сервера, черновики, версия клиента —
одним мержем); `display` начинает читаться задачей 11 вместе с формами показа; аспект `orbis/page` существует с задачи
4, но навешивается из интерфейса только с задачи 15 (модель его не видит — РП-1).

---
## Задачи

### Задача 1: Индекс аспектов в промпте (v7) и старт среза

**Зачем:** системный промпт чата и контекст рутин несут полный текст `ai_instructions` всех включённых аспектов, а
тот же текст лежит в описаниях `attach_*` — дубль ≈ 1 170 токенов на вызов, последний открытый прод-дефект промпта
(§С8-35 п. 3 спеки реформы). Спека §10 п. 1–2: секция инструкций заменяется генерируемым индексом «id, подпись,
описание», инструкции остаются только в `attach_*`, собранный промпт проверяют две семантические проверки. Задача
самостоятельна и первой же поднимает обвязку среза: ветка и база в известном
состоянии, базовая линия снята.

**Файлы:**
- ~~`render.yaml` — `autoDeploy: false`~~ — снято рулингом Ф-1а-23 (мерж в `main` один раз, автодеплой не трогается).
- Создать: `apps/server/src/llm/aspect-index.ts`, `apps/server/src/llm/aspect-index.test.ts`,
  `apps/server/src/llm/prompts/v7.ts`, `apps/server/src/llm/prompts/v7.fixture.txt`, `apps/server/src/llm/prompts/v7.test.ts`.
- Изменить: `apps/server/src/llm/context.ts` (`:46-48` импорты, `:70-95` вычисление тела по v7, `:505-532` секция →
  индекс, `:547-549` вызов), `apps/server/src/routines/context.ts:299-305`, `apps/server/src/tools/registry.ts:1274-1325`
  (снести `AspectToolRow`, `loadAspectToolRows` — читателей не остаётся), `apps/server/src/registry/load.ts:12-30`
  (из перечня «читатели мимо снимка» убрать пункт про `loadAspectToolRows`), `scripts/check-legacy-form.ts:477-493`
  (`'v6'`, `'v6.fixture'` → `FROZEN_PROMPTS`).
- Тесты изменить: `apps/server/src/llm/context.test.ts:38,95-129,150-210`, `apps/server/src/routines/context.test.ts:76,85-105`,
  `apps/server/src/registry/modules.test.ts:683-690`, `apps/server/src/ai/send-message.test.ts:245` (если пиннит v6 —
  перевести на v7).
- Леджер (вне git): `.superpowers/sdd/2026-09-23-pages-slice-1/{orchestrator-prompt.md,make-brief.sh,make-review-pack.sh,progress.md}`.
- НЕ трогать: `llm/prompts/v1…v6.ts` и фикстуры (замороженные снимки), `routine-v3.ts` (на секцию не ссылается —
  `recon-plan-2` П7), описания `attach_*` (`tools/registry.ts` `attachToolDef` `:1343-1363` — инструкции остаются там).

**Интерфейсы:**
- Consumes: `effectiveRegistry(tx, graphId: GraphId): Promise<RegistrySnapshot>` (`apps/server/src/registry/cache.ts:119`);
  `disabledModulesOf(tx, graphId)` (`apps/server/src/registry/modules.ts:20`); `isModuleEnabled(module, disabled)`
  (`packages/shared/src/registry/modules.ts`); `effectiveLabel(text: LocalizedText, locale)` и `OWNER_LOCALE = 'ru'`
  (`packages/shared/src/registry/types.ts:63,85`); `AspectDefinition` — поля `id`, `label`, `description`, `rank`,
  `key`, `module`, `service`, `aiInstructions`.
- Produces (для задач 3 и 4):
```ts
// apps/server/src/llm/aspect-index.ts
export const ASPECT_INDEX_HEADING = 'Аспекты (поля и правила — в описании тула attach_<аспект>):';
/** РП-26: последняя строка индекса — граница служебных аспектов (id через запятую), без описаний. */
export const SERVICE_BOUNDARY_PREFIX = 'Служебные — не навешивай и не правь сам: ';
/** Чистая часть: строки индекса по снимку и маске. Порядок — rank, затем key. */
export function aspectIndexLines(reg: RegistrySnapshot, disabled: readonly string[]): string[];
/** Секция канала; null — индекс пуст. Зовут llm/context.ts и routines/context.ts. */
export async function aspectIndexSection(tx: Tx, graphId: GraphId, disabled: readonly string[]): Promise<string | null>;
// apps/server/src/llm/prompts/v7.ts
export const SYSTEM_PROMPT_VERSION = 'v7';
export const SYSTEM_PROMPT_V7: string;
export { TOOL_RESULT_MARKER } from './v1';
```
  Задача 4 добавит в `aspectIndexLines` и `buildToolDefs` фильтр `AUTHORING_DEFERRED_ASPECTS` (РП-1) — сигнатуры не
  меняются.

> **Ловушка cwd.** Каждый вызов Bash начинается своим `cd`. `R=/Users/birzhan/projects/orbis`,
> `W=$R/.claude/worktrees/pages-slice-1a`, `L=$R/.superpowers/sdd/2026-09-23-pages-slice-1`.

- [ ] **Шаг 1: предпроверки основного дерева.**
```
cd /Users/birzhan/projects/orbis && git status --short && git fetch origin && git rev-parse HEAD origin/main
cd /Users/birzhan/projects/orbis && git ls-files --error-unmatch docs/superpowers/plans/2026-09-24-pages-slice-1a.md
cd /Users/birzhan/projects/orbis && git branch --list pages-slice-1a && git worktree list && grep -n autoDeploy render.yaml || echo 'autoDeploy отсутствует — ожидаемо'
cd /Users/birzhan/projects/orbis && git diff --stat 2d4f660..origin/main -- apps packages scripts
```
  Ожидание: дерево чистое, план закоммичен (иначе `make-brief.sh` читает несуществующий файл — СТОП и доклад), ветки
  и worktree нет, `autoDeploy` отсутствует. Последняя команда показывает, что код уехал от `2d4f660`: задетые файлы
  из «Карты файлов» — переснять адреса по именам и записать таблицу «адрес в плане → на HEAD» в `progress.md`.

- [ ] **Шаг 2: СНЯТ рулингом Ф-1а-23** (`main` до конца среза не меняется — выключать автодеплой незачем). Исходный текст — для истории:
```yaml
    autoDeploy: false # выключен на время среза «Страницы, срез 1а» (план 2026-09-24): пересев реестра (аспект orbis/page, registry_ref списком) обязан идти на прод ДО кода, а мерж в main после каждой задачи иначе выкатывал бы полсреза; вернуть прод-процедурой (задача 19)
```
```
cd /Users/birzhan/projects/orbis && sed -n '11,15p' render.yaml
cd /Users/birzhan/projects/orbis && git commit -m "ops(render): автодеплой выключен на время среза «Страницы, срез 1а»

Срез мержится в main после каждой задачи, а пересев реестра (аспект orbis/page, registry_ref
списком) обязан идти на прод до кода (урок D42). Возврат — задача 19 плана.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- render.yaml && git push origin main
```
  Затем `mcp__render__list_deploys` → дождаться `live` у деплоя этого коммита (безвредный: код тот же);
  `mcp__render__get_service` → `autoDeploy: "no"`. Осталось `"yes"` — dashboard → Settings → Build & Deploy →
  Auto-Deploy → No, повторить `get_service`. Ответ — в `progress.md` (перечитывается перед каждым мержем).

- [ ] **Шаг 3: ветка, worktree, окружение, база с нуля.**
```
cd /Users/birzhan/projects/orbis && git fetch origin && git worktree add -b pages-slice-1a .claude/worktrees/pages-slice-1a origin/main
cd /Users/birzhan/projects/orbis/.claude/worktrees/pages-slice-1a && git branch --unset-upstream && git rev-parse HEAD && bun install
cd /Users/birzhan/projects/orbis/.claude/worktrees/pages-slice-1a && cp /Users/birzhan/projects/orbis/apps/server/.env apps/server/.env && cp apps/server/.env .env && grep -c '^[A-Z_]' .env apps/server/.env
cd /Users/birzhan/projects/orbis/.claude/worktrees/pages-slice-1a && bunx supabase status && bunx supabase db reset && bun run db:prepare
```
  Ожидание: `HEAD` = хеш шага 2; одинаковое число ключей в `.env`; `db:prepare` EXIT 0, сид печатает «свойств 77 …
  аспектов 13 …» (ориентир), `test:rls` без «Looks like you planned».

- [ ] **Шаг 4: базовая линия.** Каждой командой отдельно, вывод — в файлы `/private/tmp/claude-501/pages-1a/base-*.log`:
```
cd /Users/birzhan/projects/orbis/.claude/worktrees/pages-slice-1a && bun run test > /private/tmp/claude-501/pages-1a/base-test.log 2>&1; echo EXIT=$?
cd /Users/birzhan/projects/orbis/.claude/worktrees/pages-slice-1a && bun run lint > /private/tmp/claude-501/pages-1a/base-lint.log 2>&1; echo EXIT=$?
cd /Users/birzhan/projects/orbis/.claude/worktrees/pages-slice-1a && bun run typecheck > /private/tmp/claude-501/pages-1a/base-tsc.log 2>&1; echo EXIT=$?
cd /Users/birzhan/projects/orbis/.claude/worktrees/pages-slice-1a && bun run test:perf:volume > /private/tmp/claude-501/pages-1a/base-perf-volume.log 2>&1; echo EXIT=$?
cd /Users/birzhan/projects/orbis/.claude/worktrees/pages-slice-1a && bun run test:perf:explain > /private/tmp/claude-501/pages-1a/base-perf-explain.log 2>&1; echo EXIT=$?
cd /Users/birzhan/projects/orbis/.claude/worktrees/pages-slice-1a && bun run test:perf:graph > /private/tmp/claude-501/pages-1a/base-perf-graph1.log 2>&1; echo EXIT=$?
cd /Users/birzhan/projects/orbis/.claude/worktrees/pages-slice-1a && bun run test:perf:graph > /private/tmp/claude-501/pages-1a/base-perf-graph2.log 2>&1; echo EXIT=$?
cd /Users/birzhan/projects/orbis/.claude/worktrees/pages-slice-1a && bun run test:perf:graph > /private/tmp/claude-501/pages-1a/base-perf-graph3.log 2>&1; echo EXIT=$?
cd /Users/birzhan/projects/orbis/.claude/worktrees/pages-slice-1a && bun run test:perf > /private/tmp/claude-501/pages-1a/base-perf.log 2>&1; echo EXIT=$?
cd /Users/birzhan/projects/orbis/.claude/worktrees/pages-slice-1a && bun run --filter @orbis/web build > /private/tmp/claude-501/pages-1a/base-build.log 2>&1 && bun scripts/check-lazy-chunks.ts > /private/tmp/claude-501/pages-1a/base-chunks.log 2>&1; echo EXIT=$?
```
  Ожидание: все EXIT=0 (`mkdir -p /private/tmp/claude-501/pages-1a` до первой). Ориентир после Б-2: shared 574 ·
  server 3254 · web 1188 + 1 skip · scripts 63; семь медиан `test:perf`. Записать числа, семь медиан и размер
  `apps/web/dist/assets/DetailScreen-*.js` в gzip (`gzip -c <файл> | wc -c`) в `progress.md` — это база РП-11.

- [ ] **Шаг 5: обвязка леджера.** Экземпляр промпта оркестратора уже лежит в `$L/orchestrator-prompt.md`
  (написан при планировании 24.09 по шаблону `docs/superpowers/templates/orchestrator-prompt.md`) — не переписывать.
  Скопировать `make-brief.sh` и `make-review-pack.sh` из
  `.superpowers/sdd/2026-09-14-properties-reform-b2/` и поправить пути (`PLAN`, `LED`, `WT`) и подписи; проверка
  вхолостую: `$L/make-brief.sh 1` печатает бриф, начинающийся заголовком «### Задача 1», с разделом «Глобальные
  ограничения» в хвосте.

- [ ] **Шаг 6: красные тесты индекса (чистая часть).** `apps/server/src/llm/aspect-index.test.ts` — без БД, снимок
  строится из встроенных словарей (`BUILTIN_ASPECT_DEFS` и т. п. — образец сборки снимка в тесте:
  `apps/server/src/tools/registry.test.ts`, поиск `buildToolDefs(`):
```ts
test('строка индекса: id — подпись: описание, порядок rank', () => {
  const lines = aspectIndexLines(REG, []);
  expect(lines[0]).toBe(`- orbis/schedule — ${label('orbis/schedule')}: ${description('orbis/schedule')}`);
  const ids = lines.filter((l) => l.startsWith('- ')).map((l) => l.slice(2, l.indexOf(' — ')));
  expect(ids).toEqual([...REG.aspects.values()].filter((a) => !a.service)
    .sort((a, b) => a.rank - b.rank || a.key.localeCompare(b.key)).map((a) => a.id));
});
test('служебный аспект — не строкой индекса, а в строке-границе без описания (РП-26)', () => {
  const lines = aspectIndexLines(REG, []);
  expect(lines.some((l) => l.startsWith('- orbis/agent-run '))).toBe(false);
  expect(lines.at(-1)).toBe(`${SERVICE_BOUNDARY_PREFIX}orbis/agent-run`);
});
test('маска модулей: аспекты выключенного модуля исчезают, прочие на месте', () => {
  const off = aspectIndexLines(REG, ['finance']);
  expect(off.some((l) => l.startsWith('- orbis/financial '))).toBe(false);
  expect(off.some((l) => l.startsWith('- orbis/task '))).toBe(true);
});
test('в индексе нет ни одного текста ai_instructions', () => {
  const text = aspectIndexLines(REG, []).join('\n');
  for (const a of REG.aspects.values()) if (a.aiInstructions) expect(text).not.toContain(a.aiInstructions);
});
```
  Прогон: `cd $W/apps/server && bun test src/llm/aspect-index.test.ts > /private/tmp/claude-501/pages-1a/t1.log 2>&1`
  → FAIL «Cannot find module './aspect-index'».

- [ ] **Шаг 7: `aspect-index.ts`.**
```ts
export function aspectIndexLines(reg: RegistrySnapshot, disabled: readonly string[]): string[] {
  const lines = [...reg.aspects.values()]
    // Служебный аспект модели не предлагается — ни тулом (`buildToolDefs`), ни строкой индекса.
    .filter((a) => !a.service)
    // §Б8-3: аспект выключенного модуля уходит вместе с модулем — та же маска, что у тулов.
    .filter((a) => isModuleEnabled(a.module, disabled))
    .sort((a, b) => a.rank - b.rank || a.key.localeCompare(b.key))
    .map((a) => `- ${a.id} — ${effectiveLabel(a.label, OWNER_LOCALE)}: ${effectiveLabel(a.description, OWNER_LOCALE)}`);
  // РП-26: служебный аспект тула не имеет, и его граница («не навешивай сам») раньше доходила до модели
  // только текстом инструкции в секции. Индекс держит её строкой-границей — без описания и инструкции.
  const service = [...reg.aspects.values()]
    .filter((a) => a.service && isModuleEnabled(a.module, disabled))
    .sort((a, b) => a.rank - b.rank)
    .map((a) => a.id);
  return service.length === 0 ? lines : [...lines, `${SERVICE_BOUNDARY_PREFIX}${service.join(', ')}`];
}
export async function aspectIndexSection(tx: Tx, graphId: GraphId, disabled: readonly string[]) {
  const lines = aspectIndexLines(await effectiveRegistry(tx, graphId), disabled);
  return lines.length === 0 ? null : `${ASPECT_INDEX_HEADING}\n${lines.join('\n')}`;
}
```
  Докблок модуля — «почему»: инструкции живут ровно в одном месте (описание `attach_*`), канал несёт карту аспектов,
  чтобы модель знала, какой тул звать (§Б7-2 спеки реформы, §10 спеки 1а); источник — ЭФФЕКТИВНЫЙ реестр (подписи и
  описания владельца с дельтами), а не сырые строки. Прогон шага 6 → PASS.

- [ ] **Шаг 8: v7.** `cp` `v6.ts` → `v7.ts`, `v6.fixture.txt` → `v7.fixture.txt`; в `v7.ts` — `SYSTEM_PROMPT_VERSION =
  'v7'`, константа `SYSTEM_PROMPT_V7`, шапка «ПРАВКИ ПРОТИВ v6» с перечнем; (1) строки с id модуля `finance` в примерах
  шпаргалки (`v6.ts:59` «aspect=orbis/category, search=Еда», `v6.ts:63` «Доходы с тегом savings = aspect=orbis/financial,
  orbis/direction=income, …») получают нейтральные примеры без id модуля (например, `aspect=orbis/note, search=…`,
  «задачи с тегом work»): иначе проверка «ни слова о выключенных приложениях» (шаг 9) красна на рукописном теле — перечень
  строк снять грепом id аспектов и свойств `module: 'finance'` по `v6.ts`; (2) строка `v6.ts:70` меняет хвост
  «…Какие ключи требует каждый вариант aggregate — в инструкции аспекта orbis/goal ниже; не угадывай их состав.» на
  «…Какие ключи требует каждый вариант aggregate — в описании тула attach_orbis_goal; не угадывай их состав.».
  `v7.test.ts` — механика `v6.test.ts` (снимок по фикстуре, версия, дифф против v6 с `REPLACED_V7` из строк правок (1) и
  (2), перенос исполняемых гардов v6 дословно со сменой импорта). `v7.test.ts` цитирует голое `status=` (гард отказа
  разбора, как `v6.test.ts:145-156`) — в `ALLOWLIST` `scripts/check-legacy-form.ts:541-548` добавить запись
  `{path: 'apps/server/src/llm/prompts/v7.test.ts', markers: ['bare-field'], reason: …}` по образцу записи `v6.test.ts`. `scripts/check-legacy-form.ts:477-493` — добавить `'v6'`,
  `'v6.fixture'` в `FROZEN_PROMPTS` с комментарием «замораживается срезом 1а вместе с v7: снимок промпта до индекса
  аспектов». Прогон: `cd $W/apps/server && bun test src/llm/prompts/v7.test.ts src/llm/prompts/v6.test.ts > …/t1b.log 2>&1`
  и `cd $W && bun test scripts/check-legacy-form.test.ts > …/t1c.log 2>&1` → PASS.

- [ ] **Шаг 9: красные тесты собранного канала (две проверки §10 п. 2).** В `context.test.ts`:
  - переписать тест `:99-117` в «канал начинается с PROMPT_BODY и несёт ИНДЕКС аспектов, а не их инструкции»:
    `expect(ctx.system).toContain(ASPECT_INDEX_HEADING)`, `toContain('- orbis/task — ')`, `not.toContain(taskInstructions)`;
  - новый `describe('собранный канал: две проверки §10 п. 2 спеки 1а')`:
```ts
test('инструкций аспектов в канале чата и рутины — ноль', async () => {
  const reg = await withIdentity(db, personal(owner), (tx) => effectiveRegistry(tx, owner));
  const chat = (await chatChannel(owner)).system;
  const routine = (await routineChannel(owner)).system; // buildRoutineContext; образец — routines/context.test.ts
  for (const a of reg.aspects.values()) {
    if (!a.aiInstructions) continue;
    expect(chat.includes(a.aiInstructions) ? a.id : null).toBeNull();
    expect(routine.includes(a.aiInstructions) ? a.id : null).toBeNull();
  }
});
test('ни слова о выключенных приложениях: id аспектов и свойств модуля finance и его фрагменты', async () => {
  await setFinance(owner, false);
  const off = (await chatChannel(owner)).system;
  const reg = await withIdentity(db, personal(owner), (tx) => effectiveRegistry(tx, owner));
  const financeIds = [...reg.aspects.values(), ...reg.properties.values()]
    .filter((x) => x.module === 'finance').map((x) => x.id);
  expect(financeIds.length).toBeGreaterThan(0);
  expect(financeIds.filter((id) => off.includes(id))).toEqual([]);
  for (const f of MODULE_MANIFESTS.finance.promptFragments) expect(off).not.toContain(f.text);
  await setFinance(owner, true);
});
```
  (Имена полей фрагмента — по `packages/shared/src/registry/modules.ts` `ModuleManifest.promptFragments`; помощники
  `chatChannel`/`setFinance` — по образцу `registry/modules.test.ts:670-690`.) Граница проверки — в докблоке теста: собранный канал чата
  и рутины; вне её — замороженный `routine-v3` (`routine-v3.fixture.txt:44`, `orbis/category`) и описание тула
  `entity_query` (`tools/registry.ts:1120`) — запись в `remainders-1a.md` (задача 17). Пины заголовка `:158`, `:198`, `:206` →
  `ASPECT_INDEX_HEADING`. `routines/context.test.ts:76,101` — «инструкции аспектов» → «индекс аспектов».
  `registry/modules.test.ts:683-690`: `'- orbis/financial:'` → `'- orbis/financial — '`, `'- orbis/task:'` →
  `'- orbis/task — '`. Прогон: `cd $W/apps/server && bun test src/llm/context.test.ts src/routines/context.test.ts
  src/registry/modules.test.ts > …/t1d.log 2>&1` → FAIL (канал ещё несёт инструкции).

- [ ] **Шаг 10: сборка канала на индекс.** `llm/context.ts`: импорт v7 вместо v6 (`:48`; тело и хвост вычисляются из
  `SYSTEM_PROMPT_V7`, текст ошибки `:83` — тоже); `aspectInstructionsSection` снести, в `buildContext` (`:547-549`)
  звать `aspectIndexSection(tx, input.graphId, disabled)`; докблок `:505-515` заменить докблоком индекса.
  `routines/context.ts:299-305` — `aspectIndexSection(tx, input.graphId, await disabledModulesOf(tx, input.graphId))`.
  `tools/registry.ts` — снести `AspectToolRow` и `loadAspectToolRows` (`:1274-1325`) и импорт в `context.ts:46`;
  `registry/load.ts:12-30` — убрать пункт перечня; докблок `buildToolDefs` (`tools/registry.ts:1441-1446`: «core-тулы
  аспект принимают — их удерживает `aiInstructions`») переписать: границу служебного аспекта держит строка-граница индекса
  (РП-26). Прогон шага 9 → PASS.

- [ ] **Шаг 11: мутации (С1а-10).** (а) вернуть в `aspectIndexLines` в конец строки `: ${a.aiInstructions}` →
  красные `aspect-index.test.ts` и «инструкций — ноль»; (б) снять фильтр маски → красный «ни слова о выключенных»;
  (в) снять `.filter((a) => !a.service)` → красный тест строки-границы. Каждую — откатить. Запись в отчёт.

- [ ] **Шаг 12: полный прогон и коммит.**
```
cd /Users/birzhan/projects/orbis/.claude/worktrees/pages-slice-1a && git add apps/server/src/llm/aspect-index.ts apps/server/src/llm/aspect-index.test.ts apps/server/src/llm/prompts/v7.ts apps/server/src/llm/prompts/v7.fixture.txt apps/server/src/llm/prompts/v7.test.ts
cd /Users/birzhan/projects/orbis/.claude/worktrees/pages-slice-1a && bun run test > /private/tmp/claude-501/pages-1a/t1-full.log 2>&1; echo EXIT=$?
cd /Users/birzhan/projects/orbis/.claude/worktrees/pages-slice-1a && bun run lint > /private/tmp/claude-501/pages-1a/t1-lint.log 2>&1; echo EXIT=$? && bun run typecheck > /private/tmp/claude-501/pages-1a/t1-tsc.log 2>&1; echo EXIT=$?
cd /Users/birzhan/projects/orbis/.claude/worktrees/pages-slice-1a && bun scripts/check-legacy-form.ts --gate; echo EXIT=$?
cd /Users/birzhan/projects/orbis/.claude/worktrees/pages-slice-1a && git commit -m "feat(llm): индекс аспектов вместо ai_instructions в канале чата и рутин, промпт v7 (§С8-35 п. 3)

Инструкции аспектов живут ровно в описании attach_*; канал несёт индекс «id — подпись: описание»
по эффективному реестру, порядок rank, маска модулей, без служебных. Две проверки собранного
канала: инструкций — ноль; ни слова о выключенных модулях. v6.ts:70 ссылался на инструкцию
«ниже» — отсюда v7 (одна строка), v6 заморожен.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- apps/server/src/llm apps/server/src/routines/context.ts apps/server/src/routines/context.test.ts apps/server/src/tools/registry.ts apps/server/src/registry/load.ts apps/server/src/registry/modules.test.ts apps/server/src/ai/send-message.test.ts scripts/check-legacy-form.ts
```
  Ожидание: все EXIT=0; счётчики против базовой линии шага 4 — только новые тесты. Протокол закрытия — «Закрытие
  задачи» глобальных ограничений (push ветки ради CI; `main` не трогается).

### Задача 2: Эталон экрана записи ДО правок web (С1а-5, база С1а-6)

**Зачем:** приёмка С1а-5 — «снимки до/после на записях всех 13 встроенных аспектов и частых сочетаний; расхождения
— только §8.2». Снимков в проекте нет (Ф-1а-17), а «до» можно снять только со старого экрана — поэтому эталон
фиксируется ДО любой правки web (задачи 11–16). Тем же заходом снимается множество запросов при открытии записи
(база сторожа РП-11 (2)). Задача не меняет продуктового кода.

**Файлы:**
- Создать: `apps/web/src/features/entity-detail/structure-snapshot.ts` (экстрактор), `apps/web/src/features/entity-detail/structure-fixtures.ts`
  (фикстуры записей и обработчик всех путей экрана), `apps/web/src/features/entity-detail/structure.test.tsx`,
  `apps/web/src/features/entity-detail/structure.capture.test.tsx` (съёмка по `CAPTURE=1`),
  `apps/web/src/features/entity-detail/golden/detail-structure.json`, `apps/web/src/features/entity-detail/golden/detail-requests.json`.
- НЕ трогать: `DetailScreen.tsx` и его части (эталон снимается с НЕТРОНУТОГО экрана).

**Интерфейсы:**
- Consumes: `renderWithProviders(ui, handler, {strict?}) → {calls: {path, input}[] , …}` (`apps/web/src/test/harness.tsx:149`),
  `wireEntity(over)` (`:233`), `installCrashTrap()` (`:35`), `registryReply(path)` (`apps/web/src/test/registry.ts:45`),
  `DetailScreen({entityId})`, опорные `data-testid` экрана: `entity-tabs`, `native-row`, `aspect-<id>`, `prop-<id>`,
  `goal-progress`, `ticket-waiting`, `assignment-card`, `routine-status`, `runs-list`, `versions-card`, `subtask`,
  `backlink`, `body-notices`, `detail-menu` (переснять грепом по `features/entity-detail/*.tsx`).
- Produces (для задач 12 и 14):
```ts
// structure-snapshot.ts
export interface DetailStructure {
  aboveTabs: string[];                         // ориентиры над вкладками в порядке документа
  tabs: { label: string; parts: string[] }[];  // подпись вкладки + ориентиры её панели
}
/** Ориентир: имя testid из LANDMARKS; для карточки аспекта — `aspect:<id>[prop:<id>,…]`; тело — `body`. */
export function snapshotDetailStructure(container: HTMLElement): DetailStructure;
export const LANDMARKS: readonly string[]; // включает `tags-block` и `page-text` (на старом экране их нет — задачи 13–14)
// structure-fixtures.ts
export interface StructureFixture { name: string; entity: WireEntity; extra?: Partial<EntityGetReply> }
export const STRUCTURE_FIXTURES: readonly StructureFixture[];
export function structureHandler(f: StructureFixture): MockHandler;
```
  Эталоны `golden/detail-structure.json` (`Record<fixtureName, DetailStructure>`) и `golden/detail-requests.json`
  (`Record<fixtureName, Record<path, number>>` — число вызовов каждого пути tRPC до стабилизации экрана; счёт, а не
  множество: список шаблонов в задаче 14 добавит `entity.query`, который у тикетов уже есть) НЕ перезаписываются
  никогда; задача 14 сравнивает с ними через функцию трёх намеренных отличий.

- [ ] **Шаг 1: проба средства.** В `structure.test.tsx` один тест: `goal`-фикстура (образец `goal.test.tsx:13-45`)
  → `snapshotDetailStructure(container)` содержит вкладки «Сущность», «Детали», «Тред» и в «Сущности» — `goal-progress`,
  в «Деталях» — `aspect:orbis/goal[…]`. Прогон
  `cd $W/apps/web && bun run test src/features/entity-detail/structure.test.tsx > /private/tmp/claude-501/pages-1a/t2.log 2>&1`
  → FAIL (модуля нет).

- [ ] **Шаг 2: экстрактор.** Обход DOM в порядке документа. Над `entity-tabs` — ориентиры по `LANDMARKS`
  (`native-row`, эмодзи — по признаку, который даёт `DetailScreen.tsx:271-275`; теги — если появятся). Для каждой
  панели вкладки (`role="tabpanel"`; постоянные панели в jsdom видны обе — `Tabs.tsx:95-96`): ориентиры `LANDMARKS`,
  карточки аспектов `aspect:<id>[prop:<id>,…]` (свойства — в порядке DOM), тело — `body` (по `editor-preview` или
  редактору). Без текстов, классов, id записей. Подпись вкладки — текст триггера. Вкладка «Тред» без `keepMounted` —
  фиксируется только подписью. Прогон шага 1 → PASS.

- [ ] **Шаг 3: фикстуры.** `STRUCTURE_FIXTURES` — 13 записей по одному встроенному аспекту
  (`BUILTIN_ASPECT_IDS`, `packages/shared/src/constants.ts:148-162`) с правдоподобными `props` (по одной на аспект,
  значения — по `BUILTIN_PROPERTY_META`), плюс сочетания: `ticket` (task + assignment), `recurring-payment`
  (financial + schedule), `project-task` (project + task), `goal-schedule`, `financial-task`, `note-plain`
  (`aspects: []`), `with-relations` (task с подзадачей, блокировкой и обратной ссылкой). Тела фикстур — текст БЕЗ блоков
  данных: их путь меняет задача 11, а структура экрана от тела не зависит. `structureHandler` отвечает
  ВСЕМ путям экрана (`entity.get` c `relations`/`backlinks`/`thread`/`goalProgress`, `registry.effective`,
  `user.getSettings`, `version.list`, `entity.query` для прогонов, `routine.*`, `oauth.listGrants`, прочее — `{}`):
  блок, которому не ответили, молча пуст и зафиксировал бы пустоту. Тест-сторож: для каждой фикстуры снимок
  непуст и содержит `native-row`; для аспектных фикстур — `aspect:<id>` или свою карточку (`goal-progress`,
  `assignment-card`, `routine-status`, `ticket-waiting`, лента прогона).

- [ ] **Шаг 4: съёмка эталонов.** `structure.capture.test.tsx` — `test.runIf(process.env.CAPTURE === '1')`: рендер
  каждой фикстуры, `waitFor` стабилизации (нет `harness-suspended`, есть `native-row`), запись
  `{structure, requests}` в файл `process.env.CAPTURE_OUT`. Запуск:
  `cd $W/apps/web && CAPTURE=1 CAPTURE_OUT=/private/tmp/claude-501/pages-1a/detail-capture.json bun run test src/features/entity-detail/structure.capture.test.tsx > …/t2cap.log 2>&1`;
  разложить результат по двум файлам `golden/*.json`, `bunx biome check --write` по ним. Прочитать эталон глазами:
  каждая фикстура показывает то, что видно на экране сегодня (карточки на «Деталях», прогресс цели на «Сущности»).

- [ ] **Шаг 5: сторож «эталон = экран».** В `structure.test.tsx`: для каждой фикстуры снимок и множество путей
  равны эталону (`toEqual`). Докблок: «эталон снят задачей 2 на экране до среза 1а; не перезаписывается; задача 14
  сравнивает через `INTENDED_1A`». Прогон → PASS.

- [ ] **Шаг 6: мутация.** Временно убрать `GoalProgress` из `DetailScreen.tsx` (`:290-295`) → сторож красный на
  `goal`/`goal-schedule`; откатить (`git diff --stat` пуст по `DetailScreen.tsx`).

- [ ] **Шаг 7: полный прогон и коммит.**
```
cd /Users/birzhan/projects/orbis/.claude/worktrees/pages-slice-1a && git add apps/web/src/features/entity-detail/structure-snapshot.ts apps/web/src/features/entity-detail/structure-fixtures.ts apps/web/src/features/entity-detail/structure.test.tsx apps/web/src/features/entity-detail/structure.capture.test.tsx apps/web/src/features/entity-detail/golden
cd /Users/birzhan/projects/orbis/.claude/worktrees/pages-slice-1a && bun run test > /private/tmp/claude-501/pages-1a/t2-full.log 2>&1; echo EXIT=$? && bun run lint > …/t2-lint.log 2>&1; echo EXIT=$? && bun run typecheck > …/t2-tsc.log 2>&1; echo EXIT=$?
cd /Users/birzhan/projects/orbis/.claude/worktrees/pages-slice-1a && git commit -m "test(web): эталон структуры экрана записи и множества запросов ДО среза 1а (С1а-5, РП-10)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- apps/web/src/features/entity-detail/structure-snapshot.ts apps/web/src/features/entity-detail/structure-fixtures.ts apps/web/src/features/entity-detail/structure.test.tsx apps/web/src/features/entity-detail/structure.capture.test.tsx apps/web/src/features/entity-detail/golden
```

### Задача 3: Стенд живой проверки §С8-30 и перезамер бюджетов промпта

**Зачем:** спека §10 п. 3–4 — перезамер слоёв 1 и 5 после Б-2 (тулов 51, замер 25.08 был на v4) и стенд §С8-30
(12 сценариев × 2 модели, паритет индекса с полным каталогом) до «готово к прогону». Старый стенд П3 мёртв и вне git
(Ф-1а-14): он переносится в дерево по образцу `scripts/probe-p4.ts` (скрипт-модуль + тест чистой части). Токены
меряются только живым вызовом провайдера — при кредитах (РП-17, В-7).

**Файлы:**
- Создать: `scripts/probe-p3.ts`, `scripts/probe-p3.test.ts`, `scripts/probe-p3/{scenarios,world,runner,variants}.ts`,
  `scripts/prompt-size.ts`, `scripts/prompt-size.test.ts`.
- Изменить: `docs/prd/01-architecture.md:1090-1100` (таблица бюджетов: байты слоёв 1 и 5 на v7 после Б-2, дата,
  строка «токены — живым замером при кредитах: `bun scripts/prompt-size.ts --tokens`»).
- Источник переноса (только чтение): `.superpowers/probe/p3/{scenarios,world,runner,run,report,gen-prompt,size}.ts`
  (снятые API — `parseQuery`, `ASPECT_SCHEMAS`, колонки `schema`/`owner_id` — живут в `runner.ts:13,18,136,183`; в
  `scenarios.ts` их нет),
  методика — `docs/superpowers/reviews/2026-08-25-probe-p3.md` §3, §4, §9.

**Интерфейсы:**
- Consumes: `buildContext(tx, {graphId, threadId})` (`apps/server/src/llm/context.ts`), `buildRoutineContext`
  (`apps/server/src/routines/context.ts`), `buildToolRegistry(tx, graphId)` (`apps/server/src/tools/registry.ts:1494`),
  `makeLLMProvider(env)` (`apps/server/src/llm/provider`), `ASPECT_INDEX_HEADING` (задача 1), `seedOwner` онбординга
  (мир владельца), образец отбора провайдера — `scripts/probe-p4.ts:174-188`, кодов выхода — `:521-741`
  (докблок `:1-60`).
- Produces: `bun scripts/probe-p3.ts --dry-run` (EXIT 0 = готово к прогону) и живой прогон
  `bun scripts/probe-p3.ts --variant=index|catalog --model=<id> --rep=N`; `bun scripts/prompt-size.ts [--tokens]`.
  Коды выхода `probe-p3`: 0 — паритет (индекс на прод-модели не ниже каталога более чем на 2 из 36 — разброс,
  измеренный П3 §3); 3 — паритета нет (откат, названный спекой реформы: «каталог аспектов + подгрузка по
  релевантности»); 2 — замер не состоялся (нет провайдера/кредитов); 1 — сломался.

- [ ] **Шаг 1: красный тест чистой части.** `scripts/probe-p3.test.ts`: (а) все 12 сценариев из переносимого
  `scenarios.ts` ссылаются только на существующие key свойств и аспектов текущего реестра (`BUILTIN_*`); (б) вариант
  `catalog` = канал `index` + секция каталога свойств по аспектам (порядок `rank`), остальное побайтно равно;
  (в) предикаты проверки сценариев на синтетических трассах: `goal-sum` проходит на трассе с `attach_orbis_goal`
  (`aggregate: sum`, `field`), падает без неё; (г) `selectProvider` без ключа → «замер не состоялся». `scripts/prompt-size.test.ts`:
  байты считаются `Buffer.byteLength(…, 'utf8')` по каналу и по JSON схем тулов; `--tokens` без провайдера — EXIT 2.
  Прогон `cd $W && bun test scripts/probe-p3.test.ts scripts/prompt-size.test.ts > …/t3.log 2>&1` → FAIL.

- [ ] **Шаг 2: перенос стенда.** `world.ts`, `runner.ts` (tool-цикл, заглушка исполнителя со стадией 2 валидации),
  `scenarios.ts` (12 сценариев таблицы П3 §3; ключи — по реестру после Б-2: `parseQueryAst` вместо снятого
  `parseQuery`, `effectiveRegistry` вместо `ASPECT_SCHEMAS`, `graph_id` вместо `owner_id`), `variants.ts`
  (`index` — ровно прод-канал `buildContext`; `catalog` — он же плюс секция каталога свойств, собранная из
  эффективного реестра по образцу старого `gen-prompt.ts` `aspectCatalogSection`), `probe-p3.ts` (флаги, коды выхода,
  отчёт таблицей П3 §3 в `out/` вне git — путь аргументом). Сценарий `routine-propose` идёт каналом чата, как в П3
  (рулинг б' исполнения 24.09: propose-рутине прод запрещает предложения про `orbis/routine`); канал propose-рутины
  (риск В-6) меряет отдельный диагностический сценарий вне паритета. Прогон
  шага 1 → PASS; `cd $W && bun scripts/probe-p3.ts --dry-run > …/t3dry.log 2>&1; echo EXIT=$?` → 0 (собраны оба
  варианта для 12 сценариев, модель не вызывалась).

- [ ] **Шаг 3: `prompt-size.ts` и замер байтов.** Слой 1 — канал `buildContext` владельца после `seedOwner` без памяти
  и якоря; слой 5 — JSON схем тулов `buildToolRegistry` в форме провайдера по умолчанию. `--tokens` — разность
  `inputTokens` трёх вызовов (методика `size.ts:24-35`). Запуск без `--tokens`:
  `cd $W && bun scripts/prompt-size.ts > …/t3size.log 2>&1` — записать байты. С `--tokens` — один раз: при отказе
  провайдера по кредитам — записать «токены не замерены: кредиты» (не ошибка задачи).

- [ ] **Шаг 4: таблица бюджетов.** `docs/prd/01-architecture.md:1090-1100`: строки слоёв 1 и 5 — факт в БАЙТАХ на v7
  с датой и числом тулов (51), прежние токены 25.08 оставить с пометкой «v4, до индекса»; абзац `:1100` (про дубль
  инструкций) — «снят индексом аспектов (срез 1а, задача 1)»; строка «токены — `bun scripts/prompt-size.ts --tokens`
  при кредитах». Цель слоя 1 «≤ 2 000 токенов» не трогать.

- [ ] **Шаг 5: мутация.** В `variants.ts` сделать `catalog` равным `index` → красный тест (б); откатить.

- [ ] **Шаг 6: полный прогон и коммит.**
```
cd /Users/birzhan/projects/orbis/.claude/worktrees/pages-slice-1a && git add scripts/probe-p3.ts scripts/probe-p3.test.ts scripts/probe-p3 scripts/prompt-size.ts scripts/prompt-size.test.ts
cd /Users/birzhan/projects/orbis/.claude/worktrees/pages-slice-1a && bun run test > /private/tmp/claude-501/pages-1a/t3-full.log 2>&1; echo EXIT=$? && bun run lint > …/t3-lint.log 2>&1; echo EXIT=$? && bun run typecheck > …/t3-tsc.log 2>&1; echo EXIT=$?
cd /Users/birzhan/projects/orbis/.claude/worktrees/pages-slice-1a && git commit -m "feat(scripts): стенд §С8-30 в дереве (индекс против каталога) и замер размера промпта

Стенд П3 перенесён из .superpowers (мёртв после реформы) в scripts/ по образцу probe-p4:
--dry-run собирает оба варианта канала на 12 сценариях без модели; живой прогон ждёт
кредитов. Бюджеты слоёв 1 и 5 — в байтах на v7 после Б-2; токены — при кредитах.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- scripts/probe-p3.ts scripts/probe-p3.test.ts scripts/probe-p3 scripts/prompt-size.ts scripts/prompt-size.test.ts docs/prd/01-architecture.md
```

### Задача 4: Аспект «страница» — `registry_ref` списком, аспект №14, два свойства, два правила

**Зачем:** спека §3 — аспект `orbis/page` (ядро, `module: null`) с двумя свойствами «Шаблон для» (список аспектов) и
«Главнее, чем» (список ссылок на страницы) и двумя правилами каталога Б-2. Разведка (Ф-1а-1) показала, что флаг
`service` прячет записи из всех выдач, — аспект объявляется обычным, а от модели его убирает временный список кода
(РП-1, В-1): нет `attach_orbis_page`, нет строки в индексе промпта. Сюда же — сквозной конфиг `cardinality` у
`registry_ref` (§3.2), проверка существования его значений списком (Ф-1а-4) и контролы web, без которых ссылочный
список затёрся бы одиночным `RefField` (Ф-1а-19).

**Файлы:**
- shared, изменить: `constants.ts:148-163` (`'orbis/page'` В КОНЕЦ `BUILTIN_ASPECT_IDS` — иначе сдвинется `rank`
  соседей), новый экспорт `AUTHORING_DEFERRED_ASPECTS`; `registry/types.ts:195` (`...listConfig`, докблок про двух
  потребителей: 1а и манифест 1б); `registry/builtin-properties.ts` (две записи В КОНЕЦ массива, после core-проекций;
  шапка `:4-9`, `:31`, `:1128-1131` — «75 доменных + 4 core»); `registry/builtin-aspects.ts` (запись №14 в конец
  `ENTRIES`; докблок `:492` «тринадцать» → «четырнадцать»); `registry/builtin-rules.ts` (две константы, ключ
  `'orbis/page'` в `BUILTIN_RULES_BY_CARRIER` `:385-401`).
- shared, тесты: `registry/builtin.test.ts` (пины — таблица шага 1), `registry/builtin-rules.test.ts:35-65,85-120`,
  `registry/property-type.test.ts`, `registry/value-schema.test.ts`.
- server, изменить: `src/registry/ref.ts:193-203` (`assertRegistryRefValue` над массивом — по образцу `refIds`
  `:64-68`), `src/tools/registry.ts:1455-1463` (`buildToolDefs` — фильтр `AUTHORING_DEFERRED_ASPECTS`),
  `src/llm/aspect-index.ts` (тот же фильтр), докблоки `src/registry/version.ts:66`, `src/routers/entity.ts:310`,
  `src/policy/confirmation.ts:266`, комментарии `test/rls/rls.pgtap.sql:97`, `src/tools/property-catalog.test.ts:157`.
- server, тесты: `test/seed-registries.test.ts:44,61,63,965,967`, `src/routers/registry.test.ts:44,48,49,136`,
  `src/registry/load.test.ts:74`, `src/registry/validator-golden.test.ts` + `test/golden/validator-verdicts.json`,
  `src/policy/confirmation.test.ts:981`, `src/registry/ref.test.ts`, `src/rules/engine.test.ts` (или новый
  `src/rules/page-rules.test.ts`), `src/tools/registry.test.ts`, `src/llm/aspect-index.test.ts`.
- scripts: `scripts/probe-p4.test.ts:334`, `scripts/probe-p4.ts:100,392` (числа считаются по `BUILTIN_PROPERTY_META`
  — пересчитать прогоном, не руками).
- web: `apps/web/src/lib/registry/controls.ts:60-78`, `apps/web/src/lib/registry/PropertyControl.tsx` (+
  `PropertyControl.test.tsx`), `apps/web/src/lib/registry/format.ts:81-92` (`displayText`: `registry_ref` аспекта — подписями вместо сырых id).

**Интерфейсы:**
- Consumes: `RuleDefinitionInput` (`registry/rule-type.ts`), образец строки `requires_when` —
  `RULE_ASSIGNMENT_GRANT_REQUIRED` (`builtin-rules.ts:134-140`); образец служебного аспекта ядра — `orbis/agent-run`
  (`builtin-aspects.ts:416-458`); образец `ref` на записи аспекта — `orbis/finance_category` (`builtin-properties.ts:402-411`);
  `aspectIndexLines` (задача 1).
- Produces (для задач 5, 12–16):
```ts
// packages/shared/src/constants.ts
export const PAGE_ASPECT = 'orbis/page';
export const TEMPLATE_FOR_PROPERTY = 'orbis/template_for';
export const TEMPLATE_WINS_OVER_PROPERTY = 'orbis/template_wins_over';
/** Аспекты, чьё авторство агентом отложено (РП-1): нет attach_*, нет строки индекса. Снимает срез 2. */
export const AUTHORING_DEFERRED_ASPECTS: readonly string[] = [PAGE_ASPECT];
// registry/builtin-rules.ts
export const RULE_PAGE_WINS_OVER_NEEDS_TEMPLATE: RuleDefinitionInput; // id 'page_wins_over_needs_template_for'
export const RULE_PAGE_WINS_OVER_NOT_SELF: RuleDefinitionInput;       // id 'page_wins_over_not_self'
// apps/web/src/lib/registry/controls.ts — новые виды контролов
type ControlKind = … | 'aspects-many';   // registry_ref {target:'aspect', cardinality:'many'}
// ref {cardinality:'many'} → 'readonly' (правка «Главнее, чем» — только плашкой спора, задача 14)
```

- [ ] **Шаг 1: красные тесты shared.** `property-type.test.ts`: `{kind:'registry_ref', target:'aspect',
  cardinality:'many', minItems:1}` принимается; `{…, cardinality:'many', foo:1}` отвергается (`.strict()` жив).
  `value-schema.test.ts`: схема значения — `{type:'array', items:{type:'string'}, minItems:1}`. `builtin.test.ts` — пины
  (адреса `recon-plan-1-shared.md` П3):

  | адрес | было | станет |
  |---|---|---|
  | `:36` `A8` | 13 ключей | + `'orbis/page': [[null,'orbis/template_for',false],[null,'orbis/template_wins_over',false]]` |
  | `:238-244` | 73 доменных / 77 | 75 / 79 |
  | `:305-306` | 13 аспектов / rank 1…13 | 14 / 1…14 |
  | `:339-341` | служебные `['orbis/agent-run']` | без изменений (страница НЕ служебная — РП-1) |
  | `:343-357` | карта module | + `'orbis/page': null` |
  | `:528-606` | снимок `ASPECTS` | + строка `orbis/page` |
  | `:609`, `:671` | 13 | 14 |
  | `A8_TYPES` `:~900-963` | 77 сигнатур | + `'orbis/template_for': 'registry_ref{cardinality:many,minItems:1,target:aspect}\|core'`, `'orbis/template_wins_over': 'ref{cardinality:many,max:50,target:{"filter":{"aspect":"orbis/page"}}}\|core'` (форма — по генератору сигнатур теста) |
  | `:1022-1036` | подписи ru | + `'orbis/page': 'Страница'` |

  `builtin-rules.test.ts`: + два id в списке, + два `'check'` в `undo` C-строк. Новый тест:
  `AUTHORING_DEFERRED_ASPECTS ⊆ BUILTIN_ASPECT_IDS` и ни один его элемент не `service`. Прогон
  `cd $W/packages/shared && bun test src/registry/ > /private/tmp/claude-501/pages-1a/t4a.log 2>&1` → FAIL.

- [ ] **Шаг 2: реестр в shared.** `types.ts:195` →
  `z.object({ kind: z.literal('registry_ref'), target: z.enum(REGISTRY_REF_TARGETS), ...listConfig }).strict()`.
  Свойства (в конец `ENTRIES`, `module: null`):
```ts
{ id: 'orbis/template_for', label: { ru: 'Шаблон для', en: 'Template for' },
  description: { ru: 'Набор аспектов: записям, несущим их все, эта страница подходит как шаблон; пусто — просто страница',
                 en: 'Aspect set: records carrying all of them may be shown through this page as a template' },
  // minItems: 1 — несущее: `present([])` истинно (Ф-1а-3), без него правило «Главнее, чем → Шаблон для»
  // пропустило бы пустой список; очистка «Шаблон для» — только `unset`.
  type: { kind: 'registry_ref', target: 'aspect', cardinality: 'many', minItems: 1 }, module: null },
{ id: 'orbis/template_wins_over', label: { ru: 'Главнее, чем', en: 'Wins over' },
  description: { ru: 'Запомненные выборы владельца в спорах шаблонов: этот шаблон побеждает перечисленные',
                 en: 'Remembered owner choices in template disputes: this template wins over the listed ones' },
  type: { kind: 'ref', target: { filter: { aspect: 'orbis/page' } }, cardinality: 'many', max: 50 }, module: null },
```
  Аспект (в конец `ENTRIES`): `id: 'orbis/page'`, `label {ru:'Страница', en:'Page'}`, `description {ru:'Запись,
  которая показывается своим телом: текст и блоки. С непустым «Шаблон для» — шаблон для записей с этими аспектами',
  en:…}`, `properties: [['orbis/template_for', false], ['orbis/template_wins_over', false]]`, `aiInstructions:
  'orbis/page — страница и шаблон владельца. Страницы пишет владелец в интерфейсе: аспект orbis/page сам не навешивай
  и orbis/template_for / orbis/template_wins_over не меняй (авторство страниц агентом — позже).'`, `tagMappings: []`,
  `viewConfig: { keyFields: ['orbis/template_for'], icon: '📄' }`, `module: null`, `service: false` с комментарием
  «НЕ служебный: служебность прячет записи из всех выдач (Ф-1а-1); от модели аспект убирает
  `AUTHORING_DEFERRED_ASPECTS`». Правила — дословно из `facts.md` Ф-1а-3 (`recon-plan-1-shared.md` П1 (а), (б)) с
  `undo: 'check'` и докблоком «почему» (правило (б) превращает сырую ошибку БД `rel_no_self` в именованный отказ).
  Константы `PAGE_ASPECT`, `TEMPLATE_FOR_PROPERTY`, `TEMPLATE_WINS_OVER_PROPERTY`, `AUTHORING_DEFERRED_ASPECTS` —
  в `constants.ts` с докблоком «временный список: отступление от довода `tools/registry.ts:1441-1446` (служебность
  из колонки) — РП-1 плана (вопрос В-1); в реестр §11.2 спеки предлагается эррата Э-1; снимает срез 2». Прогон шага 1 → PASS.

- [ ] **Шаг 3: красные тесты сервера.** (а) `ref.test.ts`: `registry_ref` списком с несуществующим id аспекта →
  отказ (как у одиночного); со всеми живыми — ok. (б) `page-rules.test.ts` (граф — `await freshGraph()`, запись —
  `execute` через `personal(g)`): запись с `orbis/page` и `template_wins_over: [<id другой страницы>]` без
  `template_for` → `INVARIANT`, `details.invariant = 'page_wins_over_needs_template_for'`; с `template_for:
  ['orbis/project']` → ok; `template_wins_over: [<свой id>]` → `INVARIANT page_wins_over_not_self` (НЕ сырая ошибка
  БД); `template_for: []` → отказ валидатора значений (`minItems`). (в) `tools/registry.test.ts`: `buildToolDefs(reg)`
  не содержит `attach_orbis_page`; эталон тулов 51 без изменений. (г) `aspect-index.test.ts`: строки
  `- orbis/page ` нет. (д) пины «13/77» (список «Файлы»). Прогон
  `cd $W/apps/server && bun test src/registry/ref.test.ts src/rules/page-rules.test.ts src/tools/registry.test.ts src/llm/aspect-index.test.ts > …/t4b.log 2>&1` → FAIL.

- [ ] **Шаг 4: сервер.** `assertRegistryRefValue`: массив → проверка каждого элемента тем же запросом (образец
  `refIds`); `buildToolDefs` и `aspectIndexLines`: `.filter((a) => !AUTHORING_DEFERRED_ASPECTS.includes(a.id))` с
  комментарием-ссылкой на РП-1. Пины «13/77» → «14/79» (тексты и числа). `validator-golden`: две записи корпуса
  `orbis/page` — позитив `{aspects:['orbis/page'], props:{'orbis/template_for':['orbis/project']}}` и негатив
  `{…'orbis/template_for': []}` (нарушение `minItems`); у обеих `legacyVerdict = newVerdict`; в тесте константа
  `POST_FREEZE_ASPECTS = ['orbis/page']` и проверка «у записей этих аспектов свидетель совпадает с новым вердиктом» с
  докблоком РП-12; `COVERAGE['orbis/page'] = [1, 1]`, `CORPUS_SIZE`/`POSITIVE_RECORDS`/`NEGATIVE_RECORDS` +1/+1/+1.
  Пересев: `cd $W && bun run db:prepare > …/t4prep.log 2>&1` — «свойств 79 … аспектов 14». `probe-p4` — прогнать
  `cd $W && bun test scripts/probe-p4.test.ts > …/t4p4.log 2>&1`, взять новые `[79, pairs, crossed]` из отказа и
  вписать в тест и текст `probe-p4.ts:100,392` (число пар — формула по реестру, не угадывать). Прогон шага 3 → PASS.

- [ ] **Шаг 5: контролы web.** `controls.ts:60-78`: `ref` с `cardinality:'many'` → `'readonly'` (показ списка ссылок
  через `EntityRef`); `registry_ref {target:'aspect', cardinality:'many'}` → `'aspects-many'`.
  `PropertyControl.tsx`: `AspectsManyControl` по образцу `SelectManyControl` (`:181-238`): чипы-переключатели по
  `registry.data.aspects` (подпись `aspectLabel`, порядок `rank`), пустой выбор → `onChange(undefined)` (снятие, не
  `[]` — `minItems`); контрол соблюдает `minItems` генерически — последний выбранный аспект снять нельзя, подсказка «сделать
  черновиком: ⋯ → «Сделать шаблоном для…» → снять все» (РП-27). `displayText` (`format.ts:81-92`): `registry_ref` аспекта —
  подписями. Тесты
  `PropertyControl.test.tsx`: выбор двух аспектов шлёт массив id; последний аспект при `minItems: 1` снять нельзя (кнопка неактивна), без `minItems` — `undefined`; `ref`-список рисуется
  только чтением. Прогон `cd $W/apps/web && bun run test src/lib/registry/ > …/t4c.log 2>&1` → PASS.

- [ ] **Шаг 6: мутации.** (а) убрать `minItems: 1` → красный «template_for: [] отказ» и «wins_over без template_for»
  на пустом списке; (б) убрать фильтр `AUTHORING_DEFERRED_ASPECTS` в `buildToolDefs` → красный (в); (в) вернуть в
  `assertRegistryRefValue` ранний `return` на массиве → красный (а). Откатить.

- [ ] **Шаг 7: полный прогон, дрейф, коммит.**
```
cd /Users/birzhan/projects/orbis/.claude/worktrees/pages-slice-1a && git add apps/server/src/rules/page-rules.test.ts
cd /Users/birzhan/projects/orbis/.claude/worktrees/pages-slice-1a && bun run test > /private/tmp/claude-501/pages-1a/t4-full.log 2>&1; echo EXIT=$? && bun run lint > …/t4-lint.log 2>&1; echo EXIT=$? && bun run typecheck > …/t4-tsc.log 2>&1; echo EXIT=$?
cd /Users/birzhan/projects/orbis/.claude/worktrees/pages-slice-1a && bun scripts/check-legacy-form.ts --gate; echo EXIT=$?
cd /Users/birzhan/projects/orbis/.claude/worktrees/pages-slice-1a && git commit -m "feat(registry): аспект orbis/page, свойства «Шаблон для» и «Главнее, чем», registry_ref списком

Аспект — ядро, НЕ служебный: service прячет записи из всех выдач (Ф-1а-1). От модели его
убирает временный список AUTHORING_DEFERRED_ASPECTS (нет attach_*, нет строки индекса) —
снимает срез 2. Правила каталога Б-2: «Главнее, чем» только у шаблона; самоссылка — отказ.
registry_ref получил сквозной cardinality; значения списком проверяются на существование.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- packages/shared/src apps/server/src apps/server/test scripts/probe-p4.ts scripts/probe-p4.test.ts apps/web/src/lib/registry
```
  **Прод-заметка (в `progress.md`):** строка `orbis/template_for` не разбирается старым кодом (Ф-1а-2) — окно
  «пересев → деплой» в задаче 19 даёт простой (РП-2).

### Задача 5: Выбор шаблона — чистые функции `@orbis/shared` (С1а-3)

**Зачем:** спека §4.2 — одна чистая функция, которую зовёт любой клиент: своё тело | шаблон | шаблон хоста, при
споре — список спорящих; §4.3 — запись выбора владельца одной пачкой (победитель получает спорящих в «Главнее, чем»,
у них победитель вычёркивается). Логика неочевидна (ничьи, противоречия, новый участник, сломанный шаблон), поэтому
живёт отдельно от экрана и закрыта таблицей случаев.

**Файлы:**
- Создать: `packages/shared/src/pages/choose-template.ts`, `packages/shared/src/pages/choose-template.test.ts`.
- Изменить: `packages/shared/src/index.ts` (экспорт — модуль лёгкий, без зависимостей).

**Интерфейсы:**
- Consumes: `PAGE_ASPECT`, `TEMPLATE_FOR_PROPERTY`, `TEMPLATE_WINS_OVER_PROPERTY` (задача 4).
- Produces (для задач 14, 15):
```ts
export interface TemplateCandidate {
  id: string;
  forAspects: readonly string[];   // S(t) — значение «Шаблон для»
  winsOver: readonly string[];     // значение «Главнее, чем»
  createdAt: string;               // ISO
}
export interface ChoiceSubject { aspects: readonly string[] }
export interface BrokenTemplate { id: string; reason: string }
export type TemplateChoice =
  | { kind: 'own-body' }
  | { kind: 'template'; id: string; dispute: readonly string[] | null; broken: readonly BrokenTemplate[] }
  | { kind: 'host'; broken: readonly BrokenTemplate[] };
/** Строки entity.query (aspect=orbis/page, has=orbis/template_for) → кандидаты; пустой набор — не шаблон. */
export function templatesFromRows(rows: readonly { id: string; props: Record<string, unknown>; createdAt: string }[]): TemplateCandidate[];
/** §4.2 шаги 1–7; шаг 8 (базовый вид) — забота рендерера, когда не отрисовался шаблон хоста. */
export function chooseTemplate(
  subject: ChoiceSubject,
  templates: readonly TemplateCandidate[],
  isBroken: (id: string) => string | null,
): TemplateChoice;
/** M — спорящие по наибольшему набору (после исключения сломанных), если их больше одного; иначе null. */
export function contendersOf(subject: ChoiceSubject, templates: readonly TemplateCandidate[], brokenIds?: ReadonlySet<string>): readonly string[] | null;
/** §4.3: новые значения «Главнее, чем» для победителя и спорящих; id вне `templates` вычищаются (РП-21). */
export function recordDisputeChoice(winner: string, contenders: readonly string[], templates: readonly TemplateCandidate[]): ReadonlyMap<string, string[]>;
```

- [ ] **Шаг 1: красная таблица случаев.** `choose-template.test.ts`, `describe('§4.2–4.3: таблица случаев С1а-3')`,
  кандидаты — фабрикой `t(id, forAspects, winsOver = [], createdAt = '2026-09-01T00:00:00Z')`:

  | случай | вход | ожидание |
  |---|---|---|
  | страница | `aspects: ['orbis/page','orbis/project']` | `own-body` |
  | нет подходящих | шаблон для `project`, запись `task` | `host`, `broken: []` |
  | один | шаблон `project`, запись `project+task` | `template` `A`, `dispute: null` |
  | больший набор | `A{project}`, `B{project,task}`, запись `project+task` | `B` |
  | ничья без выбора | `A{project}` (раньше), `B{task}` (позже), запись `project+task` | `A` (раньше создан), `dispute: ['A','B']` |
  | ничья с равной датой | `A`,`B` одна дата | меньший `id`, `dispute` |
  | ничья с выбором | `B.winsOver=['A']` | `B`, `dispute: null` |
  | новый участник | `B.winsOver=['A']`, плюс `C{task}` | раньше созданный из `A,B,C`, `dispute: ['A','B','C']` |
  | противоречие | `A.winsOver=['B']`, `B.winsOver=['A']` | детерминированный, `dispute` |
  | самоссылка игнорируется | `B.winsOver=['B','A']` | `B` |
  | сломанный | `B{project,task}` сломан, `A{project}` цел | `A`, `broken: [{id:'B', reason}]` |
  | все сломаны | единственный подходящий сломан | `host`, `broken` непуст |
  | пустой набор | кандидат с `forAspects: []` | не участвует |

  Плюс `recordDisputeChoice`: `('B', ['A','B','C'], …)` → `B.winsOver ⊇ {A, C}`, у `A` и `C` из `winsOver` убран `B`;
  id архивного шаблона (нет в `templates`) из `B.winsOver` вычищен (Фокус ревью п. 4); повторный выбор того же
  победителя идемпотентен. `templatesFromRows`: строка без `orbis/template_for` или с `[]` пропускается.
  Прогон `cd $W/packages/shared && bun test src/pages/choose-template.test.ts > …/t5.log 2>&1` → FAIL.

- [ ] **Шаг 2: реализация.**
```ts
const subset = (s: readonly string[], of: readonly string[]) => s.every((a) => of.includes(a));
const earliest = (a: TemplateCandidate, b: TemplateCandidate) =>
  a.createdAt < b.createdAt || (a.createdAt === b.createdAt && a.id < b.id) ? a : b;

function largest(subject: ChoiceSubject, templates: readonly TemplateCandidate[], broken: ReadonlySet<string>) {
  const fit = templates.filter((t) => t.forAspects.length > 0 && !broken.has(t.id) && subset(t.forAspects, subject.aspects));
  const max = Math.max(0, ...fit.map((t) => t.forAspects.length));
  return fit.filter((t) => t.forAspects.length === max);
}

/** Шаг 5: w покрывает всех прочих из M своим «Главнее, чем», и никто из M не объявлен главнее w. */
function winnerOf(m: readonly TemplateCandidate[]): TemplateCandidate | null {
  for (const w of m) {
    const others = m.filter((x) => x.id !== w.id);
    const covers = others.every((x) => w.winsOver.includes(x.id));
    const beaten = others.some((x) => x.winsOver.includes(w.id));
    if (covers && !beaten) return w;
  }
  return null;
}

export function chooseTemplate(subject, templates, isBroken): TemplateChoice {
  if (subject.aspects.includes(PAGE_ASPECT)) return { kind: 'own-body' };
  const broken: BrokenTemplate[] = [];
  const brokenIds = new Set<string>();
  for (;;) {
    const m = largest(subject, templates, brokenIds);
    if (m.length === 0) return { kind: 'host', broken };
    const w = m.length === 1 ? m[0] : winnerOf(m);
    const pick = w ?? m.reduce(earliest);
    const reason = isBroken(pick.id);
    if (reason === null) {
      return { kind: 'template', id: pick.id, dispute: w === null ? m.map((t) => t.id).sort() : null, broken };
    }
    broken.push({ id: pick.id, reason });
    brokenIds.add(pick.id); // шаг 7: исключить и выбрать заново с шага 2
  }
}
```
  Самоссылка: `winsOver` кандидата фильтруется от собственного id в `templatesFromRows` (правило §3.2 её и так
  запрещает — это защита от данных, внесённых до правила). `recordDisputeChoice`: `live = new Set(templates.map(id))`;
  победитель — `(winsOver ∪ contenders∖{winner}) ∩ live`, каждый спорящий — `winsOver ∖ {winner}` ∩ `live`; в карту
  попадают только изменившиеся. Прогон шага 1 → PASS.

- [ ] **Шаг 3: мутации.** (а) в `winnerOf` убрать условие `beaten` → красное «противоречие»; (б) в `largest` убрать
  `!broken.has` → бесконечный цикл ловится тестом «все сломаны» (тест с таймаутом 1 с); (в) `recordDisputeChoice` без
  `∩ live` → красный «архивный вычищен». Откатить.

- [ ] **Шаг 4: коммит.**
```
cd /Users/birzhan/projects/orbis/.claude/worktrees/pages-slice-1a && git add packages/shared/src/pages
cd /Users/birzhan/projects/orbis/.claude/worktrees/pages-slice-1a && bun run test > /private/tmp/claude-501/pages-1a/t5-full.log 2>&1; echo EXIT=$? && bun run lint > …/t5-lint.log 2>&1; echo EXIT=$? && bun run typecheck > …/t5-tsc.log 2>&1; echo EXIT=$?
cd /Users/birzhan/projects/orbis/.claude/worktrees/pages-slice-1a && git commit -m "feat(shared): выбор шаблона записи и запись выбора в споре — чистые функции (§4.2–4.3, С1а-3)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- packages/shared/src/pages packages/shared/src/index.ts
```

### Задача 6: Проекция блока данных в Q-AST и проверка абсолютных дат

**Зачем:** спека §5.4 — настройки показа живут в проекции запроса канона: `display` (+`tile`), `aggregate`,
`columns`, `hide_empty`. Формы спеки грамматика не принимает (Ф-1а-8) — план берёт формы в стиле существующей
грамматики (РП-4, эррата Э-2). §5.6 — абсолютная дата в блоке данных страницы или шаблона — ошибка с подсказкой;
нужна функция обхода фильтра (`absoluteDateIn`). JSON Schema Q-AST вшита в `orbis/progress_source` и в схему тула
`entity_query` (Ф-1а-9) — расширение даёт дрейф (пересев) и пересдачу эталона тулов по схеме.

**Файлы:**
- Изменить: `packages/shared/src/query/ast.ts:59` (`QUERY_DISPLAY_MODES` + `'tile'`), `:216-222` (поля `QueryAst`),
  `:394-404` (zod), `packages/shared/src/query/ast-json-schema.ts:43-50`, `packages/shared/src/query/parse-ast.ts`
  (`RESERVED_WORDS` `:367-387`, `NOT_NEGATABLE` `:960-968`, `assignOnce` `:754-765`, `dispatch` `:1106-1150`),
  `packages/shared/src/query/print.ts:313-319`, `packages/shared/src/query/static.ts:85`, `packages/shared/src/query/ast-fixtures.ts`.
- Создать: `packages/shared/src/query/dates.ts`, `packages/shared/src/query/dates.test.ts`.
- Тесты: `query/parse-ast.test.ts`, `query/print.test.ts`, `query/static.test.ts`, `query/ast.test.ts`,
  `doc/convert.test.ts` (сбор `query_refs` по `field`); server — `test/golden/tool-registry.json` (схема
  `entity_query`), `src/tools/registry-golden.test.ts` (перепрогон), `test/seed-registries.test.ts` (дрейф строки
  `orbis/progress_source` после пересева).

**Интерфейсы:**
- Consumes: `parseQueryAst(text, reg: ParseRegistry)` → `{ok:true, ast} | {ok:false, error:{code, message, position?}}`,
  коды `QUERY_PARSE_CODES` (`parse-ast.ts:129-141`); `printQueryAst(ast, reg)` (`print.ts`).
- Produces (для задач 9, 10, 11):
```ts
// query/ast.ts
export const QUERY_DISPLAY_MODES = ['compact', 'list', 'table', 'tile'] as const;
export const QUERY_AGGREGATE_FNS = ['count', 'sum', 'latest'] as const;
export type QueryAggregate = { fn: 'count' } | { fn: 'sum' | 'latest'; field: string };
export interface QueryAst {
  filter: QueryNode; sortBy?: …; limit?: number; display?: QueryDisplayMode; title?: string;
  aggregate?: QueryAggregate;       // только при display=tile, при tile — обязателен
  columns?: { field: string }[];    // только при display=table
  hideEmpty?: true;
}
// query/dates.ts
/** Первая абсолютная дата/момент в фильтре (свойства date|timestamp, включая core created_at/updated_at). */
export function absoluteDateIn(ast: QueryAst, reg: ParseRegistry): { prop: string; value: string } | null;
export const RELATIVE_DATE_TOKENS: readonly ['today', 'overdue', 'next_7d', 'after_7d'];
```
  Текстовые формы: `display=tile`, `aggregate=count`, `aggregate=sum:orbis/amount`, `aggregate=latest:orbis/weight`,
  `columns=orbis/due_date|orbis/priority`, голое слово `hide_empty`. Печать проекции — в порядке `sortBy, limit,
  display, columns, aggregate, hide_empty, title`.

- [ ] **Шаг 1: красные тесты разбора и печати.** `parse-ast.test.ts`: четыре примера спеки §5.4 в формах РП-4
  разбираются в ожидаемые деревья; отказы — `aggregate` без `display=tile` → `SYNTAX` «aggregate — только у
  display=tile»; `display=tile` без `aggregate` → `SYNTAX`; `columns` без `display=table` → `SYNTAX`;
  `aggregate=sum:orbis/title` (не число) → `TYPE` с позицией (та же проверка типа, что сервер делает `numericRef`
  `compile-ast.ts:914-923`: только `number|decimal`, не список, не core); повтор `hide_empty` → `SYNTAX`
  (`assignOnce`); `columns=[a, b]` → отказ с подсказкой «списки через |» (Э-2). `print.test.ts`: круг
  «разбор → печать → разбор» по новым формам и по корпусу `ast-fixtures.ts` (новые записи в корпус — по одной на
  форму). `static.test.ts`: `aggregate`/`columns`/`hideEmpty` — ключи проекции (статичны). `convert.test.ts`:
  блок `{{query:aspect=orbis/financial, display=tile, aggregate=sum:orbis/amount}}` → `query_refs` содержит
  `orbis/amount` (ключ `field` — `convert.ts:601-606`). Прогон
  `cd $W/packages/shared && bun test src/query/ src/doc/convert.test.ts > …/t6a.log 2>&1` → FAIL.

- [ ] **Шаг 2: реализация.** `ast.ts` — типы и zod (`.strict()`, `aggregate` — дискриминированный союз по `fn`);
  `ast-json-schema.ts` — те же поля; `parse-ast.ts` — `case 'aggregate'` (значение `count` | `sum:<имя>` |
  `latest:<имя>`, имя свойства резолвится тем же путём, что `sortBy`), `case 'columns'` (через `|`, как `parseTags`
  `:792-801`), голое `hide_empty` — ветка до `default` у токена без оператора; пост-проверки согласованности —
  после разбора всех ключей; `print.ts` — хвост проекции в порядке РП-4; `static.ts:85` — новые ключи.
  Прогон шага 1 → PASS.

- [ ] **Шаг 3: `absoluteDateIn`.** `dates.test.ts`: `orbis/due_date=today` → null; `orbis/due_date<=2026-01-01` →
  `{prop:'orbis/due_date', value:'2026-01-01'}`; диапазон `created_at=2026-06-01..2026-06-30` → первая граница;
  `in` со смесью токена и даты → дата; `or/not` обходятся; `has=orbis/due_date` — не дата; свойство `text` со
  значением, похожим на дату, — не дата. Реализация — обход по образцу `hasDateToken` (`static.ts:36-77`), тип
  свойства — по `reg.properties`. Прогон `cd $W/packages/shared && bun test src/query/dates.test.ts > …/t6b.log 2>&1` → PASS.

- [ ] **Шаг 4: каскад на сервер.** Пересев `cd $W && bun run db:prepare > …/t6prep.log 2>&1` (строка
  `orbis/progress_source` несёт новую схему). Эталон тулов: перепрогнать `cd $W/apps/server && bun test
  src/tools/registry-golden.test.ts > …/t6g.log 2>&1`, убедиться, что отличаются ТОЛЬКО схемы, включающие Q-AST:
  вход `ast` у `entity_query`, `attach_orbis_goal` (через `progress_source`), `scope` у `property_create`/`property_update`
  (`tools/registry-tools.ts:149,181`); число тулов 51;
  пересдать `test/golden/tool-registry.json` отдельным движением (`bunx biome check --write` по файлу). Проверить,
  что сервер исполняет запрос с новыми ключами проекции как обычный (компилятор их игнорирует — `entity.query` с
  `display=tile, aggregate=count` отдаёт строки): тест в `src/routers/entity.test.ts`. Цель, чей
  `progress_source.query` несёт вложенный `aggregate` проекции, считает прогресс по ВНЕШНЕМУ `aggregate` (вложенный
  игнорируется) — тест в `goals/progress.test.ts`.

- [ ] **Шаг 5: мутации.** (а) снять пост-проверку «aggregate только при tile» → красный отказ; (б) в
  `absoluteDateIn` пропустить `range` → красный тест диапазона. Откатить.

- [ ] **Шаг 6: коммит.**
```
cd /Users/birzhan/projects/orbis/.claude/worktrees/pages-slice-1a && git add packages/shared/src/query/dates.ts packages/shared/src/query/dates.test.ts
cd /Users/birzhan/projects/orbis/.claude/worktrees/pages-slice-1a && bun run test > /private/tmp/claude-501/pages-1a/t6-full.log 2>&1; echo EXIT=$? && bun run lint > …/t6-lint.log 2>&1; echo EXIT=$? && bun run typecheck > …/t6-tsc.log 2>&1; echo EXIT=$?
cd /Users/birzhan/projects/orbis/.claude/worktrees/pages-slice-1a && git commit -m "feat(query): проекция блока данных — tile, aggregate, columns, hide_empty; поиск абсолютных дат (§5.4, §5.6)

Формы спеки [a, b] и sum(x) грамматика не принимает (разделитель — запятая и пробел,
скобок нет) — взяты формы в её стиле: columns=a|b, aggregate=sum:x (РП-4, эррата Э-2).
Схема Q-AST вшита в orbis/progress_source и entity_query — пересев и эталон тулов (схема).

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- packages/shared/src/query packages/shared/src/doc/convert.test.ts apps/server/test/golden/tool-registry.json apps/server/src/routers/entity.test.ts apps/server/test/seed-registries.test.ts
```

### Задача 7: Листовой препроход грамматики тела v3 (`@orbis/shared/doc/page-grammar`)

**Зачем:** спека §5.2–§5.3, §5.7–§5.8 — контейнеры с открытием и закрытием, блоки обвязки, незнакомые формы
остаются текстом, ни одна ошибка не теряет текст. Блочный токенайзер `marked` здесь негоден (Ф-1а-7): ленивое
продолжение утаскивает маркер в список, откат в raw забирает весь контейнер. Решение — препроход по строкам (РП-6):
маркер — целая строка с колонки 0 вне заборов кода; модуль листовой (без tiptap и marked), поэтому его же читают
`parseBody`, первый кадр редактора и рендерер экрана записи без ребра `DetailScreen → doc`. Задача чисто
функциональная: узлов схемы и версии формата она не трогает (задача 8).

**Файлы:**
- Создать: `packages/shared/src/doc/page-grammar.ts`, `packages/shared/src/doc/page-grammar.test.ts`.
- Изменить: `packages/shared/package.json` (`exports`: `"./doc/page-grammar": "./src/doc/page-grammar.ts"`).

**Интерфейсы:**
- Consumes: ничего (листовой модуль; разрешён импорт только `zod`-свободных констант своего файла).
- Produces (для задач 8, 9, 11, 13, 14):
```ts
export const RECORD_BLOCK_NAMES = ['title', 'tags', 'body', 'cards', 'subtasks', 'blockers', 'backlinks', 'versions', 'thread'] as const;
export type RecordBlockName = (typeof RECORD_BLOCK_NAMES)[number];
export const GRAMMAR_ERROR_CODES = ['CONTAINER_UNCLOSED', 'PART_UNCLOSED', 'TEXT_OUTSIDE_PART', 'DEPTH_EXCEEDED',
  'PART_COUNT', 'PART_OUTSIDE_CONTAINER', 'CLOSE_WITHOUT_OPEN'] as const;
export type GrammarErrorCode = (typeof GRAMMAR_ERROR_CODES)[number];
export const CONTAINER_LIMITS = { columns: { min: 2, max: 4 }, tabs: { min: 1, max: 8 }, depth: 2 } as const;
export type PageNode =
  | { kind: 'text'; text: string }                                   // кусок markdown дословно
  | { kind: 'query'; text: string; raw: string }                     // {{query:…}}, возможно многострочный
  | { kind: 'record'; name: RecordBlockName; raw: string }
  | { kind: 'card'; aspect: string; raw: string }                    // ключ или «подпись в кавычках» как написано
  | { kind: 'columns'; parts: PageNode[][]; raw: string }
  | { kind: 'tabs'; parts: { label: string; children: PageNode[] }[]; raw: string }
  | { kind: 'broken'; code: GrammarErrorCode; message: string; raw: string };
export function parsePageText(text: string): PageNode[];
/** Сообщения ошибок §5.8 по-русски — для плашек. */
export const GRAMMAR_ERROR_MESSAGES: Record<GrammarErrorCode, string>;
```

- [ ] **Шаг 1: красные тесты.** `page-grammar.test.ts`:
  - контейнеры §5.2 (оба примера спеки) → дерево `columns` с двумя частями, `tabs` с подписями «Запись», «Тред»;
  - вложенность: `tabs` внутри `column` — законно; третий уровень → `broken DEPTH_EXCEEDED`, `raw` — дословная
    подстрока исходника от открытия до закрытия внешнего;
  - незакрытый `{{columns}}` до конца тела → `broken CONTAINER_UNCLOSED`, `raw` = хвост дословно; незакрытая часть →
    `PART_UNCLOSED`; текст вне части внутри контейнера → `TEXT_OUTSIDE_PART`; `{{column}}` вне `{{columns}}` →
    `PART_OUTSIDE_CONTAINER`; `{{/tabs}}` без открытия → `CLOSE_WITHOUT_OPEN`; 1 колонка или 5 колонок, 0 или 9
    вкладок → `PART_COUNT`;
  - блоки обвязки: все девять имён + `{{card: orbis/goal}}` + `{{card: "Цель"}}`;
  - `{{tab}}` прямо внутри `{{columns}}` (без `{{tabs}}`) → `PART_OUTSIDE_CONTAINER`; `{{tabs}}` внутри `{{column}}` —
    законно; подпись только у открывающего `{{tab: …}}`: `{{columns: x}}`, `{{/tab: x}}`, `{{column: x}}` — текст;
  - текстом остаются: `x {{title}} y`, `{{finance/ring}}`, `{{unknown}}`, маркер с отступом (`  {{title}}`);
  - заборы кода: маркеры внутри ```` ``` ```` и `~~~` (длина ≥ 3, отступ ≤ 3, закрытие тем же символом не короче) —
    текст; незакрытый забор до конца тела — всё текст (Фокус ревью п. 2);
  - `\r\n` и хвостовые пробелы у маркера (`{{tab: Тред}}  `) — маркер узнан; склейка `text`/`raw` всех узлов
    верхнего уровня воспроизводит вход байт-в-байт (Фокус ревью п. 1);
  - многострочный `{{query:\naspect=orbis/task\n}}` — один узел `query`; `{{query:` без `}}` — текст (как сегодня
    `bodySegments`).
  Прогон `cd $W/packages/shared && bun test src/doc/page-grammar.test.ts > …/t7.log 2>&1` → FAIL.

- [ ] **Шаг 2: реализация.** Сканер строк с состоянием забора; стек открытых контейнеров и частей; маркеры —
  `^\{\{(\/?)(columns|column|tabs|tab)\}\}[ \t]*$` и `^\{\{tab:\s*(.+?)\}\}[ \t]*$` (подпись — только у открывающего
  `tab`) по строке без `\r`; атомы —
  `^\{\{(title|tags|body|cards|subtasks|blockers|backlinks|versions|thread)\}\}[ \t]*$` и
  `^\{\{card:\s*(.+?)\}\}[ \t]*$`; `{{query:` — от начала строки до первого `}}` (как `query-block.ts:59-65`). Ошибка
  внутри контейнера превращает в `broken` весь внешний контейнер с дословным `raw` (текст не теряется, соседи вне
  контейнера целы). Докблок модуля: почему препроход, а не токенайзер `marked` (Ф-1а-7), и правило «одна копия
  правил маркеров» (РП-6). Прогон шага 1 → PASS.

- [ ] **Шаг 3: лёгкость модуля.** Тест: исходник `page-grammar.ts` не импортирует ничего, кроме относительных
  констант (грепом по `import` в тесте). `package.json` — сабпат; `cd $W/packages/shared && bun run typecheck >
  …/t7tsc.log 2>&1` → 0.

- [ ] **Шаг 4: мутация.** Убрать учёт заборов → красные тесты заборов; убрать ограничение глубины → красный
  `DEPTH_EXCEEDED`. Откатить.

- [ ] **Шаг 5: коммит.**
```
cd /Users/birzhan/projects/orbis/.claude/worktrees/pages-slice-1a && git add packages/shared/src/doc/page-grammar.ts packages/shared/src/doc/page-grammar.test.ts
cd /Users/birzhan/projects/orbis/.claude/worktrees/pages-slice-1a && bun run test > /private/tmp/claude-501/pages-1a/t7-full.log 2>&1; echo EXIT=$? && bun run lint > …/t7-lint.log 2>&1; echo EXIT=$? && bun run typecheck > …/t7-tsc.log 2>&1; echo EXIT=$?
cd /Users/birzhan/projects/orbis/.claude/worktrees/pages-slice-1a && git commit -m "feat(doc): листовой препроход грамматики тела v3 — контейнеры, блоки обвязки, ошибки без потери текста

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- packages/shared/src/doc/page-grammar.ts packages/shared/src/doc/page-grammar.test.ts packages/shared/package.json
```

### Задача 8: Формат тела v3 по всему стеку — узлы, разбор и печать, версия, дифф, операция корпуса

**Зачем:** спека §5.1, §5.9 — новые конструкции становятся узлами дерева документа (`body_doc` — правда, `body` —
его печать), `DOC_SCHEMA_VERSION` 2 → 3 без смены узлов у старых тел, дифф Ш1 видит контейнеры единицами, копии
правил синхронны, версия клиента поднимается (§14), корпус считается до прода. Всё — одним мержем: половина формата
(схема без гейта, гейт без черновиков) ломала бы запись тела. Разведка: `upgradeBodyDoc` умеет только v1 (Ф-1а-6);
абзац с текстом маркера при повторном разборе становится блоком (Ф-1а-11); `ops.ts` корпус под §5.9 не считает
(Ф-1а-22).

**Файлы:**
- shared, создать: `doc/nodes/layout.ts` (`columns`, `column`, `tabs`, `tab{label}`), `doc/nodes/record-blocks.ts`
  (`recordBlock{name}`, `aspectCard{aspect, text}`).
- shared, изменить: `doc/types.ts:14` (`DOC_SCHEMA_VERSION = 3`), `:36-57` (`KNOWN_NODE_TYPES` + 6), `:100-122`
  (`upgradeBodyDoc` — цепочка); `doc/schema.ts:36-53` (`DOC_EXTENSIONS` + 6); `doc/convert.ts:350-391` (`parseBody`
  поверх `parsePageText`), `:410-433` (`projectionKeepsEverything`/`collectText` для атомов); `doc/manager.ts:17-37`
  (экранирование `\{`); `doc/bind-query.ts:101-116` (привязка `aspectCard`); `doc/diff.ts:148-188,243-255,298-351`;
  `doc/index.ts`; `constants.ts:5` (`MIN_COMPATIBLE_CLIENT_VERSION = '0.3.0'`).
- shared, тесты: `doc/convert.test.ts`, `doc/schema.test.ts`, `doc/bind-query.test.ts:275,307`, `doc/diff.test.ts`.
- server: `src/executor/body-doc.test.ts` (гейт версии и чтение `readEntity` — там же живут его тесты), `src/routers/version.test.ts`
  (восстановление v2-версии), `src/db/census-v3.ts` + `src/db/census-v3.test.ts` (создать), `scripts/ops.ts` (операция
  `census-v3` в `OPS` `:673-716`, help), `src/context.test.ts:158-159`, `src/router.test.ts:152-153`.
- web: `apps/web/src/features/entity-editor/strip-ids.ts:22-29,63-73` (+ тест таблиц в `editor.test.tsx`),
  `apps/web/src/features/entity-editor/useBodySave.ts:194-207` (цепочка через `upgradeBodyDoc` — тест черновика v2),
  `apps/web/src/app/version.ts:2` (`APP_VERSION = '0.3.0'`), `apps/web/src/trpc.test.tsx:21,24`,
  `scripts/client-version.test.ts:23-24` (минимум ≥ 0.3.0).

**Интерфейсы:**
- Consumes: `parsePageText`, `PageNode`, `RECORD_BLOCK_NAMES` (задача 7); `bindQueryBlocks(doc, reg)`
  (`doc/bind-query.ts`); `describeRoleAccess` (`apps/server/src/db/backfill-body-doc.ts:169`), образец порционного цикла —
  `apps/server/src/db/audit-bodies.ts`.
- Produces (для задач 9, 11, 13, 16):
```ts
// doc/nodes/layout.ts, doc/nodes/record-blocks.ts — узлы схемы. columns, tabs, recordBlock, aspectCard — group 'block';
// column — group 'column', tab — group 'tab' (РП-28: часть вне контейнера схема отвергает)
// columns: content 'column+'; column: content 'block+'; tabs: content 'tab+'; tab: attrs {label: string}, content 'block+'
// recordBlock: atom, attrs {name: RecordBlockName}; aspectCard: atom, attrs {aspect: string | null, text: string}
// Инвариант aspectCard как у queryBlock: aspect !== null ⇒ text = key аспекта; aspect === null ⇒ text как написан.
export const DOC_SCHEMA_VERSION = 3;
// upgradeBodyDoc — сигнатура НЕ меняется (`doc/types.ts:100`); поведение: v1 → v2 → v3; v3 как есть; прочее — null
// apps/server/src/db/census-v3.ts
export interface CensusV3Result {
  total: number; withoutDoc: number;
  becomeBlocks: number;        // тела, где v3 даёт record/card/columns/tabs, а v2 — абзац
  brokenMarkers: number;       // тела с broken-узлом препрохода (текст цел, на экране — плашка)
  displayTable: number; displayList: number;
  ids: { becomeBlocks: string[]; displayTable: string[]; displayList: string[] }; // не больше 50 на список
}
export async function censusV3(io: { selectBatch(limit: number, afterId: string): Promise<{ id: string; body: string | null; bodyDocNull: boolean }[]> }): Promise<CensusV3Result>;
```
  Канон печати контейнера (закрепляется тестом): маркер — отдельной строкой; дети части разделены пустой строкой;
  между маркером и первым/последним ребёнком пустой строки нет:
```
{{columns}}
{{column}}
текст

{{query:aspect=orbis/task}}
{{/column}}
{{column}}
…
{{/column}}
{{/columns}}
```

- [ ] **Шаг 1: красные тесты shared.** `convert.test.ts`, новый `describe('грамматика v3: разбор → печать → разбор')`:
  круг без потерь для каждой конструкции §5.2–§5.3 и шаблона хоста §8.1 целиком (С1а-1); `broken`-узел препрохода
  → `rawBlock` с дословным текстом, печать возвращает его байт-в-байт; абзац, чей текст — `{{title}}` (например,
  пришёл вставкой в редактор), печатается с экранированием и при повторном разборе остаётся абзацем (Ф-1а-11);
  ссылка `[[entity:…]]` внутри колонки попадает в `bodyRefsFromDoc`, блок запроса внутри вкладки — в
  `queryRefsFromDoc`. `schema.test.ts` — растёт сам (`KNOWN_NODE_TYPES` ⇔ схема); плюс «часть вне контейнера схема отвергает»: документ с
  `column` или `tab` прямо в `doc` → `bodyDocError` не null (РП-28). `bind-query.test.ts`:
  `{{card: orbis/goal}}` → `aspect:'orbis/goal', text:'orbis/goal'`; `{{card: "Цель"}}` → привязка по подписи, печать —
  ключом; незнакомый аспект → `aspect:null`, текст как написан; `upgradeBodyDoc({v:2, doc})` → `{v:3, doc}` тем же
  объектом `doc` (id блоков целы), `v:1` → v3 через `queryAttrsV1ToV2`, `v:4`/мусор → `null` (пины `:275,307`).
  `diff.test.ts`: правка текста в одной колонке — одна единица изменений, соседняя колонка не задета; переименование
  вкладки видно единицей-заголовком; `{{card: orbis/goal}}` → `{{card: orbis/task}}` — одна единица.
  Прогон `cd $W/packages/shared && bun test src/doc/ > …/t8a.log 2>&1` → FAIL.

- [ ] **Шаг 2: узлы и разбор.** Узлы по «Интерфейсам» (группы `column`/`tab` у частей — РП-28) с `renderHTML` (`div[data-columns]` и т. п.) и
  `renderMarkdown` по канону печати; `parseBody`: `parsePageText(md)` → узлы; текстовые куски — прежним потокенным
  путём (`convert.ts:358-384`) внутри куска; `query` → `{type:'queryBlock', attrs:{ast:null, text}}`; `record` →
  `recordBlock`; `card` → `aspectCard{aspect:null, text}`; контейнеры — рекурсивно (пустая часть → пустой абзац);
  `broken` → `rawBlock{markdown: raw}`. `KNOWN_NODE_TYPES`, `DOC_EXTENSIONS`, `collectText` атомов = их печатная
  форма (иначе `projectionKeepsEverything` уведёт тело в raw — `recon-plan-1` П-док). `manager.ts`: в начале каждой
  строки текстового узла `{{<имя из RECORD_BLOCK_NAMES|columns|column|tabs|tab|card|query>` экранируется `\{{`
  (законное экранирование CommonMark). `bind-query.ts`: обход дописывает привязку `aspectCard` по реестру аспектов
  (ключ или подпись в кавычках) — образец `bindAttrs` `:66-94`. `upgradeBodyDoc`: `v===3` → как есть; `v===2` →
  `{v:3, doc}`; `v===1` → `queryAttrsV1ToV2` → штамп 3. `diff.ts`: `columns`, `column`, `tabs` — в
  `TRANSPARENT_KINDS`; `tab` — прозрачный с псевдо-единицей заголовка (ключ `label`); `KEY_ATTRS`: `aspectCard:
  ['aspect']`, `recordBlock: ['name']`. Прогон шага 1 → PASS.

- [ ] **Шаг 3: красные тесты сервера.** (а) гейт записи: `entity.update` с `bodyDoc {v:2}` → `VALIDATION`
  «…перезагрузите приложение…» (`executor.ts:2384-2390`, текст не менять) — Фокус ревью п. 5; `bodyDoc {v:3}` с
  колонками и вкладками → ok, `body` = канон печати; (б) путь модели: `body` markdown с контейнерами → `body_doc`
  с узлами `columns/tabs`; (в) `readEntity` с хранимым v2-документом → v3, `UniqueID` блоков сохранены
  (`entity-read.ts:159`); (г) `version.restore` закреплённой v2-версии → ok (`routers/version.ts:40-43`);
  (д) `census-v3.test.ts` без БД: корпус из пяти тел (обычная заметка; тело с `{{title}}` строкой; с контейнером; с
  незакрытым контейнером; с `display=table` и с `display=list`) → счётчики и id по «Интерфейсам»; порционность —
  `selectBatch` вызывается с курсором. Прогон
  `cd $W/apps/server && bun test src/executor/body-doc.test.ts src/routers/version.test.ts src/db/census-v3.test.ts > …/t8b.log 2>&1`
  → FAIL (а, д).

- [ ] **Шаг 4: сервер.** Гейт и пути записи меняются сами (константа версии) — правок кода нет, кроме
  `census-v3.ts` (счёт `parsePageText` — листовой модуль, НЕ регэкспом: многострочный запрос регэксп по строке
  пропустит, `recon-plan-4` T4; `becomeBlocks` — узлы `record|card|columns|tabs` на любой глубине; `display=` — по
  `parseQueryAst`-независимому поиску ключа в тексте блока `query`) и операции `census-v3` в `scripts/ops.ts` по
  образцу `auditBodiesOp` (`:330-414`): печать роли и BYPASSRLS, код 1 без неё, SELECT `id, body, body_doc IS NULL`
  порциями, печать счётчиков и id, тел не печатать. Прогон шага 3 → PASS.

- [ ] **Шаг 5: web и версия клиента.** `strip-ids.ts`: `UNIQUE_ID_TYPES` + `columns`, `column`, `tabs`, `tab`,
  `recordBlock`, `aspectCard`; `NODE_ATTR_DEFAULTS` — `tab.label`, `recordBlock.name`, `aspectCard.aspect/text`
  (двусторонний тест `editor.test.tsx` «таблицы умолчаний strip-ids совпадают со схемой»). `useBodySave.ts`: тест
  «черновик v2 из localStorage перештамповывается в v3 и сохраняется» (контракт `toCurrentSchema` через
  `upgradeBodyDoc`); «черновик v4» → отказ, как сегодня. Версия клиента `0.3.0` — шесть файлов по образцу `5fb73ef` (`ops.ts` из образца к подъёму не относится)
  (`constants.ts:5`, `app/version.ts:2`, `context.test.ts:158-159`, `router.test.ts:152-153`, `trpc.test.tsx:21,24`,
  `scripts/client-version.test.ts:23-24`). Прогон
  `cd $W/apps/web && bun run test src/features/entity-editor/ src/trpc.test.tsx > …/t8c.log 2>&1` и
  `cd $W && bun test scripts/client-version.test.ts > …/t8d.log 2>&1` → PASS.

- [ ] **Шаг 6: мутации.** (а) `upgradeBodyDoc` без ветки v2 → красный (в) и «черновик v2»; (б) `diff.ts` без
  `column` в `TRANSPARENT_KINDS` → красный «соседняя колонка не задета»; (в) снять экранирование в `manager.ts` →
  красный «абзац остаётся абзацем». Откатить.

- [ ] **Шаг 7: полный прогон, вес экрана, коммит.**
```
cd /Users/birzhan/projects/orbis/.claude/worktrees/pages-slice-1a && git add packages/shared/src/doc/nodes/layout.ts packages/shared/src/doc/nodes/record-blocks.ts apps/server/src/db/census-v3.ts apps/server/src/db/census-v3.test.ts
cd /Users/birzhan/projects/orbis/.claude/worktrees/pages-slice-1a && bun run test > /private/tmp/claude-501/pages-1a/t8-full.log 2>&1; echo EXIT=$? && bun run lint > …/t8-lint.log 2>&1; echo EXIT=$? && bun run typecheck > …/t8-tsc.log 2>&1; echo EXIT=$?
cd /Users/birzhan/projects/orbis/.claude/worktrees/pages-slice-1a && bun run --filter @orbis/web build > …/t8-build.log 2>&1 && bun scripts/check-lazy-chunks.ts > …/t8-chunks.log 2>&1; echo EXIT=$?
cd /Users/birzhan/projects/orbis/.claude/worktrees/pages-slice-1a && git commit -m "feat(doc): формат тела v3 — контейнеры и блоки обвязки узлами, подъём v2→v3, дифф Ш1, census-v3, клиент 0.3.0

Разбор тела идёт поверх листового препрохода; ошибки — rawBlock дословно. Подъём
v2→v3 не меняет узлов (цепочка v1→v2→v3 — иначе v2-документы пересобирались бы из body).
Абзац с текстом маркера экранируется при печати. Операция ops census-v3 считает корпус
до прода: станут блоками, display=table/list, без документа.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- packages/shared apps/server/src apps/web/src scripts/ops.ts scripts/client-version.test.ts
```

### Задача 9: Где работают блоки — матрица §5.5 и ошибки §5.8 одной функцией

**Зачем:** спека §5.5 — контейнеры и блоки обвязки только на страницах и в шаблонах, `{{body}}` — только в шаблоне и
не больше одного; §5.6 — абсолютная дата на странице и в шаблоне — ошибка с подсказкой; §5.8 — полный перечень
ошибок; §4.2 шаг 7 — шаблон с ошибкой разбора «не разобран». Это знание нужно рендереру, первому кадру, редактору и
функции выбора шаблона — одна листовая функция над деревом препрохода (разведка: `parseBody` вида записи не знает).

**Файлы:**
- Создать: `packages/shared/src/doc/placement.ts`, `packages/shared/src/doc/placement.test.ts`.
- Изменить: `packages/shared/package.json` (`"./doc/placement": "./src/doc/placement.ts"`).

**Интерфейсы:**
- Consumes: `parsePageText`, `PageNode`, `GRAMMAR_ERROR_MESSAGES` (задача 7); `parseQueryAst`, `ParseRegistry`
  (`@orbis/shared/query`); `absoluteDateIn`, `RELATIVE_DATE_TOKENS` (задача 6).
- Produces (для задач 11, 13, 14, 16):
```ts
export type BodyKind = 'note' | 'page' | 'template';
export type PlacedBlock = 'container' | 'record' | 'body' | 'card' | 'query';
/** Матрица §5.5. */
export function blockAllowedIn(block: PlacedBlock, kind: BodyKind): boolean;
export type PlacementIssueCode = GrammarErrorCode | 'BLOCK_MISPLACED' | 'SECOND_BODY' | 'ABSOLUTE_DATE' | 'QUERY_INVALID';
export interface PlacementIssue { code: PlacementIssueCode; message: string; hint?: string; path: number[] }
/** Все проблемы тела данного вида; path — индексы узла в дереве препрохода. */
export function bodyIssues(nodes: readonly PageNode[], kind: BodyKind, reg: ParseRegistry): PlacementIssue[];
/** §4.2 шаг 7: причина «шаблон не разобран» или null. */
export function templateBrokenReason(text: string, reg: ParseRegistry): string | null;
export const MISPLACED_HINT = 'работает на страницах и в шаблонах — сделать запись страницей?';
```

- [ ] **Шаг 1: красные тесты.** `placement.test.ts`: матрица §5.5 — таблица 5 × 3 значений `blockAllowedIn`
  (С1а-2, половина разбора); `bodyIssues`: `{{title}}` в заметке → `BLOCK_MISPLACED` c `hint = MISPLACED_HINT`; в
  странице — нет; `{{body}}` в странице → `BLOCK_MISPLACED`, два `{{body}}` в шаблоне → `SECOND_BODY` на втором;
  контейнер в заметке → `BLOCK_MISPLACED`; `{{query: aspect=orbis/task, orbis/due_date<=2026-01-01}}` в странице →
  `ABSOLUTE_DATE` c подсказкой, перечисляющей `today, overdue, next_7d, after_7d`, в заметке — нет (С1а-9);
  `{{query: неизвестное=1}}` → `QUERY_INVALID` с сообщением разбора; `broken`-узел → его код и сообщение;
  проблемы внутри частей контейнеров находятся (путь). `templateBrokenReason`: текст §8.1 → `null`; шаблон с
  незакрытым контейнером → сообщение `CONTAINER_UNCLOSED`. Лёгкость: модуль импортирует только `page-grammar`,
  `query`-сабпат и `dates`. Прогон `cd $W/packages/shared && bun test src/doc/placement.test.ts > …/t9.log 2>&1` → FAIL.

- [ ] **Шаг 2: реализация.** Рекурсивный обход с флагом «внутри контейнера» и счётчиком `{{body}}`; для `query`
  — `parseQueryAst(text, reg)`: отказ → `QUERY_INVALID` (сообщение разбора с позицией), успех и `kind !== 'note'` →
  `absoluteDateIn` → `ABSOLUTE_DATE` с подсказкой «замените на относительный токен: today, overdue, next_7d,
  after_7d». Прогон шага 1 → PASS.

- [ ] **Шаг 3: мутация.** Разрешить `record` в `note` → красная матрица; снять проверку дат → красный С1а-9. Откатить.

- [ ] **Шаг 4: коммит.**
```
cd /Users/birzhan/projects/orbis/.claude/worktrees/pages-slice-1a && git add packages/shared/src/doc/placement.ts packages/shared/src/doc/placement.test.ts
cd /Users/birzhan/projects/orbis/.claude/worktrees/pages-slice-1a && bun run test > /private/tmp/claude-501/pages-1a/t9-full.log 2>&1; echo EXIT=$? && bun run lint > …/t9-lint.log 2>&1; echo EXIT=$? && bun run typecheck > …/t9-tsc.log 2>&1; echo EXIT=$?
cd /Users/birzhan/projects/orbis/.claude/worktrees/pages-slice-1a && git commit -m "feat(doc): матрица мест блоков (§5.5), ошибки тела (§5.8) и абсолютные даты (§5.6) — одна листовая функция

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- packages/shared/src/doc/placement.ts packages/shared/src/doc/placement.test.ts packages/shared/package.json
```

### Задача 10: Сервер — пачка данных блоков `entity.blocks` и пачка правок `entity.updateBatch`

**Зачем:** спека §6.3 — сервер исполняет пачку просьб блоков в одной транзакции под идентичностью владельца и отдаёт
по каждому блоку строки / число / ошибку, для списков — «ещё N»; потолок пачки 30. Сегодня N блоков = N процедур и N
транзакций (Ф-1а-15). Спека §4.3 и §8.4 требуют «одна пачка, один Undo» — у web нет процедуры пачки правок, а
`entity.update` не отдаёт `actionId` (Ф-1а-16). Обе ручки — серверный деливерабл с собственными тестами; web —
задачи 11, 14, 15.

**Файлы:**
- shared, создать: `packages/shared/src/contracts/blocks.ts` (вход, ответ, потолки), экспорт в `packages/shared/src/index.ts`.
- server, создать: `apps/server/src/routers/entity-blocks.ts` (`runBlocks`), `apps/server/src/routers/entity-blocks.test.ts`,
  `apps/server/src/routers/entity-update-batch.test.ts`.
- server, изменить: `apps/server/src/routers/entity.ts` (процедуры `blocks`, `updateBatch`), `apps/server/src/query/compile-ast.ts:930-937`
  (`compileSumAst` — различные валюты суммированных записей, РП-20), `apps/server/perf/perf.test.ts:121-329`.

**Интерфейсы:**
- Consumes: `queryContext(tx, graph, thisEntityId)` (`apps/server/src/query/context.ts:63-71`), `parseOrThrow`,
  `normalizeQueryAst`, `materializationWindow`, `materializeInstances` (`recurring/with-materialization.ts:42-72` —
  каркас повторить для множества), `compileQueryAst`/`compileCountAst`/`compileSumAst`/`compileLatestAst`
  (`compile-ast.ts:901-948`), `toWireEntityFromSql` (`routers/entity.ts:327-333`), `withIdentity(db, who, fn)`,
  прецедент SAVEPOINT — `goals/progress.ts:438-462` (`tx.transaction(async (sp) => …)`), `execute(db, {identity,
  actorKind:'owner', source:'ui', batchId, operations})` → `{ok, actionId, results}` (`executor.ts:608-765`),
  `QueryAst.aggregate/display` (задача 6).
- Produces (для задач 11, 14, 15):
```ts
// packages/shared/src/contracts/blocks.ts
export const BLOCKS_BATCH_CAP = 30;          // спека §6.3
export const BLOCK_ROWS_CAP = 500;           // потолок строк сервера (= DEFAULT_LIMIT компилятора)
export const UPDATE_BATCH_CAP = 20;
export const entityBlocksInput = z.object({
  blocks: z.array(z.object({
    key: z.string().min(1).max(200),
    text: z.string().min(1).max(4000),        // текст блока {{query:…}} без обёртки
    thisEntityId: z.string().uuid().optional(),
    limit: z.number().int().min(1).max(BLOCK_ROWS_CAP).optional(), // «ещё N» раскрывает, поднимая limit
  }).strict()).min(1).max(BLOCKS_BATCH_CAP),
}).strict();
export type BlockResult =
  | { ok: true; kind: 'rows'; rows: WireEntity[]; more: number }
  | { ok: true; kind: 'count'; count: number }
  | { ok: true; kind: 'sum'; sum: string; count: number; currencies: string[] }
  | { ok: true; kind: 'latest'; value: string | null }
  | { ok: false; error: { code: string; message: string; position?: number } };
export type EntityBlocksResult = { results: Record<string, BlockResult> };
export const entityUpdateBatchInput = z.object({
  operations: z.array(z.discriminatedUnion('tool', [
    z.object({ tool: z.literal('entity_update'), input: entityUpdateUiInput }),
    z.object({ tool: z.literal('entity_version_pin'), input: z.object({ entity_id: z.string().uuid(), label: z.string().trim().min(1).max(200) }).strict() }),
  ])).min(1).max(UPDATE_BATCH_CAP),
}).strict();
// apps/server/src/routers/entity.ts
//   blocks: protectedProcedure.input(entityBlocksInput).mutation(→ EntityBlocksResult)  // POST (РП-8): вход в URL GET не влезает
//   updateBatch: ownerOnlyProcedure.input(entityUpdateBatchInput).mutation(→ { actionId: string; results: unknown[] })
```
  Правила ответа `blocks`: вид по проекции — `display=tile` → `aggregate` (`count` | `sum` | `latest`), иначе `rows`;
  `rows` — `limit` блока (или `limit` из текста запроса, иначе `BLOCK_ROWS_CAP`), выборка `limit+1`; `more` = 0 без
  переполнения, иначе `compileCountAst − limit` (второй запрос только для переполненного блока). Вход
  `entity_version_pin` — ФОРМА ТУЛА исполнителя `{id?, entity_id, label}` (`executor.ts:452-460`; `prepareVersionPin` —
  `:3245-3320`): операции уходят в `execute` без перекладки (в отличие от `routers/version.ts:52-70`, где `entityId` → `entity_id`).

- [ ] **Шаг 1: красные тесты `blocks`.** `entity-blocks.test.ts` (граф — `await freshGraph()`, вызов —
  `createCallerFactory(appRouter)` с `personal(g)`; мир — 7 задач, 3 из них дети записи-проекта, 2 финансовые записи):
  - три блока (`aspect=orbis/task, limit=5`; `children_of=this` c `thisEntityId`; `aspect=orbis/financial,
    display=tile, aggregate=sum:orbis/amount`) → один вызов, три результата: `rows` 5 и `more: 2`; дети проекта;
    `sum` c `currencies: ['RUB']`;
  - одна транзакция исполнения: счётчик вызовов `db.transaction` через тонкую обёртку `db` в тесте — 1 при запросах без
    окна материализации; с окном (`orbis/due_date=today`) — фаза 1, материализация, одна фаза исполнения;
  - изоляция ошибок (С1а-4): блок с ошибкой разбора (`неизвестное=1`) → `ok:false` с кодом и позицией, соседи целы;
    блок с ошибкой ИСПОЛНЕНИЯ — запись с кривым значением `orbis/amount` (`rawEntityRow` из `test/helpers.ts`, мимо
    валидатора) под `aggregate=sum:orbis/amount` → `ok:false`, соседний блок той же пачки — `ok:true` (SAVEPOINT);
  - `this` вне контекста (`children_of=this` без `thisEntityId`) → `ok:false` (`THIS_OUT_OF_CONTEXT`);
  - потолки: 31 блок → `BAD_REQUEST`; `limit: 1000` → отказ схемы; `text` c `limit=1000` в запросе → кламп до 500;
  - права: чужая запись `thisEntityId` под RLS не видна → пустые строки, а не ошибка чужих данных.
  Прогон `cd $W/apps/server && bun test src/routers/entity-blocks.test.ts > …/t10a.log 2>&1` → FAIL.

- [ ] **Шаг 2: `runBlocks`.** Фаза 1 — ОДНА `withIdentity`: `queryContext` один раз (реестр, таймзона), на каждый
  блок `cctx_i = {...base, thisEntityId_i}`; разбор и компиляция каждого в try/catch (ошибка → результат блока без
  SQL); окна материализации собрать. Нет окон — исполнить все в той же tx; есть — один `materializeInstances` по
  объединению окон (от min `from` до max `to`), затем фаза 2 — одна `withIdentity` на все блоки. Исполнение каждого
  блока — внутри `tx.transaction(sp => …)` (SAVEPOINT), ошибка рантайма → `ok:false` этого блока. Ошибки —
  `{code, message, position?}` по образцу `queryErrorToTRPC` (`routers/entity.ts:56-65`). `compileSumAst` получает
  необязательный параметр свойства валюты (`'orbis/currency'`) и отдаёт `array_agg(DISTINCT …) FILTER (WHERE … IS
  NOT NULL)`; прежние вызывающие (`user_query`, цели) — без параметра, поведение побайтно прежнее (тест эталона SQL
  `test/golden/query-sql.json` не меняется). Докблок процедуры: почему POST (РП-8), почему SAVEPOINT (изоляция
  §6.3), почему материализация между tx (Э-4). Прогон шага 1 → PASS.

- [ ] **Шаг 3: красные тесты `updateBatch`.** `entity-update-batch.test.ts`: (а) две правки двух записей
  (`template_wins_over` у A и B) → один `actionId`; `ai.undo({actionId})` откатывает обе; (б) пачка
  `[entity_version_pin {entity_id: X, label: 'Текст до изменения вида'}, entity_update {id: X, bodyDoc, aspects:
  {attach: ['orbis/page']}}]` → версия закреплена со СТАРЫМ телом, тело заменено, аспект навешан; Undo возвращает тело
  и снимает аспект; закреплённая версия после Undo снята; (в) отказ одной операции (правило
  `page_wins_over_not_self`) → вся пачка отвергнута, изменений нет; (г) 21 операция → `BAD_REQUEST`; (д) не-владелец
  (`actorKind` агента через `identityOfGrant`) → `FORBIDDEN` (`ownerOnlyProcedure`). Прогон
  `cd $W/apps/server && bun test src/routers/entity-update-batch.test.ts > …/t10b.log 2>&1` → FAIL.

- [ ] **Шаг 4: `updateBatch`.** `execute(ctx.db, {identity, actorKind:'owner', source:'ui', batchId: newId(),
  operations}, {sink})`; отказ → `execErrorToTRPC`; успех → `{actionId: r.actionId, results: r.results}`; эскалация
  категорий — как у `update` (`escalateAfterMutation` с теми же операциями). Прогон шага 3 → PASS.

- [ ] **Шаг 5: перф.** `perf/perf.test.ts`: ключ `'entity.blocks:10'` в `BUDGETS_MS` (порог — калибровка × 3 с
  комментарием по правилу `:108-111`), вход — одна константа на сторожа и замер (10 блоков разных видов над засеянным
  графом, `:131-134`), сторож непустоты (каждый блок `ok:true`, строки есть), `measureMedian` в гейте. Прогоны в
  порядке `test:perf:volume` → `test:perf:explain` → `test:perf:graph` ×3 → `test:perf` (каждый отдельным вызовом,
  вывод в файлы); медианы — в отчёт.

- [ ] **Шаг 6: мутации.** (а) убрать SAVEPOINT → красный «ошибка исполнения не валит соседей»; (б) `limit` без
  `+1` → красный `more: 2`; (в) в `updateBatch` не передать `batchId` → красный «один actionId». Откатить.

- [ ] **Шаг 7: коммит.**
```
cd /Users/birzhan/projects/orbis/.claude/worktrees/pages-slice-1a && git add packages/shared/src/contracts/blocks.ts apps/server/src/routers/entity-blocks.ts apps/server/src/routers/entity-blocks.test.ts apps/server/src/routers/entity-update-batch.test.ts
cd /Users/birzhan/projects/orbis/.claude/worktrees/pages-slice-1a && bun run test > /private/tmp/claude-501/pages-1a/t10-full.log 2>&1; echo EXIT=$? && bun run lint > …/t10-lint.log 2>&1; echo EXIT=$? && bun run typecheck > …/t10-tsc.log 2>&1; echo EXIT=$?
cd /Users/birzhan/projects/orbis/.claude/worktrees/pages-slice-1a && git commit -m "feat(server): entity.blocks — пачка данных блоков одной транзакцией; entity.updateBatch — пачка правок с одним Undo

Блоки: ≤30 за вызов, ошибка блока не валит соседей (разбор — до SQL, исполнение — SAVEPOINT),
«ещё N» через limit+1, валюты суммы. POST: тексты блоков в URL GET не помещаются.
Правки: entity_update и entity_version_pin одним execute с batchId — один actionId для Undo.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- packages/shared/src/contracts/blocks.ts packages/shared/src/index.ts apps/server/src/routers apps/server/src/query/compile-ast.ts apps/server/perf/perf.test.ts
```

### Задача 11: Единый механизм данных блоков в web и формы показа

**Зачем:** спека §6.3 — любой блок данных (страница, шаблон, тело заметки, предпросмотр редактора, первый кадр)
получает данные одним способом: «результат моего запроса для этого `this`», одновременные просьбы — одной пачкой;
§5.4, §7.2 — формы показа `compact` (строки открывают запись), `list` (`EntityRow`, статус неактивен), `table`,
`tile`, «ещё N», `hide_empty`; §6.5 — ошибка блока видна плашкой, пустоты вместо ошибки не бывает. Сегодня каждый
блок — свой `entity.query`, первый кадр и редактор шлют разные ключи (`recon-plan-3` W3), `display` не читается. Это единственное
касание заметок (§6.3): редактор как инструмент письма не меняется, меняется путь данных смарт-листа — его держат
переписанные существующие тесты.

**Файлы:**
- Создать: `apps/web/src/lib/query-blocks/batch.tsx` (`QueryBatchProvider`, `useBlockData`), `apps/web/src/lib/query-blocks/batch.test.tsx`,
  `apps/web/src/lib/query-blocks/body-kind.tsx` (`BodyKindProvider`, `useBodyKind`), `apps/web/src/features/page/blocks/{DataBlock,CompactForm,ListForm,TableForm,TileForm,MoreRows,BlockPlaque}.tsx`,
  `apps/web/src/features/page/blocks/forms.test.tsx`.
- Изменить: `apps/web/src/main.tsx:27-49` (провайдер пачки под `QueryClientProvider`), `apps/web/src/test/harness.tsx:149-192`
  (провайдер пачки в обвязке + помощник `blocksReply`), `apps/web/src/lib/query-blocks/QueryBlock.tsx` (тонкая
  обёртка над `DataBlock`), `apps/web/src/features/entity-editor/nodes/QueryWidget.tsx:18-111`,
  `apps/web/src/features/entity-editor/EditorShell.tsx:6,135-163` (первый кадр — `parsePageText`),
  `apps/web/src/features/browser/query.ts:50-97` (снести `bodySegments`/`queryBlocks`; `firstQueryBlock` — через
  `parsePageText`), `apps/web/src/lib/invalidate.ts:53-62`, `apps/web/src/lib/query-blocks/parse.ts:17` (ещё одна копия регэкспа
  маркера — через `parsePageText`), `apps/web/src/features/entity-detail/Blocks.tsx:107-109`,
  `apps/web/src/lib/format.ts:4-27` (деньги с валютой; `CURRENCY_SYMBOL` — из `features/budget/EnvelopeCard.tsx:70-112`),
  `apps/web/src/features/entity-editor/save.test.tsx:1483-1493` (новые эагерные файлы).
- Тесты переписать: `lib/query-blocks/QueryBlock.test.tsx` (18 путей `'entity.query'` → `'entity.blocks'`),
  `features/entity-editor/nodes/query-widget.test.tsx:74,183`, `features/entity-detail/detail.test.tsx:1067-1137,1400`
  (только блоковые ожидания; `entity.query` прогонов, `RefField`, категорий — не трогать), `features/browser/query.test.ts`.

**Интерфейсы:**
- Consumes: `trpc.entity.blocks` (мутация, задача 10), `BlockResult`, `BLOCKS_BATCH_CAP` (`@orbis/shared`);
  `parsePageText`, `PageNode` (`@orbis/shared/doc/page-grammar`, задача 7); `parseQueryAst`, `absoluteDateIn`
  (задача 6); `blockAllowedIn`, `MISPLACED_HINT`, `BodyKind` (`@orbis/shared/doc/placement`, задача 9);
  `EntityRow({entity})` (`features/browser/EntityRow.tsx:39`), `useRowProjection` (`lib/registry/row.ts:44`),
  `displayText(def, value)` (`lib/registry/format.ts:81-92`), `openEntity(id)` (`state/navigation.ts:96-99`),
  `useThisEntityId()` (`lib/query-blocks/this-entity.tsx`).
- Produces (для задач 13, 14, 16):
```ts
// lib/query-blocks/batch.tsx
export function QueryBatchProvider({ children }: { children: ReactNode }): JSX.Element;
/** Ключ кеша блока — ['query-block', text.trim(), thisEntityId ?? null, limit ?? null]: первый кадр и редактор делят его. */
export function useBlockData(text: string, opts?: { limit?: number }): UseQueryResult<BlockResult>;
export const QUERY_BLOCK_KEY = 'query-block';
// lib/query-blocks/body-kind.tsx
export function BodyKindProvider({ kind, children }: { kind: BodyKind; children: ReactNode }): JSX.Element;
export function useBodyKind(): BodyKind; // умолчание 'note'
// features/page/blocks/DataBlock.tsx
export function DataBlock(props: { text: string; onConfigure?: () => void }): JSX.Element | null;
```

- [ ] **Шаг 1: красные тесты механизма.** `batch.test.tsx` (обвязка `renderWithProviders`, ответ `entity.blocks` —
  `blocksReply`): (а) три `DataBlock` в одном рендере → ОДИН вызов `entity.blocks` с тремя элементами (С1а-4);
  (б) 31 блок → два вызова (30 + 1), каждый блок показал свои строки (Фокус ревью п. 3); (в) ответ `ok:false` у
  одного блока → у него плашка с причиной, соседи со строками; (г) `hide_empty` + пустые строки → блок не рисуется;
  `hide_empty` + ошибка → плашка видна; (д) правка текста одного блока → вызов с одним элементом; (е) один и тот же
  текст в первом кадре и в NodeView редактора → один запрос (общий ключ); (ж) `invalidateGraph` → блоки перезапрашиваются
  одной пачкой; (з) `thisEntityId` берётся из `ThisEntityProvider` и попадает в элемент пачки.
  `forms.test.tsx`: `compact` — строка кликабельна и открывает запись (`useNav`); `list` — строки `EntityRow`,
  чекбокса-контрола нет (Р-13; глиф статуса есть); `table` без `columns` — заголовок + элементы строки фактов
  (`rowProjectionOf`), с `columns=orbis/due_date|orbis/priority` — две колонки со значениями `displayText`; `tile` —
  `count` числом, `sum` с символом валюты (`RUB` → «₽»), несколько валют → сумма без символа и плашка «разные валюты:
  RUB, USD» (РП-20), `latest` — значение; «ещё 2» раскрывается на месте (второй вызов с большим `limit`, пачкой из
  одного); блок с абсолютной датой при `BodyKindProvider kind="page"` → плашка с подсказкой токенов, при `note` —
  данные (С1а-9, web-половина); счётчик закреплённого (`PinnedList`) по-прежнему зовёт `entity.count`, а не
  `entity.blocks` (§6.3, исключение). Прогон
  `cd $W/apps/web && bun run test src/lib/query-blocks/batch.test.tsx src/features/page/blocks/forms.test.tsx > …/t11a.log 2>&1` → FAIL.

- [ ] **Шаг 2: собиратель пачки.** Провайдер держит очередь `{item, resolve, reject}`; `useBlockData` — `useQuery`
  со своим ключом, `queryFn` кладёт просьбу в очередь и ждёт; очередь сбрасывается `setTimeout(0)` (ловит монтирования
  одного коммита React — микротаска могла бы сработать между эффектами разных поддеревьев) вызовом
  `utils.client.entity.blocks.mutate({blocks})` кусками по `BLOCKS_BATCH_CAP`; ответ раскладывается по ключам;
  `ok:false` блока → `reject` только его промиса (`retry: false` по умолчанию); отказ всей пачки → `reject` всех.
  Докблок: почему свой ключ на блок (правка одного блока не перезапрашивает остальных; инвалидация по префиксу), почему
  POST-процедура (РП-8). Прогон шага 1 (а)–(з) → PASS.

- [ ] **Шаг 3: формы показа.** `DataBlock`: разбор текста в браузере (`parseQueryAst` по реестру — для формы показа,
  `hide_empty`, `columns`, `aggregate`; ошибка разбора → плашка без запроса, как сегодня `QueryBlock.tsx:134-152`);
  при `useBodyKind() !== 'note'` — `absoluteDateIn` → плашка без запроса; иначе `useBlockData`. Формы — по
  «Интерфейсам» и спеке §7.2; `CompactForm` — нынешний вид `QueryBlock.tsx:159-180` с кнопкой-строкой; `ListForm` —
  `EntityRow` в кнопке по образцу `EntityList.tsx:33-42`; `TableForm` — `<table>` c подписями свойств из реестра;
  `TileForm` — `ui/Card` с числом и подписью `title`; `MoreRows` — кнопка «ещё N». Деньги: `formatMoneyWithCurrency
  (amount, currency)` в `lib/format.ts`, `CURRENCY_SYMBOL` переезжает туда из `EnvelopeCard.tsx` (импорт там же
  поправить). Прогон шага 1 → PASS.

- [ ] **Шаг 4: перевод потребителей.** `QueryBlock.tsx` — обёртка над `DataBlock` (сигнатура `{query, title?,
  onConfigure?}` сохраняется: `query` строкой или `{ast, text}` → берётся `text`); `QueryWidget.tsx` — `DataBlock`
  по `node.attrs.text`; `EditorShell.tsx` — первый кадр по `parsePageText(markdown)`: `text` → `Markdown`, `query` →
  `QueryBlock`, прочие узлы (обвязка, карточка, контейнер, `broken`) в заметке → `BlockPlaque` с `MISPLACED_HINT`
  (текст узла сохраняется в документе — плашка только на экране; §5.5); `features/browser/query.ts` —
  `bodySegments`/`queryBlocks` снести, `firstQueryBlock` — первый узел `query` из `parsePageText` (одна копия правил,
  РП-6); `invalidate.ts` — `queryClient.invalidateQueries({queryKey: [QUERY_BLOCK_KEY]})` (`queryClient` —
  экспорт `apps/web/src/trpc.ts:16`; `invalidateGraph(utils)` сигнатуру не меняет); `lib/query-blocks/parse.ts:17` — снять
  регэксп в пользу `parsePageText`; `Blocks.tsx:107-109` — то
  же. `main.tsx` и `test/harness.tsx` — `QueryBatchProvider` под `QueryClientProvider`; `blocksReply(map)` в
  обвязке: карта «текст блока → строки | BlockResult». Переписать тесты из «Файлов» (смысл сохранить: что ушло по
  каждому блоку и что показано). Прогон
  `cd $W/apps/web && bun run test src/lib/query-blocks src/features/entity-editor src/features/entity-detail src/features/browser > …/t11b.log 2>&1` → PASS.

- [ ] **Шаг 5: вес экрана и регрессия заметок.** Новые эагерные файлы (`batch.tsx`, `body-kind.tsx`, `DataBlock` и
  формы) — в список `save.test.tsx:1483-1493`; ни один не импортирует баррель `@orbis/shared/doc`. Сборка и сторож:
  `cd $W && bun run --filter @orbis/web build > …/t11-build.log 2>&1 && bun scripts/check-lazy-chunks.ts > …/t11-chunks.log 2>&1; echo EXIT=$?` → 0.
  Снимок структуры задачи 2 (`structure.test.tsx`) — зелёный без правок (тела фикстур без блоков данных).

- [ ] **Шаг 6: мутации.** (а) сбрасывать очередь на каждый блок отдельно → красный (а) «один вызов»; (б) `hide_empty`
  прячет и ошибку → красный (г); (в) ключ блока по `ast` вместо текста → красный (е). Откатить.

- [ ] **Шаг 7: коммит.**
```
cd /Users/birzhan/projects/orbis/.claude/worktrees/pages-slice-1a && git add apps/web/src/lib/query-blocks/batch.tsx apps/web/src/lib/query-blocks/batch.test.tsx apps/web/src/lib/query-blocks/body-kind.tsx apps/web/src/features/page
cd /Users/birzhan/projects/orbis/.claude/worktrees/pages-slice-1a && bun run test > /private/tmp/claude-501/pages-1a/t11-full.log 2>&1; echo EXIT=$? && bun run lint > …/t11-lint.log 2>&1; echo EXIT=$? && bun run typecheck > …/t11-tsc.log 2>&1; echo EXIT=$?
cd /Users/birzhan/projects/orbis/.claude/worktrees/pages-slice-1a && git commit -m "feat(web): единый механизм данных блоков (пачка entity.blocks) и формы показа compact/list/table/tile, «ещё N»

Блок просит «результат моего запроса для this» по своему ключу; одновременные просьбы
уходят одной пачкой ≤30. Первый кадр читает тело листовым препроходом (одна копия правил
маркеров, bodySegments снят). display читается везде (РП-5).

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- apps/web/src
```

### Задача 12: Примитивы обвязки записи — разрез экрана записи на блоки без смены вида

**Зачем:** спека §7.3 — обвязка записи становится примитивами (`title`, `tags`, `body`, `card: X`/`cards`,
`subtasks`, `blockers`, `backlinks`, `versions`, `thread`), свои карточки аспектов объявляются списком «аспект →
карточка», общая доплата — брать данные из запроса записи `this`, а не от экрана. Разведка нашла три связи, которые
разрез обязан сохранить (Ф-1а-18): состояние «план → факт» общее у заголовка и финансовой карточки, `VersionsCard`
знает активную вкладку, оптимистичный патч живёт под ключом записи. Задача режет код, но экран НЕ меняется (РП-23):
её сторож — снимок задачи 2, зелёный без правок эталона. Тем же заходом: переименование `Blocks` → `Blockers`
(§7.3), тег-примитив (нового на экране пока нет — ставит его шаблон хоста в задаче 14), `tags` в оптимистичном патче,
стейл-комментарии №39 остатков Б-2 (РП-19).

**Файлы:**
- Создать: `apps/web/src/features/entity-detail/{EntityBody,EntityThreadTab,AspectSection,TagsBlock,own-cards,record-host}.tsx`,
  `apps/web/src/features/entity-detail/record-blocks.test.tsx`.
- Изменить: `DetailScreen.tsx` (вынести `EntityBody` `:551-857` и `EntityThreadTab` `:525-537`; части вкладок — через
  примитивы; `planToFact` и активная вкладка — в контекст хоста), `AspectCards.tsx:41,90-221` (разрезать:
  `AspectSection({entity, aspectId})` + «остальные» с параметром исключений; `HIDDEN_ASPECT_CARDS` → объявление в
  `own-cards.tsx`), `useEntityDetail.ts:71-96` (`tags` в `applyPatch`), `Blocks.tsx` → `Blockers.tsx`,
  `Blocks.test.tsx` → `Blockers.test.tsx`, упоминания `lib/invalidate.ts:42`, `Subtasks.tsx:27`; стейл-комментарии
  `AssignmentCard.tsx` ≈`:97,221`, `AspectCards.tsx` ≈`:37`, `TicketWaitingBlock.tsx` ≈`:140-146` (адреса снесённого
  кода — `remainders-b2.md` №39); `save.test.tsx:1483-1493`.

**Интерфейсы:**
- Consumes: ответ `entity.get` `{entity, thread, relations, backlinks, backlinksTruncated, goalProgress}`
  (`useEntityDetail.ts:29-39`), `usePlanToFactPrompt()` (`features/budget/usePlanToFactPrompt.ts:16-43`),
  `useTicketRuns(id, enabled)` (`useTicketRuns.ts:53-85`), `ui/Chip`, образец ввода тега — `features/browser/Filters.tsx:27-46`.
- Produces (для задач 13, 14):
```ts
// features/entity-detail/record-host.tsx
export interface RecordHostValue {
  entity: WireEntity; relations: WireRelation[]; backlinks: Backlink[]; backlinksTruncated: boolean;
  goalProgress?: GoalProgress; thread: WireThread | null;
  planToFact: ReturnType<typeof usePlanToFactPrompt>;   // общее у {{title}} и карточки orbis/financial
  activeTab: string | null;                             // контейнер вкладок сообщает детям (VersionsCard.active)
  readOnlyBody: boolean;                                // предпросмотр шаблона на чужой записи (§6.2, §9.3)
}
export function RecordHostProvider(props: { value: RecordHostValue; children: ReactNode }): JSX.Element;
export function useRecordHost(): RecordHostValue;
// features/entity-detail/own-cards.tsx — объявление «аспект → карточка» (§7.3)
export const OWN_ASPECT_CARDS: Readonly<Record<string, ComponentType>> ; // goal, assignment, routine, agent-run, financial
export function AspectCardFor(props: { aspectId: string }): JSX.Element | null; // своя или AspectSection
export function RestCards(props: { placed: ReadonlySet<string> }): JSX.Element;  // {{cards}}: все, кроме placed
// features/entity-detail/record-blocks.tsx — примитивы обвязки по имени блока
export const RECORD_BLOCK_COMPONENTS: Readonly<Record<RecordBlockName, ComponentType>>;
```
  Состав своих карточек (§7.3, `recon-plan-3` W1): `orbis/goal` — `AspectSection` + `GoalProgress`;
  `orbis/assignment` — `AssignmentCard` + `TicketWaitingBlock` (если запись ещё и задача) + `RunsList`;
  `orbis/routine` — `AspectSection` + `RoutineStatusBlock` + `RunsList showGrant={false}`; `orbis/agent-run` —
  `RunFeed`; `orbis/financial` — `AspectSection` + `PlannedToFactCard` (состояние из хоста).

- [ ] **Шаг 1: красные тесты примитивов.** `record-blocks.test.tsx` (фикстуры задачи 2 `STRUCTURE_FIXTURES`):
  каждый примитив рендерится под `RecordHostProvider` и показывает свой ориентир (`native-row`, `aspect-<id>`,
  `versions-card`, `subtask`, `backlink`, …); `AspectCardFor('orbis/goal')` — секция полей И `goal-progress`;
  `RestCards({placed: {'orbis/goal'}})` на `goal-schedule` — только `aspect-orbis/schedule`; `TagsBlock`: Enter
  добавляет тег (вызов `entity.update {tags}` полной заменой), крестик снимает, дубликат — без вызова, IME-гард;
  чекбокс заголовка у финансовой задачи поднимает «план → факт», и карточка `orbis/financial`, стоящая в другом месте
  дерева, его показывает (Ф-1а-18). Прогон
  `cd $W/apps/web && bun run test src/features/entity-detail/record-blocks.test.tsx > …/t12a.log 2>&1` → FAIL.

- [ ] **Шаг 2: разрез.** Вынести `EntityBody` и `EntityThreadTab` в файлы (без изменений логики, кроме одного:
  `EntityBody` оборачивает первый кадр и редактор в `BodyKindProvider` по САМОЙ записи — `note`, если у неё нет
  `orbis/page`; `page`/`template` — по «Шаблон для»; так тело заметки внутри шаблона не наследует род шаблона); `AspectSection`
  из `AspectCards` (одна секция: строки свойств, «Снять аспект»); `AspectCards` = `RestCards` с пустым `placed` +
  секция «Свойства» (как сегодня `:210-217`); `own-cards.tsx`, `record-host.tsx`, `record-blocks.tsx`, `TagsBlock`
  (Chip + ввод по образцу `Filters`, запись через `useEntityUpdate` — `applyPatch` учится `tags`). `DetailScreen` ставит
  `RecordHostProvider` и рисует ПРЕЖНЮЮ раскладку из новых частей (прогресс цели — на «Сущности», поля цели — на
  «Деталях», как сегодня). `Blocks` → `Blockers` (файл, компонент, тест, упоминания). Прогон шага 1 → PASS.

- [ ] **Шаг 3: сторож «экран не изменился».** `cd $W/apps/web && bun run test src/features/entity-detail/ > …/t12b.log 2>&1`
  → PASS, включая `structure.test.tsx` БЕЗ правки эталонов (РП-23) и `detail.test.tsx`. Сборка и
  `check-lazy-chunks` — EXIT 0; новые эагерные файлы — в `save.test.tsx`.

- [ ] **Шаг 4: мутации.** (а) держать `planToFact` локально в заголовке → красный тест «карточка в другом месте
  дерева»; (б) `RestCards` без исключения `placed` → красный «только schedule»; (в) переставить прогресс цели на
  «Детали» → красный снимок задачи 2. Откатить.

- [ ] **Шаг 5: коммит.**
```
cd /Users/birzhan/projects/orbis/.claude/worktrees/pages-slice-1a && git add apps/web/src/features/entity-detail
cd /Users/birzhan/projects/orbis/.claude/worktrees/pages-slice-1a && bun run test > /private/tmp/claude-501/pages-1a/t12-full.log 2>&1; echo EXIT=$? && bun run lint > …/t12-lint.log 2>&1; echo EXIT=$? && bun run typecheck > …/t12-tsc.log 2>&1; echo EXIT=$?
cd /Users/birzhan/projects/orbis/.claude/worktrees/pages-slice-1a && git commit -m "refactor(web): обвязка записи — примитивы и объявление «аспект → карточка»; Blocks → Blockers; теги

Экран записи нарезан на примитивы с данными из запроса записи this (контекст хоста);
вид не изменился — сторож снимок задачи 2. Состояние «план → факт» и активная вкладка
живут в хосте: заголовок и финансовая карточка разнесены шаблоном, связь не рвётся.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- apps/web/src
```

### Задача 13: Рендерер показа и страница своим телом

**Зачем:** спека §6.1 — рендерер рисует тело на показ: текст, колонки и вкладки по-настоящему, блоки с данными;
им показываются страницы и шаблоны, случайной правки нет; §4.2 шаг 1 — запись с `orbis/page` показывается своим
телом; §6.4 — `this` на странице — сама страница, данные обвязки — ОДИН запрос записи `this` (сегодняшний `entity.get`
экрана с полными включениями; сужение по блокам не делается — РП-13, Э-14);
§5.5 — `{{body}}` на странице и обвязка в заметке не рисуются, на месте — плашка. Рендерер строится над деревом
листового препрохода (РП-6) и переиспользует вид первого кадра (`Markdown` для текста) — без ребра `DetailScreen →
doc`. Записи без аспекта «страница» в этой задаче ещё открываются прежним экраном (переход — задача 14).

**Файлы:**
- Создать: `apps/web/src/features/page/{Renderer,Columns,TabsContainer,PageView}.tsx`, `apps/web/src/features/page/render.test.tsx`.
- Изменить: `apps/web/src/features/entity-detail/DetailScreen.tsx` (запись с `orbis/page` → `PageView` поверх того же
  `get` экрана — второго `entity.get` нет), `apps/web/src/features/entity-editor/save.test.tsx:1483-1493`.

**Интерфейсы:**
- Consumes: `parsePageText`, `PageNode` (задача 7); `bodyIssues`, `BodyKind`, `blockAllowedIn` (задача 9);
  `DataBlock`, `BodyKindProvider` (задача 11); `RecordHostProvider`, `RECORD_BLOCK_COMPONENTS`, `AspectCardFor`,
  `RestCards` (задача 12); `Markdown` (`lib/markdown/Markdown.tsx`); `ui/Tabs` (`tabs[{value,label,content,keepMounted}]`,
  `ui/Tabs.tsx:24-103`); `TEMPLATE_FOR_PROPERTY`, `PAGE_ASPECT` (задача 4).
- Produces (для задач 14, 15, 16):
```ts
// features/page/Renderer.tsx
export function Renderer(props: {
  nodes: readonly PageNode[]; kind: BodyKind;
  /** Гарантия хоста §8.3: карточки аспектов записи, не размещённые ни card:, ни cards, — в конец. Только шаблонам. */
  appendUnplacedCards: boolean;
}): JSX.Element;
// features/page/PageView.tsx — страница своим телом; kind = 'template', если «Шаблон для» непуст, иначе 'page'.
// reply — ответ entity.get экрана (DETAIL_INCLUDE): relations, backlinks, thread, goalProgress для блоков обвязки.
export function PageView(props: { reply: EntityGetReply }): JSX.Element;
// Текстовые куски рендерера несут data-testid="page-text" (ориентир снимка задачи 2).
```

- [ ] **Шаг 1: красные тесты.** `render.test.tsx` (`renderWithProviders`, `wireEntity` с `aspects: ['orbis/page']`):
  - страница «Утро» с текстом, `{{columns}}` из двух колонок и тремя блоками данных → текст виден, две колонки
    (контейнер несёт классы «столбиком на узком, сеткой на `md`»), ОДИН вызов `entity.blocks` с тремя элементами
    (С1а-4 на странице, живая приёмка 1);
  - `{{tabs}}` с «А» и «Б» → видна «А», переключение показывает «Б»; вложенные колонки во вкладке рисуются;
  - `{{title}}` на странице показывает заголовок САМОЙ страницы (§6.4: `this` — сама страница); `{{backlinks}}` —
    её обратные ссылки;
  - `{{body}}` на странице → плашка `BLOCK_MISPLACED` (текст узла в теле цел); незакрытый контейнер → плашка
    с сообщением `CONTAINER_UNCLOSED` на месте контейнера, остальное тело рисуется (С1а-2, половина рендера);
  - один запрос записи: открытие страницы → РОВНО один вызов `entity.get` (в `calls`), с сегодняшним `DETAIL_INCLUDE`
    (РП-13, Э-14);
  - шаблон показан сам на себе (страница с непустым «Шаблон для», `this` = сама страница): `{{body}}` → заглушка
    «[Тело записи]» без редактора (текст шаблона не открывается редактором заметки);
  - показ не редактирует: в `PageView` нет `contenteditable`;
  - правка заголовка через `{{title}}` страницы — оптимистично, прежним `useEntityUpdate` под ключом `detailGetInput(id)`.
  Прогон `cd $W/apps/web && bun run test src/features/page/render.test.tsx > …/t13a.log 2>&1` → FAIL.

- [ ] **Шаг 2: рендерер.** `Renderer` — рекурсивный обход `PageNode[]`: `text` → `Markdown`; `query` → `DataBlock`;
  `record` → `RECORD_BLOCK_COMPONENTS[name]`; `card` → `AspectCardFor` (аспект — по ключу или подписи через реестр);
  `columns` → `Columns` (CSS-сетка `md:grid-cols-N`, на узком — `flex-col`); `tabs` → `TabsContainer` (`ui/Tabs`,
  активная вкладка — в `RecordHostValue.activeTab`); `broken` → `BlockPlaque` с сообщением. Проблемы
  `bodyIssues(nodes, kind, reg)` рисуются плашками на месте узла (путь). `appendUnplacedCards` — множество аспектов
  записи минус размещённые `card:` минус «всё», если есть `{{cards}}`, → `RestCards` в конец. `PageView`:
  `parsePageText(reply.entity.body)`, `RecordHostProvider` (данные — из `reply`), `BodyKindProvider`, `ThisEntityProvider id`;
  текстовые куски — `Markdown` в обёртке `data-testid="page-text"`; `{{body}}` при `this` = самой странице — заглушка. `DetailScreen`: `entity.aspects.includes(PAGE_ASPECT)` → `PageView`
  вместо вкладок (меню «⋯» прежнее; пункты страницы — задача 15). Прогон шага 1 → PASS.

- [ ] **Шаг 3: вес.** Новые эагерные файлы — в `save.test.tsx`; сборка + `check-lazy-chunks` → EXIT 0 (рендерер
  импортирует только `@orbis/shared/doc/page-grammar` и `/doc/placement`). Снимок задачи 2 зелёный (обычные записи —
  прежний экран).

- [ ] **Шаг 4: мутации.** (а) `PageView` со своим `entity.get` → красный «ровно один вызов»; (б) `DataBlock` в рендерере
  через прямой `entity.query` → красный «один вызов»; (в) убрать плашку `{{body}}` на странице → красный. Откатить.

- [ ] **Шаг 5: коммит.**
```
cd /Users/birzhan/projects/orbis/.claude/worktrees/pages-slice-1a && git add apps/web/src/features/page
cd /Users/birzhan/projects/orbis/.claude/worktrees/pages-slice-1a && bun run test > /private/tmp/claude-501/pages-1a/t13-full.log 2>&1; echo EXIT=$? && bun run lint > …/t13-lint.log 2>&1; echo EXIT=$? && bun run typecheck > …/t13-tsc.log 2>&1; echo EXIT=$?
cd /Users/birzhan/projects/orbis/.claude/worktrees/pages-slice-1a && git commit -m "feat(web): рендерер показа — текст, колонки, вкладки, блоки данных и обвязки; страница своим телом

Рендерер идёт по дереву листового препрохода (без схемы документа в чанке экрана); запрос
записи this — один, как сегодня; проблемы тела — плашки на месте узла.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- apps/web/src
```

### Задача 14: Экран записи через шаблон хоста, выбор шаблона, спор, гарантии (С1а-3 UI, С1а-5, С1а-6)

**Зачем:** спека §8 — сегодняшний экран записи становится шаблоном хоста: текст §8.1 в поставке, тем же разборщиком
и рендерером; три намеренных отличия §8.2, любое иное — дефект; §8.3 — дописывание карточек и базовый вид записи;
§4.2 — любая запись открывается через шаблон по функции выбора; §4.3 — плашка спора пишет выбор одной пачкой с
одним Undo; §6.5 — экран без своих шаблонов рисуется без лишнего ожидания. Приёмка С1а-5 (снимок против эталона
задачи 2 через функцию трёх отличий) и С1а-6 (четыре сторожа РП-11) закрываются здесь.

**Файлы:**
- Создать: `apps/web/src/features/page/{host-template,usePageTemplates,RecordView,TemplatePlaques,BaseRecordView}.tsx`,
  `apps/web/src/features/page/host-template.test.ts`, `apps/web/src/features/page/record-view.test.tsx`,
  `apps/web/src/features/entity-detail/intended-1a.ts` (функция трёх отличий).
- Изменить: `apps/web/src/features/entity-detail/DetailScreen.tsx` (запись без `orbis/page` → `RecordView`; вкладки
  и раскладка экрана уходят в шаблон хоста), `apps/web/src/features/entity-detail/structure.test.tsx` (сравнение
  с `INTENDED_1A(эталон)`), `apps/web/src/ui/toast-store.ts` (необязательное действие «Отменить» — РП-9), тесты web
  с пинами слова «Сущность» (18 мест, `recon-plan-3` W7) → «Запись», `save.test.tsx:1483-1493`.

**Интерфейсы:**
- Consumes: `chooseTemplate`, `templatesFromRows`, `contendersOf`, `recordDisputeChoice` (задача 5);
  `templateBrokenReason` (задача 9); `Renderer`, `PageView` (задача 13); `trpc.entity.updateBatch`
  (задача 10), `trpc.ai.undo({actionId})`; `STRUCTURE_FIXTURES`, `structureHandler`, эталоны задачи 2.
- Produces (для задач 15, 16):
```ts
// features/page/host-template.ts
export const HOST_TEMPLATE_TEXT: string;          // дословно спека §8.1
export const HOST_TEMPLATE_NODES: readonly PageNode[]; // parsePageText(HOST_TEMPLATE_TEXT), разбор при загрузке модуля
// features/page/usePageTemplates.ts
export const PAGE_TEMPLATES_QUERY = 'aspect=orbis/page, has=orbis/template_for';
export function usePageTemplates(): { templates: TemplateCandidate[]; rows: WireEntity[]; status: 'loading' | 'ok' | 'error' };
// features/page/RecordView.tsx — выбор и показ записи (не страницы)
// reply — ответ entity.get показываемой записи (экрана или — в предпросмотре — своего запроса выбранной записи)
export function RecordView(props: { reply: EntityGetReply; override?: { templateId: string | 'host' }; readOnlyBody?: boolean }): JSX.Element;
// features/page/TemplatePlaques.tsx
export function DisputePlaque(props: { contenders: readonly string[]; rows: WireEntity[] }): JSX.Element;
export function BrokenTemplatePlaque(props: { broken: BrokenTemplate; title: string }): JSX.Element;
// ui/toast-store.ts
show(title: string, tone?: Tone, action?: { label: string; onSelect: () => void }): void;
```

- [ ] **Шаг 1: красные тесты.** `host-template.test.ts`: `HOST_TEMPLATE_TEXT` побайтно равен блоку §8.1 спеки
  (строки перечислены в тесте литералом); `bodyIssues(HOST_TEMPLATE_NODES, 'template', reg)` пуст. `record-view.test.tsx`:
  - нет своих шаблонов → шаблон хоста; `entity.get` и список шаблонов запрашиваются параллельно: хендлер держит ответ
    `entity.get` неразрешённым — вызов списка шаблонов уже есть в `calls` (запросы не ждут друг друга; склейку в один
    HTTP даёт `httpBatchLink` прода, обвязкой `mockLink` она не доказуема);
  - род тела внутри `{{body}}` шаблона — по самой записи (I-4): заметка под шаблоном хоста с блоком
    `orbis/due_date<=2026-01-01` показывает ДАННЫЕ (род `note`), а не плашку абсолютной даты; тот же блок на странице —
    плашка;
  - шаблон владельца бросает при рендере (мок примитива) → считается сломанным («ошибка отрисовки»), выбор повторяется,
    рисуется следующий подходящий или шаблон хоста с плашкой;
  - шаблон владельца `{project}` и запись-проект → рисуется шаблон владельца (живая приёмка 2);
  - спор `A{project}` / `B{task}` на записи «проект + задача» → раньше созданный + `DisputePlaque` с подписью по
    объединению наборов; нажатие «B» → ОДИН вызов `entity.updateBatch` с правками по `recordDisputeChoice`, экран
    переключается на `B` после инвалидации, плашки нет; на другой записи с тем же спором плашки нет (живая приёмка 3);
    тост «Отменить» зовёт `ai.undo` с `actionId` ответа;
  - в `B.winsOver` лежит id архивного шаблона → запись выбора без него (Фокус ревью п. 4);
  - сломанный шаблон `B{project,task}` (незакрытый контейнер) → рисуется `A` и плашка «шаблон „B“ не разобран:
    <причина>» со ссылкой на шаблон;
  - ошибка списка шаблонов → шаблон хоста + плашка, экран работает (РП-14);
  - шаблон хоста падает при рендере (примитив бросает — мок) → `BaseRecordView`: заголовок, тело, карточки (§8.3);
  - шаблон владельца без `{{card: orbis/goal}}` и без `{{cards}}` на записи-цели → карточка цели дописана в конец
    (§8.3).
  `structure.test.tsx`: второй режим — для каждой фикстуры `snapshot(новый экран) toEqual INTENDED_1A(эталон)`;
  множество запросов = эталон + `{'entity.query': +1}` (список шаблонов; РП-11 (2)).
  Прогон `cd $W/apps/web && bun run test src/features/page src/features/entity-detail/structure.test.tsx > …/t14a.log 2>&1` → FAIL.

- [ ] **Шаг 2: `INTENDED_1A`.** `intended-1a.ts` — три поимённых преобразования эталона (§8.2), каждое своей
  функцией с докблоком-ссылкой: (1) `titleAndTagsAboveTabs` — `native-row` (с эмодзи) уходит из первой вкладки над
  вкладки, добавляется `tags-block`; (2) `renameEntityTab` — «Сущность» → «Запись»; (3) `ownCardsOnRecordTab` —
  части своих карточек (`goal-progress` + `aspect:orbis/goal[…]`; `assignment-card` + `ticket-waiting` +
  `runs-list`; `aspect:orbis/routine[…]` + `routine-status` + `runs-list`; лента прогона; `aspect:orbis/financial[…]`
  + «план → факт») убираются с обеих вкладок и встают одним куском на «Запись» над `body` в порядке строк §8.1;
  «Детали» = остальные карточки, `versions-card`, `subtask`, блокировки, `backlink` — в этом порядке. Функции чистые
  и видны ревью; эталон не правится (РП-10).

- [ ] **Шаг 3: экран.** `host-template.ts`; `usePageTemplates` (`entity.query {query: PAGE_TEMPLATES_QUERY}` общим
  ключом — гасится `invalidateGraph`); `RecordView`: `chooseTemplate({aspects}, templates, id =>
  templateBrokenReason(bodyOf(id), reg))` → узлы шаблона (своего — `parsePageText(row.body)`; хоста —
  `HOST_TEMPLATE_NODES`) → `Renderer kind="template" appendUnplacedCards` под `RecordHostProvider` (данные — ответ `entity.get` экрана,
  РП-13), `ThisEntityProvider`, плашки спора и сломанных над рендером; `ErrorBoundary` вокруг рендера шаблона владельца →
  шаблон в `broken` с причиной «ошибка отрисовки» и повтор выбора; вокруг шаблона хоста → `BaseRecordView`. `DetailScreen`: запись без `orbis/page` → `RecordView`; режим «открыть через X»
  — состояние экрана со сбросом в `prevIdRef`-блоке (`:145-156`); `ScreenHeader`, `DetailMenu`, `ProposalOverlay`,
  `noticeHost`, `PinVersionDialog` — прежние, над рендером. `toast-store` — действие. Пины «Сущность» → «Запись».
  Прогон шага 1 → PASS.

- [ ] **Шаг 4: сторожа скорости (РП-11).** (1) сборка + `check-lazy-chunks` → EXIT 0; (2) множество запросов —
  шаг 1; (3) `cd $W && bun run test:perf > …/t14-perf.log 2>&1` — `entity.backlinks`, `goal.progress` в порогах;
  (4) размер `apps/web/dist/assets/DetailScreen-*.js` gzip против базы задачи 1 (шаг 4) — в отчёт; рост > 15 % —
  СТОП и разбор с координатором.

- [ ] **Шаг 5: мутации (С1а-10).** (0) `EntityBody` без своего `BodyKindProvider` → красный тест рода тела; (а) убрать `{{card: orbis/goal}}` из `HOST_TEMPLATE_TEXT` → красные тест текста
  §8.1 и снимок (`goal`); (б) снять одно преобразование в `INTENDED_1A` → красный снимок; (в) в `chooseTemplate`
  вызвать без `isBroken` → красный тест сломанного шаблона; (г) дописывание карточек выключить → красный §8.3.
  Откатить.

- [ ] **Шаг 6: коммит.**
```
cd /Users/birzhan/projects/orbis/.claude/worktrees/pages-slice-1a && git add apps/web/src/features/page apps/web/src/features/entity-detail/intended-1a.ts
cd /Users/birzhan/projects/orbis/.claude/worktrees/pages-slice-1a && bun run test > /private/tmp/claude-501/pages-1a/t14-full.log 2>&1; echo EXIT=$? && bun run lint > …/t14-lint.log 2>&1; echo EXIT=$? && bun run typecheck > …/t14-tsc.log 2>&1; echo EXIT=$?
cd /Users/birzhan/projects/orbis/.claude/worktrees/pages-slice-1a && git commit -m "feat(web): экран записи через шаблон хоста; выбор шаблона владельца, плашка спора с памятью, гарантии хоста

Шаблон хоста — текст §8.1 в поставке, тем же разборщиком и рендерером. Снимок экрана
совпадает с эталоном до среза через три намеренных отличия §8.2 (функции, эталон не
тронут). Спор пишет выбор одной пачкой с одним Undo.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- apps/web/src
```

### Задача 15: Меню «⋯» записи и страницы — входы «Сделать страницей», «Изменить вид только этой записи» и другие

**Зачем:** спека §8.4 — у записи новые пункты «Открыть через шаблон хоста», «Открыть через „X“», «Изменить вид только
этой записи», «Сменить выбор шаблона для таких записей», «Сделать страницей»; у страницы — «Открыть как запись»,
«Сделать шаблоном для…», «Перестать быть страницей». «Изменить вид только этой» — одна пачка, один Undo, три случая
судьбы текста (Р-19), молча не дописывать и не убирать (С1а-8). Все записи — через `entity.updateBatch` (РП-9).
Пункты «Настроить», «Настроить шаблон „X“», «Предпросмотр на записи…» — задача 16 (им нужен режим настройки).

**Файлы:**
- Создать: `apps/web/src/features/page/change-view.ts` (+ `change-view.test.ts`), `apps/web/src/features/page/{ChangeViewDialog,TemplateForDialog}.tsx`,
  `apps/web/src/features/page/useUpdateBatch.ts`, `apps/web/src/features/page/menu.test.tsx`.
- Изменить: `apps/web/src/features/entity-detail/DetailScreen.tsx:1019-1088` (`DetailMenu` — новые пункты,
  условные — спредом, как `:1076-1084`), `apps/web/src/features/page/{RecordView,PageView}.tsx` (режим «открыть
  через X»/«как запись»), `apps/web/src/features/page/Renderer.tsx` (РП-25: на показе страницы своим телом
  `{{cards}}` не рисует карточку `orbis/page`).

**Интерфейсы:**
- Consumes: `chooseTemplate`, `contendersOf` (задача 5); `HOST_TEMPLATE_TEXT`, `RecordView`, `DisputePlaque`,
  `usePageTemplates` (задача 14); `parsePageText` (задача 7); `trpc.entity.updateBatch`, `trpc.ai.undo`,
  `toast-store.show(title, tone, action)`; `AspectsManyControl` (задача 4).
- Produces (для задачи 16):
```ts
// features/page/change-view.ts — чистая часть «Изменить вид только этой записи» (§8.4, Р-19)
export type ChangeViewPlan =
  | { case: 1; body: string }                          // текста нет → копия шаблона
  | { case: 2; body: string }                          // текст на место {{body}}
  | { case: 3; hideAsVersion: string; showBelow: string }; // текст есть, {{body}} нет → выбор владельца
export function changeViewPlan(templateText: string, recordBody: string): ChangeViewPlan;
export const TEXT_BEFORE_VIEW_CHANGE = 'Текст до изменения вида';
// features/page/useUpdateBatch.ts — пачка правок + тост «Отменить»
export function useUpdateBatch(): (operations: UpdateBatchOperation[], doneTitle: string) => Promise<void>;
```

- [ ] **Шаг 1: красные тесты чистой части.** `change-view.test.ts`: пустое тело (или одни пробелы) → случай 1, тело =
  шаблон БЕЗ строки `{{body}}` (иначе на странице — плашка §5.5; РП-29, Э-13), остальное дословно; тело «Заметка» и шаблон хоста → случай 2, в тексте шаблона строка `{{body}}` заменена текстом
  записи, остальное байт-в-байт (замена по дереву препрохода, склейка `text`/`raw` — задача 7); шаблон без
  `{{body}}` и непустое тело → случай 3: `hideAsVersion` = шаблон, `showBelow` = шаблон + пустая строка + текст
  записи; `{{body}}` внутри вкладки заменяется там же. Прогон
  `cd $W/apps/web && bun run test src/features/page/change-view.test.ts > …/t15a.log 2>&1` → FAIL; реализовать → PASS.

- [ ] **Шаг 2: красные тесты меню.** `menu.test.tsx`:
  - «Сделать страницей» (запись не страница) → `entity.updateBatch` c `entity_update {aspects:{attach:['orbis/page']}}`;
    тост «Отменить» → `ai.undo({actionId})`; у страницы пункта нет;
  - «Изменить вид только этой записи» (С1а-8): случаи 1 и 2 — одна пачка `entity_update {id, expectedUpdatedAt,
    body: plan.body, aspects:{attach:['orbis/page']}}`; ПОСЛЕ ответа запись показывается страницей, и
    `snapshotDetailStructure(после)` равен `bodyBecameText(snapshot(до), plan.case)` — поимённая функция теста: ориентир
    `body` становится `page-text` (случай 2) или исчезает (случай 1; пустое тело рисовалось заглушкой) — остальное совпадает
    (визуально как раньше; РП-25 — карточка «Страница» в `{{cards}}` своего тела не рисуется; РП-29); случай 3 — диалог с текстом Р-19 и тремя кнопками: «Сохранить версией и убрать» →
    пачка `[entity_version_pin {entity_id, label: TEXT_BEFORE_VIEW_CHANGE}, entity_update {body: plan.hideAsVersion, attach}]`
    (подсказка кнопки: «пока текст лежит в версии, его не видят поиск и агент»), «Показать внизу страницы» →
    `entity_update {body: plan.showBelow, attach}`, «Отмена» → вызовов нет; всегда ОДИН вызов `updateBatch`, один
    Undo;
  - «Открыть через шаблон хоста» — только когда открыто шаблоном владельца; разово: после ухода с записи и возврата —
    снова шаблон владельца; «Открыть через „X“» — по одному пункту на прочие подходящие шаблоны;
  - «Сменить выбор шаблона для таких записей» — только при `contendersOf ≠ null`; показывает `DisputePlaque` даже при
    запомненном выборе;
  - страница: «Открыть как запись» → `RecordView override={templateId:'host'}` (версии, тред, обратные ссылки видны);
    «Сделать шаблоном для…» → диалог с `AspectsManyControl` → пачка `entity_update {props: {'orbis/template_for':
    [...]}}`; снятие всех аспектов → `unset: ['orbis/template_for', 'orbis/template_wins_over']` одной правкой (§3.2:
    иначе первое правило отвергло бы правку); «Перестать быть страницей» → `aspects: {detach: ['orbis/page']}` (РП-22).
  Прогон `cd $W/apps/web && bun run test src/features/page/menu.test.tsx > …/t15b.log 2>&1` → FAIL.

- [ ] **Шаг 3: реализация.** `useUpdateBatch` — мутация `entity.updateBatch`, по успеху `invalidateGraph` и тост с
  действием «Отменить» (`ai.undo`, затем `invalidateGraph`); пункты `DetailMenu` по §8.4 с условиями «Когда»; режимы
  «открыть через …» — состояние `DetailScreen` со сбросом в `prevIdRef`-блоке (не `ScreenRef`: навигация и история не
  меняются, W7); диалоги на `ui/Dialog`. РП-25 — в `Renderer`: при `kind` страницы и шаблона-своего-тела `RestCards`
  получает `orbis/page` в `placed`. Прогон шага 2 → PASS.

- [ ] **Шаг 4: мутации.** (а) случай 3 без диалога (молча вниз) → красный; (б) две отдельные мутации вместо пачки →
  красный «один вызов»; (в) «Сделать шаблоном для…» при снятии без `template_wins_over` в `unset` → красный. Откатить.

- [ ] **Шаг 5: коммит.**
```
cd /Users/birzhan/projects/orbis/.claude/worktrees/pages-slice-1a && git add apps/web/src/features/page
cd /Users/birzhan/projects/orbis/.claude/worktrees/pages-slice-1a && bun run test > /private/tmp/claude-501/pages-1a/t15-full.log 2>&1; echo EXIT=$? && bun run lint > …/t15-lint.log 2>&1; echo EXIT=$? && bun run typecheck > …/t15-tsc.log 2>&1; echo EXIT=$?
cd /Users/birzhan/projects/orbis/.claude/worktrees/pages-slice-1a && git commit -m "feat(web): меню «⋯» — «Сделать страницей», «Изменить вид только этой записи», выбор и смена шаблона

Все входы пишут одной пачкой entity.updateBatch с одним Undo. «Изменить вид только этой»:
текста нет — копия шаблона; есть {{body}} — текст на его место; иначе вопрос владельцу
(версией и убрать / показать внизу / отмена), молча ничего не дописывается.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- apps/web/src
```

### Задача 16: Настройка страниц и шаблонов — редактор, баннер, предпросмотр, плашка в заметке

**Зачем:** спека §9 — «Настроить» открывает тело страницы или шаблона в том же редакторе: контейнеры — подписанные
рамки одна под другой, блоки обвязки — подписанные заглушки, блоки данных — живой предпросмотр; меню «/» предлагает
контейнеры и обвязку только у страниц и шаблонов; баннер шаблона; предпросмотр шаблона на выбранной записи с телом
только для чтения. §5.5 — блок не на своём месте в заметке показывает плашку, текст сохраняется. §7.4 — пункт «/»
переименовывается в «Список по запросу» («смарт-лист» уходит из словаря).

**Файлы:**
- Создать: `apps/web/src/features/entity-editor/nodes/{LayoutFrame,RecordBlockStub}.tsx`, `apps/web/src/features/entity-editor/nodes/layout.test.tsx`,
  `apps/web/src/features/page/{ConfigureView,TemplateBanner,TemplatePreview}.tsx`, `apps/web/src/features/page/configure.test.tsx`.
- Изменить: `apps/web/src/features/entity-editor/extensions.ts:32-90` (NodeView для шести узлов),
  `apps/web/src/features/entity-editor/slash/items.ts:60-126` (род тела, новые пункты, «Список по запросу»),
  `apps/web/src/features/entity-editor/slash/EditorSuggest.tsx:188,214` (фильтр и выбор по одному отфильтрованному
  списку), `apps/web/src/features/entity-editor/BodyEditor.tsx:151`, `apps/web/src/features/entity-editor/EditorShell.tsx`
  (первый кадр: рамки и заглушки при `kind !== 'note'`), `apps/web/src/features/entity-editor/EditorShell.tsx:42,56`
  (`isBodyGesture` — признак новых заглушек), `apps/web/src/features/entity-detail/DetailScreen.tsx` (режим
  «Настроить»; пункты «Настроить», «Настроить шаблон „X“», «Предпросмотр на записи…»), `apps/web/src/features/page/TemplatePlaques.tsx`
  (ссылка «не разобран» ведёт в настройку шаблона), `slash/slash.test.tsx:208,349,359`.

**Интерфейсы:**
- Consumes: `useBodyKind`, `BodyKindProvider` (задача 11); `EntityBody` (задача 12); `PageView`, `Renderer`
  (задача 13); `RecordView`, `usePageTemplates` (задача 14); `MISPLACED_HINT`, `blockAllowedIn` (задача 9);
  `aspectLabel(reg, id)` (`lib/registry/labels.ts:207`); NodeView-образец атома — `QueryWidget.tsx:91-110`.
- Produces: режимы экрана `configure` и `preview` (состояние `DetailScreen`); `SLASH_ITEMS` с полем
  `kinds: readonly BodyKind[]`; `filterSlashItems(query, kind, doc)`.

- [ ] **Шаг 1: красные тесты редактора.** `layout.test.tsx` (образец `query-widget.test.tsx`): тело страницы с
  колонками и вкладками в редакторе → рамки «Колонка 1», «Колонка 2», «Вкладка: Тред» одна под другой, текст внутри
  редактируется; `{{title}}` → заглушка «[Заголовок записи]», `{{cards}}` → «[Карточки аспектов]», `{{card:
  orbis/goal}}` → «[Карточка: Цель]» — без запросов данных; `{{query:…}}` → живой блок данных (пачкой);
  тело ЗАМЕТКИ с `{{title}}` (вставкой) → плашка `MISPLACED_HINT`, после сохранения текст узла в `body` цел (С1а-2,
  половина редактора). `slash.test.tsx`: у заметки — нет «Колонки», «Вкладки», обвязки; пункт называется «Список по
  запросу»; у страницы — контейнеры и обвязка без «Тело записи»; у шаблона — и «Тело записи», пока его в документе
  нет; Enter по скрытому пункту не вставляет его (фильтр и выбор — один список). Пины `:208,349,359` —
  по новому составу. Прогон
  `cd $W/apps/web && bun run test src/features/entity-editor/nodes/layout.test.tsx src/features/entity-editor/slash > …/t16a.log 2>&1` → FAIL.

- [ ] **Шаг 2: редактор.** `LayoutFrame` — первый в коде `NodeViewContent`: `NodeViewWrapper` с подписью части и
  содержимым; `RecordBlockStub` — атом по образцу `QueryWidget` c `data-query-widget` (для `isBodyGesture`); при
  `useBodyKind() === 'note'` обе вьюхи показывают плашку `MISPLACED_HINT`. `SLASH_ITEMS`: поле `kinds`; новые пункты
  «Колонки» (вставляет `columns` из двух `column` с пустыми абзацами), «Вкладки» (`tabs` с одной `tab` «Вкладка 1»),
  девять блоков обвязки и «Карточка аспекта» (выбор аспекта по реестру); «Тело записи» — только `template` и только
  если узла `recordBlock{name:'body'}` в документе нет; «Смарт-лист» → «Список по запросу». Род тела —
  `useBodyKind()` в `useEditorSuggest`. Прогон шага 1 → PASS.

- [ ] **Шаг 3: красные тесты настройки и предпросмотра.** `configure.test.tsx`: «Настроить» у страницы → редактор
  тела страницы (`BodyKindProvider kind="page"`), «Готово» → показ; «Настроить шаблон „Проекты“» с записи, открытой
  шаблоном владельца → редактор шаблона с баннером «Вы правите шаблон — изменится вид всех записей с аспектом
  „Проект“» (подписи из «Шаблон для»); открытый шаблон показывается плашкой «Шаблон для: Проект · предпросмотр на:
  [запись ▾]», по умолчанию — последняя изменённая подходящая запись (`entity.query {ast}`: `and` по аспектам набора,
  `sortBy orbis/updated_at:desc`, `limit 20`), подходящих нет → `this` — сама страница; тело записи в предпросмотре —
  только чтение (редактор не монтируется, `contenteditable` нет); «Предпросмотр на записи…» у страницы без «Шаблон
  для» → выбор записи и тот же показ; ссылка плашки «шаблон не разобран» открывает настройку шаблона. Прогон
  `cd $W/apps/web && bun run test src/features/page/configure.test.tsx > …/t16b.log 2>&1` → FAIL.

- [ ] **Шаг 4: настройка.** Режимы `configure` / `preview` — состояние `DetailScreen` (сброс в `prevIdRef`-блоке).
  `ConfigureView` — `EntityBody` страницы под `BodyKindProvider` (`template`, если «Шаблон для» непуст) +
  `TemplateBanner` + кнопка «Готово». `TemplatePreview` — свой `entity.get` выбранной записи (законно: запись другая, не запись экрана) → `RecordView
  reply={…}` с узлами этого шаблона и
  `readOnlyBody: true` в хосте (`EntityBody` в режиме только чтения рисует первый кадр без подъёма редактора).
  Прогон шага 3 → PASS.

- [ ] **Шаг 5: вес и мутации.** `LayoutFrame`/`RecordBlockStub` живут в ленивом чанке редактора (подключаются из
  `extensions.ts`) — `check-lazy-chunks` и `save.test.tsx` зелёные. Мутации: (а) снять фильтр `kinds` → красный
  «у заметки нет колонок»; (б) предпросмотр без `readOnlyBody` → красный «только чтение»; (в) убрать плашку в
  заметке → красный. Откатить.

- [ ] **Шаг 6: коммит.**
```
cd /Users/birzhan/projects/orbis/.claude/worktrees/pages-slice-1a && git add apps/web/src/features/entity-editor/nodes apps/web/src/features/page
cd /Users/birzhan/projects/orbis/.claude/worktrees/pages-slice-1a && bun run test > /private/tmp/claude-501/pages-1a/t16-full.log 2>&1; echo EXIT=$? && bun run lint > …/t16-lint.log 2>&1; echo EXIT=$? && bun run typecheck > …/t16-tsc.log 2>&1; echo EXIT=$?
cd /Users/birzhan/projects/orbis/.claude/worktrees/pages-slice-1a && bun run --filter @orbis/web build > …/t16-build.log 2>&1 && bun scripts/check-lazy-chunks.ts > …/t16-chunks.log 2>&1; echo EXIT=$?
cd /Users/birzhan/projects/orbis/.claude/worktrees/pages-slice-1a && git commit -m "feat(web): настройка страниц и шаблонов — рамки контейнеров, заглушки обвязки, меню «/» по роду тела, баннер, предпросмотр

Контейнеры и обвязка предлагаются только страницам и шаблонам; в заметке такой блок —
плашка, текст цел. «Смарт-лист» → «Список по запросу». Предпросмотр шаблона на записи —
тело только для чтения.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- apps/web/src
```

### Задача 17: Закрытие — PRD, карта реализации, ранбук, `03-pending.md`, сторож одной копии правил, `handoff-1b.md`

**Зачем:** спека §16 — PRD минимум (`02-core-os`, глоссарий, новое решение), `03-pending.md` после мержа Б-2 (пункты
§16), перенос таблицы §15; §5.9 — одна копия правил маркеров (сторож, чтобы вторая не выросла снова); сверх спеки
(промпт планирования) — факты для автора спеки 1б. PRD ложится одним коммитом с закрытием среза.

**Файлы:**
- Изменить: `docs/prd/02-core-os.md` (экран записи = шаблон хоста; блок запроса = блок данных; страница и шаблон —
  короткий раздел со ссылкой на спеку 1а), `docs/prd/00-product.md` (глоссарий: «Страница», «Блок», «Шаблон»; слово
  «смарт-лист» — пометка «устар., см. страница / блок данных»), `docs/prd/04-decision-log.md` (новое решение —
  следующий свободный номер после D44, на HEAD — **D45**; сверить `grep -n '^### D4' docs/prd/04-decision-log.md`),
  `docs/prd/01-architecture.md` (§7.1 — индекс аспектов и v7; `entity.blocks`/`entity.updateBatch` в перечне
  процедур; формат тела v3; строки про служебность `:340`, `:596` — «служебность прячет из выдач; авторство агентом
  отложено списком `AUTHORING_DEFERRED_ASPECTS`»; числа реестра `:152`, `:314`, `:336`, `:1154`, `:1345` — 14 аспектов,
  79 свойств, тулов 51), `docs/implementation/00-architecture.md` (модули `features/page`, `doc/page-grammar`,
  `doc/placement`, `pages/choose-template`, `routers/entity-blocks`), `docs/implementation/02-ops-runbook.md` (строка
  релиза в таблице `:287`-стиля и чек-лист «Деплой среза 1а (страницы)» после чек-листа Б-2 `:886`),
  `docs/implementation/03-pending.md`.
- Создать: `scripts/grammar-copies.test.ts` (сторож), леджер `$L/handoff-1b.md`, `$L/remainders-1a.md`.

**Интерфейсы:**
- Consumes: всё, что сделали задачи 1–16; `recon-plan-*.md`, `facts.md`, `progress.md`, эрраты плана.
- Produces: документы в состоянии ПОСЛЕ 1а; `handoff-1b.md` — вход автора спеки 1б.

- [ ] **Шаг 1: сторож одной копии правил (РП-6).** `scripts/grammar-copies.test.ts`: предмет — РАЗБОРЩИКИ
  маркеров, не данные: `git grep -nF '\{\{'` по `apps/*/src`, `packages/*/src` без `*.test.*` ловит литералы регэкспов с
  экранированными фигурными скобками (строки сида, примеры `{{query:…}}` в текстах и комментарии регэкспами не являются
  и не ловятся). На `2d4f660` таких литералов пять: `db/audit-bodies.ts:54`, `web/…/browser/query.ts:53`,
  `web/lib/query-blocks/parse.ts:17`, `doc/nodes/query-block.ts:60,64`. После среза разрешены только
  `packages/shared/src/doc/page-grammar.ts`, `packages/shared/src/doc/nodes/query-block.ts` (токенайзер `marked` для
  маркера внутри пункта списка — прежнее поведение), `packages/shared/src/doc/manager.ts` (экранирование) и
  `apps/server/src/db/audit-bodies.ts` (счётчик прошлой конверсии, не разбор) — список с причинами в тесте. Прогон
  `cd $W && bun test scripts/grammar-copies.test.ts > …/t17a.log 2>&1` → PASS (тест `git add` до прогона — Ф-Б2-11); мутация: вернуть копию регэкспа в
  `apps/web/src/features/browser/query.ts` → красный; откатить. Слово «Смарт-лист» в строках интерфейса web — ноль
  (`git grep -n 'Смарт-лист' -- apps/web/src ':!*.test.*'`).

- [ ] **Шаг 1а: перезамер размера промпта.** Задачи 4 и 6 изменили реестр и схемы тулов — повторить
  `cd $W && bun scripts/prompt-size.ts > …/t17size.log 2>&1` и обновить байты в таблице бюджетов `01-architecture.md`.

- [ ] **Шаг 2: PRD и карта реализации** — по «Файлам»; решение D45: «Страницы и шаблоны: страница — запись с
  аспектом `orbis/page`, тело — текст и блоки грамматики v3; любая запись показывается через шаблон (выбор §4.2 спеки
  1а, спор — выбор владельца, запомненный для спора); экран записи — шаблон хоста в поставке; данные блоков — пачкой;
  индекс аспектов в промпте» с обоснованием из спеки 1а §0 и концепции; «Заменяет/уточняет» — концепция §6.2 (ревизия
  3), D43 §Б7-2 (индекс исполнен). Числа — из фактического HEAD, не из плана.

- [ ] **Шаг 3: ранбук.** Чек-лист «Деплой среза 1а (страницы)» — порядок задачи 19 одним списком: `ping` → `check`
  (ожидаемый дрейф поимённо: аспект `orbis/page` «нет в базе», свойства `orbis/template_for`,
  `orbis/template_wins_over` «нет в базе», `orbis/progress_source` «расходится» — схема Q-AST) → `census-v3` (числа
  владельцу, СТОП до слова) → `census` → бэкап → `seed-registries` → `check` чистый → деплой СРАЗУ (окно — простой,
  РП-2; при одном мерже деплой делает автодеплой пушем в `main`, Ф-1а-23) → `/health` → смоук («Обновить» сервис-воркера; живая приёмка владельца). Миграций нет.

- [ ] **Шаг 4: `03-pending.md`.** По спеке §16: §С8-35 пп. 1–2 закрыты `c04b17e` (26.08), п. 3 — срезом 1а
  (задача 1); «остаток Б-3» — по §15 спеки (пять гардов В10, §С5, §С4, Б7-1/Б7-3); таблица §15 спеки — новым
  подразделом §2.3 («перенесено из 1а»); «12 точек модульных гейтов web» → «3 закрыты, 7 открыты — 1б». Новое в §1
  (живые проверки при кредитах): §С8-30 — `bun scripts/probe-p3.ts --variant=index|catalog …` (готово к прогону);
  токены бюджетов — `bun scripts/prompt-size.ts --tokens`. В §2 — ответы на В-1…В-7 (если владелец ответил) или
  «исполнено по умолчанию» с ценой; риск В-6 (канал `propose`-рутины без инструкций). Строки остатков Б-2 с адресатом
  «страницы-1», не закрытые 1а (РП-19), — «→ 1б».

- [ ] **Шаг 5: леджер.** `$L/remainders-1a.md` — всё отложенное среза одним документом (форма `remainders-b2.md`):
  общий дефект «самоссылка `ref` — сырая ошибка БД» (Ф-1а-3), граница проверки «ни слова о выключенных» (канал, но не
  `routine-v3` и не описание `entity_query` — задача 1 ш. 9), подсказка «запрашивай явно через aspect=orbis/agent-run»,
  ушедшая с инструкцией из канала, столкновение двух `aggregate` в `progress_source` (задача 6), `AUTHORING_DEFERRED_ASPECTS` (снимает срез 2),
  отступления §11.2 спеки, эрраты. `$L/handoff-1b.md` (сверх спеки, требование промпта планирования):
  1. итоговые имена: узлы `columns`/`column`/`tabs`/`tab`/`recordBlock`/`aspectCard`, `RECORD_BLOCK_NAMES`,
     примитивы web (`RECORD_BLOCK_COMPONENTS`, `DataBlock` и формы, `Renderer`, `RecordView`, `PageView`);
  2. где лежит шаблон хоста (`apps/web/src/features/page/host-template.ts`, `HOST_TEMPLATE_TEXT`) и как разбирается
     (`parsePageText` листового `@orbis/shared/doc/page-grammar`, при загрузке модуля; проблемы — `bodyIssues`);
  3. форма функции выбора (`chooseTemplate`, `contendersOf`, `recordDisputeChoice` — сигнатуры дословно) и где её
     зовёт клиент;
  4. ручка пачки данных (`entity.blocks` — вход, ответ, потолки, почему POST) и пачки правок (`entity.updateBatch`);
  5. что осталось от «аспект → карточка» в коде хоста (`OWN_ASPECT_CARDS` в `features/entity-detail/own-cards.tsx` —
     пять аспектов; финансовая карточка — кандидат в Бюджет 1б);
  6. новый HEAD `main` после задачи 17 и число тестов;
  7. что 1б наследует открытым: `AUTHORING_DEFERRED_ASPECTS`, счётчики закреплённых (второй путь данных), нижний
     `TabBar`, правка шаблона хоста, 13 строк остатков Б-2 «страницы-1».

- [ ] **Шаг 6: коммит (в ветке; закрытие — по протоколу, `main` не трогается).**
```
cd /Users/birzhan/projects/orbis/.claude/worktrees/pages-slice-1a && git add scripts/grammar-copies.test.ts
cd /Users/birzhan/projects/orbis/.claude/worktrees/pages-slice-1a && bun run test > /private/tmp/claude-501/pages-1a/t17-full.log 2>&1; echo EXIT=$? && bun run lint > …/t17-lint.log 2>&1; echo EXIT=$?
cd /Users/birzhan/projects/orbis/.claude/worktrees/pages-slice-1a && git commit -m "docs: срез «Страницы, срез 1а» — PRD (D45), карта реализации, ранбук деплоя, 03-pending; сторож одной копии правил маркеров

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" -- docs/prd docs/implementation scripts/grammar-copies.test.ts
```

### Задача 18: Финальное ревью ветки и фикс-волна

**Зачем:** поштучные гейты не видят сквозных осей: одна конструкция грамматики от текста до пикселя (препроход →
узел → печать → рендер → редактор → дифф Ш1), одна запись от выбора шаблона до Undo выбора, один блок данных от
текста до строки ответа пачки. Ревью — после задачи 17 и ДО первой прод-команды задачи 19 (фикс после прода стоил бы
отката). Исполнитель — координатор: собирает пакет, диспатчит, ведёт учёт; код появляется только в фикс-волне.

**Файлы:**
- Создать (леджер `$L/final/`): `final-review-pack.md`, `area-{A,B,C}.diff`, `paths-{A,B,C}.txt` (разбиение без
  пропусков и пересечений), `review-{A,B,C}.md`, `review-mutations.md`, `review-fable.md` (вторая линза),
  `refute-<id>.md` (по одному на Critical/Important), `dispatch-final-fix.md`, `fix-wave.diff`, `fix-wave-report.md`,
  `fix-wave-review.md`.
- Изменить: код — только фикс-волной по находкам; `progress.md` — учёт ревью.

**Интерфейсы:**
- Consumes: `BASE_1A` — sha `main` до среза (запись задачи 1 в `progress.md`); `$L/make-review-pack.sh`; спека,
  план, `facts.md`, `recon-plan-*.md`.
- Produces: APPROVE гейта фикс-волны; HEAD ветки = `main` после фикс-волны; сводка находок.

- [ ] **Шаг 1: пакет.** `git diff --stat $BASE_1A..HEAD`; области: **A** — `packages/shared` (реестр, выбор,
  запрос, документ); **B** — `apps/server`, `scripts` (промпт, пачки, операция корпуса, стенд); **C** — `apps/web`.
  Пакет — по шаблону оркестратора; в промпте ревьюера обязательны строки «дифф — карта, не доказательство» и
  «перечисли, что ДОЛЖНО было измениться, но не изменилось».
- [ ] **Шаг 2: три ревьюера областей** (`model: opus`), линзы: A — грамматика без потерь (С1а-1), матрица мест,
  выбор шаблона, `registry_ref` списком; B — одна транзакция и изоляция ошибок пачки, Undo пачки правок, индекс и две
  проверки промпта, окно «сид → деплой»; C — вес экрана (`DetailScreen ↛ doc`), снимок против эталона, запись в
  граф только существующими путями и `updateBatch`, словарь концепции в интерфейсе.
- [ ] **Шаг 3: мутационный ревьюер** (`model: opus`): десять сторожей С1а-10 — выбор шаблона, матрица §5.5, «ноль
  инструкций», изоляция ошибки блока, круг грамматики, снимок экрана, одна пачка данных, один Undo, абсолютные даты,
  одна копия правил — каждый краснеет при поломке защиты (мутация деливерабла, не пина, Ф-Б2-6).
- [ ] **Шаг 4: вторая линза Fable** (`model: fable`, по усмотрению координатора — рекомендовано): сквозные оси из
  «Зачем».
- [ ] **Шаг 5: опровержение.** Каждая Critical/Important — отдельный опровергатель (`model: opus`) пробоем по коду;
  ложные — записью в `facts.md`.
- [ ] **Шаг 6: фикс-волна** одним имплементером (`model: opus`) по `dispatch-final-fix.md`; гейт фикс-волны
  (`model: opus`); полный прогон, `lint`, `typecheck`, `test:rls`, перф в порядке Ф-Г-75, сборка +
  `check-lazy-chunks`, `check-legacy-form --gate`. Push ветки ради CI (`main` не трогается, Ф-1а-23). **ЖЁСТКАЯ ОСТАНОВКА:** задача 19 — только
  отдельным словом владельца.

### Задача 19: Прод-процедура среза 1а, живая приёмка владельца, итог

**Зачем:** весь срез в ветке `pages-slice-1a` и отревьюирован, `main` и прод — на коде до 1а, реестр без аспекта
`orbis/page`. Порядок «данные ДО кода» (урок D42): пересев, сразу мерж в `main` — автодеплой выкатывает сам (Ф-1а-23);
окно между ними — простой на время сборки (Ф-1а-2, РП-2). Миграций нет, `reset-world` не нужен (сид аддитивен). До пересева владелец видит числа корпуса (§5.9) и
отвечает словом. **Исполняется только вместе с владельцем.**

**Файлы:**
- Изменить: `docs/prd/04-decision-log.md` — статус D45 «и в проде <дата>» (`render.yaml` не трогается — Ф-1а-23).
- Создать (леджер): `$L/step-prod-1a.md` (сценарий — ДО первой команды; образец — задача 20 плана Б-2 и чек-лист
  ранбука задачи 17), `$L/acceptance-1a.md`.
- Дописать: `progress.md` (хроника и «ИТОГ СРЕЗА 1а»).

**Интерфейсы:**
- Consumes: `scripts/ops.ts` — `ping`, `check`, `census`, `census-v3` (задача 8), `seed-registries`; Render MCP
  (`srv-d9781kvavr4c73d85r60`, workspace `tea-d93srfq8qa3s73bdfka0`); `gh workflow run backup.yml`.
- Produces: прод на коде 1а; `acceptance-1a.md` — С1а-1…10 + живая приёмка 1–4 + смоук.

> **Ловушки обвязки (Б-1, Б-2).** (1) cwd сбрасывается — свой `cd` в каждом `git`/`gh`. (2) Голый
> `bun scripts/ops.ts …` без `cd &&`/пайпов (allow-правило матчит только голую команду). (3) Каждая прод-команда —
> отдельный вызов.

- [ ] **Шаг 1:** сценарий `$L/step-prod-1a.md` из чек-листа ранбука; ожидания каждого шага выписаны ЗАРАНЕЕ.
- [ ] **Шаг 2:** предпроверки веток: ветка перебазирована на свежий `origin/main` (ff-мерж возможен); CI ветки зелёный
  (`gh run list --branch pages-slice-1a --limit 3`); финальное ревью закрыто (`ls $L/final/` — APPROVE);
  `mcp__render__get_service` → `autoDeploy: "yes"`, `branch: main`.
- [ ] **Шаг 3:** локально — `test:perf:volume` → `test:perf:explain` → `test:perf:graph` ×3 → `test:perf` → `test` →
  `test:rls` → `check-legacy-form --gate` → сборка web + `check-lazy-chunks` (засчитывается прогон задачи 18, если
  HEAD не двигался — записать явно).
- [ ] **Шаг 4:** `bun scripts/ops.ts ping` → PostgreSQL 17.x.
- [ ] **Шаг 5:** `bun scripts/ops.ts check` → EXIT 1 закономерен; дрейф ровно ожидаемый (шаг 3 задачи 17: аспект и
  два свойства «нет в базе», `orbis/progress_source` «расходится»); иное — СТОП.
- [ ] **Шаг 6:** `bun scripts/ops.ts census-v3` → счётчики «станут блоками», `display=table`, `display=list`, «без
  документа» и id — **владельцу; СТОП до его слова** (§5.9, В-3). `bun scripts/ops.ts census` → «тел всего: N».
- [ ] **Шаг 7:** бэкап — `cd /Users/birzhan/projects/orbis && gh workflow run backup.yml`, дождаться `success`.
- [ ] **Шаг 8:** `bun scripts/ops.ts seed-registries` → «свойств 79 … аспектов 14 …», версия system-реестров +1,
  конфликтов слияния нет. **С этого момента старый код отвечает 500 на всём, что читает реестр** (Ф-1а-2) — шаг 9
  немедленно.
- [ ] **Шаг 9:** мерж и деплой (Ф-1а-23): ff-пуш ветки в `main` (`cd /Users/birzhan/projects/orbis && git push origin
  pages-slice-1a:main`) → автодеплой запускает сборку → `mcp__render__list_deploys`/`get_deploy` до `live`; коммит =
  HEAD `main`. Время окна (сид → live) — в `progress.md`. Вариант сокращения окна (решить с владельцем в шаге 1):
  пуш ДО шага 8, пересев — когда деплой перейдёт из сборки в выкатку.
- [ ] **Шаг 10:** `bun scripts/ops.ts check` — шесть `✓`; `census` — то же N; `curl -s https://orbis-64q4.onrender.com/health`
  — `status: ok` без `registryDrift`.
- [ ] **Шаг 11:** СНЯТ рулингом Ф-1а-23 (автодеплой не выключался).
- [ ] **Шаг 12: смоук и живая приёмка владельца** (Chrome владельца; после деплоя веб просит «Обновить» — сервис-воркер):
  (1) страница «Утро» написана руками, блоки показывают данные, в сети — один `entity.blocks` на окно; (2) шаблон для
  «проект», проект открывается им; (3) спор «проект + задача» — выбор, плашка больше не появляется; (4) «Изменить вид
  только этой записи». MCP-клиент (переподключить): список тулов без `attach_orbis_page`, число тулов прежнее. Чат с
  моделью (индекс в промпте) — «НЕ ВЫПОЛНЕН по кредитам», если кредитов нет.
- [ ] **Шаг 13:** `acceptance-1a.md` — таблица «№ | приёмка | носитель | исход | ссылка» по С1а-1…10 (носители —
  маппинг (б) плана) + живая приёмка + смоук; невыполнимое — «НЕ ВЫПОЛНЕН» с причиной.
- [ ] **Шаг 14:** статус D45 «и в проде <дата> (`main <хеш>`)» — docs-коммит в `main`; итог в `progress.md` (что в
  проде, счёт ревью, остатки владельцу, уроки); `git worktree remove .claude/worktrees/pages-slice-1a` (ветка
  остаётся); доклад владельцу.

---

## Эрраты спеки (спеку правит владелец ревизией; план исполняет по правой колонке)

| # | Адрес спеки | Что опровергнуто | Предложенная правка |
|---|---|---|---|
| Э-1 | §3.1 «Служебный в 1а (`service: true`)», §12 «Служебный аспект не даёт `attach_*`» | флаг `service` прячет записи аспекта из ВСЕХ выдач компилятора (`compile-ast.ts:795-800,851-862`; PRD `01-architecture.md:340,596`) — страница пропала бы из Browser, Повестки, смарт-листов | §3.1: «Не предлагается модели в 1а: нет `attach_orbis_page`, нет строки индекса — временным списком `AUTHORING_DEFERRED_ASPECTS`; флаг `service` не ставится (он прячет записи из выдач)». §12: «аспект из этого списка не даёт `attach_*` → эталон тулов не меняется» (РП-1, В-1). §11.2 (дополнено исполнением, задача 4): новая строка реестра временных отступлений — «`AUTHORING_DEFERRED_ASPECTS` (`packages/shared/src/constants.ts`): аспект `orbis/page` модели не предлагается (нет `attach_*`, нет строки индекса), его `aiInstructions` модель не видит; core-тулы запись аспекта технически принимают; снимает срез 2» |
| Э-2 | §5.4 `columns=[…]`, `aggregate=sum(…)`, голый `hide_empty` | разделитель грамматики — запятая и пробел (`parse-ast.ts:213-229`), скобок нет (`:1168-1178`) | примеры §5.4: `columns=orbis/due_date\|orbis/priority`, `aggregate=sum:orbis/amount`, `aggregate=latest:orbis/weight`; `hide_empty` — голое слово (РП-4); фраза «списки в квадратных скобках» → «списки через `\|`, как в `sortBy` и `tags`» |
| Э-3 | §5.9 «проверка корпуса: … `display=table`» | `display=list` стоит в сиде смарт-листов и телах проектов (`seed/smart-lists.ts:30-116`, `seed/project-body.ts:39-47`) — чтение `display` меняет и их | «…блоки с `display=table` и `display=list`, которые начнут рисоваться таблицей и строками» (РП-5, В-3) |
| Э-4 | §6.3 «Сервер исполняет пачку в одной транзакции» | ленивая материализация повторов идёт МЕЖДУ транзакциями (`with-materialization.ts:42-72`), как у `entity.query` сегодня | «…в одной транзакции исполнения; материализация повторов, если нужна, — до неё своей транзакцией, как у `entity.query`» |
| Э-5 | §10 п. 3 «Перезамер бюджетов промпта» | токены мерятся только живым вызовом провайдера (`.superpowers/probe/p3/size.ts:24-35`) — кредитов нет | «перезамер: байты — в срезе; токены — живым замером при кредитах (реестр живых проверок)» (РП-17, В-7) |
| Э-6 | §10 п. 1 «`ai_instructions` остаются только в `attach_*`» | у рутины в режиме `propose` тулов `attach_*` нет (`tools/registry.ts:136,200-218`) — инструкций в её канале не будет нигде | сноска: «канал `propose`-рутины получает только индекс; риск — в реестре остатков» (В-6) |
| Э-7 | §13 С1а-6 «существующим перф-гейтом web» | перф-гейта web с порогом нет (`recon-plan-4` T2): есть `check-lazy-chunks`, `save.test`, тест «первый кадр без запросов» | «…не медленнее сегодняшнего: сторож веса чанка (`check-lazy-chunks`), множество запросов при открытии против эталона, серверные пороги `entity.backlinks` и `goal.progress` (оба — `entity.get` экрана), размер чанка до/после» (РП-11) |
| Э-8 | §3.2 таблица свойств, правило «`template_wins_over` непуст → `template_for` непуст» | `present([])` истинно (`apps/server/src/expr/eval.ts:625-627`) — на пустом «Шаблон для» правило промолчало бы; `has` истинен на `[]` | тип `orbis/template_for` — `registry_ref {target: aspect}`, список, `minItems: 1`; очистка — снятием значения |
| Э-9 | §5.9 «копии правил… регэкспы ссылок» | форма ссылок `[[entity:…]]` не меняется — правка регэкспов ссылок не нужна; копия правил МАРКЕРОВ — `bodySegments`/`firstQueryBlock` web (`features/browser/query.ts:56-97`) | «…разборщик первого кадра заменяется общим листовым препроходом (одна копия правил маркеров); регэкспы ссылок не меняются» (РП-6) |
| Э-10 | §4.3 «x.«главнее, чем» ∪= M \ {x}» | `assertRefValue` проверяет все id значения (`ref.ts:139-170`) — архивный шаблон в списке отвергнет всю пачку | «…при записи выбора из «Главнее, чем» вычищаются шаблоны вне текущего списка (архивные, снятые)» (РП-21) |
| Э-11 | §8.4, С1а-8 «случаи 1–2: до/после совпадают визуально» | запись-страница показала бы в `{{cards}}` лишнюю карточку «Страница» | «на показе страницы своим телом `{{cards}}` не рисует карточку самого аспекта «страница»» (РП-25) |
| Э-12 | Приложение А (адреса) | сдвиги после Б-2: `HIDDEN_ASPECT_CARDS` `:42`→`:41`; `buildToolDefs` `:1387-1396`→`:1441-1463`; гейт версии `executor.ts:2216-2220`→`:2384-2390`; `normalize.ts:20`→`:25`; `buildContext` `:534-605`→`:534-572`; бюджеты `:1088-1100`→`:1090-1100`; `compile-ast.ts:909,934,945`→`:909-911,930-937,941-948`; `bodySegments` `:53-77`→`:63-78`; процедуры `aspects.attach` нет (путь — `entity.update {aspects:{attach}}`); `orbis/assignment` не служебный | справочно; спека адресов не пиннит |
| Э-13 | §8.4 случай 1 «Текста у записи нет → только копия шаблона» | копия шаблона со строкой `{{body}}` на странице даёт плашку `BLOCK_MISPLACED` (§5.5) — «выглядит как раньше» не выйдет | «…копия шаблона без блока `{{body}}`» (РП-29, В-11) |
| Э-14 | §6.4 «Он берёт только включения, нужные блокам выбранного шаблона: нет `{{backlinks}}` — обратные ссылки не грузятся» | шаблон выбирается по аспектам записи, которые известны только после её чтения: сужение включений стоит второго запроса на каждое открытие страницы или записи со своим шаблоном (против «без лишнего запроса» §6.5 и С1а-6) | «Данные для блоков обвязки — один запрос записи `this` (сегодняшний `entity.get` экрана)»; сужение — при появлении выбора шаблона на сервере (РП-13, В-9) |

## Маппинг (а): нормативные утверждения спеки §3–§14 → задача и шаг

| § | Утверждение | Задача / шаг |
|---|---|---|
| 3.1 | `orbis/page` — встроенный, ядро, `module: null` | 4 / ш. 2 |
| 3.1 | нет `attach_orbis_page`, нет строки индекса | 4 / ш. 2, 4 (РП-1, Э-1) |
| 3.1 | интерфейс навешивает аспект своим путём, не тулом | 15 / ш. 2–3 («Сделать страницей» через `updateBatch`) |
| 3.1 | навешенный аспект — показ своим телом, тело побеждает шаблон | 5 / ш. 1 (`own-body`); 13 / ш. 2 |
| 3.1 | карточка «страница» генерически; контрол «несколько аспектов» | 4 / ш. 5 |
| 3.2 | «Шаблон для» — `registry_ref {aspect}` списком | 4 / ш. 2 (Э-8) |
| 3.2 | «Главнее, чем» — `ref` списком на записи с `orbis/page` | 4 / ш. 2 |
| 3.2 | правило «Главнее, чем» → «Шаблон для» | 4 / ш. 2–3 |
| 3.2 | самоссылка в «Главнее, чем» запрещена | 4 / ш. 2–3 |
| 3.2 | снятие «Шаблон для» той же пачкой снимает «Главнее, чем» | 15 / ш. 2; 4 / ш. 5 (карточка последний аспект не снимает — РП-27) |
| 3.2 | `cardinality` на `registry_ref` — сквозной конфиг, сверка с правилом «≥ 2» | 4 / ш. 2 (проба 2) |
| 3.2 | дом, размещения, параметры, эталон не заводятся | 4 (свойств ровно два — пин `A8`) |
| 4.1 | хранимого выбора на записи нет | 5 (функция без состояния записи); 15 / ш. 3 (режимы «открыть через» не запоминаются) |
| 4.2 | одна чистая функция в `@orbis/shared` | 5 / ш. 2 |
| 4.2 | вход: аспекты записи, шаблоны без архивных (id, набор, «Главнее, чем», дата) | 5 (`templatesFromRows`); 14 / ш. 3 (список — компилятор исключает архивные) |
| 4.2 | шаги 1–6 | 5 / ш. 1–2 |
| 4.2 | шаг 7: сломанный исключается, плашка со ссылкой на настройку | 5 / ш. 1; 9 / ш. 1 (`templateBrokenReason`); 14 / ш. 1, 3; 16 / ш. 3 (ссылка → настройка) |
| 4.2 | шаг 8: базовый вид записи | 14 / ш. 1, 3 |
| 4.3 | плашка спора, подпись из объединения наборов | 14 / ш. 1, 3 |
| 4.3 | выбор одной пачкой, один Undo, формулы ∪= и вычёркивание | 5 / ш. 2; 10 / ш. 3–4; 14 / ш. 1 (Э-10) |
| 4.3 | экран переключается сразу, плашка не появляется ни здесь, ни на других | 14 / ш. 1 |
| 4.3 | новый участник → плашка; противоречие → плашка | 5 / ш. 1 |
| 4.3 | «Сменить выбор шаблона для таких записей» | 15 / ш. 2 |
| 4.3 | выбор — свойство шаблона в данных графа | 4 / ш. 2; 14 / ш. 3 |
| 5.1 | одна грамматика; `body_doc` — правда, `body` — печать; `{{…}}` с начала строки, маркер на своей строке | 7 / ш. 2; 8 / ш. 2 |
| 5.2 | контейнеры с закрытием; внутри — только части; глубина ≤ 2; 2–4 колонки, 1–8 вкладок | 7 / ш. 1–2 |
| 5.2 | на узком экране колонки столбиком | 13 / ш. 1–2 |
| 5.3 | девять блоков обвязки + `{{card: X}}` | 7 / ш. 1; 8 / ш. 2; 12; 13 / ш. 2 |
| 5.3 | `{{card: X}}` — ключ или подпись, печать ключом; ничего, если аспекта нет | 8 / ш. 1–2; 12 / ш. 1 |
| 5.3 | `{{body}}` в шаблоне не больше одного | 9 / ш. 1 |
| 5.4 | настройки показа в проекции запроса; второй записи нет | 6 / ш. 2 |
| 5.4 | `display` compact/list/table/tile; начинает читаться | 6 / ш. 2; 11 / ш. 3 |
| 5.4 | `aggregate` обязателен при `tile` и только при нём | 6 / ш. 1 |
| 5.4 | `columns` только при `table`; без него — строка фактов | 6 / ш. 1; 11 / ш. 1 |
| 5.4 | `hide_empty` прячет только честно пустое | 11 / ш. 1 |
| 5.4 | формы списков | 6 / ш. 1 (Э-2) |
| 5.4 | старые `{{query:…}}` читаются как раньше | 6 / ш. 1 (корпус `ast-fixtures`); 11 / ш. 4 (тесты заметок) |
| 5.5 | матрица «где работают блоки» | 9 / ш. 1; 13 / ш. 1; 16 / ш. 1–2 |
| 5.5 | в заметке такой блок не рисуется — плашка, текст сохраняется | 11 / ш. 4 (первый кадр); 16 / ш. 1–2 (редактор) |
| 5.6 | абсолютная дата на странице/в шаблоне — ошибка с подсказкой; в заметке разрешена | 6 / ш. 3; 9 / ш. 1; 11 / ш. 1 |
| 5.7 | примитивы хоста без префикса; незнакомая форма остаётся текстом | 7 / ш. 1 |
| 5.8 | ни одна ошибка не теряет текст (`rawBlock`), плашка с причиной; перечень ошибок | 7 / ш. 1; 8 / ш. 1–2; 9 / ш. 1; 13 / ш. 1 |
| 5.8 | шаблон с ошибкой разбора не разобран | 9 / ш. 1; 14 / ш. 1 |
| 5.9 | `DOC_SCHEMA_VERSION` 2 → 3 без смены узлов | 8 / ш. 1–2 |
| 5.9 | старые вкладки — отказ на сохранении; черновики защищены | 8 / ш. 3, 5 |
| 5.9 | дифф Ш1 видит контейнеры и части единицами | 8 / ш. 1–2 |
| 5.9 | новые узлы во все копии правил (`KNOWN_*`, `strip-ids`, первый кадр, регэкспы) | 8 / ш. 2, 5; 11 / ш. 4; 17 / ш. 1 (Э-9) |
| 5.9 | проверка корпуса до выкатки — посчитать и показать владельцу | 8 / ш. 4 (`census-v3`); 19 / ш. 6 (Э-3) |
| 6.1 | рендерер показа — страницы и шаблоны, без случайной правки; редактор — тело записи и настройка; компоненты блоков одни | 13; 16; 11 (`DataBlock` в обоих) |
| 6.2 | `{{body}}` — редактор тела `this` с первым кадром, плашками тела, предложениями Ш1 | 12 / ш. 2 (`EntityBody` целиком); 14 / ш. 3 |
| 6.2 | в предпросмотре шаблона тело только для чтения | 16 / ш. 3–4 |
| 6.3 | один способ данных для всех блоков; пачка клиента; правленый блок — пачкой из одного | 11 / ш. 1–2 |
| 6.3 | сервер: одна транзакция под идентичностью, по блоку строки/число/ошибка, «ещё N» | 10 / ш. 1–2 (Э-4) |
| 6.3 | потолок пачки 30; строки — `limit` и потолок сервера | 10 / ш. 1; 11 / ш. 1 |
| 6.3 | агрегаты — существующие компиляторы | 10 / ш. 2 |
| 6.3 | редактор заметок не меняется; касание закрыто тестами существующих смарт-листов | 11 / ш. 4 |
| 6.3 | счётчики закреплённых — отдельный вызов | 11 / ш. 4 (`PinnedList` зовёт `entity.count` как раньше) |
| 6.4 | `this` по таблице (шаблон, страница, предпросмотр, тело в шаблоне, редактор) | 14 / ш. 3; 13 / ш. 1; 16 / ш. 3; 12 / ш. 2; 16 / ш. 4 |
| 6.4 | данные обвязки — один запрос `this`; «только включения, нужные блокам» | 13 / ш. 1–2 (один запрос; сужение — Э-14, В-9) |
| 6.5 | ошибка блока — плашка, соседи работают, пустоты вместо ошибки нет | 10 / ш. 1; 11 / ш. 1 |
| 6.5 | свежесть — прежняя инвалидация | 11 / ш. 1 (ж), ш. 4 |
| 6.5 | шаблон хоста в поставке, экран без лишнего запроса; список шаблонов один раз и обновляется | 14 / ш. 1, 3 (РП-14) |
| 7.1 | `columns` (телефон — столбиком), `tabs` (`ui/Tabs`) | 13 / ш. 2 |
| 7.2 | `compact` (строки открывают), `list` (`EntityRow`, статус неактивен), `table`, `tile` (деньги по валюте), «ещё N» | 11 / ш. 1, 3 (РП-20) |
| 7.3 | примитивы обвязки, разрез `AspectCards`, свои карточки списком, `Blocks` → `Blockers`, теги | 12 / ш. 1–2 |
| 7.4 | «смарт-лист» уходит; пункт «/» — «Список по запросу» | 16 / ш. 2; 17 / ш. 1 |
| 8.1 | текст шаблона хоста в поставке, тем же разборщиком и рендерером, не правится | 14 / ш. 1, 3 |
| 8.2 | три намеренных отличия; иное — дефект | 14 / ш. 1–2 (`INTENDED_1A`) |
| 8.3 | дописывание карточек; базовый вид записи | 13 / ш. 2; 14 / ш. 1, 3 |
| 8.4 | пункты записи: «Открыть через шаблон хоста», «Открыть через „X“», «Изменить вид только этой», «Сменить выбор», «Сделать страницей» | 15 / ш. 2–3 |
| 8.4 | «Настроить шаблон „X“» | 16 / ш. 3–4 |
| 8.4 | «Изменить вид только этой» — одна пачка, один Undo, три случая, вопрос Р-19 | 15 / ш. 1–2 (Э-11) |
| 8.4 | пункты страницы: «Настроить», «Предпросмотр на записи…» | 16 / ш. 3–4 |
| 8.4 | пункты страницы: «Открыть как запись», «Сделать шаблоном для…», «Перестать быть страницей» | 15 / ш. 2–3 (РП-22) |
| 9.1 | «Настроить» — тот же редактор; контейнеры рамками; обвязка заглушками; блоки данных живые; «/» по роду тела; «Готово» | 16 / ш. 1–4 |
| 9.2 | баннер шаблона с подписями из «Шаблон для» | 16 / ш. 3 |
| 9.3 | предпросмотр: плашка, последняя изменённая подходящая запись, иначе сама страница; черновик — «Предпросмотр на записи…»; тело только чтение | 16 / ш. 3–4 |
| 10 п. 1 | индекс вместо инструкций; `rank`; маска; инструкции только в `attach_*`; пин перевёрнут; v7 — решает план | 1 / ш. 6–10 (РП-3, РП-16) |
| 10 п. 2 | две проверки собранного промпта | 1 / ш. 9 |
| 10 п. 3 | перезамер бюджетов слоёв 1 и 5 после Б-2, таблица `01-architecture` | 3 / ш. 3–4 (Э-5) |
| 10 п. 4 | стенд §С8-30 до «готово к прогону» | 3 / ш. 1–2 |
| 10 | фильтр `contract` и Б7-1/Б7-3 — не делаются | самопроверка (правок `property-catalog.ts` нет) |
| 10 | запись `03-pending` о §С8-35 пп. 1–2 устарела — поправить | 17 / ш. 4 |
| 11.1 | ничего нового мимо действий; прежняя правка экрана как есть; без чекбокса в строках | глобальные ограничения; 12 / ш. 2; 11 / ш. 1; 15 / ш. 3 |
| 11.2 | реестр временных отступлений | 4 / ш. 2 (докблок списка); 17 / ш. 5 |
| 11.3 | настройки показа в проекции — `entity_query` их игнорирует | 6 / ш. 4 |
| 12 | миграций нет; найденная — стоп | глобальные ограничения (Ф-1а-5) |
| 12 | расширения типов; аспект №14 ломает пины «13» | 4 / ш. 1, 4 |
| 12 | пересев реестра до кода | 19 / ш. 8–9 (РП-2) |
| 13 | живая приёмка владельца 1–4 | 19 / ш. 12 |
| 14 | первая задача — индекс | 1 |
| 14 | выкатка: остановка перед продом, `main` не меняется до конца среза (Ф-1а-23), пересев до кода, подъём версии клиента | 18 / ш. 6; 19; 8 / ш. 5 |

## Маппинг (б): приёмка С1а-1…10 → задача и шаг

| № | Приёмка | Носитель |
|---|---|---|
| С1а-1 | Грамматика без потерь: разбор → печать → разбор; ошибки §5.8 — с сохранением текста | 7 / ш. 1 (препроход, байт-в-байт); 8 / ш. 1 (`convert.test.ts`, каждая конструкция и шаблон хоста); 6 / ш. 1 (проекция) |
| С1а-2 | Матрица §5.5 разбором и рендером; плашка в заметке | 9 / ш. 1; 13 / ш. 1; 11 / ш. 4; 16 / ш. 1 |
| С1а-3 | Таблица случаев выбора §4.2–4.3 | 5 / ш. 1; 14 / ш. 1 |
| С1а-4 | N блоков → один запрос, одна транзакция; изоляция ошибки; `hide_empty` не прячет ошибку; `this` по §6.4; «ещё N» | 10 / ш. 1; 11 / ш. 1; 13 / ш. 1 |
| С1а-5 | Снимки до/после на 13 аспектах и сочетаниях; расхождения — только §8.2 | 2 (эталон); 12 / ш. 3 (разрез не меняет); 14 / ш. 1–2 |
| С1а-6 | Экран записи не медленнее | 1 / ш. 4 (база); 14 / ш. 4 (РП-11, Э-7); 10 / ш. 5 |
| С1а-7 | Ноль `ai_instructions` в промпте чата и рутин; две проверки; golden; перезамер записан | 1 / ш. 8–9; 3 / ш. 3–4 |
| С1а-8 | «Изменить вид только этой»: случаи 1–2 визуально; случай 3 — вопрос, обе ветки и отмена; одна пачка, один Undo | 15 / ш. 1–2 (сравнение через `bodyBecameText`, РП-29) |
| С1а-9 | Абсолютные даты: ошибка на странице и в шаблоне; в заметке работает | 6 / ш. 3; 9 / ш. 1; 11 / ш. 1; 14 / ш. 1 (заметка под шаблоном — данные, страница — плашка) |
| С1а-10 | Мутационная проверка ключевых сторожей | 1 / ш. 11; 4 / ш. 6; 5 / ш. 3; 6 / ш. 5; 7 / ш. 4; 8 / ш. 6; 9 / ш. 3; 10 / ш. 6; 11 / ш. 6; 12 / ш. 4; 13 / ш. 4; 14 / ш. 5; 15 / ш. 4; 16 / ш. 5; 17 / ш. 1; 18 / ш. 3 |

## Маппинг (в): открытые пункты §18 спеки → где решены

| Пункт §18 | Решение | Где |
|---|---|---|
| Нужна ли v7 промпта | да: `v6.ts:70` ссылается «ниже» на снятую секцию (Ф-1а-12) | РП-3, задача 1 / ш. 8 |
| Потолок пачки и форма «ещё N» | 30 блоков (`BLOCKS_BATCH_CAP`); `limit + 1`, `count` только при переполнении; `limit` ≤ 500 | РП-8, задача 10 / ш. 1–2 |
| Точные токены проекции и коды ошибок §5.8 | `display=tile`, `aggregate=count\|sum:x\|latest:x`, `columns=a\|b`, `hide_empty`; коды `GRAMMAR_ERROR_CODES` + `BLOCK_MISPLACED`, `SECOND_BODY`, `ABSOLUTE_DATE`, `QUERY_INVALID` | РП-4, задачи 6, 7, 9 |
| Техника рендерера | дерево листового препрохода → React; текст — `Markdown` первого кадра; без схемы документа в чанке экрана | РП-6, задача 13 |
| Сверка `cardinality` на `registry_ref` с правилом словаря; `ref`-список на страницы | сквозной конфиг (текст словаря `types.ts:4-9`), не новый kind; цель `{filter:{aspect:'orbis/page'}}` статична | проба 2, задача 4 / ш. 2 |
| Где живёт выбор шаблона при споре, кроме плашки и «⋯» | в карточке «Страница» — «Главнее, чем» генерически ТОЛЬКО чтением (`ref`-список → `readonly`); правка — плашкой спора и «Сменить выбор» | задача 4 / ш. 5; 14; 15 |
| Корпус: сколько тел затронут v3 и `display=table` | операция `ops census-v3` (+ `display=list`, Э-3); числа — на проде до пересева, владельцу | задача 8 / ш. 4; 19 / ш. 6 |
| Перф-гейт: какие сценарии экрана сравниваются | 20 фикстур задачи 2 (13 аспектов + 7 сочетаний): множество запросов; серверные `entity.backlinks`, `goal.progress`; размер чанка `DetailScreen` | РП-11, задачи 2, 14 / ш. 4 |

## Самопроверка плана

Проведена 24.09.2026 по скиллу `writing-plans` над собранным планом.

- **Покрытие спеки.** Маппинг (а) проходит §3–§14 построчно — у каждого нормативного утверждения есть задача и шаг;
  (б) — все десять приёмок; (в) — все восемь открытых пунктов §18. Вне 1а по спеке §2.2/§15 (параметры, кроме
  `this`; встраивание; правка шаблона хоста; оболочка и навигация; формы и действия; фильтр `contract`; группировка;
  обратные ссылки как запрос; токены периодов) — ни одной задачи; проверено отсутствием этих имён в «Файлах».
- **Заглушки.** Скан по «TBD / TODO / реализовать позже / аналогично задаче / добавить обработку ошибок» — ноль в
  разделах задач; места, где имплементер переснимает число прогоном (`probe-p4`, эталон тулов, медианы), названы
  командой и критерием, а не оставлены пустыми.
- **Согласованность имён и типов.** Сверены по задачам: `aspectIndexLines`/`aspectIndexSection`/`ASPECT_INDEX_HEADING`
  (1, 4); `AUTHORING_DEFERRED_ASPECTS`, `PAGE_ASPECT`, `TEMPLATE_FOR_PROPERTY`, `TEMPLATE_WINS_OVER_PROPERTY` (4, 5, 13,
  15); `TemplateCandidate`, `chooseTemplate(subject, templates, isBroken)`, `contendersOf`, `recordDisputeChoice` (5,
  14, 15); `QueryAst.aggregate/columns/hideEmpty`, `absoluteDateIn` (6, 9, 10, 11); `parsePageText`, `PageNode`,
  `RECORD_BLOCK_NAMES`, `GRAMMAR_ERROR_CODES` (7, 8, 9, 11, 13, 14, 15); узлы `columns/column/tabs/tab/recordBlock/
  aspectCard` (8, 16); `bodyIssues`, `templateBrokenReason`, `MISPLACED_HINT`, `BodyKind` (9, 11, 13, 14, 16);
  `entity.blocks`/`BlockResult`/`BLOCKS_BATCH_CAP`, `entity.updateBatch` (10, 11, 14, 15); `useBlockData`,
  `QUERY_BLOCK_KEY`, `BodyKindProvider` (11, 13, 16); `RecordHostProvider`, `RECORD_BLOCK_COMPONENTS`, `AspectCardFor`,
  `RestCards`, `OWN_ASPECT_CARDS` (12, 13, 14); `Renderer`, `PageView` (13–16);
  `HOST_TEMPLATE_TEXT`/`NODES`, `RecordView`, `usePageTemplates`, `DisputePlaque` (14–16); `changeViewPlan`,
  `useUpdateBatch` (15). Эталоны задачи 2 (`STRUCTURE_FIXTURES`, `detail-structure.json`, `detail-requests.json`) —
  потребители 12 и 14.
- **Фокус ревью.** Пять входов раздела «Фокус ревью» имеют тесты в задачах-владельцах: 7 / ш. 1 (п. 1, 2), 11 / ш. 1
  (п. 3), 5 / ш. 1 и 14 / ш. 1 (п. 4), 8 / ш. 3 и 5 (п. 5).
- **Промежуточные состояния.** Формат v3 — одной задачей 8; экран записи до задачи 14 — прежний (РП-23), после — через
  шаблон хоста; страницы до задачи 13 не рисуются своим телом, но и создать их из интерфейса до задачи 15 нельзя
  (модель аспект не видит — РП-1); `main` не меняется до задачи 19 (Ф-1а-23).
- **Известные ограничения плана.** Адреса сняты на `2d4f660` и опровергаемы; числа сьютов, медианы и размер чанка —
  прогоном задачи 1; число пар `probe-p4` и схема эталона тулов — прогоном задач 4 и 6; живой прогон §С8-30 и токены —
  при кредитах.
- **Ревью двумя линзами (24.09).** Opus 5.5 (соответствие спеке и решениям): Critical 0, Important 6, Minor 10;
  Fable 5.1 (исполнимость, ≈90 адресов): Critical 0, Important 6, Minor 12; ложных находок — 0. Закрыты правками плана:
  v7 снимает примеры с id модуля finance и получает запись `ALLOWLIST`; строка-граница служебных в индексе (РП-26, В-8);
  «Изменить вид» случай 1 без `{{body}}` и функция `bodyBecameText` (РП-29, Э-13); род тела по самой записи; один запрос
  записи вместо сужения включений (РП-13, Э-14, В-9); контрол аспектов соблюдает `minItems` (РП-27); группы узлов частей
  (РП-28); форма тула `entity_version_pin {entity_id}`; тест чтения v2 — в `body-doc.test.ts`; сторож копий по литералам
  регэкспов (+ пятая копия `lib/query-blocks/parse.ts:17`); адреса стенда П3; перф базы в порядке Ф-Г-75; перезамер
  байтов в задаче 17; вопросы В-8…В-11. Отчёты — `review-plan-opus.md`, `review-plan-fable.md` леджера; рулинги — `facts.md`.
- **Ре-ревью линзы 1 (24.09): APPROVE** — шесть Important закрыты по существу; шесть новых Minor (r-1…r-6: фильтр строк
  индекса в тесте и один экспорт `SERVICE_BOUNDARY_PREFIX`; `RecordView({reply})` и свой запрос предпросмотра; граница
  проверки «ни слова о выключенных»; один термин `page-text`; маппинг С1а-8/9; сторожа Э-7) закрыты правкой плана.
- **Объём:** 19 задач, 126 шагов (TDD-шаги с красным тестом, реализацией, мутацией и коммитом), новых модулей ≈ 40,
  три задачи — процедурные (1 шаги 1–5, 18, 19).

