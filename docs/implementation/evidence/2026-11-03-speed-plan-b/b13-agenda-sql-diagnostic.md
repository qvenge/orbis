# Б13 — SQL и планы трёх блоков «Повестки»

Две source-local диагностические копии `/private/tmp/orbis-b13-agenda-profile.QoK9Vd/{candidate,before}`: exact a0+0027 на 54339, exact b5+0026 на 54341. Только измерительные правки двух файлов в каждом, aliases внутри. Исходный a0 CI архив и пороги неизменны. Последовательные runs 16:34:03–16:37:24 UTC и 16:39:57–16:41:29 UTC. Первый baseline setup остановился до запуска бенча из-за различий между `BlockResult` и `BlockSuccess` и формой savepoint. Исправлен только локальный instrumentation marker и запущена только baseline половина. Первые traceback, candidate source и все raw outputs сохранены.

Тот же seed, штатный caller и пять timed samples. Проверка fixture выдала [480,500,30] в обоих. EXPLAIN выполнялся после samples под эффективной ролью authenticated, session user orbis_app, JIT on, plan_cache_mode auto, work_mem 4MB. Все четыре read-only catalog snapshots exit0.

| Перепроверка | b5+0026 | a0+0027 |
| --- | --- | --- |
| Timed Agenda median | 239,5 мс | 484,1 мс |
| Seed duration | 80,5 с | 187,0 с |
| executeAll median | 169,8 мс | 353,9 мс |
| Await SQL по блокам 0/1/2 | 43,4 / 61,6 / 45,7 мс | 85,1 / 144,5 / 85,3 мс |
| EXPLAIN server execution, отдельный вызов | 25,7 / 45,8 / 37,4 мс | 28,3 / 51,1 / 41,8 мс |
| Wire/layout группы 1, separately | 2,2 / 4,3 мс | 2,7 / 4,9 мс |
| Outside savepoint callback, medians 0/1/2 | 1,7 / 4,6 / 4,4 мс | 3,1 / 5,1 / 5,5 мс |
| Distinct full other-cost flag | spent-cache p95 8,1 мс | spent-cache p95 14,0 мс |

Agenda raw, в порядке вызова: b5 [261,0;274,4;216,1;236,3;239,5], a0 [483,4;644,1;536,6;411,1;292,8] мс. a0 perf 1/2, b5 2/1, обе медианы Agenda выше исходного порога 120. Это инструментированный diagnostic, обычные a0 154,4 и 882 177,7/159,5 остаются отдельными RED.

- У всех трёх блоков совпадают полный compiled SQL и все bind values, структурное дерево планов, actual/estimated rows и loops каждого узла. Actual SQL returns 480/501/31, последние две строки отрезает прежний механизм `limit+1`. Иерархия основных узлов Limit, Sort, WindowAgg, Nested Loop, Seq Scan совпала. Обе БД без physical reads и temporary spill; a0 на +2 shared hit buffers в каждом из трёх EXPLAIN. Планировщик одинаково недооценивает две выборки (1→480 и 6→501). Нового отличающегося узла для локальной правки не найдено.
- Размер и live/dead `entities/relations` после seed/прогона практически совпадают. После тестов `relpages` 183/32, `reltuples` 3036/1863, live3043/1875, dead40/0 одинаковы. История базы различается, до seed a0 содержит предыдущий 53k graph corpus. Настройки тоже фактически различаются: `effective_cache_size` 524288 vs 16384 страниц и preload `pg_cron` only vs штатный список Supabase. Это реальные условия контрола, но показанные планы от них не поменялись.
- Хост измерен между lanes, load 12.41/14.78/11.86 при 12 логических CPU, в 16:39:38 UTC CPU_Speed_Limit 57, в 16:41:53 UTC 42 по независимому чтению root. Нет замера лимита в начале a0 lane, поэтому его точный вклад не рассчитан. Совпадающий SQL и кардинальности, ускорение второго seed более чем вдвое и предыдущий более спокойный phase 113,9→119,0 делают эти абсолютные timings непригодными для оценки стоимости плана Б. Driver wait включает время SQL, транспорт, декодирование и scheduling; его разность с отдельным EXPLAIN не превращается в измерение сети.

Гипотеза роста именно SQL/JS layout для трёх готовых блоков этим опытом не подтверждается. Изолированный обход graph и browser timings отложены до снятия CPU cap. Сначала неизменённый graph repeat в отдельном тихом окне. Fresh equal-history pair имеет смысл, если после восстановления хоста остаётся несопоставимость или появляется повторяемый разрыв. Для него нужны два пустых disposable Postgres одинакового cached image с точно одинаковыми runtime flags, роли и миграции 0026/0027, два обычных seed (порядка 1–1,5 мин каждый в рабочем окне) плюс проверка схемы. Это отдельный эксперимент и ресурсы, существующие контейнеры не менять.

- Машинная сводка `agenda-sql-summary.json` SHA 615a9aa4b40ffde9ecf1aa8d9380eb51e03f20aa27be249b5b66e6385085a947.
- Все raw logs, source diffs, stage exits, actual catalog и host snapshot в `/private/tmp/orbis-b13-final-ci.07CROy/reports`, индекс `b13-agenda-sql-evidence.sha256`.
