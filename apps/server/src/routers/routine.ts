// apps/server/src/routers/routine.ts
// Роутер routine (§9.1, V1) — владельческая половина внутреннего исполнителя: «прогнать
// сейчас» (V1.3), ответ на вопрос прогона (V1.9), чтение предложения и решение по нему
// (V1.6, V1.7), обзор для экрана рутины (V1.14) и ПАЧКА РЕШЕНИЙ прогона — единицы,
// отложенные фоном, с решением по каждой поштучно и «Принять все» разом (D42 §6).
//
// ТОЛЬКО трансляция: правила живут в routines/lifecycle.ts (решения владельца), в
// routines/schedule.ts (календарь) и в routines/runner.ts (цикл модели) — здесь разбор
// входа, подстановка identity и перевод доменных отказов в TRPCError.
//
// Все десять — ownerOnly, и это не осторожность: рутина — доверенность, выданная владельцем,
// и все решения по ней (запустить, ответить, принять план) принимает он сам. Внутреннему
// исполнителю сюда хода нет по построению — его поверхность это глаголы и `orbis_propose`,
// а инвариант запрета по объекту (V1.10) закрывает ему и обходной путь через граф.

import type { RunSummary } from '@orbis/shared';
import { z } from 'zod';
import { routineById, runSummary, runsOfParent } from '../agent-loop/queries';
import { defaultAiDeps } from '../ai/send-message';
import { withIdentity } from '../db/with-identity';
import { ExecError, execErrorToTRPC } from '../errors';
import { ROUTINE_STAGE_PROPERTY } from '../policy/confirmation';
import { type AnswerQuestionResult, listRunUnits, type RunUnit } from '../policy/pending';
import { ownerTimeZone } from '../query/context';
import { editsSchema } from '../routines/edits';
import {
  answerRoutineCheckpoint,
  answerRunQuestion,
  type DecideAllItem,
  type DecideDeferredResult,
  type DecideProposalResult,
  decideAllDeferred,
  decideDeferredUnit,
  decideProposal,
  openProposalsForEntity,
  type ProposalView,
  proposalView,
  type RoutineWriteDeps,
  type StartOutcome,
  startManualRun,
} from '../routines/lifecycle';
import { runRoutineRun } from '../routines/runner';
import { nextBucketAt } from '../routines/schedule';
import { manualRuns } from '../routines/shutdown';
import type { Context } from '../trpc';
import { ownerOnlyProcedure, router } from '../trpc';

/** Потолок ответа — тот же, что у вопроса чекпойнта в схеме аспекта (4000). */
const answerCheckpointInput = z
  .object({ runId: z.string().uuid(), answer: z.string().min(1).max(4000) })
  .strict();

const routineIdInput = z.object({ routineId: z.string().uuid() }).strict();
const runIdInput = z.object({ runId: z.string().uuid() }).strict();

/**
 * Состояние рутины для её экрана (V1.14): когда сработает в следующий раз, чем кончился
 * прошлый прогон, сколько её вопросов ждут ответа, висит ли нерешённое предложение и у
 * скольких прогонов осталась неразобранная пачка (D42).
 *
 * Одна процедура, а не пять: экран показывает это ОДНИМ блоком, и пять запросов дали бы
 * ему пять моментов времени вместо одного снимка.
 *
 * ТРИ ВИДА ОЖИДАНИЯ РАЗНЕСЕНЫ ПО ТРЁМ ПОЛЯМ намеренно: терминальный вопрос (`waiting`),
 * предложение (`openProposal`) и пачка (`undecided`) решаются разными кнопками на разных
 * экранах, и общая цифра обещала бы владельцу одно действие вместо трёх.
 */
export interface RoutineOverview {
  /** ISO следующего срабатывания; `null` — рутина на паузе (сработать ей нечем). */
  nextBucketAt: string | null;
  lastRun: RunSummary | null;
  /** Сколько прогонов рутины ждут ответа владельца (исход `checkpoint`). */
  waiting: number;
  /** Есть ли нерешённое предложение — по нему экран рисует «ждёт решения». */
  openProposal: boolean;
  /** Сколько прогонов рутины несут неразобранную пачку (флажок `undecided`). */
  undecided: number;
}

