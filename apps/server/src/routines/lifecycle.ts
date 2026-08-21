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
// Атрибуция расщеплена (см. PatchActor): ответ на вопрос — `owner`/`ui` со ссылкой на
// прогон (это реплика владельца, и «отмени последнее» вправе её снять), а пометка судьбы
// предложения — `owner`/`system` со ссылкой на прогон: это бухгалтерия О прогоне, само же
// решение владельца воплощено батчем принятого предложения (source `routine`), и именно
// его снимает «отмени последнее» (приёмка 3) и откат прогона (приёмка 11, rollback.ts).
import {
  type AgentRunAspect,
  entityThreadId,
  isManualBucket,
  manualBucket,
  newId,
  type PreconditionMismatch,
  type ProposalStatus,
  pendingMessageId,
  routineRunBatchId,
  routineRunId,
} from '@orbis/shared';
import type { BodyDoc } from '@orbis/shared/doc';
import { sql } from 'drizzle-orm';
import { type RunRow, runById, runSummary, runsOfParent } from '../agent-loop/queries';
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
import {
  acquirePendingLock,
  approvePending,
  createPending,
  listRunUnits,
  type RejectReason,
  rejectedReason,
  rejectPending,
  rejectPendingTx,
  stalePendingQuestion,
} from '../policy/pending';
import { wallClockIn } from '../recurring/materialize';
import {
  CONSECUTIVE_FAILURES_TO_PAUSE,
  CORE_FIELD_LABELS,
  editsNoun,
  MAX_ATTEMPTS,
  RETRY_DELAYS_MS,
  ROUTINE_HISTORY_TAIL,
} from './constants';
import type { RoutineHistoryItem } from './context';
import {
  buildEditedOperations,
  countProposalRows,
  editsHash,
  isEmptyEdits,
  type ProposalEdits,
} from './edits';
import { processRoutineLocks, type RoutineLocks } from './locks';
import { type ProposalBodyDiff, type ProposalBodyRow, proposalBodyRows } from './proposal-diff';

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
  /**
   * In-process замок по рутине вокруг «решить и создать прогон» (locks.ts): тик и «прогнать
   * сейчас» в одно окно иначе заводили бы два running с разными ключами. По умолчанию —
   * общий замок процесса; свой экземпляр подкладывают тесты межпроцессной гонки (два замка
   * = два процесса).
   */
  locks?: RoutineLocks;
}

/**
 * Итог гашения по ВСЕМ прошлым прогонам рутины. Числа погашенных ЕДИНИЦ пачки здесь нет
 * намеренно (D42, рулинг Р0-5): читателя у него сегодня нет ни одного — раннер зовёт
 * `supersedeOpen` ради самого гашения и результат не смотрит, — а расширять публичный
 * результат без читателя значит заводить мёртвый контракт. Понадобится «погашено N
 * отложек» в отчёте прогона — доедет одним полем, `closeOpenOfRun` его уже возвращает.
 */
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
 * Атрибуция патча (§7.8). Умолчание — бухгалтерия прогона (`ai`/`system`, рулинг Р-7).
 * Владельческие вызывающие переопределяют актора на `owner` со ссылкой на прогон, но
 * ИСТОЧНИК у них разный, и разница значима для Undo и отката:
 *  - ответ на вопрос — `ui`: реплика владельца, его действие в графе; «отмени последнее»
 *    вправе её снять, а откат прогона (rollback.ts) её не трогает и конфликтом не считает —
 *    у рутинного прогона инвертируется только работа источника `routine`;
 *  - судьба предложения (approved/rejected/stale) — `system`: пометка О прогоне, а не
 *    решение само по себе; решение владельца — это батч принятого предложения (`routine`),
 *    и «отмени последнее» после «Принять» обязано снять план, а не вернуть карточке кнопки
 *    (undoLast пропускает `system`, приёмка 3).
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
 * как «заменено», неотвеченный вопрос переходит в `stale`, а вся пачка единиц прошлого
 * прогона — отложенные действия и вопросы — получает свои судьбы (D42 ОЧ.8). Без этого к
 * пятнице у владельца четыре плана и три вопроса, и ни один не про сегодня.
 *
 * `exceptRunId` — текущий прогон: он единственный, кого гасить нельзя ни при каких
 * условиях (иначе раннер снял бы собственное предложение сразу после того, как подал его).
 *
 * Тело на один прогон — `closeOpenOfRun` (оно же у отката прогона): порядок, предусловия и
 * уважение к чужому решению описаны там.
 */
export async function supersedeOpen(
  deps: RoutineDeps,
  args: { ownerId: string; routineId: string; exceptRunId: string },
): Promise<SupersedeResult> {
  const runs = await withIdentity(deps.db, args.ownerId, (tx) => runsOfParent(tx, args.routineId));
  const out: SupersedeResult = { superseded: 0, staled: 0 };

  for (const row of runs) {
    if (row.id === args.exceptRunId) continue;
    const closed = await closeOpenOfRun(deps, {
      ownerId: args.ownerId,
      routineId: args.routineId,
      runId: row.id,
      run: row.run,
      reason: 'superseded',
      // Владелец видит в треде, почему вопрос пропал из «ждут меня» (V1.8)
      questionNote: 'Вопрос прошлого прогона снят: рутина сработала заново',
    });
    if (closed.proposal) out.superseded += 1;
    if (closed.question) out.staled += 1;
  }
  return out;
}

/**
 * Текст судьбы ЕДИНИЦЫ пачки (D42 ОЧ.8, замечание С6 ревью спеки). Свой, а не
 * `REJECT_CONTENT` из `policy/pending.ts`: тамошние строки писаны про предложение, и
 * владелец, увидев «Предложение заменено новым прогоном» на отложенной АРХИВАЦИИ,
 * прочитал бы неправду. Причина при этом та же самая — текст только представление, и
 * второго источника правды о судьбе он не заводит (её читают `rejectedReason` и пачка).
 *
 * Ключей два, а не четыре: гашение знает ровно эти причины. `owner` пишет кнопка
 * владельца, `edited` — лестница правки, и текст у них свой по месту.
 */
const UNIT_REJECT_CONTENT: Record<Extract<RejectReason, 'superseded' | 'stale'>, string> = {
  superseded: 'Отложенное действие снято новым прогоном',
  stale: 'Отложенное действие устарело: прогон откачен',
};

/**
 * Гашение открытого у ОДНОГО прогона — общее тело `supersedeOpen` (причина `superseded`:
 * рутина сработала заново) и отката прогона (rollback.ts, причина `stale`: прогон откачен,
 * его наследство больше не о чём).
 *
 * Гасится ТРОЙКА, а не «одно из двух» (D42 ОЧ.8): непринятое предложение получает причину
 * в ленте и статусом на прогоне; терминальный вопрос переходит в `stale` с системной
 * записью в тред рутины; вся ПАЧКА единиц прогона — отложенные действия и вопросы —
 * получает свои судьбы со своими текстами (`closeUnitsOfRun`). Раньше первая же
 * сработавшая ветка выходила из функции: у прогона могло быть либо предложение, либо
 * вопрос, и третьего не было вовсе. Теперь может быть всё сразу — поэтому ветки идут
 * подряд, а «гасить нечего» и CONFLICT обрывают ТОЛЬКО СВОЮ ветку.
 *
 * Порядок внутри пары «предложение»: СНАЧАЛА rejectPending, потом статус на прогоне.
 * Обратный порядок оставлял бы окно, в котором прогон уже говорит «заменено», а кнопка
 * «Принять» на карточке ещё работает — то есть владелец применил бы снятый план.
 * Обратная асимметрия безопасна: rejectPending идемпотентен (`alreadyRejected`), а
 * недописанный статус чинится следующим проходом. У единиц пачки — тот же порядок и тот
 * же довод, только вместо статуса на прогоне у них общий флажок `undecided`.
 *
 * Снятое НЕ пропадает: оно остаётся в истории прогона (спека V1.8) — уходит только из
 * «ждут меня». Ничего не бросает: гашение — гигиена, и её сбой не повод не сделать работу
 * (новый прогон, откат); штатные CONFLICT (владелец успел решить/ответить) молчат.
 */
