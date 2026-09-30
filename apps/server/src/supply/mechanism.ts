// apps/server/src/supply/mechanism.ts
// Механизм поставки (срез 1б §9.1 п. 2–4, РП-6, С1б-6): обновления записей поставки — ТОЛЬКО
// предложениями.
//
// Никаких тихих записей (§0.2 п. 2, С1б-5): релиз записи поставки не трогает никогда. Новый эталон кода —
// это лишь другой отпечаток; `listUpdates` его показывает, а пишет только действие владельца — «принять»,
// «оставить своё», «принять все», «вернуть как было», «добавить». Каждое — одна пачка исполнителя, одна
// запись журнала со своей подписью, один Undo.
//
// Кто пишет что. Свойства эталона (ключ, отпечаток, текст, отказ) пишет только механизм `supply` (флаг
// `writer`, задача 9): «принять», «оставить своё», «добавить». «Вернуть как было» — механизм `user`: оно
// меняет только содержимое записи (к печати эталона, которая в записи уже лежит), и эталон записи не
// трогает — после него запись снова «как в поставке» того же эталона.
//
// Запись поставки — та, что НЕСЁТ аспект «поставка» сейчас (R-17): снятый аспект — решение владельца
// «вывести из поставки», и такой записи механизм не предлагает ничего и ничего в ней не пишет, хотя её
// свойства эталона остаются (снятие аспекта значений не трогает, Р9).
import {
  APP_ASPECT,
  APP_HOME,
  APP_NAV,
  APP_OPENS_OVER,
  type GraphId,
  newId,
  SUPPLY_ASPECT,
  SUPPLY_DECLINED,
  SUPPLY_HASH,
  SUPPLY_KEY,
  SUPPLY_TEXT,
} from '@orbis/shared';
import {
  etalonOf,
  SUPPLY_ETALONS,
  type SupplyEtalon,
  type SupplyKey,
  type SupplyKeyValue,
} from '@orbis/shared/supply';
import {
  APP_PRINT_PROPS,
  parseAppPrint,
  parsePagePrint,
  printAppProps,
  printPageRecord,
  supplyStatusOf,
} from '@orbis/shared/supply/print';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { entities } from '../db/schema';
import { type Tx, withIdentity } from '../db/with-identity';
import { ExecError, type ExecErrorCode } from '../errors';
import { execute } from '../executor/executor';
import { makeJournalSink } from '../executor/journal';
import { actionsOnEntity, isUndone, type JournalEntry } from '../executor/journal-read';
import type { MutationMechanism } from '../executor/types';
import type { Identity } from '../identity';
import { effectiveRegistry } from '../registry/cache';
import type { RegistrySnapshot } from '../registry/load';
import type { ExecOperation } from '../routines/propose';
import { etalonHash } from './hash';
import { appEtalonProps, type ResolveSupplyKey, supplyCreateOps, supplyTextOf } from './records';

const sink = makeJournalSink();

/** Подпись закреплённой версии тела перед заменой (§9.1 п. 2 «прежняя версия сохранится», п. 4). */
export const PREVIOUS_VERSION_LABEL = 'Прежняя версия';

export interface SupplyCtx {
  db: Db;
  identity: Identity;
}

/**
 * Пункт «Обновлений» (§9.1 п. 2–3). `update` — у живой записи поставки отпечаток не тот, что у эталона кода,
 * и владелец от этого эталона не отказывался; `new` — записи ключа нет вовсе либо её архив — откат её же
 * создания (R-18). `edited` — запись правлена владельцем («Принять все» её не берёт). `declined` — владелец
 * отказывался от ПРЕЖНЕГО эталона этой записи (отказ от нынешнего пункт убирает совсем): плашка может
 * сказать «вы уже оставляли своё — вот ещё более новый эталон».
 *
 * `etalonText` — печать НОВОГО эталона в этом графе (канон тела считает только сервер), `recordText` —
 * нынешняя печать записи (`null` у новой): по этой паре «Сравнить» задачи 22 строит двусторонний дифф без
 * шума канона.
 */
export interface SupplyUpdate {
  key: SupplyKey;
  kind: 'update' | 'new';
  recordId: string | null;
  edited: boolean;
  declined: boolean;
  etalonText: string;
  recordText: string | null;
}

