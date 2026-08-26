// scripts/ops.ts — именованные операции против ПРОДА.
//
// Зачем обёртка, а не голый DSN в окружении: админский DSN умеет и `DROP TABLE`.
// Здесь он не отдаётся наружу и не печатается — операции перечислены поимённо,
// всё остальное отклоняется. Это принцип наименьших полномочий: ассистент может
// запустить `seed-registries`, но не «что угодно на проде».
//
// Секрет живёт в Ключнице macOS, а не в файле репозитория:
//   security add-generic-password -a orbis -s orbis-prod-admin -U -w '<DSN>'
// Читается через `security find-generic-password -w`. В git его нет, в транскрипт
// он не попадает, на диске открытым текстом не лежит.
//
// Использование:
//   bun scripts/ops.ts check           # только чтение: расхождение реестров с кодом
//   bun scripts/ops.ts migrate         # накатить неприменённые миграции схемы
//   bun scripts/ops.ts seed-registries # upsert встроенных свойств, ролей и аспектов
//   bun scripts/ops.ts coverage       # только чтение: покрытие транзакций (00-product §8)
//   bun scripts/ops.ts census         # только чтение: сколько тел перенос изменит сильнее прочих
//   bun scripts/ops.ts audit-bodies   # только чтение: агрегаты по корпусу тел перед конверсией
//   bun scripts/ops.ts backfill-body-doc  # конверсия тел в body_doc — ТОЛЬКО после audit-bodies
//   bun scripts/ops.ts ping           # связность и версия PostgreSQL
//   bun scripts/ops.ts issue-pat <owner-uuid> [метка] [--scope worker]  # headless-токен (§9.3)
import { join } from 'node:path';
import {
  diffBuiltinRegistries,
  hasRegistryDrift,
  REGISTRY_KINDS,
  type RegistryDbRow,
  type RegistryDbRows,
  registryDriftReport,
} from '@orbis/shared';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import {
  type AuditRow,
  auditBodies,
  auditExitCode,
  FLAGGED_LIMIT,
  formatFlagged,
} from '../apps/server/src/db/audit-bodies';
import {
  backfillBodyDoc,
  backfillExitCode,
  describeRoleAccess,
  drizzleBackfillIo,
} from '../apps/server/src/db/backfill-body-doc';
import { REGISTRY_DRIFT_QUERIES } from '../apps/server/src/db/registry-drift';
import * as schema from '../apps/server/src/db/schema';
import { seedRegistries, seedRegistriesReport } from '../apps/server/src/db/seed-registries';
import { issuePatGrant } from '../apps/server/src/oauth/grants';
import { PAT_USAGE, parsePatArgs } from '../apps/server/src/oauth/pat-args';

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
 * Сверяет встроенные строки ПЯТИ реестров и таблицы действий в проде с кодом (§А12-1 п.4).
 *
 * И само сравнение (`diffBuiltinRegistries`, включая канонизацию JSON — jsonb не хранит
 * порядок ключей), и ТЕКСТЫ ЗАПРОСОВ (`REGISTRY_DRIFT_QUERIES`) общие со стартовой
 * проверкой сервера: второй реализации «что считать дрейфом» и «что для этого читать» быть
 * не должно — иначе ручная операция и автоматическая проверка однажды разойдутся в ответах.
 *
 * Отличие от `/health` — момент: здесь чтение ЖИВОЕ, а /health отдаёт снимок, снятый на
 * старте процесса. Расхождение между ними после пересева на поднятом сервисе — ожидаемое
 * (runbook §1), и лечится рестартом, а не пересевом.
 *
 * Второе отличие — РОЛЬ, и оно намеренное. Стартовая проверка читает под `authenticated`,
 * потому что под ней сервер и работает: снятый грант обязан всплыть именно там. Здесь
 * чтение идёт админской ролью, потому что вопрос другой — «что лежит в проде», и ответ на
 * него не должен зависеть от целости прав: иначе сломанная политика приходила бы оператору
 * под видом «реестры неизвестны», и он чинил бы не то. Возможность стать `authenticated` у
 * админской роли есть (проверено пробоем) — это выбор, а не ограничение.
 *
 * Снапшот-семантика при этом ТА ЖЕ, что у стартовой проверки: шесть запросов в одной
 * транзакции REPEATABLE READ, иначе (READ COMMITTED) каждый SELECT взял бы свой снапшот и
 * параллельный пересев дал бы ложный дрейф. `READ ONLY` — забор: операция объявлена
 * «только чтение» в белом списке, и это утверждение проверяет сервер, а не только докблок.
 */
