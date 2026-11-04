# Б13 — точный полный локальный CI a0 и адресные контроли

`a0bff516be98680685b790908ef76cc4f949f49c`, detached checkout `/private/tmp/orbis-b13-final-ci.07CROy/candidate`, 1519 tracked files byte-identical Git archive, no remotes, clean before/after, все workspace aliases внутри checkout. Bun 1.2.7, Mac x64, local Postgres 17.6 на 127.0.0.1:54339, runtime role orbis_app. Frozen install из копии локального cache, без внешних запросов. Точный SHA установлен в VITE_BUILD_ID. Hosted CI не запускался. Все raw files в `/private/tmp/orbis-b13-final-ci.07CROy/reports`, индекс `b13-final-ci-evidence.sha256`. Исходный mirror 882 не тронут.

| Gate | Exit | Факт |
| --- | ---: | --- |
| Frozen install / lint / typecheck / db:prepare | 0 / 0 / 0 / 0 | 773 установленных пакета, workspace types, фактические 197 pgTAP checks |
| Full `bun run test` | 1 | Shared 1319 PASS. Server 4210 PASS / 0 FAIL в 201 файле. Web 3059 PASS / 2 FAIL / 2 skip, см. ниже. Все 40 исходных устойчивых web-отказов и прошлый серверный extension-off timeout не повторились. |
| Scripts separately / legacy-form | 0 / 0 | scripts отдельной командой после exit1 workspace, actual legacy gate без строк нарушения |
| Quiet server perf | 1 | 2 PASS / 1 FAIL. Единственное превышение `agenda:page` 154,4/120 мс, прочие бюджеты проходят. Предыдущие неизменённые 177,7 и 159,5 мс сохранены. |
| Quiet graph perf | 1 | 1 PASS / 1 FAIL. `descendants_of:subtree` P95 172,2/130 мс, median 122,3; raw 20 samples. `recompute` 716,3/1000, when next_7d 190,0/430, deadline 17,4/350, small recompute 15,9/150, все проходят. Первый 882 P95 122,3 проходил. |
| Production web build | 0 | Workbox 125 precache, 2110,00 KiB. 130 dist files, manifest SHA 043d444f6c66ccf3a8fc52d76c2f423de32b29084b939490a7997ec4542dbbf8. |
| Lazy guard | 1 | Individual DetailScreen 22999/34889 PASS. Static eager closure 365135/325750, +39385 bytes. Largest entry 135856, Markdown 47823, tRPC 39289. Никакой смены порогов. |

## Два nav controls

Все четыре неизменённых named runs exit 1 (один worker, исходные wait/defaults), каждый с отдельными command/time/exit/log/JSON. На a0 и оригинальном b5 падают до первого жеста по одной и той же точной проверке: Back/site ищет heading E2 в `back-nav.test.tsx:48`, Settings ищет heading E1 в `settings-nav.test.tsx:47`. Верный `data-place` уже есть в полном a0; Settings показывает скелетон lazy ScreenFallback. Back output обрезан до места где различим lazy-vs-data. Отдельный старый Back контроль на 882 проходил. Вывод ограничен baseline reproducibility обоих отказов, без объявления зеленого suite или изменения таймаута. `b13-final-nav-control-plan.md` содержит source/DOM comparison.

## Три AST mutants

Изолированный exact clone `/private/tmp/orbis-b13-final-ci.07CROy/mutants`, не основной CI checkout. `scripts/write-paths.test.ts` на b5 и a0 имеет один Git blob `80825677ba6301e0a7407966c20e7b6f8bb0b13b`, SHA256 `623677c7602d67cd2579dd628ad399f4ab8ed57e538ddcd72740a7bd10008737`. В чистой базе `bun test scripts/{write-paths,cache-dependencies,record-links}.test.ts` даёт 38 PASS. После трёх добавлений `bun run typecheck` exit 0 на shared/server/web.

| Fixture | Source bytes in reports | Guard result |
| --- | --- | --- |
| Typed graph SQL writer outside boundary | `b13-writer-mutant.ts` | `write-paths.test.ts` 29 PASS / 1 FAIL, named violation in `apps/server/src/routers/b13-writer-mutant.ts` |
| Typed destructured QueryClient custom family | `b13-cache-family-mutant.ts` | `cache-dependencies.test.ts` 3 PASS / 1 FAIL, `b13-unregistered-family` at line 5 |
| Typed direct openRecord via alias | `b13-record-link-mutant.tsx` | `record-links.test.ts` 3 PASS / 1 FAIL, exact file `apps/web/src/b13-record-link-mutant.tsx` |

Каждый mutant command exit 1 проверен скриптом и совпал с нужной причиной. Возврат к чистому Git status, затем те же 38 PASS. `guard-run.exit` 0, `guard-after.status` пуст, точные source SHA в `guard-mutant-source.sha256`, полный скрипт в родительском `guard-mutants.zsh`. Пустой helper-output при первой попытке извлечь hash объясняется zsh expansion и не является измерением, проверенный blob в `guard-writer-before-after.log`.

Отдельная разрешённая диагностика SQL/DB и один unchanged graph repeat пишутся новыми файлами, исходные красные не заменяются. After-B, native/fallback/реальный buster/контролируемая PWA матрица ещё не запущены. Решение по пинам после конкретных измерений и root, запрет main/release сохраняется.
