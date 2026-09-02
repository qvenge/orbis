-- 0017_reform_contract.sql — contract-половина реформы свойств (§А1-1, §А3-1, §А4-3, РП-2).
--
-- Файл РУКОПИСНЫЙ, снимок meta/0017_snapshot.json — сгенерированный. Так же, как у 0015/0016
-- и по той же причине: drizzle-kit не умеет выразить порядок «снять констрейнт → снять
-- колонку → собрать констрейнт заново», а без снимка следующая генерация увидит снятые
-- колонки как «надо добавить».
--
-- ЧТО ЭТА МИГРАЦИЯ ДЕЛАЕТ: убирает вторые описания той же правды, которые срез А завёл
-- намеренно и держал ровно до перевода всех читателей (expand → migrate → contract).
-- Каждый DROP ниже — снятие ВТОРОГО экземпляра факта, а не потеря факта.
--
-- ДАННЫЕ. Значения `entities.aspects_legacy` — проекция `props`/`aspects[]` (её писал
-- `executor/legacy-form.ts`), `relations.relation_type` — проекция `role`
-- (`projectLegacyRelationType`), `aspect_definitions.schema` — производная реестра свойств
-- (`legacyAspectJsonSchema`). Ни одного независимого факта в трёх колонках нет, поэтому
-- конверсии перед сносом не требуется, а бэкапом закрыт риск ошибки в самом этом
-- утверждении (чек-лист D43, шаг 1).
--
-- RLS, ГРАНТЫ, pgTAP: новых таблиц нет, поэтому здесь их нет тоже. Политика
-- `owner_owns_both_ends` на `relations` (0001) смотрит только на владение концами и колонок
-- ребра не касается; гранты 0001 выданы на таблицу целиком; состав таблиц не меняется, а
-- значит не меняются ни группа pgTAP, ни список `truncateAll`.

-- ─── entities: старая карта аспектов и мешок meta ────────────────────────────────────────
--
-- Индексы `entities_aspects_legacy_gin` (0001:102, переименован 0015:24) и
-- `entities_meta_gin` (0001:104) уходят ВМЕСТЕ с колонками — отдельный DROP INDEX для них
-- не нужен и был бы вторым способом сказать то же самое.
--
-- ТРИ GIN, ЗАВЕДЁННЫЕ 0015 (`entities_props_gin`, `entities_aspects_gin`,
-- `entities_query_refs_gin`), ОСТАЮТСЯ ВСЕ ТРИ, и это решение по замеру, а не по умолчанию.
-- Замер (`perf/explain.test.ts`, 2026-08-27 и перезамер этой задачи): под ролью приложения
-- ни один из них не выбирается и не применим даже с `enable_seqscan = off`
-- (`chosen=false, usable=false`), под админским подключением — применим (`admin=true`).
-- Причина одна на все три и НЕ в индексах: политика `owner_owns_row` — security qual, а
-- `jsonb_contains`/`arraycontains` не leakproof, поэтому планировщик обязан применить
-- политику раньше индексного условия. То же верно для ВСЕХ дореформенных GIN на `entities`
-- (`entities_tags_gin`, `entities_body_refs_gin`, оба FTS) — то есть «не берётся под
-- приложением» здесь не признак лишнего индекса, а свойство модели доступа. Под админским
-- подключением ходят сиды, скрипты и `ops.ts`, и там индексы работают.
ALTER TABLE entities DROP COLUMN aspects_legacy;--> statement-breakpoint
ALTER TABLE entities DROP COLUMN meta;--> statement-breakpoint

-- ─── relations: уникальность по РОЛИ вместо проекции роли ────────────────────────────────
--
-- Порядок трёх шагов существен и проверяется накатом на непустую базу:
--  1. снять `rel_uniq` — иначе `DROP COLUMN relation_type` не пройдёт под констрейнтом;
--  2. снять индексы по типу и саму колонку;
--  3. собрать `rel_uniq` заново по (source_id, target_id, role) — раньше имя занято.
--
-- Что это меняет для графа: две роли с одной проекцией (`subitem`+`ticket`,
-- `subitem`+`envelope-binding`, `mention`+`supersedes`) между одной парой сущностей были
-- НЕВЫРАЗИМЫ и получали структурированный отказ интервала; теперь они законны. Обратная
-- сторона — дублей по новому ключу быть не должно; на непустой базе шаг 3 их и не встретит,
-- потому что старый ключ был СТРОЖЕ нового ровно на схлопывании ролей.
ALTER TABLE relations DROP CONSTRAINT rel_uniq;--> statement-breakpoint
DROP INDEX IF EXISTS relations_source_type;--> statement-breakpoint
DROP INDEX IF EXISTS relations_target_type;--> statement-breakpoint
ALTER TABLE relations DROP COLUMN relation_type;--> statement-breakpoint
ALTER TABLE relations ADD CONSTRAINT rel_uniq UNIQUE (source_id, target_id, role);--> statement-breakpoint

-- Эвристика восстановления роли (0016:46) отработала свой единственный бэкфилл и с этого
-- момента не вызывается ниоткуда: тесты, звавшие её напрямую, сняты вместе с ней. Оставлять
-- в базе функцию, читающую колонку, которой больше нет, — значит держать код, который
-- упадёт при первом же вызове.
DROP FUNCTION IF EXISTS reform_role_heuristic(text, jsonb, jsonb);--> statement-breakpoint

-- ─── aspect_definitions: JSON Schema аспекта — производная, а не хранимое ────────────────
--
-- Колонка была ВТОРЫМ, независимым описанием тех же полей рядом с реестром свойств (§А3-1) и
-- разъезжалась с ним ровно там, где реестр и правят. Вход тула `attach_*` и стадия 2
-- валидатора собираются из эффективного снимка реестра с Задачи 12; последний SELECT
-- колонки (`loadAspectToolRows`) снят вместе с ней.
ALTER TABLE aspect_definitions DROP COLUMN schema;
