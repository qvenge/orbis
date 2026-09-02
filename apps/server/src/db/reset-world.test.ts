// apps/server/src/db/reset-world.test.ts
//
// Приёмка разрушающей прод-операции «Пересев мира» (РП-7, runbook §1) — против ЖИВОЙ
// локальной базы. Прод здесь не участвует: `ops.ts` с прод-DSN не запускается ни разу,
// проверяется та же функция, которую он зовёт, и тот же разбор подтверждения.
//
// Env: DATABASE_URL (роль приложения — ею сеется владелец) и DATABASE_URL_ADMIN (сама
// операция: снос чужих строк и запись system-строк реестра невозможны под RLS).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  BUILTIN_ASPECT_DEFS,
  BUILTIN_PROPERTY_META,
  BUILTIN_RELATION_ROLE_META,
  diffBuiltinRegistries,
  hasRegistryDrift,
  newId,
  REGISTRY_KINDS,
  type RegistryDbRow,
  type RegistryDbRows,
} from '@orbis/shared';
import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import {
  adminDb,
  appDb,
  freshUserId,
  requireEnv,
  seedCustomAspect,
  truncateAll,
} from '../../test/helpers';
import { previewMergeConflicts, type RegistryDeltaRow } from '../registry/deltas';
import { seedOwner } from '../seed/onboarding';
import { SEED_WORLD_SIZE } from '../seed/world';
import { REGISTRY_DELTAS_QUERY, REGISTRY_DRIFT_QUERIES } from './registry-drift';
import {
  DEFINITION_TABLES,
  prodRefFromDsn,
  resetWorld,
  resetWorldGate,
  runResetWorld,
} from './reset-world';
import { codeSystemDefinitions, readSystemDefinitions } from './seed-registries';

requireEnv();

const ADMIN_DSN = process.env.DATABASE_URL_ADMIN as string;

// Прод-подобные DSN для разбора подтверждения. Секретов в них нет — пароль выдуман, хост
// взят из runbook §1 как форма, а не как доступ.
const PROD_REF = 'ceovqtdibalxnqkgedrl';
const PROD_DSN = `postgresql://postgres.${PROD_REF}:pa%40ss:word@aws-0-eu-central-1.pooler.supabase.com:5432/postgres`;

const { db: admin, client: adminClient } = adminDb();
const { db: app, client: appClient } = appDb();

afterAll(async () => {
  await truncateAll();
  await adminClient.end();
  await appClient.end();
});

async function count(table: string, where = 'TRUE'): Promise<number> {
  const rows = (await admin.execute(
    sql`SELECT count(*)::int AS n FROM ${sql.raw(table)} WHERE ${sql.raw(where)}`,
  )) as unknown as { n: number }[];
  return rows[0]?.n ?? 0;
}

async function systemVersion(): Promise<number> {
  const rows = (await admin.execute(
    sql`SELECT version FROM registry_system WHERE id = 1`,
  )) as unknown as { version: number }[];
  const v = rows[0]?.version;
  if (v === undefined) throw new Error('нет строки registry_system id=1');
  return v;
}

describe('reset-world — подтверждение двумя флагами', () => {
  test('ref выводится из DSN: пулерный `postgres.<REF>` и прямой `db.<REF>.supabase.co`', () => {
    expect(prodRefFromDsn(PROD_DSN)).toBe(PROD_REF);
    expect(
      prodRefFromDsn(`postgresql://postgres:pwd@db.${PROD_REF}.supabase.co:5432/postgres`),
    ).toBe(PROD_REF);
    // Локальный стенд ref не несёт — и это отказ, а не послабление: подтверждать нечем.
    expect(prodRefFromDsn('postgres://postgres:postgres@127.0.0.1:54322/postgres')).toBeNull();
  });

  test('без --confirm: печатает ожидаемый ref, код 2, соединение НЕ открывает', async () => {
    const said: string[] = [];
    const code = await runResetWorld([], {
      readDsn: () => PROD_DSN,
      // Соединение здесь — уже полдела: разрушающая операция не должна доходить до базы,
      // пока подтверждение не сошлось. Мутация «открыть пул до проверки» роняет этот тест.
      openSql: () => {
        throw new Error('соединение открыто ДО подтверждения');
      },
      log: (l) => said.push(l),
      error: (l) => said.push(l),
    });
    expect(code).toBe(2);
    expect(said.join('\n')).toContain(PROD_REF);
    // Пароль DSN в выводе не появляется ни при каком исходе.
    expect(said.join('\n')).not.toContain('word');
  });

  const refusals: [string, string[]][] = [
    ['чужой ref', ['--confirm', 'not-our-project', '--i-understand', 'RESET']],
    ['без второго флага', ['--confirm', PROD_REF]],
    ['другое слово во втором флаге', ['--confirm', PROD_REF, '--i-understand', 'reset']],
    ['незнакомый флаг', ['--confirm', PROD_REF, '--i-understand', 'RESET', '--force']],
  ];
  for (const [name, args] of refusals) {
    test(`отказ до любой записи: ${name}`, async () => {
      const said: string[] = [];
      const code = await runResetWorld(args, {
        readDsn: () => PROD_DSN,
        openSql: () => {
          throw new Error('соединение открыто ДО подтверждения');
        },
        log: (l) => said.push(l),
        error: (l) => said.push(l),
      });
      expect(code).toBe(2);
    });
  }

  test('оба флага сошлись — операция ИДЁТ к базе (иначе гейт запрещал бы всё)', async () => {
    // Без этой пробы все отказы выше зеленели бы и на операции, которая не работает вовсе.
    await expect(
      runResetWorld(['--confirm', PROD_REF, '--i-understand', 'RESET'], {
        readDsn: () => PROD_DSN,
        openSql: () => {
          throw new Error('маркер: подтверждение принято');
        },
        log: () => {},
        error: () => {},
      }),
    ).rejects.toThrow('маркер: подтверждение принято');
  });

  test('гейт не смотрит на порядок флагов', () => {
    expect(resetWorldGate(PROD_DSN, ['--i-understand', 'RESET', '--confirm', PROD_REF])).toEqual({
      proceed: true,
    });
  });
});

