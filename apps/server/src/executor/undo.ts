// apps/server/src/executor/undo.ts
// Undo §7.8 при append-only журнале (§4.6): отмена НЕ правит записанное сообщение —
// добавляет НОВОЕ системное сообщение {type:'undo', undoes:<action_id>} в тот же тред
// и применяет inverse В ОДНОМ tx с его записью. Нового action undo не порождает
// (undo неотменяем). Применение inverse идёт через executor во внутреннем режиме
// (InternalUndoMode, см. types.ts) — стадии, инварианты и RLS общие, конвейер не
// дублируется; режим недостижим через tRPC/тулы.
import { newId } from '@orbis/shared';
import { appendMessage } from '../chat/messages';
import { ensureGlobalThread } from '../chat/threads';
import type { Db } from '../db/client';
import { withIdentity } from '../db/with-identity';
import type { Identity } from '../identity';
import { unmarkRefSources } from '../registry/ref';
import { ExecError } from './errors';
import { execute } from './executor';
import {
  actionRecordOf,
  findAction,
  findLastUndoable,
  isUndone,
  type JournalEntry,
} from './journal-read';
import type {
  ActionRecord,
  ExecuteErr,
  ExecuteOk,
  ExecuteRequest,
  ExecuteResult,
  ExecutorDeps,
} from './types';

/**
 * То же «последнее неотменённое», но БЕЗ применения (В-8): политике §7.10 нужно посмотреть на обратные
 * операции, чтобы назначить уровень, а применять их до решения владельца она не вправе. Скан — у API
 * журнала (`journal-read.findLastUndoable`), чтобы у правила «последнее ВИДИМОЕ действие владельца» был ОДИН
 * дом и не было второй копии в диспатче. `title` — заголовок записи журнала (`card.title` синка) — единственная
 * человекочитаемая строка о действии.
 */
export async function peekLastUndoable(
  db: Db,
  who: Identity,
): Promise<{ action: ActionRecord; title: string } | undefined> {
  const found = await withIdentity(db, who, (tx) => findLastUndoable(tx, who.graph));
  return found === undefined ? undefined : { action: actionRecordOf(found), title: found.title };
}

/**
 * Применение inverse найденного действия: операции журнала — это тулы executor'а,
 * поэтому просто прогоняем их конвейером во внутреннем режиме. Multi-op inverse
 * (batch-действие) идёт batch-путём с техническим batchId — атомарность §7.8;
 * в журнал он не попадает (internal-режим пишет undo-сообщение вместо action).
 *
 * Отсюда требование к ФОРМЕ полезной нагрузки, которое ломается молча: `iv.payload`
 * уезжает во вход тула и разбирается fail-closed'ом (`entityUpdateExecInput`), поэтому
 * форма, которой контракт не знает, даёт не «ничего не сделал», а VALIDATION — а по
 * ответу undo это неотличимо от честного отказа. С §А7-4 нагрузка — плоские `props`/
 * `unset`/`aspects:{attach,detach}` (внутренняя форма §А1-1), и exec-надмножество их
 * принимает; менять её здесь, не тронув контракт, нельзя.
 */
/**
 * Источники, которым отменяемое действие поставило `needs-review` при архивации цели ссылки
 * (§А6-3, рулинг Р-11-1). Читаются из строки журнала `ref_sources_marked`, которую пишет
 * `applyRefEffects`.
 *
 * Форма нагрузки разбирается ЗАЩИТНО: журнал append-only, и в нём лежат записи, сделанные до
 * этого коммита, — у них строки `ref_sources_marked` нет вовсе либо она несёт прежнее поле
 * `marked` (счётчик). Ни то ни другое не должно ронять откат: неизвестная форма означает
 * «снимать нечего», а не исключение.
 */
function markedRefSources(action: Pick<ActionRecord, 'operations'>): string[] {
  const out: string[] = [];
  for (const op of action.operations) {
    if (op.op !== 'ref_sources_marked') continue;
    const sources = (op.payload as { sources?: unknown }).sources;
    if (!Array.isArray(sources)) continue;
    for (const id of sources) if (typeof id === 'string') out.push(id);
  }
  return out;
}

