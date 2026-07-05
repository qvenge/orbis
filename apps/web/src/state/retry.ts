import type { EntityCreateInput } from '@orbis/shared';
import { useSyncExternalStore } from 'react';
import { create } from 'zustand';
import {
  createRetryBuffer,
  type FlushOutcome,
  localStorageQueue,
  type QueuedCreate,
} from '../lib/retry-buffer';

const storage = localStorageQueue;
const buffer = createRetryBuffer(storage);

export type RetrySend = (op: QueuedCreate) => Promise<FlushOutcome>;
let sendImpl: RetrySend | null = null;
// Task 8 регистрирует реальный send (entity.create + mapSendError).
export function registerRetrySend(fn: RetrySend) {
  sendImpl = fn;
}

type RetryState = {
  size: number;
  pending: QueuedCreate[];
  enqueueCreate: (input: EntityCreateInput, source: 'fast_path') => QueuedCreate;
  flushNow: () => Promise<void>;
  cancel: (clientId: string) => void;
};

// storage.load() — авторитетный источник оставшихся операций (buffer.flush их удаляет/оставляет).
function snapshot(): { size: number; pending: QueuedCreate[] } {
  const items = storage.load();
  return { size: items.length, pending: items };
}

export const useRetryBuffer = create<RetryState>((set) => ({
  ...snapshot(),
  enqueueCreate: (input, source) => {
    const op = buffer.enqueue({ tool: 'entity.create', payload: { input, source } });
    set(snapshot());
    return op;
  },
  flushNow: async () => {
    if (!sendImpl) return;
    await buffer.flush(sendImpl);
    set(snapshot());
  },
  cancel: (clientId) => {
    buffer.cancel(clientId);
    set(snapshot());
  },
}));

export function useOnline(): boolean {
  return useSyncExternalStore(
    (cb) => {
      window.addEventListener('online', cb);
      window.addEventListener('offline', cb);
      return () => {
        window.removeEventListener('online', cb);
        window.removeEventListener('offline', cb);
      };
    },
    () => navigator.onLine,
    () => true,
  );
}
