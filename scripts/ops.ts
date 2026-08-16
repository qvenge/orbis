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
//   bun scripts/ops.ts migrate        # накатить неприменённые миграции схемы
//   bun scripts/ops.ts seed-aspects   # upsert встроенных аспектов (идемпотентно)
//   bun scripts/ops.ts coverage       # только чтение: покрытие транзакций (00-product §8)
//   bun scripts/ops.ts audit-bodies   # только чтение: агрегаты по корпусу тел перед конверсией
//   bun scripts/ops.ts backfill-body-doc  # конверсия тел в body_doc — ТОЛЬКО после audit-bodies
//   bun scripts/ops.ts ping           # связность и версия PostgreSQL
//   bun scripts/ops.ts issue-pat <owner-uuid> [метка]   # headless-токен агента (§9.3)
import { join } from 'node:path';
import { aspectJsonSchema, BUILTIN_ASPECT_META, diffBuiltinAspects } from '@orbis/shared';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { type AuditRow, auditBodies } from '../apps/server/src/db/audit-bodies';
import {
  backfillBodyDoc,
  backfillExitCode,
  describeRoleAccess,
  drizzleBackfillIo,
} from '../apps/server/src/db/backfill-body-doc';
import * as schema from '../apps/server/src/db/schema';
import { issuePatGrant } from '../apps/server/src/oauth/grants';

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

/**
 * Сверяет JSON Schema и ai_instructions встроенных аспектов в проде с кодом.
 *
 * Само сравнение (включая канонизацию JSON — jsonb не хранит порядок ключей) живёт в
 * `@orbis/shared` (`diffBuiltinAspects`): ту же функцию зовёт стартовая проверка сервера,
 * и второй реализации «что считать дрейфом» быть не должно — иначе ручная операция и
 * автоматическая проверка однажды разойдутся в ответах.
 */
async function check(): Promise<number> {
  return withDb(async (sql) => {
    const rows = await sql<{ id: string; schema: unknown; ai_instructions: string }[]>`
      SELECT id, schema, ai_instructions FROM aspect_definitions WHERE owner_id IS NULL`;
    const drift = diffBuiltinAspects(
      rows.map((r) => ({ id: r.id, schema: r.schema, aiInstructions: r.ai_instructions })),
    );
    const bad = new Set<string>([...drift.missing, ...drift.drifted.map((d) => d.id)]);
    for (const meta of BUILTIN_ASPECT_META) {
      if (!bad.has(meta.id)) console.log(`✓ ${meta.id}`);
    }
    for (const id of drift.missing) console.log(`✗ ${id}: в проде НЕТ`);
    for (const d of drift.drifted) console.log(`✗ ${d.id}: расходится (${d.what.join(' + ')})`);
    console.log(
      bad.size === 0
        ? `\nРеестр в проде совпадает с кодом (${BUILTIN_ASPECT_META.length} аспектов).`
        : `\nРасхождений: ${bad.size}. Починить: bun scripts/ops.ts seed-aspects`,
    );
    return bad.size === 0 ? 0 : 1;
  });
}

/** Комплект миграций — тот же каталог, что у drizzle-kit (apps/server/drizzle.config.ts). */
const MIGRATIONS_FOLDER = join(import.meta.dir, '../apps/server/src/db/migrations');

/** Сколько миграций уже в журнале. До первого прогона таблицы журнала нет вовсе. */
async function appliedCount(sql: postgres.Sql): Promise<number> {
  const [row] = await sql<{ n: number | null }[]>`
    SELECT CASE
             WHEN to_regclass('drizzle.__drizzle_migrations') IS NULL THEN NULL
             ELSE (SELECT count(*)::int FROM drizzle.__drizzle_migrations)
           END AS n`;
  return row?.n ?? 0;
}

