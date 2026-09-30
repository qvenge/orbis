// apps/server/src/executor/body-chain.ts
// Единое правило отмены правки текста (спека скорости §8.6, К-12, К-18, К-21, К-30; решение владельца Р-15) — одним
// местом. Отмена, чьи данные отмены ПИШУТ ТЕЛО записи, возвращает текст, только если действующее действие текущего тела
// (колонка `body_action_id` с раскруткой через записи отмены) — это самое отменяемое действие; иначе отказывает ВСЁ
// действие с перечнем записей и местом продолжения «Всё равно отменить».
//
// Что здесь, а что у исполнителя. Здесь — раскрутка цепочки (`effectiveBodyAction`), какие записи отмена касается
// (`bodyEntitiesOf`), проверка под замками строк (`bodyRuleFailures`), сам отказ (`UndoTextChangedError`) и правило
// целиком (`assertUndoTextRule`) — его executor зовёт ОДНИМ вызовом в начале каждой транзакции отмены (одиночный путь и
// пачка), после `beforeStages` и advisory-замков. У `applyUndo` (`undo.ts`) — закрепления версий первыми операциями
// записи отмены (страховка сеанса и продолжение). Действующее действие для экрана записи — `bodyActionOf` (§8.2, К-37).
import type {
  BodyActionInfo,
  GraphId,
  UndoConflictEntry,
  UndoTextChangedDetails,
} from '@orbis/shared';
import { and, eq } from 'drizzle-orm';
import { agentGrants, entities } from '../db/schema';
import type { Tx } from '../db/with-identity';
import type { Identity } from '../identity';
import { ExecError } from './errors';
import {
  findAction,
  isUndone,
  type JournalEntry,
  liveActionOf,
  undoRecordById,
} from './journal-read';
import { sessionSpan } from './text-session';
import type { InternalUndoMode } from './types';

type EntityRow = typeof entities.$inferSelect;

/**
 * Предел раскрутки: цепочка живого графа короче (каждый шаг — запись отмены в истории этой записи), а цикл возможен
 * только в повреждённых данных — тогда действующее действие неизвестно (`null`), и проверка честно отказывает.
 */
const MAX_HOPS = 64;

/** Подпись актора текста, у которого нет записи журнала: ops-скрипт, сев, перенос (колонка пуста, К-19, К-34). */
export const OUTSIDE_APP_LABEL = 'вне приложения';

// Проверка с раскруткой (§8.6, К-18): отмена действия X возвращает текст записи, только если ДЕЙСТВУЮЩЕЕ действие
// текущего тела равно X. Берётся колонка; пока она указывает на запись отмены U, вместо неё берётся «действие тела до»
// у действия, которое U отменила. Так проходят «B2 отменено → отменяем B1», второй шаг «отмени последнее», возврат к
// более раннему сеансу, а чужая правка (человек, агент, ops-скрипт с пустой колонкой) проверку останавливает.
export async function effectiveBodyAction(
  tx: Tx,
  graph: GraphId,
  entityId: string,
  raw: string | null,
): Promise<string | null> {
  let cur = raw;
  for (let hops = 0; cur !== null && hops < MAX_HOPS; hops++) {
    const undo = await undoRecordById(tx, graph, cur); // journal-read: строка type='undo' по её id
    if (!undo) {
      // Действие, отменённое записью, которая текст не сменила (inverse дал тот же текст), колонку не двигает (триггер
      // IS DISTINCT FROM) — действующим оно не является: раскручиваем его, как запись отмены.
      // Только для СЫРОЙ колонки (hops === 0) — случай сеанса с нулевым итогом; в середине цепочки текущий текст мог
      // вернуть inverse другой записи (продолжение X при чужой Y), и прыжок через отменённое X пропустил бы чужую правку.
      if (hops > 0 || !(await isUndone(tx, graph, cur))) return cur; // действующее действие
      const own = await findAction(tx, graph, cur);
      if (!own?.bodyBefore || !(entityId in own.bodyBefore)) return null;
      cur = own.bodyBefore[entityId] ?? null;
      continue;
    }
    const undone = await findAction(tx, graph, undo.undoes as string);
    if (!undone?.bodyBefore || !(entityId in undone.bodyBefore)) return null; // перенесённая: цепочку не восстановить
    cur = undone.bodyBefore[entityId] ?? null;
  }
  // Сюда доходят пустая колонка (`cur === null`) и превышение предела (повреждённые данные) — действующего нет
  return null;
}