/**
 * Часы запроса. Берутся из инжектируемых AI-зависимостей потому, что это единственный
 * шов времени в контексте tRPC: тесты подменяют его там же, где провайдера, а боевой путь
 * получает обычное «сейчас». Своего второго шва заводить незачем — разъехались бы.
 */
function clockOf(ctx: Context): () => Date {
  return ctx.ai?.clock ?? (() => new Date());
}

function writeDeps(ctx: Context): RoutineWriteDeps {
  return { db: ctx.db, clock: clockOf(ctx) };
}

/** Отказ запуска (V1.3) в терминах поверхности: занято, исчерпано или гонка. */
function startRefusal(outcome: Extract<StartOutcome, { started: false }>): never {
  if (outcome.reason === 'running') {
    throw new ExecError('CONFLICT', 'прогон уже идёт', { reason: outcome.reason });
  }
  if (outcome.reason === 'limit') {
    throw new ExecError('LIMIT', 'на сегодня лимит прогонов рутины исчерпан', {
      reason: outcome.reason,
    });
  }
  // Остальные причины ручному запуску недостижимы (ретраев и слотов у него нет), кроме
  // проигранной гонки двух нажатий в одну миллисекунду: для владельца это то же «занято»
  throw new ExecError('CONFLICT', 'прогон уже создан', { reason: outcome.reason });
}

