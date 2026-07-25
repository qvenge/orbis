// scripts/ops.ts — именованные операции против ПРОДА.
//
// Зачем обёртка, а не голый DSN в окружении: админский DSN умеет и `DROP TABLE`.
// Здесь он не отдаётся наружу и не печатается — операции перечислены поимённо,
// всё остальное отклоняется. Это принцип наименьших полномочий: ассистент может
// запустить `seed-aspects`, но не «что угодно на проде».
//
// Секрет живёт в Ключнице macOS, а не в файле репозитория:
//   security add-generic-password -a orbis -s orbis-prod-admin -U -w '<DSN>'
// Читается через `security find-generic-password -w`. В git его нет, в транскрипт
// он не попадает, на диске открытым текстом не лежит.
//
// Использование:
//   bun scripts/ops.ts check          # только чтение: расхождение реестра аспектов с кодом
//   bun scripts/ops.ts seed-aspects   # upsert встроенных аспектов (идемпотентно)
//   bun scripts/ops.ts ping           # связность и версия PostgreSQL
import { aspectJsonSchema, BUILTIN_ASPECT_META } from '@orbis/shared';
import postgres from 'postgres';

const KEYCHAIN_ACCOUNT = 'orbis';
const KEYCHAIN_SERVICE = 'orbis-prod-admin';

/** Читает прод-DSN из Ключницы. Значение не логируется ни при каком исходе. */
function readDsn(): string {
  const r = Bun.spawnSync([
    'security',
    'find-generic-password',
    '-a',
    KEYCHAIN_ACCOUNT,
    '-s',
    KEYCHAIN_SERVICE,
    '-w',
  ]);
  const dsn = new TextDecoder().decode(r.stdout).trim();
  if (r.exitCode !== 0 || dsn === '') {
    throw new Error(
      `секрет «${KEYCHAIN_SERVICE}» не найден в Ключнице.\n` +
        'Положить один раз (команду выполнить в СВОЁМ терминале, не через ассистента):\n' +
        `  security add-generic-password -a ${KEYCHAIN_ACCOUNT} -s ${KEYCHAIN_SERVICE} -U -w '<DSN>'\n` +
        'Формат DSN и где взять части — docs/implementation/02-ops-runbook.md §1 (роль postgres, session-пулер :5432)',
    );
  }
  return dsn;
}

/** Ошибки драйвера несут DSN в тексте — вырезаем пароль до вывода. */
function redact(e: unknown): string {
  const s = e instanceof Error ? e.message : String(e);
  return s.replace(/(postgres(?:ql)?:\/\/[^:\s]+):[^@\s]+@/g, '$1:***@');
}

async function withDb<T>(fn: (sql: postgres.Sql) => Promise<T>): Promise<T> {
  const sql = postgres(readDsn(), { max: 1 });
  try {
    return await fn(sql);
  } finally {
    await sql.end();
  }
}

/** Сверяет JSON Schema и ai_instructions встроенных аспектов в проде с кодом. */
async function check(): Promise<number> {
  return withDb(async (sql) => {
    const rows = await sql<{ id: string; schema: unknown; ai_instructions: string }[]>`
      SELECT id, schema, ai_instructions FROM aspect_definitions WHERE owner_id IS NULL`;
    const byId = new Map(rows.map((r) => [r.id, r]));
    let drift = 0;
    for (const meta of BUILTIN_ASPECT_META) {
      const row = byId.get(meta.id);
      if (!row) {
        console.log(`✗ ${meta.id}: в проде НЕТ`);
        drift += 1;
        continue;
      }
      const schemaDrift = JSON.stringify(row.schema) !== JSON.stringify(aspectJsonSchema(meta.id));
      const instrDrift = row.ai_instructions !== meta.aiInstructions;
      if (schemaDrift || instrDrift) {
        const what = [schemaDrift && 'schema', instrDrift && 'ai_instructions']
          .filter(Boolean)
          .join(' + ');
        console.log(`✗ ${meta.id}: расходится (${what})`);
        drift += 1;
      } else {
        console.log(`✓ ${meta.id}`);
      }
    }
    console.log(
      drift === 0
        ? `\nРеестр в проде совпадает с кодом (${BUILTIN_ASPECT_META.length} аспектов).`
        : `\nРасхождений: ${drift}. Починить: bun scripts/ops.ts seed-aspects`,
    );
    return drift === 0 ? 0 : 1;
  });
}

/** Тот же upsert, что scripts/seed-aspects.ts, но с секретом из Ключницы. */
async function seedAspects(): Promise<number> {
  await withDb(async (sql) => {
    for (const meta of BUILTIN_ASPECT_META) {
      await sql`
        INSERT INTO aspect_definitions
          (id, owner_id, name, namespace, description, icon, schema,
           ai_instructions, tag_mappings, view_config)
        VALUES
          (${meta.id}, NULL, ${meta.name}, ${meta.namespace}, ${meta.description},
           ${meta.icon}, ${sql.json(aspectJsonSchema(meta.id))}, ${meta.aiInstructions},
           ${meta.tagMappings}, ${sql.json(meta.viewConfig)})
        ON CONFLICT (id) WHERE owner_id IS NULL DO UPDATE SET
          name = EXCLUDED.name, description = EXCLUDED.description, icon = EXCLUDED.icon,
          schema = EXCLUDED.schema, ai_instructions = EXCLUDED.ai_instructions,
          tag_mappings = EXCLUDED.tag_mappings, view_config = EXCLUDED.view_config`;
    }
    console.log(`seed-aspects: ${BUILTIN_ASPECT_META.length} встроенных аспектов upsert'нуто`);
  });
  return 0;
}

async function ping(): Promise<number> {
  await withDb(async (sql) => {
    const [row] = await sql<{ version: string }[]>`SELECT version()`;
    console.log(row?.version ?? 'нет ответа');
  });
  return 0;
}

const OPS: Record<string, { run: () => Promise<number>; help: string }> = {
  check: { run: check, help: 'только чтение: расхождение реестра аспектов прода с кодом' },
  'seed-aspects': { run: seedAspects, help: 'upsert встроенных аспектов (идемпотентно)' },
  ping: { run: ping, help: 'связность и версия PostgreSQL' },
};

const name = process.argv[2];
const op = name === undefined ? undefined : OPS[name];
if (!op) {
  const list = Object.entries(OPS)
    .map(([k, v]) => `  ${k.padEnd(13)} — ${v.help}`)
    .join('\n');
  console.error(
    (name === undefined ? 'ops: операция не указана.' : `ops: неизвестная операция «${name}».`) +
      `\nДоступно:\n${list}`,
  );
  process.exit(2);
}

try {
  process.exit(await op.run());
} catch (e) {
  console.error(`ops ${name}: ${redact(e)}`);
  process.exit(1);
}
