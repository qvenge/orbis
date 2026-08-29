// apps/server/src/db/registry-drift.test.ts
// Серверная половина стартовой проверки реестров (E1, §А12-1 п.4): чтение ШЕСТИ таблиц под
// ролью приложения. Именно она ловит то, чего не видят unit'ы shared, — права роли: без
// SET LOCAL ROLE authenticated запрос падает «permission denied» на каждом старте (роль
// приложения NOINHERIT, гранты висят на authenticated), а забытый GRANT новой таблице даёт
// 42501 ещё до всякой политики.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { hasRegistryDrift, newId } from '@orbis/shared';
import { sql } from 'drizzle-orm';
import { adminDb, appDb, freshUserId, requireEnv, truncateAll } from '../../test/helpers';
import { withIdentity } from '../db/with-identity';
import { approvePending } from '../policy/pending';
import { effectiveRegistry } from '../registry/cache';
import { type RegistryDeltaRow, threeWayMerge, UNKNOWN_PREV_SYSTEM } from '../registry/deltas';
import { createDriftConflictUnits } from '../registry/merge-conflict';
import {
  checkRegistryDrift,
  REGISTRY_DELTAS_QUERY,
  reportRegistryDriftOnStartup,
} from './registry-drift';
import { codeSystemDefinitions } from './seed-registries';

requireEnv();

const { db, client } = appDb();
const admin = adminDb();

/**
 * Сеть безопасности файла: тесты ниже намеренно ПОРТЯТ общие реестры, а по ним валидирует
 * исполнитель во ВСЕХ остальных серверных сьютах прогона — упавший на середине тест не
 * имеет права оставить локальную БД в состоянии «фича мертва», иначе следом посыплется
 * весь прогон.
 *
 * Снимок ТАБЛИЦ ЦЕЛИКОМ (`to_jsonb` → `jsonb_populate_recordset`), а не повтор upsert'а из
 * сидера: список колонок не дублируется, и следующая миграция реестров не забудет про этот
 * файл.
 */
const SNAPSHOT_TABLES = [
  'property_definitions',
  'aspect_definitions',
  'relation_role_definitions',
  'contract_definitions',
  'subscription_definitions',
  'action_definitions',
] as const;

const snapshots = new Map<string, string>();

async function saveRegistries(): Promise<void> {
  for (const table of SNAPSHOT_TABLES) {
    const rows = (await admin.db.execute(
      sql`SELECT coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) AS rows
          FROM ${sql.raw(table)} t WHERE owner_id IS NULL`,
    )) as unknown as { rows: unknown }[];
    snapshots.set(table, JSON.stringify(rows[0]?.rows ?? []));
  }
}

async function restoreRegistries(): Promise<void> {
  for (const table of SNAPSHOT_TABLES) {
    await admin.db.execute(sql`DELETE FROM ${sql.raw(table)} WHERE owner_id IS NULL`);
    await admin.db.execute(
      sql`INSERT INTO ${sql.raw(table)}
          SELECT * FROM jsonb_populate_recordset(NULL::${sql.raw(table)},
            ${snapshots.get(table) ?? '[]'}::jsonb)`,
    );
  }
}

beforeAll(async () => {
  await truncateAll();
  await saveRegistries();
});

afterAll(async () => {
  await restoreRegistries();
  await admin.client.end();
  await client.end();
});

test('засеянные реестры: расхождений нет и запросы проходят под ролью приложения', async () => {
  const drift = await checkRegistryDrift(db);
  expect(hasRegistryDrift(drift)).toBe(false);
  const empty = { missing: [], drifted: [], extra: [] };
  expect(drift).toEqual({
    properties: empty,
    aspects: empty,
    roles: empty,
    contracts: empty,
    subscriptions: empty,
    actions: empty,
  });
});

/**
 * Пин обещания докблока `checkRegistryDrift`. Без него «шесть запросов видят один снапшот»
 * остаётся словами: транзакция по умолчанию READ COMMITTED, и каждый SELECT в ней берёт
 * СВОЙ снапшот (замерено пробоем) — то есть ровно то, что докблок обещал и чего не делал.
 *
 * Проверка ПОВЕДЕНЧЕСКАЯ, а не «в вызов передан объект конфига»: прокси-`Db` пробрасывает
 * вызов настоящему и внутри ТОЙ ЖЕ транзакции спрашивает у PostgreSQL, в каком режиме она
 * фактически открыта. Аргумент можно передать и мимо драйвера, режим соврать не может.
 */
