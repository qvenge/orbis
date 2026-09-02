// apps/server/src/db/reset-world.ts
//
// «ПЕРЕСЕВ МИРА» (РП-7, D43): разрушающая прод-операция, которая сносит граф и журнал
// владельцев, их строки реестров и дельты, а затем пересевает три системных реестра.
// Запускается ровно одним путём — `bun scripts/ops.ts reset-world` (белый список, секрет из
// Ключницы); здесь живут её состав, подтверждение и отчёт.
//
// ПОЧЕМУ ОТДЕЛЬНЫЙ МОДУЛЬ, А НЕ ТЕЛО ФУНКЦИИ В `scripts/ops.ts`. `ops.ts` — исполняемый
// скрипт: его импорт запускает диспетчер и `process.exit`, поэтому проверить его тестом
// нельзя вовсе. Единственная другая пишущая операция белого списка устроена так же
// (`backfill-body-doc.ts` + обёртка в `ops.ts`), и по той же причине: разрушающая операция
// без единого теста — это регламент вместо гарантии.
//
// ЧТО СОХРАНЯЕТСЯ ЦЕЛИКОМ: `agent_grants`, `oauth_clients`, `ai_usage`, `registry_system`, а
// также `user_settings` — кроме версии реестра владельца. Это и есть разница между пересевом
// прода и зачисткой между сьютами (`test/helpers.ts:truncateAll`, которая сносит и настройки,
// и гранты): владелец после пересева заходит в то же приложение теми же ключами, просто в
// пустой мир.
import type { Sql } from 'postgres';
import { type SeedRegistriesResult, seedRegistries, seedRegistriesReport } from './seed-registries';

/**
 * Шесть definition-таблиц реформы: встроенные строки (`owner_id IS NULL`) переживают и
 * пересев, и зачистку между сьютами, пользовательские — ни того, ни другого.
 *
 * Список ОДИН на прод-операцию и на `truncateAll` тестов намеренно: у обеих ровно одно и то
 * же правило («строки владельца — вон, встроенные — остаются»), и седьмой реестр части Б,
 * забытый в одном из двух списков, дал бы либо течь состояния между сьютами, либо переживший
 * пересев мусор в проде. Литералом, а не обходом схемы: новая таблица обязана попадать сюда
 * решением человека.
 */
export const DEFINITION_TABLES = [
  'property_definitions',
  'aspect_definitions',
  'relation_role_definitions',
  'contract_definitions',
  'subscription_definitions',
  'action_definitions',
] as const;

/**
 * Граф и журнал владельцев — то, что сносится начисто.
 *
 * `TRUNCATE` списком, БЕЗ `CASCADE`, и это выбор, а не упущение. FK-граф базы (семь связей)
 * ссылается на `entities` и `chat_threads` только из этой же шестёрки, поэтому `CASCADE`
 * сегодня не утащил бы ничего сверх списка — но он и не проверяет этого впредь. Без него
 * седьмая таблица, которая однажды сошлётся на `entities` и в список не попадёт, уронит
 * операцию явной ошибкой ДО всякой записи; с ним — молча уедет в снос. Список жертв
 * разрушающей операции обязан быть ровно тем, что написан.
 */
const GRAPH_TABLES = [
  'entities',
  'relations',
  'chat_threads',
  'chat_messages',
  'entity_origins',
  'entity_versions',
] as const;

export interface ResetWorldReport {
  /** Сколько строк было в каждой таблице графа и журнала ДО сноса. */
  graph: Record<(typeof GRAPH_TABLES)[number], number>;
  /** Снесённые дельты реестров (их снос идёт ПЕРВЫМ — см. `resetWorld`). */
  deltas: number;
  /** Снесённые пользовательские строки каждого реестра. */
  definitions: Record<(typeof DEFINITION_TABLES)[number], number>;
  /** Строк настроек, у которых версия реестра владельца выставлена в 0. */
  settingsReset: number;
  /** Отчёт пересева трёх системных реестров — он же двигает системную версию. */
  seed: SeedRegistriesResult;
}

/**
 * ВЕСЬ ПЕРЕСЕВ — ОДНОЙ ТРАНЗАКЦИЕЙ, и порядок внутри неё существен (runbook §1).
 *
 * 1. **Дельты — первыми, до пересева.** Иначе их найдёт сид (шаг 5) и прогонит трёхстороннее
 *    слияние: при конфликте он создаст глобальный тред заново — тот самый, который шаг 2
 *    только что снёс, — и положит туда заметку о расхождении с дельтой, которой уже нет.
 *    Снесённые в ЭТОЙ ЖЕ транзакции, они не видны и самому сиду
 *    (`mergeRegistryDeltas` увидит ноль строк и вернётся, не открыв второго соединения).
 * 2. Граф и журнал владельцев.
 * 3. Пользовательские строки шести реестров.
 * 4. Версия реестра ВЛАДЕЛЬЦА — в 0: его собственных определений больше нет, а кеш
 *    эффективных определений ключуется тройкой `(владелец, его версия, системная)`
 *    (`registry/cache.ts`), и «его версия» обязана честно вернуться в начало.
 * 5. Пересев трёх системных реестров тем же кодом, что `ops.ts seed-registries`. Системную
 *    версию он двигает САМ и всегда (`seed-registries.ts`) — руками её здесь не трогают:
 *    она монотонна, по ней отличают «сид был» от «сида не было».
 *
 * Одна транзакция, а не пять: половина пересева — это прод без графа, но со старыми
 * определениями владельца, то есть состояние, в котором приложение отдаёт снимок реестра,
 * которого больше нет ни в одной таблице.
 *
 * `sql` — АДМИНСКОЕ подключение: под ролью приложения RLS не даст ни тронуть чужие строки,
 * ни записать system-строки реестра (`owner_id IS NULL`).
 */
