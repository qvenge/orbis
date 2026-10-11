# Свойства и связи: приёмка ветки и передача срезу 2

Дата: 2026-10-11. Проверяемая ветка: `codex/properties-and-relations`; база Task 10: `d97723a4b8f0ebd46dc7f61f3d5441cdc6a1681a`. Проверенный product HEAD: `c127ec149f49b54fbbc26f21d0afed1abd7e64a3`; ordinary full web/acceptance checkpoint: `b838fe98`. Исходный HEAD полного aggregate: `fa65d758` (WB-PF-01/02); `2ef98b43` восстановил query-free каркас скрытой карточки версий. Итоговый docs commit — commit, вводящий этот документ. Спецификация: [2026-10-10-properties-and-relations-design.md](../superpowers/specs/2026-10-10-properties-and-relations-design.md).

Состояние: **реализовано в ветке, выпуск не подтверждён**. Исходные automated gates и локальная браузерная приёмка закрыты с точной историей ниже; после интеграции актуального main ожидаются CI и новая ручная приёмка. PR, merge в main и deploy не выполнялись. Проверка мобильного viewport не подтверждает клавиатуру на физическом телефоне.

## Интеграция с актуальным main перед выпуском

После завершения исходной приёмки пользователь разрешил выпуск. В изолированную feature-ветку влит текущий deployed `origin/main` `6fa20edd9e149b68b081ca225ad45649a51c936a` без rebase/force. История исходной приёмки ниже относится к прежней базе; она не заменяет gates объединённой версии. Push main и deploy этим интеграционным commit не выполняются.

Сохранены актуальные JournalRef `{ actionId, consequences }`, action_journal и облегчённое чтение записи с bodyRevision. Панель использует текущий shared Undo с global stack, досылом тела, замками переписывания и явным продолжением UNDO_TEXT_CHANGED. Подтверждённые vanilla-команды самостоятельно регистрируются в общем Undo после проверки JournalRef; transport без валидного receipt не создаёт Undo. Ответы и delayed host imports прежней сессии не меняют панель/плашки/stack. Смена владельца очищает прежнюю панель; смена responsive frame той же сессии сохраняет raw/pending/unknown. True-server cache timestamp сохранён при optimistic и rollback updates. Из текущего producer извлечён PinVersionDialog с исходными revision/flush/epoch/id guards; скрытые версии по-прежнему не читаются.

Локальная проверка объединённого кода: 441 web tests / 31 files PASS, 46 server tests / 4 files PASS; дополнительные current journal/Undo/host seams — 56 PASS / 3 files и owner/session/responsive — 8 PASS. Affected host/body/history/lazy run дал 471 PASS и пять failures нового upstream detail suite из-за заменяемого DOM; точные live-container assertions закрыли все пять без повышения deadline. All three typechecks, lint, 211 scripts и actual legacy gate PASS. Полный локальный aggregate не запускался: обязательный полный shared/server/web/scripts/perf/legacy/build/lazy gate выполняется CI на точном frozen feature SHA. **CI и новая ручная интеграционная приёмка ещё ожидаются; выпуск не подтверждён.**

Настоящие миграции, bootstrap, seed и 185 pgTAP прошли штатным db:prepare в новом одноразовом CI-equivalent контейнере `supabase/postgres:17.6.1.140`, только loopback 55439, database postgres. Прежняя выделенная база 54322 и production не менялись. Новых миграций поверх текущего main feature не добавляет; исторические production migrations не повторяются.

Production build и текущий неизменный CI lazy/PWA gate PASS: DetailScreen **23 264 B gzip <=34 889**, eager closure **317 082 B gzip-9 <=325 750**, 33 files. Порог 325 750 взят из актуального upstream R93, не поднят интеграцией. Сохранены все current source/static/text guards и feature SW precache guard. Исходные замеры 325 238 ниже остаются историческим свидетельством прежней базы.

