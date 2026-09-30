// apps/server/src/executor/journal.ts
// Боевой JournalSink (§7.8, спека скорости §11.2): строка таблицы `action_journal` ТЕМ ЖЕ tx, что и стадия 5, и её
// строки боковой `action_journal_entities` (РП-8) — одной инструкцией. Строка — действие целиком (весь `ActionRecord`,
// РП-7), заголовок и тул карточки, результаты пачки (ответ идемпотентного повтора, §7.8); запись отмены — отдельная
// строка `type:'undo'` (`writeUndo`). Целевой тред — entry.threadId, иначе глобальный тред графа (создаётся в том же
// tx; РП-10 — как до таблицы, новое поведение тредов — задача 6). Журнал только дописывается: у ролей приложения нет
// ни UPDATE, ни DELETE (0025). Retention журнала (RET-02) здесь НЕ реализуется — отложен (К-15).
//
// Форма карточки ленты больше не хранится: она собирается на чтении (`feedCard`, `journal/thread-page.ts`) из
// заголовка, тула и записи — хранить её значило бы держать вторую копию того, что уже лежит в строке.
import type { GraphId } from '@orbis/shared';
import { type SQL, sql } from 'drizzle-orm';
import { ensureGlobalThread } from '../chat/threads';
import type { Tx } from '../db/with-identity';
import { ExecError } from '../errors';
import type { Card } from '../tools/registry';
import { pgErrorInfo } from './executor';
import { actionRecordOf, findBatch, touchedEntityIds } from './journal-read';
import type {
  ActionCard,
  ActionRecord,
  JournalSink,
  JournalWrite,
  MutationSource,
  UndoWrite,
} from './types';
import { AuditIdConflictError } from './types';

/**
 * Источники, чья строка журнала — ЕДИНСТВЕННЫЙ носитель карточки в ленте: только для
 * них в metadata.cards отдаётся форма клиентского union'а (02-core-os §2.3, с kind).
 * Без kind renderCards уходит в default (apps/web/.../cards/renderCards.tsx) и после
 * перезагрузки от карточки остаётся голая строка content.
 *
 * Почему белый список, а не «все, кроме chat»:
 * - 'chat' — у него СВОЙ, более богатый носитель: ответ ассистента персистит карточку
 *   с aspects/keyFields из реестра и ТЕМ ЖЕ undoActionId (ai/send-message.ts). Вторая
 *   карточка дала бы в ленте дубль с двумя кнопками «Отменить», причём беднее первой;
 * - 'fast_path' — единственная реальная деградация: клиентская карточка живёт лишь в
 *   кэше react-query (features/chat/useFastPath.ts), а из БД приезжает голая строка;
 * - 'mcp' | 'ui' | 'quick_capture' — карточки в ленте не было НИКОГДА, ни живьём, ни
 *   после перезагрузки: карточка тут была бы новой функцией, а не починкой;
 * - 'system' — скрыт выдачей треда (`journal-read.threadFeed`), рисовать нечего;
 * - 'routine' (V1.5) — как fast_path, только хуже: у правки прогона НЕТ другого носителя
 *   вовсе. Ответа ассистента за ней не стоит (диалога не было), клиентского кэша тоже
 *   (владельца в этот момент не было в приложении) — строка журнала единственное, что
 *   он увидит, и без клиентской формы от неё осталась бы голая строка без «Отменить».
 */
const FEED_CARD_SOURCES: ReadonlySet<MutationSource> = new Set<MutationSource>([
  'fast_path',
  'routine',
]);

/**
 * Карточка ленты — ВЕТКА серверного union'а Card (tools/registry.ts), а не копия его
 * полей: копий формы и так две (registry + web types.ts), третья молча отстала бы при
 * добавлении поля. Импорт type-only, цикла нет (registry тянет только shared/drizzle/zod/db).
 * Локальное ужесточение: у журнальной карточки undoActionId есть ВСЕГДА (в union он
 * опционален — у карточек LLM-ответа Undo может не быть).
 */
type FeedEntityCard = Extract<Card, { kind: 'entity_card' }> & { undoActionId: string };

/**
 * Что ляжет в metadata.cards[0] строки журнала в треде. Вне белого списка — ActionCard дословно
 * (`{tool, entity_id, title}` — прежняя форма провода, РП-10).
 *
 * При entity_id === null (batch, одиночные relation-мутации) форма остаётся прежней —
 * entityId клиентской карточки обязан быть строкой, null там был бы враньём.
 *
 * aspects/keyFields пустые СОЗНАТЕЛЬНО, а не по недосмотру: у журнала нет ни WireEntity,
 * ни viewConfig.keyFields (они собираются в tools/dispatch.ts из реестра аспектов) —
 * обогащать нечем. Карточка беднее живой, зато переживает перезагрузку и несёт «Отменить».
 */