interface SupplyRow {
  id: string;
  title: string;
  emoji: string | null;
  body: string;
  aspects: string[];
  props: Record<string, unknown>;
  archived: boolean;
  updatedAt: string;
}

interface Snapshot {
  rows: SupplyRow[];
  reg: RegistrySnapshot;
  /** Архивные записи, чей архив — откат их же создания (R-18): «как будто не добавляли». */
  undoneCreation: ReadonlySet<string>;
}

/**
 * Глубина обхода журнала записи в `archivedByUndoneCreation` (гейт m-5 задачи 9): обход кончается на первом
 * неотменённом действии, так что читать журнал записи целиком незачем. Цепочка из стольких ОТМЕНЁННЫХ
 * правок подряд — не сценарий владельца; не дошли до решения — признака нет (предложения нет), то есть
 * ошибка в безопасную сторону: поставка промолчит, а не вернёт из архива то, что владелец убрал.
 */
const UNDONE_WALK_DEPTH = 50;

/**
 * Архив записи — откат её «добавления», а не решение владельца (R-18)? Признак по журналу: ПОСЛЕДНЕЕ
 * НЕОТМЕНЁННОЕ действие, тронувшее запись (любая операция с её id), — «добавление», и оно отменено.
 * «Добавление» — это создание записи (`entity_create` с её id: сев, «добавить») или возврат её из архива
 * механизмом `supply` («добавить» по записи, чей архив — откат прежнего добавления). Круг «добавить → Undo
 * → добавить → Undo» поэтому держится на любой глубине: смотрится последнее действие, а не первое
 * создание. Возврат из архива владельцем (механизм `user`) — его правка; если потом запись в архиве — это
 * его решение, предложения нет.
 *
 * ОТМЕНЁННЫЕ ДЕЙСТВИЯ, КРОМЕ «ДОБАВЛЕНИЯ», ПРОПУСКАЮТСЯ (М-8 остатков 1б): владелец поправил архивную
 * запись и отменил правку — правки как будто не было, и последним остаётся всё то же отменённое
 * «добавить». Без пропуска признак гас бы от чужого отменённого действия, и поставка молча перестала бы
 * предлагать запись (новый ключ поставки 1в — Повестка — это делает достижимым). Отменённое ли
 * действие — та же проба `{type:'undo', undoes}`, что и у «добавления». Неотменённое не-«добавление» —
 * решение владельца: признака нет.
 *
 * Сама отмена нового действия журнала не порождает — запись отмены «действием» не является (К-22, API журнала
 * её не отдаёт), поэтому отменённое действие остаётся в журнале последним, пока его не перекроет новое. Порядок —
 * время записи журнала (время начала транзакции, `defaultNow`); действия владельца над одной записью идут
 * последовательно. Журнал читается API (`executor/journal-read.ts`, РП-9): «тронувшее запись» — действие, чьи
 * ОПЕРАЦИИ правили саму запись (`payload.id`), а не связь с ней.
 */
async function archivedByUndoneCreation(
  tx: Tx,
  graph: GraphId,
  ids: readonly string[],
): Promise<Set<string>> {
  const out = new Set<string>();
  for (const id of ids) {
    for (const action of await actionsOnEntity(tx, graph, id, UNDONE_WALK_DEPTH)) {
      const wasUndone = await isUndone(tx, graph, action.id);
      if (isAddition(action, id)) {
        if (wasUndone) out.add(id);
        break;
      }
      // Отменённая правка — как будто её не было: смотрим глубже. Неотменённая — решение владельца.
      if (!wasUndone) break;
    }
  }
  return out;
}

/**
 * «Добавление» записи (R-18): создание с её id (`entity_create`: сев, «добавить») или возврат из архива
 * механизмом `supply` (`entity_update {id, archived:false}` — «добавить» по записи, чей архив — откат прежнего
 * добавления). Возврат владельцем (механизм `user`) — его правка, не добавление.
 */
function isAddition(action: JournalEntry, id: string): boolean {
  if (action.operations.some((op) => op.op === 'entity_create' && op.payload.id === id)) {
    return true;
  }
  return (
    action.mechanism === 'supply' &&
    action.operations.some(
      (op) => op.op === 'entity_update' && op.payload.id === id && op.payload.archived === false,
    )
  );
}

