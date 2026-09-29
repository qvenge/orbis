// apps/server/src/seed/setup-graph.ts
// Заведение графа (срез 1б §8.6, РП-15, Р-29, С1б-5) — ЕДИНСТВЕННАЯ запись онбординга.
//
// Единственная запись онбординга — заведение графа, действие владельца по Р-29: вход владельца в
// граф, где нет оболочки хоста, заводит его один раз; на каждом следующем входе онбординг не пишет
// НИЧЕГО (§0.2 п. 2, «никаких тихих записей»). Досевов нет: новая запись поставки или новый эталон в
// заведённом графе приходят только предложением (§9.1), разовые переводы данных — прод-процедурой со
// словом владельца (белый список `scripts/ops.ts`; перевод 1б `migrate-1b` исполнен в проде 28.09 и снят
// срезом 1в, РП-13).
//
// ПРИЗНАК «ГРАФ ЗАВЕДЁН» — запись с `orbis/supply_key = host-shell`, В ТОМ ЧИСЛЕ АРХИВНАЯ (Р-29): в
// продукте её нельзя удалить, только заархивировать, и архив — решение владельца, а не «графа нет».
// Строка настроек маркером больше не служит: `reset-world` её сохраняет, а оболочку сносит — и
// ближайший вход после пересева заводит граф заново тем же путём, что новый (один путь, Р-29).
//
// ПОРЯДОК (РП-15, R-20): маска [] → 12 категорий → записи поставки БЕЗ оболочки → садовник → «Перенос
// остатков» → маска ['finance'] → глобальный тред → ОБОЛОЧКА ХОСТА последней пачкой. Сев — ДО маски: при
// выключенных Финансах пачка категорий получила бы `MODULE_DISABLED`. Когда маска снимается и ставится —
// раздел «МАСКА» ниже.
//
// ПОЧЕМУ ОБОЛОЧКА — ПОСЛЕДНЕЙ (R-20, Р-29). Признак «граф заведён» обязан значить «заведён ЦЕЛИКОМ»:
// оболочка, записанная раньше рутин и маски, при падении процесса посередине оставила бы граф без
// садовника или с включёнными Финансами навсегда — следующий вход, увидев признак, не пишет ничего. Пока
// оболочки нет, граф «не заведён», и каждый шаг до неё повторяем: id детерминированы (uuidv5), всё, что
// уже есть, пропускается пробой по PK, маска идемпотентна. Вход после частичного заведения поэтому
// доводит граф до конца тем же путём.
//
// МАСКА (фикс-раунд 1 задачи 12). Маска — слово владельца (`module_set`, журнал и Undo), и заведение
// трогает её ровно настолько, насколько она ещё не его:
//  - ПЕРВОЕ заведение (ни одной категории мира — новый граф, граф после `reset-world`, падение до первой
//    пачки): маска снимается целиком (Д-1: после пересева в сохранённой строке может стоять что угодно, а
//    граф заводится в одном виде), в конце — `['finance']`;
//  - ДОВЕДЕНИЕ частичного заведения (категории есть, оболочки нет): маска НЕ снимается; Финансы в конце
//    выключаются, только если в журнале графа нет ни одного `module_set` владельца. Выбран журнал, а не
//    «шаг маски пройден»: между падением и следующим входом приложение работает (строка настроек есть),
//    и владелец мог переключить расширение — это его журналированное действие, и молча отменять его
//    записью без журнала нельзя. Если он его сказал, граф доводится с его маской как есть;
//  - проигравший гонку вход (оболочку под замком строки настроек уже записал другой) маску не трогает.
// Шаги маски обоих входов сериализует `FOR UPDATE` строки настроек.
//
// ТРАНЗАКЦИИ РАЗНЫЕ, И НАМЕРЕННО: `execute` открывает свою транзакцию на другом соединении (рулинг
// Р-17-1), вложить его в транзакцию маски — дедлок на строке настроек. Атомарности на весь путь нет;
// её заменяют повторяемость шагов (выше) и перепроверка по PK после отказа пачки — так ловится гонка
// двух первых входов.
//
// ЖУРНАЛА НЕТ (как у сева до 1б, решение 6 плана онбординга): заведение графа — не правка, и стать
// «последним действием» для Undo оно не должно.
import { type GraphId, ORBIS_NAMESPACE, SUPPLY_ASPECT, SUPPLY_KEY } from '@orbis/shared';
import {
  LEGACY_SEED_LIST_SLUGS,
  SUPPLY_ETALONS,
  type SupplyEtalon,
  type SupplyKey,
} from '@orbis/shared/supply';
import { sql } from 'drizzle-orm';
import { v5 as uuidv5 } from 'uuid';
import { ensureGlobalThread } from '../chat/threads';
import type { Db } from '../db/client';
import { userSettings } from '../db/schema';
import { type Tx, withIdentity } from '../db/with-identity';
import { ExecError } from '../errors';
import { execute } from '../executor/executor';
import type { Identity } from '../identity';
import { effectiveRegistry } from '../registry/cache';
import { disabledExtensionsOf, setExtensionDisabled } from '../registry/extensions';
import { lockOwnerRegistry } from '../registry/ops';
import { supplyCreateOps, supplyRecordId } from '../supply/records';
import { SEED_CATEGORIES } from './categories';
import { seedGardener } from './gardener';
import { ensurePersonalGraph } from './personal-graph';
import { seedRolloverRoutine } from './rollover-routine';
import { missingIds, seedCategoryId, seedOwnerWorld, seedSmartListId } from './world';

