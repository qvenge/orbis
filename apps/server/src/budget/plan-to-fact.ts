// apps/server/src/budget/plan-to-fact.ts
// Перевод РУЧНОЙ planned-покупки в факт одним batch (03-budget §2.7, приёмка §7.6,
// Task A8). Подтверждение (§2.7-флоу «покупка совершена?») ставит planned=false,
// обновляет occurred_on на фактическую дату и заново выбирает конверт — авто-привязку
// по НОВОЙ дате дописывает бюджет-хук executor'а (A4) В ТОТ ЖЕ action, поэтому Undo
// откатывает переход целиком (план + прежний occurred_on + прежняя привязка).
//
// ТЕЛО — ДЕКЛАРАЦИЯ `finance/plan-to-fact` (§Б6-1, `BUILTIN_ACTION_DEFS`): пять пречеков §2.7
// стали её предусловием, `entity_update` — её шагом, и исполняет их конвейер действий
// (`actions/resolve.ts` + `execute`). Эквивалентность сегодняшнему коду доказывает golden
// §С8-27 (`src/actions/golden.test.ts`): состояние графа — байт-в-байт, строка журнала — с
// точностью до четырёх расхождений §Б6-4. Здесь осталась РУЧКА: вход §2.7, идемпотентность по
// batchId клиента (audit-PK §7.8) и код отказа, который читает экран (`asLegacyRefusal`).
import {
  batchAuditMessageId,
  type ConfirmPurchaseInput,
  type ConfirmPurchaseResult,
  effectiveLabel,
} from '@orbis/shared';
import { OWNER_LOCALE } from '@orbis/shared/query';
import { actionDateArgs } from '../actions/precondition';
import { resolveAction } from '../actions/resolve';
import type { Db } from '../db/client';
import { withIdentity } from '../db/with-identity';
import { ExecError, type ExecErrorCode } from '../errors';
import { execute } from '../executor/executor';
import { makeChatJournalSink } from '../executor/journal';
import type { Identity } from '../identity';
import { effectiveRegistry } from '../registry/cache';

// Синк один на модуль (как post-due.ts / rollover): состояния не хранит, audit-сообщение
// batch пишется тем же tx, что операции executor'а (§7.8).
const sink = makeChatJournalSink();

/** Декларация, которой ручка переводит покупку (`BUILTIN_ACTION_DEFS`, модуль Финансы). */
const PLAN_TO_FACT_ACTION = 'finance/plan-to-fact';

/**
 * Перевод planned-покупки в факт (§2.7) — ТЕПЕРЬ ДЕКЛАРАЦИЕЙ. Пять пречеков и один
 * `entity_update` переехали в строку `finance/plan-to-fact` (`BUILTIN_ACTION_DEFS`); здесь
 * осталась ручка: вход §2.7, идемпотентность по `batchId` и перевод отказа конвейера в тот код,
 * которым эта ручка отвечала всегда (см. `asLegacyRefusal`).
 *
 * ПОРЯДОК «replay-детект ПЕРЕД резолвом» СОХРАНЁН И ОН НЕСУЩИЙ: у повтора того же `batchId`
 * предусловие ложно по построению (`planned` уже `false`), и резолв ответил бы «переводить
 * нечего» на собственном прошлом переходе. Прежний код обходил это тем же способом (пречек
 * только когда это НЕ повтор), и менять поведение повтора эта задача не вправе — §С8-27
 * требует равенства.
 */