export async function resetWorld(sql: Sql, adminDsn: string): Promise<ResetWorldReport> {
  return sql.begin(async (tx) => {
    // Счёт ДО сноса: после `TRUNCATE` сказать, что именно снесено, будет нечем, а отчёт
    // разрушающей операции — единственное, по чему оператор сверяет «снесли то, что думали».
    const [before] = await tx<Record<string, number>[]>`
      SELECT (SELECT count(*) FROM entities)::int         AS entities,
             (SELECT count(*) FROM relations)::int        AS relations,
             (SELECT count(*) FROM chat_threads)::int     AS chat_threads,
             (SELECT count(*) FROM chat_messages)::int    AS chat_messages,
             (SELECT count(*) FROM entity_origins)::int   AS entity_origins,
             (SELECT count(*) FROM entity_versions)::int  AS entity_versions,
             (SELECT count(*) FROM registry_deltas)::int  AS registry_deltas`;
    if (before === undefined) throw new Error('reset-world: счёт строк не вернул ни одной строки');

    // (1) Дельты — первыми.
    await tx.unsafe('TRUNCATE registry_deltas');

    // (2) Граф и журнал.
    await tx.unsafe(`TRUNCATE ${GRAPH_TABLES.join(', ')} RESTART IDENTITY`);

    // (3) Пользовательские строки реестров.
    const definitions = {} as ResetWorldReport['definitions'];
    for (const table of DEFINITION_TABLES) {
      const removed = await tx.unsafe(`DELETE FROM ${table} WHERE owner_id IS NOT NULL`);
      definitions[table] = removed.count;
    }

    // (4) Версия реестра владельца. Безусловным `UPDATE`, а не «где не ноль»: правило
    // операции — «после пересева версия владельца равна нулю», и проверять его надо по
    // состоянию, а не по числу задетых строк.
    const settingsReset = await tx.unsafe('UPDATE user_settings SET registry_version = 0');

    // (5) Пересев. Тот же код, что у `ops.ts seed-registries`: второй реализации «что такое
    // системный реестр» быть не должно.
    const seed = await seedRegistries(tx, adminDsn);

    return {
      graph: {
        entities: before.entities ?? 0,
        relations: before.relations ?? 0,
        chat_threads: before.chat_threads ?? 0,
        chat_messages: before.chat_messages ?? 0,
        entity_origins: before.entity_origins ?? 0,
        entity_versions: before.entity_versions ?? 0,
      },
      deltas: before.registry_deltas ?? 0,
      definitions,
      settingsReset: settingsReset.count,
      seed,
    };
  });
}

/** Строки отчёта — то, что оператор читает и кладёт в чек-лист runbook §1. */
export function resetWorldReport(r: ResetWorldReport): string[] {
  return [
    'reset-world: снесено —',
    `  граф и журнал: ${Object.entries(r.graph)
      .map(([t, n]) => `${t} ${n}`)
      .join(', ')}`,
    `  дельты реестров: ${r.deltas}`,
    `  пользовательские строки реестров: ${Object.entries(r.definitions)
      .map(([t, n]) => `${t} ${n}`)
      .join(', ')}`,
    `  версия реестра владельца обнулена у строк настроек: ${r.settingsReset}`,
    ...seedRegistriesReport(r.seed),
  ];
}

/**
 * Reference прод-проекта Supabase, выведенный ИЗ САМОГО DSN.
 *
 * Зачем выводить, а не спрашивать вторым секретом: подтверждение должно отвечать на вопрос
 * «оператор назвал ТУ базу, к которой мы подключимся», а не «оператор помнит какую-то
 * строку». Признак — тот же, по которому базу узнаёт человек в runbook §1: имя пользователя
 * пулера имеет вид `postgres.<REF>` (Supavisor так маршрутизирует проект), а у прямого
 * подключения ref стоит в хосте `db.<REF>.supabase.co`.
 *
 * `null` — «ref из этого DSN не выводится» (например, локальный `postgres@127.0.0.1`), и это
 * ОТКАЗ, а не послабление: подтвердить нечего, значит подтверждения нет.
 *
 * Разбор без `new URL`: пароль DSN может содержать символы, на которых конструктор URL
 * спотыкается, а нам нужны только имя пользователя и хост.
 */
