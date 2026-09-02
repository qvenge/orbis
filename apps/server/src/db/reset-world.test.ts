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
import { appendMessageIdempotent } from '../chat/messages';
import { ensureGlobalThread } from '../chat/threads';
import { execute } from '../executor/executor';
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
import { withIdentity } from './with-identity';

requireEnv();

const ADMIN_DSN = process.env.DATABASE_URL_ADMIN as string;

// Прод-подобные DSN для разбора подтверждения. Секретов в них нет — пароль выдуман, хост
// взят из runbook §1 как форма, а не как доступ.
const PROD_REF = 'ceovqtdibalxnqkgedrl';
const PROD_DSN = `postgresql://postgres.${PROD_REF}:pa%40ss:word@aws-0-eu-central-1.pooler.supabase.com:5432/postgres`;
// Форма локального стенда: имени проекта в ней нет ни в пользователе, ни в хосте.
const LOCAL_DSN_SHAPE = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';

/** Шесть таблиц графа и журнала — тот же список, что сносит операция (порядок отчёта). */
const GRAPH_TABLES_UNDER_TEST = [
  'entities',
  'relations',
  'chat_threads',
  'chat_messages',
  'entity_origins',
  'entity_versions',
] as const;

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
    expect(prodRefFromDsn(LOCAL_DSN_SHAPE)).toBeNull();
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

  // Каждый отказ проверяется ПРИЧИНОЙ, а не только кодом 2: код 2 у всех один, и по нему
  // ветки гейта неразличимы — снятая ветка деградировала бы в соседнюю молча (например,
  // «ref не выводится» превратился бы в «--confirm не совпал с null»).
  const refusals: [string, string, string[], string][] = [
    [
      'чужой ref',
      PROD_DSN,
      ['--confirm', 'not-our-project', '--i-understand', 'RESET'],
      'не совпадает с проектом подключения',
    ],
    ['без второго флага', PROD_DSN, ['--confirm', PROD_REF], 'нет второго подтверждения'],
    [
      'другое слово во втором флаге',
      PROD_DSN,
      ['--confirm', PROD_REF, '--i-understand', 'reset'],
      'ожидает точное слово',
    ],
    [
      'незнакомый флаг',
      PROD_DSN,
      ['--confirm', PROD_REF, '--i-understand', 'RESET', '--force'],
      'неизвестный аргумент',
    ],
    // Локальный DSN ref не несёт — подтверждать нечем. Без этой строки ветку можно удалить
    // целиком, и все прочие тесты останутся зелёными: без `--confirm` печаталось бы
    // «проект: null», с `--confirm null` — отказ по несовпадению; отказ бы уцелел, а текст
    // деградировал незаметно.
    [
      'ref из DSN не выводится',
      LOCAL_DSN_SHAPE,
      ['--confirm', PROD_REF, '--i-understand', 'RESET'],
      'подтверждать нечем',
    ],
    ['ref не выводится и флагов нет', LOCAL_DSN_SHAPE, [], 'подтверждать нечем'],
  ];
  for (const [name, dsn, args, reason] of refusals) {
    test(`отказ до любой записи: ${name}`, async () => {
      const said: string[] = [];
      const code = await runResetWorld(args, {
        readDsn: () => dsn,
        openSql: () => {
          throw new Error('соединение открыто ДО подтверждения');
        },
        log: (l) => said.push(l),
        error: (l) => said.push(l),
      });
      expect([name, code]).toEqual([name, 2]);
      expect(said.join('\n')).toContain(reason);
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
    const seeded = (await admin.execute(
      sql`SELECT id FROM entities WHERE owner_id = ${owner}::uuid ORDER BY id LIMIT 2`,
    )) as unknown as { id: string }[];
    const entity = seeded[0];
    const second = seeded[1];
    if (entity === undefined || second === undefined) {
      throw new Error('онбординг не посеял двух сущностей');
    }
    // Ребро и сообщение треда — БОЕВЫМ путём, и они здесь не для полноты картины: онбординг
    // не пишет ни того, ни другого, поэтому без них «relations и chat_messages снесены»
    // доказывалось бы не данными, а только тем, что TRUNCATE без CASCADE упал бы на FK. Для
    // таблицы, которая однажды выйдет из-под FK, этого пина не будет вовсе.
    const edge = await execute(app, {
      actorUserId: owner,
      actorKind: 'owner',
      source: 'fast_path',
      operations: [
        {
          tool: 'relation_create',
          input: { source_id: entity.id, target_id: second.id, role: 'mention' },
        },
      ],
    });
    if (!edge.ok) throw new Error(`ребро фикстуры не создано: ${JSON.stringify(edge.error)}`);
    await withIdentity(app, owner, async (tx) => {
      const threadId = await ensureGlobalThread(tx, owner);
      await appendMessageIdempotent(tx, {
        id: newId(),
        threadId,
        role: 'user',
        content: 'сообщение фикстуры пересева',
      });
    });
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
    // Все ШЕСТЬ таблиц сноса непусты ДО операции — иначе «снесено» ниже проверяло бы пустоту,
    // которая и так была.
    for (const table of GRAPH_TABLES_UNDER_TEST) {
      const n = await count(table);
      expect([table, n > 0]).toEqual([table, true]);
    }

    const raw = postgres(ADMIN_DSN, { max: 1 });
    let report: Awaited<ReturnType<typeof resetWorld>>;
    try {
      report = await resetWorld(raw, ADMIN_DSN);
    } finally {
      await raw.end();
    }

    // Отчёт называет снесённое поимённо — по нему оператор сверяет масштаб.
    expect(report.graph.entities).toBe(SEED_WORLD_SIZE + 1);
    expect(report.graph.relations).toBe(1);
    expect(report.graph.chat_messages).toBe(1);
    expect(report.graph.entity_origins).toBe(1);
    expect(report.graph.entity_versions).toBe(1);
    expect(report.deltas).toBe(1);
    expect(report.definitions.property_definitions).toBe(1);
    expect(report.definitions.aspect_definitions).toBe(1);
    expect(report.settingsReset).toBe(2);

    // Граф и журнал — начисто.
    for (const table of [...GRAPH_TABLES_UNDER_TEST, 'registry_deltas']) {
      expect([table, await count(table)]).toEqual([table, 0]);
    }
    // Снимок «после» самой операции говорит то же самое — им оператор Шага 6 и сверяется.
    expect(Object.values(report.after.graph)).toEqual([0, 0, 0, 0, 0, 0]);
    expect(report.after.deltas).toBe(0);
    expect(report.after.ownerDefinitions).toBe(0);
    expect(report.after.ownerVersionMax).toBe(0);
    expect(report.after.systemVersion).toBe(report.before.systemVersion + 1);

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

  test('шов: тот же владелец после пересева получает мир ЦЕЛИКОМ, а пины — живые id (Р-24-6)', async () => {
    // Тот самый шаг (9) runbook: владелец заходит в приложение после операции. Строку
    // `user_settings` пересев СОХРАНЯЕТ (в ней пины и дефолты), и пока «свежесть» владельца
    // определялась по ней, заход досевал четыре сущности из девятнадцати, а три пина
    // сайдбара указывали на снесённые id. Проба идёт ПОСЛЕ пересева в этом же describe —
    // именно в том состоянии базы, которое оставляет операция.
    expect(await count('entities', `owner_id = '${owner}'`)).toBe(0);

    const again = await seedOwner(app, owner);
    // `seeded: false` — строка настроек на месте, онбординг «уже был». Мир при этом посеян:
    // ответ про фазу настроек, а не про граф (см. докблок `seedOwner`).
    expect(again.seeded).toBe(false);
    expect(await count('entities', `owner_id = '${owner}'`)).toBe(SEED_WORLD_SIZE + 1);

    // Пины сходятся сами: id мира детерминированы от owner + слаг, и после пересева
    // возвращаются те же. Проверяется НЕ формула, а то, что каждая закреплённая сущность
    // существует, — иначе сайдбар покажет сырые uuid.
    const settings = (await admin.execute(
      sql`SELECT "pinnedEntities" AS pinned FROM user_settings WHERE owner_id = ${owner}::uuid`,
    )) as unknown as Array<{ pinned: Array<{ id: string }> }>;
    const pinned = settings[0]?.pinned ?? [];
    expect(pinned.length).toBeGreaterThan(0);
    for (const pin of pinned) {
      expect([pin.id, await count('entities', `id = '${pin.id}'`)]).toEqual([pin.id, 1]);
    }

    // Повторный заход ничего не удваивает — идемпотентность держит проба по PK, а не guard.
    await seedOwner(app, owner);
    expect(await count('entities', `owner_id = '${owner}'`)).toBe(SEED_WORLD_SIZE + 1);
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