/**
 * Записи, чьё тело отмена действия ПИШЕТ (§8.6 «Кого касается»): ключи «действия тела до» — ровно записи, чью ревизию
 * действие сдвинуло (задача 7), у слияния свойства — каждый держатель. Отмена создания (архив) и прочие отмены без тела
 * ключей не несут и правилу не подлежат.
 *
 * Перенесённая запись журнала (до плана А, `bodyBefore === null`) цепочки не несёт — её записи с телом видны только по
 * данным отмены: `entity_update` с `body`/`bodyDoc` и держатели отката слияния (`property_merge_undo.bodies`).
 */
export function bodyEntitiesOf(action: JournalEntry): string[] {
  if (action.bodyBefore !== null) return Object.keys(action.bodyBefore);
  const out = new Set<string>();
  for (const op of action.inverse) {
    const p = op.payload;
    if (
      op.op === 'entity_update' &&
      typeof p.id === 'string' &&
      (p.body !== undefined || p.bodyDoc !== undefined)
    ) {
      out.add(p.id.toLowerCase());
    }
    if (op.op === 'property_merge_undo' && Array.isArray(p.bodies)) {
      for (const b of p.bodies as Array<{ entityId?: unknown }>) {
        if (typeof b?.entityId === 'string') out.add(b.entityId.toLowerCase());
      }
    }
  }
  return [...out];
}

/**
 * Записи из `entityIds`, у которых проверка §8.6 для отмены `undoing` НЕ проходит, — с актором и временем правки,
 * остановившей проверку. Перенесённая запись журнала (`bodyBefore === null`) проходит, только если сырая колонка равна
 * ей самой (§8.6 «Записи до плана А»).
 *
 * `lock` (умолчание) — строки `FOR UPDATE`: так проверяет правило в транзакции отмены — проверка и применение видят один
 * и тот же текст, порядок захвата — по id (две отмены, задевшие одни записи, берут замки одним порядком), и захват идёт
 * после advisory-замков исполнителя. Предпроверка продолжения (`applyUndo`) читает БЕЗ замка: её вывод перепроверяет
 * правило под замком, а строковый замок в отдельной транзакции вне порядка «advisory → строки» только заводил бы класс
 * взаимных блокировок с правками пачкой.
 */
export async function bodyRuleFailures(
  tx: Tx,
  graph: GraphId,
  undoing: JournalEntry,
  entityIds: string[],
  opts: { lock: boolean } = { lock: true },
): Promise<UndoConflictEntry[]> {
  const failures: UndoConflictEntry[] = [];
  for (const entityId of [...new Set(entityIds.map((id) => id.toLowerCase()))].sort()) {
    const query = tx
      .select({
        title: entities.title,
        bodyActionId: entities.bodyActionId,
        bodyChangedAt: entities.bodyChangedAt,
      })
      .from(entities)
      .where(and(eq(entities.graphId, graph), eq(entities.id, entityId)));
    const rows = opts.lock ? await query.for('update') : await query;
    const row = rows[0];
    // Записи не видно (RLS, чужой граф) — проверять нечего: обратная операция по ней откажет сама (NOT_FOUND)
    if (row === undefined) continue;
    const raw = row.bodyActionId;
    const effective = await effectiveBodyAction(tx, graph, entityId, raw);
    const passes = undoing.bodyBefore === null ? raw === undoing.id : effective === undoing.id;
    if (!passes) failures.push(await conflictEntry(tx, graph, undoing, entityId, row, effective));
  }
  return failures;
}

/**
 * Строка перечня отказа: кто и когда дал текущий текст. Действующее действие с записью журнала — её актор; время — время
 * изменения тела, пока колонка указывает на него (сеанс правки текста длится после своей записи), иначе время записи.
 * Без записи журнала (пустая колонка, цепочка оборвана переносом) — «вне приложения» и время изменения тела.
 *
 * Раскрутка, ушедшая ЗА отменяемое действие (к тексту, который был до него, или к писателю без журнала), при записи
 * отмены в колонке значит: текст после отменяемого действия сменила эта отмена (продолжение по более раннему действию,
 * К-30). Называется она — владелец и время изменения тела, а не автор старого текста (гейт задачи 10, M-3).
 */