/**
 * Накат неприменённых миграций схемы на ПРОД.
 *
 * Зачем операция здесь. Штатный путь подготовки базы — `bun run db:prepare`, но он написан
 * про НОВУЮ или восстановленную базу и для живого прода не годится: он зовёт `setup-db.ts`
 * (тот делает `ALTER ROLE orbis_app PASSWORD` из ORBIS_APP_PASSWORD — на проде это ротация
 * пароля боевой роли, то есть обрыв DATABASE_URL, если значение не совпало) и завершается
 * `test:rls` (а тот ставит расширение pgtap и льёт фикстуры — на проде им не место, пусть
 * и в откатываемой транзакции). Оставался голый `db:migrate`, но он требует админского DSN
 * в окружении, а голый прод-DSN оператору не выдаётся — по той же причине, по которой
 * заведена вся эта обёртка. Без операции здесь накат миграций на прод не имел
 * санкционированного пути вовсе, а контейнер их не катит: Dockerfile сразу запускает
 * сервер (CMD), шага миграции в образе нет.
 *
 * Идемпотентна: журнал `drizzle.__drizzle_migrations` тот же, что у drizzle-kit, поэтому
 * повторный вызов на актуальной базе не делает ничего. Роль — админская (postgres из
 * Ключницы): миграции создают политики и раздают гранты, под orbis_app это невозможно.
 *
 * Роль `orbis_app` операция НЕ создаёт: на проде она давно есть, а `0005_oauth_rls.sql`
 * называет её поимённо и упал бы на её отсутствии. Отказ `role "orbis_app" does not exist`
 * означает, что база не подготовлена вовсе, — это случай `db:prepare`, а не этой команды.
 */