export const routineRouter = router({
  /**
   * «Прогнать сейчас» (V1.3, приёмка 10): создаёт РУЧНОЙ прогон и отвечает его id, не
   * дожидаясь модели. Цикл уходит в фон — иначе кнопка держала бы запрос все десять минут
   * дедлайна прогона, а мобильный клиент отвалился бы по таймауту задолго до исхода.
   *
   * Прогон на паузе разрешён намеренно: пауза — это «не запускать по расписанию», а рука
   * владельца выше расписания (и ровно ею проверяют, починилась ли сломанная рутина).
   *
   * Фон не ждём, но СТОРОЖИМ остановку процесса (routines/shutdown.ts): прогон получает
   * сигнал реестра и регистрируется в нём, и shutdown index.ts дёргает рубильник (раннер
   * закроет прогон `failed` «остановлен при выключении процесса» между шагами) и дожидается
   * закрытия до `client.end()` — иначе после SIGTERM (каждый деплой) ручной прогон висел бы
   * `running` до подметания (30 мин), блокируя и кнопку, и плановый бакет. «Кто создал прогон,
   * тот и гонит модель» (инвариант 1) сохраняется; SIGKILL по-прежнему чинит подметание.
   * `.catch(console.error)`: необработанный reject уронил бы процесс, а раннер и так
   * закрывает прогон сам на любом исходе.
   */
  runNow: ownerOnlyProcedure
    .input(routineIdInput)
    .mutation(async ({ ctx, input }): Promise<{ runId: string }> => {
      try {
        const ai = ctx.ai ?? defaultAiDeps();
        const runs = ai.manualRuns ?? manualRuns;
        // Рубильник уже дёрнут (процесс останавливается): заводить прогон бессмысленно —
        // раннер закрыл бы его `failed aborted` на первом же шаге, попутно погасив открытое
        // предложение прошлого прогона (supersedeOpen). Отказ ДО любой записи; клиент
        // повторит после редеплоя
        if (runs.signal.aborted) {
          throw new ExecError('CONFLICT', 'сервер останавливается — повторите через минуту', {
            reason: 'shutting_down',
          });
        }
        const { routine, timeZone } = await withIdentity(ctx.db, ctx.actorUserId, async (tx) => ({
          routine: await routineById(tx, input.routineId),
          timeZone: await ownerTimeZone(tx, ctx.actorUserId),
        }));
        // Чужая, архивная и несуществующая под RLS неразличимы — единый NOT_FOUND
        if (routine === null) {
          throw new ExecError('NOT_FOUND', 'рутина не найдена', { routineId: input.routineId });
        }

        const deps = {
          db: ctx.db,
          provider: ai.provider,
          model: ai.model,
          entitlements: ai.entitlements,
          clock: ai.clock ?? (() => new Date()),
          signal: runs.signal,
        };
        const started = await startManualRun(deps, {
          ownerId: ctx.actorUserId,
          routine,
          timeZone,
        });
        if (!started.started) startRefusal(started);

        void runs
          .track(
            runRoutineRun(deps, {
              ownerId: ctx.actorUserId,
              routine,
              runId: started.runId,
              bucket: started.bucket,
            }),
          )
          .catch(console.error);
        return { runId: started.runId };
      } catch (e) {
        if (e instanceof ExecError) throw execErrorToTRPC(e);
        throw e;
      }
    }),

  /**
   * Ответ владельца на вопрос прогона рутины (V1.9, приёмка 10). Тело — lifecycle.ts;
   * здесь только трансляция отказов.
   */
  answerCheckpoint: ownerOnlyProcedure
    .input(answerCheckpointInput)
    .mutation(async ({ ctx, input }): Promise<{ runId: string }> => {
      try {
        return await answerRoutineCheckpoint(writeDeps(ctx), {
          ownerId: ctx.actorUserId,
          runId: input.runId,
          answer: input.answer,
        });
      } catch (e) {
        if (e instanceof ExecError) throw execErrorToTRPC(e);
        throw e;
      }
    }),

  /**
   * Предложение прогона для карточки (V1.6, V1.14): операции построчно с заголовками
   * сущностей и парой «было — станет». `null` значит «показывать нечего» и ошибкой не
   * является: карточка открывается и у прогона, который предложения не подавал.
   */
  proposal: ownerOnlyProcedure
    .input(runIdInput)
    .query(
      ({ ctx, input }): Promise<ProposalView | null> =>
        proposalView(ctx.db, { ownerId: ctx.actorUserId, runId: input.runId }),
    ),

  /**
   * Открытые предложения рутин по записи (Ш1.3): чем экран записи отвечает на «есть ли по
   * мне план, которого я не видел». Список, а не одно: одну запись законно трогают
   * предложения разных рутин, и решение по каждому своё (приёмка 18). Пустой список —
   * обычный ответ, а не отсутствие.
   *
   * `ownerOnly`, как весь роутер: `entity.*` читается на `protectedProcedure`, и такая же
   * процедура отдала бы PAT-агенту чужие планы владельца вместе с их операциями.
   */
  proposalsForEntity: ownerOnlyProcedure
    .input(z.object({ entityId: z.string().uuid() }).strict())
    .query(
      ({ ctx, input }): Promise<ProposalView[]> =>
        openProposalsForEntity(ctx.db, { ownerId: ctx.actorUserId, entityId: input.entityId }),
    ),

  /**
   * Решение владельца по предложению (V1.6, V1.7; приёмка 2, 4, 5). Устаревшее предложение
   * и уже принятое решение едут ЗНАЧЕНИЕМ, а не TRPCError: экран рисует по ним список
   * расхождений и подпись статуса, а не плашку ошибки (та же логика, что у agentRun.rollback).
   */
  decideProposal: ownerOnlyProcedure
    .input(
      z
        .object({
          runId: z.string().uuid(),
          /**
           * Предложение, которое владелец ВИДЕЛ. Обязательно: у прогона их бывает
           * несколько, и решение без адреса применило бы то, чего он не читал. Цена —
           * вкладка, открытая до этого деплоя, получит VALIDATION до перезагрузки; громкий
           * отказ безопаснее тихого исполнения чужого payload'а.
           */
          pendingId: z.string().uuid(),
          decision: z.enum(['approve', 'reject']),
          /**
           * Что владелец поправил в предложении перед принятием (Ш1.4): значения полей и
           * тело документом. Правка порождает НОВОЕ предложение — правила и потолки живут
           * в routines/edits.ts, здесь только форма входа.
           */
          edits: editsSchema.optional(),
        })
        .strict(),
    )
    .mutation(async ({ ctx, input }): Promise<DecideProposalResult> => {
      try {
        return await decideProposal(writeDeps(ctx), {
          ownerId: ctx.actorUserId,
          runId: input.runId,
          pendingId: input.pendingId,
          decision: input.decision,
          edits: input.edits,
        });
      } catch (e) {
        if (e instanceof ExecError) throw execErrorToTRPC(e);
        throw e;
      }
    }),

  /**
   * Решение владельца по ЕДИНИЦЕ пачки (D42 §6; приёмки 3, 4, 10). Как и у предложения,
   * устаревшее и уже решённое едут ЗНАЧЕНИЕМ: экран рисует по ним расхождения и подпись
   * судьбы, а не плашку ошибки.
   *
   * Адрес — только `pendingId`, без прогона: единицы решаются поштучно (ОЧ.3), а прогон
   * читается сервером из самой записи. Второй ключ здесь был бы не защитой, а поводом
   * разойтись — карточка знает свой pendingId, и он один.
   */
  decideDeferred: ownerOnlyProcedure
    .input(
      z
        .object({
          pendingId: z.string().uuid(),
          decision: z.enum(['approve', 'reject']),
        })
        .strict(),
    )
    .mutation(async ({ ctx, input }): Promise<DecideDeferredResult> => {
      try {
        return await decideDeferredUnit(writeDeps(ctx), {
          ownerId: ctx.actorUserId,
          pendingId: input.pendingId,
          decision: input.decision,
        });
      } catch (e) {
        if (e instanceof ExecError) throw execErrorToTRPC(e);
        throw e;
      }
    }),

  /**
   * «Принять все» (D42 ОЧ.11, приёмка 6): разобрать пачку прогона одним нажатием.
   *
   * Адрес — ПРОГОН, а не список единиц: клиент не должен собирать перечень открытых
   * карточек и присылать его обратно — между рисованием экрана и нажатием кнопки пачку
   * мог тронуть следующий прогон (гашение) или второе устройство, и решать по устаревшему
   * списку значило бы жевать чужие судьбы. Открытые действия отбирает сервер.
   *
   * Ответ — СВОДКА по каждой единице, а не «ок»: атомарности между единицами нет и она не
   * обещается (ОЧ.11), поэтому экран обязан показать, что именно применилось, а что
   * устарело и с какими расхождениями.
   */
  decideAll: ownerOnlyProcedure
    .input(runIdInput)
    .mutation(async ({ ctx, input }): Promise<DecideAllItem[]> => {
      try {
        return await decideAllDeferred(writeDeps(ctx), {
          ownerId: ctx.actorUserId,
          runId: input.runId,
        });
      } catch (e) {
        if (e instanceof ExecError) throw execErrorToTRPC(e);
        throw e;
      }
    }),

  /**
   * Ответ владельца на вопрос пачки (D42 §6, приёмка 5). Не то же, что `answerCheckpoint`:
   * тот отвечает на ТЕРМИНАЛЬНЫЙ вопрос прогона (исход `checkpoint` на аспекте), а этот —
   * на нетерминальный `orbis_ask`, который прогон задал по дороге и работал дальше.
   *
   * `option` — ИНДЕКС нажатой кнопки (0..3, потолок числа вариантов у `orbis_ask`); текст
   * выбранного едет в `answer` тем же полем, что и свободный ответ. Диапазон здесь —
   * только форма входа; сверку с вариантами САМОГО вопроса делает ядро (рулинг Р3-3).
   */
  answerQuestion: ownerOnlyProcedure
    .input(
      z
        .object({
          pendingId: z.string().uuid(),
          answer: z.string().min(1).max(4000),
          option: z.number().int().min(0).max(3).optional(),
        })
        .strict(),
    )
    .mutation(async ({ ctx, input }): Promise<AnswerQuestionResult> => {
      try {
        return await answerRunQuestion(writeDeps(ctx), {
          ownerId: ctx.actorUserId,
          pendingId: input.pendingId,
          answer: input.answer,
          ...(input.option !== undefined && { option: input.option }),
        });
      } catch (e) {
        if (e instanceof ExecError) throw execErrorToTRPC(e);
        throw e;
      }
    }),

  /**
   * Пачка решений прогона для его экрана (D42 §7): единицы с судьбами, в порядке
   * постановки. Пустой список — обычный ответ, а не отсутствие: экран прогона открывается
   * и у того, кто ничего не откладывал и ни о чём не спрашивал.
   *
   * Прогон через `runById` НЕ читается, как и в решениях (Р-17): тот стоит на
   * `NOT archived`, и пачка откаченного прогона перестала бы показываться вовсе — вместе
   * с судьбами, по которым владелец только и поймёт, что с ней стало.
   *
   * `withIdentity` здесь не плумбинг, а КОНТРАКТ `listRunUnits`: транзакция обязана быть
   * открыта для ТОГО ЖЕ владельца, иначе судьбы молча не найдутся и вся пачка прочитается
   * открытой (её докблок). Тот же приём, что у `runNow` и `overview` ниже.
   */
  runUnits: ownerOnlyProcedure
    .input(runIdInput)
    .query(async ({ ctx, input }): Promise<RunUnit[]> => {
      try {
        return await withIdentity(ctx.db, ctx.actorUserId, (tx) =>
          listRunUnits(tx, ctx.actorUserId, input.runId),
        );
      } catch (e) {
        // Чтение пачки fail-closed: повреждённая запись роняет ВЕСЬ список (её докблок), и
        // без перевода владелец получил бы 500 вместо внятного «запись повреждена»
        if (e instanceof ExecError) throw execErrorToTRPC(e);
        throw e;
      }
    }),

  /**
   * Обзор рутины для её экрана (V1.14). Читающая процедура: прогоны рутины уже лежат одним
   * запросом (`runsOfParent`), и считать по ним «ждут ответа» и «есть предложение» дешевле,
   * чем звать сервер трижды.
   */
  overview: ownerOnlyProcedure
    .input(routineIdInput)
    .query(async ({ ctx, input }): Promise<RoutineOverview> => {
      try {
        const { routine, timeZone, runs } = await withIdentity(
          ctx.db,
          ctx.actorUserId,
          async (tx) => ({
            routine: await routineById(tx, input.routineId),
            timeZone: await ownerTimeZone(tx, ctx.actorUserId),
            runs: await runsOfParent(tx, input.routineId),
          }),
        );
        if (routine === null) {
          throw new ExecError('NOT_FOUND', 'рутина не найдена', { routineId: input.routineId });
        }

        // Рутина на паузе не сработает вовсе (activeRoutines её не отбирает), и показывать
        // ей «следующее срабатывание» значило бы обещать то, чего не будет
        const next =
          routine.props[ROUTINE_STAGE_PROPERTY] === 'active'
            ? nextBucketAt({
                at: routine.props['orbis/routine_at'],
                days: routine.props['orbis/routine_days'],
                timeZone,
                now: clockOf(ctx)(),
              })
            : null;
        const last = runs.at(-1);
        // Архивный прогон — след отката (rollback.ts): его вопрос и предложение уже погашены
        // (`stale`), а если запись старше хвоста и pending на нём остался — ответить и решить
        // по нему всё равно нельзя (NOT_FOUND под архивом), и считать его «ждёт» значило бы
        // обещать кнопку, которой нет
        const live = runs.filter((r) => !r.archived);
        return {
          nextBucketAt: next === null ? null : next.toISOString(),
          lastRun: last === undefined ? null : runSummary(last),
          // «Ждут меня» (V1.9) — обычное равенство по исходу: состоянием вопроса
          // сделан сам исход прогона, отдельной сущности «вопрос» в срезе нет
          waiting: live.filter((r) => r.props['orbis/run_outcome'] === 'checkpoint').length,
          openProposal: live.some((r) => r.props['orbis/run_proposal']?.status === 'pending'),
          // Пачка считается АСПЕКТНЫМ ФИЛЬТРОМ по уже прочитанным прогонам (С8 ревью
          // спеки) — тем же способом, что и `waiting`, и без единой пробы по треду:
          // GIN-проба на прогон стоила бы Seq Scan под RLS (докблок `listRunUnits`) на
          // каждое открытие экрана рутины. Цена — цифра означает «у стольких прогонов
          // осталась неразобранная пачка», а не «столько единиц ждёт»: точное число
          // ЕДИНИЦ читается одной пробой на экране прогона (`runUnits`), где оно и нужно
          undecided: live.filter((r) => r.props['orbis/undecided'] === true).length,
        };
      } catch (e) {
        if (e instanceof ExecError) throw execErrorToTRPC(e);
        throw e;
      }
    }),
});
