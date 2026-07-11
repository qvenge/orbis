// Формулы — дословно PRD 01 §5.4 (инстансы), §4.5 (треды), §7.8 (batch-audit).
// Формулы с owner_id — workspace-scoped при введении workspace'ов (D11).
import { v5 as uuidv5, v7 as uuidv7 } from 'uuid';

export const ORBIS_NAMESPACE = 'cb339e97-82d7-4d16-91c6-942d42df7054';

/** Client-generated id (UUIDv7 — время в префиксе, 01 §2.1). */
export function newId(): string {
  return uuidv7();
}

export function globalThreadId(ownerId: string): string {
  return uuidv5(`${ownerId.toLowerCase()}:global-thread`, ORBIS_NAMESPACE);
}

export function entityThreadId(ownerId: string, entityId: string): string {
  return uuidv5(
    `${ownerId.toLowerCase()}:entity-thread:${entityId.toLowerCase()}`,
    ORBIS_NAMESPACE,
  );
}

export function batchAuditMessageId(ownerId: string, batchId: string): string {
  return uuidv5(`batch:${ownerId.toLowerCase()}:${batchId.toLowerCase()}`, ORBIS_NAMESPACE);
}

/** PK reject-сообщения pending-подтверждения (§7.10): идемпотентность reject по PK. */
export function rejectMessageId(ownerId: string, pendingId: string): string {
  return uuidv5(`reject:${ownerId.toLowerCase()}:${pendingId.toLowerCase()}`, ORBIS_NAMESPACE);
}

/**
 * PK карточки-запроса pending-подтверждения (§7.10), детерминированный по исходному
 * batch_id модели: ретрай того же batch на explicit-уровне даёт тот же PK → ON CONFLICT
 * не плодит вторую pending-карточку (митигация Minor-4 Task 6). Server-derived — с сырым
 * batch_id клиента не совпадает (approve исполняет batch_id = pendingId, §7.10).
 */
export function pendingMessageId(ownerId: string, batchId: string): string {
  return uuidv5(`pending:${ownerId.toLowerCase()}:${batchId.toLowerCase()}`, ORBIS_NAMESPACE);
}

/**
 * PK системного маркера «ответ готовится» (ai.sendMessage): детерминирован по
 * client-UUID user-сообщения — конкурентный ретрай того же сообщения находит маркер
 * первого прогона и не запускает второй tool-цикл. Owner в формуле не нужен:
 * client-UUID уникален сам по себе.
 */
export function processingMessageId(userMessageId: string): string {
  return uuidv5(`processing:${userMessageId.toLowerCase()}`, ORBIS_NAMESPACE);
}

export function recurringInstanceId(templateId: string, dateISO: string): string {
  return uuidv5(`${templateId.toLowerCase()}:${dateISO}`, ORBIS_NAMESPACE);
}

/**
 * batch_id материализации окна одного шаблона (§5.4, Task A3): повтор того же окна
 * тем же шаблоном — тот же batch → идемпотентный replay по audit-PK (§7.8).
 * from/to — 'YYYY-MM-DD' эффективного (обрезанного горизонтом) окна.
 */
export function materializeBatchId(templateId: string, from: string, to: string): string {
  return uuidv5(`materialize:${templateId.toLowerCase()}:${from}:${to}`, ORBIS_NAMESPACE);
}

/**
 * batch_id перехода planned→fact recurring-инстанса (01 §3.3, Task A5) — формула
 * спеки дословно: uuidv5(NS, "post-financial:<instance_id>"). Детерминирован
 * инстансом: конкурентные выполнения transition с разных устройств сходятся к
 * одному action по audit-PK (§7.8), а Undo перехода «липкий» — повтор реплеится.
 */
export function postFinancialBatchId(instanceId: string): string {
  return uuidv5(`post-financial:${instanceId.toLowerCase()}`, ORBIS_NAMESPACE);
}