export interface SetupGraphOptions {
  /**
   * Садовник и «Перенос остатков» (по умолчанию — да). `false` — вход фикстур `seedOwnerGraph`: рутины
   * в чужом сьюте только шумят (перф-обвязка, гейт бюджета, импорт), и числа этих сьютов от них не
   * зависят.
   */
  routines?: boolean;
  clock?: () => Date;
  /** Эталоны поставки — инъекция «нового релиза» в тестах; в бою — эталоны кода. */
  etalons?: readonly SupplyEtalon[];
  /** Точка после каждого шага — инъекция падения процесса в тестах повторяемости (R-20). */
  afterStep?: (step: SetupStep) => void | Promise<void>;
}

/** Шаги заведения до оболочки хоста — точки, после которых процесс может упасть (R-20). */
export type SetupStep = 'world' | 'supply' | 'routines' | 'mask';

export interface SetupGraphResult {
  /** `true` — граф завёл ЭТОТ вызов; `false` — граф уже был заведён (или его завёл параллельный вход). */
  seeded: boolean;
}

/** Расширение, выключенное в заведённом графе (спека 1б §8.6: «маска с выключенными Финансами»). */
const SETUP_DISABLED_EXTENSION = 'finance';

type GraphState = 'ready' | 'legacy' | 'new';

/** Оболочка хоста есть (с архивной) — признак «граф заведён» (Р-29). */
async function shellExists(tx: Tx, graph: GraphId): Promise<boolean> {
  const shell = await tx.execute(sql`
    SELECT 1 FROM entities
     WHERE graph_id = ${graph}::uuid
       AND props @> ${JSON.stringify({ [SUPPLY_KEY]: 'host-shell' })}::jsonb
     LIMIT 1`);
  return shell.length > 0;
}

/**
 * Состояние графа по одной пробе чтения. `ready` — оболочка хоста есть (с архивной); `legacy` — мир
 * старой формы (Э-18): ЛЮБОЙ из ПРЕЖНИХ шести списков сева (`LEGACY_SEED_LIST_SLUGS` — с Upcoming, а не
 * нынешний сев с Повесткой, срез 1в §6.3) на своём прежнем id без аспекта «поставка». Не только
 * «Daily Planning»: граф, где его строки нет, а пять других старой формы, иначе сошёл бы за новый —
 * пачка страниц пропустила бы занятые id, оболочка поставила бы навигацию на записи вне поставки, и
 * отказ «граф старой формы» больше не звучал бы. Заводить поверх такого мира нельзя, переводить молча —
 * тем более; `new` — иначе.
 */
