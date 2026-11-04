# Б13 — фактические события для причинного web-триажа

Local PostgreSQL 17.6, schema 0027, 127.0.0.1:54339, runtime orbis_app. Отдельный exact checkout `882bd444` без изменений tracked source; apps/server, packages/shared, root package, bun.lock, tsconfig, CI и render байт-в-байт равны принятым 49a43220 и dad1fdf2 (tree/blob IDs в `b13-feed-shapes-equivalence*.log`). Проверка server router через настоящий caller 0.7 и local DB, не browser. Один новый синтетический граф 629c6591-bd7f-4073-b639-b3a6092229b1, затем тот же граф для повтора. Cleaner и внешний доступ не использовались.

`bun test ./.superpowers/sdd/2026-11-03-speed-plan-b/feed-shapes.test.ts` 04.11.2026 15:02:30–15:02:33 UTC: 1 PASS, 0 FAIL, 88 assertions. Для каждого успешного результата связывали его actionId с journal rowKey в фактически прочитанной транзакции, проверяли `from ≤ txId < watermark`, scope и affected IDs. Где ответ содержит txId, он совпал с лентой. Полные ID/пакеты в raw.

| Действие | Actual TX → watermark | Изменение, видимое клиентскому ключу |
| --- | --- | --- |
| version.restore / Undo восстановления | 36723→36724 / 36724→36725 | `version insert` / `version delete` страховки, parent entityId; оба `entity update body`. Версия реально появляется и уходит из version.list. |
| Structured Undo 409 | from 36727 → 36728 | Ни одной транзакции графа. Watermark может двигаться без записи. |
| Force Undo | 36728→36729 | `version insert` с точным `pinnedVersions[].versionId`, `entity update body`, journal. |
| App disable / enable / archive / restore | 36730, 36731, 36732, 36734 | `entity update other` для app row, без graphWide. Тот же APPS_QUERY (graph dependency) отражает четыре состояния. |
| New app with existing page as Home | 36736→36737 | ACK содержит created row. Тот же TX создаёт app, изменяет Home исходной страницы, создаёт две relations. |
| Supply add / Undo | 36738→36739 / 36739→36740 | `entity insert other` / `entity update other` (архив), один и тот же deterministic ID. `supply.updates` убирает и снова предлагает ключ. |
| App composition | 36740→36741 | `entity update other` только app row; ни одно affected ID не Home, `edited` у Home остаётся false. |
| Independent Home body edit | 36741→36742 | `entity update body` Home, `supply.updates` видит edited=true. Registry статическая карта его ключа указывает bodyOrStamp. |

Raw `b13-feed-shapes.log` SHA 3eafacc9dab2c7c53748d4e3f3e7fec182e9822d8716500657f2ecef9e92587b. Source `/private/tmp/orbis-b13-ci.F6FMiU/candidate/.superpowers/sdd/2026-11-03-speed-plan-b/feed-shapes.test.ts` SHA 7414cbff2fa4ec501cba75c3ba33767e3aecee400d2cf3aa7d060f8badd03fd8. Current equivalence `b13-feed-shapes-equivalence-current.log` SHA 4beffcaa139c8bbc1b0c50de70afb4bc2a03992f46bd8860411291859f6cfdf0.

Сохранены три первые попытки. `b13-feed-shapes-filter-miss.log` Bun exit 0 без обнаруженного теста, DB не тронута. `b13-feed-shapes-wire-first.log` exit 1, предыдущие реальные restore/Undo/409/force пакеты уже сняты, проверка неправильно читала `pinnedVersions[].id` (в старой web-фикстуре то же поле). `b13-feed-shapes-import-first.log` exit 1 при загрузке probe, без DB вызовов. Повтор исправил имя wire поля и импорт server identity parser, использовал существующий тестовый граф. Ни один из первых выводов не переписан.

На следующем web-этапе моделировать только фактически наблюдённые success события и их parent IDs. App composition и Home commit разделить. Для generic Undo failure этот свидетель устанавливает отсутствие события у конкретного реального 409 и оставляет отдельными политику targeted catchup и вариант реального commit с потерянным 500 ответом. UI-поведение, status полного web suite и отдельный cold BODY дефект этим тестом не закрыты.
