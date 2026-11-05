# План Б — обычный локальный функциональный CI на 356a610f

Точный `356a610f5ae92efe429bdb6891c5bde6f9c09e9f`, clean detached clone `/private/tmp/orbis-speed-b-release-ci.1IskrJ/candidate`. Проверены 2131 tracked files по Git archive, все workspace aliases внутри клона, remote отсутствует. Bun 1.2.7, frozen install из копии прежнего локального cache. Только существующий тестовый `orbis-speed-b-db`, Docker local Unix endpoint, `supabase/postgres:17.6.1.140`, привязка `127.0.0.1:54339`. До запуска проверены локальные DSN и роли orbis_app/postgres, секреты в evidence не включены. Готовность PostgreSQL проверена. Остальные тестовые контейнеры не запускались.

Один корневой `bun run test`, локальная default concurrency, `CI` unset, Web Vitest defaults 4 workers. Исходные waits, fixture source и assertions сохранены. Стадии от 01:36:55 до 01:58:38 UTC 05.11.2026. Отдельный путь с прежним точным 13f one-worker 3061/2 остаётся своим результатом.

| Стадия | Exit | Результат |
| --- | ---: | --- |
| `bun install --frozen-lockfile --cache-dir <isolated-cache>` | 0 | 773 packages, exact 1.2.7, чистый checkout |
| `bun run lint` | 0 | 1265 files, 29 warnings, 6 infos |
| `bun run db:prepare` | 0 | Роли, миграции, registry seed, 197 pgTAP assertions |
| `bun run test` | 1 | Shared 1319 PASS. Server 4210 PASS / 0 FAIL в 201 file. Web 3060 PASS / 1 FAIL / 2 skip, 217 passing files / 1 failing / 2 skipped. |
| `bun test scripts/` | 0 | 249 PASS / 0 FAIL в 24 files. Отдельный прогон, потому что root `&&` остановился после красного Web. |
| `bun scripts/check-legacy-form.ts --gate` | 0 | Рабочее дерево проходит отдельный legacy gate |
| `VITE_BUILD_ID=356a610f5ae92efe429bdb6891c5bde6f9c09e9f bun run --filter @orbis/web build` | 0 | Штатный web tsc и Vite build, SW сгенерирован, 130 файлов в `build-artifact.sha256` |
| Server/shared typecheck | carried | a0 прошёл, соответствующие source/config/lock байты не менялись. Exact a0→356 non-doc/runtime diff ограничен тремя Web test paths. Exact 13f→356 вне docs diff 0. Отдельный web typecheck был 0 на 13f, и web tsc пройден в текущей сборке. |

Суммарный локальный функциональный CI **RED**. Единственный отказ `src/features/entity-detail/reference-caption.test.tsx:46`, `actual reference picker caption uses prior and next cached labels without extra title requests`. Не найдено начальное поле «Категория» до смены ссылки, мутации и проверок количества запросов. Raw DOM обрезан внутри шапки, точное состояние данных и lazy leaf при отказе не установлено. Предыдущие nav и properties failures в этом обычном запуске не повторились.

Один неизменённый named control на exact 356 с теми же waits и одним worker прошёл, 828 ms test. Один cold sibling в отдельном exact клоне + diagnostic trace прошёл все прежние assertions. Trace order в относительных отметках: entity.get reply 56,1ms, registry.effective reply 222,9ms, actual AspectSectionView import 304,1→386,4ms, Category visible 591,3ms. Это фиксирует успешную причинную последовательность в sibling. Первичный RED не воспроизведён и не объяснён конкретной причиной. Никаких ожиданий, preloads, worker defaults или product code не менялось. Новый обычный полный прогон не запускался.

Артефакт сборки: `/private/tmp/orbis-speed-b-release-ci.1IskrJ/candidate/apps/web/dist`. Его file manifest SHA 15144519575777a82e0e75728de0a1bd4f3c02eb0c1ca41fdce746635b03b4ea. Raw команды, timestamps, exits, clone/equivalence proof и диагностические исходники в `/private/tmp/orbis-speed-b-release-ci.1IskrJ/reports`, индекс `functional-ci-evidence.sha256`. Тестовые процессы завершились. Существующий primary передан root в running state после согласованного запуска.

Perf, graph, after-B и lazy budget не повторялись по решению владельца. Прежние RED обязательных perf/lazy шагов и запреты на hosted CI, release и main остаются отдельными границами.
