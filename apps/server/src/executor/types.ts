// apps/server/src/executor/types.ts
// Точные сигнатуры executor'а (контракт Task 9; на них встают Task 10–15 и весь 1b).
import type { Tx } from '../db/with-identity';

export type ActorKind = 'owner' | 'ai' | 'agent';
export type MutationSource = 'chat' | 'fast_path' | 'quick_capture' | 'mcp' | 'system';

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

// ---------------------------------------------------------------------------
// JournalSink — ВРЕМЕННЫЙ интерфейс стадий 6–7 (Task 9).
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
  ownerId: string;
  threadId?: string; // нет → глобальный тред владельца (резолвит боевой синк, Task 11)
  action: ActionRecord;
  card: ActionCard;
}

export interface JournalSink {
  write(tx: Tx, entry: JournalWrite): Promise<void>;
}

/** In-memory реализация для тестов (стадии 6–7 наблюдаемы без chat_messages). */
export class InMemoryJournalSink implements JournalSink {
  readonly entries: JournalWrite[] = [];

  async write(_tx: Tx, entry: JournalWrite): Promise<void> {
    this.entries.push(entry);
  }
}

/** Зависимости execute; Task 11 передаёт боевой синк здесь. */
export interface ExecutorDeps {
  sink?: JournalSink;
}