export async function closeOpenOfRun(
  deps: RoutineWriteDeps,
  args: {
    ownerId: string;
    routineId: string;
    runId: string;
    run: AgentRunAspect;
    reason: Extract<RejectReason, 'superseded' | 'stale'>;
    /** Текст системной записи в тред рутины при снятии вопроса — он же текст судьбы вопросов пачки. */
    questionNote: string;
  },
): Promise<{ proposal: boolean; question: boolean; units: number }> {
  const { ownerId, routineId, runId, run, reason } = args;
  const out = { proposal: false, question: false, units: 0 };
  const now = deps.clock().toISOString();

  if (run.proposal?.status === 'pending') {
    const closed = await closeProposalOfRun(deps, { ownerId, proposal: run.proposal, reason });
    // `null` — гасить нечего: карточка исчезла, уже исполнена или решена ЧУЖОЙ причиной.
    // Статус на прогоне пишет тот, чей reason стоит в reject-строке (она — источник
    // правды, V1.8): наше «заменено» поверх его «отклонил» соврало бы владельцу про его
    // же решение. Ветка на этом кончается, но функция — нет: пачка ждёт своего гашения.
    if (closed !== null) {
      // `proposal` — вложенный объект, а merge аспекта пополевой: патчим его целиком,
      // иначе pending_id пропал бы вместе со ссылкой на карточку. Предусловие — тот же
      // объект, каким мы его прочитали (сравнение по JSON-форме, executor.ts): вложенное
      // поле `proposal.status` грамматика предусловий адресовать не умеет, а целый объект
      // умеет — и если решение владельца легло между чтением и патчем, CONFLICT оставит
      // его статус нетронутым.
      const patched = await patchAspect(deps, {
        ownerId,
        id: runId,
        aspect: 'orbis/agent-run',
        patch: {
          proposal: {
            pending_id: closed.pendingId,
            status: reason,
            decided_at: now,
            ...(closed.mismatches !== undefined && { mismatches: closed.mismatches }),
            // Происхождение предложения не зависит от его судьбы (Ш1.8): погашенное
            // родилось из правки владельца ровно так же, как живое, и потеряв поле здесь,
            // мы оборвали бы цепочку «кто чей потомок» молча — патч типом не проверяется
            ...(closed.editedFrom !== undefined && { edited_from: closed.editedFrom }),
          },
        },
        precondition: [{ aspect: 'orbis/agent-run', field: 'proposal', in: [run.proposal] }],
      });
      if (patched.ok) out.proposal = true;
      else if (patched.error.code !== 'CONFLICT') {
        console.error(`[routines] статус «${reason}» не записан на ${runId}:`, patched.error.code);
      }
    }
  }

  if (run.outcome === 'checkpoint') {
    const patched = await patchAspect(deps, {
      ownerId,
      id: runId,
      aspect: 'orbis/agent-run',
      patch: { outcome: 'stale' },
      // Под замком исход мог уже стать `answered` (владелец ответил секунду назад) —
      // тогда снимать вопрос нельзя: ответ важнее нового прогона
      precondition: [{ aspect: 'orbis/agent-run', field: 'outcome', in: ['checkpoint'] }],
    });
    if (patched.ok) {
      out.question = true;
      await withIdentity(deps.db, ownerId, (tx) =>
        appendSystemNote(tx, {
          ownerId,
          entityId: routineId,
          content: args.questionNote,
          metadata: { type: 'routine_stale', routine_id: routineId, run_id: runId },
        }),
      );
      // CONFLICT здесь — «владелец ответил, пока мы читали»: вопрос гасить уже нельзя
    } else if (patched.error.code !== 'CONFLICT') {
      console.error(`[routines] вопрос прогона ${runId} не снят:`, patched.error.code);
    }
  }

  const units = await closeUnitsOfRun(deps, args);
  out.units = units.closed;

  // Бухгалтерия пачки: разобранный прогон перестаёт числиться неразобранным. Условие
  // двойное, потому что случая тоже два: погасили сами — флажок точно стоял; не погасили
  // ничего, но флажок стоит — его не снял тот, кто решил последнюю единицу (сбой-лестница
  // §5, признанная цена), и починить это обязан следующий проход. `complete:false` не
  // снимает ничего: часть пачки могла остаться открытой, и «разобрано» было бы враньём.
  if ((units.closed > 0 || run.undecided === true) && units.complete) {
    // Снятие — ЗАПИСЬ `false`, а не удаление ключа: предиката «поля нет» у грамматики §6
    // не существует, и запросом «разобранную пачку» иначе не отличить от неразобранной.
    // Актор системный (§9.6, инвариант 5): пиши мы его от владельца, «отмени последнее»
    // после «Принять» сняло бы флажок вместо действия (undoLast пропускает `system`).
    const patched = await patchAspect(deps, {
      ownerId,
      id: runId,
      aspect: 'orbis/agent-run',
      patch: { undecided: false },
      actor: { ...ACCOUNTING_ACTOR, runId },
    });
    if (!patched.ok) {
      // Флажок — производная величина: не сняли сейчас — снимет следующее решение или
      // гашение (лестница §5). Ронять из-за него настоящую работу нечем оправдать.
      console.error(`[routines] флажок пачки не снят с ${runId}:`, patched.error.code);
    }
  }
  return out;
}

/**
 * Гашение ПАЧКИ одного прогона (D42 ОЧ.8): каждая ОТКРЫТАЯ единица получает свою судьбу —
 * отложенное действие отклоняется причиной гашения и своим текстом (С6), вопрос переходит
 * в `stale` тем же текстом, что уходит в тред при снятии терминального вопроса.
 *
 * Зовутся ОБЁРТКИ (`rejectPending(db, …)`, `stalePendingQuestion(db, …)`), а не tx-формы,
 * и это не небрежность: обе берут СВОЙ advisory-замок по единице, и вызов изнутри чужой
 * транзакции повис бы на нём до statement_timeout (докблок `rejectPending`). Открытой
 * транзакции здесь нет — `closeOpenOfRun` принимает `deps`, а не `tx`, и единственная
 * транзакция этой функции (чтение списка) закрывается ДО первого гашения. Понадобится
 * когда-нибудь звать гашение из открытой транзакции — заводить tx-формы, а не «обходить».
 *
 * Атомарности между единицами нет и не обещается (инвариант §9.2): пачка — не батч, и
 * крэш посреди обхода оставит часть погашенной, а остальное догасит следующий прогон.
 *
 * `complete:false` — обход не дошёл до конца (повреждённая pending-запись валит fail-closed
 * `listRunUnits`, отказ БД): открытые единицы могли остаться, и флажок `undecided` снимать
 * нельзя. Наружу при этом не бросаем — контракт `closeOpenOfRun` («ничего не бросает»)
 * держится намеренно: сорванная гигиена не повод не запустить новый прогон и не откатить
 * старый, а не погашенное владелец по-прежнему видит карточками в треде.
 */
async function closeUnitsOfRun(
  deps: RoutineWriteDeps,
  args: {
    ownerId: string;
    runId: string;
    reason: Extract<RejectReason, 'superseded' | 'stale'>;
    questionNote: string;
  },
): Promise<{ closed: number; complete: boolean }> {
  const { ownerId, runId, reason } = args;
  let closed = 0;
  try {
    // Порядок обхода — `created_at, id` самого `listRunUnits`: тай-брейк там не украшение,
    // а условие того, что два обхода берут замки единиц в одном порядке (взаимоблокировка)
    const units = await withIdentity(deps.db, ownerId, (tx) => listRunUnits(tx, ownerId, runId));
    for (const unit of units) {
      if (unit.fate !== 'open') continue;
      if (unit.kind === 'action') {
        const rejected = await rejectPending(deps.db, {
          ownerId,
          pendingId: unit.pendingId,
          reason,
          text: UNIT_REJECT_CONTENT[reason],
        });
        if (!rejected.ok) {
          // «Уже исполнено» и «карточки нет»: единица решена или её в ленте больше нет —
          // гасить нечего, и судьбу такой единицы пишет не гашение. Лог, а не отказ.
          console.error(
            `[routines] единица ${unit.pendingId} не погашена (${reason}):`,
            rejected.error.code,
          );
          continue;
        }
        // Чужая причина старше нашей (владелец отклонил сам, лестница правки): судьба уже
        // записана, и в счёт погашенного эта единица не идёт
        if (!rejected.alreadyRejected) closed += 1;
      } else {
        // `staled:false` — либо вопрос отвечен (ОТВЕТ ВАЖНЕЕ ГАШЕНИЯ, ОЧ.8), либо погашен
        // раньше. Различать эти два случая незачем: и там, и там судьба уже есть, и не наша
        const staled = await stalePendingQuestion(deps.db, {
          ownerId,
          pendingId: unit.pendingId,
          text: args.questionNote,
        });
        if (staled.staled) closed += 1;
      }
    }
  } catch (e) {
    console.error(`[routines] пачка прогона ${runId} погашена не вся (${reason}):`, e);
    return { closed, complete: false };
  }
  return { closed, complete: true };
}

