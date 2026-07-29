// apps/server/src/db/aspect-drift.test.ts
// Серверная половина стартовой проверки реестра (E1): чтение aspect_definitions под
// ролью приложения. Именно она ловит то, чего не видят unit'ы shared, — права роли:
// без SET LOCAL ROLE authenticated запрос падает «permission denied» на каждом старте
// (роль приложения NOINHERIT, гранты висят на authenticated).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { hasAspectDrift } from '@orbis/shared';
import { sql } from 'drizzle-orm';
import { adminDb, appDb, requireEnv, truncateAll } from '../../test/helpers';
import { checkAspectDrift, driftReport, reportAspectDriftOnStartup } from './aspect-drift';

requireEnv();

const { db, client } = appDb();
const admin = adminDb();

/**
 * Сеть безопасности файла: тесты ниже намеренно ПОРТЯТ общий реестр, а по нему валидирует
 * исполнитель во ВСЕХ остальных серверных сьютах прогона — упавший на середине тест не
 * имеет права оставить локальную БД в состоянии «фича мертва», иначе следом посыплется
 * весь прогон.
 *
 * Снимок ТАБЛИЦЫ ЦЕЛИКОМ (`to_jsonb` → `jsonb_populate_recordset`), а не повтор upsert'а
 * из сидера: список колонок не дублируется, и следующая миграция аспектов не забудет
 * про этот файл.
 */
let registrySnapshot = '[]';

async function saveRegistry(): Promise<void> {
  const rows = (await admin.db.execute(
    sql`SELECT coalesce(jsonb_agg(to_jsonb(a)), '[]'::jsonb) AS rows
        FROM aspect_definitions a WHERE owner_id IS NULL`,
  )) as unknown as Array<{ rows: unknown }>;
  registrySnapshot = JSON.stringify(rows[0]?.rows ?? []);
}

async function restoreRegistry(): Promise<void> {
  await admin.db.execute(sql`DELETE FROM aspect_definitions WHERE owner_id IS NULL`);
  await admin.db.execute(
    sql`INSERT INTO aspect_definitions
        SELECT * FROM jsonb_populate_recordset(NULL::aspect_definitions,
          ${registrySnapshot}::jsonb)`,
  );
}

beforeAll(async () => {
  await truncateAll();
  await saveRegistry();
});

afterAll(async () => {
  await restoreRegistry();
  await admin.client.end();
  await client.end();
});

test('засеянный реестр: расхождений нет и запрос проходит под ролью приложения', async () => {
  const drift = await checkAspectDrift(db);
  expect(drift).toEqual({ missing: [], drifted: [] });
  expect(hasAspectDrift(drift)).toBe(false);
});

test('расхождение схемы в БД видно проверке и названо в отчёте', async () => {
  const before = await admin.db.execute(
    sql`SELECT schema FROM aspect_definitions WHERE id = 'orbis/financial' AND owner_id IS NULL`,
  );
  const original = (before as unknown as { schema: unknown }[])[0]?.schema;
  try {
    await admin.db.execute(
      sql`UPDATE aspect_definitions SET schema = ${sql.raw('\'{"type":"object"}\'::jsonb')}
          WHERE id = 'orbis/financial' AND owner_id IS NULL`,
    );
    const drift = await checkAspectDrift(db);
    expect(drift.drifted).toEqual([{ id: 'orbis/financial', what: ['schema'] }]);
    expect(driftReport(drift)[0]).toContain('orbis/financial');
  } finally {
    await admin.db.execute(
      sql`UPDATE aspect_definitions SET schema = ${JSON.stringify(original)}::jsonb
          WHERE id = 'orbis/financial' AND owner_id IS NULL`,
    );
  }
  expect(hasAspectDrift(await checkAspectDrift(db))).toBe(false);
});

test('аспект отсутствует в реестре: missing (релиз добавил аспект без пересева)', async () => {
  // Снимок строки целиком через to_jsonb и восстановление через jsonb_populate_record:
  // перечислять колонки руками — значит забыть новую при следующей миграции.
  const before = await admin.db.execute(
    sql`SELECT to_jsonb(a) AS row FROM aspect_definitions a
        WHERE id = 'orbis/memory' AND owner_id IS NULL`,
  );
  const snapshot = (before as unknown as { row: unknown }[])[0]?.row;
  expect(snapshot).toBeDefined();
  try {
    await admin.db.execute(
      sql`DELETE FROM aspect_definitions WHERE id = 'orbis/memory' AND owner_id IS NULL`,
    );
    const drift = await checkAspectDrift(db);
    expect(drift.missing).toEqual(['orbis/memory']);
  } finally {
    await admin.db.execute(
      sql`INSERT INTO aspect_definitions
          SELECT * FROM jsonb_populate_record(NULL::aspect_definitions,
            ${JSON.stringify(snapshot)}::jsonb)`,
    );
  }
  expect(hasAspectDrift(await checkAspectDrift(db))).toBe(false);
});

// Три состояния вместо двух (фикс-раунд по находке ревью): «проверка не выполнилась»
// обязано отличаться от «расхождений нет». Раньше одна неудачная попытка навсегда
// снимала ловушку, а /health отвечал ровно как на здоровом реестре — то есть штатная
// операторская проверка (runbook §1) давала ложноотрицательный ответ.
describe('reportAspectDriftOnStartup: провал ≠ «дрейфа нет»', () => {
  /** Заглушка Db, чья транзакция падает n раз, а дальше зовёт настоящую. */
  function flakyDb(failures: number) {
    let left = failures;
    return {
      transaction: (fn: unknown) => {
        if (left > 0) {
          left -= 1;
          return Promise.reject(new Error('connection refused'));
        }
        return (db as unknown as { transaction: (f: unknown) => Promise<unknown> }).transaction(fn);
      },
    } as unknown as typeof db;
  }

  test('здоровый реестр → status ok', async () => {
    expect(await reportAspectDriftOnStartup(db, { delays: [] })).toEqual({ status: 'ok' });
  });

  test('БД недоступна на первой попытке → повтор, и проверка всё же выполняется', async () => {
    const waits: number[] = [];
    const r = await reportAspectDriftOnStartup(flakyDb(2), {
      delays: [1, 2, 3],
      wait: async (ms) => {
        waits.push(ms);
      },
    });
    expect(r).toEqual({ status: 'ok' });
    expect(waits).toEqual([1, 2]); // ровно две паузы на два отказа
  });

  test('попытки исчерпаны → status unknown, а НЕ «расхождений нет»', async () => {
    const r = await reportAspectDriftOnStartup(flakyDb(99), {
      delays: [1, 1],
      wait: async () => {},
    });
    expect(r).toEqual({ status: 'unknown' });
  });
});