При новой интеграционной браузерной проверке обнаружено перекрытие кнопки toast Undo открытой modal Sheet: Radix отключает body pointer events, а текущий custom Toaster наследовал запрет. Real userEvent pointer-check подтвердил RED; только pointer-auto дал отдельный RED внепланового outside-dismiss. Узкое исправление явно включает pointer events у уведомления и исключает только его viewport из outside-dismiss Sheet; modal focus trap и обычные dirty/pending guards сохранены. Действие выполняется один раз, raw и фокус сохраняются: affected toast/Undo/panel/host 72 PASS / 6 files, all3 types/lint и relative-origin/main diff-check PASS. Пересборка после исправления: **23 233 / 317 080 B** при тех же **34 889 / 325 750**; lazy/PWA PASS. Exact-new-SHA CI, независимое re-review и normal browser click без force ещё ожидаются.

Normal browser click первой правки действительно отправил один Undo исходного actionId и восстановил ребро, но notification item успел удалиться до deferred outside handler Radix: clean Sheet закрылся, dirty Sheet показал лишнее подтверждение (raw сохранился guard-ом). Дополнительный deterministic userEvent + synchronous React commit test воспроизводит RED; marker на самом исходном notification item переживает его удаление из viewport и закрывает этот seam. 72 affected tests и отдельные три overlay tests PASS, включая обычный backdrop close, callback ровно один, raw/focus сохранены. Final build/lazy/PWA: **23 234 / 317 084 B**, thresholds неизменны. Новая normal browser clean/dirty проверка и exact-SHA CI ожидаются.

## Исполняемая граница приёмки

`apps/web/src/features/entity-detail/properties-relations/acceptance.test.tsx` открывает настоящее меню DetailScreen и ленивую панель. Transport fixture использует настоящие builtin registry definitions и пользовательские декларации того же типа. Она применяет только присланные patch/aspect/triple, сохраняет исходный snapshot под actionId для toast Undo и не вычисляет server rules/defaults/access. Настоящие атомарность, правила, журнал, RLS и отказ без частичной записи проверяет server integration suite Task 1.

Сценарий выполняет пять команд: attach пользовательского аспекта с общим свойством и двумя значениями; values с двумя правками и unset свободного поля без blur; createRelation на стороне target; deleteRelation исходной тройки и toast Undo; detach с сохранением общего значения. Проверяются один entity_update в первом batch, адрес записи, отсутствие body и не-Undo AI вызовов, одна строка общего свойства двух носителей, сохранение определения свободного поля и исходного текста/id. UI не использует собственный вычислитель контракта или серверных правил.

## Команды и фактические результаты

Все команды выполняются из отдельного managed worktree. Dedicated DB: `orbis_properties_relations_test_20261011`, loopback port 54322; оба соединения проверяют `current_database()` до запуска. DSN и пароли не опубликованы. База уже подготовлена Task 1; setup-db.ts с cluster-global ALTER ROLE не вызывается. Другие базы и личный/production граф не используются. Functional и performance DB suites выполняются последовательно.

| Gate | Результат |
|---|---|
| Целевые acceptance/controls/forms/PropertyControl tests | controls 121 PASS / 6 files; final timing seams/acceptance 27 PASS / 4 files; versions 199 PASS / 5 files и 7 ADE cases; affected forms/metadata 119 PASS |
| `bun run typecheck` | final shared/server/web PASS, exit 0 на c127ec14 |
| `bun run test` (shared, server, web, scripts) | исходный aggregate exit 1; shared 1 160 PASS; server 3 606 PASS / 1 timing FAIL с exact isolated closure PASS; final full web 2 224 PASS / 2 existing skipped, exit 0; scripts 117 PASS / 0 FAIL |
| `bun run lint` | final PASS, 1009 files; 3 прежних informational useLiteralKeys в coverage-report scripts вне scope, 0 errors/warnings |
| `bun run check:legacy-form` и CI `--gate` | оба PASS, exit 0 |
| `bun run test:perf` после functional | PASS 3 / 0 FAIL, 27 assertions, 35,72 s, exit 0; текущие thresholds |
| `bun run --filter @orbis/web build` | final PASS, включая web tsc |
| `bun scripts/check-lazy-chunks.ts --max-gzip DetailScreen=34889 --max-closure-gzip DetailScreen=325238` | PASS: файл 28 098 B gzip <=34 889; closure 317 688 B gzip-9 <=325 238, 23 files |
| generated SW precache / lazy module boundaries | PASS: 26 boundaries, 12 forbidden edges, feature assets отсутствуют в precache |
| `git diff --check` | PASS final docs diff |