export function feedCard(
  action: Pick<ActionRecord, 'id' | 'source'>,
  card: ActionCard,
): ActionCard | FeedEntityCard {
  if (!FEED_CARD_SOURCES.has(action.source) || card.entity_id === null) return card;
  return {
    kind: 'entity_card',
    entityId: card.entity_id,
    title: card.title,
    aspects: [],
    keyFields: {},
    // тот же id, что уходит в ai.undo({actionId}) у живых карточек (§7.8)
    undoActionId: action.id,
  };
}

/** `ARRAY[$1,…]::uuid[]`; пустой список — пустой массив того же типа (шаблон drizzle развернул бы JS-массив в кортеж). */
function uuidArray(ids: readonly string[]): SQL {
  if (ids.length === 0) return sql`ARRAY[]::uuid[]`;
  return sql`ARRAY[${sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  )}]::uuid[]`;
}

const json = (v: unknown): SQL => sql`${JSON.stringify(v)}::jsonb`;
const uuidOrNull = (v: string | null | undefined): SQL =>
  v === undefined || v === null ? sql`NULL` : sql`${v}::uuid`;
const textOrNull = (v: string | null | undefined): SQL =>
  v === undefined || v === null ? sql`NULL` : sql`${v}`;

/** Колонки строки журнала в порядке `VALUES` ниже. */
interface JournalRowValues {
  graphId: GraphId;
  id: string;
  type: string;
  entityId: string | null;
  actorUserId: string;
  actorKind: string;
  source: string;
  mechanism: string;
  actorGrantId?: string;
  runId?: string;
  actionId?: string;
  module?: string;
  editedFrom?: string;
  threadId: string | null;
  title: string;
  cardTool: string;
  entityIds: readonly string[];
  operations: unknown;
  inverse: unknown;
  results?: unknown[];
  textSession: boolean;
  bodyBefore: Record<string, string | null> | null;
  undoes: string | null;
  pinnedVersionIds: readonly string[];
  cardInReply: boolean;
}

/**
 * ОДНА инструкция: строка журнала и её строки боковой таблицы (CTE с `RETURNING`). Внешний ключ боковой таблицы
 * проверяется в конце инструкции — строка журнала к тому моменту вставлена. Время боковых строк — время строки
 * журнала (`created_at` из `RETURNING`), иначе пробы по записи и порядок журнала разъехались бы. `DISTINCT` — id
 * в разном регистре приводятся к одному uuid и дали бы повтор ключа боковой строки.
 */
async function insertRow(tx: Tx, v: JournalRowValues): Promise<void> {
  await tx.execute(sql`
    WITH j AS (
      INSERT INTO action_journal (graph_id, id, type, entity_id, actor_user_id, actor_kind, source, mechanism,
                                  actor_grant_id, run_id, action_id, module, edited_from, thread_id, title, card_tool,
                                  entity_ids, operations, inverse, results, text_session, body_before, undoes,
                                  pinned_version_ids, card_in_reply)
      VALUES (${v.graphId}::uuid, ${v.id}::uuid, ${v.type}, ${uuidOrNull(v.entityId)}, ${v.actorUserId}::uuid,
              ${v.actorKind}, ${v.source}, ${v.mechanism}, ${uuidOrNull(v.actorGrantId)}, ${uuidOrNull(v.runId)},
              ${textOrNull(v.actionId)}, ${textOrNull(v.module)}, ${uuidOrNull(v.editedFrom)},
              ${uuidOrNull(v.threadId)}, ${v.title}, ${v.cardTool}, ${uuidArray(v.entityIds)},
              ${json(v.operations)}, ${json(v.inverse)}, ${v.results === undefined ? sql`NULL` : json(v.results)},
              ${v.textSession}, ${v.bodyBefore === null ? sql`NULL` : json(v.bodyBefore)},
              ${uuidOrNull(v.undoes)}, ${uuidArray(v.pinnedVersionIds)}, ${v.cardInReply})
      RETURNING graph_id, id, created_at, entity_ids
    )
    INSERT INTO action_journal_entities (graph_id, action_id, entity_id, created_at)
    SELECT DISTINCT j.graph_id, j.id, e.entity_id, j.created_at
      FROM j CROSS JOIN LATERAL unnest(j.entity_ids) AS e(entity_id)`);
}