/** Записи с ключом эталона (с архивными и без аспекта) и реестр — одной транзакцией чтения. */
async function snapshot(ctx: SupplyCtx): Promise<Snapshot> {
  const graph: GraphId = ctx.identity.graph;
  return withIdentity(ctx.db, ctx.identity, async (tx) => {
    const rows = await tx
      .select({
        id: entities.id,
        title: entities.title,
        emoji: entities.emoji,
        body: entities.body,
        aspects: entities.aspects,
        props: entities.props,
        archived: entities.archived,
        updatedAt: entities.updatedAt,
      })
      .from(entities)
      .where(and(eq(entities.graphId, graph), sql`${entities.props} ? ${SUPPLY_KEY}`));
    const reg = await effectiveRegistry(tx, graph);
    const undoneCreation = await archivedByUndoneCreation(
      tx,
      graph,
      rows.filter((r) => r.archived).map((r) => r.id),
    );
    return {
      rows: rows.map((r) => ({
        ...r,
        props: (r.props ?? {}) as Record<string, unknown>,
        updatedAt: r.updatedAt.toISOString(),
      })),
      reg,
      undoneCreation,
    };
  });
}

const keyOf = (r: SupplyRow): unknown => r.props[SUPPLY_KEY];
/** Запись поставки сейчас — несёт аспект «поставка» (R-17). */
const isSupply = (r: SupplyRow): boolean => r.aspects.includes(SUPPLY_ASPECT);
/** Живая запись ключа — с аспектом или без: по ней решается, есть ли у ключа запись вообще. */
const liveOf = (s: Snapshot, key: SupplyKeyValue): SupplyRow | undefined =>
  s.rows.find((r) => keyOf(r) === key && !r.archived);
/**
 * Ключ → id живой записи этого графа: ссылки оболочки ставятся только на живые записи. Снятый аспект
 * ссылку не отнимает: страница, выведенная из поставки, — всё та же страница владельца в навигации.
 */
const resolverOf =
  (s: Snapshot): ResolveSupplyKey =>
  (k) =>
    liveOf(s, k)?.id ?? null;

function etalonIn(etalons: readonly SupplyEtalon[], key: SupplyKey): SupplyEtalon {
  const e = etalons.find((x) => x.key === key);
  if (e === undefined) {
    throw new ExecError('VALIDATION', `эталона поставки с ключом «${key}» нет`, { key });
  }
  return e;
}

/** Нынешняя печать записи — та же, с которой `supplyStatusOf` сравнивает `supply_text`. */
function recordPrintOf(row: SupplyRow, key: SupplyKey): string {
  return etalonOf(key).kind === 'app'
    ? printAppProps({ title: row.title, emoji: row.emoji, props: row.props })
    : printPageRecord({ title: row.title, emoji: row.emoji, body: row.body });
}

/** id записей в ссылках места печати приложения (домашняя, навигация, «поверх»). */
function placeRefIds(print: ReturnType<typeof parseAppPrint>): Set<string> {
  const out = new Set<string>();
  for (const p of [APP_HOME, APP_NAV, APP_OPENS_OVER]) {
    const v = print.props[p];
    for (const x of Array.isArray(v) ? v : [v]) if (typeof x === 'string') out.add(x);
  }
  return out;
}

/**
 * Эталон приложения тот же, но в графе появилась запись его ключа, которой не было, когда эталон пришёл
 * (Fable I-1 задачи 9 среза 1в). Печать эталона В ГРАФЕ разрешает ключи в id живых записей
 * (`appEtalonProps` пропускает ключ без записи): оболочка, принятая ДО «Добавить: Повестка», легла с
 * навигацией без Повестки и отпечатком нового эталона — и без этой проверки после «Добавить» обновление
 * больше не предлагалось бы, §6.2 («Повестка на месте Upcoming») не наступал бы никогда.
 *
 * Только ПРИБАВЛЕНИЕ ссылки, не любое расхождение: запись, которую владелец отправил в архив, из печати в
 * графе выпадает (резолвер видит живые), и «обновление без неё» было бы предложением снять его раздел —
 * это его решение (R-16), не поставки. «Новые записи — отдельное решение» (§9.1 п. 2) не нарушается:
 * пункт появляется только ПОСЛЕ «Добавить».
 */