Все 83 исходных web failures связаны с отсутствием прежнего lightweight `versions-card` landmark до первой активации ленивой карточки. `2ef98b43` вернул существующие section/header/ellipsis без загрузки producer или запросов; immutable goldens и реальные menu/request assertions не изменены. Узкая проверка structure, record-blocks, page/render, page/menu и lazy latch: 199 PASS / 5 files. Исходный общий вызов с web exit 1 не считается успешным; завершение составляющих фиксируется отдельно.

Повторный полный web под ещё работающим сервером: 2 216 PASS / 8 FAIL / 2 skipped. Четыре versions assertions держали заменённый placeholder DOM; ожидания теперь проверяют прежнее фактическое содержимое в текущем контейнере, затем получают producer node. Все семь ADE versions cases прошли без изменения assertions результата/лимитов. Следующий full web без DB нагрузки: 2 220 PASS / 4 timing FAIL / 2 skipped; четыре ожидания проходили изолированно, но исчерпывались при обычном числе воркеров. Поэтому только NEW five-command/Undo acceptance получила явный integration deadline 10 000 ms с полным canonical catalog; первый cold-load readiness в двух probes ограничен 3 000 ms внутри прежнего deadline 5 000. Configure N-1 детерминированно продвигает прежнюю паузу 2 000 ms, сохраняя отложенный ответ/три правки/guard assertions и deadline 5 000. Глобальные, продуктовые, chunk и performance лимиты не повышены. Единственный server failure — property_merge/Undo, timeout 5 009 ms при лимите 5 000; точный повтор после full run: PASS за 2 138,32 ms, 23 assertions. Исходные exit 1 сохранены в истории; итоговый full web выполнен отдельно без фоновых gates.

Итоговый ordinary full web на test checkpoint `b838fe98`: 2 224 PASS / 2 existing skipped, 144 files, exit 0, 250,87 s. Все функциональные составляющие закрыты с указанной историей. Первые root scripts дали 114 PASS / 3 guard FAIL: точные словарные записи не следовали переносу pin-version dialog, а новые JS lazy имена не были перечислены. `c127ec14` переносит точные word counts 1/3/1 с прежним значением закрепления версии, перечисляет конкретные JS имена и переименовывает domain helper в extensionReason. Guard regex/охват/assertions не ослаблены; final scripts 117 PASS, affected forms/metadata 119 PASS и all3 typecheck PASS. Чистое переименование не требовало нового полного web/server прогона.

## Матрица ПС-01…28

Пути web ниже относительны `apps/web/src`, server — `apps/server/src`. Матрица описывает проверяемые assertions; фактические результаты составляющих aggregate записаны выше. Manual обозначено отдельно и не заменяется jsdom.

