import type { EntityCreateInput } from '@orbis/shared';
import { useEffect, useSyncExternalStore } from 'react';
import { create } from 'zustand';
import {
  createRetryBuffer,
  type FlushOutcome,
  localStorageQueue,
  type QueuedCreate,
  setQueueScope,
} from '../lib/retry-buffer';

const storage = localStorageQueue;
const buffer = createRetryBuffer(storage);

/**
 * Привязать очередь к владельцу сессии (null — выход). Вызывается AuthProvider'ом ДО рендера
 * дерева, поэтому store здесь не трогаем (обновление чужого store в фазе рендера) —
 * его синхронизирует useRetryFlush на монтировании.
 */
export function setRetryScope(userId: string | null): void {
  setQueueScope(userId);
}

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
    // id из парсера — тот самый UUID, который (возможно) уже принят сервером в упавшей
    // онлайн-попытке: сохраняем его как clientId, иначе ретрай создаст вторую сущность.
    const op = buffer.enqueue({
      tool: 'entity.create',
      payload: { input, source },
      clientId: input.id,
    });
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

/**
 * §2.6/§5.3: автослив retry-буфера. Смонтирован один раз в App (не в render-фазе main.tsx):
 *  - на старте: если онлайн и в буфере есть незасланные fast-path операции — дренируем один раз;
 *  - при переходе offline→online (window 'online') — досылаем накопленное.
 * flushNow сам гейтит отсутствие send-impl (sendImpl===null → no-op), поэтому вызов до
 * registerRetrySend безопасен и не дублирует отправку.
 */
export function useRetryFlush(): void {
  useEffect(() => {
    // Store создан на импорте модуля — до того, как AuthProvider задал скоуп владельца:
    // пересинхронизируем его с очередью текущего пользователя, иначе индикатор «ждут
    // отправки: N» и гейт автослива смотрели бы в чужой (общий) ключ.
    useRetryBuffer.setState(snapshot());
    const flush = () => {
      void useRetryBuffer.getState().flushNow();
    };
    if (navigator.onLine && buffer.size() > 0) flush();
    window.addEventListener('online', flush);
    return () => window.removeEventListener('online', flush);
  }, []);
}

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
