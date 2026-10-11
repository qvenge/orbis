import type { JournalRef } from '@orbis/shared';
import type { ExecuteOk } from './types';

/** Ответ сохраняет прежнюю полезную нагрузку; эта пара адресует её действие журнала. */
export function journalRef(result: ExecuteOk): JournalRef {
  return { actionId: result.actionId, consequences: result.consequences };
}
