// apps/server/src/executor/ancestors.ts
//
// Правило `nearest_ancestor` (§А8, Ч9): вычисляемые свойства `orbis/parent_project` и
// `orbis/root_project` — проекция иерархии на каждую сущность под проектом. Ими реформа
// заменяет ручную денормализацию `orbis/agent-run.project_id`, которую писал ровно один
// глагол и которая молча врала при любом переносе поддерева.
//
// ЗДЕСЬ — КОД ДВИЖКА, а не декларация правила: СТРОКА правила в реестре каталога появляется
// только в части Б (Б-2), и до неё имя правила живёт в коде — во флаге `flags.computed.rule`
// встроенных свойств и в системной строке журнала о пересчёте. Обе стороны берут его из
// ОДНОЙ константы `RULE_NEAREST_ANCESTOR` (`@orbis/shared`, `constants.ts`): она видна и
// пакету реестра, и серверу, поэтому переименование правит оба места разом. Что константа
// доехала до строки реестра в БД, проверяет отдельный тест — сид между ними ещё стоит.
//
// ТРИ ОТСТУПЛЕНИЯ ОТ ОБЫЧНОГО ПУТИ ЗАПИСИ, каждое — норматив, а не сокращение:
//
//  1. ЗАПИСЬ ПРЯМЫМ UPDATE, а не операцией executor'а. Механизм этой записи — `rule`
//     (§А4-4), и гейт §А2-5 её пропустил бы (`COMPUTED_WRITE_MECHANISMS` содержит `rule`),
//     но пересчёт поддерева — это N правок на одну правку владельца, и провести их через
//     `entity_update` значило бы положить в журнал N операций с N inverse на каждое
//     перетаскивание задачи. Кэш вычисления не откатывают — его пересчитывают (см. п. 3).
//
//  2. `updated_at` НЕ ДВИГАЕТСЯ. Это производное значение, а не правка владельца: сдвинь
//     мы метку, и CAS тела (`expectedUpdatedAt`, §5.2) начал бы отказывать соседней правке
//     из-за чужого переноса поддерева, а списки, отсортированные по `updated_at`, прыгали
//     бы без причины.
//
//  3. `aspects_legacy` НЕ ПЕРЕПИСЫВАЕТСЯ, и это НЕ пропуск дуальной записи. Носителя-аспекта
//     у обоих свойств нет намеренно (§А8: они живут на любой сущности под проектом), а
//     проекция в старую карту раскладывает значения ПО АСПЕКТАМ (`projectLegacyAspects`) —
//     значит места этим двум свойствам в ней нет по построению, и её пересборка была бы не
//     проекцией новых значений, а молчаливым переписыванием остальной карты владельца.
import { sql } from 'drizzle-orm';
import type { Tx } from '../db/with-identity';
import type { RegistrySnapshot } from '../registry/load';
import { hierarchicalRoles } from '../registry/roles';

export const PROP_PARENT_PROJECT = 'orbis/parent_project';
export const PROP_ROOT_PROJECT = 'orbis/root_project';

/**
 * Аспект, наличие которого делает сущность проектом для этого правила. Экспортирован ради
 * executor'а: он же решает, что навешивание/снятие ИМЕННО ЭТОГО аспекта запускает пересчёт,
 * и вторая копия литерала развела бы условие запуска с условием обхода.
 */
export const PROJECT_ASPECT = 'orbis/project';

/**
 * Кап глубины обхода — и вниз по поддереву, и вверх по предкам.
 *
 * Он не про производительность, а про ЗАВЕРШАЕМОСТЬ: ацикличность в реестре объявлена
 * только у `category-parent` и `dependency` (§А4-2), то есть цикл из `subitem` владелец
 * построить может, и обход без капа висел бы на нём. 32 — заведомо больше любой живой
 * иерархии; глубже кап молча обрезает, и это честнее отказа: правка ребра не обязана
 * падать из-за формы графа, которую сам же граф и разрешает.
 */
const DEPTH_CAP = 32;

/**
 * Пересчёт `orbis/parent_project`/`orbis/root_project` для поддеревьев затронутых целей.
 *
 * `changedTargetIds` — это ЦЕЛИ изменившихся иерархических рёбер (у ребра «родитель →
 * ребёнок» меняется предок ребёнка, не родителя) плюс сущности, у которых
 * навесили или сняли `orbis/project`: у первых меняется собственный предок, у вторых —
 * предок всего, что под ними.
 *
 * Одним запросом, а не обходом в памяти: у пересчёта нет ни одной ветки, которую стоило бы
 * разглядывать построчно, а рекурсивный CTE идёт по тем же индексам, что и любой другой
 * обход связей, и не гоняет N запросов на N узлов поддерева.
 *
 * ОБА ОБХОДА ИДУТ ПО РОЛЯМ ИЗ СНИМКА РЕЕСТРА (`hierarchical`), а не по списку в коде:
 * роль с этим признаком заводится операциями реестра (Задача 15), и константа её не увидела
 * бы. Пустой список ролей — законный случай (реестр без иерархии): пересчитывать нечего.
 *
 * Возвращает число строк, у которых значение ДЕЙСТВИТЕЛЬНО изменилось: журналу нужен факт
 * пересчёта, а не факт вызова.
 */
