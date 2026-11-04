# Б13 — исходный полный локальный прогон 882bd444

Артефакт `882bd444e87793d4b4c6c9a1e9b64afe14d93b6c`, exact detached local checkout `/private/tmp/orbis-b13-ci.F6FMiU/candidate`. Все 1518 отслеживаемых файлов совпали с git archive, `@orbis/*` разрешаются внутрь checkout, status после прогона пуст. Bun 1.2.7, macOS x64, PostgreSQL 17 в проверенном контейнере `supabase/postgres:17.6.1.140` на 127.0.0.1:54339; runtime DSN orbis_app. Последовательные команды с `b13-ci-*.command/.started/.ended/.exit/.log`. 04.11.2026 13:24:24–13:53:11 UTC. Это локальный mirror, hosted CI не запускался.

| Этап | Exit | Наблюдение |
| --- | ---: | --- |
| Frozen install | 0 | Та же команда с writable tmp и локальной копией cache. Первые 2 попытки сохранены отдельно: AccessDenied temp, затем FailedToOpenSocket на пустом cache. Внешний доступ не использован. |
| lint | 0 | 1264 файла, 25 warnings / 6 infos |
| typecheck | 0 | shared/server/web |
| db:prepare | 0 | setup/migrate/seed и pgTAP 197 |
| workspace test | 1 | Shared 1319/0. Server 4206/1 в 201 файле (1333,26 с). Web 2974/41/2 в 220 файлах (368,66 с); 15 красных файлов. |
| scripts separately | 1 | 244/3, три отказа `scripts/lab/selectors.test.ts` |
| legacy-form actual tree | 1 | 7 строк в 3 файлах |
| quiet test:perf | 1 | 2/1, `agenda:page` 177,7 мс / 120 мс; остальное в существующих пределах. |
| production build | 0 | VITE_BUILD_ID=точный 882bd444, SW precache 123 / 2102,90 KiB |
| lazy guard | 1 | DetailScreen 22581/34889 Б gzip; static closure 363007/325750 Б gzip−9 (+37257 Б) |
| quiet test:perf:graph | 0 | 2/2. 50000 сущностей / 149999 рёбер. P95: descendants subtree 122,3 мс; recompute subtree5k 635 мс; when next_7d 168,6 мс; deadline 21,5 мс; small recompute 16 мс. |

Серверный child завершился около 13:47:16 UTC. Родительская оболочка была удержана между этапами после окончания child и возобновлена в 13:49:38 после адресной проверки ревьюера; весь workspace test прошёл до собственного завершения. Оболочка записала exit 1, затем независимые ворота дошли до конца. Успех последней команды оболочки не превращает общий набор в PASS.

- Полный `b13-ci-test.log` SHA `57c759050e1d4ddb994da467e23b20e9830bafc54d8b87d6dfbf5b675666c369`. `b13-ci-red-names.json` SHA `812213638ac82bfa2910dda5f196ba6ff1b155f6a5e690a4db9df3b5181b6852`: 42 уникальных отказа с путями, исторические совпадения отдельно. Server — `src/registry/extension-off.test.ts`, материализация повтора с выключенными финансами, 5000 мс. Web — 9 arrows, 6 history-lifecycle, 4 apps/open, 3 useGraphUndo, 3 page/menu, 3 settings/apps-and-extensions, по 2 nav-editor/budget plan-owner/foreign-refusal/versions-freshness, по 1 back-nav/perf wiring/fixtures/EnvelopeCard/history-delivery. Сходство с промежуточным Б8/Б9 контролем не устанавливает статус до полного Б. Неизменённые адресные повторы и исходный `b5abb7fe` для устойчивых отказов — отдельный триаж.
- Lab selectors: AST ожидает устаревшие формы `#side-chat ...`, не считывая продолжение template literal после `${scope}`; пины SearchPanel/SideChat ссылаются на прежние JSX. В runtime уже используется точный thread-ready selector и актуальные средства поиска. `b13-ci-scripts.log` SHA `e07c2c0faeed54d4c3968adb7bb6dce53ab05edc3e99b8ea2ea65d4c1da332ca`.
- Legacy-form: `response-cache.ts:263/360/362/473`, `create-intents.test.ts:197` (identity-pair), `freshness/runtime.ts:215/429` (brand-cast). Контроль/решение владельцев файлов, без расширения allowlist ради результата. `b13-ci-legacy-form.log` SHA `b10b71ee844d98d8cf58d7752d94f5b4d56dffa5b087ae32e6b3276f4573b07c`.
- Perf fixture seed 61,842 с; quiet medians list50 24,1, badge 21,8, budget overview 122,8, old agenda horizon 52,8, backlinks 45,7, fastpath create 109,0, goal 59,7, blocks:10 132,2 мс. Warm spent cache p95 5,3. Отдельный `agenda:page` использует те же 3 реальных блока и неизменённый порог, требуется сопоставимый контроль для причины. `b13-ci-perf.log` SHA `d8151191eb4398282472b50b8b75abaa7baab92089a900b1c675df2f1a5e8fd6`. `b13-ci-graph.log` SHA `0b177fbef01ece973b427c1ae31f751902692f59df531b44421da414277a290f`.
- Artifact manifest `b13-ci-dist-manifest.json` SHA `de97b58d9f02b6777f300824e40098bb15c37a315c9ba585fbf5ca714101bde2`, 128 файлов. `b13-ci-lazy.log` SHA `b6f46430f1d681c4923ad8e5425f31c3d0bfcf47392ee273b8a0c2747868cfe2`. Пороги не менялись. Ранее отвергнутый Markdown diff не входит в код.

На 882 независимый reviewer адресно воспроизвёл сбросы cursor/token и пропуск барьера сохранения после future reset. Корректирующая работа у root и исходных авторов. Настоящие browser after-B, local native matrix, fallback 0.7 и финальная приёмка ждут исправленного SHA. Исходный красный mirror сохранён.
