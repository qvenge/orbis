// apps/server/src/routines/locks.ts
// In-process замок по рутине вокруг решения «заводить ли прогон» (V1.3, хвост C1a-5/C2-2).
//
// Инвариант «у рутины не бывает двух идущих прогонов» держится в startBucketRun/startManualRun
// на снимке (прочитали прогоны → создали) — двух вызовов в одно окно этого не сдерживает: у
// планового бакета и ручного прогона РАЗНЫЕ ключи (`routineRunId` от бакета), и ни PK
// сущности, ни детерминированный batch_id проигравшего не останавливают. Межпроцессную гонку
// ОДНОГО бакета (два инстанса на деплое) закрывает Р-1 — batch_id/PK; здесь закрывается
// внутрипроцессная гонка РАЗНЫХ ключей одной рутины: тик и кнопка «прогнать сейчас», два
// нажатия из двух вкладок. Один процесс — одна очередь на рутину; операции разных рутин друг
// друга не ждут.
//
// Замок — часть зависимостей (`RoutineDeps.locks`), а не голый модульный синглтон, ради одного:
// тестам межпроцессной гонки нужно её ЭМУЛИРОВАТЬ, и два экземпляра замка — это два процесса.
// Боевой путь (роутер и планировщик) берёт общий `processRoutineLocks`.

export interface RoutineLocks {
  /** Исполняет `fn` под замком рутины: вызовы по одному id идут строго по очереди. */
  run<T>(routineId: string, fn: () => Promise<T>): Promise<T>;
}

/** Замок как цепочка промисов на рутину: хвост цепочки — тот, за кем встаёт следующий. */
export function makeRoutineLocks(): RoutineLocks {
  const tails = new Map<string, Promise<void>>();
  return {
    async run(routineId, fn) {
      const prev = tails.get(routineId) ?? Promise.resolve();
      let release: () => void = () => {};
      const mine = new Promise<void>((resolve) => {
        release = resolve;
      });
      // Хвост никогда не отклоняется: `mine` резолвится в finally при любом исходе `fn`
      const tail = prev.then(() => mine);
      tails.set(routineId, tail);
      await prev;
      try {
        return await fn();
      } finally {
        release();
        // Убираем ключ, только если за нами никто не встал — иначе затёрли бы чужой хвост
        if (tails.get(routineId) === tail) tails.delete(routineId);
      }
    },
  };
}

/** Один замок на процесс: его делят планировщик и «прогнать сейчас» роутера. */
export const processRoutineLocks: RoutineLocks = makeRoutineLocks();
