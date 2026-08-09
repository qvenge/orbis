import type { EntityCreateInput } from '@orbis/shared';
import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import { create } from 'zustand';
import { invalidateGraph } from '../lib/invalidate';
import {
  createRetryBuffer,
  type FlushOutcome,
  localStorageQueue,
  type QueuedCreate,
  setQueueScope,
} from '../lib/retry-buffer';
import { trpc } from '../trpc';

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

/** Идущий слив (см. flushNow): на весь модуль один, буфер и store тоже синглтоны. */
let inFlight: Promise<number> | null = null;

type RetryState = {
  size: number;
  pending: QueuedCreate[];
  enqueueCreate: (input: EntityCreateInput, source: 'fast_path') => QueuedCreate;
  /** Возвращает число подтверждённых операций — на нём висит инвалидация графа. */
  flushNow: () => Promise<number>;
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
    const send = sendImpl;
    if (!send) return 0;
    // Слив сериализован: два параллельных вызова видели ОДИН снимок очереди
    // (lib/retry-buffer/index.ts удаляет запись только ПОСЛЕ await send) и слали каждую
    // операцию дважды. Сервер идемпотентен по client-UUID, поэтому дублей сущностей не
    // возникало, но лишние запросы приходились ровно на момент, когда сети нет.
    // Опоздавший вызов разделяет промис ведущего, а не ждёт очереди: слив ниже сам
    // дочитывает очередь до конца, поэтому «дождаться этого» и «дождаться своего» —
    // одно и то же.
    if (inFlight) return inFlight;
    inFlight = (async () => {
      let total = 0;
      try {
        // Проходов может быть несколько: очередь пополняется ВО ВРЕМЯ слива — fast-path
        // кладёт запись и тут же зовёт flush, попадая в этот самый разделённый промис.
        // Без доп. прохода такая запись ждала бы следующего триггера, а их наперечёт.
        for (;;) {
          const before = storage.load();
          if (before.length === 0) break;
          total += await buffer.flush(send);
          const left = new Set(storage.load().map((q) => q.clientId));
          // Прогресс = ушла хоть одна запись ЭТОГО снимка. Сравнивать размеры очереди
          // нельзя: пополнение во время слива читалось бы как «сеть по-прежнему лежит»
          // (и наоборот — вечный цикл, если бы условие смотрело только на пустоту).
          if (before.every((q) => left.has(q.clientId))) break;
        }
        return total;
      } finally {
        set(snapshot());
        inFlight = null;
      }
    })();
    return inFlight;
  },
  cancel: (clientId) => {
    buffer.cancel(clientId);
    set(snapshot());
  },
}));

/**
 * Слив буфера, ПОСЛЕ КОТОРОГО граф перечитывается (Р17, круг правок 2). Единственный путь
 * записи, идущий мимо React Query: операции уходят vanilla-клиентом
 * (`state/retry-send.ts`), и mutation-хука, к которому можно было бы прицепить
 * инвалидацию, у них нет. Без этой обёртки самый заметный сценарий буфера — «писал офлайн,
 * вернулся в сеть» — заканчивался тем, что запись легла на сервер, а список, на который
 * человек смотрит, её не показывает.
 *
 * Инвалидация висит на ПОДТВЕРЖДЁННОМ успехе (confirmed > 0), а не на самой попытке:
 * business_rejection тоже чистит очередь, но графа не меняет, и перечитывать по нему
 * нечего. Буфер — исторически хрупкое место, и лишний перечит здесь хуже, чем кажется:
 * он маскирует отказ видимостью работы.
 */
export function useFlushBuffer(): () => Promise<void> {
  const utils = trpc.useUtils();
  const flushNow = useRetryBuffer((s) => s.flushNow);
  return useCallback(async () => {
    if ((await flushNow()) > 0) invalidateGraph(utils);
  }, [flushNow, utils]);
}

/**
 * §2.6/§5.3: автослив retry-буфера. Смонтирован один раз в App (не в render-фазе main.tsx):
 *  - на старте: если онлайн и в буфере есть незасланные fast-path операции — дренируем один раз;
 *  - при переходе offline→online (window 'online') — досылаем накопленное.
 * flushNow сам гейтит отсутствие send-impl (sendImpl===null → no-op), поэтому вызов до
 * registerRetrySend безопасен и не дублирует отправку.
 */
export function useRetryFlush(): void {
  // Функция слива живёт в ref, а эффект — с пустыми зависимостями. Иначе (flush в deps)
  // любая смена ссылки пересобирала бы подписку И заново дренировала буфер прямо в
  // рендер-цикле, пока очередь непуста.
  const flush = useFlushBuffer();
  const flushRef = useRef(flush);
  useEffect(() => {
    flushRef.current = flush;
  }, [flush]);
  useEffect(() => {
    // Store создан на импорте модуля — до того, как AuthProvider задал скоуп владельца:
    // пересинхронизируем его с очередью текущего пользователя, иначе индикатор «ждут
    // отправки: N» и гейт автослива смотрели бы в чужой (общий) ключ.
    useRetryBuffer.setState(snapshot());
    const run = () => {
      void flushRef.current();
    };
    if (navigator.onLine && buffer.size() > 0) run();
    window.addEventListener('online', run);
    return () => window.removeEventListener('online', run);
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
