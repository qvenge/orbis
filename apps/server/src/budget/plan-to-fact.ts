// apps/server/src/budget/plan-to-fact.ts
// Перевод РУЧНОЙ planned-покупки в факт одним batch (03-budget §2.7, приёмка §7.6,
// Task A8). Подтверждение (§2.7-флоу «покупка совершена?») ставит planned=false,
// обновляет occurred_on на фактическую дату и заново выбирает конверт — авто-привязку
// по НОВОЙ дате дописывает бюджет-хук executor'а (A4) В ТОТ ЖЕ action, поэтому Undo
// откатывает переход целиком (план + прежний occurred_on + прежняя привязка).
//
// Один вызов execute() с batchId клиента: идемпотентность повтора и Undo — по audit-PK
// (§7.8). Пречек §2.7 идёт ПОСЛЕ replay-детекта (как rolloverCreate): повтор того же
// batchId обязан вернуться replay'ем, а не упасть INVARIANT «уже факт» на собственном
// прошлом переходе. Отказ INVARIANT, если сущность не ручная planned-покупка: нет
// financial / уже факт / архивна / шаблон recurring / recurring-инстанс (derived_from —
// его переводит системный конвейер postDue в свой день, §2.8). Чужая сущность невидима
// под RLS → тот же INVARIANT.
import {
  batchAuditMessageId,
  type ConfirmPurchaseInput,
  type ConfirmPurchaseResult,
} from '@orbis/shared';
import { sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { withIdentity } from '../db/with-identity';
import { ExecError, type ExecErrorCode } from '../errors';
import { execute } from '../executor/executor';
import { makeChatJournalSink } from '../executor/journal';
import type { ExecuteRequest } from '../executor/types';

// Синк один на модуль (как post-due.ts / rollover): состояния не хранит, audit-сообщение
// batch пишется тем же tx, что операции executor'а (§7.8).
const sink = makeChatJournalSink();

function invariant(message: string): ExecError {
  return new ExecError('INVARIANT', message, { invariant: 'not_planned_purchase' });
}

/**
 * Перевод planned-покупки в факт (§2.7): один batch с одной операцией entity_update
 * (planned=false, occurred_on=<фактическая дата>); переселект конверта по новой дате —
 * бюджет-хук A4 в том же action. Идемпотентно по batchId, Undo обратим целиком (§7.6).
 */
export async function confirmPurchase(
  db: Db,
  ownerId: string,
  input: ConfirmPurchaseInput,
): Promise<ConfirmPurchaseResult> {
  const auditId = batchAuditMessageId(ownerId, input.batchId);

  // Фаза чтения: replay-детект + пречек §2.7. Пречек — только когда это НЕ повтор того
  // же batchId (иначе уже переведённая покупка ложно отклонялась бы «уже факт»).
  await withIdentity(db, ownerId, async (tx) => {
    const replay = (await sink.findByAuditId(tx, auditId)) !== undefined;
    if (replay) return;

    // Сущность под RLS: чужая невидима → row отсутствует → INVARIANT (не перевод чужого).
    const rows = (await tx.execute(sql`
      SELECT
        e.archived AS archived,
        e.aspects->'orbis/financial' AS fin,
        e.aspects->'orbis/schedule'->'recurrence' AS recurrence,
        EXISTS (
          SELECT 1 FROM relations r
          WHERE r.target_id = e.id AND r.relation_type = 'derived_from'
        ) AS derived
      FROM entities e
      WHERE e.id = ${input.entityId} AND e.owner_id = ${ownerId}
    `)) as unknown as Array<{
      archived: boolean;
      fin: Record<string, unknown> | null;
      recurrence: unknown;
      derived: boolean;
    }>;
    const row = rows[0];
    if (row === undefined || row.fin === null) {
      throw invariant('сущность не является запланированной покупкой (нет orbis/financial) — §2.7');
    }
    if (row.archived) {
      throw invariant('покупка архивирована — сначала разархивируйте её (§2.7)');
    }
    if (row.recurrence != null) {
      throw invariant(
        'шаблон повторения не переводится в факт этим действием (§2.9); правьте инстансы',
      );
    }
    if (row.derived) {
      throw invariant(
        'recurring-инстанс переводит в факт системный конвейер в свой день (§2.8), а не ручное подтверждение',
      );
    }
    if (row.fin.planned !== true) {
      throw invariant('операция уже переведена в факт (planned=false) — переводить нечего (§2.7)');
    }
  });

  // Один batch (§2.7): entity_update planned=false + фактическая дата. batchId клиента →
  // ветка executeBatch (идемпотентность/Undo по audit-PK), A4-хук переселектит конверт.
  const request: ExecuteRequest = {
    actorUserId: ownerId,
    actorKind: 'owner',
    source: 'ui', // подтверждённое действие владельца на карточке «Покупка совершена?» (§2.7)
    batchId: input.batchId,
    operations: [
      {
        tool: 'entity_update',
        input: {
          id: input.entityId,
          aspects: { 'orbis/financial': { planned: false, occurred_on: input.occurredOn } },
        },
      },
    ],
  };
  const r = await execute(db, request, { sink });
  if (!r.ok) {
    throw new ExecError(r.error.code as ExecErrorCode, r.error.message, r.error.details);
  }
  return { actionId: r.actionId, idempotentReplay: r.idempotentReplay };
}