async function conflictEntry(
  tx: Tx,
  graph: GraphId,
  undoing: JournalEntry,
  entityId: string,
  row: Pick<EntityRow, 'title' | 'bodyActionId' | 'bodyChangedAt'>,
  effective: string | null,
): Promise<UndoConflictEntry> {
  const by = effective === null ? undefined : await findAction(tx, graph, effective);
  const beyond = by === undefined || by.createdAt.getTime() < undoing.createdAt.getTime();
  if (beyond && row.bodyActionId !== null && row.bodyActionId !== effective) {
    const undo = await undoRecordById(tx, graph, row.bodyActionId);
    if (undo !== undefined) {
      return {
        entityId,
        title: row.title,
        actorKind: undo.actorKind,
        actorLabel: null,
        at: row.bodyChangedAt.toISOString(),
      };
    }
  }
  if (by === undefined) {
    return {
      entityId,
      title: row.title,
      actorKind: 'owner',
      actorLabel: OUTSIDE_APP_LABEL,
      at: row.bodyChangedAt.toISOString(),
    };
  }
  return {
    entityId,
    title: row.title,
    actorKind: by.actorKind,
    actorLabel: await actorLabelOf(tx, graph, by),
    at: (row.bodyActionId === by.id ? row.bodyChangedAt : by.createdAt).toISOString(),
  };
}

/** Подпись агента без названного гранта (грант снят или запись до атрибуции грантом). */
export const AGENT_LABEL = 'агент';

/**
 * Подпись актора строки перечня: у агента — подпись его гранта (какой именно агент дал текст — §8.6 «с актором», строка
 * агента `mcp`, Р-16), без гранта — «агент». Владельцу и ассистенту подпись не нужна: клиент называет их по `actorKind`.
 */
async function actorLabelOf(tx: Tx, graph: GraphId, by: JournalEntry): Promise<string | null> {
  if (by.actorKind !== 'agent') return null;
  if (by.actorGrantId === undefined) return AGENT_LABEL;
  const rows = await tx
    .select({ label: agentGrants.label })
    .from(agentGrants)
    .where(and(eq(agentGrants.graphId, graph), eq(agentGrants.id, by.actorGrantId)));
  return rows[0]?.label ?? AGENT_LABEL;
}

/**
 * Отказ правила отмены текста (§8.6, Р-15): «текст изменён после этой правки» — отказ ВСЕГО действия (К-21) с перечнем
 * записей и местом продолжения. Код — `UNDO_TEXT_CHANGED` (409), детали уходят клиенту каналом `data.orbis`.
 */
export class UndoTextChangedError extends ExecError {
  declare readonly details: UndoTextChangedDetails;

  constructor(details: UndoTextChangedDetails) {
    super(
      'UNDO_TEXT_CHANGED',
      `текст изменён после этой правки (записей: ${details.entries.length}) — отмена не применена; ` +
        '«Всё равно отменить» закрепит текущий текст версией (§8.6)',
      details,
    );
    this.name = 'UndoTextChangedError';
  }
}

/**
 * Единое правило отмены текста (§8.6) — ОДНО место для всех путей: одиночная отмена, «отмени последнее», карточка,
 * откат прогона, отмена пачки, поставки, слияния, возврат сеанса. Executor зовёт его в начале каждой транзакции отмены —
 * после `beforeStages` (отказ «отклонено» карточки отката — раньше правила) и advisory-замков (правило берёт строки
 * `FOR UPDATE`, а порядок «advisory → строки» глобален), до стадий. Отказ — всего действия (К-21): частичной отмены нет,
 * признак «отменено» — само наличие записи отмены (PRD §7.8).
 *
 * Без продолжения любой провал останавливает всё (закрепление страховки сеанса продолжением НЕ является). С
 * продолжением отмена проходит, только если каждая провалившая запись закреплена первой операцией этой записи отмены:
 * закрепляются записи, провалившие ПРЕДПРОВЕРКУ, и запись, провалившая проверку только к транзакции, — гонка: отказ с
 * новым перечнем, человек жмёт продолжение ещё раз.
 */