describe('reset-world — состав пересева на живой базе', () => {
  const owner = freshUserId();
  const otherOwner = freshUserId();
  const clientId = `test-client-${newId()}`;
  let versionBefore = 0;

  beforeAll(async () => {
    await truncateAll();

    // Мир владельца — боевым путём: 19 сущностей через исполнитель, настройки, глобальный тред.
    await seedOwner(app, owner);

    // Собственное свойство владельца в реестре + дельта поверх системного аспекта: ровно то,
    // что пересев обязан снести (а `truncateAll` сносит и без него — потому проба и живёт
    // внутри самой операции, а не рядом).
    await seedCustomAspect(owner, {
      key: 'user/sleep-log',
      label: { ru: 'Сон' },
      properties: [{ key: 'hours', type: { kind: 'number' } }],
    });
    await admin.execute(
      sql`INSERT INTO registry_deltas (id, owner_id, target_kind, target_id, base_version, delta)
          VALUES (gen_random_uuid(), ${owner}::uuid, 'aspect', 'orbis/task', 0,
                  '{"label":{"ru":"Дело"}}'::jsonb)`,
    );
    await admin.execute(
      sql`UPDATE user_settings SET registry_version = 7 WHERE owner_id = ${owner}::uuid`,
    );

    // Доступы и метеринг — то, что пересев обязан СОХРАНИТЬ.
    await admin.execute(
      sql`INSERT INTO oauth_clients (client_id, client_name, redirect_uris)
          VALUES (${clientId}, 'тестовый клиент', ARRAY['https://example.invalid/cb'])`,
    );
    await admin.execute(
      sql`INSERT INTO agent_grants (id, owner_id, client_id, kind, label, scope)
          VALUES (${newId()}::uuid, ${owner}::uuid, ${clientId}, 'oauth', 'проба', 'full')`,
    );
    await admin.execute(
      sql`INSERT INTO ai_usage (owner_id, date, model, input_tokens, output_tokens, request_count)
          VALUES (${owner}::uuid, current_date, 'gpt-5.5', 10, 20, 1)`,
    );
    // Второй владелец — со строкой настроек и версией: пересев глобален, и обнулить он обязан
    // всех, а не только того, чей граф мы разглядываем.
    await admin.execute(
      sql`INSERT INTO user_settings (owner_id, registry_version) VALUES (${otherOwner}::uuid, 3)`,
    );
    // Журнальные таблицы наполняем прямо: боевой путь их пишет в других сценариях, а пересеву
    // важно, что они попадают под снос вместе с графом.
    const [entity] = (await admin.execute(
      sql`SELECT id FROM entities WHERE owner_id = ${owner}::uuid LIMIT 1`,
    )) as unknown as { id: string }[];
    if (entity === undefined) throw new Error('онбординг не посеял ни одной сущности');
    await admin.execute(
      sql`INSERT INTO entity_origins (id, owner_id, entity_id, namespace, external_id)
          VALUES (${newId()}::uuid, ${owner}::uuid, ${entity.id}::uuid, 'csv:проба', '1')`,
    );
    await admin.execute(
      sql`INSERT INTO entity_versions (id, owner_id, entity_id, label, body, actor_user_id, actor_kind)
          VALUES (${newId()}::uuid, ${owner}::uuid, ${entity.id}::uuid, 'проба', 'тело',
                  ${owner}::uuid, 'owner')`,
    );

    versionBefore = await systemVersion();
  });

  test('после пересева: граф пуст, реестры только системные, версии на месте, доступы целы', async () => {
    // Предусловие, без которого зелень ничего не значит: сносить было ЧТО.
    expect(await count('entities', `owner_id = '${owner}'`)).toBe(SEED_WORLD_SIZE + 1);
    expect(await count('registry_deltas')).toBe(1);
    expect(await count('property_definitions', 'owner_id IS NOT NULL')).toBe(1);
    expect(await count('aspect_definitions', 'owner_id IS NOT NULL')).toBe(1);
    expect(await count('chat_threads')).toBeGreaterThan(0);

    const raw = postgres(ADMIN_DSN, { max: 1 });
    let report: Awaited<ReturnType<typeof resetWorld>>;
    try {
      report = await resetWorld(raw, ADMIN_DSN);
    } finally {
      await raw.end();
    }

    // Отчёт называет снесённое поимённо — по нему оператор сверяет масштаб.
    expect(report.graph.entities).toBe(SEED_WORLD_SIZE + 1);
    expect(report.graph.entity_origins).toBe(1);
    expect(report.graph.entity_versions).toBe(1);
    expect(report.deltas).toBe(1);
    expect(report.definitions.property_definitions).toBe(1);
    expect(report.definitions.aspect_definitions).toBe(1);
    expect(report.settingsReset).toBe(2);

    // Граф и журнал — начисто.
    for (const table of [
      'entities',
      'relations',
      'chat_threads',
      'chat_messages',
      'entity_origins',
      'entity_versions',
      'registry_deltas',
    ]) {
      expect([table, await count(table)]).toEqual([table, 0]);
    }

    // Реестры — только системные строки, и ровно те, что в коде.
    for (const table of DEFINITION_TABLES) {
      expect([table, await count(table, 'owner_id IS NOT NULL')]).toEqual([table, 0]);
    }
    expect(await count('property_definitions')).toBe(BUILTIN_PROPERTY_META.length);
    expect(await count('relation_role_definitions')).toBe(BUILTIN_RELATION_ROLE_META.length);
    expect(await count('aspect_definitions')).toBe(BUILTIN_ASPECT_DEFS.length);

    // Версии: владельца — в ноль (у ОБОИХ), системная — на единицу вверх, её двигает сид.
    const settings = (await admin.execute(
      sql`SELECT owner_id, registry_version, plan, timezone FROM user_settings ORDER BY owner_id`,
    )) as unknown as { owner_id: string; registry_version: number; plan: string }[];
    expect(settings.map((s) => s.registry_version)).toEqual([0, 0]);
    expect(settings.map((s) => s.owner_id).sort()).toEqual([owner, otherOwner].sort());
    // Настройки СОХРАНЯЮТСЯ — обнуляется только версия: владелец заходит в то же приложение.
    expect(settings.every((s) => s.plan === 'dev')).toBe(true);
    expect(await systemVersion()).toBe(versionBefore + 1);
    expect(report.seed.version).toBe(versionBefore + 1);

    // Доступы, клиенты и метеринг — целы.
    expect(await count('agent_grants')).toBe(1);
    expect(await count('oauth_clients')).toBe(1);
    expect(await count('ai_usage')).toBe(1);
  });

  test('после пересева `check` чист: дрейфа реестров нет, конфликтов слияния нет', async () => {
    // Ровно то, что печатает `bun scripts/ops.ts check`, — теми же запросами и тем же
    // сравнением. Секрет Ключницы для этого не нужен, а вторая формулировка «что такое
    // чистый check» разошлась бы с первой.
    const rows = {} as RegistryDbRows;
    for (const kind of REGISTRY_KINDS) {
      rows[kind] = (await admin.execute(
        sql.raw(REGISTRY_DRIFT_QUERIES[kind]),
      )) as unknown as RegistryDbRow[];
    }
    expect(hasRegistryDrift(diffBuiltinRegistries(rows))).toBe(false);

    const deltaRows = (await admin.execute(sql.raw(REGISTRY_DELTAS_QUERY))) as unknown as Record<
      string,
      unknown
    >[];
    expect(deltaRows).toHaveLength(0);
    const raw = postgres(ADMIN_DSN, { max: 1 });
    try {
      const conflicts = previewMergeConflicts(
        await readSystemDefinitions(raw),
        codeSystemDefinitions(),
        deltaRows as unknown as RegistryDeltaRow[],
        await systemVersion(),
      );
      expect(conflicts).toEqual([]);
    } finally {
      await raw.end();
    }
  });
});