async function migrateOp(): Promise<number> {
  return withDb(async (sql) => {
    const before = await appliedCount(sql);
    await migrate(drizzle(sql), { migrationsFolder: MIGRATIONS_FOLDER });
    const after = await appliedCount(sql);
    console.log(
      after === before
        ? `migrate: новых миграций нет (в журнале ${after})`
        : `migrate: применено ${after - before} (в журнале ${after})`,
    );
    return 0;
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

/** Окно отчёта покрытия: три месяца выписок — достаточный горизонт для метрики §8. */
const COVERAGE_DAYS = 90;

/**
 * Покрытие транзакций (00-product §8: «ручной ввод + импорт покрывают ≥ 95% транзакций
 * банка»). Считается по сводкам импорта в журнале (карточка import_summary): доля строк
 * выписки, которые Orbis УЖЕ знал к моменту импорта, — привязанные к ручным записям
 * (adopted) плюс пропущенные как уже импортированные (skipped).
 *
 * Что метрика НЕ говорит: сколько операций прошло мимо и выписки тоже (банк — источник
 * истины, но наличные и переводы вне его). Это честная граница измерения, а не оговорка:
 * бóльшего из данных Orbis не выводится.
 */
async function coverage(): Promise<number> {
  return withDb(async (sql) => {
    const rows = await sql<{ cards: unknown }[]>`
      SELECT metadata -> 'cards' AS cards FROM chat_messages
      WHERE created_at > now() - make_interval(days => ${COVERAGE_DAYS})
        AND metadata @> '{"cards":[{"kind":"import_summary"}]}'::jsonb
      ORDER BY created_at`;
    type Summary = {
      kind?: string;
      total?: number;
      created?: number;
      adopted?: number;
      skipped?: number;
    };
    const summaries = rows
      .flatMap((r) => (r.cards as Summary[] | null) ?? [])
      .filter((c) => c.kind === 'import_summary');
    if (summaries.length === 0) {
      console.log(`За ${COVERAGE_DAYS} дней импортов не было — измерять нечего.`);
      return 0;
    }
    const sum = (pick: (s: Summary) => number): number =>
      summaries.reduce((acc, s) => acc + pick(s), 0);
    const total = sum((s) => s.total ?? 0);
    const known = sum((s) => (s.adopted ?? 0) + (s.skipped ?? 0));
    const pct = total === 0 ? 0 : (known / total) * 100;
    const created = sum((s) => s.created ?? 0);
    console.log(`Импортов за ${COVERAGE_DAYS} дней: ${summaries.length}`);
    console.log(
      `Строк выписок: ${total}; из них Orbis уже знал: ${known}; создано новых: ${created}`,
    );
    console.log(`Покрытие: ${pct.toFixed(1)}% (цель 00-product §8 — ≥ 95%)`);
    return 0;
  });
}

/**
 * Read-only аудит корпуса тел ПЕРЕД миграцией и бэкфиллом (ревью И10, вердикт): сколько тел
 * изменит канонизация, сколько получат raw-блоки, сколько тел держит ссылки внутри raw.
 * Числа — стоп-кран: заметная доля raw или ненулевые ссылки в raw означают, что до конверсии
 * надо расширять белые списки токенов (KNOWN_BLOCK/KNOWN_INLINE), а не запускать бэкфилл.
 *
 * Сам цикл и арифметика счётчиков живут в `apps/server/src/db/audit-bodies.ts` — по той же
 * причине, по какой там же живёт цикл бэкфилла: дословная копия здесь осталась бы НЕ ПОКРЫТОЙ
 * тестом. Здесь только адаптер к сырому пулу и печать.
 *
 * Корпус читается ПОРЦИЯМИ по курсору (итоговое ревью, находка 7): прежний одиночный
 * `SELECT body FROM entities` тянул в память всё разом — на замере, который делается прямо
 * перед необратимой операцией, это лишний риск.
 */
async function auditBodiesOp(): Promise<number> {
  return withDb(async (sql) => {
    const r = await auditBodies({
      // `id` выбирается ТОЛЬКО ради курсора и никуда не печатается: тела и всё, что к ним
      // ведёт, из процесса не выходят — вывод команды попадает в транскрипты и отчёты.
      selectBatch: (limit, afterId) =>
        sql<AuditRow[]>`SELECT id, body FROM entities
                        WHERE id > ${afterId}::uuid ORDER BY id LIMIT ${limit}`,
    });
    console.log(`тел всего: ${r.total}`);
    console.log(`канон изменит body: ${r.changed}`);
    // ДВА СТОП-КРАНА прода. Оба обязаны быть нулевыми до запуска backfill-body-doc: «канон
    // изменит body» на эту роль не годится — он велик и на здоровом корпусе (нормализация
    // разметки), а эти два растут только от настоящей беды.
    console.log(`СТОП-КРАН канон неустойчив (canon(canon) ≠ canon): ${r.unstable}`);
    console.log(`СТОП-КРАН канон теряет текст или ссылку: ${r.lossy}`);
    console.log(`получат raw-блоки: ${r.withRaw}`);
    console.log(`ссылки внутри raw: ${r.refsInRaw}`);
    // Без этой строки числа про raw нечем взвесить: доля raw сама по себе не говорит, много ли
    // в корпусе тел, которым вообще есть что терять при конверсии.
    console.log(`со ссылкой или смарт-листом ([[entity: или {{query:): ${r.nontrivial}`);
    console.log(`упали на парсе: ${r.failed}`);
    return 0;
  });
}

/**
 * Разовая конверсия тел в структурную форму (`entities.body_doc`) — ЕДИНСТВЕННАЯ пишущая
 * операция белого списка, которая трогает пользовательские данные.
 *
 * Порядок на проде жёсткий: сперва `migrate` (колонки без неё нет), потом READ-ONLY
 * `audit-bodies` — и только если его числа приемлемы, эта команда. Аудит для того и заведён:
 * заметная доля raw-блоков или ненулевые «ссылки внутри raw» означают, что до конверсии надо
 * расширять белые списки токенов, а не запускать бэкфилл. Откатывать нечем.
 *
 * Идемпотентна: берёт только строки с `body_doc IS NULL`, поэтому повторный запуск не делает
 * ничего. Пишет ОБЕ колонки — `body` тоже выравнивается до канона, иначе инвариант
 * «body === serializeBody(body_doc)» ломался бы на самом первом шаге.
 *
 * Работает по ЖИВОЙ базе, поэтому запись идёт под CAS: строку, которую владелец или агент
 * тронул между выборкой и записью, бэкфилл НЕ переписывает (иначе затёр бы свежий текст
 * каноном прочитанного старого). Такие строки попадают в «пропущено» и остаются на ленивую
 * конверсию при первом чтении.
 *
 * Печатает ТРИ числа и ФАКТ РОЛИ. Одних чисел мало: роль с грантами, но без `BYPASSRLS`, под
 * FORCE RLS видит ноль строк — и «0 / 0 / 0» у неё неотличимо от «корпус уже сконвертирован»
 * (воспроизведено пробой под `authenticated`: `count(*)` вернул 0 при непустой таблице). Три
 * числа этот случай различить НЕ МОГУТ в принципе — различает только `rolbypassrls`, поэтому
 * он и печатается (ревью M-2, второй круг).
 *
 * Ни цикл, ни SQL здесь не дублируются: сырой пул `withDb` оборачивается в drizzle (так же, как
 * в migrateOp и issuePat выше) и отдаётся тому же `drizzleBackfillIo`, который прогоняет тест.
 * Дословная вторая копия цикла осталась бы непокрытой и разошлась бы с проверенной на первой же
 * правке (ревью И16).
 */
async function backfillBodyDocOp(): Promise<number> {
  return withDb(async (sql) => {
    const db = drizzle(sql, { schema });
    const who = await describeRoleAccess(db);
    console.log(`роль: ${who.role} (BYPASSRLS: ${who.bypassRls ? 'да' : 'НЕТ'})`);
    const result = await backfillBodyDoc(drizzleBackfillIo(db));
    const { done, skipped, pending } = result;
    console.log(`сконвертировано тел: ${done}`);
    console.log(`осталось неконвертированных: ${pending}`);
    console.log(`пропущено (тело изменилось во время прогона): ${skipped}`);
    // `done === 0` в гейте обязателен наравне с остатком: без BYPASSRLS обнуляется И pending
    // (он считается тем же SELECT под той же политикой), поэтому гейт только по остатку
    // молчал бы ровно в том случае, ради которого заведён.
    if (pending > 0 || done === 0) {
      console.log(
        who.bypassRls
          ? '\nОстаток — норма, если тела правили во время прогона: их догонит повторный запуск' +
              '\n(или ленивая конверсия при первом чтении). Если же и остаток, и сконвертировано' +
              '\nнулевые — корпус либо уже сконвертирован, либо пуст; сверь с `audit-bodies`.'
          : `\nВНИМАНИЕ: роль ${who.role} НЕ несёт BYPASSRLS, а на entities включён FORCE RLS` +
              '\nс политикой owner_id = auth.uid(). Прямое подключение auth.uid() не выставляет,' +
              '\nпоэтому такая роль видит НОЛЬ строк — и нули выше означают «корпус НЕ ВИДЕН»,' +
              '\nа НЕ «корпус сконвертирован». Нужен DSN роли с BYPASSRLS (на Supabase — postgres).',
      );
    }
    // Код возврата, а не только предупреждение (итоговое ревью, находка 6): печать читает
    // человек, а запуск из скрипта читает КОД, и он врал успехом на «корпус не виден».
    return backfillExitCode(who, result);
  });
}

async function ping(): Promise<number> {
  await withDb(async (sql) => {
    const [row] = await sql<{ version: string }[]>`SELECT version()`;
    console.log(row?.version ?? 'нет ответа');
  });
  return 0;
}

/**
 * Выпуск headless-токена внешнего агента на ПРОДЕ (§9.3, D34).
 *
 * Зачем операция здесь, а не только в scripts/issue-pat.ts: до переезда PAT в таблицу
 * грантов скрипт выдачи базы не касался вовсе — печатал хеш, который человек руками клал
 * в Render. Теперь выдача это ЗАПИСЬ в базу, то есть требует прод-DSN, а голый прод-DSN
 * оператору не выдаётся по той же причине, по которой заведена вся эта обёртка. Без
 * операции здесь выпуск PAT на проде остался бы без санкционированного пути.
 *
 * Сама механика выдачи не дублируется: зовётся тот же issuePatGrant, что и на локальном
 * стенде, — второй реализации «как выглядит и как хешируется токен» быть не должно.
 *
 * Единственная операция белого списка, которая ПЕЧАТАЕТ СЕКРЕТ: сырой токен показывается
 * один раз и не восстановим (в базе только sha256).
 */
async function issuePat(args: string[]): Promise<number> {
  const ownerId = args[0];
  const label = args[1] ?? 'headless-агент';
  if (ownerId === undefined || ownerId === '') {
    console.error(
      'issue-pat: нужен owner-uuid.\n' +
        '  bun scripts/ops.ts issue-pat <owner-uuid> [метка]\n' +
        'owner-uuid — из Supabase → Authentication → Users',
    );
    return 2;
  }
  return withDb(async (sql) => {
    // Проверка владельца ДО выдачи. Опечатка в UUID иначе дала бы живой токен
    // несуществующего владельца: аутентификация им прошла бы, а агент молча видел бы
    // пустой граф — отказ, неотличимый от потери данных. Из скрипта локального стенда
    // проверки нет намеренно: там auth.users пуст ровно до первого входа, и гейт мешал бы
    // готовить стенд. Здесь же цена ошибки — мёртвый доступ в проде.
    const [owner] = await sql<{ ok: number }[]>`
      SELECT 1 AS ok FROM auth.users WHERE id = ${ownerId}::uuid`;
    if (!owner) {
      console.error(
        `issue-pat: пользователя ${ownerId} нет в auth.users — токен не выдан.\n` +
          'UUID берётся в Supabase → Authentication → Users.',
      );
      return 2;
    }
    const token = await issuePatGrant(drizzle(sql, { schema }), { ownerId, label });
    console.log(`Токен выдан («${label}»). Показывается ОДИН раз — сохрани его сейчас:`);
    console.log(`  ${token}`);
    console.log('');
    console.log('Подключение агента (заголовочный путь, для claude -p / Agent SDK / CI):');
    console.log(
      `  claude mcp add --transport http orbis <url>/mcp --header "Authorization: Bearer ${token}"`,
    );
    console.log('Отзыв — «Настройки → Агенты» в приложении.');
    return 0;
  });
}

const OPS: Record<string, { run: (args: string[]) => Promise<number>; help: string }> = {
  check: { run: check, help: 'только чтение: расхождение реестра аспектов прода с кодом' },
  migrate: { run: migrateOp, help: 'накатить неприменённые миграции схемы (идемпотентно)' },
  'seed-aspects': { run: seedAspects, help: 'upsert встроенных аспектов (идемпотентно)' },
  coverage: { run: coverage, help: 'только чтение: покрытие транзакций за 90 дней (§8)' },
  'audit-bodies': {
    run: auditBodiesOp,
    help: 'только чтение: агрегаты по корпусу тел перед конверсией (тела не печатаются)',
  },
  'backfill-body-doc': {
    run: backfillBodyDocOp,
    help: 'конверсия тел в body_doc + выравнивание body до канона; ТОЛЬКО после audit-bodies',
  },
  ping: { run: ping, help: 'связность и версия PostgreSQL' },
  'issue-pat': {
    run: issuePat,
    help: 'headless-токен агента: <owner-uuid> [метка] (печатает секрет ОДИН раз)',
  },
};

const name = process.argv[2];
const op = name === undefined ? undefined : OPS[name];
if (!op) {
  const list = Object.entries(OPS)
    .map(([k, v]) => `  ${k.padEnd(17)} — ${v.help}`)
    .join('\n');
  console.error(
    (name === undefined ? 'ops: операция не указана.' : `ops: неизвестная операция «${name}».`) +
      `\nДоступно:\n${list}`,
  );
  process.exit(2);
}

try {
  process.exit(await op.run(process.argv.slice(3)));
} catch (e) {
  console.error(`ops ${name}: ${redact(e)}`);
  process.exit(1);
}
