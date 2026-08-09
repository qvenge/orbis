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

/**
 * Потолок проходов одного слива. Проходы нужны для записей, легших в очередь ВО ВРЕМЯ
 * слива (см. flushNow), но слив обязан заканчиваться при любом поведении отправки:
 * недобранное заберёт следующий триггер, а бесконечный цикл забрать некому.
 */
const MAX_FLUSH_PASSES = 8;

type RetryState = {
  size: number;
  pending: QueuedCreate[];
  /**
   * Идёт слив. Живёт в store, а не в компоненте: слив один на приложение (сериализован
   * ниже), а кнопок досыла и автосливов — сколько угодно, и каждая обязана видеть чужой.
   */
  flushing: boolean;
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
  flushing: false,
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
    // Транспорт фиксируется на весь слив: registerRetrySend может подменить sendImpl
    // посреди прохода (перевыпуск токена, тесты), и тогда одна очередь ушла бы двумя
    // разными клиентами — исходы в пределах одного слива стали бы несопоставимы.
    const send = sendImpl;
    if (!send) return 0;
    // Слив сериализован: два параллельных вызова видели ОДИН снимок очереди
    // (lib/retry-buffer/index.ts удаляет запись только ПОСЛЕ await send) и слали каждую
    // операцию дважды. Сервер идемпотентен по client-UUID, поэтому дублей сущностей не
    // возникало, но лишние запросы приходились ровно на момент, когда сети нет.
    // Опоздавший вызов разделяет промис ведущего, а не ждёт очереди: слив ниже сам
    // дочитывает очередь до конца, поэтому «дождаться этого» и «дождаться своего» —
    // одно и то же. Разделённый промис ОБЯЗАН оседать, иначе к нему присоединятся все
    // следующие вызовы и буфер замолчит до перезагрузки, — предел ожидания отправки
    // держит state/retry-send.ts.
    if (inFlight) return inFlight;
    set({ flushing: true });
    inFlight = (async () => {
      let total = 0;
      try {
        // Проходов может быть несколько: очередь пополняется ВО ВРЕМЯ слива — fast-path
        // кладёт запись и тут же зовёт flush, попадая в этот самый разделённый промис.
        // Без доп. прохода такая запись ждала бы следующего триггера, а их наперечёт.
        for (let pass = 0; pass < MAX_FLUSH_PASSES; pass += 1) {
          const before = storage.load();
          if (before.length === 0) break;
          const known = new Set(before.map((q) => q.clientId));
          total += await buffer.flush(send);
          // Ещё проход — ТОЛЬКО если появилась НОВАЯ запись. Условие «ушла хоть одна»
          // здесь не годится: при смешанном исходе (одна упала, другая прошла) следующий
          // проход обошёл бы ВСЮ очередь и переслал только что упавшую — тот же лишний
          // трафик, ради которого правка и делалась, только по другой оси: N записей,
          // падающих по разу, давали бы порядка N²/2 запросов, и без всякого бэкоффа.
          if (storage.load().every((q) => known.has(q.clientId))) break;
        }
        return total;
      } finally {
        inFlight = null;
        set({ ...snapshot(), flushing: false });
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
 *
 * Число подтверждённых уходит и вызывающему: по нему кнопка досыла (ChatScreen) решает,
 * жаловаться ли на неудачу. Считать это по размеру очереди «до и после» нельзя — размер
 * врёт в обе стороны: запись, легшая в очередь ВО ВРЕМЯ слива, выглядит как отказ, а
 * слив, где одна запись прошла, а другая упала, выглядит как удача.
 */
export function useFlushBuffer(): () => Promise<number> {
  const utils = trpc.useUtils();
  const flushNow = useRetryBuffer((s) => s.flushNow);
  return useCallback(async () => {
    const confirmed = await flushNow();
    if (confirmed > 0) invalidateGraph(utils);
    return confirmed;
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
