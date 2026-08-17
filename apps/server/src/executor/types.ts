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
  /**
   * Грант внешнего агента, от имени которого идёт мутация (С2) — доезжает до записи
   * журнала как actor_grant_id. Нет у владельческих и чатовых путей: за ними стоит сам
   * владелец, а не выданный кому-то доступ.
   */
  actorGrantId?: string;
  /** Прогон агента, в рамках которого сделана мутация (С2) — в журнале как run_id. */
  runId?: string;
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
  /**
   * Структурная форма тела. Едет ТОЛЬКО по include('bodyDoc') — см. Р6 дизайна: wire-форма
   * несёт body всегда, и второй экземпляр тела в каждом ответе удвоил бы вес любого списка.
   * Отсюда и опциональность ключа: `undefined` = «не запрашивали», а не «документа нет».
   */
  bodyDoc?: { v: number; doc: Record<string, unknown> } | null;
  bodyRefs: string[];
  tags: string[];
  meta: Record<string, unknown>;
  aspects: Record<string, Record<string, unknown>>;
  createdAt: string;
  updatedAt: string;
  archived: boolean;
}

/**
 * Wire-форма строки provenance (01-arch §4.8, 03-budget §3.4.1): результат внутренних
 * операций entity_origin_create / entity_origin_delete. Не сущность и не связь —
 * отдельный тип, а не приведение чужого: в publicном контракте §9.2 origins не значатся.
 */
export interface WireOrigin {
  id: string;
  entityId: string;
  namespace: string;
  externalId: string;
  createdAt: string;
}

/**
 * Wire-форма закреплённой версии тела (С11): результат внутренних операций
 * entity_version_pin / entity_version_delete. Соседствует с WireOrigin по той же причине —
 * это не сущность и не связь, а строка служебной таблицы, которой в публичном контракте
 * §9.2 нет.
 *
 * Тела здесь нет НАМЕРЕННО: список версий рисует подписи и даты, а тащить в него по два
 * тела на строку (markdown + документ) значит грузить экран текстом, который никто не
 * читает. Вместо документа едет признак `hasDoc` — снимок сущности, чьё тело ещё не
 * сконвертировано, хранит только markdown (body_doc IS NULL).
 */
export interface WireEntityVersion {
  id: string;
  entityId: string;
  label: string;
  hasDoc: boolean;
  actorKind: ActorKind;
  createdAt: string;
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
  // origin_created/origin_deleted — provenance импорта (§4.8): не сущность и не связь,
  // поэтому честный собственный вариант. Расширение аддитивно: исчерпывающих switch
  // по этому полю в коде нет (журнал читает только по id/inverse — undo.ts, journal.ts).
  //
  // Сегодня В ЗАПИСЬ они не попадают: единственный вызывающий origin-операций —
  // confirmImport, а он всегда задаёт batchId, и весь импорт журналируется одним
  // action типа 'batch'. Варианты оставлены намеренно: их несут JournalPlan'ы этих
  // операций (executor.ts prepareOriginCreate/prepareOriginDelete), и они станут
  // наблюдаемыми у первого НЕ-batch вызывающего — убирать их значило бы заводить
  // отдельный, более узкий тип для плана той же операции.
  //
  // version_pinned/version_deleted — закрепление версии тела (С11): та же аддитивность.
  // В отличие от origin-вариантов, version_pinned в записи НАБЛЮДАЕМ: version.pin —
  // одиночный (не batch) вызывающий, его action ложится в журнал этим типом, и по нему
  // «отмени последнее» находит закрепление. version_deleted достижим только как inverse.
  type:
    | 'entity_created'
    | 'entity_updated'
    | 'relation_created'
    | 'relation_deleted'
    | 'origin_created'
    | 'origin_deleted'
    | 'version_pinned'
    | 'version_deleted'
    | 'batch';
  entity_id: string | null;
  actor_user_id: string;
  actor_kind: ActorKind;
  source: MutationSource;
  /**
   * Грант и прогон агента (С2) — вторая половина атрибуции: actor_kind говорит «агент»,
   * эта пара — КАКОЙ агент и в каком прогоне.
   *
   * Опциональны ПО ОТСУТСТВИЮ КЛЮЧА, а не по null, и это не стилистика: действия прогона
   * ищутся контейнмент-пробой `metadata @> {"actions":[{"run_id": …}]}` — единственным
   * предикатом, который берёт jsonb-индекс. Запись `"run_id": null` у каждого действия
   * владельца сделала бы такую пробу ложно-положительной для проб с null и удвоила бы
   * пустыми ключами вес всего журнала. Отсюда и условная сборка в executor.ts.
   */
  actor_grant_id?: string;
  run_id?: string;
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
  /**
   * Вызывается ПЕРВЫМ statement'ом withIdentity-tx execute — до реестра, replay-проверки
   * и стадий 1–7. Единственный потребитель — сериализация pending-подтверждений §7.10
   * (policy/pending, fix round Task 6): advisory-lock по pendingId + перепроверка
   * «не отклонён» В ТОМ ЖЕ tx, где пишется audit-сообщение, — иначе approve и reject
   * образуют write-skew (оба проходят свои проверки до чужого коммита). Санкционировано
   * координатором как минимальное расширение; других потребителей не заводить без нужды.
   */
  beforeStages?: (tx: Tx) => Promise<void>;
}