export async function assertUndoTextRule(
  tx: Tx,
  graph: GraphId,
  undo: InternalUndoMode,
): Promise<void> {
  const failures = await bodyRuleFailures(tx, graph, undo.undoing, bodyEntitiesOf(undo.undoing));
  if (failures.length > 0 && (!undo.force || failures.some((f) => !undo.pinned.has(f.entityId)))) {
    // Конкурентная отмена ТОГО ЖЕ действия, закоммиченная, пока эта ждала замков строк, сама сдвинула колонки: отказ
    // здесь — «уже отменено», а не «текст изменён» с кнопкой, которая отменила бы отменённое ещё раз (гейт M-2)
    if (await isUndone(tx, graph, undo.undoing.id)) {
      throw new ExecError('VALIDATION', `действие ${undo.undoing.id} уже отменено`, {
        actionId: undo.undoing.id,
        reason: 'already_undone',
      });
    }
    throw new UndoTextChangedError({
      action: { id: undo.undoing.id, title: undo.undoing.title },
      entries: failures,
      continuation: undo.continuation,
    });
  }
}

/**
 * Действующее действие текущего тела записи для ответа (§8.2 «ответы с записью», К-37): раскрученная колонка → запись
 * журнала → признак сеанса, «моё ли» (этот же человек-владелец — ему пункт «Вернуть текст как на …»), актор и отрезок
 * (конец — только пока колонка указывает на само действие, `sessionSpan`). Нет действующего действия или его записи —
 * `null`: текст дал писатель без журнала или цепочка оборвана переносом.
 *
 * `live` — ЖИВОЕ действие колонки (не запись отмены и не отменённое): у него раскрутка не нужна — `effectiveBodyAction`
 * вернул бы саму колонку. Прочитано вызывающим вместе с колонками (`bodyColumnProbe`) — берётся как есть; `null` —
 * вызывающий уже знает, что живого нет (сразу раскрутка); не передано — одним запросом (`liveActionOf`). Так чтение
 * записи и ответ правки платят одним запросом, раскрутка — только у записи отмены в колонке.
 */
export async function bodyActionOf(
  tx: Tx,
  who: Identity,
  row: Pick<EntityRow, 'id' | 'bodyActionId' | 'bodyChangedAt'>,
  live?: JournalEntry | null,
): Promise<BodyActionInfo | null> {
  if (row.bodyActionId === null) return null;
  let entry =
    live === undefined
      ? await liveActionOf(tx, who.graph, row.bodyActionId)
      : live !== null && live.id === row.bodyActionId
        ? live
        : undefined;
  if (entry === undefined) {
    const actionId = await effectiveBodyAction(tx, who.graph, row.id, row.bodyActionId);
    if (actionId === null) return null;
    entry = await findAction(tx, who.graph, actionId);
    if (entry === undefined) return null;
  }
  return bodyActionInfo(entry, who, row);
}

/** Ответ о действии тела по его записи журнала и колонкам записи графа — одна форма для всех путей (§8.2). */
export function bodyActionInfo(
  entry: JournalEntry,
  who: Identity,
  row: Pick<EntityRow, 'bodyActionId' | 'bodyChangedAt'>,
): BodyActionInfo {
  const span = sessionSpan(entry, row);
  return {
    actionId: entry.id,
    textSession: entry.textSession,
    mine: entry.actorUserId === who.actor && entry.actorKind === 'owner',
    actorKind: entry.actorKind,
    startedAt: span.start.toISOString(),
    endedAt: span.end === null ? null : span.end.toISOString(),
  };
}

/** Потолок подписи закреплённой версии — тот же, что у входа закрепления (`entity_version_pin`, `version.pin`). */
export const VERSION_LABEL_MAX = 200;

/**
 * Подпись версии в потолке: страховки («перед восстановлением: …», «перед отменой: …», «перед возвратом к ЧЧ:ММ»)
 * несут чужую подпись или заголовок и могут его превысить — закрепление отказало бы разбором, а с ним и всё действие.
 * Потолок меряется UTF-16 единицами (`z.string().max`), режется по КОДОВЫМ ТОЧКАМ: срез посреди суррогатной пары
 * (эмодзи на границе) оставил бы одиночный суррогат. Пробелы по краям снимаются заранее — вход закрепления их срезает
 * (`trim`), и подпись в ответе разошлась бы с записанной.
 */
export function versionLabel(text: string): string {
  const full = text.trim();
  if (full.length <= VERSION_LABEL_MAX) return full;
  let cut = '';
  for (const ch of full) {
    if (cut.length + ch.length > VERSION_LABEL_MAX - 1) break;
    cut += ch;
  }
  return `${cut}…`;
}
