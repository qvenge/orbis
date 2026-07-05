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
  let queue: QueuedCreate[] = storage.load();

  return {
    enqueue(op) {
      // UUIDv7 (01 §5.3) — генератор из packages/shared при исполнении слайса;
      // crypto.randomUUID() здесь placeholder-скелет (v4, не сортируемый по времени).
      const item: QueuedCreate = {
        ...op,
        clientId: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
      };
      queue = [...queue, item];
      storage.save(queue);
      return item;
    },
    async flush(send) {
      for (const item of [...queue]) {
        const outcome = await send(item);
        if (outcome === 'confirmed' || outcome === 'business_rejection') {
          queue = queue.filter((q) => q.clientId !== item.clientId);
          storage.save(queue);
        }
        // transport_failure — запись остаётся, ретрай следующим вызовом flush()
      }
    },
    cancel(clientId) {
      queue = queue.filter((q) => q.clientId !== clientId);
      storage.save(queue);
    },
    size: () => queue.length,
  };
}
