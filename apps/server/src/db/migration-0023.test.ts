// Миграция 0023 (спека 1в §6.5, §10): уход встроенной подписки Повестки — ЕДИНСТВЕННАЯ миграция среза,
// только данные. Проверяется САМ ФАЙЛ миграции, а не копия его SQL в тесте: копия прошла бы и тогда, когда
// файл потерял бы `DELETE` или задел бы чужие строки.
//
// Всё — в откатываемой транзакции админ-соединения: встроенная строка с движком `agenda`, пережившая тест,
// уронила бы строгую загрузку реестра (`subscriptionDefinitionSchema` без варианта `agenda`) всем сьютам
// общей базы.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { adminDb, freshGraph, requireEnv } from '../../test/helpers';

requireEnv();

const MIGRATION = new URL('./migrations/0023_agenda_subscription_drop.sql', import.meta.url);

/**
 * Прежняя декларация Повестки (`AGENDA_DEF` до среза 1в) — ЛИТЕРАЛОМ: норматив из кода ушёл вместе с
 * движком, а миграция обязана снять именно ту строку, которую сеял прод.
 */
const AGENDA_DEF_1B = {
  engine: 'agenda',
  params: ['window_from', 'window_to'],
  show: {
    contract: 'orbis/when',
    slot: 'moment',
    window: { from: { ctx: '$today' }, to: { param: 'window_to' } },
    prefer: [],
    sortBy: 'asc',
    limit: 200,
  },
  overdue: {
    contract: 'orbis/when',
    slots: ['deadline', 'moment'],
    before: { ctx: '$today' },
    where: { op: 'in', args: [{ class: { contract: 'orbis/completable' } }, { const: 'open' }] },
    prefer: [],
    limit: 200,
  },
  hide: { contract: 'orbis/recurrence', set: 'templates' },
};

class Rollback extends Error {}

/** Операторы файла по разделителю drizzle — тем же, по которому их режет мигратор. */
function statementsOf(text: string): string[] {
  return text
    .split('--> statement-breakpoint')
    .map((s) => s.trim())
    .filter((s) => s.replace(/--[^\n]*\n?/g, '').trim() !== '');
}

describe('миграция 0023: встроенная подписка Повестки уходит', () => {
  test('встроенной orbis/agenda нет; строка владельца с тем же id и Бюджет — на месте', async () => {
    const owner = await freshGraph();
    const statements = statementsOf(readFileSync(MIGRATION, 'utf8'));
    expect(statements.length).toBeGreaterThan(0);
    const { db, client } = adminDb();
    try {
      await db
        .transaction(async (tx) => {
          // Локальная база до пересева ещё держит встроенную строку — без этого вставка ниже упала бы
          // на `subscription_definitions_builtin_uniq`, а после пересева строки уже нет.
          await tx.execute(
            sql`DELETE FROM subscription_definitions WHERE id = 'orbis/agenda' AND graph_id IS NULL`,
          );
          await tx.execute(sql`INSERT INTO subscription_definitions (id, graph_id, surface, definition, module, rank)
            VALUES ('orbis/agenda', NULL, 'core/agenda', ${JSON.stringify(AGENDA_DEF_1B)}::jsonb, NULL, 900)`);
          await tx.execute(sql`INSERT INTO subscription_definitions (id, graph_id, surface, definition, module, rank)
            VALUES ('orbis/agenda', ${owner}::uuid, 'core/agenda', ${JSON.stringify(AGENDA_DEF_1B)}::jsonb, NULL, 901)`);

          for (const s of statements) await tx.execute(sql.raw(s));

          const rows =
            (await tx.execute(sql`SELECT id, graph_id::text AS graph_id FROM subscription_definitions
            WHERE id IN ('orbis/agenda', 'orbis/budget-overview')
              AND (graph_id IS NULL OR graph_id = ${owner}::uuid)
            ORDER BY id, graph_id NULLS FIRST`)) as unknown as {
              id: string;
              graph_id: string | null;
            }[];
          expect(rows.map((r) => [r.id, r.graph_id])).toEqual([
            // Строку владельца миграция НЕ трогает: её счёт — `migrate-1v --report` до миграции (§6.5).
            ['orbis/agenda', owner],
            ['orbis/budget-overview', null],
          ]);
          throw new Rollback();
        })
        .catch((e: unknown) => {
          if (!(e instanceof Rollback)) throw e;
        });
    } finally {
      await client.end();
    }
  });
});