/**
 * Предел цепочки правок, за которой идёт гашение. Каждое звено — это один крэш между
 * шагами лестницы, так что двух уже почти не бывает; предел стоит не ради длины, а чтобы
 * порванные данные (ссылка на саму себя) не сделали гашение бесконечным.
 */
const MAX_EDIT_CHAIN = 8;

/**
 * Кого гасить у прогона и чью судьбу писать (V1.8 + Р-10). Обычно это само предложение
 * прогона, но указатель мог остаться на ИСХОДНОМ, которое владелец поправил, а живёт
 * правленое: перевод указателя идёт отдельной транзакцией, и крэш между ними — штатное
 * окно. Не пойди гашение за правкой, новый прогон погасил бы мертвеца и оставил живое
 * предложение, на которое никто не указывает: владелец видел бы кнопку «Принять» у плана,
 * которого рутина уже не предлагает.
 *
 * `null` — гасить нечего: карточка исчезла, уже исполнена или решена ЧУЖОЙ причиной.
 * Иначе — предложение, чью судьбу вызывающий и записывает на прогон.
 */
async function closeProposalOfRun(
  deps: RoutineWriteDeps,
  args: {
    ownerId: string;
    proposal: RunProposal;
    reason: Extract<RejectReason, 'superseded' | 'stale'>;
  },
): Promise<{ pendingId: string; editedFrom?: string; mismatches?: ProposalMismatchNote[] } | null> {
  const { ownerId, reason } = args;
  let pendingId = args.proposal.pending_id;
  let editedFrom = args.proposal.edited_from;
  for (let hop = 0; hop < MAX_EDIT_CHAIN; hop++) {
    const rejected = await rejectPending(deps.db, { ownerId, pendingId, reason });
    if (!rejected.ok) {
      // Карточка исчезла или уже исполнена: статус прогона тогда правит не гашение, а
      // decideProposal — переписывать его здесь значило бы соврать про судьбу
      console.error(`[routines] предложение не отклонено (${reason}):`, rejected.error);
      return null;
    }
    if (!rejected.alreadyRejected || rejected.reason === reason) {
      // Погасили сами либо дописываем недописанный статус прошлого прохода
      return {
        pendingId,
        ...(editedFrom !== undefined && { editedFrom }),
        // Разбор расхождений принадлежит ТОМУ предложению, у которого он снят: переносить
        // его на правленое значило бы приписать ему чужие расхождения
        ...(hop === 0 &&
          args.proposal.mismatches !== undefined && {
            mismatches: args.proposal.mismatches,
          }),
      };
    }
    // Чужое решение (владелец кнопкой, проверка предусловий) старше нашего
    if (rejected.reason !== 'edited') return null;
    const child = await withIdentity(deps.db, ownerId, (tx) => editedChildOf(tx, pendingId));
    if (child === undefined) {
      console.error(`[routines] предложение ${pendingId} погашено правкой без правленого`);
      return null;
    }
    editedFrom = pendingId;
    pendingId = child;
  }
  console.error(`[routines] цепочка правок длиннее ${MAX_EDIT_CHAIN} — гашение прекращено`);
  return null;
}

/** Тип системной записи стоп-крана в треде рутины (`metadata.type`). */
export const ROUTINE_PAUSED_NOTE_TYPE = 'routine_paused';

/**
 * Последний плановый провал, УЧТЁННЫЙ последней записью стоп-крана в треде рутины
 * (`metadata.run_id`), — граница, от которой счёт «три подряд» начинается заново.
 * `undefined` — записи нет (рутина ещё ни разу не вставала по стоп-крану) либо она старого
 * формата без `run_id` (записи до хвоста C1a-6): тогда считаются все, как прежде.
 */
async function lastPauseCut(
  tx: Tx,
  ownerId: string,
  routineId: string,
): Promise<string | undefined> {
  const probe = JSON.stringify({ type: ROUTINE_PAUSED_NOTE_TYPE });
  const rows = await tx.execute(
    sql`SELECT metadata ->> 'run_id' AS run_id
        FROM chat_messages
        WHERE thread_id = ${entityThreadId(ownerId, routineId)}::uuid
          AND metadata @> ${probe}::jsonb
        ORDER BY created_at DESC, id DESC
        LIMIT 1`,
  );
  const runId = (rows as unknown as Array<{ run_id: unknown }>)[0]?.run_id;
  return typeof runId === 'string' ? runId : undefined;
}

/**
 * Стоп-кран (V1.12): CONSECUTIVE_FAILURES_TO_PAUSE плановых прогонов подряд, закончившихся
 * `failed`, переводят рутину в `paused` с записью в её тред. Рутина, которая ломается
 * каждое утро, иначе ломается каждое утро месяц — и жжёт токены на каждой попытке.
 *
 * Считаются только ПЛАНОВЫЕ прогоны (бакет не `manual:`): ручной запускает владелец и
 * видит исход сразу, ставить его же кнопкой рутину на паузу было бы наказанием за проверку.
 *
 * Считаются только провалы НОВЕЕ последней записи стоп-крана (хвост C1a-6): запись несёт
 * `run_id` последнего учтённого провала, и прогоны до него включительно в новый счёт не
 * идут. Иначе после того, как владелец снял паузу, первый же плановый сбой (транзиент
 * провайдера) давал хвост [f, f, f] из СТАРЫХ провалов — пауза возвращалась немедленно, и
 * попытки 2–3 бакета не случались вовсе. Снятие паузы рукой владельца — это и есть «счёт с
 * нуля»: он сказал, что причина устранена.
 *
 * Идемпотентен и безопасен к повторному вызову (тик зовёт его каждую минуту для каждой
 * активной рутины — хвост C1b-3, крэш-луп): читает граф, пишет только при переходе
 * active → paused под предусловием.
 *
 * Принятая цена, названная в спеке прямо: временно исчерпанный лимит тоже ставит на паузу —
 * снимается рукой.
 */
export async function pauseIfFailing(
  deps: RoutineDeps,
  args: { ownerId: string; routineId: string },
): Promise<{ paused: boolean }> {
  const { runs, cut } = await withIdentity(deps.db, args.ownerId, async (tx) => ({
    runs: await runsOfParent(tx, args.routineId),
    cut: await lastPauseCut(tx, args.ownerId, args.routineId),
  }));
  const planned = runs.filter((r) => r.run.bucket !== undefined && !isManualBucket(r.run.bucket));
  // Граница — позиция учтённого провала в порядке создания (runsOfParent: created_at ASC);
  // если его среди плановых нет (запись без run_id либо про чужой id) — считаем все
  const cutIndex = cut === undefined ? -1 : planned.findIndex((r) => r.id === cut);
  const fresh = planned.slice(cutIndex + 1);
  const tail = fresh.slice(-CONSECUTIVE_FAILURES_TO_PAUSE);
  if (tail.length < CONSECUTIVE_FAILURES_TO_PAUSE) return { paused: false };
  if (!tail.every((r) => r.run.outcome === 'failed')) return { paused: false };
  const lastCounted = tail[tail.length - 1];
  if (lastCounted === undefined) return { paused: false }; // недостижимо: длина проверена

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
      // run_id — последний учтённый провал: граница следующего счёта (см. lastPauseCut)
      metadata: {
        type: ROUTINE_PAUSED_NOTE_TYPE,
        routine_id: args.routineId,
        run_id: lastCounted.id,
      },
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
 * минуту, когда идущий закончится. Внутри процесса это правило держит замок рутины
 * (`deps.locks`, locks.ts): снимок и создание идут под ним, и запуск другого ключа той же
 * рутины (ручной прогон, соседний бакет) в то же окно видит созданный прогон как `running`.
 * Между процессами замка нет — там один и тот же бакет сходится по batch_id/PK (Р-1), а
 * разные ключи (тик одного инстанса и кнопка на другом) остаются принятой щелью.
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
  // Под замком рутины — и чтение снимка, и создание (locks.ts): внутри процесса два запуска
  // одной рутины идут по очереди, и второй видит прогон первого как `running`
  return (deps.locks ?? processRoutineLocks).run(args.routine.id, () =>
    startBucketRunLocked(deps, args),
  );
}

