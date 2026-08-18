// apps/server/src/routines/lifecycle.ts
// Жизненный цикл рутины вокруг прогона: что делает НОВЫЙ прогон с наследством прошлых
// (V1.8) и когда рутина сама себя останавливает (V1.12).
//
// Почему это отдельный модуль от раннера: и гашение незакрытого, и стоп-кран — правила
// РУТИНЫ, а не цикла модели. Их зовёт раннер (Задача 9), а `startBucketRun` планировщика
// (Задача 10) встанет рядом на те же `RoutineDeps` — цикл модели ему не нужен вовсе.
//
// Атрибуция всех записей этого модуля — `actorKind: 'ai'`, `source: 'system'` (рулинг
// Р-7/В1): это протокол ведения прогонов, а не правка графа по существу. Отсюда два
// следствия, ради которых источник и выбран: «отмени последнее» (undoLast пропускает
// только `system`) не снимает пометку «заменено» вместо правки модели, а инвариант
// запрета по объекту (V1.10, молчит для владельческих и системных источников) не блокирует
// паузу самой рутины.
import { isManualBucket, newId } from '@orbis/shared';
import { runSummary, runsOfParent } from '../agent-loop/queries';
import type { Clock } from '../budget/aggregates';
import { appendMessage } from '../chat/messages';
import { ensureEntityThread } from '../chat/threads';
import type { Db } from '../db/client';
import { type Tx, withIdentity } from '../db/with-identity';
import type { EntitlementResolver } from '../entitlements';
import { execute } from '../executor/executor';
import { makeChatJournalSink } from '../executor/journal';
import type { JournalSink } from '../executor/types';
import type { LLMProvider } from '../llm/types';
import { rejectPending } from '../policy/pending';
import { CONSECUTIVE_FAILURES_TO_PAUSE, ROUTINE_HISTORY_TAIL } from './constants';
import type { RoutineHistoryItem } from './context';

/** Боевой синк — один инстанс на модуль (состояния не хранит), как в dispatch.ts. */
const defaultSink = makeChatJournalSink();

/**
 * Всё, что нужно фоновой работе рутины. Один тип на раннер, планировщик и ручной запуск:
 * они образуют одну цепочку вызовов, и три похожих набора зависимостей разъехались бы на
 * первом же новом шве (часы в тестах, второй провайдер, резолвер лимитов).
 */
export interface RoutineDeps {
  db: Db;
  provider: LLMProvider;
  /** Имя модели для метеринга §4.7 — берётся у провайдера, не из env (см. makeAiDeps). */
  model: string;
  /** Резолвер §8; по умолчанию боевой resolveEntitlement (на плане dev безлимитен). */
  entitlements?: EntitlementResolver;
  clock: Clock;
  /** Боевой журнальный синк по умолчанию; тесты подменяют. */
  sink?: JournalSink;
  /**
   * Рубильник остановки процесса. Проверяется МЕЖДУ шагами цикла (Р-15): дожать текущий
   * шаг дешевле, чем оставить прогон в `running` до подметания.
   */
  signal?: AbortSignal;
}

export interface SupersedeResult {
  /** Сколько pending-предложений отклонено как «заменено». */
  superseded: number;
  /** Сколько неотвеченных вопросов переведено в `stale`. */
  staled: number;
}

/**
 * Системная запись в тред СУЩНОСТИ — сообщение, а не действие журнала (как reject в
 * policy/pending.ts): «рутина поставлена на паузу» и «вопрос снят» ничего в графе не
 * меняют, и заводить на них action §7.8 значило бы предлагать владельцу кнопку «отменить»
 * для события, которое отменять нечем.
 *
 * `metadata.type` обязателен по конвенции чтения ленты: по нему экран отличает эти строки
 * от audit'а и pending'ов. Инфраструктурным фильтром (chat/messages.ts) они НЕ скрыты —
 * это записи для владельца, он их и должен увидеть.
 */
export async function appendSystemNote(
  tx: Tx,
  args: { ownerId: string; entityId: string; content: string; metadata: Record<string, unknown> },
): Promise<void> {
  const threadId = await ensureEntityThread(tx, args.ownerId, args.entityId);
  await appendMessage(tx, {
    id: newId(),
    threadId,
    role: 'system',
    content: args.content,
    metadata: args.metadata,
  });
}

/**
 * Патч аспекта прогона/рутины бухгалтерией прогона: один execute, источник `system`.
 *
 * Код отказа возвращается, а не логируется здесь: `CONFLICT` по предусловию для обоих
 * вызывающих — не сбой, а «состояние изменилось, и правило говорит не трогать» (владелец
 * ответил на вопрос; рутину уже поставил на паузу конкурент). Логировать это как ошибку
 * значило бы засыпать лог штатными исходами.
 */