function gainedPlaceRef(s: Snapshot, row: SupplyRow, e: SupplyEtalon): boolean {
  if (e.kind !== 'app') return false;
  const stored = row.props[SUPPLY_TEXT];
  if (typeof stored !== 'string') return false;
  let had: Set<string>;
  try {
    had = placeRefIds(parseAppPrint(stored));
  } catch {
    // Битая печать в записи — не повод молча предлагать; её честно показывает «изменено вами».
    return false;
  }
  const now = placeRefIds(parseAppPrint(supplyTextOf(e, s.reg, resolverOf(s))));
  return [...now].some((id) => !had.has(id));
}

/** Пункт обновления по живой записи поставки или `null`, если предлагать нечего. */
function updateOf(s: Snapshot, row: SupplyRow, e: SupplyEtalon): SupplyUpdate | null {
  if (!isSupply(row)) return null;
  const hash = etalonHash(e);
  if (row.props[SUPPLY_HASH] === hash && !gainedPlaceRef(s, row, e)) return null;
  const declined = row.props[SUPPLY_DECLINED];
  // Отказ помнится до СЛЕДУЮЩЕГО эталона (§9.1 п. 2): отклонённый отпечаток не предлагается, иной — да.
  // «Оставить своё» у пункта «появилась запись эталона» пишет тот же отпечаток — и пункт уходит.
  if (declined === hash) return null;
  return {
    key: e.key,
    kind: 'update',
    recordId: row.id,
    edited: supplyStatusOf(row) === 'edited',
    declined: typeof declined === 'string',
    etalonText: supplyTextOf(e, s.reg, resolverOf(s)),
    recordText: recordPrintOf(row, e.key),
  };
}

/** Архивная запись ключа, которую «добавить» вернёт из архива: её архив — откат её же создания (R-18). */
function restorableOf(s: Snapshot, key: SupplyKey): SupplyRow | undefined {
  return s.rows.find(
    (r) => keyOf(r) === key && r.archived && isSupply(r) && s.undoneCreation.has(r.id),
  );
}

/** Что предлагает поставка этому графу. Ничего не пишет. */
export async function listUpdates(
  ctx: SupplyCtx,
  etalons: readonly SupplyEtalon[] = SUPPLY_ETALONS,
): Promise<SupplyUpdate[]> {
  const s = await snapshot(ctx);
  const out: SupplyUpdate[] = [];
  for (const e of etalons) {
    const all = s.rows.filter((r) => keyOf(r) === e.key);
    const live = all.find((r) => !r.archived);
    // Записи ключа нет — или её архив лишь откат «добавить» (R-18): поставка снова предлагает её.
    // Архив владельцем — его решение (Р-29): ни обновления, ни возврата. Живая запись без аспекта
    // «поставка» — выведена владельцем из поставки (R-17): ни обновлений, ни `new` для ключа.
    if (all.length === 0 || (live === undefined && restorableOf(s, e.key) !== undefined)) {
      out.push({
        key: e.key,
        kind: 'new',
        recordId: null,
        edited: false,
        declined: false,
        etalonText: supplyTextOf(e, s.reg, resolverOf(s)),
        recordText: null,
      });
      continue;
    }
    if (live === undefined) continue;
    const u = updateOf(s, live, e);
    if (u !== null) out.push(u);
  }
  return out;
}

/** Одна пачка исполнителя от имени владельца: одна запись журнала с подписью, один Undo. */
async function run(
  ctx: SupplyCtx,
  mechanism: MutationMechanism,
  label: string,
  operations: ExecOperation[],
): Promise<{ actionId: string }> {
  const r = await execute(
    ctx.db,
    {
      identity: ctx.identity,
      actorKind: 'owner',
      source: 'ui',
      mechanism,
      batchId: newId(),
      batchLabel: label,
      operations,
    },
    { sink },
  );
  if (!r.ok) throw new ExecError(r.error.code as ExecErrorCode, r.error.message, r.error.details);
  return { actionId: r.actionId };
}

/**
 * Операции «принять» для одной записи: содержимое = эталон кода, отпечаток и текст — новые, отказ снят.
 * У страницы тело сначала закрепляется версией «Прежняя версия» — порядок значим: закрепление снимает тело
 * ДО замены (§9.1 п. 2 «прежняя версия сохранится»). У приложения прежние свойства хранит журнал для Undo.
 */
