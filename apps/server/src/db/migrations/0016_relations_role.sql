-- 0016_relations_role.sql — expand-половина реформы ролей рёбер (§А4-3 спеки, РП-2).
--
-- Файл РУКОПИСНЫЙ, снимок meta/0016_snapshot.json — сгенерированный. Так пришлось потому,
-- что drizzle-kit пишет `ADD COLUMN "role" text NOT NULL` без значения: на пустой базе это
-- проходит, на непустой падает первой же строкой. Правда ребра существует и у старых строк,
-- её надо ВЫВЕСТИ, а не потребовать. Поэтому три шага: добавить nullable → заполнить
-- эвристикой → закрыть NOT NULL.
--
-- РАЗРУШАЮЩИХ шагов нет: `relation_type`, `rel_uniq` и оба индекса по типу остаются на
-- месте — их снимает contract-миграция 0017 («Пересев мира»). До неё колонка типа живёт
-- как ПРОИЗВОДНОЕ от роли (`projectLegacyRelationType`), потому что её ещё читают
-- компилятор запросов, бюджет, agent-loop и импорт.
--
-- Ни RLS-политик, ни грантов здесь нет намеренно: новых таблиц не появилось, политика
-- `owner_owns_both_ends` (0001) смотрит только на владение концами и колонок ребра не
-- касается вовсе, а гранты 0001 выданы на таблицу целиком.

-- Эвристика восстановления роли из схлопнутого типа. Обратной функции к
-- `projectLegacyRelationType` не существует (пять ролей → один `parent`), поэтому роль
-- ДОГАДЫВАЕТСЯ по аспектам концов — ровно тем способом, который реформа и отменяет.
-- Порядок веток значим: `envelope-binding` проверяется до `category-parent`, иначе конверт
-- в дереве категорий увёл бы транзакцию не в ту роль.
--
-- Читается `aspects_legacy`, а не новая `aspects`: у строк, существовавших до 0015, новый
-- массив пуст (0015 данные не конвертировала), и по нему эвристика молча вернула бы
-- `subitem` для всего графа.
--
-- Функция ОСТАЁТСЯ в базе до 0017 (там `DROP FUNCTION`): её вызывает тест реформы напрямую
-- на временных jsonb-значениях — иначе проверить эвристику можно было бы только перепрогоном
-- миграции на подготовленных данных.
CREATE FUNCTION reform_role_heuristic(rt text, src jsonb, tgt jsonb) RETURNS text
  LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN rt = 'blocks' THEN 'dependency'
    WHEN rt = 'related_to' THEN 'mention'
    WHEN rt = 'derived_from' THEN 'instance-of'
    WHEN rt = 'parent' AND src ? 'orbis/budget' THEN 'envelope-binding'
    WHEN rt = 'parent' AND tgt ? 'orbis/category' THEN 'category-parent'
    WHEN rt = 'parent' AND tgt ? 'orbis/agent-run' THEN 'run'
    WHEN rt = 'parent' AND src ? 'orbis/project' AND tgt ? 'orbis/assignment' THEN 'ticket'
    ELSE 'subitem' END
$$;--> statement-breakpoint

ALTER TABLE relations ADD COLUMN role text;--> statement-breakpoint

UPDATE relations r SET role = reform_role_heuristic(
  r.relation_type,
  (SELECT e.aspects_legacy FROM entities e WHERE e.id = r.source_id),
  (SELECT e.aspects_legacy FROM entities e WHERE e.id = r.target_id));--> statement-breakpoint

ALTER TABLE relations ALTER COLUMN role SET NOT NULL;--> statement-breakpoint

-- Пара к `relations_source_type`/`relations_target_type` (0001): те же два направления
-- обхода графа, но по роли. Старые НЕ снимаются — до 0017 по типу ходят все непереведённые
-- читатели. Судьба обеих пар — вердикт EXPLAIN «Пересева мира».
CREATE INDEX relations_source_role ON relations (source_id, role);--> statement-breakpoint
CREATE INDEX relations_target_role ON relations (target_id, role);
