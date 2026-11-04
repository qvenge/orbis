# Б1. Адресное повторное ревью fix 1

**PASS. P1 и P2 — ADDRESSED.** Проверены изменения после [первого ревью](b1-review.md) поверх `793233d9`.

## P1 — ADDRESSED

Независимо повторил исходное двухграфовое воспроизведение `/tmp/orbis-b1-review.sql` с чтением под `SET LOCAL ROLE authenticated` для A. Запись A больше не выдаёт живой UUID B из `body_refs`. Версия, сообщение и тред A скрывают якорь, перемещённый в B, и выдают `graph_wide=true`. FK `SET NULL` при удалении треда B оставляет journal UPDATE A без foreign thread ID, с `graph_wide=true`. Каскадное удаление ребра после переноса источника в B не оставляет scoped строки отношения. Событие удаления X из A в момент переноса остаётся видимым как разрешённая OLD сторона.

- `0027_change_feed.sql:87`, `:97`, `:378`. В helper сначала ищется живой объект. Для исчезнувшего берётся последняя строка нужного kind/key/xid по feed.id без преждевременного фильтра графа. Только DELETE доказывает OLD. При смене графа одного ключа synthetic DELETE получает id раньше INSERT. Отдельные вызовы capture через SPI видят события, записанные более ранними триггерами той же транзакции. Обычный каскад и A→B→A подтверждают точное событие, A→B подтверждает подъём floor без scoped relation payload. При исчезновении обоих концов действует общий reset.
- `0027_change_feed.sql:140`, `:188`, `:199`, `:212`. Разность ссылок и якоря передаются после доказательства. Для неустановленной принадлежности и для чужого графа ветвь одинакова. Вставка сообщения без разрешимого parent не создаёт scoped строки. Тесты покрывают реальную собственную ссылку, чужую, отсутствующую и moved anchor.
- `0027_change_feed.sql:224`, `:246`. Живой или OLD тред журнала должен быть того же графа. Подтверждённый same-graph DELETE сохраняет старый thread key. При разрешении edge история используется после проверки живого или последнего удалённого ребра, а возвращаемые концы ещё раз проверяются. Unknown ref даёт graph-wide, edge ID сам по себе не становится affected entity ID.
- Helpers `STABLE STRICT SECURITY INVOKER` с фиксированным `search_path=pg_catalog, public` и квалифицированными постоянными объектами. Действующие ACL на стенде содержат EXECUTE для административного владельца и capture definer. У app-ролей и PUBLIC EXECUTE отсутствует. Нужные дополнительные чтения definer ограничены колонками метаданных ленты. Snapshot 0027 правильно продолжает 0026, все прежние таблицы совпадают, частичный индекс совпадает с SQL и декларацией Drizzle.

## P2 — ADDRESSED

`0027_change_feed.sql:150` пропускает оба EXCEPT при равных refs в том же графе. `:249` дедуплицирует journal IDs до проверок. Частичный индекс ограничивает поиск parent history по xid, kind и row key. Предикат `f.kind IN ('entity','thread','relation')` присутствует в самом helper наряду с параметром kind.

Независимый probe `/tmp/orbis-b1-review-generic.sql` подготовил фактический `pg_proc.prosrc` установленного helper, заменив только именованные параметры позиционными. На реальной таблице `public.change_feed` с 30 000 откатываемых строк, `plan_cache_mode=force_generic_plan` и без отключения Seq Scan план выбрал `Index Scan using change_feed_parent_proof` с `Index Cond: ((tx_id = $3) AND (kind = $1) AND (row_key = $2))`. Счётчики `generic_plans=1`, `custom_plans=0`, 4 buffer hits, 0.034 мс на данном стенде. Массовый end-to-end замер стоимости триггеров и добавленной индексной записи остаётся в Б13.

## Проверки

- `bun test apps/server/src/db/change-feed.test.ts apps/server/src/freshness/feed.test.ts` — 22 pass, 0 fail, 62 assertions.
- `bun run test:rls` — 197/197, exit 0. Исходный SQL repro и generic plan probe — exit 0, оба с ROLLBACK.
- `git diff --check` — exit 0. Typecheck shared/server/web после правки тестовой аннотации подтверждён отдельным прогоном исполнителя.

Архитектурный гейт Б1 проходит. RLS удерживает строки своего графа, а definer отдельно ограничивает содержимое metadata payload. Граница исправления осталась внутри feed, модель графа и контракт Б2 не менялись.
