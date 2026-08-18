// apps/server/src/routines/lifecycle.ts
// Жизненный цикл рутины вокруг прогона: что делает НОВЫЙ прогон с наследством прошлых
// (V1.8) и когда рутина сама себя останавливает (V1.12).
//
// Почему это отдельный модуль от раннера: и гашение незакрытого, и стоп-кран — правила
// РУТИНЫ, а не цикла модели. Их зовёт раннер, а запуск прогона (`startBucketRun`
// планировщика, `startManualRun` кнопки «прогнать сейчас») стоит рядом на тех же
// `RoutineDeps` — цикл модели ему не нужен вовсе: «кто создал прогон, тот и гонит модель»
// (V1.3), и создание отделено от гонки нарочно.
//
// Атрибуция ФОНОВЫХ записей модуля — `actorKind: 'ai'`, `source: 'system'` (рулинг
// Р-7/В1): это протокол ведения прогонов, а не правка графа по существу. Отсюда два
// следствия, ради которых источник и выбран: «отмени последнее» (undoLast пропускает
// только `system`) не снимает пометку «заменено» вместо правки модели, а инвариант
// запрета по объекту (V1.10, молчит для владельческих и системных источников) не блокирует
// паузу самой рутины.
//
// Здесь же живёт ВЛАДЕЛЬЧЕСКАЯ половина того же цикла (V1.6, V1.9): ответ на вопрос
// прогона и решение по предложению — их зовёт роутер (routers/routine.ts). Они стоят
// рядом с `supersedeOpen` не для компании: судьбу одного и того же поля `proposal` пишут
// оба, ОДНИМ правилом (CAS на весь объект) и в одном порядке (сначала pending, потом
// статус), и разведённые по файлам эти правила разъехались бы на первой же правке.
// Атрибуция у них другая и обязана быть другой — `owner`/`ui` со ссылкой на прогон:
// решение владельца не должно сниматься откатом прогона (инвариант 7, rollback.ts).
import {
  type AgentRunAspect,
  isManualBucket,
  manualBucket,
  newId,
  type PreconditionMismatch,
  type ProposalStatus,
  routineRunBatchId,
  routineRunId,
} from '@orbis/shared';
import { sql } from 'drizzle-orm';
import {
  type RunRow,
  runById,
  runSummary,
  runsForBucket,
  runsOfParent,
} from '../agent-loop/queries';
import type { Clock } from '../budget/aggregates';
import { appendMessage } from '../chat/messages';
import { ensureEntityThread } from '../chat/threads';
import type { Db } from '../db/client';
import { type Tx, withIdentity } from '../db/with-identity';
import {
  type EntitlementResolver,
  ROUTINE_RUNS_PER_DAY_KEY,
  resolveEntitlement,
} from '../entitlements';
import { ExecError, type ExecErrorCode, type StructuredError } from '../errors';
import { execute } from '../executor/executor';
import { makeChatJournalSink } from '../executor/journal';
import type { ActorKind, JournalSink, MutationSource } from '../executor/types';
import type { LLMProvider } from '../llm/types';
import { approvePending, type RejectReason, rejectPending } from '../policy/pending';
import { wallClockIn } from '../recurring/materialize';
import {
  CONSECUTIVE_FAILURES_TO_PAUSE,
  MAX_ATTEMPTS,
  RETRY_DELAYS_MS,
  ROUTINE_HISTORY_TAIL,
} from './constants';
import type { RoutineHistoryItem } from './context';

/** Боевой синк — один инстанс на модуль (состояния не хранит), как в dispatch.ts. */
const defaultSink = makeChatJournalSink();

/**
 * Минимум, которым пишется бухгалтерия прогона и решения владельца по нему: БД, часы,
 * журнальный синк. Выделен из `RoutineDeps` потому, что владельческая половина (ответ на
 * вопрос, решение по предложению — они же процедуры роутера) модели не вызывает вовсе, и
 * требовать от неё провайдер значило бы заставлять экран носить с собой LLM ради патча
 * одного поля.
 */
export interface RoutineWriteDeps {
  db: Db;
  clock: Clock;
  /** Боевой журнальный синк по умолчанию; тесты подменяют. */
  sink?: JournalSink;
}

/**
 * Всё, что нужно фоновой работе рутины. Один тип на раннер, планировщик и ручной запуск:
 * они образуют одну цепочку вызовов, и три похожих набора зависимостей разъехались бы на
 * первом же новом шве (часы в тестах, второй провайдер, резолвер лимитов).
 */
