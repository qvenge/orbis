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
import {
  type GraphId,
  newId,
  SUPPLY_DECLINED,
  SUPPLY_HASH,
  SUPPLY_KEY,
  SUPPLY_TEXT,
} from '@orbis/shared';
import {
  APP_PRINT_PROPS,
  etalonOf,
  parseAppPrint,
  parsePagePrint,
  SUPPLY_ETALONS,
  type SupplyEtalon,
  type SupplyKey,
  supplyStatusOf,
} from '@orbis/shared/supply';
import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { entities } from '../db/schema';
import { withIdentity } from '../db/with-identity';
import { ExecError, type ExecErrorCode } from '../errors';
import { execute } from '../executor/executor';
import { makeChatJournalSink } from '../executor/journal';
import type { MutationMechanism } from '../executor/types';
import type { Identity } from '../identity';
import { effectiveRegistry } from '../registry/cache';
import type { RegistrySnapshot } from '../registry/load';
import type { ExecOperation } from '../routines/propose';
import { etalonHash } from './hash';
import { appEtalonProps, type ResolveSupplyKey, supplyCreateOps, supplyTextOf } from './records';

const sink = makeChatJournalSink();

/** Подпись закреплённой версии тела перед заменой (§9.1 п. 2 «прежняя версия сохранится», п. 4). */
export const PREVIOUS_VERSION_LABEL = 'Прежняя версия';

export interface SupplyCtx {
  db: Db;
  identity: Identity;
}

/**
 * Пункт «Обновлений» (§9.1 п. 2–3). `update` — у живой записи ключа отпечаток не тот, что у эталона кода, и
 * владелец от этого эталона не отказывался; `new` — записи ключа нет вовсе (ни живой, ни в архиве).
 * `edited` — запись правлена владельцем («Принять все» её не берёт). `declined` — владелец отказывался от
 * ПРЕЖНЕГО эталона этой записи (отказ от нынешнего пункт убирает совсем): плашка может сказать «вы уже
 * оставляли своё — вот ещё более новый эталон».
 */
export interface SupplyUpdate {
  key: SupplyKey;
  kind: 'update' | 'new';
  recordId: string | null;
  edited: boolean;
  declined: boolean;
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
}

/** Записи поставки графа (с архивными) и реестр — одной транзакцией чтения. */
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
    return {
      rows: rows.map((r) => ({
        ...r,
        props: (r.props ?? {}) as Record<string, unknown>,
        updatedAt: r.updatedAt.toISOString(),
      })),
      reg,
    };
  });
}

const keyOf = (r: SupplyRow): unknown => r.props[SUPPLY_KEY];
const liveOf = (s: Snapshot, key: SupplyKey): SupplyRow | undefined =>
  s.rows.find((r) => keyOf(r) === key && !r.archived);
/** Ключ → id живой записи этого графа: ссылки оболочки ставятся только на живые записи. */
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

/** Пункт обновления по живой записи или `null`, если предлагать нечего. */
function updateOf(row: SupplyRow, e: SupplyEtalon): SupplyUpdate | null {
  const hash = etalonHash(e);
  if (row.props[SUPPLY_HASH] === hash) return null;
  const declined = row.props[SUPPLY_DECLINED];
  // Отказ помнится до СЛЕДУЮЩЕГО эталона (§9.1 п. 2): отклонённый отпечаток не предлагается, иной — да.
  if (declined === hash) return null;
  return {
    key: e.key,
    kind: 'update',
    recordId: row.id,
    edited: supplyStatusOf(row) === 'edited',
    declined: typeof declined === 'string',
  };
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
    if (all.length === 0) {
      out.push({ key: e.key, kind: 'new', recordId: null, edited: false, declined: false });
      continue;
    }
    // Запись ключа только в архиве — владелец её убрал; поставка не предлагает ни обновить её, ни
    // вернуть (Р-29): архив — его решение.
    const live = all.find((r) => !r.archived);
    if (live === undefined) continue;
    const u = updateOf(live, e);
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

function liveOrRefuse(s: Snapshot, key: SupplyKey): SupplyRow {
  const row = liveOf(s, key);
  if (row === undefined) {
    throw new ExecError('NOT_FOUND', `записи поставки «${key}» нет`, { key });
  }
  return row;
}

/** «Принять — прежняя версия сохранится» (§9.1 п. 2). Принять можно и отклонённое раньше. */
export async function acceptUpdate(
  ctx: SupplyCtx,
  key: SupplyKey,
  etalons: readonly SupplyEtalon[] = SUPPLY_ETALONS,
): Promise<{ actionId: string }> {
  const s = await snapshot(ctx);
  const row = liveOrRefuse(s, key);
  const e = etalonIn(etalons, key);
  if (row.props[SUPPLY_HASH] === etalonHash(e)) {
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
    const u = updateOf(row, e);
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
  if (updateOf(row, e) === null) {
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
 */
export async function revertToEtalon(
  ctx: SupplyCtx,
  key: SupplyKey,
): Promise<{ actionId: string }> {
  const s = await snapshot(ctx);
  const row = liveOrRefuse(s, key);
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
  // Род печати — по ключу эталона, как у `supplyStatusOf`.
  if (etalonOf(key).kind === 'app') {
    const print = parseAppPrint(text);
    const unset = APP_PRINT_PROPS.filter(
      (p) => row.props[p] !== undefined && print.props[p] === undefined,
    );
    return run(ctx, 'user', label, [
      {
        tool: 'entity_update',
        input: {
          id: row.id,
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
        ...(bodyChanged && { body: print.body, expectedUpdatedAt: row.updatedAt }),
      },
    },
  ]);
}

/**
 * «Добавить» (§9.1 п. 3): новая запись поставки в существующем графе — только по слову владельца. Запись
 * ключа уже есть (живая или в архиве) — отказ: архив — решение владельца, поставка его не отменяет.
 */
export async function addSupplyRecord(
  ctx: SupplyCtx,
  key: SupplyKey,
  etalons: readonly SupplyEtalon[] = SUPPLY_ETALONS,
): Promise<{ actionId: string }> {
  const s = await snapshot(ctx);
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
