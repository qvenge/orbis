// apps/server/src/routines/scheduler.ts
// Планировщик рутин (V1.2): тик раз в минуту внутри процесса сервера. Тик — сменная
// деталь: вся логика «что сейчас должно быть отработано» лежит в dueBuckets/startBucketRun
// и не зависит от того, бодрствовал ли сервер, — пропущенные тики догоняются в окне.
//
// Обход владельцев без обхода RLS (V1.13, инвариант 14): список — служебной ролью по узкой
// политике (ownerIdsForScheduler), вся работа по владельцу — под withIdentity(владелец).
//
// Тик заодно зовёт подметание (V1.12): зависший прогон рутины закрывается `failed` ДО
// решения о запуске — только так умерший процесс даёт ретрай, а не вечный `running`. Тем
// же вызовом закрывается дыра среза 1: брошенные грантовые прогоны подметались только по
// приходу агента за очередью.
import { activeRoutines } from '../agent-loop/queries';
import { sweepStaleRuns } from '../agent-loop/sweep';
import { withIdentity } from '../db/with-identity';
import { ownerTimeZone } from '../query/context';
import { TICK_INTERVAL_MS } from './constants';
import { pauseIfFailing, type RoutineDeps, type StartOutcome, startBucketRun } from './lifecycle';
import { ownerIdsForScheduler } from './queries';
import { runRoutineRun } from './runner';
import { dueBuckets } from './schedule';

export interface TickResult {
  /** Сколько владельцев обошёл тик. */
  owners: number;
  /** Сколько зависших прогонов закрыло подметание. */
  swept: number;
  /** Рутины, которые ЭТОТ тик поставил на паузу стоп-краном (после подметания, до запуска). */
  paused: string[];
  /** id прогонов, созданных ЭТИМ тиком (и отработанных им же — инвариант 1). */
  started: string[];
  /** Наступившие бакеты, по которым прогон не заведён, с причиной (см. StartOutcome). */
  skipped: Array<{
    routineId: string;
    bucket: string;
    reason: Extract<StartOutcome, { started: false }>['reason'];
  }>;
}

/**
 * Один тик: владельцы → под identity каждого: подметание → активные рутины → стоп-кран по
 * графу → наступившие бакеты → запуск → цикл модели, последовательно.
 *
 * Стоп-кран В ТИКЕ (хвост C1b-3): раннер зовёт pauseIfFailing только после СВОЕГО сбоя, а
 * прогон, закрытый подметанием (SIGKILL, OOM — крэш-луп процесса), через раннер не проходит.
 * Три подряд подметённых провала оставляли рутину активной, и инвариант 12 нарушался до
 * первого «живого» сбоя. Оценка по графу идемпотентна и дешёва (один запрос на рутину), а
 * стоит она ДО решения о запуске: поставленная на паузу рутина бакет этим тиком не получает.
 *
 * Последовательно, а не параллельно, намеренно: у free-инстанса один процесс и три
 * соединения в пуле, а прогон — это до восьми обращений к модели; параллельные прогоны
 * толкались бы за пул и за лимит провайдера. Тик, который не успел за минуту, просто
 * пропускает следующий (startRoutineScheduler) — бакеты никуда не деваются.
 *
 * Ошибка одной рутины (или подметания одного владельца) логируется и не роняет тик: утро
 * одного владельца не должно отменять утро остальных. Раннер бросает только при падении
 * самого закрытия прогона — тогда прогон остаётся `running`, и его подберёт подметание
 * следующего тика.
 *
 * Рубильник (`deps.signal`) проверяется перед КАЖДЫМ запуском: после stop() новых прогонов
 * не заводим, идущий раннер закроет сам (между шагами) — иначе остановка ждала бы весь
 * оставшийся обход.
 */
