// apps/server/src/routers/agent-run.ts
// Роутер agentRun (§9.1) — владельческая половина круга исполнителя: ответить на чекпойнт
// (С3), подмести брошенные прогоны с экрана (С6) и откатить прогон (С12). ТОЛЬКО
// трансляция: ответ на чекпойнт идёт batch'ем через executor (единственный путь мутаций,
// 00-arch §4), подметание и откат — в agent-loop/, чтения — под withIdentity (RLS §4.10).
//
// Все три — ownerOnly: это поверхность ЧЕЛОВЕКА. Исполнителю здесь делать нечего — его
// путь идёт через /mcp и глаголы (verbs.ts), а ответ на собственный вопрос агентом был бы
// подменой того самого решения, ради которого чекпойнт и останавливает работу.
import { newId } from '@orbis/shared';
import { z } from 'zod';
import { runById, runsOfTicket, ticketOfRun } from '../agent-loop/queries';
import { rollbackRun } from '../agent-loop/rollback';
import { sweepStaleRuns } from '../agent-loop/sweep';
import { withIdentity } from '../db/with-identity';
import { ExecError, execErrorToTRPC } from '../errors';
import { execute } from '../executor/executor';
import { makeChatJournalSink } from '../executor/journal';
import type { WireEntity } from '../executor/types';
import { ownerOnlyProcedure, router } from '../trpc';
import type { WireRollbackResult } from '../wire';

// Боевой синк — один инстанс на модуль (состояния не хранит, пишет тем же tx, §7.8).
const sink = makeChatJournalSink();

/** Потолок ответа — тот же, что у вопроса чекпойнта в схеме аспекта (4000). */
const answerCheckpointInput = z
  .object({
    ticketId: z.string().uuid(),
    runId: z.string().uuid(),
    answer: z.string().min(1).max(4000),
  })
  .strict();

/**
 * Результат операции батча — wire-форма сущности. Форму проверяем, а не приводим: batchId
 * здесь всегда свежий (newId), поэтому идемпотентный replay §7.8 недостижим, но
 * молчаливое приведение чужой формы к WireEntity дало бы TypeError вместо отказа, если
 * это когда-нибудь изменится.
 */
function wireEntityAt(results: readonly unknown[], index: number, id: string): WireEntity {
  const value = results[index];
  if (typeof value !== 'object' || value === null || (value as WireEntity).id !== id) {
    throw new ExecError('CONFLICT', 'ответ на чекпойнт вернул не ту сущность', { id });
  }
  return value as WireEntity;
}

