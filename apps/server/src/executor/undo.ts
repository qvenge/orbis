// apps/server/src/executor/undo.ts
// Undo §7.8 при append-only журнале (§4.6): отмена НЕ правит записанное сообщение —
// добавляет НОВОЕ системное сообщение {type:'undo', undoes:<action_id>} в тот же тред
// и применяет inverse В ОДНОМ tx с его записью. Нового action undo не порождает
// (undo неотменяем). Применение inverse идёт через executor во внутреннем режиме
// (InternalUndoMode, см. types.ts) — стадии, инварианты и RLS общие, конвейер не
// дублируется; режим недостижим через tRPC/тулы.
import { newId } from '@orbis/shared';
import { sql } from 'drizzle-orm';
import { appendMessage } from '../chat/messages';
import type { Db } from '../db/client';
import { type Tx, withIdentity } from '../db/with-identity';
import { ExecError } from './errors';
import { execute } from './executor';
import type { ActionRecord, ExecuteRequest, ExecuteResult } from './types';

interface FoundAction {
  threadId: string;
  action: ActionRecord;
}

/** Сообщение с action по id — containment по GIN-индексу chat_messages_metadata_gin. */
async function findActionMessage(tx: Tx, actionId: string): Promise<FoundAction | undefined> {
  const probe = JSON.stringify({ actions: [{ id: actionId }] });
  const rows = await tx.execute(
    sql`SELECT thread_id, metadata FROM chat_messages
        WHERE metadata @> ${probe}::jsonb
        LIMIT 1`,
  );
  const row = rows[0];
  if (!row) return undefined;
  const metadata = row.metadata as { actions?: ActionRecord[] };
  const action = metadata.actions?.find((a) => a.id === actionId);
  if (!action) return undefined; // недостижимо: containment гарантирует наличие
  return { threadId: row.thread_id as string, action };
}

/** Действие отменено ⇔ существует undo-сообщение с его id (§7.8). */
async function isUndone(tx: Tx, actionId: string): Promise<boolean> {
  const probe = JSON.stringify({ type: 'undo', undoes: actionId });
  const rows = await tx.execute(
    sql`SELECT 1 AS hit FROM chat_messages WHERE metadata @> ${probe}::jsonb LIMIT 1`,
  );
  return rows.length > 0;
}

/**
 * Скан журнала владельца с конца (§7.8): сообщения по created_at DESC (RLS скоупит
 * владельцем); undo-записи и сообщения без actions отсекаются containment-фильтром,
 * уже отменённые — NOT EXISTS по их undo-сообщению; берётся первое неотменённое.
 */
async function findLastUndoable(tx: Tx): Promise<FoundAction | undefined> {
  const rows = await tx.execute(
    sql`SELECT m.thread_id, m.metadata
        FROM chat_messages m
        WHERE m.metadata @> '{"actions": []}'::jsonb
          AND jsonb_array_length(m.metadata->'actions') > 0
          AND NOT EXISTS (
            SELECT 1 FROM chat_messages u
            WHERE u.metadata @> jsonb_build_object(
              'type', 'undo', 'undoes', m.metadata->'actions'->0->>'id')
          )
        ORDER BY m.created_at DESC, m.id DESC
        LIMIT 1`,
  );
  const row = rows[0];
  if (!row) return undefined;
  const metadata = row.metadata as { actions?: ActionRecord[] };
  const action = metadata.actions?.[0];
  if (!action) return undefined; // недостижимо: фильтр требует непустой actions
  return { threadId: row.thread_id as string, action };
}

/**
 * Применение inverse найденного действия: операции журнала — это тулы executor'а,
 * поэтому просто прогоняем их конвейером во внутреннем режиме. Multi-op inverse
 * (batch-действие) идёт batch-путём с техническим batchId — атомарность §7.8;
 * в журнал он не попадает (internal-режим пишет undo-сообщение вместо action).
 */
async function applyUndo(db: Db, actorUserId: string, found: FoundAction): Promise<ExecuteResult> {
  const { action, threadId } = found;
  if (action.inverse.length === 0) {
    // Недостижимо для действий executor'а (inverse всегда непуст); страховка формата
    return {
      ok: false,
      error: { code: 'VALIDATION', message: `у действия ${action.id} нет inverse-операций` },
    };
  }
  const req: ExecuteRequest = {
    actorUserId,
    actorKind: 'owner', // MVP: undo инициирует владелец графа
    source: 'system',
    operations: action.inverse.map((iv) => ({ tool: iv.op, input: iv.payload })),
    batchId: action.inverse.length > 1 ? newId() : undefined,
  };
  const result = await execute(db, req, {
    internalUndo: {
      // Вызывается ПОСЛЕ применения inverse В ТОМ ЖЕ tx — атомарность undo (§7.8)
      async writeUndoMessage(tx) {
        // Перепроверка под замками строк: конкурентный undo того же action мог
        // закоммититься, пока этот tx ждал FOR UPDATE (READ COMMITTED увидит его);
        // отказ откатывает и применённый inverse — двойного отката не бывает
        if (await isUndone(tx, action.id)) {
          throw new ExecError('VALIDATION', `действие ${action.id} уже отменено`, {
            actionId: action.id,
          });
        }
        await appendMessage(tx, {
          id: newId(),
          threadId, // тот же тред, где записано отменяемое действие
          role: 'system',
          content: `Отменено действие ${action.id}`,
          metadata: { type: 'undo', undoes: action.id },
        });
      },
    },
  });
  // Вызывающему полезен id ОТМЕНЁННОГО действия, а не технический id внутреннего
  // прогона (тот не соответствует никакой записи журнала)
  return result.ok ? { ...result, actionId: action.id } : result;
}

/** Отмена конкретного действия по id из журнала (§7.8). */
export async function undoAction(
  db: Db,
  args: { actorUserId: string; actionId: string },
): Promise<ExecuteResult> {
  try {
    const found = await withIdentity(db, args.actorUserId, async (tx) => {
      // Чтение action отдельным tx от применения безопасно: журнал append-only,
      // metadata неизменяема (§4.6); статус «отменено» перепроверяется в tx применения
      const msg = await findActionMessage(tx, args.actionId);
      if (!msg) {
        // RLS скоупит журнал владельцем: чужое и несуществующее неразличимы
        throw new ExecError('NOT_FOUND', `действие ${args.actionId} не найдено в журнале`, {
          actionId: args.actionId,
        });
      }
      if (await isUndone(tx, args.actionId)) {
        throw new ExecError('VALIDATION', `действие ${args.actionId} уже отменено`, {
          actionId: args.actionId,
        });
      }
      return msg;
    });
    return await applyUndo(db, args.actorUserId, found);
  } catch (e) {
    if (e instanceof ExecError) {
      return { ok: false, error: { code: e.code, message: e.message, details: e.details } };
    }
    throw e;
  }
}

/** «Отмени последнее» (§7.8): inverse первого неотменённого действия с конца журнала. */
export async function undoLast(db: Db, args: { actorUserId: string }): Promise<ExecuteResult> {
  try {
    const found = await withIdentity(db, args.actorUserId, (tx) => findLastUndoable(tx));
    if (!found) {
      return {
        ok: false,
        error: { code: 'NOT_FOUND', message: 'неотменённых действий в журнале нет' },
      };
    }
    return await applyUndo(db, args.actorUserId, found);
  } catch (e) {
    if (e instanceof ExecError) {
      return { ok: false, error: { code: e.code, message: e.message, details: e.details } };
    }
    throw e;
  }
}