function acceptOps(
  row: SupplyRow,
  e: SupplyEtalon,
  reg: RegistrySnapshot,
  resolve: ResolveSupplyKey,
): ExecOperation[] {
  const supply = { [SUPPLY_HASH]: etalonHash(e), [SUPPLY_TEXT]: supplyTextOf(e, reg, resolve) };
  const declined = typeof row.props[SUPPLY_DECLINED] === 'string' ? [SUPPLY_DECLINED] : [];
  if (e.kind === 'app') {
    const place = appEtalonProps(e, resolve);
    const dropped = APP_PRINT_PROPS.filter(
      (p) => row.props[p] !== undefined && place[p] === undefined,
    );
    const unset = [...dropped, ...declined];
    return [
      {
        tool: 'entity_update',
        input: {
          id: row.id,
          // Правка места с другой вкладки между чтением и «принять» не перекрывается молча: у тела это
          // держит `expectedUpdatedAt`, у свойств — предусловие на штамп записи (отказ `CONFLICT`).
          precondition: [{ property: 'orbis/updated_at', in: [row.updatedAt] }],
          title: e.title,
          emoji: e.emoji,
          props: { ...place, ...supply },
          ...(unset.length > 0 && { unset }),
        },
      },
    ];
  }
  return [
    { tool: 'entity_version_pin', input: { entity_id: row.id, label: PREVIOUS_VERSION_LABEL } },
    {
      tool: 'entity_update',
      input: {
        id: row.id,
        expectedUpdatedAt: row.updatedAt,
        title: e.title,
        emoji: e.emoji,
        body: e.text,
        props: supply,
        ...(declined.length > 0 && { unset: declined }),
      },
    },
  ];
}

function liveOrRefuse(s: Snapshot, key: SupplyKeyValue): SupplyRow {
  const row = liveOf(s, key);
  if (row === undefined) {
    throw new ExecError('NOT_FOUND', `записи поставки «${key}» нет`, { key });
  }
  if (!isSupply(row)) {
    throw new ExecError(
      'VALIDATION',
      'запись выведена из поставки: аспекта «поставка» на ней нет',
      {
        key,
        id: row.id,
      },
    );
  }
  return row;
}

/**
 * Шов гонки для тестов: вызывается между чтением записи и пачкой — там, где в бою успевает правка с другой
 * вкладки. Боевые вызовы его не передают.
 */
export interface RaceSeam {
  afterRead?: () => Promise<void>;
}

/** «Принять — прежняя версия сохранится» (§9.1 п. 2). Принять можно и отклонённое раньше. */
export async function acceptUpdate(
  ctx: SupplyCtx,
  key: SupplyKey,
  etalons: readonly SupplyEtalon[] = SUPPLY_ETALONS,
  seam: RaceSeam = {},
): Promise<{ actionId: string }> {
  const s = await snapshot(ctx);
  await seam.afterRead?.();
  const row = liveOrRefuse(s, key);
  const e = etalonIn(etalons, key);
  // «Обновления нет» — по тому же правилу, что список (`updateOf`): у приложения обновление бывает и при
  // равном отпечатке — появилась запись его ключа (Fable I-1).
  if (row.props[SUPPLY_HASH] === etalonHash(e) && !gainedPlaceRef(s, row, e)) {
    throw new ExecError('VALIDATION', 'обновления нет: запись уже с этим эталоном', { key });
  }
  return run(
    ctx,
    'supply',
    `Принять обновление поставки «${row.title}»`,
    acceptOps(row, e, s.reg, resolverOf(s)),
  );
}

/**
 * «Принять все» (§9.1 п. 2) — только записи, которые владелец не правил, одной пачкой (всё равно явное
 * действие). Новые записи поставки сюда не входят: «добавить» — отдельное решение по каждой.
 */