async function startBucketRunLocked(
  deps: RoutineDeps,
  args: { ownerId: string; routine: StartRoutineRef; bucket: string },
): Promise<StartOutcome> {
  const { ownerId, routine, bucket } = args;
  const now = deps.clock();
  // ОДИН запрос и один снимок: слот вырезается из прогонов рутины в памяти, а не вторым
  // запросом (runsForBucket). Два запроса даже в одной tx под READ COMMITTED видят разные
  // снимки — конкурент мог закоммитить прогон между ними, и тогда «по рутине никто не
  // идёт», а «в слоте есть не-failed» = running классифицировался бы как «отработан»
  // (done). С одним снимком исход согласован: читали до коммита конкурента → идём в execute
  // и проигрываем там (replay/id_conflict); после → видим его running.
  const all = await withIdentity(deps.db, ownerId, (tx) => runsOfParent(tx, routine.id));
  const ofBucket = all.filter((r) => r.run.bucket === bucket);

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
  // Тот же замок, что у бакета (locks.ts): кнопка в секунду тика — второй, а не параллельный
  return (deps.locks ?? processRoutineLocks).run(args.routine.id, () =>
    startManualRunLocked(deps, args),
  );
}

async function startManualRunLocked(
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
 * Атрибуция — `owner`/`ui` плюс `runId` (см. PatchActor): ссылка ставит ответ рядом с
 * вопросом на экране прогона, а `source: 'ui'` держит его вне работы прогона — откат
 * рутинного прогона инвертирует только источник `routine` и ответ ни снимает, ни считает
 * конфликтом (rollback.ts, инвариант 7).
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
  /**
   * Различие тела построчно — только у строки тела и только у ЖИВОГО предложения (Ш1.1,
   * Ш1.2). У решённого поля нет: решать нечего, а тело записи с тех пор ушло вперёд.
   * `after` при этом остаётся всегда — это запасная форма показа при любом `skipped`.
   */
  bodyDiff?: ProposalBodyDiff;
  /** Документ предложенного тела — редактору слоя правки; см. ProposalBodyRow.proposedDoc. */
  proposedDoc?: BodyDoc;
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
  /**
   * Предложение рождено ПРАВКОЙ владельца: здесь id исходного, которое эта правка погасила
   * (Ш1.8). По нему экран подписывает карточки: живую — «правка владельца», исходную —
   * «заменено правкой владельца». Отдельного статуса «правлено» нет намеренно: статус
   * описывает судьбу живого предложения, а это — его происхождение.
   */
  editedFrom?: string;
  /**
   * Прогон убран в архив — след ОТКАТА рутинного прогона (rollback.ts): у принятого
   * предложения это значит «принято, затем откачено», и карточка обязана это сказать, а не
   * читаться как действующий план. Второй путь в архив — рука владельца из меню записи;
   * различить их нечем, поэтому подпись говорит про откат только у `approved`.
   */
  runArchived: boolean;
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
 *
 * `replaced` — пятый исход и отдельный вариант, а не поле внутри `already`: у `already`
 * смысл «предложение, по которому ты решаешь, уже решено», а здесь решать нечего вовсе —
 * прогон живёт ДРУГИМ предложением, и экран обязан перечитать и показать его, а не
 * дорисовать статус к тому, что видел.
 */
export type DecideProposalResult =
  | {
      status: 'applied';
      actionId: string;
      /**
       * Применено предложение, рождённое правкой владельца: здесь id ИСХОДНОГО, которое
       * эта правка погасила. Экран исходной карточки по нему понимает, что применено не
       * ровно то, что он показывал.
       */
      editedFrom?: string;
    }
  | {
      status: 'stale';
      mismatches: PreconditionMismatch[];
      /** Какое именно предложение устарело — карточке нужно узнать своё среди двух. */
      pendingId?: string;
    }
  | { status: 'rejected' }
  | { status: 'already'; proposalStatus: ProposalStatus }
  | {
      status: 'replaced';
      /** Предложение, которым прогон живёт СЕЙЧАС: карточка ведёт владельца на него. */
      livePendingId: string;
      /** Его статус — по нему экран решает, рисовать ли кнопки, не ходя за ним второй раз. */
      liveStatus: ProposalStatus;
      /** Почему умерло АДРЕСОВАННОЕ — причина его отказа, а не судьба живого. */
      reason: RejectReason;
    };

/** Максимум строк разбора в аспекте прогона и потолок одной строки (schemas/aspects.ts). */
const MAX_MISMATCH_NOTES = 50;
const MISMATCH_NOTE_MAX = 500;

/** Заголовок цели, которой не видно под identity (удалена или не наша). */
const UNKNOWN_TITLE = 'запись недоступна';

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
    // Архивный прогон ОТДАЁТСЯ (в отличие от `runById`): архив у рутинного прогона — след
    // отката, и карточка принятого-затем-откаченного предложения обязана остаться читаемой
    // в треде рутины, а не превратиться в «прогон не найден»
    const row = await runRowAnyArchive(tx, args.runId);
    if (row === null) return null;
    const routineId = row.run.routine_id;
    const proposal = row.run.proposal;
    if (routineId === undefined || proposal === undefined) return null;

    const stored = await storedProposal(tx, proposal.pending_id);
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
      ...(proposal.edited_from !== undefined && { editedFrom: proposal.edited_from }),
      runArchived: row.archived,
      // Дифф тела — только у живого предложения (Ш1.1): статус берётся с прогона, он же
      // источник правды о судьбе
      operations: await describeOperations(tx, stored.operations, {
        withDiff: proposal.status === 'pending',
      }),
    };
  });
}

/** Прогон по id С архивными — только для чтения предложения (см. proposalView). */
async function runRowAnyArchive(
  tx: Tx,
  runId: string,
): Promise<{ run: AgentRunAspect; archived: boolean } | null> {
  const rows = await tx.execute(
    sql`SELECT archived, aspects -> 'orbis/agent-run' AS run
        FROM entities
        WHERE id = ${runId}::uuid AND aspects ? 'orbis/agent-run'`,
  );
  const row = (rows as unknown as Array<Record<string, unknown>>)[0];
  if (row === undefined) return null;
  return { run: row.run as AgentRunAspect, archived: row.archived === true };
}

/**
 * Открытые предложения рутин, касающиеся записи (Ш1.3). Экран записи спрашивает сервер
 * «есть ли по мне план, которого я не видел» — владелец не обязан узнавать о предложении
 * из ленты чата, открыв запись сбоку.
 *
 * Ответ — СПИСОК, а не одно предложение: одну запись законно трогают предложения РАЗНЫХ
 * рутин (приёмка 18), и решение по каждому своё. Предложение из нескольких записей
 * находится по каждой из них (приёмка 17) и отдаётся целиком — слой показывает и строки
 * по соседней записи, иначе владелец принимал бы половину того, что видит. На практике
 * список из нуля или одного: у рутины открытых предложений не больше одного (V1.8).
 *
 * Порядок — по времени сообщения: старшее предложение первым, как в ленте.
 *
 * В ответе только ЖИВОЕ: `status === 'pending'` и прогон не в архиве. Проба это уже
 * проверила, но между её транзакцией и сборкой проходит вторая — за это окно владелец
 * успевает решить предложение из другой вкладки, а откат — убрать прогон в архив.
 * Перепроверка стоит одного сравнения и делает обещание экрану («всё, что здесь есть, —
 * pending, значит у строки тела есть `bodyDiff` и `proposedDoc`») правдой, а не почти
 * правдой.
 */
export async function openProposalsForEntity(
  db: Db,
  args: { ownerId: string; entityId: string },
): Promise<ProposalView[]> {
  const runIds = await withIdentity(db, args.ownerId, (tx) => liveProposalRuns(tx, args.entityId));
  const views: ProposalView[] = [];
  for (const runId of runIds) {
    // Сборка — тем же `proposalView`, что и у карточки: у него уже есть заголовки целей,
    // дифф тела и пометка происхождения, а вторая проекция того же предложения разъехалась
    // бы с первой на первой же правке. Запросов на предложение выходит больше, чем
    // минимально возможно, — цена принята: список это 0–1 элемент
    const view = await proposalView(db, { ownerId: args.ownerId, runId });
    if (view === null) continue;
    if (view.status !== 'pending' || view.runArchived) continue;
    views.push(view);
  }
  return views;
}