test('чтение идёт в REPEATABLE READ и READ ONLY (снапшот один на шесть запросов)', async () => {
  let mode: { iso: string; ro: string } | undefined;
  const spy = {
    transaction: (fn: unknown, config: unknown) =>
      (db as unknown as { transaction: (f: unknown, c: unknown) => Promise<unknown> }).transaction(
        async (tx: { execute: (q: unknown) => Promise<unknown> }) => {
          const r = (await tx.execute(sql`SELECT current_setting('transaction_isolation') AS iso,
                                                 current_setting('transaction_read_only') AS ro`)) as unknown as {
            iso: string;
            ro: string;
          }[];
          mode = r[0];
          return (fn as (t: unknown) => Promise<unknown>)(tx);
        },
        config,
      ),
  } as unknown as typeof db;

  const drift = await checkRegistryDrift(spy);
  expect(mode).toEqual({ iso: 'repeatable read', ro: 'on' });
  // И сама сверка при этом работает — режим не сломал ни SET LOCAL ROLE, ни запросы.
  expect(hasRegistryDrift(drift)).toBe(false);
});

test('label свойства в БД разошёлся с кодом — drifted с именем столбца', async () => {
  try {
    await admin.db.execute(
      sql`UPDATE property_definitions SET label = '{"ru":"Не тот"}'::jsonb
          WHERE id = 'orbis/amount' AND owner_id IS NULL`,
    );
    const drift = await checkRegistryDrift(db);
    expect(drift.properties.drifted).toEqual([{ id: 'orbis/amount', what: ['label'] }]);
  } finally {
    await restoreRegistries();
  }
  expect(hasRegistryDrift(await checkRegistryDrift(db))).toBe(false);
});

test('колонка schema аспекта устарела — drifted (носитель СТАРОЙ формы, Р-24)', async () => {
  try {
    await admin.db.execute(
      sql`UPDATE aspect_definitions SET schema = '{"type":"object"}'::jsonb
          WHERE id = 'orbis/financial' AND owner_id IS NULL`,
    );
    const drift = await checkRegistryDrift(db);
    expect(drift.aspects.drifted).toEqual([{ id: 'orbis/financial', what: ['schema'] }]);
  } finally {
    await restoreRegistries();
  }
  expect(hasRegistryDrift(await checkRegistryDrift(db))).toBe(false);
});

test('роли нет в реестре — missing (релиз добавил роль без пересева)', async () => {
  try {
    await admin.db.execute(
      sql`DELETE FROM relation_role_definitions WHERE id = 'mention' AND owner_id IS NULL`,
    );
    expect((await checkRegistryDrift(db)).roles.missing).toEqual(['mention']);
  } finally {
    await restoreRegistries();
  }
  expect(hasRegistryDrift(await checkRegistryDrift(db))).toBe(false);
});

// Р-23: до реформы лишняя встроенная строка дрейфом НЕ считалась — свойство, удалённое из
// кода, продолжало валидировать данные в проде молча.
test('лишняя system-строка свойства — extra, а не тишина (Р-23)', async () => {
  try {
    await admin.db.execute(
      sql`INSERT INTO property_definitions (id, owner_id, key, label, description, type, rank)
          VALUES ('orbis/zzz', NULL, 'orbis/zzz', '{"ru":"Ж"}'::jsonb, '{"ru":"Ж"}'::jsonb,
                  '{"kind":"text"}'::jsonb, 999)`,
    );
    const drift = await checkRegistryDrift(db);
    expect(drift.properties.extra).toEqual(['orbis/zzz']);
    expect(hasRegistryDrift(drift)).toBe(true);
  } finally {
    await restoreRegistries();
  }
});

// §А12-1: контракты, подписки и действия срез А создаёт ПУСТЫМИ; их сиды — первый акт
// среза Б-1 после гейта П5. Строка, положенная раньше, обязана быть видна.
test('system-строка в contract_definitions и action_definitions — extra (в срезе А они пусты)', async () => {
  try {
    await admin.db.execute(
      sql`INSERT INTO contract_definitions (id, owner_id, key, label, description, kind, rank)
          VALUES ('orbis/completable', NULL, 'orbis/completable', '{"ru":"З"}'::jsonb,
                  '{"ru":"З"}'::jsonb, 'slots', 1)`,
    );
    await admin.db.execute(
      sql`INSERT INTO action_definitions (id, owner_id, key, label, description)
          VALUES ('orbis/close', NULL, 'orbis/close', '{"ru":"З"}'::jsonb, '{"ru":"З"}'::jsonb)`,
    );
    const drift = await checkRegistryDrift(db);
    expect(drift.contracts.extra).toEqual(['orbis/completable']);
    expect(drift.actions.extra).toEqual(['orbis/close']);
  } finally {
    await restoreRegistries();
  }
  expect(hasRegistryDrift(await checkRegistryDrift(db))).toBe(false);
});

