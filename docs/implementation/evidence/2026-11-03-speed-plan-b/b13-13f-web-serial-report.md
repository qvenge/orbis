# Б13 — полный последовательный web-прогон 13f

Точный `13f343eeda3110ecf75806eeacb76e6170a7c3e7`, detached local clone `/private/tmp/orbis-b13-final-ci.07CROy/web-serial`. Все 1519 tracked files совпали с Git archive. Workspace aliases внутри checkout, Git status пуст до и после. Дельта от фактически собранного и проверенного a0 ограничена тремя web test fixtures. `web-serial-runtime-equivalence.log` показывает только `back-nav.test.tsx`, `settings-nav.test.tsx` и `properties-relations/responsive.test.tsx`, все прочие paths совпадают. Server/shared, браузерные артефакты и прежние evidence остаются на фактически проверенных SHA.

Один полный запуск из `apps/web` командой `bun x --no-install vitest run --maxWorkers=1`, Vitest 4.1.9. **3061 PASS / 2 skip / 0 FAIL**. Файлы 218 PASS / 2 skip из 220. Длительность Vitest 845,99 с, exit 0. Один worker установлен явно для контролируемого функционального прогона. Исходные assertions, waits и suite selection сохранены. Прежние полные default-worker a0 и e074 RED сохранены отдельно. Повтор default-worker CI не проводился.

После завершения тестов на том же чистом checkout `bun run --filter @orbis/web typecheck` exit 0. Параллельных Browser, DB или perf прогонов в этом окне не было. Пороги и состояние прежних perf/graph/lazy ворот не менялись.

Raw commands, timestamps, exits, aliases, source check, equivalence and logs in `/private/tmp/orbis-b13-final-ci.07CROy/reports/web-serial*`. SHA256 index `b13-13f-web-serial-evidence.sha256`.