/** Фабрика боевого синка; состояние не хранит — один инстанс переиспользуем. */
export function makeJournalSink(): JournalSink {
  return {
    async write(tx: Tx, entry: JournalWrite): Promise<void> {
      // Инвариант §7.8 «одна строка — одно действие»: отмена, откат прогона и повтор пачки читают действие строкой.
      // Несколько action в одной записи молча потеряли бы всё, кроме первого, — поэтому нормализуем и проверяем ровно
      // один ДО любой записи (guard страхует будущий формат/баг вызывающего; отказ — VALIDATION, §9.2).
      const asList = entry.action as ActionRecord | readonly ActionRecord[];
      const actions: readonly ActionRecord[] = Array.isArray(asList) ? asList : [asList];
      const action = actions.length === 1 ? actions[0] : undefined;
      if (action === undefined) {
        throw new ExecError(
          'VALIDATION',
          'запись журнала должна нести ровно одно действие (§7.8)',
          {
            count: actions.length,
          },
        );
      }
      const threadId = entry.threadId ?? (await ensureGlobalThread(tx, entry.graphId));
      try {
        await insertRow(tx, {
          graphId: entry.graphId,
          id: action.id,
          type: action.type,
          entityId: action.entity_id,
          actorUserId: action.actor_user_id,
          actorKind: action.actor_kind,
          source: action.source,
          mechanism: action.mechanism,
          ...(action.actor_grant_id !== undefined && { actorGrantId: action.actor_grant_id }),
          ...(action.run_id !== undefined && { runId: action.run_id }),
          ...(action.action_id !== undefined && { actionId: action.action_id }),
          ...(action.module !== undefined && { module: action.module }),
          ...(action.edited_from !== undefined && { editedFrom: action.edited_from }),
          threadId,
          title: entry.card.title,
          cardTool: entry.card.tool,
          entityIds: touchedEntityIds(action),
          operations: action.operations,
          inverse: action.inverse,
          ...(entry.results !== undefined && { results: entry.results }),
          textSession: action.text_session ?? false,
          bodyBefore: action.body_before ?? null,
          undoes: null,
          pinnedVersionIds: [],
          cardInReply: entry.cardInReply ?? false,
        });
      } catch (e) {
        // Контракт JournalSink: ключ `(graph_id, id)` уже занят (конкурент вставил пачку первым, или batch_id совпал с
        // id одиночного действия — РП-12) → 23505 по PK журнала → AuditIdConflictError. tx уже abort'нут PG —
        // executor откатит его и ответит сохранённым результатом пачки или отказом (§7.8).
        const pg = pgErrorInfo(e);
        if (pg.code === '23505' && pg.constraint === 'action_journal_pkey') {
          throw new AuditIdConflictError(action.id);
        }
        throw e;
      }
    },

    async writeUndo(tx: Tx, entry: UndoWrite): Promise<void> {
      const undoing = entry.undoing;
      try {
        await insertRow(tx, {
          graphId: entry.graphId,
          id: entry.undoRecordId,
          type: 'undo',
          // Своей записи-адреса у отмены нет: карточка отменённого показывает «отменено» по ссылке undoes (К-45)
          entityId: null,
          actorUserId: entry.actorUserId,
          actorKind: 'owner',
          source: entry.path,
          mechanism: 'user',
          threadId: undoing.threadId,
          title: `Отменено: ${undoing.title}`,
          cardTool: 'undo',
          entityIds: undoing.entityIds,
          operations: entry.operations,
          // Отмена неотменяема (§0.2 п. 7): своего inverse у записи отмены нет
          inverse: [],
          textSession: false,
          bodyBefore: entry.bodyBefore,
          undoes: undoing.id,
          pinnedVersionIds: entry.pinnedVersionIds,
          cardInReply: false,
        });
      } catch (e) {
        // «Уже отменено» держит уникальность (graph_id, undoes): гонка двух отмен, прошедших перепроверку до чужого
        // коммита, — штатный отказ, а не сырой 23505 наружу
        const pg = pgErrorInfo(e);
        if (pg.code === '23505' && pg.constraint === 'action_journal_undoes_uniq') {
          throw new ExecError('VALIDATION', 'действие уже отменено', {
            actionId: undoing.id,
            reason: 'already_undone',
          });
        }
        throw e;
      }
    },

    async findBatchWrite(
      tx: Tx,
      graph: GraphId,
      batchId: string,
    ): Promise<JournalWrite | undefined> {
      const e = await findBatch(tx, graph, batchId);
      if (e === undefined) return undefined;
      return {
        graphId: e.graphId,
        ...(e.threadId !== null && { threadId: e.threadId }),
        action: actionRecordOf(e),
        card: { tool: e.cardTool, entity_id: e.entityId, title: e.title },
        ...(e.results !== undefined && { results: e.results }),
        cardInReply: e.cardInReply,
      };
    },
  };
}
