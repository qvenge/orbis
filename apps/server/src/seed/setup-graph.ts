// apps/server/src/seed/setup-graph.ts
// Заведение графа (срез 1б §8.6, РП-15, Р-29, С1б-5) — ЕДИНСТВЕННАЯ запись онбординга.
//
// Единственная запись онбординга — заведение графа, действие владельца по Р-29: вход владельца в
// граф, где нет оболочки хоста, заводит его один раз; на каждом следующем входе онбординг не пишет
// НИЧЕГО (§0.2 п. 2, «никаких тихих записей»). Досевов нет: новая запись поставки или новый эталон в
// заведённом графе приходят только предложением (§9.1), разовые переводы данных — прод-процедурой со
// словом владельца (`migrate-1b`, задача 13).
//
// ПРИЗНАК «ГРАФ ЗАВЕДЁН» — запись с `orbis/supply_key = host-shell`, В ТОМ ЧИСЛЕ АРХИВНАЯ (Р-29): в
// продукте её нельзя удалить, только заархивировать, и архив — решение владельца, а не «графа нет».
// Строка настроек маркером больше не служит: `reset-world` её сохраняет, а оболочку сносит — и
// ближайший вход после пересева заводит граф заново тем же путём, что новый (один путь, Р-29).
//
// ПОРЯДОК (РП-15, R-20): маска [] → 12 категорий → записи поставки БЕЗ оболочки → садовник → «Перенос
// остатков» → маска ['finance'] → глобальный тред → ОБОЛОЧКА ХОСТА последней пачкой. Сев — ДО маски: при
// выключенных Финансах пачка категорий получила бы `MODULE_DISABLED`. Маска снимается целиком, а не только
// Финансы: после `reset-world` в сохранённой строке настроек может стоять любое из четырёх расширений
// (Д-1), а граф заводится в одном виде.
//
// ПОЧЕМУ ОБОЛОЧКА — ПОСЛЕДНЕЙ (R-20, Р-29). Признак «граф заведён» обязан значить «заведён ЦЕЛИКОМ»:
// оболочка, записанная раньше рутин и маски, при падении процесса посередине оставила бы граф без
// садовника или с включёнными Финансами навсегда — следующий вход, увидев признак, не пишет ничего. Пока
// оболочки нет, граф «не заведён», и каждый шаг до неё повторяем: id детерминированы (uuidv5), всё, что
// уже есть, пропускается пробой по PK, маска идемпотентна. Вход после частичного заведения поэтому
// доводит граф до конца тем же путём.
//
// ТРАНЗАКЦИИ РАЗНЫЕ, И НАМЕРЕННО: `execute` открывает свою транзакцию на другом соединении (рулинг
// Р-17-1), вложить его в транзакцию маски — дедлок на строке настроек. Атомарности на весь путь нет;
// её заменяют повторяемость шагов (выше) и перепроверка по PK после отказа пачки — так ловится гонка
// двух первых входов.
//
// ЖУРНАЛА НЕТ (как у сева до 1б, решение 6 плана онбординга): заведение графа — не правка, и стать
// «последним действием» для Undo оно не должно.
import { type GraphId, ORBIS_NAMESPACE, SUPPLY_ASPECT, SUPPLY_KEY } from '@orbis/shared';
import { SUPPLY_ETALONS, type SupplyEtalon, type SupplyKey } from '@orbis/shared/supply';
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
import { supplyCreateOps, supplyRecordId } from '../supply/records';
import { seedGardener } from './gardener';
import { ensurePersonalGraph } from './personal-graph';
import { seedRolloverRoutine } from './rollover-routine';
import { missingIds, seedOwnerWorld, seedSmartListId } from './world';

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

/**
 * Состояние графа по одной пробе чтения. `ready` — оболочка хоста есть (с архивной); `legacy` — мир
 * старой формы: список «Daily Planning» на своём прежнем id без аспекта «поставка» (Э-18) — заводить
 * поверх него нельзя (сев упёрся бы в PK списков), переводить молча — тем более; `new` — иначе.
 */
async function graphState(tx: Tx, graph: GraphId): Promise<GraphState> {
  const shell = await tx.execute(sql`
    SELECT 1 FROM entities
     WHERE graph_id = ${graph}::uuid
       AND props @> ${JSON.stringify({ [SUPPLY_KEY]: 'host-shell' })}::jsonb
     LIMIT 1`);
  if (shell.length > 0) return 'ready';
  const legacy = await tx.execute(sql`
    SELECT 1 FROM entities
     WHERE graph_id = ${graph}::uuid
       AND id = ${seedSmartListId(graph, 'daily-planning')}::uuid
       AND NOT (aspects @> ARRAY[${SUPPLY_ASPECT}]::text[])`);
  return legacy.length > 0 ? 'legacy' : 'new';
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
    if ((await missingIds(db, who, ids)).size === 0) return false;
    throw new Error(`сев записей поставки: ${r.error.code} ${r.error.message}`);
  }
  return true;
}

/**
 * Завести граф владельца, если он не заведён. Граф старой формы — отказ `GRAPH_NEEDS_MIGRATION` без
 * единой записи (Э-18: его переводит `migrate-1b`).
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
      'граф старой формы: его нужно перевести на новую версию (bun scripts/ops.ts migrate-1b)',
      { graph },
    );
  }

  // Маска [] и строка настроек. Строку заводим здесь, а не ждём `setExtensionDisabled` в конце: тот
  // завёл бы её с одной маской, а дефолты настроек — дело заведения графа.
  await withIdentity(db, who, async (tx) => {
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
    for (const ext of await disabledExtensionsOf(tx, graph)) {
      await setExtensionDisabled(tx, graph, ext, false);
    }
  });

  const step = opts.afterStep ?? (() => {});
  const shellKeys = etalons.filter((e) => e.kind === 'app').map((e) => e.key);
  const pageKeys = etalons.filter((e) => e.kind !== 'app').map((e) => e.key);

  await seedOwnerWorld(db, who, { clock });
  await step('world');
  await seedSupplyRecords(db, who, clock, etalons, pageKeys, 'pages');
  await step('supply');
  // Садовник — после списков: он рутина и в «Рутинах» виден с первого открытия. Оба сева повторяемы
  // (проба по PK) и переживают гонку (перепроверка после отказа).
  if (opts.routines ?? true) {
    await seedGardener(db, who, clock);
    await seedRolloverRoutine(db, who, clock);
  }
  await step('routines');

  // Маска — у ОБОИХ входов гонки: проигравший снимал её до своего сева, и оставить её снятой значило бы
  // завести граф с включёнными Финансами.
  await withIdentity(db, who, async (tx) => {
    await setExtensionDisabled(tx, graph, SETUP_DISABLED_EXTENSION, true);
    await ensureGlobalThread(tx, graph);
  });
  await step('mask');

  // Признак «граф заведён» — ПОСЛЕДНИМ (R-20). `seeded` — оболочку завёл этот вызов.
  const seeded = await seedSupplyRecords(db, who, clock, etalons, shellKeys, 'shell');
  return { seeded };
}
