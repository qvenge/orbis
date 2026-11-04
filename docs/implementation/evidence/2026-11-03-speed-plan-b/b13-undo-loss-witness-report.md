# Б13 — два причинно разных Undo с одинаковым HTTP 500

Настоящие Hono/tRPC 0.7.0, PostgreSQL 0027 и runtime orbis_app на 127.0.0.1:54339. Backend из exact882 в `/private/tmp/orbis-b13-ci.F6FMiU/candidate`; server/shared/package/lock/tsconfig/CI/render байт-в-байт совпадают с accepted 1e5c05ae. Отдельный loopback Bun HTTP proxy, один свежий синтетический граф, без cleaner и внешнего доступа. Тест SHA 36cd2deeaaf8d566c5d92a9aa2b8191ae78867b41b2f329d489019abea7b107c. Настоящий origin формирует успешный ответ только во второй ветке, а диагностический proxy выдаёт одинаковый tRPC 500 в обеих.

- До передачи в Hono: клиент получил 500, заголовок остался «До», `from=36745`, `watermark=36745`, transactions=[].
- После принятой Hono записи: origin ответил 200, клиент получил тот же 500 / INTERNAL_SERVER_ERROR. Реальный Undo изменил title на «После отказа». Reconcile от 36745 получил commit tx36745 при W36746 с entity/update/other на точный ID и новым journal action ID. Ответ клиента не мог подтвердить этот commit без ленты.
- Structured no-write 409 проверялся отдельно в `b13-feed-shapes-report.md`: rejection не создаёт событие даже при движении watermark.

`bun test ./.superpowers/sdd/2026-11-03-speed-plan-b/b13-undo-loss-witness.test.ts`: **1 PASS, 12 assertions**, raw `b13-undo-loss-witness.log` SHA 47103a65c22d8bf33ec337066d527587b33749943a4969c00156fce8f9d78928. Server equivalence `b13-undo-loss-equivalence.log` SHA 4beffcaa139c8bbc1b0c50de70afb4bc2a03992f46bd8860411291859f6cfdf0. Это локальный контроль двух исходов, не проверка браузерного Undo или production proxy.