async function patchAspect(
  deps: RoutineDeps,
  args: {
    ownerId: string;
    id: string;
    aspect: 'orbis/agent-run' | 'orbis/routine';
    patch: Record<string, unknown>;
    precondition?: Array<Record<string, unknown>>;
  },
): Promise<{ ok: boolean; code?: string }> {
  const r = await execute(
    deps.db,
    {
      actorUserId: args.ownerId,
      actorKind: 'ai',
      source: 'system',
      operations: [
        {
          tool: 'entity_update',
          input: {
            id: args.id,
            ...(args.precondition !== undefined && { precondition: args.precondition }),
            aspects: { [args.aspect]: args.patch },
          },
        },
      ],
      clock: deps.clock,
    },
    { sink: deps.sink ?? defaultSink },
  );
  // Не бросаем: гашение и пауза — гигиена вокруг работы, и провалившаяся гигиена не повод
  // не сделать (или отменить) саму работу.
  return r.ok ? { ok: true } : { ok: false, code: r.error.code };
}

/**
 * Гасит незакрытое от ПРОШЛЫХ прогонов рутины (V1.8): непринятое предложение отклоняется
 * как «заменено», неотвеченный вопрос переходит в `stale`. Без этого к пятнице у владельца
 * четыре плана и три вопроса, и ни один не про сегодня.
 *
 * `exceptRunId` — текущий прогон: он единственный, кого гасить нельзя ни при каких
 * условиях (иначе раннер снял бы собственное предложение сразу после того, как подал его).
 *
 * Порядок внутри пары «предложение»: СНАЧАЛА rejectPending, потом статус на прогоне.
 * Обратный порядок оставлял бы окно, в котором прогон уже говорит «заменено», а кнопка
 * «Принять» на карточке ещё работает — то есть владелец применил бы снятый план.
 * Обратная асимметрия безопасна: rejectPending идемпотентен (`alreadyRejected`), а
 * недописанный статус чинится следующим проходом.
 *
 * Снятое НЕ пропадает: оно остаётся в истории прогона (спека V1.8) — уходит только из
 * «ждут меня».
 */
export async function supersedeOpen(
  deps: RoutineDeps,
  args: { ownerId: string; routineId: string; exceptRunId: string },
): Promise<SupersedeResult> {
  const runs = await withIdentity(deps.db, args.ownerId, (tx) => runsOfParent(tx, args.routineId));
  const out: SupersedeResult = { superseded: 0, staled: 0 };
  const now = deps.clock().toISOString();

  for (const row of runs) {
    if (row.id === args.exceptRunId) continue;
    const run = row.run;

    if (run.proposal?.status === 'pending') {
      const rejected = await rejectPending(deps.db, {
        ownerId: args.ownerId,
        pendingId: run.proposal.pending_id,
        reason: 'superseded',
      });
      if (!rejected.ok) {
        // Карточка исчезла или уже исполнена: статус прогона тогда правит не гашение, а
        // decideProposal (Задача 11) — переписывать его здесь значило бы соврать про судьбу
        console.error('[routines] предложение не отклонено как заменённое:', rejected.error);
        continue;
      }
      if (rejected.alreadyRejected && rejected.reason !== 'superseded') {
        // Между нашим чтением («ждёт решения») и отказом предложение уже отклонил кто-то
        // другой — владелец кнопкой или проверка предусловий (Задача 11). Статус на прогоне
        // пишет тот, чей reason стоит в reject-строке (она — источник правды, V1.8): наше
        // «заменено» поверх его «отклонил» соврало бы владельцу про его же решение.
        // Свой прежний reason 'superseded' — недописанный статус прошлого прохода, дописываем.
        continue;
      }
      // `proposal` — вложенный объект, а merge аспекта пополевой: патчим его целиком,
      // иначе pending_id пропал бы вместе со ссылкой на карточку. Предусловие — тот же
      // объект, каким мы его прочитали (сравнение по JSON-форме, executor.ts): вложенное
      // поле `proposal.status` грамматика предусловий адресовать не умеет, а целый объект
      // умеет — и если решение владельца легло между чтением и патчем, CONFLICT оставит
      // его статус нетронутым.
      const patched = await patchAspect(deps, {
        ownerId: args.ownerId,
        id: row.id,
        aspect: 'orbis/agent-run',
        patch: {
          proposal: {
            pending_id: run.proposal.pending_id,
            status: 'superseded',
            decided_at: now,
            ...(run.proposal.mismatches !== undefined && { mismatches: run.proposal.mismatches }),
          },
        },
        precondition: [{ aspect: 'orbis/agent-run', field: 'proposal', in: [run.proposal] }],
      });
      if (patched.ok) out.superseded += 1;
      else if (patched.code !== 'CONFLICT') {
        console.error(`[routines] статус «заменено» не записан на ${row.id}:`, patched.code);
      }
      continue;
    }

    if (run.outcome === 'checkpoint') {
      const patched = await patchAspect(deps, {
        ownerId: args.ownerId,
        id: row.id,
        aspect: 'orbis/agent-run',
        patch: { outcome: 'stale' },
        // Под замком исход мог уже стать `answered` (владелец ответил секунду назад) —
        // тогда снимать вопрос нельзя: ответ важнее нового прогона
        precondition: [{ aspect: 'orbis/agent-run', field: 'outcome', in: ['checkpoint'] }],
      });
      if (!patched.ok) {
        // CONFLICT здесь — «владелец ответил, пока мы читали»: вопрос гасить уже нельзя
        if (patched.code !== 'CONFLICT') {
          console.error(`[routines] вопрос прогона ${row.id} не снят:`, patched.code);
        }
        continue;
      }
      out.staled += 1;
      // Владелец видит в треде, почему вопрос пропал из «ждут меня» (V1.8)
      await withIdentity(deps.db, args.ownerId, (tx) =>
        appendSystemNote(tx, {
          ownerId: args.ownerId,
          entityId: args.routineId,
          content: 'Вопрос прошлого прогона снят: рутина сработала заново',
          metadata: { type: 'routine_stale', routine_id: args.routineId, run_id: row.id },
        }),
      );
    }
  }
  return out;
}

