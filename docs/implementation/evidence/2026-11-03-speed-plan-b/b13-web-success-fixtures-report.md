# Б13 — три исходных файла для пяти подтверждённых success-side отказов

Exact dad1fdf2e9f6d292e2d127618326b3862149f26b в `/private/tmp/orbis-b13-web-success-fixtures.A1CeZE`. Изменены только `features/entity-detail/versions-freshness.test.tsx`, `features/apps/open.test.tsx` и `features/settings/apps-and-extensions.test.tsx`. Последние две области сохраняют остальные исходные сценарии, включая R5 shared navigation и известные ещё красные ветки. Четырёхфайловый пакет истории остаётся отдельно, без adoption.

Основа — actual SQL witness `b13-feed-shapes-report.md` и `b13-web-success-probes-report.md`. V-1 сохраняет прежнюю проверку visible Versions и теперь отдельно покрывает узкое version событие после ACK и полный actual commit до ACK. Force использует `versionId`, настоящие bodyDoc и revisions. App-off тест держит отдельный ACK, затем проверяет scoped entity/other delivery. Supply add/Undo используют insert/archive по тому же ID. App composition не меняет `edited` у Home, его меняет отдельный настоящий body effect, смоделированный своим событием.

Поведенческий snapshot `b13-web-success-fixtures-tested.diff` SHA 2f9c8ac13c65064d223691c43d2d1959c7620e99b73f82aed4e22f688c51e7e8, source manifest `b13-web-success-fixtures-tested.sha256`. Actual Vitest по этим трём исходным путям, один worker: **9 PASS / 43 skip**, exit 0. Пять исходных RED представлены шестью позитивными контролями из-за двух порядков V-1. Три соседних controls — R5 shared menu/Enter, прежний no-write app enable refusal, создание приложения с «Составом». Raw `b13-web-success-fixtures-targeted.log` SHA f28fb2f6f4223a559657c23889c11e152b2bd38bf520fbb0589ac2eca5d08d93. Остальные cases не объявляются зелёными.

Первая Biome проверка отмечала формат двух путей и одно fixture nonnull предупреждение, сохранена в `b13-web-success-fixtures-biome-first.log`. После scoped Biome format, Biome exit 0, 1 предупреждение; diff-check exit 0. Изменения после теста только форматирование, отдельный test rerun финальных байтов не запускался.

Финальные TEMP хеши:
- `b13-web-success-fixtures-review.diff` SHA ead2a317bd2f44d2a1c7c8772fbaa57193ee6048a52ea1e0a399e5d9cc88cb69.
- `b13-web-success-fixtures-review.sha256` SHA 25d347413ee1c67f1db9c58dd3fde7ad5a6370925bf9690345fb28f04bc13198.
- `b13-web-success-fixtures-biome.log` SHA 462912eea536506d8c04dcfc61f72aab4ea98315bc9607d4111c604331117716.

Production code и рабочая ветка не изменены. Пакет передан root для принятия.
