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

export function recurringInstanceId(templateId: string, dateISO: string): string {
  return uuidv5(`${templateId.toLowerCase()}:${dateISO}`, ORBIS_NAMESPACE);
}