/**
 * Стоп-кран (V1.12): CONSECUTIVE_FAILURES_TO_PAUSE плановых прогонов подряд, закончившихся
 * `failed`, переводят рутину в `paused` с записью в её тред. Рутина, которая ломается
 * каждое утро, иначе ломается каждое утро месяц — и жжёт токены на каждой попытке.
 *
 * Считаются только ПЛАНОВЫЕ прогоны (бакет не `manual:`): ручной запускает владелец и
 * видит исход сразу, ставить его же кнопкой рутину на паузу было бы наказанием за проверку.
 *
 * Принятая цена, названная в спеке прямо: временно исчерпанный лимит тоже ставит на паузу —
 * снимается рукой.
 */
export async function pauseIfFailing(
  deps: RoutineDeps,
  args: { ownerId: string; routineId: string },
): Promise<{ paused: boolean }> {
  const runs = await withIdentity(deps.db, args.ownerId, (tx) => runsOfParent(tx, args.routineId));
  const planned = runs.filter((r) => r.run.bucket !== undefined && !isManualBucket(r.run.bucket));
  const tail = planned.slice(-CONSECUTIVE_FAILURES_TO_PAUSE);
  if (tail.length < CONSECUTIVE_FAILURES_TO_PAUSE) return { paused: false };
  if (!tail.every((r) => r.run.outcome === 'failed')) return { paused: false };

  // Предусловие `stage: active` — не оптимизация, а сериализация: два прогона, упавших
  // почти одновременно, иначе оба записали бы паузу и оба положили бы запись в тред.
  // Проигравший получает CONFLICT и честно отвечает `paused: false` — паузу поставил не он.
  const paused = await patchAspect(deps, {
    ownerId: args.ownerId,
    id: args.routineId,
    aspect: 'orbis/routine',
    patch: { stage: 'paused' },
    precondition: [{ aspect: 'orbis/routine', field: 'stage', in: ['active'] }],
  });
  if (!paused.ok) {
    // CONFLICT — рутина уже на паузе (её поставил конкурент либо прошлый сбой): штатный
    // исход, а не ошибка; запись в тред кладёт тот, кто выиграл предусловие
    if (paused.code !== 'CONFLICT') {
      console.error(`[routines] пауза рутины ${args.routineId} не записана:`, paused.code);
    }
    return { paused: false };
  }

  await withIdentity(deps.db, args.ownerId, (tx) =>
    appendSystemNote(tx, {
      ownerId: args.ownerId,
      entityId: args.routineId,
      content: `Рутина поставлена на паузу: ${CONSECUTIVE_FAILURES_TO_PAUSE} прогона подряд закончились сбоем. Снимите паузу, когда причина устранена.`,
      metadata: { type: 'routine_paused', routine_id: args.routineId },
    }),
  );
  return { paused: true };
}

/**
 * Хвост истории рутины для контекста модели (Р-18): последние `tail` прогонов, кроме
 * текущего, от старых к новым.
 *
 * Хвост, а не вся история (в отличие от `claim_task`, где она без лимита): у ежедневной
 * рутины прогоны копятся линейно, и через месяц история вытеснила бы из контекста саму
 * инструкцию. Проекции (`proposalStatus`, `reply`, `explanation`) заполняются здесь —
 * см. докблок RoutineHistoryItem.
 */
export async function routineHistory(
  tx: Tx,
  routineId: string,
  exceptRunId: string,
  tail: number = ROUTINE_HISTORY_TAIL,
): Promise<RoutineHistoryItem[]> {
  const runs = await runsOfParent(tx, routineId);
  return runs
    .filter((row) => row.id !== exceptRunId)
    .slice(-tail)
    .map((row) => {
      const summary = runSummary(row);
      return {
        run: summary,
        ...(summary.proposal !== undefined && { proposalStatus: summary.proposal.status }),
        ...(summary.reply !== undefined && { reply: summary.reply.text }),
        // Проза предложения живёт в `report` прогона (её кладёт orbis_propose): отчёт
        // прогона БЕЗ предложения — это отчёт режима act, и объяснением он не является
        ...(summary.proposal !== undefined &&
          summary.report !== undefined && { explanation: summary.report }),
      };
    });
}
