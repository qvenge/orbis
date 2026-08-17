// apps/server/src/agent-loop/queries.ts
// Запросы круга исполнителя (§4.14, С7): читающие проверки и выборки, которыми
// пользуются гейты и глаголы. Все — под уже открытым `withIdentity`-tx вызывающего
// (RLS владельца), собственных мутаций здесь нет.
import { sql } from 'drizzle-orm';
import type { Tx } from '../db/with-identity';

/**
 * Инвариант 2 спеки: «скоуп worker не может тронуть чужое». Периметр записи фонового
 * исполнителя — треды НАЗНАЧЕННЫХ ему тикетов и их проектов: тикет он ведёт, а в проект
 * пишет сводку «готово, проверь» (С8/С9). Всё остальное в графе владельца ему закрыто.
 *
 * Один SQL вместо двух чтений: сущность годится, если она сама — тикет с назначением на
 * ЭТОТ грант, либо она родитель такого тикета (`relations.relation_type='parent'`,
 * направление как в грамматике §6: родитель — `source_id`, ребёнок — `target_id`).
 * Проверка назначения — containment по колонке `aspects` (индекс `entities_aspects_gin`),
 * а не разбор json-полей: так условие остаётся индексируемым.
 *
 * `executor: 'agent'` в пробе не декоративен: при `executor='human'` grant_id запрещён
 * инвариантом (assertAssignment), но проба обязана быть точной сама по себе — назначение
 * человеку не даёт прав никакому гранту.
 */
export async function isWorkerThreadTarget(
  tx: Tx,
  ownerId: string,
  grantId: string,
  entityId: string,
): Promise<boolean> {
  const assigned = JSON.stringify({
    'orbis/assignment': { executor: 'agent', grant_id: grantId },
  });
  const rows = await tx.execute(
    sql`SELECT 1 AS ok
        FROM entities t
        WHERE t.owner_id = ${ownerId}::uuid
          AND t.aspects @> ${assigned}::jsonb
          AND (
            t.id = ${entityId}::uuid
            OR EXISTS (
              SELECT 1 FROM relations r
              WHERE r.source_id = ${entityId}::uuid
                AND r.target_id = t.id
                AND r.relation_type = 'parent'
            )
          )
        LIMIT 1`,
  );
  return rows.length > 0;
}