async function applyUndo(
  db: Db,
  who: Identity,
  action: JournalEntry,
  beforeStages?: ExecutorDeps['beforeStages'],
): Promise<ExecuteResult> {
  if (action.inverse.length === 0) {
    // Недостижимо для действий executor'а (inverse всегда непуст); страховка формата
    return {
      ok: false,
      error: { code: 'VALIDATION', message: `у действия ${action.id} нет inverse-операций` },
    };
  }
  const req: ExecuteRequest = {
    identity: who,
    actorKind: 'owner', // MVP: undo инициирует владелец графа
    source: 'system',
    operations: action.inverse.map((iv) => ({ tool: iv.op, input: iv.payload })),
    batchId: action.inverse.length > 1 ? newId() : undefined,
  };
  const result = await execute(db, req, {
    // Шов сериализации карточки отката (`approvePending`, ключ `undo_of`): замок единицы и
    // перепроверка «не отклонена» — в ТОЙ ЖЕ транзакции, что undo-сообщение (см. `undoAction`).
    ...(beforeStages !== undefined && { beforeStages }),
    internalUndo: {
      // Вызывается ПОСЛЕ применения inverse В ТОМ ЖЕ tx — атомарность undo (§7.8)
      async writeUndoMessage(tx) {
        // Перепроверка под замками строк: конкурентный undo того же action мог
        // закоммититься, пока этот tx ждал FOR UPDATE (READ COMMITTED увидит его);
        // отказ откатывает и применённый inverse — двойного отката не бывает
        if (await isUndone(tx, who.graph, action.id)) {
          throw new ExecError('VALIDATION', `действие ${action.id} уже отменено`, {
            actionId: action.id,
          });
        }
        // Снятие пометки `needs-review`, поставленной архивацией цели ссылки (Р-11-1).
        // ЗДЕСЬ, а не в inverse, по двум причинам сразу: inverse исполняется ТУЛАМИ, а «снять
        // тег у списка сущностей» тулом не выражается; и делать это надо ПОСЛЕ применения
        // inverse — цель к этому моменту уже разархивирована, и условие «не осталось ссылок
        // на архивную цель» внутри `unmarkRefSources` считается по восстановленному графу.
        await unmarkRefSources(tx, who.graph, markedRefSources(action));
        await appendMessage(tx, {
          id: newId(),
          // Тот же тред, где записано отменяемое действие. У прежнего хранилища тред есть у каждой записи;
          // запись без треда (таблица журнала, задача 5) отменой не будит разговор — глобальный тред владельца.
          threadId: action.threadId ?? (await ensureGlobalThread(tx, who.graph)),
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

/**
 * Отмена конкретного действия по id из журнала (§7.8).
 *
 * `beforeStages` — ровно тот же шов, что у `approvePending` для пачки (`ExecutorDeps`): карточка
 * отката (`undo_of`, В-8) исполняется здесь, а не `execute` payload'а, и без шва её «Принять» и
 * «Отклонить» не делили бы замок единицы — владелец мог получить в ленте «отменено» и «отклонено»
 * разом (фикс-раунд 1 задачи 8, I-3). Других потребителей у параметра нет.
 */
export async function undoAction(
  db: Db,
  args: { identity: Identity; actionId: string },
  deps: { beforeStages?: ExecutorDeps['beforeStages'] } = {},
): Promise<ExecuteResult> {
  try {
    const found = await withIdentity(db, args.identity, async (tx) => {
      // Чтение action отдельным tx от применения безопасно: журнал append-only,
      // metadata неизменяема (§4.6); статус «отменено» перепроверяется в tx применения
      const found = await findAction(tx, args.identity.graph, args.actionId);
      if (!found) {
        // RLS скоупит журнал владельцем: чужое и несуществующее неразличимы
        throw new ExecError('NOT_FOUND', `действие ${args.actionId} не найдено в журнале`, {
          actionId: args.actionId,
        });
      }
      if (await isUndone(tx, args.identity.graph, args.actionId)) {
        throw new ExecError('VALIDATION', `действие ${args.actionId} уже отменено`, {
          actionId: args.actionId,
        });
      }
      return found;
    });
    return await applyUndo(db, args.identity, found, deps.beforeStages);
  } catch (e) {
    if (e instanceof ExecError) {
      return { ok: false, error: { code: e.code, message: e.message, details: e.details } };
    }
    throw e;
  }
}

/**
 * Что именно отменило «отмени последнее» — для того, кто НЕ выбирал действие сам: чат-модели
 * (тул `undo_last`, tools/dispatch.ts) нужно назвать владельцу откаченное, а `actionId` без
 * подписи ей ничего не говорит. `title` — заголовок audit-сообщения («Создана сущность
 * «…»»), `type`/`entityId` — из самой записи журнала.
 */
export interface UndoneAction {
  actionId: string;
  type: ActionRecord['type'];
  entityId: string | null;
  title: string;
}

/**
 * Исход «отмени последнее»: тот же ExecuteResult, что у точечного undo, плюс `undone` при
 * успехе. Отказ «отменять нечего» — NOT_FOUND с `details.reason: 'nothing_to_undo'`: чату он
 * нужен как ШТАТНЫЙ ответ («нечего отменять»), а не как ошибка, и отличать его по тексту
 * сообщения было бы хрупко.
 */
export type UndoLastResult = (ExecuteOk & { undone: UndoneAction }) | ExecuteErr;

/** «Отмени последнее» (§7.8): inverse первого неотменённого действия с конца журнала. */
export async function undoLast(db: Db, args: { identity: Identity }): Promise<UndoLastResult> {
  try {
    const found = await withIdentity(db, args.identity, (tx) =>
      findLastUndoable(tx, args.identity.graph),
    );
    if (!found) {
      return {
        ok: false,
        error: {
          code: 'NOT_FOUND',
          message: 'неотменённых действий в журнале нет',
          details: { reason: 'nothing_to_undo' },
        },
      };
    }
    const result = await applyUndo(db, args.identity, found);
    if (!result.ok) return result;
    // `findLastUndoable` записей отмены не отдаёт (К-22) — запись журнала здесь всегда действие
    const record = actionRecordOf(found);
    return {
      ...result,
      undone: {
        actionId: record.id,
        type: record.type,
        entityId: record.entity_id,
        title: found.title,
      },
    };
  } catch (e) {
    if (e instanceof ExecError) {
      return { ok: false, error: { code: e.code, message: e.message, details: e.details } };
    }
    throw e;
  }
}