export async function recomputeProjectAncestors(
  tx: Tx,
  ownerId: string,
  changedTargetIds: string[],
  reg: RegistrySnapshot,
): Promise<{ recomputed: number }> {
  const roots = [...new Set(changedTargetIds)];
  const roles = hierarchicalRoles(reg);
  if (roots.length === 0 || roles.length === 0) return { recomputed: 0 };

  const rootList = sql.join(
    roots.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  const roleList = sql.join(
    roles.map((role) => sql`${role}`),
    sql`, `,
  );

  const rows = (await tx.execute(sql`
    WITH RECURSIVE down(id, depth) AS (
        SELECT e.id, 0 FROM entities e
         WHERE e.id IN (${rootList}) AND e.owner_id = ${ownerId}::uuid
      UNION
        SELECT r.target_id, d.depth + 1
          FROM down d
          JOIN relations r ON r.source_id = d.id AND r.role IN (${roleList})
         WHERE d.depth < ${DEPTH_CAP}
    ),
    -- Ромб в иерархии даёт один и тот же узел на разной глубине: множество поддерева
    -- обязано быть множеством, иначе строка обновлялась бы дважды и считалась дважды.
    subtree AS (SELECT DISTINCT id FROM down),
    up(start_id, id, depth) AS (
        SELECT s.id, s.id, 0 FROM subtree s
      UNION
        SELECT u.start_id, r.source_id, u.depth + 1
          FROM up u
          JOIN relations r ON r.target_id = u.id AND r.role IN (${roleList})
         WHERE u.depth < ${DEPTH_CAP}
    ),
    -- Кандидаты в предки: только ВЫШЕ самой сущности (depth > 0) — проект не предок себе.
    proj AS (
      SELECT u.start_id, u.depth, e.id AS project_id, e.created_at
        FROM up u JOIN entities e ON e.id = u.id
       WHERE u.depth > 0 AND ${PROJECT_ASPECT}::text = ANY(e.aspects)
    ),
    -- Родителей у иерархической роли может быть несколько, поэтому «ближайший» и «корневой»
    -- доопределены детерминированно: сначала глубина, потом старшинство записи. Молча
    -- выбранный «любой» давал бы разный ответ на одном и том же графе.
    --
    -- ОДНА группировка вместо двух "DISTINCT ON", и это правка ПО ЗАМЕРУ, а не по вкусу
    -- (перф-гейт П6, "perf/graph.test.ts", корпус 50 000 сущностей / 149 999 рёбер,
    -- поддерево 4999 узлов, 2026-08-27):
    --
    --   два "DISTINCT ON" + два LEFT JOIN       — 4589 мс;
    --   "AS MATERIALIZED" у обоих (первая гипотеза) — 5431 мс, то есть ХУЖЕ;
    --   одна группировка (эта форма)              —  475 мс.
    --   на МАЛОМ поддереве (6 узлов) все три формы равны: 6,4 / 5,5 / 6,4 мс.
    --
    -- Числа выше сняты на ЧИСТОМ SELECT той же формы (без UPDATE) — так три варианта
    -- сравнимы между собой. Полный "recomputeProjectAncestors" на том же поддереве: до
    -- правки 1,76 с в лучшем режиме планировщика и 12,1 с в худшем (режим менялся между
    -- прогонами), после правки 0,43…0,60 с на шести прогонах — режим один. Порог П6 в 1 с
    -- до правки не брался ни разу, после берётся с запасом.
    --
    -- Почему так. "nearest" и "root" читались по одному разу каждый, PostgreSQL 12+ такой
    -- CTE инлайнит, и в плане обе половины оказывались внутри "Nested Loop Left Join":
    -- материализованный набор из 2500 строк пересканировался на КАЖДУЮ из 5000 строк
    -- поддерева — 12,5 млн сравнений вместо одного хеш-соединения. Выбор соединения зависит
    -- от оценок и потому был нестабилен между прогонами (отсюда и два режима), а пересчёт
    -- идёт ВНУТРИ транзакции правки владельца ("executor.ts"): «повезёт с планом» там не
    -- аргумент. Группировка убирает выбор: обе величины берутся за один проход по "proj",
    -- и соединение с поддеревом остаётся ровно одно.
    --
    -- Равенство форм проверено на данных, а не выведено: "(array_agg(x ORDER BY …))[1]" —
    -- это и есть первая строка "DISTINCT ON" с тем же ORDER BY, и выдачи обеих форм совпали
    -- и на поддереве 4999 узлов, и на поддереве из шести.
    picked AS (
      SELECT start_id,
             (array_agg(project_id ORDER BY depth ASC, created_at ASC, project_id ASC))[1]
               AS parent_project,
             (array_agg(project_id ORDER BY depth DESC, created_at ASC, project_id ASC))[1]
               AS root_project
        FROM proj GROUP BY start_id
    ),
    computed AS (
      SELECT s.id, p.parent_project, p.root_project
        FROM subtree s
        LEFT JOIN picked p ON p.start_id = s.id
    )
    UPDATE entities e
       SET props = (e.props - ${PROP_PARENT_PROJECT}::text - ${PROP_ROOT_PROJECT}::text)
                 || CASE WHEN c.parent_project IS NULL THEN '{}'::jsonb
                         ELSE jsonb_build_object(${PROP_PARENT_PROJECT}::text,
                                                 to_jsonb(c.parent_project::text)) END
                 || CASE WHEN c.root_project IS NULL THEN '{}'::jsonb
                         ELSE jsonb_build_object(${PROP_ROOT_PROJECT}::text,
                                                 to_jsonb(c.root_project::text)) END
      FROM computed c
     WHERE e.id = c.id
       -- Строки с неизменившимся значением не трогаем вовсе: пересчёт поддерева обязан
       -- быть дешёвым на «перетащили одну задачу», а не переписывать всё поддерево целиком.
       AND (e.props->>${PROP_PARENT_PROJECT}::text IS DISTINCT FROM c.parent_project::text
         OR e.props->>${PROP_ROOT_PROJECT}::text IS DISTINCT FROM c.root_project::text)
    RETURNING e.id`)) as unknown as Array<{ id: string }>;

  return { recomputed: rows.length };
}
