// apps/server/src/agent-loop/rollback.ts
// Откат прогона (С12, инвариант 7): «отменить в Orbis всё, что сделал этот прогон».
// Нового механизма отмены здесь НЕТ — работу делает существующий Undo §7.8
// (executor/undo.ts) по действиям прогона в обратном порядке; собственных INSERT/UPDATE
// в графе этот файл не выполняет, только SELECT по журналу.
//
// Зачем поверх Undo нужна ПРЕДПРОВЕРКА. Undo — осознанный LWW-откат: он восстанавливает
// зафиксированное в журнале прежнее состояние ПОВЕРХ текущего, не спрашивая, менялось ли
// оно с тех пор (обоснование — докблок `InternalUndoMode` в executor/types.ts: body-патчи
// идут без expectedUpdatedAt, аспект-ключи восстанавливаются целиком). Для ОДНОГО «отмени
// последнее» это правильно — человек отменяет то, что только что видел. Для отката целого
// прогона — нет: между концом прогона и нажатием кнопки владелец мог ответить на чекпойнт
// или переставить статус руками, и серия LWW-отмен стёрла бы его решение молча. Ровно это
// запрещает инвариант 7 («откат не затирает чужие изменения — при расхождении показывает
// конфликт»), поэтому расхождение ищется ДО первой отмены и отдаётся списком.
//
// Почему серия НЕ атомарна. Undo одного действия — одна транзакция (undoAction открывает
// свою), и склеить их в одну нечем: internal-режим executor'а принимает `Db`, а не `Tx`.
// Общий откат — обещание уровня UX, а не инвариант БД: если серия встанет на середине,
// вызывающий получает `partial` со списком уже отменённого и адресом отказа, а граф
// остаётся в понятном промежуточном состоянии (часть действий отменена, остальные — нет),
// которое чинится повторным вызовом. Прятать это за «атомарно» было бы враньём.
import { sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { type Tx, withIdentity } from '../db/with-identity';
import type { ActionOperation, ActionRecord } from '../executor/types';
import { isUndone, undoAction } from '../executor/undo';
import type { RollbackConflict, WireRollbackResult } from '../wire';

/**
 * Постоянный текст успешного отката (С12). Именно постоянный, а не собранный по факту:
 * граница «Orbis откатили, git не трогали» — свойство механизма, а не этого прогона, и
 * человек должен читать её одинаково после каждого отката.
 */
export const ROLLBACK_NOTE =
  'Откачены изменения в Orbis (статусы тикета, прогон). ' +
  "Ветку и коммиты в репозитории откат не трогает — откатывайте их git'ом.";

/** Запись журнала: сам action + отметка времени и id сообщения (ключ порядка). */
interface JournalEntry {
  messageId: string;
  at: Date;
  action: ActionRecord;
}

/**
 * timestamptz из raw-SQL: drizzle отключает date-парсеры postgres.js, поэтому tx.execute
 * отдаёт строку PG (то же приведение, что в wire.ts).
 */
function toDate(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value));
}

/**
 * Строка журнала → запись. Инвариант §7.8 «один action на audit-сообщение» (journal.ts
 * проверяет его на записи) — читаем `actions[0]`, как undo.ts.
 */
function toEntry(row: Record<string, unknown>): JournalEntry | undefined {
  const metadata = row.metadata as { actions?: ActionRecord[] };
  const action = metadata.actions?.[0];
  if (action === undefined) return undefined; // недостижимо: отбор требует непустой actions
  return { messageId: String(row.id), at: toDate(row.created_at), action };
}

/**
 * Что считается действием ПРОГОНА — и что нарочно не считается.
 *
 * `source: 'ui'` отсеивается, и это не мелочь: ответ владельца на чекпойнт тоже несёт
 * `run_id` (он про этот прогон и стоит рядом с вопросом на экране), но это ЕГО решение,
 * а не работа исполнителя. Считать его действием прогона значило бы молча снимать его
 * откатом — ровно то, что запрещает инвариант 7. Он остаётся чужим изменением и виден
 * конфликтом (шаг 3).
 *
 * Работа исполнителя — `source: 'mcp'`, обслуживание круга (подметание С6) — `'system'`.
 * Последнее откатывается вместе с прогоном намеренно: «отмени последнее» подметание
 * пропускает (undo.ts findLastUndoable), и без него брошенный прогон не откатился бы
 * целиком — тикет остался бы с чужим `waiting_for` о разборе остатков.
 */