/**
 * Прогоны, чьё ЖИВОЕ предложение трогает запись. Проба — containment по сохранённому
 * payload'у pending-сообщения; вложенный массив внутри пробы законен и уже используется
 * эскалацией (ai/escalation.ts).
 *
 * Проб ТРИ, потому что затронуть запись предложение умеет тремя способами, и все три
 * обещаны экраном:
 *  - `input.id` — правка самой записи (`entity_update`); приёмки 3, 17, 18;
 *  - `input.source_id` — связь, у которой запись является началом. Карточка перечисляет
 *    источник связи отдельной строкой с `entity: {id: source_id}` (см. `relationRow`), а
 *    приёмка 2 обещает: тап по записи из карточки открывает слой. Без этой пробы тап вёл
 *    бы на запись без слоя — тупик того самого класса, против которого написан весь срез;
 *  - `input.target_id` — второй конец связи затронут не меньше первого: «связать эту
 *    задачу с проектом» меняет и проект, и приёмка 3 обещает плашку при ОБЫЧНОМ открытии
 *    любой затронутой записи.
 * Условия сложены `OR` в ОДНОМ запросе, а не тремя запросами с последующим слиянием: так
 * дедупликация и общий порядок получаются построением (сообщение, совпавшее по двум
 * пробам, — одна строка), а под RLS это ещё и один проход по таблице вместо трёх.
 *
 * ЗАМЕР, который стоит знать заранее: под `withIdentity` план этой пробы — **Seq Scan**, а не
 * обход `chat_messages_metadata_gin`. Стенд на 39 013 сообщений, под RLS: тройная форма —
 * **50–53 мс**, одна проба по `id` — 26.3 мс, `storedProposal` — 18.8 мс. То есть три условия
 * стоят вдвое против одного, а не втрое (проход по таблице один, лишний тут только фильтр);
 * ожидание ревью «три Seq Scan по 24 мс, итого ~72» этим замером опровергнуто.
 *
 * Форма проб тут ни при чём: на том же стенде в обход RLS все три индексируемы и идут по
 * `chat_messages_metadata_gin` за 0.23–0.31 мс каждая. Причина —
 * `jsonb_contains` не leakproof (`pg_proc.proleakproof = f`), и под политикой планировщик
 * не вправе опустить его в Index Cond; leakproof-условия (`uuid_eq`, `texteq`) индексы под
 * той же политикой берут. Это общее свойство ВСЕХ containment-проб под RLS
 * (`storedProposal`, `findPendingMessage`, `aspects @>` в entity_query), а не этой; лечится
 * не здесь — только столбцом со скалярным ключом вместо пробы по jsonb.
 *
 * `source: 'routine'` стоит в САМИХ пробах, а не фильтром после них: чат-подтверждение
 * несёт ровно те же операции по той же записи (тот же `batch_execute` с тем же `id`).
 * Ответ оно не испортило бы и без этого условия — его сторожит живость ниже, — но проба,
 * заведомо вытаскивающая чужие строки, живёт ровно до первой правки условий после неё, и
 * ровно этим условием проба ляжет на индекс в день, когда его станет можно взять.
 *
 * Живость — ТРИ условия сразу, и третье не избыточно. Прогон не в архиве: архив рутинного
 * прогона это след отката, решать по нему уже нечего. Статус `pending` на прогоне: он
 * источник правды о судьбе. И `proposal.pending_id === id сообщения` — потому что после
 * правки владельца в ленте лежат ДВА pending-сообщения одного прогона: погашенное
 * исходное и живое правленое. Операции по записи несут оба, а прогон снова `pending` — без
 * третьего условия владелец увидел бы на записи две плашки вместо одной, и одна из них
 * вела бы на мёртвое предложение. Оно же отсекает pending рутины, который предложением не
 * является вовсе (dispatch.ts:771 — подтверждение тула прогона несёт тот же `source` и тот
 * же `run_id`).
 */
