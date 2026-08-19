// apps/server/src/routers/routine.ts
// Роутер routine (§9.1, V1) — владельческая половина внутреннего исполнителя: «прогнать
// сейчас» (V1.3), ответ на вопрос прогона (V1.9), чтение предложения и решение по нему
// (V1.6, V1.7), обзор для экрана рутины (V1.14).
//
// ТОЛЬКО трансляция: правила живут в routines/lifecycle.ts (решения владельца), в
// routines/schedule.ts (календарь) и в routines/runner.ts (цикл модели) — здесь разбор
// входа, подстановка identity и перевод доменных отказов в TRPCError.
//
// Все пять — ownerOnly, и это не осторожность: рутина — доверенность, выданная владельцем,
// и все решения по ней (запустить, ответить, принять план) принимает он сам. Внутреннему
// исполнителю сюда хода нет по построению — его поверхность это глаголы и `orbis_propose`,
// а инвариант запрета по объекту (V1.10) закрывает ему и обходной путь через граф.

import type { RunSummary } from '@orbis/shared';
import { z } from 'zod';
import { routineById, runSummary, runsOfParent } from '../agent-loop/queries';
import { defaultAiDeps } from '../ai/send-message';
import { withIdentity } from '../db/with-identity';
import { ExecError, execErrorToTRPC } from '../errors';
import { ownerTimeZone } from '../query/context';
import {
  answerRoutineCheckpoint,
  type DecideProposalResult,
  decideProposal,
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
 * прошлый прогон, сколько её вопросов ждут ответа и висит ли нерешённое предложение.
 *
 * Одна процедура, а не четыре: экран показывает это ОДНИМ блоком, и четыре запроса дали бы
 * ему четыре момента времени вместо одного снимка.
 */
export interface RoutineOverview {
  /** ISO следующего срабатывания; `null` — рутина на паузе (сработать ей нечем). */
  nextBucketAt: string | null;
  lastRun: RunSummary | null;
  /** Сколько прогонов рутины ждут ответа владельца (исход `checkpoint`). */
  waiting: number;
  /** Есть ли нерешённое предложение — по нему экран рисует «ждёт решения». */
  openProposal: boolean;
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
        const { routine, timeZone } = await withIdentity(ctx.db, ctx.actorUserId, async (tx) => ({
          routine: await routineById(tx, input.routineId),
          timeZone: await ownerTimeZone(tx, ctx.actorUserId),
        }));
        // Чужая, архивная и несуществующая под RLS неразличимы — единый NOT_FOUND
        if (routine === null) {
          throw new ExecError('NOT_FOUND', 'рутина не найдена', { routineId: input.routineId });
        }

        const ai = ctx.ai ?? defaultAiDeps();
        const runs = ai.manualRuns ?? manualRuns;
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
   * Решение владельца по предложению (V1.6, V1.7; приёмка 2, 4, 5). Устаревшее предложение
   * и уже принятое решение едут ЗНАЧЕНИЕМ, а не TRPCError: экран рисует по ним список
   * расхождений и подпись статуса, а не плашку ошибки (та же логика, что у agentRun.rollback).
   */
  decideProposal: ownerOnlyProcedure
    .input(z.object({ runId: z.string().uuid(), decision: z.enum(['approve', 'reject']) }).strict())
    .mutation(async ({ ctx, input }): Promise<DecideProposalResult> => {
      try {
        return await decideProposal(writeDeps(ctx), {
          ownerId: ctx.actorUserId,
          runId: input.runId,
          decision: input.decision,
        });
      } catch (e) {
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
          routine.routine.stage === 'active'
            ? nextBucketAt({
                at: routine.routine.at,
                days: routine.routine.days,
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
          waiting: live.filter((r) => r.run.outcome === 'checkpoint').length,
          openProposal: live.some((r) => r.run.proposal?.status === 'pending'),
        };
      } catch (e) {
        if (e instanceof ExecError) throw execErrorToTRPC(e);
        throw e;
      }
    }),
});
