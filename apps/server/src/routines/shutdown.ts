// apps/server/src/routines/shutdown.ts
// Рубильник процесса для РУЧНЫХ прогонов рутин («прогнать сейчас», routers/routine.ts) —
// хвост C2-1/E2-5 финального ревью V1.
//
// Плановый прогон живёт внутри тика планировщика, и `scheduler.stop()` (Р-12) даёт ему
// AbortSignal и дожидается тика. Ручной прогон запускается из HTTP-запроса fire-and-forget:
// ответ владельцу уходит сразу, а раннер остаётся в фоне без чьего-либо присмотра. Render
// шлёт SIGTERM на каждый деплой — то есть после каждого мержа: без рубильника такой прогон
// продолжал бы звать провайдера, упирался бы в закрытый пул на следующей записи и висел
// `running` до подметания (30 мин), а на это время «прогнать сейчас» отвечало бы «прогон
// уже идёт», и плановый бакет пропускался бы как `running`.
//
// Реестр — сигнал + множество живых прогонов: `shutdown()` дёргает сигнал (раннер закроет
// прогон `failed` «остановлен при выключении процесса» между шагами) и ЖДЁТ, пока все
// закроются, — чтобы `client.end()` в index.ts не рвал пул под транзакцией закрытия.
// Инжектируется через AiDeps (`manualRuns`), боевой путь берёт `manualRuns` этого модуля;
// index.ts зовёт его shutdown рядом с планировщиком, ДО `client.end()`.

export interface RunRegistry {
  /** Сигнал остановки процесса — в `RoutineDeps.signal` ручного прогона. */
  readonly signal: AbortSignal;
  /** Регистрирует фоновый прогон до его завершения; возвращает тот же исход. */
  track<T>(run: Promise<T>): Promise<T>;
  /** Дёргает сигнал и дожидается всех зарегистрированных прогонов (идемпотентно). */
  shutdown(): Promise<void>;
}

export function makeRunRegistry(): RunRegistry {
  const controller = new AbortController();
  const inFlight = new Set<Promise<unknown>>();
  return {
    signal: controller.signal,
    track(run) {
      const tracked = run.finally(() => {
        inFlight.delete(tracked);
      });
      inFlight.add(tracked);
      return tracked;
    },
    async shutdown() {
      controller.abort();
      // allSettled: исход прогона (в т.ч. reject раннера) — дело того, кто его запустил
      // (роутер вешает свой catch); остановке важно только дождаться
      await Promise.allSettled([...inFlight]);
    },
  };
}

/** Один реестр на процесс: его слушает runNow, его останавливает shutdown в index.ts. */
export const manualRuns: RunRegistry = makeRunRegistry();