async function graphState(tx: Tx, graph: GraphId): Promise<GraphState> {
  if (await shellExists(tx, graph)) return 'ready';
  const listIds = LEGACY_SEED_LIST_SLUGS.map((slug) => seedSmartListId(graph, slug));
  const legacy = await tx.execute(sql`
    SELECT 1 FROM entities
     WHERE graph_id = ${graph}::uuid
       AND id IN (${sql.join(
         listIds.map((id) => sql`${id}::uuid`),
         sql`, `,
       )})
       AND NOT (aspects @> ARRAY[${SUPPLY_ASPECT}]::text[])
     LIMIT 1`);
  return legacy.length > 0 ? 'legacy' : 'new';
}

/**
 * Заведение графа уже СЕЯЛО (есть хоть одна категория мира): пачка категорий — первый сев и атомарна,
 * так что её отсутствие значит «ни один шаг сева не прошёл» — новый граф, граф после `reset-world` или
 * падение до первой пачки. Архивная категория — тоже «есть».
 */
async function worldSeeded(tx: Tx, graph: GraphId): Promise<boolean> {
  const ids = SEED_CATEGORIES.map((c) => seedCategoryId(graph, c.slug));
  const rows = await tx.execute(sql`
    SELECT 1 FROM entities
     WHERE graph_id = ${graph}::uuid
       AND id IN (${sql.join(
         ids.map((id) => sql`${id}::uuid`),
         sql`, `,
       )})
     LIMIT 1`);
  return rows.length > 0;
}

/**
 * Владелец уже сказал своё слово о ФИНАНСАХ — расширении, которое заведение выключает: в журнале графа
 * есть операция `module_set` по `finance` (с Undo — тоже слово). Проба — по ОПЕРАЦИИ, а не по типу
 * действия (финал 1б, остатки М-9, М-10): `module_set` приходит и одиночным действием, и внутри пачки
 * `app.setDisabled` (тип `batch`), — а слово о другом расширении Финансы не касается, и заведение
 * доводит их до выключения, как задумано.
 */
async function ownerSetMask(tx: Tx, graph: GraphId): Promise<boolean> {
  const probe = {
    actions: [
      { operations: [{ op: 'module_set', payload: { module: SETUP_DISABLED_EXTENSION } }] },
    ],
  };
  const rows = await tx.execute(sql`
    SELECT 1 FROM chat_messages m JOIN chat_threads t ON t.id = m.thread_id
     WHERE t.graph_id = ${graph}::uuid
       AND m.metadata @> ${JSON.stringify(probe)}::jsonb
     LIMIT 1`);
  return rows.length > 0;
}

/**
 * Замки шагов маски: реестра владельца, затем строки настроек. Строка сериализует шаги маски двух
 * параллельных входов; замок реестра — с `module_set` исполнителя (финал 1б, остаток М-12): тот
 * читает прежнюю маску для Undo под этим замком, и запись маски мимо него дала бы Undo по устаревшей
 * маске. Порядок — глобальный «advisory → строки» исполнителя: обратный — взаимная блокировка.
 */
async function lockSettings(tx: Tx, graph: GraphId): Promise<void> {
  await lockOwnerRegistry(tx, graph);
  await tx.execute(sql`SELECT 1 FROM user_settings WHERE graph_id = ${graph}::uuid FOR UPDATE`);
}

/**
 * «Уже есть» у записи поставки — только если на её id лежит запись С ЭТИМ КЛЮЧОМ. Иначе id занят чужой
 * записью (явный id `entity_create`), и молча пропустить её значило бы: у оболочки — вечное «граф не
 * заведён» и перезапись маски на каждом входе (тихие записи навсегда), у страницы — навигацию на
 * чужую запись. Состояние по замыслу недостижимое — поэтому отказ, а не обход.
 */