| ПС | Автоматический носитель | Проверяемый результат / граница |
|---|---|---|
| 01 | web `features/entity-detail/properties-relations/entry.test.tsx` | note/page/app/custom без cards; title/id замороженной записи |
| 02 | entry, panel; `features/page/preview-readonly.test.tsx` | выбранный preview readonly; A→B body адресный; A→A local/history согласованы; configuring не пишет невидимую запись |
| 03 | server `routers/properties-relations.test.ts`; web forms | task на прежнем id/body, серверный task_status default, refetch проекции |
| 04 | server `routers/entity-update-batch.test.ts`, `registry/ref.test.ts`; web forms, acceptance | attach+fields один action, настоящий tx/journal rollback, отказ сохраняет draft |
| 05 | server properties-relations; web metadata/forms/acceptance | общий property id дедуплицирован, два носителя, detach не удаляет value |
| 06 | server properties-relations; web forms/acceptance | free set/unset без attach, definition сохраняется |
| 07 | web PropertyControl, draft, forms, acceptance | активный raw без blur, один touched patch/Undo, незатронутые поля не отправлены |
| 08 | web draft-value, ScalarListControl, draft | false/0/empty text/list/null отличаются от unset; decimal precision/timestamp zone |
| 09 | server ref; web useEntityOptions, RefManyControl | target/undefined/alternatives, полные списки, серверный доступ |
| 10 | web ScalarListControl | строка с запятой остаётся одним элементом; add/remove полным массивом |
| 11 | server ref; web RefManyControl/forms | архивные/недоступные ids остаются; весь изменённый список проверяет сервер, явная коррекция без автоочистки |
| 12 | web metadata/forms/panel/cache-provenance/useRegistry | flags/mask/deprecated/unknown/read failures/version drift; clear не обходит gate; optimistic cache write не снимает stale block |
| 13 | web assignment-form/forms/panel/host-pending | unsupported reason; coherent assignment без task, generated unset проверяется, одно действие/Undo |
| 14 | server relations; web relations | subitem обе стороны, только relation_create между существующими записями |
| 15 | web relations/useCommands, graph invalidation | dependency source/target, invalidate списков и блокировок |
| 16 | server relations/properties-relations; web relations | self всех ролей, duplicate/cycle/contract/incoming limit; refusal сохраняет выбор/raw |
| 17 | server ref; web relations | две ручные роли отдельно; два ref properties одно зеркало, unset одного сохраняет второе и зеркало |
| 18 | server router API; web useCommands/relations/acceptance | исходная directed triple со стороны target, реальный actionId/Undo пересчётов |
| 19 | server relations/ref; web relations | system/ref без прямой кнопки, API отказ; ref переход к правильному source property |
| 20 | server properties-relations; web relations | mention и body_refs независимы |
| 21 | web useEntityOptions/useResolvedRefs/relations/panel | error/empty/limit отдельно; max200 batches, 401 edges/total/50 paging, retry |
| 22 | web draft/entry/panel/host-pending/responsive/reconciliation-race | dirty confirm, frozen id, delayed response/import, addressed host lock; responsive не теряет raw/pending/unknown |
| 23 | web draft/forms/panel/useRegistry/cache-provenance | актуальные entity/context/registry; conflict keep/accept, mask-only change, сохраняется raw, old cached/local write не выдаётся за fresh read |
| 24 | web graph-command/useCommands/panel/reconciliation-race | unknown reread, matches/differs/unavailable, без auto retry/выдуманного actionId, per-attempt token |
| 25 | web useGraphUndo/useCommands/invalidation tests | оба конца/списки/counts/blocks/ref titles/budget invalidated после write и Undo; late A closure не пишет B |
| 26 | web entry/panel/lazy helpers/UI tests + build/lazy/PWA gate; actual browser PASS | отсутствие feature chunks/queries до gesture; focus/scroll/footer/360px и responsive raw; physical phone keyboard отдельно не проверена |
| 27 | server properties-relations + RLS suite | чужой graph/actor отказ, ownerOnly сохранён |
| 28 | acceptance UI suite и types RunPanelCommand | исполняемая граница сегодня; **сам перенос ещё не выполнен**, будущий parity gate ниже |

## Ручные наблюдения

Финальная приёмка координатора **PASS, 2026-10-11**, после functional/performance gates: production build `c127ec14` + настоящий локальный API, fresh origin `http://127.0.0.1:56715`, fixture `mv32w4sz`, note `01a12856-84fa-75e2-9a4c-d4a95ae295d6`, только выделенная DB. Service worker включён, origin/cache свежие, установка завершена; запросы наблюдались на уровне browser context, включая SW. Это новый прогон, прежний exploratory smoke Task 9 его не заменяет.

