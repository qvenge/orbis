import { newId } from '@orbis/shared';
import type { QueueStorage } from './storage';
import { localStorageQueue } from './storage';

export type { QueueStorage };
// Re-export storage seam so consumers (state/retry.ts) can inject/observe the queue.
export { localStorageQueue };

export interface QueuedCreate {
  clientId: string;
  tool: string;
  payload: unknown;
  createdAt: string;
}

export type FlushOutcome = 'confirmed' | 'transport_failure' | 'business_rejection';

export interface RetryBuffer {
  enqueue(op: Omit<QueuedCreate, 'clientId' | 'createdAt'>): QueuedCreate;
  flush(send: (op: QueuedCreate) => Promise<FlushOutcome>): Promise<void>;
  cancel(clientId: string): void;
  size(): number;
}

export function createRetryBuffer(storage: QueueStorage = localStorageQueue): RetryBuffer {
  // storage — единственный источник истины (совпадает с state/retry.ts: storage.load()
  // авторитетен). Держать отдельный in-memory кэш нельзя: singleton-буфер разъехался бы
  // со storage при внешней очистке (напр. logout/тесты) — методы читают storage свежим.
  return {
    enqueue(op) {
      // clientId — UUIDv7 (01 §5.3): время в префиксе, сортируемо, идемпотентность по client-UUID.
      const item: QueuedCreate = {
        ...op,
        clientId: newId(),
        createdAt: new Date().toISOString(),
      };
      storage.save([...storage.load(), item]);
      return item;
    },
    async flush(send) {
      for (const item of storage.load()) {
        const outcome = await send(item);
        if (outcome === 'confirmed' || outcome === 'business_rejection') {
          storage.save(storage.load().filter((q) => q.clientId !== item.clientId));
        }
        // transport_failure — запись остаётся, ретрай следующим вызовом flush()
      }
    },
    cancel(clientId) {
      storage.save(storage.load().filter((q) => q.clientId !== clientId));
    },
    size: () => storage.load().length,
  };
}