export async function acceptAll(
  ctx: SupplyCtx,
  etalons: readonly SupplyEtalon[] = SUPPLY_ETALONS,
): Promise<{ actionId: string | null; accepted: SupplyKey[] }> {
  const s = await snapshot(ctx);
  const resolve = resolverOf(s);
  const accepted: SupplyKey[] = [];
  const ops: ExecOperation[] = [];
  for (const e of etalons) {
    const row = liveOf(s, e.key);
    if (row === undefined) continue;
    const u = updateOf(s, row, e);
    if (u === null || u.edited) continue;
    accepted.push(e.key);
    ops.push(...acceptOps(row, e, s.reg, resolve));
  }
  if (accepted.length === 0) return { actionId: null, accepted };
  const { actionId } = await run(
    ctx,
    'supply',
    `Принять все обновления поставки (${accepted.length})`,
    ops,
  );
  return { actionId, accepted };
}

/** «Оставить своё» (§9.1 п. 2): отказ от ЭТОГО эталона — помнится, пока не придёт следующий. */
export async function declineUpdate(
  ctx: SupplyCtx,
  key: SupplyKey,
  etalons: readonly SupplyEtalon[] = SUPPLY_ETALONS,
): Promise<{ actionId: string }> {
  const s = await snapshot(ctx);
  const row = liveOrRefuse(s, key);
  const e = etalonIn(etalons, key);
  if (updateOf(s, row, e) === null) {
    throw new ExecError('VALIDATION', 'обновления нет: отказываться не от чего', { key });
  }
  return run(ctx, 'supply', `Оставить своё: «${row.title}»`, [
    { tool: 'entity_update', input: { id: row.id, props: { [SUPPLY_DECLINED]: etalonHash(e) } } },
  ]);
}

/**
 * «Вернуть как было» (§9.1 п. 4) — действие владельца механизмом `user`: содержимое записи = печать
 * эталона В ЗАПИСИ (`orbis/supply_text`), эталон записи не трогается. Прежнее тело страницы закрепляется
 * версией до замены; прежние свойства приложения хранит журнал для Undo. Диалог «какие разделы исчезнут»
 * у оболочки хоста — дело клиента (задача 22).
 *
 * Ключ — любой допустимый (`SupplyKeyValue`), в том числе снятый с поставки (срез 1в §6.3: Upcoming 1б):
 * возврату эталон кода не нужен — текст лежит в записи, род берётся из неё же.
 */
export async function revertToEtalon(
  ctx: SupplyCtx,
  key: SupplyKeyValue,
  expectedUpdatedAt?: string,
  seam: RaceSeam = {},
): Promise<{ actionId: string }> {
  const s = await snapshot(ctx);
  await seam.afterRead?.();
  const row = liveOrRefuse(s, key);
  // Версия, которую видел клиент (финал 1б, B1 m-3): диалог оболочки назвал исчезающие разделы по
  // ЕГО копии записи, и возврат поверх правки, пришедшей после (агент добавил раздел), снял бы то, чего
  // диалог не называл. Сверка — здесь и предусловием в пачке (гонка после чтения), как у «Принять».
  if (expectedUpdatedAt !== undefined && expectedUpdatedAt !== row.updatedAt) {
    throw new ExecError(
      'STALE_VERSION',
      'запись изменилась, пока был открыт диалог, — откройте «Вернуть как было» ещё раз',
      { key },
    );
  }
  const version = expectedUpdatedAt ?? row.updatedAt;
  const text = row.props[SUPPLY_TEXT];
  if (typeof text !== 'string') {
    throw new ExecError('VALIDATION', 'у записи нет текста эталона — возвращать не к чему', {
      key,
    });
  }
  if (supplyStatusOf(row) === 'etalon') {
    throw new ExecError('VALIDATION', 'запись и так как в поставке', { key });
  }
  const label = `Вернуть как было: «${row.title}»`;
  // Род печати — из САМОЙ записи (аспект «приложение»), не из эталона кода (1в §6.3, Д-13): у снятого
  // ключа эталона нет, а текст, к которому возвращаемся, — печать того рода, что у записи. У ключей с
  // эталоном это то же самое: приложение поставки — только оболочка, и она несёт аспект.
  if (row.aspects.includes(APP_ASPECT)) {
    const print = await withoutArchivedTargets(ctx, parseAppPrint(text));
    if (
      printAppProps({ title: row.title, emoji: row.emoji, props: row.props }) ===
      printAppProps(print)
    ) {
      throw new ExecError(
        'VALIDATION',
        'возвращать нечего: отличие от поставки — только записи в архиве',
        {
          key,
        },
      );
    }
    const unset = APP_PRINT_PROPS.filter(
      (p) => row.props[p] !== undefined && print.props[p] === undefined,
    );
    return run(ctx, 'user', label, [
      {
        tool: 'entity_update',
        input: {
          id: row.id,
          precondition: [{ property: 'orbis/updated_at', in: [version] }],
          title: print.title,
          emoji: print.emoji,
          props: print.props,
          ...(unset.length > 0 && { unset }),
        },
      },
    ]);
  }
  const print = parsePagePrint(text);
  const bodyChanged = row.body !== print.body;
  return run(ctx, 'user', label, [
    // Версия — только когда тело и правда меняется: снимок, равный телу эталона, ничего не сберегает.
    ...(bodyChanged
      ? [
          {
            tool: 'entity_version_pin',
            input: { entity_id: row.id, label: PREVIOUS_VERSION_LABEL },
          },
        ]
      : []),
    {
      tool: 'entity_update',
      input: {
        id: row.id,
        title: print.title,
        emoji: print.emoji,
        ...(bodyChanged && { body: print.body, expectedUpdatedAt: version }),
      },
    },
  ]);
}

