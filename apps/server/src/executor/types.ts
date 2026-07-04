// apps/server/src/executor/types.ts
// Точные сигнатуры executor'а (контракт Task 9; на них встают Task 10–15 и весь 1b).
import type { Tx } from '../db/with-identity';

export type ActorKind = 'owner' | 'ai' | 'agent';
// 'ui' — прямое действие владельца в UI (entity.update / relation.*), отличимое в
// журнале от клиентского create ('fast_path'|'quick_capture'), внутреннего чата
// ('chat'), MCP-агента ('mcp') и системного отката ('system').
export type MutationSource = 'chat' | 'fast_path' | 'quick_capture' | 'mcp' | 'ui' | 'system';

export interface ExecuteRequest {
  actorUserId: string; // владелец графа (D11); в MVP актор-владелец = owner
  actorKind: ActorKind;
  source: MutationSource;
  threadId?: string; // тред для audit-сообщения; нет → глобальный тред владельца
  operations: Array<{ tool: string; input: unknown }>; // 1 элемент = одиночный вызов
  batchId?: string; // обязателен при operations.length > 1
  clock?: () => Date; // инъекция времени (тесты); default () => new Date()
}

export interface ExecuteOk {
  ok: true;
  actionId: string;
  results: unknown[]; // по одному на операцию (wire-формы сущностей/relations)
  idempotentReplay: boolean; // true: повтор — ничего не применялось
}

export interface ExecuteErr {
  ok: false;
  error: { code: string; message: string; details?: unknown }; // структурированная (§9.2)
}

export type ExecuteResult = ExecuteOk | ExecuteErr;

/** Wire-форма сущности: core-таймстампы — всегда Date.toISOString() (решение 12 плана). */
export interface WireEntity {
  id: string;
  ownerId: string;
  title: string;
  emoji: string | null;
  body: string;
  bodyRefs: string[];
  tags: string[];
  meta: Record<string, unknown>;
  aspects: Record<string, Record<string, unknown>>;
  createdAt: string;
  updatedAt: string;
  archived: boolean;
}

/** Wire-форма связи (§4.2): таймстампы — toISOString, как у сущностей. */
export interface WireRelation {
  id: string;
  sourceId: string;
  targetId: string;
  relationType: string;
  meta: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// JournalSink — ВРЕМЕННЫЙ интерфейс стадий 6–7 (Task 9/10).
// Executor вычисляет inverse-операции (§7.8) и данные карточки и зовёт sink.write(...)
// В ТОМ ЖЕ tx. Боевой синк в chat_messages подключает Task 11, передавая свою
// реализацию в execute(..., { sink }) — БЕЗ правки executor.ts.
// ---------------------------------------------------------------------------

export interface ActionOperation {
  op: string;
  payload: Record<string, unknown>;
}

/** Элемент журнала действий — формат §7.8 + атрибуция актора (D11). */
export interface ActionRecord {
  id: string;
  type: 'entity_created' | 'entity_updated' | 'relation_created' | 'relation_deleted' | 'batch';
  entity_id: string | null;
  actor_user_id: string;
  actor_kind: ActorKind;
  source: MutationSource;
  operations: ActionOperation[];
  inverse: ActionOperation[]; // в обратном порядке исполнения (§7.8)
}

/** Данные карточки действия для чата (§7.8); полный рендер — территория Task 11+/UI. */
export interface ActionCard {
  tool: string;
  entity_id: string | null;
  title: string;
}

export interface JournalWrite {
  /**
   * Явный PK audit-сообщения. Batch (§7.8) передаёт детерминированный
   * batchAuditMessageId(ownerId, batchId) — уникальность этого id и делает повтор
   * batch проверяемым. Отсутствует → id выбирает реализация синка.
   */
  id?: string;
  ownerId: string;
  threadId?: string; // нет → глобальный тред владельца (резолвит боевой синк, Task 11)
  action: ActionRecord;
  card: ActionCard;
  /** Результаты операций batch — источник ответа идемпотентного повтора (§7.8). */
  results?: unknown[];
}

/**
 * Конфликт PK audit-сообщения: запись с таким id уже существует (batch применён
 * конкурентом/ранее). Семантика PG 23505: боевой синк (Task 11) обязан замапить
 * unique_violation по PK chat_messages на этот класс — executor по нему откатывает
 * tx и возвращает сохранённый результат (§7.8).
 */
export class AuditIdConflictError extends Error {
  readonly code = '23505';
  readonly auditId: string;

  constructor(auditId: string) {
    super(`audit-сообщение ${auditId} уже существует (повтор batch, §7.8)`);
    this.name = 'AuditIdConflictError';
    this.auditId = auditId;
  }
}

export interface JournalSink {
  /**
   * Запись стадий 6–7 В ТОМ ЖЕ tx. Контракт: если entry.id задан и запись с таким id
   * уже существует — реализация ОБЯЗАНА бросить AuditIdConflictError (ничего не записав).
   */
  write(tx: Tx, entry: JournalWrite): Promise<void>;
  /** Поиск audit-записи по детерминированному id — идемпотентность batch (§7.8). */
  findByAuditId(tx: Tx, id: string): Promise<JournalWrite | undefined>;
}

/**
 * In-memory реализация для тестов (стадии 6–7 наблюдаемы без chat_messages):
 * честная уникальность по id с той же семантикой, что PK БД (23505 → AuditIdConflictError).
 * ВАЖНО: гонку конкурентных одинаковых batch'ей полноценно закрывает только реальный
 * PK chat_messages (Task 11) — in-memory хранилище не транзакционно.
 */
export class InMemoryJournalSink implements JournalSink {
  readonly entries: JournalWrite[] = [];

  async write(_tx: Tx, entry: JournalWrite): Promise<void> {
    if (entry.id !== undefined && this.entries.some((e) => e.id === entry.id)) {
      throw new AuditIdConflictError(entry.id);
    }
    this.entries.push(entry);
  }

  async findByAuditId(_tx: Tx, id: string): Promise<JournalWrite | undefined> {
    return this.entries.find((e) => e.id === id);
  }
}

/**
 * ВНУТРЕННИЙ режим executor'а — доступен ТОЛЬКО из undo.ts (Task 11). Не входит в
 * envelope-схемы §9.2 и недостижим через tRPC/тулы: передаётся через ExecutorDeps,
 * которые конструирует исключительно серверный код (в роутеры Task 12 не идёт).
 *
 * Обоснование (§7.8): Undo восстанавливает зафиксированное в журнале прежнее
 * состояние ПОВЕРХ текущего — это осознанный LWW-откат, а не пользовательская
 * правка, поэтому в этом режиме:
 * - body-патчи применяются БЕЗ требования expectedUpdatedAt (§5.2);
 * - аспект-ключи восстанавливаются ЦЕЛИКОМ (замена ключа, а не shallow-merge §9.2,
 *   и без нормализаций §3.2 — иначе пофазовый откат ненадёжен);
 * - relation_create принимает meta восстанавливаемой связи;
 * - вместо записи action вызывается writeUndoMessage: undo не порождает нового
 *   action (undo неотменяем).
 */
export interface InternalUndoMode {
  /** Пишет undo-сообщение {type:'undo', undoes} В ТОМ ЖЕ tx после применения операций. */
  writeUndoMessage(tx: Tx): Promise<void>;
}

/** Зависимости execute; Task 11 передаёт боевой синк здесь. */
export interface ExecutorDeps {
  sink?: JournalSink;
  /** Только из undo.ts — см. InternalUndoMode. */
  internalUndo?: InternalUndoMode;
}