export interface RoutineDeps extends RoutineWriteDeps {
  provider: LLMProvider;
  /** Имя модели для метеринга §4.7 — берётся у провайдера, не из env (см. makeAiDeps). */
  model: string;
  /** Резолвер §8; по умолчанию боевой resolveEntitlement (на плане dev безлимитен). */
  entitlements?: EntitlementResolver;
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
 * Атрибуция патча (§7.8). Умолчание — бухгалтерия прогона (`ai`/`system`, рулинг Р-7);
 * решения владельца (ответ на вопрос, судьба предложения) переопределяют её на
 * `owner`/`ui` со ссылкой на прогон: это ЕГО действие, и откат прогона обязан видеть его
 * чужим изменением, а не своей работой (rollback.ts, инвариант 7).
 */
interface PatchActor {
  kind: ActorKind;
  source: MutationSource;
  runId?: string;
}

const ACCOUNTING_ACTOR: PatchActor = { kind: 'ai', source: 'system' };

/** Исход патча: структурированная ошибка целиком — её текст едет владельцу на экран. */
type PatchResult = { ok: true } | { ok: false; error: StructuredError };

/**
 * Патч аспекта прогона/рутины одним execute.
 *
 * Ошибка возвращается, а не логируется здесь: `CONFLICT` по предусловию для всех
 * вызывающих — не сбой, а «состояние изменилось, и правило говорит не трогать» (владелец
 * ответил на вопрос; рутину уже поставил на паузу конкурент; предложение решил второй
 * экран). Логировать это как ошибку значило бы засыпать лог штатными исходами.
 */
async function patchAspect(
  deps: RoutineWriteDeps,
  args: {
    ownerId: string;
    id: string;
    aspect: 'orbis/agent-run' | 'orbis/routine';
    patch: Record<string, unknown>;
    precondition?: Array<Record<string, unknown>>;
    actor?: PatchActor;
  },
): Promise<PatchResult> {
  const actor = args.actor ?? ACCOUNTING_ACTOR;
  const r = await execute(
    deps.db,
    {
      actorUserId: args.ownerId,
      actorKind: actor.kind,
      source: actor.source,
      ...(actor.runId !== undefined && { runId: actor.runId }),
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
  // не сделать (или отменить) саму работу. Владельческие вызывающие решают сами — им
  // отдаётся структурированная ошибка целиком.
  return r.ok ? { ok: true } : { ok: false, error: r.error };
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
      else if (patched.error.code !== 'CONFLICT') {
        console.error(`[routines] статус «заменено» не записан на ${row.id}:`, patched.error.code);
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
        if (patched.error.code !== 'CONFLICT') {
          console.error(`[routines] вопрос прогона ${row.id} не снят:`, patched.error.code);
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
    if (paused.error.code !== 'CONFLICT') {
      console.error(`[routines] пауза рутины ${args.routineId} не записана:`, paused.error.code);
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

// ---------------------------------------------------------------------------
// Запуск прогона (V1.3): бакет планировщика и ручной прогон
// ---------------------------------------------------------------------------

/**
 * Чем кончилась попытка завести прогон. `started` — прогон создан ЭТИМ вызовом, и модель
 * гонит вызывающий (инвариант 1): `runId` и `bucket` — ровно то, что нужно `runRoutineRun`
 * (бакет ручного прогона рождается внутри startManualRun, и вызывающему его больше взять
 * неоткуда). Всё остальное — «не гоним», с причиной для тика и экрана.
 * Причины: `replay` — тот же batch уже исполнен (конкурент опередил, PK audit'а);
 * `id_conflict` — id прогона занят (конкурент опередил в той же миллисекунде); `running` —
 * у рутины уже идёт прогон; `done` — слот отработан (терминальный исход, кроме failed);
 * `attempts` — попытки бакета исчерпаны; `backoff` — пауза перед следующей попыткой ещё
 * идёт; `limit` — лимит прогонов в сутки (V1.15).
 */
export type StartOutcome =
  | { started: true; runId: string; bucket: string }
  | {
      started: false;
      reason: 'replay' | 'id_conflict' | 'running' | 'limit' | 'attempts' | 'backoff' | 'done';
    };

/** Рутина в объёме, нужном запуску: id — для ключей и связи, title — для заголовка прогона. */
export interface StartRoutineRef {
  id: string;
  title: string;
}

function skip(reason: Extract<StartOutcome, { started: false }>['reason']): StartOutcome {
  return { started: false, reason };
}

/**
 * Заводит прогон бакета (V1.3, инвариант 1) — ОДНИМ batch'ем `[entity_create(id =
 * routineRunId), relation_create parent]` с детерминированным `batchId =
 * routineRunBatchId(рутина, бакет, попытка)`.
 *
 * Почему batch, а не два вызова: прогон без связи с рутиной — сирота, которого не видит
 * ни история, ни стоп-кран, ни экран; атомарность даёт executor. Почему детерминированный
 * batchId (Р-1): replay-семантика одиночного entity_create в batch не действует — занятый
 * id там всегда CONFLICT/id_conflict; а по PK audit-сообщения тот же batch у второго
 * вызывающего становится `idempotentReplay`. Оба исхода читаются одинаково: «проиграл,
 * модель не гоню» — и два тика в одну минуту (два инстанса на деплое) сходятся к одному
 * прогону и одному вызову модели.
 *
 * Порядок проверок: идущий прогон → отработанный слот → попытки исчерпаны → пауза ретрая →
 * лимит суток. «Идущий» проверяется по ВСЕЙ рутине, а не по слоту: у рутины
 * не бывает двух прогонов разом (иначе оба гасили бы незакрытое друг у друга и подавали бы
 * два предложения на одно утро); бакет при этом не пропадает — тик вернётся к нему через
 * минуту, когда идущий закончится.
 *
 * Пауза ретрая — от `finished_at` последнего провала (см. RETRY_DELAYS_MS): сбой,
 * закрытый подметанием через полчаса, не должен ретраиться в ту же секунду. Провал без
 * `finished_at` в графе невозможен (закрытие пишет его всегда), но на всякий случай
 * отсчёт берётся от `started_at`.
 *
 * Бухгалтерия прогона (Р-7): актор `ai`, источник `system`, `runId` — «отмени последнее»
 * такое не трогает, а инвариант запрета по объекту (V1.10) для system молчит.
 */
export async function startBucketRun(
  deps: RoutineDeps,
  args: { ownerId: string; routine: StartRoutineRef; bucket: string },
): Promise<StartOutcome> {
  const { ownerId, routine, bucket } = args;
  const now = deps.clock();
  const { all, ofBucket } = await withIdentity(deps.db, ownerId, async (tx) => ({
    all: await runsOfParent(tx, routine.id),
    ofBucket: await runsForBucket(tx, routine.id, bucket),
  }));

  if (all.some((r) => r.run.outcome === 'running')) return skip('running');
  // Идущих больше нет, значит любой не-failed исход слота — терминальный: слот отработан
  if (ofBucket.some((r) => r.run.outcome !== 'failed')) return skip('done');
  const failed = ofBucket.filter((r) => r.run.outcome === 'failed');
  if (failed.length >= MAX_ATTEMPTS) return skip('attempts');
  if (failed.length > 0) {
    const delay =
      RETRY_DELAYS_MS[failed.length - 1] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1] ?? 0;
    const lastFailedAt = Math.max(
      ...failed.map((r) => Date.parse(r.run.finished_at ?? r.run.started_at)),
    );
    if (lastFailedAt + delay > now.getTime()) return skip('backoff');
  }
  // Сутки лимита — по дате бакета (см. overRunsPerDay), а не по «сегодня» тика
  if (overRunsPerDay(deps, ownerId, all, bucket.slice(0, 10))) return skip('limit');

  const attempt = failed.length + 1;
  return createRun(deps, {
    ownerId,
    routine,
    bucket,
    attempt,
    now,
    batchId: routineRunBatchId(routine.id, bucket, attempt),
    title: `Прогон: ${routine.title} — ${bucket.replace('T', ' ')}`,
  });
}

/**
 * Ручной прогон «прогнать сейчас» (V1.3): свой ключ `manual:<ISO часов>`, плановый бакет
 * не занимает, попытка всегда 1 (не ретраится), в стоп-кране не участвует (это уже в
 * pauseIfFailing/раннере). Свежий `batchId`: повтор кнопки — новый прогон, а не replay
 * старого; тот же ключ в ту же миллисекунду — `id_conflict`, не второй цикл.
 *
 * Два правила общие с бакетом: у рутины не бывает двух идущих прогонов, и лимит прогонов
 * в сутки (V1.15) — тот же ключ: кнопка не должна обходить исчерпанный день. Сутки для
 * ручного — локальная дата владельца на момент нажатия (`timeZone`).
 */
export async function startManualRun(
  deps: RoutineDeps,
  args: { ownerId: string; routine: StartRoutineRef; timeZone: string },
): Promise<StartOutcome> {
  const { ownerId, routine, timeZone } = args;
  const now = deps.clock();
  const all = await withIdentity(deps.db, ownerId, (tx) => runsOfParent(tx, routine.id));
  if (all.some((r) => r.run.outcome === 'running')) return skip('running');
  if (overRunsPerDay(deps, ownerId, all, wallClockIn(now, timeZone).date)) return skip('limit');

  // Те же `now` — и в ключе (manual:<ISO>), и в started_at/created_at прогона: два чтения
  // часов дали бы бакет и отметку старта, разъехавшиеся на миллисекунды
  return createRun(deps, {
    ownerId,
    routine,
    bucket: manualBucket(now.toISOString()),
    attempt: 1,
    now,
    batchId: newId(),
    title: `Прогон: ${routine.title} — вручную`,
  });
}

/**
 * Лимит `routines.runs_per_day` (V1.15) через резолвер §8: считаются ПЛАНОВЫЕ прогоны
 * рутины (бакет не `manual:`) любого исхода, чья ДАТА БАКЕТА — заданные локальные сутки.
 *
 * Почему по дате бакета, а не по created_at в таймзоне: сутки лимита — сутки рутины
 * («её локальные сутки»), а не сутки, в которые сервер проснулся. Бакет 23:30, догнанный
 * в 00:15, и его ретрай в 00:20 относятся ко вчерашнему дню и не съедают сегодняшний
 * слот; счёт при этом не зависит от того, бодрствовал ли сервер (V1.2). Ручные прогоны
 * не считаются (за ними стоит рука владельца, лимит — про автономный расход), но сами
 * упираются в тот же лимит: кнопка не обходит исчерпанный день.
 */
function overRunsPerDay(
  deps: RoutineDeps,
  ownerId: string,
  runs: RunRow[],
  localDate: string,
): boolean {
  const decision = (deps.entitlements ?? resolveEntitlement)(ownerId, ROUTINE_RUNS_PER_DAY_KEY);
  // Отказ резолвера — «прогонов на этом плане нет вовсе»: считать уже нечего
  if (!decision.allowed) return true;
  if (decision.limit === null) return false; // безлимитный план (сегодняшний 'dev')
  const planned = runs.filter(
    (r) =>
      r.run.bucket !== undefined &&
      !isManualBucket(r.run.bucket) &&
      r.run.bucket.startsWith(localDate),
  );
  return planned.length >= decision.limit;
}

/**
 * Собственно создание: тот же batch, что у фикстуры seedRoutineRun и у claim_task —
 * сущность прогона в `running` со связью `parent` от рутины. Часы батча — ОДИН момент
 * `now`, прочитанный вызывающим: из него берутся и `started_at` (от него раннер считает
 * дедлайн), и `created_at` сущности (по нему читается порядок попыток), и — у ручного
 * прогона — сам ключ бакета; второе чтение часов развело бы их на миллисекунды.
 */
async function createRun(
  deps: RoutineDeps,
  args: {
    ownerId: string;
    routine: StartRoutineRef;
    bucket: string;
    attempt: number;
    now: Date;
    batchId: string;
    title: string;
  },
): Promise<StartOutcome> {
  const runId = routineRunId(args.routine.id, args.bucket, args.attempt);
  const nowIso = args.now.toISOString();
  const r = await execute(
    deps.db,
    {
      actorUserId: args.ownerId,
      actorKind: 'ai',
      source: 'system',
      runId,
      batchId: args.batchId,
      clock: () => args.now,
      operations: [
        {
          tool: 'entity_create',
          input: {
            id: runId,
            title: args.title,
            tags: [],
            aspects: {
              'orbis/agent-run': {
                routine_id: args.routine.id,
                bucket: args.bucket,
                attempt: args.attempt,
                outcome: 'running',
                started_at: nowIso,
                last_step_at: nowIso,
                step_count: 0,
                steps: [],
              },
            },
          },
        },
        {
          tool: 'relation_create',
          input: { source_id: args.routine.id, target_id: runId, relation_type: 'parent' },
        },
      ],
    },
    { sink: deps.sink ?? defaultSink },
  );
  if (!r.ok) {
    // Проигранная гонка приходит двумя отказами, и оба значат одно — «этот прогон только
    // что создал конкурент, модель не гоним»:
    // - CONFLICT/id_conflict — id прогона занят (в batch занятый id всегда отказ, не replay);
    // - INVARIANT/duplicate_relation — конкурент закоммитил МЕЖДУ нашими стадиями: проверка
    //   id прошла (его строка ещё не была видна), а предпроверка связи parent (стадия 4
    //   batch, до первой записи) уже увидела его связь рутина→прогон. Связь с этим ключом
    //   существует только вместе с прогоном того же id, так что смысл тот же.
    // Любой иной отказ — дефект, а не состояние графа (предусловий у batch нет): поднимаем
    // доменной ошибкой, тик её залогирует, кнопка вернёт структурным отказом.
    const details = r.error.details as { reason?: string; invariant?: string } | undefined;
    const lostRace =
      (r.error.code === 'CONFLICT' && details?.reason === 'id_conflict') ||
      (r.error.code === 'INVARIANT' && details?.invariant === 'duplicate_relation');
    if (lostRace) return skip('id_conflict');
    throw new ExecError(
      r.error.code as ExecErrorCode,
      `прогон рутины не создан: ${r.error.message}`,
      { routine_id: args.routine.id, bucket: args.bucket, details: r.error.details },
    );
  }
  // Тот же batch уже исполнен конкурентом — сущность его, модель гонит он (Р-1)
  if (r.idempotentReplay) return skip('replay');
  return { started: true, runId, bucket: args.bucket };
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

// ---------------------------------------------------------------------------
// Владельческая половина (V1.6, V1.7, V1.9): ответ на вопрос прогона и решение по
// предложению. Поверхность — routers/routine.ts; здесь правила, там трансляция.
// ---------------------------------------------------------------------------

/** Предложение в аспекте прогона — форма, которую пишет и читает весь этот раздел. */
type RunProposal = NonNullable<AgentRunAspect['proposal']>;

/**
 * Ответ владельца на вопрос прогона рутины (V1.9, приёмка 10): вопрос закрыт, исход
 * прогона становится `answered`, реплика ложится в `reply` — оттуда её прочтёт СЛЕДУЮЩИЙ
 * прогон (routineHistory), и рутина не спросит то же самое второй раз.
 *
 * Своя процедура, а не `agentRun.answerCheckpoint`: там ответ возвращает в работу ТИКЕТ
 * (второй операцией батча), а у рутины тикета нет вовсе — прогон терминален, и «вернуть в
 * работу» нечего. Общего между ними ровно одна операция, и объединение стоило бы ветки
 * «есть ли тикет» внутри пути, который обязан быть простым.
 *
 * ОДНА операция под предусловием `outcome: 'checkpoint'`: между чтением и записью вопрос
 * мог снять новый прогон (`supersedeOpen` переводит его в `stale`) — тогда отвечать уже
 * не на что, и CONFLICT честнее записи ответа в снятый вопрос. Обратная гонка закрыта
 * там же: гашение проверяет своё предусловие тем же способом.
 *
 * Атрибуция — `owner`/`ui` плюс `runId` (см. шапку модуля): ссылка ставит ответ рядом с
 * вопросом на экране прогона, а `source: 'ui'` не даёт откату прогона снять его как работу
 * исполнителя (rollback.ts `isRunAction`, инвариант 7).
 */
export async function answerRoutineCheckpoint(
  deps: RoutineWriteDeps,
  args: { ownerId: string; runId: string; answer: string },
): Promise<{ runId: string }> {
  const row = await withIdentity(deps.db, args.ownerId, (tx) => runById(tx, args.runId));
  // Чужой, несуществующий и ТИКЕТНЫЙ прогон здесь неразличимы намеренно: у тикетного своя
  // процедура (agentRun.answerCheckpoint), и отвечать на него отсюда — не «нельзя», а
  // «не тем ключом»; NOT_FOUND сообщает ровно это, не рассказывая про чужой граф.
  if (row === null || row.run.routine_id === undefined) {
    throw new ExecError('NOT_FOUND', 'прогон рутины не найден', { runId: args.runId });
  }
  if (row.run.outcome !== 'checkpoint') {
    throw new ExecError('CONFLICT', `прогон не ждёт ответа (${row.run.outcome})`, {
      runId: args.runId,
      outcome: row.run.outcome,
    });
  }

  const patched = await patchAspect(deps, {
    ownerId: args.ownerId,
    id: args.runId,
    aspect: 'orbis/agent-run',
    patch: {
      reply: { text: args.answer, at: deps.clock().toISOString() },
      outcome: 'answered',
    },
    precondition: [{ aspect: 'orbis/agent-run', field: 'outcome', in: ['checkpoint'] }],
    actor: { kind: 'owner', source: 'ui', runId: args.runId },
  });
  if (!patched.ok) throw toExecError(patched.error);
  return { runId: args.runId };
}

/**
 * Одна строка предложения на экране владельца. НЕ операция payload'а: одна правка
 * `entity_update` может тронуть два поля, и владелец обязан увидеть обе строкой каждая —
 * «принять список правок, а не пересказ модели» (V1.14). Поэтому `index` — номер ОПЕРАЦИИ
 * в предложении, и у строк одной операции он общий (ключ строки на экране — пара с
 * `aspect`/`field`).
 *
 * Подписи полей здесь НЕ переводятся: сервер отдаёт ключи (`orbis/task`, `status`), а
 * человеческие имена знает web (fieldLabel) — второй словарь подписей на сервере разошёлся
 * бы с экранным на первой же новой схеме. `summary` — запасной текст той же строки для
 * мест, где словаря нет.
 */
export interface ProposalOperationView {
  /** Номер операции в предложении; у строк одной операции общий. */
  index: number;
  /** Имя тула операции (`entity_update`, `entity_create`, `relation_*`). */
  tool: string;
  /** Цель под identity владельца: id и ЗАГОЛОВОК (у связей — конец-источник). */
  entity?: { id: string; title: string };
  aspect?: string;
  field?: string;
  /**
   * Текущее значение на момент СОСТАВЛЕНИЯ предложения — снятое предусловие (V1.7), а не
   * значение «сейчас»: именно с ним предложение будет сверяться на «Принять», и именно
   * его расхождение сделает предложение устаревшим. Литерал `'absent'` значит «поля не
   * было». Ключа нет там, где предусловия нет вовсе (заголовок, метки, тело, создание).
   */
  before?: unknown;
  /** Значение, которое встанет после применения. */
  after?: unknown;
  summary: string;
}

/** Расхождение предусловия в человекочитаемой форме — как оно лежит в аспекте прогона. */
export interface ProposalMismatchNote {
  aspect: string;
  field: string;
  note: string;
}

/**
 * Предложение рутины целиком для экрана (V1.6, V1.14): статус берётся с ПРОГОНА (он
 * источник правды о судьбе), операции — из сохранённого payload'а pending'а, объяснение —
 * из карточки. Клиентского срока годности у предложения нет: «протухло» решает сервер.
 */
export interface ProposalView {
  pendingId: string;
  runId: string;
  routineId: string;
  status: ProposalStatus;
  explanation: string;
  decidedAt?: string;
  /** Заполнено у статуса `stale`: чем именно предложение разошлось с графом. */
  mismatches?: ProposalMismatchNote[];
  operations: ProposalOperationView[];
}

/**
 * Исход решения владельца по предложению (V1.6, V1.7).
 *
 * `stale` — ЗНАЧЕНИЕ, а не исключение (рулинг Р-2): «состояние изменилось, вот что именно»
 * это ответ экрану, который он рисует списком расхождений, а не сбой, на который
 * показывают плашку ошибки. `already` — предложение уже решено (владельцем со второго
 * экрана, гашением нового прогона, прошлой проверкой предусловий): повторное нажатие
 * обязано быть безопасным и внятным, а не вторым решением поверх первого.
 */
export type DecideProposalResult =
  | { status: 'applied'; actionId: string }
  | { status: 'stale'; mismatches: PreconditionMismatch[] }
  | { status: 'rejected' }
  | { status: 'already'; proposalStatus: ProposalStatus };

/** Максимум строк разбора в аспекте прогона и потолок одной строки (schemas/aspects.ts). */
const MAX_MISMATCH_NOTES = 50;
const MISMATCH_NOTE_MAX = 500;

/** Заголовок цели, которой не видно под identity (удалена или не наша). */
const UNKNOWN_TITLE = 'запись недоступна';

/** Поля сущности вне аспектов, которые предложение может тронуть (entityUpdateInput). */
const CORE_FIELD_LABELS: Record<string, string> = {
  body: 'тело',
  title: 'заголовок',
  emoji: 'эмодзи',
  tags: 'метки',
  archived: 'архив',
  meta: 'служебные поля',
};

/** Структурированная ошибка обратно в доменную — её маппит в TRPCError роутер. */
function toExecError(error: StructuredError): ExecError {
  return new ExecError(error.code as ExecErrorCode, error.message, error.details);
}

/**
 * Предложение прогона для экрана. `null` — предложения нет: прогон не найден (чужой и
 * несуществующий под RLS неразличимы), это не рутинный прогон, предложения он не подавал
 * либо карточка не найдена. Все четыре случая для экрана — одно и то же «показывать
 * нечего», и различать их значило бы рассказывать про чужой граф.
 */
export async function proposalView(
  db: Db,
  args: { ownerId: string; runId: string },
): Promise<ProposalView | null> {
  return withIdentity(db, args.ownerId, async (tx) => {
    const row = await runById(tx, args.runId);
    if (row === null) return null;
    const routineId = row.run.routine_id;
    const proposal = row.run.proposal;
    if (routineId === undefined || proposal === undefined) return null;

    const stored = await storedProposal(tx, args.runId);
    if (stored === null) return null;

    return {
      pendingId: proposal.pending_id,
      runId: args.runId,
      routineId,
      status: proposal.status,
      // Проза предложения живёт в карточке, а `report` прогона — её же копия (propose.ts
      // кладёт explanation обоими путями). Карточка первична: она — то, что видел владелец.
      explanation: stored.explanation ?? row.run.report ?? '',
      ...(proposal.decided_at !== undefined && { decidedAt: proposal.decided_at }),
      ...(proposal.mismatches !== undefined && { mismatches: proposal.mismatches }),
      operations: await describeOperations(tx, stored.operations),
    };
  });
}

/**
 * Решение владельца по предложению (V1.6): «Принять» исполняет СОХРАНЁННЫЙ payload без
 * обращения к модели, «Отклонить» закрывает предложение, не трогая граф.
 *
 * Порядок обеих веток один и тот же и повторяет `supersedeOpen`: сначала судьба pending'а
 * (исполнение либо отказ), потом статус на прогоне. Обратный порядок оставлял бы окно, в
 * котором прогон уже говорит «решено», а кнопка на карточке ещё работает.
 *
 * Уже решённое предложение сюда не доходит: статус, отличный от `pending`, — это `already`
 * с ЕГО статусом. В том числе `superseded` и `stale`: погашенное новым прогоном или
 * разошедшееся с графом предложение принадлежит не этой кнопке, и переписывать его судьбу
 * своим «отклонено» значило бы соврать владельцу про то, что произошло на самом деле.
 */
export async function decideProposal(
  deps: RoutineWriteDeps,
  args: { ownerId: string; runId: string; decision: 'approve' | 'reject' },
): Promise<DecideProposalResult> {
  const proposal = await readProposal(deps.db, args.ownerId, args.runId);
  if (proposal.status !== 'pending') {
    return { status: 'already', proposalStatus: proposal.status };
  }
  return args.decision === 'approve'
    ? approveProposal(deps, args.ownerId, args.runId, proposal)
    : rejectProposal(deps, args.ownerId, args.runId, proposal);
}

/**
 * Прогон с предложением под RLS. NOT_FOUND (а не «нет предложения») на тикетном прогоне:
 * решать предложения там нечего, и различать «чужой прогон» от «прогон без предложения»
 * владельцу незачем — обе кнопки просто не существуют.
 */
async function readProposal(db: Db, ownerId: string, runId: string): Promise<RunProposal> {
  const row = await withIdentity(db, ownerId, (tx) => runById(tx, runId));
  if (row === null || row.run.routine_id === undefined) {
    throw new ExecError('NOT_FOUND', 'прогон рутины не найден', { runId });
  }
  if (row.run.proposal === undefined) {
    throw new ExecError('NOT_FOUND', 'у прогона нет предложения', { runId });
  }
  return row.run.proposal;
}

/** Статус предложения прогона СЕЙЧАС — перечитывается после проигранной гонки. */
async function currentStatus(
  db: Db,
  ownerId: string,
  runId: string,
): Promise<ProposalStatus | undefined> {
  const row = await withIdentity(db, ownerId, (tx) => runById(tx, runId));
  return row?.run.proposal?.status;
}

/** Какой статус на прогоне соответствует уже записанной причине отказа (V1.8). */
const STATUS_BY_REJECT_REASON: Record<RejectReason, ProposalStatus> = {
  owner: 'rejected',
  superseded: 'superseded',
  stale: 'stale',
};

/**
 * Чужое решение, которое уже легло: статус с прогона, а если конкурент ещё не дописал его
 * (reject-строка и статус пишутся двумя шагами) — статус, выведенный из ЕГО причины
 * отказа. Отдавать в этом окне «ждёт решения» значило бы предложить владельцу нажать
 * кнопку, которая уже ничего не сделает.
 */
async function foreignDecision(
  db: Db,
  ownerId: string,
  runId: string,
  reason: RejectReason,
): Promise<DecideProposalResult> {
  const status = await currentStatus(db, ownerId, runId);
  return {
    status: 'already',
    proposalStatus:
      status !== undefined && status !== 'pending' ? status : STATUS_BY_REJECT_REASON[reason],
  };
}

/**
 * «Принять» (V1.6): approve исполняет сохранённый payload полным конвейером — это и есть
 * ревалидация. Три исхода конвейера разведены нарочно:
 *  - применилось: статус `approved` на прогоне, наружу `applied` с id действия (по нему
 *    работает «Отменить» §7.8);
 *  - предусловие не выполнено (V1.7): предложение УСТАРЕЛО — карточка гасится причиной
 *    `stale`, разбор расхождений ложится на прогон, наружу идёт значение, а не исключение;
 *  - любая другая ошибка: наружу исключением. Это принятая цена контракта pending
 *    (§7.10) — полная валидация делается на approve, поэтому структурная ошибка возможна
 *    ПОСЛЕ нажатия «Принять».
 */
async function approveProposal(
  deps: RoutineWriteDeps,
  ownerId: string,
  runId: string,
  proposal: RunProposal,
): Promise<DecideProposalResult> {
  const applied = await approvePending(deps.db, {
    ownerId,
    pendingId: proposal.pending_id,
    clock: deps.clock,
  });

  if (applied.ok) {
    const settled = await settleProposal(deps, { ownerId, runId, proposal, status: 'approved' });
    return settled.written
      ? { status: 'applied', actionId: applied.actionId }
      : { status: 'already', proposalStatus: settled.proposalStatus };
  }

  const mismatches = preconditionMismatches(applied.error);
  if (mismatches === null) {
    // Не «устарело». Одна причина отказа всё же означает не сбой, а чужое решение: pending
    // отклонили между нашим чтением статуса и approve (гашение новым прогоном идёт именно
    // в таком порядке). Отличаем её по факту, а не по тексту: если предложение с тех пор
    // решено, это `already`, и владелец увидит, чей это был ход.
    const status = await currentStatus(deps.db, ownerId, runId);
    if (status !== undefined && status !== 'pending') {
      return { status: 'already', proposalStatus: status };
    }
    throw toExecError(applied.error);
  }

  // Порядок как у гашения: сначала карточка, потом статус — иначе прогон говорил бы
  // «устарело», а кнопка «Принять» ещё работала бы
  const rejected = await rejectPending(deps.db, {
    ownerId,
    pendingId: proposal.pending_id,
    reason: 'stale',
  });
  if (!rejected.ok) {
    // Карточка не погашена: применимее предложение от этого не стало — разбор всё равно
    // пишем, а неудачу гашения логируем (владелец увидит статус, а не зависшую кнопку)
    console.error('[routines] устаревшее предложение не отклонено:', rejected.error);
  } else if (rejected.alreadyRejected && rejected.reason !== 'stale') {
    // Пока мы ревалидировали, предложение снял кто-то другой — его решение старше нашего
    return foreignDecision(deps.db, ownerId, runId, rejected.reason);
  }

  const settled = await settleProposal(deps, {
    ownerId,
    runId,
    proposal,
    status: 'stale',
    mismatches: mismatchNotes(mismatches),
  });
  return settled.written
    ? { status: 'stale', mismatches }
    : { status: 'already', proposalStatus: settled.proposalStatus };
}

/** «Отклонить» (V1.6, приёмка 5): карточка закрыта причиной `owner`, граф не тронут. */
async function rejectProposal(
  deps: RoutineWriteDeps,
  ownerId: string,
  runId: string,
  proposal: RunProposal,
): Promise<DecideProposalResult> {
  const rejected = await rejectPending(deps.db, {
    ownerId,
    pendingId: proposal.pending_id,
    reason: 'owner',
  });
  if (!rejected.ok) throw toExecError(rejected.error);
  // Повтор собственной кнопки (`owner`) — дописываем недописанный статус; чужая причина
  // (`superseded`/`stale`) — чужое решение, и переписывать его своим «отклонено» нельзя
  if (rejected.alreadyRejected && rejected.reason !== 'owner') {
    return foreignDecision(deps.db, ownerId, runId, rejected.reason);
  }

  const settled = await settleProposal(deps, { ownerId, runId, proposal, status: 'rejected' });
  return settled.written
    ? { status: 'rejected' }
    : { status: 'already', proposalStatus: settled.proposalStatus };
}

/**
 * Статус предложения на прогоне — под CAS на ВЕСЬ объект `proposal`, ровно как в
 * `supersedeOpen`: вложенное поле грамматика предусловий адресовать не умеет, а целый
 * объект умеет, и чужое решение, легшее между чтением и патчем, останется нетронутым.
 *
 * `written: false` значит «пока мы решали, решил кто-то другой» — вызывающий отвечает
 * `already` с ЕГО статусом. Иная (не CAS) неудача патча статуса уже случившегося не
 * отменяет: batch на approve исполнен, отказ карточки записан, — поэтому она логируется,
 * а решение считается состоявшимся.
 */
async function settleProposal(
  deps: RoutineWriteDeps,
  args: {
    ownerId: string;
    runId: string;
    proposal: RunProposal;
    status: ProposalStatus;
    mismatches?: ProposalMismatchNote[];
  },
): Promise<{ written: true } | { written: false; proposalStatus: ProposalStatus }> {
  const mismatches = args.mismatches ?? args.proposal.mismatches;
  const patched = await patchAspect(deps, {
    ownerId: args.ownerId,
    id: args.runId,
    aspect: 'orbis/agent-run',
    patch: {
      proposal: {
        pending_id: args.proposal.pending_id,
        status: args.status,
        decided_at: deps.clock().toISOString(),
        ...(mismatches !== undefined && { mismatches }),
      },
    },
    precondition: [{ aspect: 'orbis/agent-run', field: 'proposal', in: [args.proposal] }],
    actor: { kind: 'owner', source: 'ui', runId: args.runId },
  });
  if (patched.ok) return { written: true };
  if (patched.error.code !== 'CONFLICT') {
    console.error(`[routines] статус предложения не записан на ${args.runId}:`, patched.error);
    return { written: true };
  }
  const status = await currentStatus(deps.db, args.ownerId, args.runId);
  return { written: false, proposalStatus: status ?? args.proposal.status };
}

/**
 * Расхождения предусловия из ошибки конвейера — либо `null`, если отказ не про них.
 * Разбор идёт по `code` плюс `details.reason`, а не по тексту: CONFLICT означает ещё и
 * занятый client-UUID (см. errors.ts), и потребитель не должен гадать по сообщению.
 */
function preconditionMismatches(error: StructuredError): PreconditionMismatch[] | null {
  if (error.code !== 'CONFLICT') return null;
  const details = error.details as { reason?: string; mismatches?: unknown } | undefined;
  if (details?.reason !== 'precondition_failed') return null;
  return Array.isArray(details.mismatches) ? (details.mismatches as PreconditionMismatch[]) : [];
}

/**
 * Расхождения в форме, которая ложится в аспект прогона (V1.4): человекочитаемая строка
 * вместо сырых значений. Она переживает саму карточку и читается на экране прогона спустя
 * дни — «предусловие orbis/task.status не выполнено» там не сказало бы владельцу ничего.
 */
function mismatchNotes(mismatches: readonly PreconditionMismatch[]): ProposalMismatchNote[] {
  return mismatches.slice(0, MAX_MISMATCH_NOTES).map((m) => ({
    aspect: m.aspect,
    field: m.field,
    note: `ожидали ${expectedText(m.expected)}, сейчас ${actualText(m.actual)}`.slice(
      0,
      MISMATCH_NOTE_MAX,
    ),
  }));
}

function expectedText(expected: unknown[] | 'absent'): string {
  if (expected === 'absent') return 'поля не было';
  return expected.map(valueText).join(' или ');
}

function actualText(actual: unknown): string {
  return actual === undefined ? 'поля нет' : valueText(actual);
}

/** Значение поля в тексте: строка — в кавычках, остальное — своей JSON-формой. */
function valueText(value: unknown): string {
  if (typeof value === 'string') return `«${value}»`;
  return JSON.stringify(value) ?? String(value);
}

/** Операция payload'а pending'а — та самая exec-форма, которую собрал orbis_propose. */
interface StoredOperation {
  tool: string;
  input: Record<string, unknown>;
}

interface StoredProposal {
  operations: StoredOperation[];
  explanation?: string;
}

/**
 * Сохранённое предложение из ленты: payload и объяснение с карточки. Проба — containment
 * по `run_id` (индекс `chat_messages_metadata_gin`, форма `jsonb_path_ops`), а не по
 * pendingId: адресом предложения владеет прогон, и один и тот же запрос находит карточку
 * и тогда, когда статус на прогоне ещё не дописан.
 */
async function storedProposal(tx: Tx, runId: string): Promise<StoredProposal | null> {
  const probe = JSON.stringify({ pending: { run_id: runId } });
  const rows = await tx.execute(
    sql`SELECT metadata FROM chat_messages WHERE metadata @> ${probe}::jsonb LIMIT 1`,
  );
  const row = (rows as unknown as Array<Record<string, unknown>>)[0];
  if (row === undefined) return null;
  const metadata = row.metadata as {
    pending?: { input?: { operations?: unknown } };
    cards?: Array<{ kind?: string; explanation?: unknown }>;
  };
  const operations = metadata.pending?.input?.operations;
  if (!Array.isArray(operations)) return null;
  const card = metadata.cards?.find((c) => c.kind === 'proposal_card');
  return {
    operations: operations.filter(isStoredOperation),
    ...(typeof card?.explanation === 'string' && { explanation: card.explanation }),
  };
}

function isStoredOperation(value: unknown): value is StoredOperation {
  if (typeof value !== 'object' || value === null) return false;
  const op = value as { tool?: unknown; input?: unknown };
  return typeof op.tool === 'string' && typeof op.input === 'object' && op.input !== null;
}

/** Заголовки целей одним запросом: список правок без имён — это список uuid. */
async function titlesOf(tx: Tx, ids: readonly string[]): Promise<Map<string, string>> {
  const titles = new Map<string, string>();
  if (ids.length === 0) return titles;
  const rows = await tx.execute(
    sql`SELECT id, title FROM entities WHERE id IN (${sql.join(
      ids.map((id) => sql`${id}::uuid`),
      sql`, `,
    )})`,
  );
  for (const row of rows as unknown as Array<Record<string, unknown>>) {
    titles.set(String(row.id), String(row.title));
  }
  return titles;
}

/** id, на которые ссылаются операции: цель правки и оба конца связи. */
function referencedIds(operations: readonly StoredOperation[]): string[] {
  const ids = new Set<string>();
  for (const op of operations) {
    for (const key of ['id', 'source_id', 'target_id']) {
      const value = op.input[key];
      if (typeof value === 'string') ids.add(value);
    }
  }
  return [...ids];
}

/** Предложение построчно: заголовки резолвятся под identity владельца (RLS). */
async function describeOperations(
  tx: Tx,
  operations: readonly StoredOperation[],
): Promise<ProposalOperationView[]> {
  const titles = await titlesOf(tx, referencedIds(operations));
  const rows: ProposalOperationView[] = [];
  for (const [index, op] of operations.entries()) {
    if (op.tool === 'entity_create') {
      rows.push(createRow(index, op.input));
    } else if (op.tool === 'relation_create' || op.tool === 'relation_delete') {
      rows.push(relationRow(index, op, titles));
    } else if (op.tool === 'entity_update') {
      rows.push(...updateRows(index, op.input, titles));
    } else {
      // Реестр предложения сужен (PROPOSAL_ALLOWED_TOOLS), сюда попасть нечему; но молча
      // проглотить незнакомую строку значило бы показать владельцу неполный список
      rows.push({ index, tool: op.tool, summary: op.tool });
    }
  }
  return rows;
}

function titleOf(titles: ReadonlyMap<string, string>, id: string): string {
  return titles.get(id) ?? UNKNOWN_TITLE;
}

function createRow(index: number, input: Record<string, unknown>): ProposalOperationView {
  const title = typeof input.title === 'string' ? input.title : 'без заголовка';
  const aspects = Object.keys((input.aspects as Record<string, unknown> | undefined) ?? {});
  return {
    index,
    tool: 'entity_create',
    // id у создания может и не быть (его выдаст executor) — тогда ссылаться не на что
    ...(typeof input.id === 'string' && { entity: { id: input.id, title } }),
    summary: aspects.length > 0 ? `Создать: ${title} (${aspects.join(', ')})` : `Создать: ${title}`,
  };
}

function relationRow(
  index: number,
  op: StoredOperation,
  titles: ReadonlyMap<string, string>,
): ProposalOperationView {
  const sourceId = String(op.input.source_id);
  const targetId = String(op.input.target_id);
  const type = String(op.input.relation_type);
  const from = titleOf(titles, sourceId);
  const to = titleOf(titles, targetId);
  const verb = op.tool === 'relation_create' ? 'Связь' : 'Убрать связь';
  return {
    index,
    tool: op.tool,
    entity: { id: sourceId, title: from },
    summary: `${verb} ${type}: «${from}» → «${to}»`,
  };
}

/**
 * Правка построчно. «Было» берётся из СНЯТОГО предусловия (V1.7), а не из графа сейчас:
 * предложение сверится именно с ним, и показать владельцу «сейчас» значило бы нарисовать
 * согласие там, где будет отказ.
 *
 * Поля вне аспектов (заголовок, метки, тело, архив) предусловий не имеют вовсе — у тела
 * своё CAS по `updated_at`, у остальных нет и его. Такая строка едет без `before`: «что
 * встанет» владелец видит, «что было» ему покажет сама запись.
 */
function updateRows(
  index: number,
  input: Record<string, unknown>,
  titles: ReadonlyMap<string, string>,
): ProposalOperationView[] {
  const id = String(input.id);
  const entity = { id, title: titleOf(titles, id) };
  const before = preconditionValues(input.precondition);
  const rows: ProposalOperationView[] = [];

  const aspects = input.aspects as Record<string, Record<string, unknown> | null> | undefined;
  for (const [aspect, patch] of Object.entries(aspects ?? {})) {
    if (patch === null) continue; // снятие аспекта предложением запрещено (propose.ts)
    for (const [field, after] of Object.entries(patch)) {
      const known = before.get(`${aspect} ${field}`);
      rows.push({
        index,
        tool: 'entity_update',
        entity,
        aspect,
        field,
        ...(known !== undefined && { before: known.value }),
        after,
        summary: `«${entity.title}»: ${aspect}.${field}`,
      });
    }
  }
  for (const [field, label] of Object.entries(CORE_FIELD_LABELS)) {
    if (input[field] === undefined) continue;
    rows.push({
      index,
      tool: 'entity_update',
      entity,
      field,
      after: input[field],
      summary: `«${entity.title}»: ${label}`,
    });
  }
  // Операция без единой видимой правки быть не может (её отклонил бы сам executor), но
  // пустой список строк на экране читался бы как «предложение пустое» — показываем цель
  if (rows.length === 0) {
    rows.push({ index, tool: 'entity_update', entity, summary: `«${entity.title}»` });
  }
  return rows;
}

/**
 * Значения снятых предусловий по ключу «аспект + поле». Обёртка `{ value }` не декоративна:
 * само значение бывает `null` и `false`, и различать «предусловия нет» от «предусловие
 * есть, и оно про null» по самому значению было бы нельзя.
 */
function preconditionValues(precondition: unknown): Map<string, { value: unknown }> {
  const out = new Map<string, { value: unknown }>();
  if (!Array.isArray(precondition)) return out;
  for (const item of precondition) {
    if (typeof item !== 'object' || item === null) continue;
    const p = item as { aspect?: unknown; field?: unknown; in?: unknown; absent?: unknown };
    if (typeof p.aspect !== 'string' || typeof p.field !== 'string') continue;
    const key = `${p.aspect} ${p.field}`;
    if (p.absent === true) {
      // Литерал `'absent'` — контракт ProposalOperationView.before: «поля не было»
      out.set(key, { value: 'absent' });
    } else if (Array.isArray(p.in) && p.in.length > 0) {
      out.set(key, { value: p.in[0] });
    }
  }
  return out;
}