- Закрытая панель: 146 запросов / 9 tRPC events bootstrap, feature assets отсутствуют и в запросах, и в CacheStorage после активации SW. Меню без выбора панели загрузило только 7 прежних menu-related JS assets, без feature asset/tRPC запросов. Панель загрузила `PropertiesRelationsPanel-y7mCEJ68.js` по gesture; редактирование значений — `RefManyControl-DjBIHsV0.js`. Обе лежат только в `properties-relations-assets` runtime cache, отсутствуют в workbox-precache. SW/browser events одного asset не считаются дополнительными записями.
- Note→task: один batch / один entity_update с attach orbis/task, прежний адрес/title. Required custom aspect без общего поля: настоящий server refusal, сфокусированный role=alert и сохранённый draft. После заполнения общего поля и number=2 один batch содержит attach + оба значения. Следующая правка shared + number=7.5 и unset free — также один batch, только touched props/unset, без body; последнее число заполнено перед Save в активном поле.
- Incoming dependency: текущая сторона «Заблокированная работа», source blocker `01a12856-850e-7093-beee-99cc458cd5b0` → target note. Один create; delete/confirmation имена содержат role key и оба исходных адреса/предмета; один delete точно исходной тройки. Один toast ai.undo восстановил то же incoming ребро, что подтверждено повторным открытием и server read.
- Mobile 360×640: длинные подписи и archived marker видимы, scrollWidth/clientWidth 360/360; Save x16/y568, высота 44. Raw «Черновик узкого экрана» сохранился при 360→1024→360 с настоящей сменой navigation frames. Dirty Close открывает подтверждение с начальным фокусом «Продолжить редактирование»; продолжение сохраняет raw. При 360×360 и фокусе input Save x16/y288, высота 44, доступен; переполнения по горизонтали нет.
- Ref-many: к `[archived, available]` явно добавлен blocker, archived остаётся помечен. Save отправляет все три refs и edited shared в одном batch; настоящий сервер отказывает из-за архивной цели. Сфокусированная ошибка, raw и все три refs сохраняются. Явное удаление только archived и следующий Save успешно сохраняют `[available, blocker]` и прежний raw, без автофильтрации/автоповтора.
- Specialized assignment с default «Человек»: один batch attach orbis/assignment, executor=human, unset grant/may_close; после успеха доступен «Открыть редактор: Исполнитель».
- Всего: 7 batch attempts (5 success, 2 ожидаемых server refusals), 1 relation.create, 1 relation.delete, 1 ai.undo. Каждый batch — один entity_update без body. Других ai.* нет; read POST entity.blocks не считается mutation. Две console errors — ожидаемые rejected tRPC responses required/archived validation, zero-console-errors не заявлен.
- Actual before/after entity.get с явно включёнными body/bodyDoc: entityIdUnchanged, bodyUnchanged, bodyDocUnchanged — все true. Финально shared/number сохранены, free отсутствует, refs `[available, blocker]`, incoming dependency восстановлена. Браузер переведён в about:blank; проверенный owned local server остановлен, session exit 0.

Границы: локальная production-сборка и тестовый граф; viewport/keyboard-occlusion emulation, а не физический телефон/native soft keyboard. Release/deploy и перенос среза 2 не выполнены.

## Обязательный будущий gate ПС-28 — срез 2

Перевести **пять** операций `values`, `attach`, `detach`, `createRelation`, `deleteRelation` на формы и именованные действия. Новая реализация предоставляет тот же `RunPanelCommand` для сценариев либо переносит публичный UI suite на новые формы. Для каждой операции spy на фактической транспортной записи доказывает **один жест — один вызов записи**. Старый direct adapter и новый путь никогда не исполняются одновременно.

До переключения и после него, без пользовательских записей между снимками, сравнить точное равенство ids/aspects/props/relations (включая отсутствие/null/false/порядок массивов и directed triples). **Миграции данных нет.** Прогнать ПС-01…27 новым путём, включая нестандартный шаблон, assignment/page, server refusal и Undo, current-context/unknown/host-addressing guards и lazy/Network budgets.

Удалить `features/entity-detail/properties-relations/useCommands.ts` с прямыми вызовами и заменённую ручную сборку forms/локальные маршруты специальных редакторов там, где они выражены декларациями. Общие PropertyControl/search/draft parsing и сервер сохраняются. Пока хотя бы один сценарий не выражается срезом 2, перенос **не complete**: сохранить именованный остаток с причиной в [03-pending.md](03-pending.md). Никаких выдуманных schema/actions API или миграций «на будущее» в текущем срезе не добавлено.

После фактического выпуска отдельным этапом обновить состояние с датой и доказательством выпуска; текущий acceptance commit сам выпуск не подтверждает.