// Кастомные строки эталона в коде не имеют — дрейфом они не бывают ни в какую сторону.
test('кастомные строки владельца сверку не трогают', async () => {
  const owner = crypto.randomUUID();
  try {
    await admin.db.execute(
      sql`INSERT INTO property_definitions (id, owner_id, key, label, description, type, rank)
          VALUES ('user/mood', ${owner}::uuid, 'user/mood', '{"ru":"Настроение"}'::jsonb,
                  '{"ru":"Настроение"}'::jsonb, '{"kind":"text"}'::jsonb, 1)`,
    );
    expect(hasRegistryDrift(await checkRegistryDrift(db))).toBe(false);
  } finally {
    await admin.db.execute(sql`DELETE FROM property_definitions WHERE owner_id IS NOT NULL`);
  }
});

/**
 * ДЕЛЬТЫ ПОД РОЛЬЮ ПРИЛОЖЕНИЯ НЕ ВИДНЫ — и это причина, по которой предпросмотр конфликтов
 * слияния (§А3-3) живёт в `ops.ts check`, а не в /health.
 *
 * Утверждение проверяемое, а не пояснительное: политика `owner_owns_row` (0014) скоупит
 * `registry_deltas` по `auth.uid()`, у стартовой проверки актора нет вовсе, и «конфликтов
 * ноль» в /health означало бы не «их нет», а «их некому увидеть». Проба ниже кладёт живую
 * дельту и показывает обе стороны: админская роль её видит, роль приложения — нет.
 */