export function prodRefFromDsn(dsn: string): string | null {
  const user = /^postgres(?:ql)?:\/\/([^:@/?#]+)[:@]/.exec(dsn)?.[1];
  const dot = user?.indexOf('.') ?? -1;
  if (user !== undefined && dot > 0) return user.slice(dot + 1);
  const at = dsn.lastIndexOf('@');
  const host = at === -1 ? '' : dsn.slice(at + 1);
  return /^db\.([a-z0-9]+)\.supabase\.co(?::|\/|$)/.exec(host)?.[1] ?? null;
}

/** Точное слово второго флага. Оно одно и пишется здесь, а не в двух местах. */
const UNDERSTAND_WORD = 'RESET';

export type ResetWorldGate = { proceed: true } | { proceed: false; code: number; lines: string[] };

/**
 * ДВА НЕЗАВИСИМЫХ ФЛАГА, оба обязательны, stdin не читается (Р-23c-1).
 *
 * Почему не «повторный ввод RESET с клавиатуры», как говорил первый черновик регламента:
 * процедуру выполняет оператор из среды без TTY, а `printf RESET | bun scripts/ops.ts …` —
 * составная команда, которая уходит в классификатор разрешений целиком. Два флага в одной
 * строке чуть менее «интерактивны», чем stdin; компенсирует это второй флаг, несущий точное
 * слово, — опечатка в нём отказ, а не согласие.
 *
 * Вызов БЕЗ `--confirm` — не ошибка оператора, а штатный первый шаг: он печатает ожидаемый
 * ref (секретов в нём нет — runbook §1 называет его фактом) и выходит кодом 2, чтобы значение
 * можно было скопировать в настоящий вызов.
 *
 * Незнакомый флаг — ОТКАЗ, а не «пропустим»: та же причина, что у `parsePatArgs` (опечатка в
 * имени флага иначе означала бы согласие, которого не давали).
 */
export function resetWorldGate(dsn: string, args: string[]): ResetWorldGate {
  const usage = `  bun scripts/ops.ts reset-world --confirm <PROD_REF> --i-understand ${UNDERSTAND_WORD}`;
  let confirm: string | undefined;
  let understand: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i];
    if (flag === '--confirm') {
      confirm = args[++i];
      continue;
    }
    if (flag === '--i-understand') {
      understand = args[++i];
      continue;
    }
    return {
      proceed: false,
      code: 2,
      lines: [`reset-world: неизвестный аргумент «${flag}».`, usage],
    };
  }

  const expected = prodRefFromDsn(dsn);
  if (expected === null) {
    return {
      proceed: false,
      code: 2,
      lines: [
        'reset-world: из DSN не выводится reference проекта — подтверждать нечем.',
        'Ожидался пулерный DSN вида postgresql://postgres.<PROD_REF>:…@<POOLER_HOST>:5432/postgres',
        '(runbook §1). Операция не выполнена.',
      ],
    };
  }
  if (confirm === undefined) {
    return {
      proceed: false,
      code: 2,
      lines: [
        'reset-world: РАЗРУШАЮЩАЯ операция — требуется подтверждение двумя флагами.',
        `Подключение ведёт к проекту: ${expected}`,
        usage.replace('<PROD_REF>', expected),
      ],
    };
  }
  if (confirm !== expected) {
    return {
      proceed: false,
      code: 2,
      lines: [
        `reset-world: --confirm «${confirm}» не совпадает с проектом подключения «${expected}».`,
        'Операция не выполнена — проверь, к той ли базе ведёт DSN в Ключнице.',
      ],
    };
  }
  if (understand !== UNDERSTAND_WORD) {
    return {
      proceed: false,
      code: 2,
      lines: [
        understand === undefined
          ? `reset-world: нет второго подтверждения --i-understand ${UNDERSTAND_WORD}.`
          : `reset-world: --i-understand ожидает точное слово ${UNDERSTAND_WORD}, получено «${understand}».`,
        usage.replace('<PROD_REF>', expected),
      ],
    };
  }
  return { proceed: true };
}

/** Ввод-вывод операции — тот же приём инъекции, что у `backfillBodyDoc` (тест без Ключницы). */
export interface ResetWorldIo {
  /** Прод-DSN. В `ops.ts` — чтение Ключницы; значение не логируется ни при каком исходе. */
  readDsn(): string;
  /** Открытие пула. Зовётся ТОЛЬКО после успешного подтверждения — это и есть гарантия «отказ до любой записи». */
  openSql(dsn: string): Sql;
  log(line: string): void;
  error(line: string): void;
}

/**
 * Операция целиком: подтверждение → пересев → отчёт. Код возврата — код операции `ops.ts`.
 *
 * Подключение открывается ПОСЛЕ проверки обоих флагов, а не до: разрушающая операция не
 * должна успевать даже дотронуться до базы, пока подтверждение не сошлось.
 */
export async function runResetWorld(args: string[], io: ResetWorldIo): Promise<number> {
  const dsn = io.readDsn();
  const gate = resetWorldGate(dsn, args);
  if (!gate.proceed) {
    for (const line of gate.lines) io.error(line);
    return gate.code;
  }
  const sql = io.openSql(dsn);
  try {
    for (const line of resetWorldReport(await resetWorld(sql, dsn))) io.log(line);
  } finally {
    await sql.end();
  }
  return 0;
}