function isRunAction(action: ActionRecord, runId: string): boolean {
  return action.run_id === runId && action.source !== 'ui';
}

/**
 * Действия прогона в порядке журнала (шаг 1). Обратная ссылка `run_id` — containment-проба
 * `metadata @> {"actions":[{"run_id": …}]}`: единственная форма, которую берёт GIN
 * `jsonb_path_ops` (0001_rls_and_indexes.sql:123, проверено EXPLAIN — Bitmap Index Scan по
 * chat_messages_metadata_gin). `metadata ? 'actions'` этим индексом НЕ покрыт.
 *
 * Тай-брейк по `id` обязателен: колонка created_at — precision 3, и два действия одной
 * миллисекунды без второго ключа встали бы в порядке, который выбрал план. Идиома та же,
 * что в undo.ts (`ORDER BY created_at DESC, id DESC`). Полной строгости это не даёт — id
 * batch-действия детерминирован (uuidv5 от batch_id), а не возрастает во времени, — но два
 * глагола ОДНОГО прогона в одну миллисекунду означали бы, что агент выпустил их
 * параллельно, а этого не допускает CAS-счётчик шагов (verbs.ts runStep).
 */
async function runActions(tx: Tx, runId: string): Promise<JournalEntry[]> {
  const probe = JSON.stringify({ actions: [{ run_id: runId }] });
  const rows = await tx.execute(
    sql`SELECT id, created_at, metadata FROM chat_messages
        WHERE metadata @> ${probe}::jsonb
        ORDER BY created_at ASC, id ASC`,
  );
  const entries: JournalEntry[] = [];
  for (const row of rows as unknown as Array<Record<string, unknown>>) {
    const entry = toEntry(row);
    if (entry !== undefined && isRunAction(entry.action, runId)) entries.push(entry);
  }
  return entries;
}

/** uuid-подобные значения payload'а операции: что именно тронуло действие. */
const TOUCHED_KEYS = ['id', 'source_id', 'target_id', 'entity_id'] as const;

/**
 * Сущности, затронутые действиями (шаг 2). Берём id из ОБЕИХ половин записи — операций и
 * inverse: у entity_create операция несёт id новой сущности, а inverse — её же под
 * архивацию, но у relation-операций id связи в payload'е нет вовсе, зато есть концы
 * (`source_id`/`target_id`). Отсюда широкий набор ключей: конфликт по связи — тоже
 * конфликт, и лучше показать лишнюю строку, чем молча затереть правку соседа.
 */
function touchedEntities(entries: readonly JournalEntry[]): Set<string> {
  const touched = new Set<string>();
  for (const entry of entries) {
    for (const op of [...entry.action.operations, ...entry.action.inverse]) {
      for (const id of operationIds(op)) touched.add(id);
    }
  }
  return touched;
}

function operationIds(op: ActionOperation): string[] {
  const ids: string[] = [];
  for (const key of TOUCHED_KEYS) {
    const value = op.payload[key];
    if (typeof value === 'string') ids.push(value);
  }
  return ids;
}

/**
 * Чужие неотменённые действия ПОЗЖЕ последнего действия прогона по тем же сущностям
 * (шаг 3). Отбор — по составному курсору `(created_at, id) > (…)`, тем же ключом, что
 * и порядок шага 1: `created_at > tLast` пропустил бы действие той же миллисекунды, а
 * при precision 3 это не гипотетический случай.
 *
 * Containment `{"actions": []}` + непустая длина — тот же приём, что в undo.ts
 * findLastUndoable: он отсекает undo-сообщения и обычную переписку (у них нет `actions`).
 * Индексом он, в отличие от пробы шага 1, НЕ берётся (пустой контейнер не даёт ключей
 * jsonb_path_ops) — сужает здесь курсор по created_at (EXPLAIN: Index Scan по
 * chat_messages_thread_created), а containment остаётся фильтром. Этого достаточно:
 * позже последнего действия прогона у владельца лежит хвост журнала, а не весь журнал.
 * Действия ЭТОГО прогона отсеиваются ТЕМ ЖЕ предикатом, что отбирал их на шаге 1
 * (`isRunAction`), — они и есть то, что мы собрались отменять. Предикат, а не голое
 * сравнение run_id: ответ владельца на чекпойнт тоже несёт run_id, и по голому сравнению
 * он молча выпал бы из конфликтов, то есть был бы снят откатом (инвариант 7).
 * Уже отменённые чужие — не конфликт: их эффекта в графе больше нет.
 *
 * Пара {сущность, действие} дедуплицируется: id обычно встречается и в операции, и в
 * inverse одного action'а, и без дедупликации экран показывал бы один конфликт дважды.
 */