export async function routineTick(deps: RoutineDeps): Promise<TickResult> {
  const owners = await ownerIdsForScheduler(deps.db);
  const result: TickResult = {
    owners: owners.length,
    swept: 0,
    paused: [],
    started: [],
    skipped: [],
  };
  // Функцией, а не полем: рубильник дёргают снаружи между нашими await, а сужение типа по
  // свойству TS держит через весь цикл — «после первой проверки уже не aborted»
  const aborted = (): boolean => deps.signal?.aborted === true;

  for (const ownerId of owners) {
    if (aborted()) break;

    try {
      // Актор подметания — `ai` (Р-7): в тике действует не владелец, а фон сервера;
      // источник у подметания и так `system`. Порог — штатный RUN_STALE_AFTER_MS (30 мин):
      // дедлайн прогона 10 мин, и «нет шагов полчаса» надёжно значит «процесс умер», а не
      // «модель думает».
      const { swept } = await sweepStaleRuns(deps.db, {
        ownerId,
        actorKind: 'ai',
        clock: deps.clock,
      });
      result.swept += swept;
    } catch (e) {
      // Подметание — гигиена перед решением, а не само решение: провал логируем и идём
      // к рутинам — зависший прогон в худшем случае даст «уже идёт» до следующего тика
      console.error(`[routines] подметание владельца ${ownerId} не удалось:`, e);
    }

    let routines: Awaited<ReturnType<typeof activeRoutines>>;
    let timeZone: string;
    try {
      ({ routines, timeZone } = await withIdentity(deps.db, ownerId, async (tx) => ({
        routines: await activeRoutines(tx),
        timeZone: await ownerTimeZone(tx, ownerId),
      })));
    } catch (e) {
      console.error(`[routines] рутины владельца ${ownerId} не прочитаны:`, e);
      continue;
    }

    for (const routine of routines) {
      if (aborted()) break;
      try {
        // Стоп-кран по графу — ДО запуска: подметённые провалы считаются здесь (см. докблок)
        const { paused } = await pauseIfFailing(deps, { ownerId, routineId: routine.id });
        if (paused) {
          result.paused.push(routine.id);
          continue;
        }
        const due = dueBuckets({
          at: routine.routine.at,
          ...(routine.routine.days !== undefined && { days: routine.routine.days }),
          timeZone,
          now: deps.clock(),
        });
        for (const { bucket } of due) {
          if (aborted()) break;
          const outcome = await startBucketRun(deps, { ownerId, routine, bucket });
          if (!outcome.started) {
            result.skipped.push({ routineId: routine.id, bucket, reason: outcome.reason });
            continue;
          }
          result.started.push(outcome.runId);
          // Создатель гонит модель (инвариант 1) — здесь же, тем же тиком
          const end = await runRoutineRun(deps, {
            ownerId,
            routine,
            runId: outcome.runId,
            bucket,
          });
          console.log(
            `[routines] прогон ${outcome.runId} рутины ${routine.id} (${bucket}): ${end.outcome}` +
              (end.reason !== undefined ? ` (${end.reason})` : ''),
          );
        }
      } catch (e) {
        console.error(`[routines] рутина ${routine.id} владельца ${ownerId} — сбой тика:`, e);
      }
    }
  }
  return result;
}

export interface RoutineScheduler {
  /** Останавливает: новых тиков нет, идущий тик получает рубильник и дожидается. */
  stop(): Promise<void>;
  /** Момент начала последнего НАЧАВШЕГОСЯ тика (пропущенные из-за наложения не считаются). */
  lastTickAt(): Date | null;
}

/**
 * Фоновый цикл: setInterval с периодом TICK_INTERVAL_MS. Тик, заставший предыдущий, —
 * пропускается (не ставится в очередь): бакеты догоняются следующим тиком, а очередь из
 * тиков после долгого прогона молотила бы одни и те же «уже идёт»/«отработан».
 *
 * `stop()` (Р-12): рубильник — идущему раннеру (он закроет прогон `failed` «остановлен при
 * выключении процесса» между шагами), интервал снят, идущий тик дожидается — чтобы
 * `client.end()` в shutdown не рвал пул под транзакцией закрытия. Подметание остаётся
 * страховкой на SIGKILL.
 *
 * Исключение тика (не пойманное внутри routineTick — например, упал список владельцев)
 * логируется и процесс не роняет: следующий тик попробует снова.
 */
export function startRoutineScheduler(
  deps: Omit<RoutineDeps, 'signal'>,
  opts: { intervalMs?: number } = {},
): RoutineScheduler {
  const controller = new AbortController();
  const tickDeps: RoutineDeps = { ...deps, signal: controller.signal };
  let inFlight: Promise<void> | null = null;
  let last: Date | null = null;

  const tick = (): void => {
    if (inFlight !== null) return; // предыдущий ещё идёт — этот пропускаем
    last = deps.clock();
    inFlight = routineTick(tickDeps)
      .then(
        () => undefined,
        (e: unknown) => {
          console.error('[routines] тик планировщика упал:', e);
        },
      )
      .finally(() => {
        inFlight = null;
      });
  };

  const timer = setInterval(tick, opts.intervalMs ?? TICK_INTERVAL_MS);

  return {
    async stop() {
      clearInterval(timer);
      controller.abort();
      if (inFlight !== null) await inFlight;
    },
    lastTickAt: () => last,
  };
}