async function check(): Promise<number> {
  return withDb(async (sql) => {
    const rows = await sql.begin('isolation level repeatable read read only', async (tx) => {
      const out = {} as RegistryDbRows;
      for (const kind of REGISTRY_KINDS) {
        out[kind] = (await tx.unsafe(REGISTRY_DRIFT_QUERIES[kind])) as unknown as RegistryDbRow[];
      }
      return out;
    });
    const drift = diffBuiltinRegistries(rows);
    for (const kind of REGISTRY_KINDS) {
      const d = drift[kind];
      const bad = d.missing.length + d.drifted.length + d.extra.length;
      console.log(
        `${bad === 0 ? '✓' : '✗'} ${kind}: строк ${rows[kind].length}, расхождений ${bad}`,
      );
    }
    for (const line of registryDriftReport(drift)) console.log(line);
    console.log(
      hasRegistryDrift(drift)
        ? '\nНедостающее и расходящееся чинится: bun scripts/ops.ts seed-registries\n' +
            'ЛИШНИЕ строки пересев не убирает — что с ними делать, решает человек.'
        : '\nРеестры в проде совпадают с кодом.',
    );
    return hasRegistryDrift(drift) ? 1 : 0;
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

/** Тот же сид, что `scripts/seed-registries.ts`, но с секретом из Ключницы. */
async function seedRegistriesOp(): Promise<number> {
  await withDb(async (sql) => {
    console.log(seedRegistriesReport(await seedRegistries(sql)));
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
 *
 * ПЕЧАТАЕТ ФАКТ РОЛИ и возвращает ненулевой код, когда корпус не виден (ре-ревью раунда 3).
 * Без этого команда была зелена ровно в том случае, ради которого заведена: роль без BYPASSRLS
 * под FORCE RLS видит ноль строк молча, все счётчики читаются нулями, и человек получал
 * зелёный свет на необратимую конверсию оттого, что аудит НИЧЕГО НЕ УВИДЕЛ. Это дословный
 * повтор находки M-2, закрытой для бэкфилла; здесь довод сильнее — тут число и есть решение.
 *
 * Годится и как ПОСТ-проверка: `body_doc` читается, и последние два числа отвечают на вопрос
 * «конверсия доехала и пара согласована?». Повторный прогон одних стоп-кранов на эту роль не
 * годится — после бэкфилла он вакуумен по построению (см. AuditResult.pairBroken).
 */
async function auditBodiesOp(): Promise<number> {
  return withDb(async (sql) => {
    const who = await describeRoleAccess(drizzle(sql, { schema }));
    console.log(`роль: ${who.role} (BYPASSRLS: ${who.bypassRls ? 'да' : 'НЕТ'})`);
    const r = await auditBodies({
      // `id` выбирается ради курсора порций И ради списка виновных строк ниже. Наружу не
      // выходят ТЕЛА — вывод команды попадает в транскрипты и отчёты; идентификаторы выходят
      // намеренно, иначе разбор по кранам неисполним (раньше здесь стояло «никуда не
      // печатается» — после раунда 5 это перестало быть правдой).
      selectBatch: (limit, afterId) =>
        sql<AuditRow[]>`SELECT id, body, body_doc AS "bodyDoc",
                               body_before_doc AS "bodyBeforeDoc"
                        FROM entities
                        WHERE id > ${afterId}::uuid ORDER BY id LIMIT ${limit}`,
    });
    console.log(`тел всего: ${r.total}`);
    console.log(`канон изменит body: ${r.changed}`);
    // ДВА СТОП-КРАНА прода. Оба обязаны быть нулевыми до запуска backfill-body-doc: «канон
    // изменит body» на эту роль не годится — он велик и на здоровом корпусе (нормализация
    // разметки), а эти два растут только от настоящей беды.
    console.log(`СТОП-КРАН канон неустойчив (canon(canon) ≠ canon): ${r.unstable}`);
    console.log(`СТОП-КРАН канон теряет текст или ссылку: ${r.lossy}`);
    // Третий кран — ЕДИНСТВЕННЫЙ про первый разбор, то есть про сам необратимый шаг. Два крана
    // выше считают уже ПОСЛЕ него и к этому классу слепы по построению.
    console.log(`СТОП-КРАН из тела пропало слово: ${r.lostWords}`);
    console.log(`получат raw-блоки: ${r.withRaw}`);
    console.log(`ссылки внутри raw: ${r.refsInRaw}`);
    // Без этой строки числа про raw нечем взвесить: доля raw сама по себе не говорит, много ли
    // в корпусе тел, которым вообще есть что терять при конверсии.
    console.log(`со ссылкой или смарт-листом ([[entity: или {{query:): ${r.nontrivial}`);
    console.log(`упали на парсе: ${r.failed}`);
    // Пост-проверка: ДО конверсии первое число равно всему корпусу, ПОСЛЕ — оба обязаны быть 0.
    console.log(`без документа (body_doc IS NULL): ${r.withoutDoc}`);
    console.log(`СТОП-КРАН пара разошлась (body ≠ serialize(body_doc)): ${r.pairBroken}`);
    // Четвёртый кран: всё заявление «конверсия обратима» держится на этой колонке, и до
    // раунда 6 её не проверял никто.
    console.log(`СТОП-КРАН сконвертировано без страховки обратимости: ${r.convertedWithoutBackup}`);
    // Без id регламентный «стоп и разбор конкретного тела» неисполним: по счётчику «1» строку
    // в корпусе на тысячи записей не найти. Сами тела наружу по-прежнему не выходят.
    if (r.flagged.length > 0) {
      console.log(`\nid строк, поднявших стоп-кран (не больше ${FLAGGED_LIMIT}):`);
      // `row.id` и имена кранов ПОИМЁННО. Прежняя строка печатала `${id}` по массиву объектов
      // и давала `[object Object]` — шаг регламента «взять напечатанные id» был неисполним
      // (ре-ревью раунда 7, Д3). Тесты этого не ловили: они проверяли СТРУКТУРУ результата,
      // а не печать, — поэтому ниже к ним добавлена проверка самой строки вывода.
      for (const line of formatFlagged(r.flagged)) console.log(line);
      console.log(
        '\nРазбор — ЛОКАЛЬНО, вывод не в транскрипт:' +
          "\n  ДО переноса:    SELECT body FROM entities WHERE id = '<id>';" +
          "\n  ПОСЛЕ переноса: SELECT body_before_doc FROM entities WHERE id = '<id>';" +
          '\n  (после переноса `body` уже канон — сравнивать надо с исходным телом)',
      );
    }
    if (!who.bypassRls) {
      console.error(
        `\nВНИМАНИЕ: роль ${who.role} НЕ несёт BYPASSRLS, а на entities включён FORCE RLS` +
          '\nс политикой owner_id = auth.uid(). Прямое подключение auth.uid() не выставляет,' +
          '\nпоэтому такая роль видит НОЛЬ строк — и нули выше означают «корпус НЕ ВИДЕН»,' +
          '\nа НЕ «корпус здоров». Нужен DSN роли с BYPASSRLS (на Supabase — postgres).',
      );
    }
    return auditExitCode(who, r);
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

/**
 * Перепись форм, которые перенос изменит СИЛЬНЕЕ ПРОЧИХ, — только чтение, только числа.
 *
 * Заведена потому, что регламентный «шаг переписи» был НЕИСПОЛНИМ: прод-операции идут только
 * через белый список этого файла, а такой команды в нём не было (ре-ревью раунда 6, п.4).
 * Обещанный шаг, которого нельзя выполнить, — хуже отсутствующего: он создаёт видимость
 * проверки.
 *
 * Это НЕ гейт: все перечисленные формы после починок текста не теряют, они лишь станут
 * дословными блоками или сменят вид. Число нужно, чтобы владелец знал масштаб ПЕРЕД переносом
 * и не удивился, открыв заметку.
 *
 * Тела не печатаются — только счётчики; `id` тоже не выводится (для разбора есть audit-bodies).
 */
async function censusBodies(): Promise<number> {
  return withDb(async (sql) => {
    const who = await describeRoleAccess(drizzle(sql, { schema }));
    console.log(`роль: ${who.role} (BYPASSRLS: ${who.bypassRls ? 'да' : 'НЕТ'})`);
    const [row] = await sql<Array<Record<string, number>>>`SELECT
        count(*)::int AS total,
        count(*) FILTER (WHERE body ~ '(^|\n)[0-9]+[.)] ' AND body LIKE '%|%')::int AS ol_table,
        count(*) FILTER (WHERE body ~ '(^|\n)[0-9]+[.)] ' AND body LIKE '%[](%')::int AS ol_emptylink,
        count(*) FILTER (WHERE body ~ '(^|\n)[0-9]+[.)] ' AND body LIKE '%![%')::int AS ol_image,
        count(*) FILTER (WHERE body LIKE '%- [ ] %' AND body LIKE '%|%')::int AS task_table,
        count(*) FILTER (WHERE body LIKE '%- [ ] %' AND body LIKE '%[](%')::int AS task_emptylink,
        count(*) FILTER (WHERE body LIKE '%&nbsp;%' OR body LIKE '%' || chr(160) || '%')::int AS nbsp,
        count(*) FILTER (WHERE body ~ '(^|\n)0[.)] ')::int AS zero_start
      FROM entities`;
    console.log(`тел всего: ${row?.total ?? 0}`);
    console.log(`нумерованный список рядом с таблицей: ${row?.ol_table ?? 0}`);
    console.log(`нумерованный список со ссылкой [](: ${row?.ol_emptylink ?? 0}`);
    console.log(`нумерованный список с картинкой ![: ${row?.ol_image ?? 0}`);
    console.log(`чеклист рядом с таблицей: ${row?.task_table ?? 0}`);
    console.log(`чеклист со ссылкой [](: ${row?.task_emptylink ?? 0}`);
    console.log(`неразрывный пробел (&nbsp; или U+00A0): ${row?.nbsp ?? 0}`);
    console.log(`список, начинающийся с 0.: ${row?.zero_start ?? 0}`);
    console.log('\nЭто НЕ гейт: текст в этих формах цел, меняется только вид.');
    return who.bypassRls ? 0 : 1;
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
  // Разбор — общий с локальным scripts/issue-pat.ts: `--scope worker` обязан значить
  // на проде ровно то же, что на стенде. Незнакомая область или флаг — ОТКАЗ кодом 2,
  // а не откат на 'full': опечатка иначе выдала бы самый широкий доступ вместо узкого,
  // и невосстановимо — токен печатается один раз.
  const parsed = parsePatArgs(args);
  if ('error' in parsed) {
    console.error(
      `issue-pat: ${parsed.error}.\n` +
        `  bun scripts/ops.ts issue-pat ${PAT_USAGE}\n` +
        'owner-uuid — из Supabase → Authentication → Users\n' +
        '--scope worker — фоновый исполнитель: чтения и глаголы задач, без прочей записи',
    );
    return 2;
  }
  const { ownerId, label, scope } = parsed;
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
    const token = await issuePatGrant(drizzle(sql, { schema }), { ownerId, label, scope });
    console.log(
      `Токен выдан («${label}», область ${scope}). Показывается ОДИН раз — сохрани его сейчас:`,
    );
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
  check: {
    run: check,
    help: 'только чтение: расхождение реестров прода с кодом (пять + действия)',
  },
  migrate: { run: migrateOp, help: 'накатить неприменённые миграции схемы (идемпотентно)' },
  'seed-registries': {
    run: seedRegistriesOp,
    help: 'upsert встроенных свойств, ролей и аспектов (идемпотентно)',
  },
  coverage: { run: coverage, help: 'только чтение: покрытие транзакций за 90 дней (§8)' },
  census: {
    run: censusBodies,
    help: 'только чтение: сколько тел перенос изменит сильнее прочих (не гейт, тела не печатаются)',
  },
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
    help: `headless-токен агента: ${PAT_USAGE} (печатает секрет ОДИН раз)`,
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