export async function confirmPurchase(
  db: Db,
  who: Identity,
  input: ConfirmPurchaseInput,
): Promise<ConfirmPurchaseResult> {
  const graphId = who.graph;
  const auditId = batchAuditMessageId(graphId, input.batchId);
  const replay = await withIdentity(db, who, (tx) => sink.findByAuditId(tx, auditId));
  if (replay !== undefined) {
    // Сохранённый результат — из журнала: `execute` вернул бы его же batch-веткой, но для
    // этого ему нужны операции, а резолвить их у повтора нечем (см. докблок выше).
    return { actionId: replay.action.id, idempotentReplay: true };
  }
  try {
    // «Сегодня» и зона — той же функцией, что у `runAction` и «Принять» (`actionDateArgs`):
    // предусловие `plan-to-fact` дат не читает, но резолв одного действия, считающий «сегодня»
    // по разным часам на разных входах, был бы вторым правилом.
    const resolved = await withIdentity(db, who, async (tx) =>
      resolveAction(
        tx,
        await effectiveRegistry(tx, graphId),
        graphId,
        {
          action: PLAN_TO_FACT_ACTION,
          self: input.entityId,
          params: { occurred_on: input.occurredOn },
          batch_id: input.batchId,
        },
        await actionDateArgs(tx, graphId),
      ),
    );
    // Один batch (§2.7): batchId клиента → ветка executeBatch (идемпотентность/Undo по
    // audit-PK), A4-хук переселектит конверт в тот же action.
    const r = await execute(
      db,
      {
        identity: who,
        actorKind: 'owner',
        source: 'ui', // подтверждённое действие владельца на карточке «Покупка совершена?» (§2.7)
        batchId: input.batchId,
        operations: resolved.operations,
        action: { id: resolved.decl.id, module: resolved.decl.module },
        // Подпись — тем же сборщиком, что у `runAction`: карточка ленты у ручки и у чата одна.
        actionLabel: effectiveLabel(resolved.decl.label, OWNER_LOCALE),
      },
      { sink },
    );
    if (!r.ok) throw new ExecError(r.error.code as ExecErrorCode, r.error.message, r.error.details);
    return { actionId: r.actionId, idempotentReplay: r.idempotentReplay };
  } catch (e) {
    throw asLegacyRefusal(e);
  }
}

/**
 * ОТКАЗ РУЧКИ НЕ МЕНЯЕТСЯ, И ЭТО НЕ КОСМЕТИКА (Р-23). Экран читает код TRPC: `CONFLICT` у него
 * означает «batchId непригоден» — он минтит новый id и показывает «Не удалось перевести»
 * (`apps/web/src/features/budget/PlannedToFactCard.tsx:57-64`). Отдай ручка наружу
 * `CONFLICT precondition_failed`, и «уже факт» стал бы для владельца безымянным сбоем с
 * прокруткой batchId, а `NOT_FOUND` на чужой сущности — четвёртым кодом там, где всегда был один.
 * Переписать экран Б-2 не вправе, поэтому перевод стоит ЗДЕСЬ, на границе ручки, одной функцией
 * с закрытой таблицей — а не размазан по конвейеру.
 *
 * ТЕКСТ ПРИ ЭТОМ ОДИН НА ПЯТЬ ПОВОДОВ: у действия предусловие одно (§Б6-1), и различить, какой
 * конъюнкт не сошёлся, конвейер не обещает. Это записанное расхождение приёмки (см.
 * `src/actions/golden.test.ts`, `PRECONDITION_CONJUNCTS`), а не потеря по недосмотру.
 */
const NOT_PLANNED_PURCHASE =
  'сущность не является ручной запланированной покупкой: нет orbis/financial, архивна, ' +
  'шаблон или инстанс повторения, либо уже переведена в факт (§2.7)';

/**
 * `NOT_FOUND` переводится только ПО ЦЕЛИ (в `details` есть `id` — так отвечают `loadTargets` и
 * резолв о строке, невидимой под RLS). `NOT_FOUND` самой декларации (`lookupAction`, `details`
 * без `id`) — поломка развёртывания (реестр не пересеян), а не «это не покупка»: спрятать её
 * текстом §2.7 значило бы отвечать владельцу неправдой и не оставить следа в ошибках.
 */
function asLegacyRefusal(e: unknown): unknown {
  if (!(e instanceof ExecError)) return e;
  const details = (e.details ?? {}) as { reason?: unknown; id?: unknown };
  if (
    (e.code === 'NOT_FOUND' && details.id !== undefined) ||
    (e.code === 'CONFLICT' && details.reason === 'precondition_failed')
  ) {
    return new ExecError('INVARIANT', NOT_PLANNED_PURCHASE, { invariant: 'not_planned_purchase' });
  }
  return e;
}