test('registry_deltas: админ видит строку, роль приложения — ни одной (RLS без актора)', async () => {
  const owner = crypto.randomUUID();
  try {
    await admin.db.execute(
      sql`INSERT INTO registry_deltas (id, owner_id, target_kind, target_id, base_version, delta)
          VALUES (gen_random_uuid(), ${owner}::uuid, 'aspect', 'orbis/task', 1,
                  '{"label":{"ru":"Дело"}}'::jsonb)`,
    );
    const byAdmin = (await admin.db.execute(
      sql.raw(REGISTRY_DELTAS_QUERY),
    )) as unknown as unknown[];
    expect(byAdmin.length).toBeGreaterThan(0);

    const byApp = await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE authenticated`);
      return (await tx.execute(sql.raw(REGISTRY_DELTAS_QUERY))) as unknown as unknown[];
    });
    expect(byApp.length).toBe(0);
  } finally {
    await admin.db.execute(sql`DELETE FROM registry_deltas WHERE owner_id = ${owner}::uuid`);
  }
});

// Три состояния вместо двух: «проверка не выполнилась» обязано отличаться от «расхождений
// нет». Раньше одна неудачная попытка навсегда снимала ловушку, а /health отвечал ровно как
// на здоровом реестре — то есть штатная операторская проверка (runbook §1) давала
// ложноотрицательный ответ.
describe('reportRegistryDriftOnStartup: провал ≠ «дрейфа нет»', () => {
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

  test('здоровые реестры → status ok', async () => {
    expect(await reportRegistryDriftOnStartup(db, { delays: [] })).toEqual({ status: 'ok' });
  });

  test('БД недоступна на первой попытке → повтор, и проверка всё же выполняется', async () => {
    const waits: number[] = [];
    const r = await reportRegistryDriftOnStartup(flakyDb(2), {
      delays: [1, 2, 3],
      wait: async (ms: number) => {
        waits.push(ms);
      },
    });
    expect(r).toEqual({ status: 'ok' });
    expect(waits).toEqual([1, 2]); // ровно две паузы на два отказа
  });

  test('попытки исчерпаны → status unknown, а НЕ «расхождений нет»', async () => {
    const r = await reportRegistryDriftOnStartup(flakyDb(99), {
      delays: [1, 1],
      wait: async () => {},
    });
    expect(r).toEqual({ status: 'unknown' });
  });
});

// ---------------------------------------------------------------------------
// §А3-3: конфликты трёхстороннего слияния → единицы пачки (Задача 15)
// ---------------------------------------------------------------------------

describe('конфликты пересева становятся единицами пачки (§А3-3)', () => {
  const owner = freshUserId();

  test('«вариант рядом с похожим» → единица пачки с aspect_delta_set; approve применяет дельту', async () => {
    // Владелец добавил в `orbis/content_type` два своих варианта. У первого подпись
    // совпадает с системным «Markdown», ключ — другой: это ровно тот ряд §А3-3, где
    // молчаливого правильного ответа нет («слить их может только владелец»). Второй
    // ни на что не похож и обязан пережить разбор — иначе «слить» стоило бы владельцу
    // настройки, о которой его не спрашивали.
    const row: RegistryDeltaRow = {
      id: newId(),
      ownerId: owner,
      targetKind: 'aspect',
      targetId: 'orbis/note',
      baseVersion: 0,
      delta: {
        selectOptions: {
          'orbis/content_type': {
            add: [
              { key: 'md', label: { ru: 'Markdown' }, rank: 10 },
              { key: 'table', label: { ru: 'Таблица' }, rank: 11 },
            ],
          },
        },
      },
    };
    const { merged, conflicts } = threeWayMerge(UNKNOWN_PREV_SYSTEM, codeSystemDefinitions(), row);
    expect(conflicts.map((c) => c.kind)).toEqual(['variant-merge']);
    // Ключи пары — СТРУКТУРНО: единица собирается по ним, а не разбором человеческого текста.
    expect(conflicts[0]?.option).toEqual({ mine: 'md', theirs: 'markdown' });

    const ids = await withIdentity(db, owner, (tx) =>
      createDriftConflictUnits(tx, {
        ownerId: owner,
        systemVersion: 7,
        deltaRowId: row.id,
        merged,
        conflicts,
      }),
    );
    expect(ids).toHaveLength(1);
    const pendingId = ids[0] as string;

    const rows = (await withIdentity(db, owner, (tx) =>
      tx.execute(sql`SELECT content, metadata FROM chat_messages WHERE id = ${pendingId}::uuid`),
    )) as unknown as Array<{ content: string; metadata: Record<string, unknown> }>;
    const pending = (rows[0]?.metadata as { pending: Record<string, unknown> }).pending;
    // Единица — ОТ СИСТЕМЫ: у деплойного слияния актора нет вовсе (находка 46).
    expect(pending).toMatchObject({ actor_kind: 'system', source: 'system', kind: 'action' });
    expect(pending.tool).toBe('aspect_delta_set');
    // «Слить» = принять: в нагрузке ПОХОЖЕГО варианта уже нет, а непохожий остался.
    const input = pending.input as { aspect: string; delta: Record<string, unknown> };
    expect(input.aspect).toBe('orbis/note');
    const added = (input.delta.selectOptions as Record<string, { add: Array<{ key: string }> }>)[
      'orbis/content_type'
    ]?.add;
    expect(added?.map((o) => o.key)).toEqual(['table']);

    // Повторный прогон пересева той же версии второй карточки не кладёт.
    const again = await withIdentity(db, owner, (tx) =>
      createDriftConflictUnits(tx, {
        ownerId: owner,
        systemVersion: 7,
        deltaRowId: row.id,
        merged,
        conflicts,
      }),
    );
    expect(again).toEqual([pendingId]);
    const count = (await withIdentity(db, owner, (tx) =>
      tx.execute(sql`SELECT id FROM chat_messages
                     WHERE metadata @> '{"pending":{"tool":"aspect_delta_set"}}'::jsonb`),
    )) as unknown as unknown[];
    expect(count).toHaveLength(1);

    // approve ПРИМЕНЯЕТ дельту обычным конвейером — своего пути записи у конфликта нет.
    const approved = await approvePending(db, { ownerId: owner, pendingId });
    expect(approved.ok).toBe(true);
    const reg = await withIdentity(db, owner, (tx) => effectiveRegistry(tx, owner));
    const options = reg.properties.get('orbis/content_type')?.type;
    const keys =
      options?.kind === 'select' ? options.options.map((o: { key: string }) => o.key) : [];
    expect(keys).toContain('table');
    expect(keys).not.toContain('md');
    expect(keys).toContain('markdown');
  });
});
