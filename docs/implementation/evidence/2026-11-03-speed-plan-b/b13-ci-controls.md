# Б13 — адресные контроли исходного CI

Исходный mirror 882bd444e87793d4b4c6c9a1e9b64afe14d93b6c остаётся RED. Контроли ниже отделяют устойчивые отказы от одиночных и дают сопоставимый серверный замер.

## Web и серверные тесты

- Exact 882, неизменённые tests и лимиты, один worker, по исходным именам: 40 FAIL / 1 PASS. Исключение — `back-nav.test.tsx` «‹ снимает верх стопки…». `b13-triage-candidate-882/index.json` SHA af3e186e… содержит имя, путь, exit и лог каждой проверки.
- Exact исходный b5abb7fe70068c06b7075ed54a2a0f3c3d729d7b с собственным lock и собственными исходными тестами: все 40 имён найдены и прошли. `b13-triage-initial-before-b/index.json` SHA 3325b795…. Эти 40 отказов связаны с изменениями после исходной точки. Два тестовых контракта уже разобраны и подтверждены `b13-fixtures-report.md`; остальные требуют классификации по фактическому runtime/фикстуре.
- `registry/extension-off.test.ts` case 10, тот же лимит 5000 мс: исходный код 3475,01 мс PASS, 882 3623,16 мс PASS. Исходный полный timeout не переписан. Контроль не устанавливает причину таймаута. `b13-control-{baseline,candidate}-server-exact.log`.

## Серверный perf

04.11.2026, последовательное тихое окно 14:01:37–14:03:31 UTC. Exact detached clone b5abb7fe `/private/tmp/orbis-b13-ci.F6FMiU/before-b-control` использовал свой frozen lock и собственную миграцию 0026; свежий отдельный контейнер `orbis-speed-b-before-db` на 127.0.0.1:54341 (cached `supabase/postgres:17.6.1.140`, image ID 6501843661…, --pull=never). `db:prepare` exit 0. Exact 882 использовал свою миграцию 0027 на уже использованном 127.0.0.1:54339. Оба прогона исполнили `bun run test:perf` со своим truncate и повторным севом той же исходной фикстуры. DB lifecycle различался.

| Замер | Исходный b5abb+0026 | 882, исходный CI | 882, тихий повтор |
| --- | ---: | ---: | ---: |
| agenda:page, медиана 5 | 117,5 мс | 177,7 мс | 159,5 мс |
| entity.blocks:10 | 108,8 мс | 132,2 мс | 100,5 мс |
| agenda:horizon | 40,3 мс | 52,8 мс | 44,7 мс |
| perf suite | 3 PASS | 2 PASS / 1 FAIL | 2 PASS / 1 FAIL |

Неизменённый порог `agenda:page` 120 мс. Тихий повтор выше исходного контроля на 42,0 мс / 35,7% и выше порога на 39,5 мс. Пять отдельных latency samples исходный гейт не печатает; сохранены фактические medians и stdout каждой команды. Две адаптации shape в `perf.test.ts` относятся к guard ненулевой фикстуры, вызов `entity.blocks`, 3 блока, warmup, 5 повторов и порог те же. Измерение whole-source + schema не распределяет стоимость между Б1/Б2/Б4 и состоянием двух экземпляров БД.

Raw hashes:
- `b13-control-baseline-perf.log` a6176d0fb353bfb4c53a7ce970a45ed05f105bb0d5e80cc9f0da73905f02fed3.
- `b13-control-candidate-perf-repeat.log` 346a38879bd6cdaa228d5db6cafe563b7f00972017dc06c9f8288599edae1b09.
- `b13-ci-perf.log` d8151191eb4398282472b50b8b75abaa7baab92089a900b1c675df2f1a5e8fd6.

Самый короткий следующий причинный probe — разметить одну оригинальную цепочку `runBlocks`: phase 1 context/prepare (отдельно локальная граница суток), `materializeInstances`, phase 2 SQL/savepoints и преобразование результатов. `nextMidnightAt` уже ленив и мемоизируется на общий CompileCtx, а `withIdentity` добавляет snapshot в существующий SQL set_config без дополнительного сетевого round trip. Триггеры 0027 действуют на записи, поэтому одного их наличия недостаточно для объяснения медленного SELECT. Сначала определить дорогую фазу и проверять её отдельной контролируемой вариацией в disposable TEMP. В обеих ветках мерить одинаковые реальные блоки и проверять их непустоту.