/**
 * Ссылки места без архивных и несуществующих целей (R-16): печать эталона хранит id записей на момент,
 * когда эталон пришёл, а исполнитель отказывает всему ссылочному значению с архивной целью («цель
 * архивна»). Владелец, заархивировавший страницу из навигации, получает навигацию эталона без неё — и
 * запись честно остаётся «изменено вами», пока страница в архиве.
 */
async function withoutArchivedTargets(
  ctx: SupplyCtx,
  print: ReturnType<typeof parseAppPrint>,
): Promise<ReturnType<typeof parseAppPrint>> {
  const refs = [APP_HOME, APP_NAV, APP_OPENS_OVER];
  const ids = refs.flatMap((p) => {
    const v = print.props[p];
    return typeof v === 'string'
      ? [v]
      : Array.isArray(v)
        ? v.filter((x) => typeof x === 'string')
        : [];
  });
  if (ids.length === 0) return print;
  const live = await withIdentity(ctx.db, ctx.identity, (tx) =>
    tx
      .select({ id: entities.id })
      .from(entities)
      .where(
        and(
          eq(entities.graphId, ctx.identity.graph),
          inArray(entities.id, ids),
          eq(entities.archived, false),
        ),
      ),
  );
  const alive = new Set(live.map((r) => r.id));
  const props: Record<string, unknown> = { ...print.props };
  for (const p of refs) {
    const v = props[p];
    if (typeof v === 'string' && !alive.has(v)) delete props[p];
    if (Array.isArray(v)) {
      const kept = v.filter((x) => typeof x === 'string' && alive.has(x));
      if (kept.length > 0) props[p] = kept;
      else delete props[p];
    }
  }
  return { ...print, props };
}

/**
 * «Добавить» (§9.1 п. 3): новая запись поставки в существующем графе — только по слову владельца. Живая
 * запись ключа — отказ. Архивная: если её архив — откат её же «добавить» (R-18), запись возвращается из
 * архива тем же действием, а не создаётся вторая; архив владельцем — отказ (Р-29: его решение).
 */
export async function addSupplyRecord(
  ctx: SupplyCtx,
  key: SupplyKey,
  etalons: readonly SupplyEtalon[] = SUPPLY_ETALONS,
): Promise<{ actionId: string }> {
  const s = await snapshot(ctx);
  const restorable = liveOf(s, key) === undefined ? restorableOf(s, key) : undefined;
  if (restorable !== undefined) {
    return run(ctx, 'supply', `Добавить из поставки: «${restorable.title}»`, [
      { tool: 'entity_update', input: { id: restorable.id, archived: false } },
    ]);
  }
  const existing = s.rows.find((r) => keyOf(r) === key);
  if (existing !== undefined) {
    throw new ExecError(
      'VALIDATION',
      existing.archived ? 'запись поставки этого ключа в архиве' : 'запись поставки уже есть',
      { key, id: existing.id },
    );
  }
  const e = etalonIn(etalons, key);
  return run(
    ctx,
    'supply',
    `Добавить из поставки: «${e.title}»`,
    supplyCreateOps(ctx.identity.graph, [key], resolverOf(s), s.reg, etalons),
  );
}