async function liveProposalRuns(tx: Tx, entityId: string): Promise<string[]> {
  // Ключ операции, которым адресуется запись: правка зовёт её `id`, связь — концами
  // (`propose.ts` собирает relation_* как есть, полями source_id/target_id)
  const probe = (field: 'id' | 'source_id' | 'target_id'): string =>
    JSON.stringify({
      pending: { source: 'routine', input: { operations: [{ input: { [field]: entityId } }] } },
    });
  const rows = await tx.execute(
    sql`SELECT id, metadata -> 'pending' ->> 'run_id' AS run_id
        FROM chat_messages
        WHERE metadata @> ${probe('id')}::jsonb
           OR metadata @> ${probe('source_id')}::jsonb
           OR metadata @> ${probe('target_id')}::jsonb
        ORDER BY created_at, id`,
  );
  const runIds: string[] = [];
  for (const row of rows as unknown as Array<{ id: string; run_id: string | null }>) {
    // Предложение без прогона невозможно (propose.ts кладёт `run_id` всегда), но
    // адресоваться нечем — молча пропускаем, а не падаем на чужой форме метаданных
    if (row.run_id === null) continue;
    const found = await runRowAnyArchive(tx, row.run_id);
    if (found === null || found.archived) continue;
    const proposal = found.run.proposal;
    if (proposal === undefined || proposal.status !== 'pending') continue;
    if (proposal.pending_id !== row.id) continue;
    runIds.push(row.run_id);
  }
  return runIds;
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
 *
 * Адрес решения — ПРЕДЛОЖЕНИЕ (`pendingId`), а не прогон: у прогона их бывает несколько
 * (правка владельца гасит исходное и рождает новое), и «принимаю то, что вижу» —
 * обязательство сервера, а не вежливость клиента. Указатель прогона уехал на другое —
 * `replaced`; исполнить сохранённый payload, которого владелец не читал, нельзя ни при
 * каком удобстве.
 *
 * Правки (Ш1.5) едут только с «Принять» и только непустые: пустая правка — это ровно
 * сегодняшнее принятие, без второго предложения и без лестницы.
 */
export async function decideProposal(
  deps: RoutineWriteDeps,
  args: {
    ownerId: string;
    runId: string;
    pendingId: string;
    decision: 'approve' | 'reject';
    /** Что владелец поправил в предложении перед принятием (Ш1.4). */
    edits?: ProposalEdits;
  },
): Promise<DecideProposalResult> {
  // Пустая правка = правок нет (Развилка 12): клиент вправе слать `{}`, но заводить на
  // ней второе предложение значило бы плодить копии на каждом «Принять» без изменений
  const edits = args.edits !== undefined && !isEmptyEdits(args.edits) ? args.edits : undefined;
  if (args.decision === 'reject' && edits !== undefined) {
    // Отказ ничего не применяет, и принять правки «на память» некуда: журнал append-only,
    // а вид, будто они учтены, — худшее, что можно ответить владельцу
    throw new ExecError(
      'VALIDATION',
      'правки едут только с «Принять»: отклонение ничего не применяет',
      { reason: 'edits_on_reject' },
    );
  }

  const live = await readProposal(deps.db, args.ownerId, args.runId);
  const addressed = await addressedProposal(deps, { ...args, edits, live });
  if (addressed.kind === 'answer') return addressed.result;
  // Возобновление (Р-10): правленое предложение — наше, и решать по нему заново нечего,
  // надо ДОВЕСТИ применение. Статус при этом не проверяем: он уже может быть `approved`
  // (двойной тап), и ответ «уже решено» скрыл бы от владельца исход его же правки.
  // Решение здесь всегда `approve`: «наше» опознаётся по правке, а правки едут только с ним.
  if (addressed.kind === 'resume') {
    return approveProposal(deps, args.ownerId, args.runId, addressed.proposal);
  }

  const proposal = addressed.proposal;
  if (proposal.status !== 'pending') {
    return { status: 'already', proposalStatus: proposal.status };
  }
  if (args.decision === 'reject') {
    return rejectProposal(deps, args.ownerId, args.runId, proposal);
  }
  return edits === undefined
    ? approveProposal(deps, args.ownerId, args.runId, proposal)
    : editAndApprove(deps, {
        ownerId: args.ownerId,
        runId: args.runId,
        proposal,
        edits,
      });
}

/**
 * Чем кончилось приведение адреса решения к тому, чем прогон живёт на самом деле.
 *
 * `decide` — адрес и указатель сошлись, решаем это предложение обычным порядком;
 * `resume` — адресованное погашено ЭТОЙ ЖЕ правкой, и её правленое предложение надо
 * доводить, а не решать заново; `answer` — решать нечего, ответ готов.
 */
type AddressedProposal =
  | { kind: 'decide'; proposal: RunProposal }
  | { kind: 'resume'; proposal: RunProposal }
  | { kind: 'answer'; result: DecideProposalResult };

/**
 * Приведение адреса решения к указателю прогона — обе половины правила возобновления
 * (Ш1.5, Р-10).
 *
 * Лестница правки физически не может быть одной транзакцией (перевод указателя идёт через
 * executor, а тот открывает свою), поэтому состояние «исходное погашено, правленое лежит,
 * указатель не переехал» — не экзотика, а штатное крэш-окно. Довести его обязан ЛЮБОЙ, кто
 * на него наткнулся, с какой бы стороны ни пришёл:
 *  - адресовано ПРАВЛЕНОЕ, а указатель на его мёртвом родителе → доводим шаг 2 и решаем
 *    правленое, как если бы указатель переехал вовремя;
 *  - адресовано ИСХОДНОЕ, погашенное правкой → у него есть дитя; доводим шаг 2 и либо
 *    доводим применение (правка та же — владелец нажал второй раз), либо честно отвечаем
 *    «заменено» с адресом живого. Ответ `replaced` на МЁРТВОЕ замкнул бы круг: экран
 *    пошёл бы решать по нему и снова получил бы то же самое.
 */
async function addressedProposal(
  deps: RoutineWriteDeps,
  args: {
    ownerId: string;
    runId: string;
    pendingId: string;
    edits?: ProposalEdits;
    live: RunProposal;
  },
): Promise<AddressedProposal> {
  const { ownerId, runId, pendingId, live } = args;

  if (pendingId === live.pending_id) {
    // Быстрый путь. Одна проба всё же нужна: адресованное могла погасить правка, чей шаг 2
    // не дошёл, — тогда решать по нему нечего, а его дитя ждёт указателя. Авторитетную
    // проверку делает сама лестница под замком; здесь — как fast-path у approvePending.
    const reason = await withIdentity(deps.db, ownerId, (tx) => rejectedReason(tx, pendingId));
    if (reason !== 'edited') return { kind: 'decide', proposal: live };
    return takeoverEdited(deps, args, live);
  }

  // Адресовано дитя живого: правка прошла, а указатель не переехал
  const parent = await withIdentity(deps.db, ownerId, (tx) => editedFromOf(tx, pendingId));
  if (parent !== undefined && parent === live.pending_id) {
    const moved = await pointAtEdited(deps, { ownerId, runId, from: live, childId: pendingId });
    return moved.pending_id === pendingId
      ? { kind: 'decide', proposal: moved }
      : { kind: 'answer', result: await replacedProposal(deps.db, ownerId, pendingId, moved) };
  }

  const reason = await withIdentity(deps.db, ownerId, (tx) => rejectedReason(tx, pendingId));
  if (reason === 'edited') return takeoverEdited(deps, args, live);
  return { kind: 'answer', result: replacedBy(live, reason ?? 'superseded') };
}

/**
 * Адресованное предложение погашено ПРАВКОЙ — значит у него есть дитя (гонку за родителя
 * выигрывает ровно один, и шаг 1 атомарен, поэтому дитя единственно по построению).
 * Доводим шаг 2 и решаем, наша ли это правка: id дитяти детерминирован парой «родитель +
 * личность правки», так что совпадение id и означает «та же самая правка».
 */
async function takeoverEdited(
  deps: RoutineWriteDeps,
  args: { ownerId: string; runId: string; pendingId: string; edits?: ProposalEdits },
  live: RunProposal,
): Promise<Extract<AddressedProposal, { kind: 'resume' | 'answer' }>> {
  const { ownerId, runId, pendingId, edits } = args;
  const child = await withIdentity(deps.db, ownerId, (tx) => editedChildOf(tx, pendingId));
  if (child === undefined) {
    // Причина стоит, а дитяти нет: чинить нечем, но и врать про судьбу не станем
    console.error(`[routines] предложение ${pendingId} погашено правкой без правленого`);
    return { kind: 'answer', result: replacedBy(live, 'edited') };
  }
  const current =
    live.pending_id === pendingId
      ? await pointAtEdited(deps, { ownerId, runId, from: live, childId: child })
      : live;
  if (current.pending_id !== child) {
    // Указатель ушёл ещё дальше (цепочка правок либо гашение новым прогоном): чинит его
    // следующий заход владельца — по одному звену за раз
    return { kind: 'answer', result: replacedBy(current, 'edited') };
  }
  const mine = edits !== undefined && editedPendingId(ownerId, pendingId, edits) === child;
  return mine
    ? { kind: 'resume', proposal: current }
    : { kind: 'answer', result: replacedBy(current, 'edited') };
}

/**
 * Решение адресовано предложению, которым прогон больше не живёт.
 *
 * Причина — из отказа САМОГО адресованного, а не из судьбы живого: адресованное погасил
 * тот, кто увёл указатель, и владельцу важно, ПОЧЕМУ умерло то, что он читал. Отказа ещё
 * не видно (окно между гашением и переводом указателя, либо адрес вовсе выдуман) —
 * `superseded`: «его заменили», единственное, что известно наверняка.
 */
async function replacedProposal(
  db: Db,
  ownerId: string,
  addressedId: string,
  live: RunProposal,
): Promise<DecideProposalResult> {
  const reason = await withIdentity(db, ownerId, (tx) => rejectedReason(tx, addressedId));
  return replacedBy(live, reason ?? 'superseded');
}

function replacedBy(live: RunProposal, reason: RejectReason): DecideProposalResult {
  return {
    status: 'replaced',
    livePendingId: live.pending_id,
    liveStatus: live.status,
    reason,
  };
}

/**
 * Ключ дедупликации правленого предложения — «какую правку и какого предложения». Из него
 * `createPending` считает PK, поэтому двойной тап по «Принять» попадает в ТО ЖЕ
 * предложение и в тот же батч, а не применяет правку дважды.
 */
function editDedupeKey(parentId: string, edits: ProposalEdits): string {
  return `edit:${parentId}:${editsHash(edits)}`;
}

function editedPendingId(ownerId: string, parentId: string, edits: ProposalEdits): string {
  return pendingMessageId(ownerId, editDedupeKey(parentId, edits));
}

/**
 * Правленое предложение, рождённое из этого (Ш1.5) — контейнмент-проба по `edited_from`
 * (индекс `chat_messages_metadata_gin`). `LIMIT 1` честен: дитя единственно по построению.
 */
async function editedChildOf(tx: Tx, parentId: string): Promise<string | undefined> {
  const probe = JSON.stringify({ pending: { edited_from: parentId } });
  const rows = await tx.execute(
    sql`SELECT metadata FROM chat_messages WHERE metadata @> ${probe}::jsonb LIMIT 1`,
  );
  const row = (rows as unknown as Array<Record<string, unknown>>)[0];
  const id = (row?.metadata as { pending?: { id?: unknown } } | undefined)?.pending?.id;
  return typeof id === 'string' ? id : undefined;
}

/** Предложение, из правки которого рождено это; `undefined` — оно не правленое. */
async function editedFromOf(tx: Tx, pendingId: string): Promise<string | undefined> {
  const probe = JSON.stringify({ pending: { id: pendingId } });
  const rows = await tx.execute(
    sql`SELECT metadata FROM chat_messages WHERE metadata @> ${probe}::jsonb LIMIT 1`,
  );
  const row = (rows as unknown as Array<Record<string, unknown>>)[0];
  const from = (row?.metadata as { pending?: { edited_from?: unknown } } | undefined)?.pending
    ?.edited_from;
  return typeof from === 'string' ? from : undefined;
}

/** Чем кончился шаг 1 лестницы — гашение исходного и рождение правленого одной транзакцией. */
type EditStep1 =
  | { kind: 'created' }
  /** Исходное погасили раньше нас — своей же правкой (гонка, повтор) или чужим решением. */
  | { kind: 'raced'; reason: RejectReason }
  /** Указатель прогона уехал на другое предложение, пока мы шли к замку. */
  | { kind: 'moved' }
  /** Предложение решено между чтением и правкой. */
  | { kind: 'decided'; status: ProposalStatus };

/**
 * Лестница правки (Ш1.5): правка владельца порождает НОВОЕ провалидированное предложение,
 * исходное гаснет причиной `edited` в той же транзакции, указатель прогона переезжает
 * CAS'ом, и дальше — прежний конвейер принятия.
 *
 * Почему не «поправить payload на месте»: журнал append-only (§4.6), и переписанное
 * предложение стёрло бы то, что владелец читал. Почему не «применить правку мимо
 * pending'а»: применение обязано остаться работой прогона (source `routine`, тот же
 * `run_id`) — иначе принятая правка не откатится вместе с прогоном (приёмка 11) и не
 * снимется «отмени последнее» (приёмка 10).
 *
 * Предусловия НЕ переснимаются (Ш1.6): предложение сверяется ровно с тем состоянием, из
 * которого рутина его составила. Разошлось — `stale`, как и у неправленого.
 */
async function editAndApprove(
  deps: RoutineWriteDeps,
  args: { ownerId: string; runId: string; proposal: RunProposal; edits: ProposalEdits },
): Promise<DecideProposalResult> {
  const { ownerId, runId, proposal, edits } = args;
  const parentId = proposal.pending_id;
  const childId = editedPendingId(ownerId, parentId, edits);
  const step1 = await createEditedProposal(deps, { ...args, childId });

  if (step1.kind === 'decided') return { status: 'already', proposalStatus: step1.status };
  if (step1.kind === 'raced') {
    // Проиграли гонку за исходное. Своей же правкой — доводим её (дитя одно, и оно наше,
    // если хеш совпал); чужим решением — оно старше нашего, и переписывать его нельзя.
    if (step1.reason !== 'edited') return foreignDecision(deps.db, ownerId, runId, step1.reason);
    const live = await readProposal(deps.db, ownerId, runId);
    return resumeOrAnswer(
      deps,
      args,
      await takeoverEdited(deps, { ...args, pendingId: parentId }, live),
    );
  }
  if (step1.kind === 'moved') {
    // Указатель увели под нами — а увести его может только чужая лестница, то есть
    // исходное погашено правкой. Не погашено — значит прогон просто живёт другим
    // предложением, и решать по прочитанному нечего.
    const live = await readProposal(deps.db, ownerId, runId);
    const reason = await withIdentity(deps.db, ownerId, (tx) => rejectedReason(tx, parentId));
    if (reason !== 'edited') return replacedBy(live, reason ?? 'superseded');
    return resumeOrAnswer(
      deps,
      args,
      await takeoverEdited(deps, { ...args, pendingId: parentId }, live),
    );
  }

  // Шаг 2: указатель переезжает на правленое. Отдельной транзакцией — вложить её в шаг 1
  // нельзя (execute открывает свою), и именно поэтому правило возобновления обязательно.
  const live = await pointAtEdited(deps, { ownerId, runId, from: proposal, childId });
  if (live.pending_id !== childId) return replacedBy(live, 'edited');
  // Шаги 3–4: прежний конвейер — ревалидация, применение, судьба на прогоне
  return approveProposal(deps, ownerId, runId, live);
}

/**
 * Довести применение либо отдать готовый ответ. Вариант `decide` сюда не принимается
 * НАМЕРЕННО: там предложение неправленое, и «довести применение» означало бы применить
 * payload рутины вместо правки владельца — ровно то, от чего защищает весь этот срез.
 */
async function resumeOrAnswer(
  deps: RoutineWriteDeps,
  args: { ownerId: string; runId: string },
  addressed: Extract<AddressedProposal, { kind: 'resume' | 'answer' }>,
): Promise<DecideProposalResult> {
  return addressed.kind === 'answer'
    ? addressed.result
    : approveProposal(deps, args.ownerId, args.runId, addressed.proposal);
}

/**
 * Шаг 1 лестницы ОДНОЙ транзакцией: исходное предложение гаснет причиной `edited`, а
 * правленое ложится рядом. Атомарность здесь закрывает сразу три беды: сироту-предложение
 * без гашения родителя, потерю правки при гашении без замены и гонку двух правок (вторая
 * увидит родителя уже погашенным и второго дитяти не заведёт).
 *
 * Замок берётся ДО первого чтения состояния исходного (см. acquirePendingLock): перечитка
 * указателя и payload'а идёт снапшотом, снятым уже под ним, а `rejectPendingTx` повторный
 * захват того же ключа не удорожает. Внутри — только tx-варианты: `rejectPending(db, …)`
 * отсюда повис бы на собственном замке до statement_timeout.
 */
async function createEditedProposal(
  deps: RoutineWriteDeps,
  args: {
    ownerId: string;
    runId: string;
    proposal: RunProposal;
    edits: ProposalEdits;
    childId: string;
  },
): Promise<EditStep1> {
  const { ownerId, runId, edits, childId } = args;
  const parentId = args.proposal.pending_id;
  return withIdentity(deps.db, ownerId, async (tx) => {
    await acquirePendingLock(tx, parentId);
    const row = await runById(tx, runId);
    if (row === null || row.run.routine_id === undefined || row.run.proposal === undefined) {
      // Прогон уехал в архив (откат) между чтением и правкой — тот же ответ, что у
      // решения по откаченному прогону, а не выдуманный статус
      throw new ExecError('NOT_FOUND', 'прогон рутины не найден', { runId });
    }
    const live = row.run.proposal;
    if (live.pending_id !== parentId) return { kind: 'moved' };
    if (live.status !== 'pending') return { kind: 'decided', status: live.status };

    const stored = await storedProposal(tx, parentId);
    if (stored === null) {
      throw new ExecError('NOT_FOUND', 'предложение не найдено — править нечего', {
        pendingId: parentId,
      });
    }
    // Сборка ДО гашения: отказ правки (VALIDATION) обязан оставить исходное живым —
    // ExecError отсюда откатывает всю транзакцию, а не половину лестницы
    const operations = buildEditedOperations(stored.operations, edits);

    const rejected = await rejectPendingTx(tx, { ownerId, pendingId: parentId, reason: 'edited' });
    if (rejected.alreadyRejected) return { kind: 'raced', reason: rejected.reason };

    // Строки, а не операции, — как и у исходного предложения (см. `countProposalRows`):
    // строка ленты у правленого обязана выглядеть так же, как у того, что оно заменило.
    const n = countProposalRows(operations);
    const summary = `${n} ${editsNoun(n)}`;
    await createPending(tx, {
      // Тред карточки исходного и есть тред рутины: правленое обязано лечь туда же, иначе
      // лента рутины разорвётся, а `ensureEntityThread` здесь был бы вторым источником
      threadId: rejected.threadId,
      actor: { userId: ownerId, kind: 'ai', source: 'routine', runId, editedFrom: parentId },
      tool: 'batch_execute',
      input: { batch_id: childId, operations },
      level: 'explicit-confirmation',
      dedupeKey: editDedupeKey(parentId, edits),
      clock: deps.clock,
      content: `Предложение рутины: ${summary}`,
      summary,
      card: {
        kind: 'proposal_card',
        pendingId: childId,
        runId,
        routineId: row.run.routine_id,
        summary,
        // Проза — прежняя: владелец поправил значения, а не объяснение рутины
        explanation: stored.explanation ?? row.run.report ?? '',
        editedFrom: parentId,
      },
    });
    return { kind: 'created' };
  });
}

/**
 * Шаг 2 лестницы: указатель прогона переезжает на правленое предложение — CAS на ВЕСЬ
 * объект `proposal`, как у всякой записи его судьбы. Отдельная транзакция: `patchAspect`
 * идёт через executor, а тот открывает собственную.
 *
 * Возвращает предложение, которым прогон живёт ПОСЛЕ попытки: своё при выигранном CAS и
 * чужое при проигранном. Проиграть можно только тому, кто уже увёл указатель (чужая
 * лестница либо гашение новым прогоном), и переписывать его результат нечем.
 */
async function pointAtEdited(
  deps: RoutineWriteDeps,
  args: { ownerId: string; runId: string; from: RunProposal; childId: string },
): Promise<RunProposal> {
  const next: RunProposal = {
    pending_id: args.childId,
    status: 'pending',
    edited_from: args.from.pending_id,
  };
  const patched = await patchAspect(deps, {
    ownerId: args.ownerId,
    id: args.runId,
    aspect: 'orbis/agent-run',
    patch: { proposal: next },
    precondition: [{ aspect: 'orbis/agent-run', field: 'proposal', in: [args.from] }],
    // `system`, как у пометки судьбы (см. PatchActor): это бухгалтерия прогона, и «отмени
    // последнее» после «Принять» обязано снять план, а не переезд указателя
    actor: { kind: 'owner', source: 'system', runId: args.runId },
  });
  if (!patched.ok && patched.error.code !== 'CONFLICT') throw toExecError(patched.error);
  // Перечитка в ЛЮБОМ исходе, а не только при проигранном CAS. Предусловие следующего шага
  // сверяется JSON-ФОРМОЙ (executor: JSON.stringify обеих сторон), а jsonb нормализует
  // порядок ключей объекта — собранный руками `next` не совпал бы с самим собой, лёгшим в
  // БД, и решение по правленому упиралось бы в вечный CONFLICT. Отсюда правило: объект
  // `proposal` для CAS всегда берётся ЧТЕНИЕМ, а не сборкой.
  return readProposal(deps.db, args.ownerId, args.runId);
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

/**
 * Какой статус на прогоне соответствует уже записанной причине отказа (V1.8).
 *
 * У `edited` (Ш1.5) статуса на прогоне НЕТ: правка не решает предложение, а заменяет его,
 * и указатель прогона переезжает на правленое. Сюда причина попадает только из окна,
 * которое правило возобновления уже отработало (`foreignDecision` — последний рубеж, а не
 * штатный путь), и «заменено» — самое близкое, что можно сказать честно.
 */
const STATUS_BY_REJECT_REASON: Record<RejectReason, ProposalStatus> = {
  owner: 'rejected',
  superseded: 'superseded',
  stale: 'stale',
  edited: 'superseded',
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
 *  - предусловие не выполнено (V1.7) либо разошёлся CAS тела (STALE_VERSION, см.
 *    bodyMismatch): предложение УСТАРЕЛО — карточка гасится причиной `stale`, разбор
 *    расхождений ложится на прогон, наружу идёт значение, а не исключение;
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
    // Правленое предложение доносит до экрана, ЧТО именно применено: исходную карточку
    // владелец видел своими глазами, и она обязана понять, что применено не ровно она
    const editedFrom = proposal.edited_from;
    const done: DecideProposalResult = {
      status: 'applied',
      actionId: applied.actionId,
      ...(editedFrom !== undefined && { editedFrom }),
    };
    // Возобновление шагов 3–4 (двойной тап по «Принять»): батч исполнен идемпотентно, тем
    // же actionId, а статус уже стоит — переписывать его значило бы плодить действие
    // журнала с новым `decided_at` на каждый повторный тап
    if (proposal.status === 'approved') return done;
    const settled = await settleProposal(deps, { ownerId, runId, proposal, status: 'approved' });
    return settled.written ? done : { status: 'already', proposalStatus: settled.proposalStatus };
  }

  const mismatches = preconditionMismatches(applied.error) ?? bodyMismatch(applied.error);
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
    ? // Адрес устаревшего — у прогона их бывает двое (исходное и правленое), и карточка
      // обязана узнать своё: иначе владелец не поймёт, чья работа потеряна
      { status: 'stale', mismatches, pendingId: proposal.pending_id }
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
        // См. closeOpenOfRun: решение владельца меняет судьбу предложения, но не его
        // происхождение — след правки (Ш1.8) переживает и approve, и rejected, и stale
        ...(args.proposal.edited_from !== undefined && {
          edited_from: args.proposal.edited_from,
        }),
      },
    },
    precondition: [{ aspect: 'orbis/agent-run', field: 'proposal', in: [args.proposal] }],
    // `system`, а не `ui` (см. PatchActor): пометка судьбы — бухгалтерия прогона, и «отмени
    // последнее» после «Принять» обязано снять сам план, а не эту пометку
    actor: { kind: 'owner', source: 'system', runId: args.runId },
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
 * Правка ТЕЛА в предложении разошлась с графом (финальное ревью V1, A-2/B2-1). У тела нет
 * предусловия по значению — его CAS это `expectedUpdatedAt` строки, снятый при составлении
 * (propose.ts buildUpdate), и executor отвечает на расхождение не CONFLICT/precondition_failed,
 * а STALE_VERSION. Для владельца это то же самое «устарело»: сущность менялась после того,
 * как рутина её видела (тело — или что угодно ещё: `updated_at` бампит любая правка).
 * Расхождение выражается той же формой, что у полей: `aspect: ''` (тело — вне аспектов),
 * `field: 'body'`, ожидали/сейчас — отметки `updated_at`. Не про STALE_VERSION — `null`.
 */
