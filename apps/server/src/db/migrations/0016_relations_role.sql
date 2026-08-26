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
--
-- Каждая ветка `parent` спрашивает ОБА конца, а не один. Это не педантизм: догадка по
-- источнику одному ошибается в пользу СИСТЕМНОЙ роли, а системную роль владелец обратно уже
-- не поставит (`ROLE_SYSTEM_ONLY`). Обычная заметка внутри конверта получила бы
-- `envelope-binding`, пропала бы из «Подзадач», назвалась бы «Привязкой к конверту» — и
-- вернуть её в подпункты было бы нечем. Условия сверены с теми, по которым читают САМИ
-- потребители: конверт считает транзакцию (`spentByEnvelope` — ребёнок с `orbis/financial`),
-- дерево категорий требует категорию с ОБЕИХ сторон (`categoryEdges`), прогон опознаётся
-- аспектом цели (`runsOfParent`).
--
-- Порядок веток значим и запинен тестом: `envelope-binding` проверяется до `category-parent`
-- (запись, которая одновременно конверт и категория, — прежде всего конверт).
--
-- Неизвестный тип РОНЯЕТ миграцию с именем типа в тексте. Прежний `ELSE 'subitem'` глотал
-- бы и опечатку, и значение, которого код не знает: граф молча получил бы роль «подпункт»
-- там, где смысл был другой, а разобрать это стало бы нечем — старая колонка уходит в 0017.
-- Ради этого функция на plpgsql, а не на sql: RAISE в чистом SQL не выразить.
--
-- Читается `aspects_legacy`, а не новая `aspects`: у строк, существовавших до 0015, новый
-- массив пуст (0015 данные не конвертировала), и по нему эвристика молча вернула бы
-- `subitem` для всего графа.
--
-- Функция ОСТАЁТСЯ в базе до 0017 (там `DROP FUNCTION`): её вызывает тест реформы напрямую
-- на временных jsonb-значениях — иначе проверить эвристику можно было бы только перепрогоном
-- миграции на подготовленных данных.
CREATE FUNCTION reform_role_heuristic(rt text, src jsonb, tgt jsonb) RETURNS text
  LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  IF rt = 'blocks' THEN RETURN 'dependency'; END IF;
  IF rt = 'related_to' THEN RETURN 'mention'; END IF;
  IF rt = 'derived_from' THEN RETURN 'instance-of'; END IF;
  -- `ref` колонка v1 не знает, но проекция роли `ref` даёт именно его: молчаливый `subitem`
  -- здесь развёл бы эвристику с `projectLegacyRelationType` на ровном месте.
  IF rt = 'ref' THEN RETURN 'ref'; END IF;
  IF rt <> 'parent' THEN
    RAISE EXCEPTION 'reform_role_heuristic: неизвестный relation_type «%» — роль не выводится', rt;
  END IF;

  IF jsonb_exists(src, 'orbis/budget') AND jsonb_exists(tgt, 'orbis/financial') THEN
    RETURN 'envelope-binding';
  END IF;
  IF jsonb_exists(src, 'orbis/category') AND jsonb_exists(tgt, 'orbis/category') THEN
    RETURN 'category-parent';
  END IF;
  IF jsonb_exists(tgt, 'orbis/agent-run') THEN RETURN 'run'; END IF;
  IF jsonb_exists(src, 'orbis/project') AND jsonb_exists(tgt, 'orbis/assignment') THEN
    RETURN 'ticket';
  END IF;
  RETURN 'subitem';
END $$;--> statement-breakpoint

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
