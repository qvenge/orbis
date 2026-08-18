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
// Атрибуция всех записей этого модуля — `actorKind: 'ai'`, `source: 'system'` (рулинг
// Р-7/В1): это протокол ведения прогонов, а не правка графа по существу. Отсюда два
// следствия, ради которых источник и выбран: «отмени последнее» (undoLast пропускает
// только `system`) не снимает пометку «заменено» вместо правки модели, а инвариант
// запрета по объекту (V1.10, молчит для владельческих и системных источников) не блокирует
// паузу самой рутины.
import {
  isManualBucket,
  manualBucket,
  newId,
  routineRunBatchId,
  routineRunId,
} from '@orbis/shared';
import { type RunRow, runSummary, runsForBucket, runsOfParent } from '../agent-loop/queries';
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
import { ExecError, type ExecErrorCode } from '../errors';
import { execute } from '../executor/executor';
import { makeChatJournalSink } from '../executor/journal';
import type { JournalSink } from '../executor/types';
import type { LLMProvider } from '../llm/types';
import { rejectPending } from '../policy/pending';
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