async function foreignChangesAfter(
  tx: Tx,
  args: { runId: string; after: JournalEntry; touched: ReadonlySet<string> },
): Promise<RollbackConflict[]> {
  const rows = await tx.execute(
    sql`SELECT id, created_at, metadata FROM chat_messages
        WHERE metadata @> '{"actions": []}'::jsonb
          AND jsonb_array_length(metadata->'actions') > 0
          AND (created_at, id) > (${args.after.at.toISOString()}::timestamptz, ${args.after.messageId}::uuid)
        ORDER BY created_at ASC, id ASC`,
  );
  const conflicts: RollbackConflict[] = [];
  const seen = new Set<string>();
  for (const row of rows as unknown as Array<Record<string, unknown>>) {
    const entry = toEntry(row);
    if (entry === undefined) continue;
    const action = entry.action;
    if (isRunAction(action, args.runId)) continue;
    if (await isUndone(tx, action.id)) continue;
    for (const op of [...action.operations, ...action.inverse]) {
      for (const entityId of operationIds(op)) {
        if (!args.touched.has(entityId)) continue;
        const key = `${action.id}:${entityId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        conflicts.push({
          entityId,
          actionId: action.id,
          at: entry.at.toISOString(),
          source: action.source,
        });
      }
    }
  }
  return conflicts;
}

/**
 * Откат прогона. Шаги 1–3 (чтение журнала и предпроверка) идут ОДНОЙ транзакцией под
 * `withIdentity`: RLS на chat_messages скоупит журнал владельцем (§4.10), и без identity
 * выборка вернула бы пусто. Транзакция закрывается ДО серии отмен намеренно — undoAction
 * принимает `Db` и открывает собственную транзакцию, а вложенности здесь быть не должно.
 *
 * Прогон, которого нет (или чужой — под RLS это неразличимо), даёт `ok` с пустым undone,
 * а не NOT_FOUND: «откатывать нечего» — это исход, а не отказ, и повторное нажатие кнопки
 * после успешного отката обязано вести себя так же.
 */
export async function rollbackRun(
  db: Db,
  args: { actorUserId: string; runId: string },
): Promise<WireRollbackResult> {
  const { actorUserId, runId } = args;

  const plan = await withIdentity(db, actorUserId, async (tx) => {
    const all = await runActions(tx, runId);
    // Уже отменённые (вручную «отмени последнее» или прошлым откатом) выбывают: повторная
    // отмена вернула бы VALIDATION и уронила бы весь откат в partial на ровном месте
    const live: JournalEntry[] = [];
    for (const entry of all) {
      if (!(await isUndone(tx, entry.action.id))) live.push(entry);
    }
    const last = live[live.length - 1];
    if (last === undefined) return { live, conflicts: [] as RollbackConflict[] };
    const conflicts = await foreignChangesAfter(tx, {
      runId,
      after: last,
      touched: touchedEntities(live),
    });
    return { live, conflicts };
  });

  if (plan.conflicts.length > 0) {
    return { ok: false, reason: 'conflict', conflicts: plan.conflicts };
  }

  // Шаг 4: серия отмен в ОБРАТНОМ порядке журнала — иначе inverse раннего действия лёг бы
  // поверх позднего и восстановил состояние, которого не было (§7.8 «inverse в обратном
  // порядке исполнения»). Копия перед reverse: он мутирует массив на месте, а `plan`
  // здесь — прочитанный план, а не рабочий буфер.
  const undone: string[] = [];
  for (const entry of [...plan.live].reverse()) {
    const result = await undoAction(db, { actorUserId, actionId: entry.action.id });
    if (!result.ok) {
      return {
        ok: false,
        reason: 'partial',
        undone,
        failed: {
          actionId: entry.action.id,
          error: { code: result.error.code, message: result.error.message },
        },
      };
    }
    undone.push(entry.action.id);
  }
  return { ok: true, undone, note: ROLLBACK_NOTE };
}