export const agentRunRouter = router({
  /**
   * Ответ владельца на чекпойнт (С3, приёмка 8): вопрос закрыт — тикет возвращается в
   * работу, ответ ложится на прогон, чтобы следующий захват прочитал его в `history`
   * (verbs.ts claimTask) и не начал разговор заново.
   *
   * ОДИН batch, а не два вызова: состояния «ответ записан, а тикет всё ещё ждёт» быть не
   * должно ни на миг — оно читалось бы как «человек не ответил», и агент, придя за
   * очередью, снова прошёл бы мимо тикета. Второе следствие важнее: один action §7.8 —
   * это одно «Отменить», а не половина отката.
   */
  answerCheckpoint: ownerOnlyProcedure
    .input(answerCheckpointInput)
    .mutation(async ({ ctx, input }): Promise<{ ticket: WireEntity; run: WireEntity }> => {
      try {
        // Предпроверка под RLS — ради ВНЯТНОГО отказа: гонку закрывают предусловия ниже,
        // но без чтения человек получал бы на неверную пару id безымянный CONFLICT
        // предусловия вместо «прогон не принадлежит этому тикету».
        const outcome = await withIdentity(ctx.db, ctx.actorUserId, async (tx) => {
          const run = await runById(tx, input.runId);
          // Чужой и несуществующий под RLS неразличимы — единый NOT_FOUND
          if (run === null) {
            throw new ExecError('NOT_FOUND', 'прогон не найден', { runId: input.runId });
          }
          const ticket = await ticketOfRun(tx, input.runId);
          if (ticket === null || ticket.id !== input.ticketId) {
            throw new ExecError('NOT_FOUND', 'прогон не принадлежит этому тикету', {
              runId: input.runId,
              ticketId: input.ticketId,
            });
          }
          if (ticket.aspectsLegacy['orbis/task']?.status !== 'waiting') {
            throw new ExecError('CONFLICT', 'тикет не ждёт ответа — отвечать не на что', {
              ticketId: input.ticketId,
              status: ticket.aspectsLegacy['orbis/task']?.status,
            });
          }
          // Отвечают ПОСЛЕДНЕМУ прогону тикета. Все прошлые прогоны терминальны, и
          // предусловие исхода их пропускает: устаревший экран (или чужой вызов API) с
          // прежним runId положил бы ответ в старый прогон, вернул тикет в planned — а
          // вопрос текущего прогона остался бы без ответа, и агент прочитал бы в истории
          // чужую реплику. Порядок — тот же created_at ASC, что у экрана истории.
          const runs = await runsOfTicket(tx, input.ticketId);
          if (runs.at(-1)?.id !== input.runId) {
            throw new ExecError('CONFLICT', 'ответ адресуется последнему прогону тикета', {
              ticketId: input.ticketId,
              runId: input.runId,
              lastRunId: runs.at(-1)?.id,
            });
          }
          return run.run.outcome;
        });
        // Открытый ВОПРОС ответ закрывает: исход `checkpoint` → `answered` (V1, D38) — иначе
        // отвеченный прогон вечно сидел бы в блоке «Ждут ответа» списка «Рутины» и в его
        // бейдже (запрос `outcome=checkpoint` по всем прогонам; отсечь тикетные грамматика
        // не умеет). Ответ на уже законченный прогон (`finished`/`abandoned` — человек ответил
        // после итога или подметания) исход не переписывает: он не был вопросом.
        const answersQuestion = outcome === 'checkpoint';

        const r = await execute(
          ctx.db,
          {
            actorUserId: ctx.actorUserId,
            actorKind: 'owner',
            source: 'ui', // прямое действие владельца в UI (не chat/mcp/system)
            // …но МЕХАНИЗМ — глагол исполнителя (§А4-4): ответ ложится в служебные
            // свойства прогона (`reply`, `outcome`), а они `system_writable` (§А2-5).
            // Оси разные ровно поэтому: канал — рука владельца, механизм — бухгалтерия.
            mechanism: 'verb',
            // Ответ — про ЭТОТ прогон: обратная ссылка ставит его в историю прогона на
            // экране рядом с вопросом. Откатом прогона она его не уносит — там действия
            // владельца намеренно не считаются работой исполнителя (rollback.ts).
            runId: input.runId,
            batchId: newId(),
            operations: [
              {
                tool: 'entity_update',
                input: {
                  id: input.runId,
                  // Прогон обязан быть ЗАКОНЧЕН: отвечать в идущий прогон нельзя — агент
                  // его не перечитывает, и ответ утонул бы. `finished`/`abandoned`
                  // допущены наравне с `checkpoint`: человек мог ответить на вопрос уже
                  // после того, как прогон подмели (С6) или он успел завершиться сам.
                  // Предусловие сужено до прочитанного исхода: CAS против второго экрана,
                  // который успел ответить (и перевести вопрос в `answered`) секундой раньше.
                  precondition: [
                    {
                      aspect: 'orbis/agent-run',
                      field: 'outcome',
                      in: answersQuestion ? ['checkpoint'] : ['finished', 'abandoned'],
                    },
                  ],
                  aspects: {
                    'orbis/agent-run': {
                      reply: { text: input.answer, at: new Date().toISOString() },
                      ...(answersQuestion && { outcome: 'answered' }),
                    },
                  },
                },
              },
              {
                tool: 'entity_update',
                input: {
                  id: input.ticketId,
                  // Тикет всё ещё ждёт: между чтением и записью на него мог ответить
                  // второй экран владельца, и второй ответ поверх первого затёр бы его
                  precondition: [{ aspect: 'orbis/task', field: 'status', in: ['waiting'] }],
                  // Уходя из waiting — снимаем waiting_for (конвенция среза, как в
                  // подметании и итоге): вопрос рядом с `planned` читался бы как открытый
                  aspects: { 'orbis/task': { status: 'planned', waiting_for: null } },
                },
              },
            ],
          },
          { sink },
        );
        if (!r.ok) throw execErrorToTRPC(r.error);
        return {
          run: wireEntityAt(r.results, 0, input.runId),
          ticket: wireEntityAt(r.results, 1, input.ticketId),
        };
      } catch (e) {
        if (e instanceof ExecError) throw execErrorToTRPC(e);
        throw e;
      }
    }),

  /**
   * Подметание брошенных прогонов с экранов проекта и тикета (С6). Отдельная процедура,
   * а не побочный эффект чтения: инвариант 6 («тикет не висит in_progress навсегда») не
   * должен зависеть от того, что какой-то агент однажды позовёт `orbis_my_queue` —
   * владелец, открывший проект, чинит его сам, ничего об этом не зная.
   *
   * Часов здесь не инжектируем намеренно: это боевой путь, а не тест, и «сейчас» у него
   * ровно одно. Порог — серверная константа (agent-loop/constants.ts).
   */
  sweep: ownerOnlyProcedure
    .input(z.object({}).strict())
    .mutation(async ({ ctx }): Promise<{ swept: number }> => {
      try {
        return await sweepStaleRuns(ctx.db, { ownerId: ctx.actorUserId, actorKind: 'owner' });
      } catch (e) {
        if (e instanceof ExecError) throw execErrorToTRPC(e);
        throw e;
      }
    }),

  /**
   * Откат прогона в Orbis (С12, приёмка 13). Алгоритм и его обоснования — в
   * agent-loop/rollback.ts; здесь только трансляция. Отказы едут ЗНАЧЕНИЕМ, а не
   * TRPCError: конфликт и частичный откат — это исходы, которые экран рисует списком
   * («вот что помешало», «вот на чём встали»), а не сбои, на которые он показывает
   * плашку ошибки.
   */
  rollback: ownerOnlyProcedure
    .input(z.object({ runId: z.string().uuid() }).strict())
    .mutation(
      ({ ctx, input }): Promise<WireRollbackResult> =>
        rollbackRun(ctx.db, { actorUserId: ctx.actorUserId, runId: input.runId }),
    ),
});