function bodyMismatch(error: StructuredError): PreconditionMismatch[] | null {
  if (error.code !== 'STALE_VERSION') return null;
  const details = error.details as { expected?: unknown; current?: unknown } | undefined;
  return [{ aspect: '', field: 'body', expected: [details?.expected], actual: details?.current }];
}

/** Нота расхождения тела в аспекте прогона: отметки `updated_at` владельцу ничего не скажут. */
const BODY_MISMATCH_NOTE = 'тело изменено после составления предложения';

/**
 * Расхождения в форме, которая ложится в аспект прогона (V1.4): человекочитаемая строка
 * вместо сырых значений. Она переживает саму карточку и читается на экране прогона спустя
 * дни — «предусловие orbis/task.status не выполнено» там не сказало бы владельцу ничего.
 */
function mismatchNotes(mismatches: readonly PreconditionMismatch[]): ProposalMismatchNote[] {
  return mismatches.slice(0, MAX_MISMATCH_NOTES).map((m) => ({
    aspect: m.aspect,
    field: m.field,
    note:
      m.aspect === '' && m.field === 'body'
        ? BODY_MISMATCH_NOTE
        : `ожидали ${expectedText(m.expected)}, сейчас ${actualText(m.actual)}`.slice(
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
 * по `pending.id` (индекс `chat_messages_metadata_gin`, форма `jsonb_path_ops`), та же, что
 * у `findPendingMessage`.
 *
 * Именно по id, а не по `run_id`: у одного прогона pending-сообщений бывает несколько
 * (правка владельца гасит исходное и кладёт рядом новое, тот же `run_id`), и `LIMIT 1` по
 * прогону вернул бы произвольное из них — владелец увидел бы операции чужого предложения
 * под адресом своего. Адресом по-прежнему владеет прогон, но добывается он с прогона
 * (`proposal.pending_id`), а не угадывается запросом.
 */
async function storedProposal(tx: Tx, pendingId: string): Promise<StoredProposal | null> {
  const probe = JSON.stringify({ pending: { id: pendingId } });
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

/**
 * Предложение построчно: заголовки резолвятся под identity владельца (RLS), а у строк тела
 * живого предложения рядом считается дифф (`withDiff`, proposal-diff.ts).
 */
async function describeOperations(
  tx: Tx,
  operations: readonly StoredOperation[],
  args: { withDiff: boolean },
): Promise<ProposalOperationView[]> {
  const titles = await titlesOf(tx, referencedIds(operations));
  const bodies = await proposalBodyRows(tx, operations, args);
  const rows: ProposalOperationView[] = [];
  for (const [index, op] of operations.entries()) {
    if (op.tool === 'entity_create') {
      rows.push(createRow(index, op.input));
    } else if (op.tool === 'relation_create' || op.tool === 'relation_delete') {
      rows.push(relationRow(index, op, titles));
    } else if (op.tool === 'entity_update') {
      rows.push(...updateRows(index, op.input, titles, bodies.get(index)));
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
 * встанет» владелец видит, «что было» ему покажет сама запись. У тела «что было» показывает
 * дифф (`body`), и он приезжает готовым — считает его proposal-diff.ts.
 */
function updateRows(
  index: number,
  input: Record<string, unknown>,
  titles: ReadonlyMap<string, string>,
  body: ProposalBodyRow | undefined,
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
    if (field === 'body') {
      // Строка тела рисуется по РЕЗУЛЬТАТУ разбора тела, а не по `input.body`: у правленого
      // предложения тело едет `bodyDoc` (Ш1.11), и проверка на `body` теряла бы строку целиком
      if (body === undefined) continue;
      rows.push({
        index,
        tool: 'entity_update',
        entity,
        field,
        ...(body.after !== undefined && { after: body.after }),
        ...(body.bodyDiff !== undefined && { bodyDiff: body.bodyDiff }),
        ...(body.proposedDoc !== undefined && { proposedDoc: body.proposedDoc }),
        summary: `«${entity.title}»: ${label}`,
      });
      continue;
    }
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
