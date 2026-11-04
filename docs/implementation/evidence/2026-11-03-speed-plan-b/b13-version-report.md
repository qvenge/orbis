# Б13 — передача версии 0.7.0

Замороженная копия `/private/tmp/orbis-b13-version.Eq7UNm` из `git archive c4ae0efe90d56daf33f55741d4982d5baa4bd6fa`. Ровно 42 исходных хеша Б11 совпали с `owned` финального `b11-fix3-source-hashes.json` SHA `dd37166b6533f3598ddef0b4cf6c8effb31570d265e9efe2c8e94cc24a8cd3ea`. Алиасы `@orbis/*` указывают внутрь копии. Продуктовый workspace не менялся.

Пять разрешённых путей: `apps/web/src/app/version.ts`, `packages/shared/src/constants.ts`, `apps/server/src/router.test.ts`, `apps/web/src/trpc.test.tsx`, `scripts/client-version.test.ts`. Совместимая пара APP/MIN поднята до 0.7.0. Исторические негативные проверки до Б сохранены. Негативный пин 0.6.0/0.6.9 проверяет GET detail, POST blocks и POST update. Минимум 0.7.0 пропускает неавторизованное обращение до 401, публичный ping — до 200. Пины заголовка и точного номера обеих констант обновлены. Исторические perf samples и gate implementation сохранены.

- RED `bun test -t 'HTTP: клиенты плана А' apps/server/src/router.test.ts` на исходном минимуме дал ожидаемый отказ проверки: 401 вместо 412, `b13-version-red-db.log`. Первый запуск без loopback env не прошёл fixture setup и сохранён отдельно как `b13-version-red.log`.
- GREEN `bun test apps/server/src/router.test.ts version-proof.test.ts` — 17/17, 99 утверждений. `version-proof.test.ts` — временный test-only probe вне diff (SHA `e54783c7009baff6b947aa079feb6ea6b6579eff1217394db407881e13096bec`). Настоящий Bun/Hono socket и JWT + PostgreSQL `orbis_app` на 127.0.0.1:54339: GET и POST 0.6.0 дали 412, GET 0.7.0 дал 200, заголовок в БД остался прежним. Изолированная синтетическая graph fixture. Внешние auth/DB не использовались. `b13-version-http.log` SHA `de1ce114fc996a5b116dea480f68f8019bdf1f462b8c7f8e102cead32aa84c8d`.
- Скрипт версий 7/7, web header/hook 2/2, Biome на пяти путях exit 0. `b13-version-{script,web,biome}.log`. `git apply --check` на текущем workspace exit 0.
- `b13-version-review.diff` SHA `ac19412293553facb4c34338fe3384ca9278e057fc20df997bb2cd1781fd5181`; `b13-version-review-hashes.json` SHA `a29ed9437cffb11b3cebb5fd1878a99bce690fdd0c18cda4cba272dd7bd09408`.

Следующий шаг root: адресное независимое ревью, проверка пяти хешей и локальный commit, затем exact SHA для полного CI mirror/build и лаборатории. Продуктовая 412/PWA матрица сохранения текста, compatible response-off и бóльшая приёмка остаются фазами Б13.
