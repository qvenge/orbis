import type { JournalRef } from '@orbis/shared';
/** Старый approval wire отмены несёт actionId, но не consequences: отмена не новое действие. */
export function journalRefOf(data: unknown): JournalRef | null {
  const r = data as Partial<JournalRef> | null | undefined;
  return typeof r?.actionId === 'string' && typeof r.consequences === 'boolean'
    ? { actionId: r.actionId, consequences: r.consequences }
    : null;
}