async function assertOwnSupplyIds(
  db: Db,
  who: Identity,
  keys: readonly SupplyKey[],
): Promise<void> {
  const graph = who.graph;
  const rows = (await withIdentity(db, who, (tx) =>
    tx.execute(sql`
      SELECT id::text AS id, props ->> ${SUPPLY_KEY} AS key FROM entities
       WHERE graph_id = ${graph}::uuid AND id IN (${sql.join(
         keys.map((k) => sql`${supplyRecordId(graph, k)}::uuid`),
         sql`, `,
       )})`),
  )) as unknown as Array<{ id: string; key: string | null }>;
  for (const k of keys) {
    const row = rows.find((r) => r.id === supplyRecordId(graph, k));
    if (row !== undefined && row.key !== k) {
      throw new ExecError(
        'INVARIANT',
        `запись поставки «${k}» не заведена: её id занят чужой записью`,
        { key: k, id: row.id },
      );
    }
  }
}

/** batchId пачки записей поставки — детерминированный, как у пачки мира; у оболочки — свой. */
function supplyBatchId(graph: GraphId, part: 'pages' | 'shell'): string {
  return uuidv5(`${graph.toLowerCase()}:setup-supply:${part}`, ORBIS_NAMESPACE);
}

/**
 * Записи поставки ключей `keys` одной пачкой механизма `supply` (свойства эталона с `writer: 'supply'`
 * другой механизм не запишет — гейт задачи 9); записи, что уже есть, пропускаются. Возвращает, создал ли
 * их ЭТОТ вызов: пачка атомарна, а отказ из-за гонки распознаётся перепроверкой по PK.
 *
 * Ссылки оболочки ставятся на записи ключей эталонов: к моменту её пачки страницы уже заведены.
 */
async function seedSupplyRecords(
  db: Db,
  who: Identity,
  clock: () => Date,
  etalons: readonly SupplyEtalon[],
  keys: readonly SupplyKey[],
  part: 'pages' | 'shell',
): Promise<boolean> {
  if (keys.length === 0) return false;
  const graph = who.graph;
  const ids = keys.map((k) => supplyRecordId(graph, k));
  const missing = await missingIds(db, who, ids);
  // Чужая запись на id поставки — отказ ДО пачки при любом числе недостающих (финал 1б, остаток М-11):
  // иначе занятый id молча пропускался бы, а оболочка ставила бы навигацию на чужую запись.
  await assertOwnSupplyIds(db, who, keys);
  if (missing.size === 0) return false;

  const reg = await withIdentity(db, who, (tx) => effectiveRegistry(tx, graph));
  const all: readonly SupplyKey[] = etalons.map((e) => e.key);
  const ops = supplyCreateOps(
    graph,
    keys.filter((k) => missing.has(supplyRecordId(graph, k))),
    (k) => (all.includes(k) ? supplyRecordId(graph, k) : null),
    reg,
    etalons,
  );
  const r = await execute(db, {
    identity: who,
    actorKind: 'owner',
    source: 'system',
    mechanism: 'supply',
    batchId: supplyBatchId(graph, part),
    operations: ops,
    clock,
  });
  if (!r.ok) {
    // Гонка двух первых входов — единственный законный отказ, и он проверяется: записи на месте —
    // значит их завёл параллельный вход.
    if ((await missingIds(db, who, ids)).size === 0) {
      await assertOwnSupplyIds(db, who, keys);
      return false;
    }
    throw new Error(`сев записей поставки: ${r.error.code} ${r.error.message}`);
  }
  return true;
}

/**
 * Завести граф владельца, если он не заведён. Граф старой формы — отказ `GRAPH_NEEDS_MIGRATION` без
 * единой записи (Э-18). Перевод 1б `migrate-1b` снят срезом 1в (РП-13: исполнен в проде 28.09, его план
 * стоял на эталонах, которые 1в меняет) — перевода нет: мир пересевается `reset-world` (ранбук), данные графа
 * сносятся.
 *
 * `installedViews` и `pinnedEntities` не пишутся (РП-15): закреплённые стали навигацией оболочки хоста.
 */
