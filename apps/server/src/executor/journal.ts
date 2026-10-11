// apps/server/src/executor/journal.ts
// Боевой JournalSink (§7.8, спека скорости §11.2): строка таблицы `action_journal` ТЕМ ЖЕ tx, что и стадия 5, и её
// строки боковой `action_journal_entities` (РП-8) — одной инструкцией. Строка — действие целиком (весь `ActionRecord`,
// РП-7), заголовок и тул карточки, результаты пачки (ответ идемпотентного повтора, §7.8), признак «карточка в ответе»;
// запись отмены — отдельная строка `type:'undo'` (`writeUndo`). Тред строки выбирает `journalThreadOf` по источнику
// (§11.3). Журнал только дописывается: у ролей приложения нет ни UPDATE, ни DELETE (0025). Retention журнала (RET-02)
// здесь НЕ реализуется — отложен (К-15).
//
// Форма карточки ленты не хранится: она собирается на чтении (`journal/thread-page.ts`) из заголовка, тула и записи —
// хранить её значило бы держать вторую копию того, что уже лежит в строке.
import type { GraphId } from '@orbis/shared';
import { type SQL, sql } from 'drizzle-orm';
import { ensureGlobalThread } from '../chat/threads';
import type { Tx } from '../db/with-identity';
import { ExecError } from '../errors';
import { pgErrorInfo } from './executor';
import { actionRecordOf, findBatch, touchedEntityIds } from './journal-read';
import type { ActionRecord, JournalSink, JournalWrite, MutationSource, UndoWrite } from './types';
import { AuditIdConflictError } from './types';

/**
 * Где показать карточку действия (§11.3): правки владельца в интерфейсе (`ui`, `quick_capture`) и системные записи
 * (`system`) — без треда (Р-12, §11.4): у них отмена в интерфейсе, а тред молчит. Агент (`mcp`) треда не передаёт —
 * глобальный тред владельца, как сегодня. Остальные — тред, который передал вызывающий (разговор, ввод, прогон).
 *
 * Решает синк, а не вызывающие: мест с источником `ui` в сервере два десятка (роутеры, одобрение единиц, откат
 * прогона), и правило, размазанное по ним, разошлось бы с первой новой кнопкой. Переданный тред у `ui` игнорируется
 * молча — он значит «где нажали», а не «где показать».
 */
export function journalThreadOf(
  source: MutationSource,
  requested: string | undefined,
): 'none' | 'global' | string {
  if (source === 'ui' || source === 'quick_capture' || source === 'system') return 'none';
  return requested ?? 'global';
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
  results?: unknown[] | { items: unknown[]; consequences: boolean };
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
      const target = journalThreadOf(action.source, entry.threadId);
      // Глобальный тред заводится ТОЛЬКО когда строке он положен: правка владельца в интерфейсе треда не создаёт
      const threadId =
        target === 'none'
          ? null
          : target === 'global'
            ? await ensureGlobalThread(tx, entry.graphId)
            : target;
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
          ...(entry.results !== undefined && {
            results:
              entry.consequences === undefined
                ? entry.results
                : { items: entry.results, consequences: entry.consequences },
          }),
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
        ...(e.consequences !== undefined && { consequences: e.consequences }),
        cardInReply: e.cardInReply,
      };
    },
  };
}