export async function setupGraph(
  db: Db,
  who: Identity,
  opts: SetupGraphOptions = {},
): Promise<SetupGraphResult> {
  const clock = opts.clock ?? (() => new Date());
  const etalons = opts.etalons ?? SUPPLY_ETALONS;
  const graph = who.graph;

  // Строка `graphs` — ПЕРВОЙ (D44): каждая запись мира несёт FK на неё. Для существующего графа —
  // проба без записи.
  await withIdentity(db, who, (tx) => ensurePersonalGraph(tx, who));

  const state = await withIdentity(db, who, (tx) => graphState(tx, graph));
  if (state === 'ready') return { seeded: false };
  if (state === 'legacy') {
    throw new ExecError(
      'GRAPH_NEEDS_MIGRATION',
      'граф старой формы: перевода нет — мир пересевается операцией reset-world, данные графа сносятся (docs/implementation/02-ops-runbook.md, «Что делает пересев и что он сносит»)',
      { graph },
    );
  }

  // Строка настроек и решение о маске — под замком строки. Строку заводим здесь, а не ждём
  // `setExtensionDisabled` в конце: тот завёл бы её с одной маской, а дефолты настроек — дело заведения.
  const plan = await withIdentity(db, who, async (tx) => {
    // Замок реестра — ПЕРВЫМ statement'ом (порядок «advisory → строки», см. `lockSettings`): вставка
    // строки настроек ниже уже берёт её замок.
    await lockOwnerRegistry(tx, graph);
    await tx
      .insert(userSettings)
      .values({
        graphId: graph,
        plan: 'dev',
        timezone: 'Europe/Moscow',
        defaultCurrency: 'RUB',
        weekStartDay: 'monday',
        updatedAt: clock(),
      })
      .onConflictDoNothing();
    await lockSettings(tx, graph);
    // Параллельный вход довёл граф, пока мы пробовали: ничего не пишем.
    if (await shellExists(tx, graph)) return null;
    const fresh = !(await worldSeeded(tx, graph));
    if (fresh) {
      for (const ext of await disabledExtensionsOf(tx, graph)) {
        await setExtensionDisabled(tx, graph, ext, false);
      }
    }
    return { ownMask: fresh || !(await ownerSetMask(tx, graph)) };
  });
  if (plan === null) return { seeded: false };

  const step = opts.afterStep ?? (() => {});
  const shellKeys = etalons.filter((e) => e.kind === 'app').map((e) => e.key);
  const pageKeys = etalons.filter((e) => e.kind !== 'app').map((e) => e.key);

  await seedOwnerWorld(db, who, { clock });
  await step('world');
  await seedSupplyRecords(db, who, clock, etalons, pageKeys, 'pages');
  await step('supply');
  // Садовник — после списков: он рутина и в «Рутинах» виден с первого открытия. Оба сева повторяемы
  // (проба по PK) и переживают гонку (одиночный `entity_create` на своём занятом id — replay).
  if (opts.routines ?? true) {
    await seedGardener(db, who, clock);
    await seedRolloverRoutine(db, who, clock);
  }
  await step('routines');

  // Маска Финансов — только если маска наша (см. «МАСКА» в шапке) и граф ещё не довёл параллельный вход:
  // проигравший гонку, увидев оболочку под замком, маску не трогает вовсе.
  const finished = await withIdentity(db, who, async (tx) => {
    await lockSettings(tx, graph);
    if (await shellExists(tx, graph)) return true;
    if (plan.ownMask) await setExtensionDisabled(tx, graph, SETUP_DISABLED_EXTENSION, true);
    await ensureGlobalThread(tx, graph);
    return false;
  });
  if (finished) return { seeded: false };
  await step('mask');

  // Признак «граф заведён» — ПОСЛЕДНИМ (R-20). `seeded` — оболочку завёл этот вызов.
  const seeded = await seedSupplyRecords(db, who, clock, etalons, shellKeys, 'shell');
  return { seeded };
}
