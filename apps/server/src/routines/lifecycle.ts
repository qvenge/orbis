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
  BODY_NOTE_PROPERTY,
  entityThreadId,
  isManualBucket,
  manualBucket,
  newId,
  type PreconditionMismatch,
  type ProposalDivergence,
  type ProposalStatus,
  pendingMessageId,
  ROLE_RUN,
  routineRunBatchId,
  routineRunId,
} from '@orbis/shared';
import type { BodyDoc } from '@orbis/shared/doc';
import { sql } from 'drizzle-orm';
import {
  type RunProps,
  type RunRow,
  runById,
  runSummary,
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
import { ROUTINE_STAGE_PROPERTY } from '../policy/confirmation';
import {
  type AnswerQuestionResult,
  acquirePendingLock,
  answerPendingQuestion,
  approvePending,
  createPending,
  listRunUnits,
  type RejectReason,
  type RunUnit,
  rejectedReason,
  rejectPending,
  rejectPendingTx,
  stalePendingQuestion,
} from '../policy/pending';
import { wallClockIn } from '../recurring/materialize';
import { loadRegistry, type RegistrySnapshot } from '../registry/load';
import {
  CONSECUTIVE_FAILURES_TO_PAUSE,
  CORE_FIELD_LABELS,
  editsNoun,
  MAX_ATTEMPTS,
  MAX_RUN_UNITS,
  RETRY_DELAYS_MS,
  ROUTINE_HISTORY_TAIL,
} from './constants';
import type { RoutineHistoryItem, RoutineHistoryUnit } from './context';
import {
  buildEditedOperations,
  countProposalRows,
  editsHash,
  isEmptyEdits,
  type ProposalEdits,
} from './edits';
import { processRoutineLocks, type RoutineLocks } from './locks';
import { type ProposalBodyDiff, type ProposalBodyRow, proposalBodyRows } from './proposal-diff';
import { namedAspects } from './propose';

/**
 * «Станет» у строки СНЯТИЯ свойства. Литерал, а не отсутствие ключа: `after` — обязательное
 * поле строки предложения, и пустое значение владелец прочитал бы как «строку не дорисовали».
 */
const UNSET_ROW_VALUE = '—';

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
 * Патч свойств прогона/рутины одним execute (§А1-1).
 *
 * Ключи патча — id СВОЙСТВ, и тип у них открытый (`Record<string, unknown>`), а не союз
 * двух аспектов, как было до реформы. Это не послабление типизации, а прямое следствие
 * §А2-1: словарь свойств расширяется владельцем операциями реестра, и закрытый союз в коде
 * закрыл бы собственное свойство рутины ещё до того, как оно появится. Что значение годится
 * свойству, а механизм вправе его писать, решает исполнитель по реестру (стадии 2 и §А2-5),
 * а не эта сигнатура.
 *
 * Ошибка возвращается, а не логируется здесь: `CONFLICT` по предусловию для всех
 * вызывающих — не сбой, а «состояние изменилось, и правило говорит не трогать» (владелец
 * ответил на вопрос; рутину уже поставил на паузу конкурент; предложение решил второй
 * экран). Логировать это как ошибку значило бы засыпать лог штатными исходами.
 */
async function patchRun(
  deps: RoutineWriteDeps,
  args: {
    ownerId: string;
    id: string;
    props: Record<string, unknown>;
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
      // Механизм — глагол исполнителя (§А4-4) у ВСЕХ вызывающих этой воронки: и у фоновой
      // бухгалтерии, и у ответа владельца на чекпойнт. Канал у них разный (`system`/`ui`),
      // а пишут они одно и то же — служебные свойства прогона (`system_writable`, §А2-5).
      mechanism: 'verb',
      ...(actor.runId !== undefined && { runId: actor.runId }),
      operations: [
        {
          tool: 'entity_update',
          input: {
            id: args.id,
            ...(args.precondition !== undefined && { precondition: args.precondition }),
            props: args.props,
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
      props: row.props,
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
    /** Свойства прогона (§А1-1) — те же, что отдаёт `runsOfParent`/`runFacts`. */
    props: RunProps;
    reason: Extract<RejectReason, 'superseded' | 'stale'>;
    /** Текст системной записи в тред рутины при снятии вопроса — он же текст судьбы вопросов пачки. */
    questionNote: string;
  },
): Promise<{ proposal: boolean; question: boolean; units: number }> {
  const { ownerId, routineId, runId, props, reason } = args;
  const out = { proposal: false, question: false, units: 0 };
  const now = deps.clock().toISOString();
  const proposal = props['orbis/run_proposal'];

  if (proposal?.status === 'pending') {
    const closed = await closeProposalOfRun(deps, { ownerId, proposal, reason });
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
      const patched = await patchRun(deps, {
        ownerId,
        id: runId,
        props: {
          'orbis/run_proposal': {
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
        precondition: [{ property: 'orbis/run_proposal', in: [proposal] }],
      });
      if (patched.ok) out.proposal = true;
      else if (patched.error.code !== 'CONFLICT') {
        console.error(`[routines] статус «${reason}» не записан на ${runId}:`, patched.error.code);
      }
    }
  }

  if (props['orbis/run_outcome'] === 'checkpoint') {
    const patched = await patchRun(deps, {
      ownerId,
      id: runId,
      props: { 'orbis/run_outcome': 'stale' },
      // Под замком исход мог уже стать `answered` (владелец ответил секунду назад) —
      // тогда снимать вопрос нельзя: ответ важнее нового прогона
      precondition: [{ property: 'orbis/run_outcome', in: ['checkpoint'] }],
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
  if ((units.closed > 0 || props['orbis/undecided'] === true) && units.complete) {
    // Снятие — ЗАПИСЬ `false`, а не удаление ключа: предиката «поля нет» у грамматики §6
    // не существует, и запросом «разобранную пачку» иначе не отличить от неразобранной.
    // Актор системный (§9.6, инвариант 5): пиши мы его от владельца, «отмени последнее»
    // после «Принять» сняло бы флажок вместо действия (undoLast пропускает `system`).
    const patched = await patchRun(deps, {
      ownerId,
      id: runId,
      props: { 'orbis/undecided': false },
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
    // а условие предсказуемости — два обхода идут по единицам одинаково. Про дедлок это НЕ:
    // замок у каждой единицы свой и живёт одну короткую транзакцию (`decideAllOfRun`, ниже)
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
  const planned = runs.filter((r) => {
    const bucket = r.props['orbis/run_bucket'];
    return bucket !== undefined && !isManualBucket(bucket);
  });
  // Граница — позиция учтённого провала в порядке создания (runsOfParent: created_at ASC);
  // если его среди плановых нет (запись без run_id либо про чужой id) — считаем все
  const cutIndex = cut === undefined ? -1 : planned.findIndex((r) => r.id === cut);
  const fresh = planned.slice(cutIndex + 1);
  const tail = fresh.slice(-CONSECUTIVE_FAILURES_TO_PAUSE);
  if (tail.length < CONSECUTIVE_FAILURES_TO_PAUSE) return { paused: false };
  if (!tail.every((r) => r.props['orbis/run_outcome'] === 'failed')) return { paused: false };
  const lastCounted = tail[tail.length - 1];
  if (lastCounted === undefined) return { paused: false }; // недостижимо: длина проверена

  // Предусловие `stage: active` — не оптимизация, а сериализация: два прогона, упавших
  // почти одновременно, иначе оба записали бы паузу и оба положили бы запись в тред.
  // Проигравший получает CONFLICT и честно отвечает `paused: false` — паузу поставил не он.
  const paused = await patchRun(deps, {
    ownerId: args.ownerId,
    id: args.routineId,
    props: { [ROUTINE_STAGE_PROPERTY]: 'paused' },
    precondition: [{ property: ROUTINE_STAGE_PROPERTY, in: ['active'] }],
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
  const ofBucket = all.filter((r) => r.props['orbis/run_bucket'] === bucket);

  if (all.some((r) => r.props['orbis/run_outcome'] === 'running')) return skip('running');
  // Идущих больше нет, значит любой не-failed исход слота — терминальный: слот отработан
  if (ofBucket.some((r) => r.props['orbis/run_outcome'] !== 'failed')) return skip('done');
  const failed = ofBucket.filter((r) => r.props['orbis/run_outcome'] === 'failed');
  if (failed.length >= MAX_ATTEMPTS) return skip('attempts');
  if (failed.length > 0) {
    const delay =
      RETRY_DELAYS_MS[failed.length - 1] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1] ?? 0;
    const lastFailedAt = Math.max(
      ...failed.map((r) =>
        Date.parse(r.props['orbis/run_finished_at'] ?? r.props['orbis/run_started_at']),
      ),
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
  if (all.some((r) => r.props['orbis/run_outcome'] === 'running')) return skip('running');
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
  const planned = runs.filter((r) => {
    const bucket = r.props['orbis/run_bucket'];
    return bucket !== undefined && !isManualBucket(bucket) && bucket.startsWith(localDate);
  });
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
      // Механизм — глагол исполнителя (§А4-4): прогон целиком собран из служебных свойств
      mechanism: 'verb',
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
          input: { source_id: args.routine.id, target_id: runId, role: ROLE_RUN },
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
 * Текст единицы для истории — ровно то, что видел владелец: у вопроса сам вопрос, у
 * действия сводка его карточки («Архивация: «Прошлогодний отчёт»»), а не `tool` с `input`.
 * Модель обязана прочитать в истории то, ПО ЧЕМУ принималось решение, иначе «отклонено»
 * повиснет над строкой `entity_update`, из которой не видно ни записи, ни намерения.
 *
 * Запасные ветки недостижимы и стоят не для вида: `question` у вопроса и `tool` у действия
 * обязательны по схеме записи (`pendingRecord.superRefine`), карточку единице всегда кладёт
 * её постановщик (`deferRoutineUnit`, `routines/ask.ts`). Отказ вместо запасного текста
 * уронил бы сборку контекста целиком — прогон остался бы без ВСЕЙ истории из-за одной
 * подписи, а это дороже, чем строка с id вместо имени.
 */
function unitHistoryText(unit: RunUnit): string {
  if (unit.kind === 'question') return unit.question ?? unit.pendingId;
  if (unit.card !== undefined && 'summary' in unit.card) return unit.card.summary;
  return unit.tool ?? unit.pendingId;
}

/** Единица пачки в объёме истории: id, payload и карточка модели не нужны. */
function historyUnit(unit: RunUnit): RoutineHistoryUnit {
  return {
    kind: unit.kind,
    text: unitHistoryText(unit),
    fate: unit.fate,
    // Причина едет с судьбой, а не сворачивается в подпись здесь: печать — дело контекста,
    // и подпись отклонённого действия выводится из ПАРЫ (fate, reason)
    ...(unit.reason !== undefined && { reason: unit.reason }),
    ...(unit.answer !== undefined && { answer: unit.answer }),
  };
}

/**
 * Хвост истории рутины для контекста модели (Р-18): последние `tail` прогонов, кроме
 * текущего, от старых к новым.
 *
 * Хвост, а не вся история (в отличие от `claim_task`, где она без лимита): у ежедневной
 * рутины прогоны копятся линейно, и через месяц история вытеснила бы из контекста саму
 * инструкцию. Проекции (`proposalStatus`, `reply`, `explanation`) заполняются здесь —
 * см. докблок RoutineHistoryItem.
 *
 * ЕДИНИЦЫ ПАЧКИ (D42 ОЧ.7) — здесь же, и это ЕДИНСТВЕННАЯ дорога ответов владельца в
 * следующий прогон: контекст рутины ленту треда не читает вовсе («ВМЕСТО ЛЕНТЫ ТРЕДА —
 * ИСТОРИЯ ПРОГОНОВ», `context.ts`), и без этого слоя владелец отвечал бы в пустоту —
 * рутина спрашивала бы одно и то же каждое утро (блокер Б1 ревью спеки).
 *
 * `ownerId` ОТДЕЛЬНЫМ параметром, а не из tx: это КОНТРАКТ `listRunUnits` — tx обязан быть
 * открыт `withIdentity` для ТОГО ЖЕ владельца, иначе судьбы молча не найдутся и вся пачка
 * прочитается как открытая (модель увидела бы «без ответа» там, где владелец ответил).
 *
 * ЦЕНА, честно: проба единиц — containment по `metadata`, и под RLS её план — **Seq Scan**,
 * а не обход `chat_messages_metadata_gin` (`jsonb_contains` не leakproof; замер и разбор —
 * докблок `liveProposalRuns` ниже: 26.3 мс на одну пробу по `id` на стенде в 39 013
 * сообщений). Проб столько, сколько прогонов в хвосте, — семь, то есть ≈130–180 мс на
 * сборку контекста. Цена ПРИНЯТА: контекст собирается один раз за прогон при дедлайне в
 * десять минут. Дешевле её делает не переписывание этого места, а скалярная колонка вместо
 * пробы по jsonb — общее лекарство для ВСЕХ containment-проб под RLS.
 *
 * Пробы последовательны, а не `Promise.all`: у нас один tx, и параллельных запросов в нём
 * не бывает по построению.
 */
export async function routineHistory(
  tx: Tx,
  ownerId: string,
  routineId: string,
  exceptRunId: string,
  tail: number = ROUTINE_HISTORY_TAIL,
): Promise<RoutineHistoryItem[]> {
  const runs = await runsOfParent(tx, routineId);
  const items: RoutineHistoryItem[] = [];
  for (const row of runs.filter((r) => r.id !== exceptRunId).slice(-tail)) {
    const summary = runSummary(row);
    // Предложение прогона в пачку НЕ попадает (Б5 ревью): проба идёт по явному `kind`,
    // а у предложения его нет — иначе один и тот же текст модель прочитала бы дважды,
    // как проекцию `explanation` и как единицу
    const units = await listRunUnits(tx, ownerId, row.id);
    // Потолок истории считает ВСЕ единицы, а кап пачки (MAX_RUN_UNITS) — только открытые:
    // решённая освобождает место под капом, поэтому за длинный прогон их накапливается и
    // больше десяти, и хвост «и ещё N» — не мёртвая ветка. Усекается именно хвост: ранние
    // единицы прогона модель читает первыми, как и весь остальной порядок истории
    const shown = units.slice(0, MAX_RUN_UNITS);
    items.push({
      run: summary,
      ...(summary.proposal !== undefined && { proposalStatus: summary.proposal.status }),
      ...(summary.reply !== undefined && { reply: summary.reply.text }),
      // Проза предложения живёт в `report` прогона (её кладёт orbis_propose): отчёт
      // прогона БЕЗ предложения — это отчёт режима act, и объяснением он не является
      ...(summary.proposal !== undefined &&
        summary.report !== undefined && { explanation: summary.report }),
      // Ключа НЕТ у прогона без единиц (не пустой массив): прогоны до D42 обязаны давать
      // прежнюю строку истории байт-в-байт
      ...(shown.length > 0 && { units: shown.map(historyUnit) }),
      ...(units.length > shown.length && { unitsOmitted: units.length - shown.length }),
    });
  }
  return items;
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
  if (row === null || row.props['orbis/run_routine'] === undefined) {
    throw new ExecError('NOT_FOUND', 'прогон рутины не найден', { runId: args.runId });
  }
  const outcome = row.props['orbis/run_outcome'];
  if (outcome !== 'checkpoint') {
    throw new ExecError('CONFLICT', `прогон не ждёт ответа (${outcome})`, {
      runId: args.runId,
      outcome,
    });
  }

  const patched = await patchRun(deps, {
    ownerId: args.ownerId,
    id: args.runId,
    props: {
      'orbis/run_reply': { text: args.answer, at: deps.clock().toISOString() },
      'orbis/run_outcome': 'answered',
    },
    precondition: [{ property: 'orbis/run_outcome', in: ['checkpoint'] }],
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
  /**
   * ПУСТУЕТ с Задачи 12 и остаётся в форме ради экрана, который её ещё читает (web,
   * Задача 13c): строка предложения адресуется СВОЙСТВОМ (§А1-1), а не парой «аспект +
   * поле», и сервер этого ключа больше не пишет. Снять его отсюда — правка контракта
   * вместе с web, а не в одиночку.
   */
  aspect?: string;
  /** Адрес строки: id свойства (`orbis/amount`) либо core-поле (`title`, `tags`, `body`). */
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

/**
 * Расхождение предусловия в человекочитаемой форме — как оно лежит в аспекте прогона.
 *
 * Тип ВЫВЕДЕН из схемы, а не написан рядом: схема допускает две формы (новую по свойству и
 * старую по паре «аспект + поле», см. `agentRunAspectSchema`), и вторая копия формы здесь
 * разъехалась бы с ней молча — ровно там, где значение читается кастом, а не разбором.
 */
export type ProposalMismatchNote = NonNullable<RunProposal['mismatches']>[number];

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
      /** Расхождения по СВОЙСТВАМ (§А7-3). Тела здесь нет — оно рядом флагом (РП-10). */
      mismatches: PreconditionMismatch[];
      /** Тело записи изменилось после составления предложения. */
      bodyChanged: boolean;
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
    const routineId = row.props['orbis/run_routine'];
    const proposal = row.props['orbis/run_proposal'];
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
      explanation: stored.explanation ?? row.props['orbis/run_report'] ?? '',
      ...(proposal.decided_at !== undefined && { decidedAt: proposal.decided_at }),
      ...(proposal.mismatches !== undefined && { mismatches: proposal.mismatches }),
      ...(proposal.edited_from !== undefined && { editedFrom: proposal.edited_from }),
      runArchived: row.archived,
      // Дифф тела — только у живого предложения (Ш1.1): статус берётся с прогона, он же
      // источник правды о судьбе
      operations: await describeOperations(tx, args.ownerId, stored.operations, {
        withDiff: proposal.status === 'pending',
      }),
    };
  });
}

/**
 * Прогон по id С архивными — только для чтения предложения (см. proposalView).
 *
 * Признак носителя `'orbis/agent-run' = ANY(aspects)` тот же, что у `runById`: без него
 * id любой сущности владельца прошёл бы за прогон, а свойства прогона переживают снятие
 * аспекта (Р9), и на такой строке карточка предложения нарисовалась бы из старых значений.
 */
async function runRowAnyArchive(
  tx: Tx,
  runId: string,
): Promise<{ props: RunProps; archived: boolean } | null> {
  const rows = await tx.execute(
    sql`SELECT archived, props
        FROM entities
        WHERE id = ${runId}::uuid AND 'orbis/agent-run' = ANY(aspects)`,
  );
  const row = (rows as unknown as Array<Record<string, unknown>>)[0];
  if (row === undefined) return null;
  return { props: row.props as RunProps, archived: row.archived === true };
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
 * (`storedProposal`, `findPendingMessage`, `aspects_legacy @>` в entity_query), а не этой; лечится
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
    const proposal = found.props['orbis/run_proposal'];
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
    if (
      row === null ||
      row.props['orbis/run_routine'] === undefined ||
      row.props['orbis/run_proposal'] === undefined
    ) {
      // Прогон уехал в архив (откат) между чтением и правкой — тот же ответ, что у
      // решения по откаченному прогону, а не выдуманный статус
      throw new ExecError('NOT_FOUND', 'прогон рутины не найден', { runId });
    }
    const live = row.props['orbis/run_proposal'];
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
        routineId: row.props['orbis/run_routine'],
        summary,
        // Проза — прежняя: владелец поправил значения, а не объяснение рутины
        explanation: stored.explanation ?? row.props['orbis/run_report'] ?? '',
        editedFrom: parentId,
      },
    });
    return { kind: 'created' };
  });
}

/**
 * Шаг 2 лестницы: указатель прогона переезжает на правленое предложение — CAS на ВЕСЬ
 * объект `proposal`, как у всякой записи его судьбы. Отдельная транзакция: `patchRun`
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
  const patched = await patchRun(deps, {
    ownerId: args.ownerId,
    id: args.runId,
    props: { 'orbis/run_proposal': next },
    precondition: [{ property: 'orbis/run_proposal', in: [args.from] }],
    // `system`, как у пометки судьбы (см. PatchActor): это бухгалтерия прогона, и «отмени
    // последнее» после «Принять» обязано снять план, а не переезд указателя
    actor: { kind: 'owner', source: 'system', runId: args.runId },
  });
  if (!patched.ok && patched.error.code !== 'CONFLICT') throw toExecError(patched.error);
  // Перечитка в ЛЮБОМ исходе, а не только при проигранном CAS. Порядок ключей объекта после
  // jsonb уже не важен — сравнение по типу свойства канонизирует json (§А7-3,
  // `comparePropertyValue`), — но `next` собран из ЧАСТИ полей, а прочитанное предложение
  // несёт ещё и то, что дописал сервер (`decided_at`, `mismatches`). Отсюда правило
  // остаётся прежним: объект `proposal` для CAS всегда берётся ЧТЕНИЕМ, а не сборкой.
  return readProposal(deps.db, args.ownerId, args.runId);
}

/**
 * Прогон с предложением под RLS. NOT_FOUND (а не «нет предложения») на тикетном прогоне:
 * решать предложения там нечего, и различать «чужой прогон» от «прогон без предложения»
 * владельцу незачем — обе кнопки просто не существуют.
 */
async function readProposal(db: Db, ownerId: string, runId: string): Promise<RunProposal> {
  const row = await withIdentity(db, ownerId, (tx) => runById(tx, runId));
  if (row === null || row.props['orbis/run_routine'] === undefined) {
    throw new ExecError('NOT_FOUND', 'прогон рутины не найден', { runId });
  }
  const proposal = row.props['orbis/run_proposal'];
  if (proposal === undefined) {
    throw new ExecError('NOT_FOUND', 'у прогона нет предложения', { runId });
  }
  return proposal;
}

/** Статус предложения прогона СЕЙЧАС — перечитывается после проигранной гонки. */
async function currentStatus(
  db: Db,
  ownerId: string,
  runId: string,
): Promise<ProposalStatus | undefined> {
  const row = await withIdentity(db, ownerId, (tx) => runById(tx, runId));
  return row?.props['orbis/run_proposal']?.status;
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

  const divergence = divergenceOf(applied.error);
  if (divergence === null) {
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
    mismatches: mismatchNotes(divergence),
  });
  return settled.written
    ? // Адрес устаревшего — у прогона их бывает двое (исходное и правленое), и карточка
      // обязана узнать своё: иначе владелец не поймёт, чья работа потеряна
      { status: 'stale', ...divergence, pendingId: proposal.pending_id }
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
  const patched = await patchRun(deps, {
    ownerId: args.ownerId,
    id: args.runId,
    props: {
      'orbis/run_proposal': {
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
    precondition: [{ property: 'orbis/run_proposal', in: [args.proposal] }],
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

// ---------------------------------------------------------------------------
// Пачка решений (D42 §6): владелец решает единицы прогона ПОШТУЧНО.
//
// Соседство с предложением не случайно и не «по теме»: у решений по единице и по
// предложению ОДНИ И ТЕ ЖЕ рёбра — тот же `approvePending` (он же ревалидация полным
// конвейером), тот же разбор CONFLICT в расхождения, тот же append-only отказ. Разница
// ровно в двух местах, и обе — предмет этого раздела: у единицы нет статуса на прогоне
// (её судьбу целиком держит лента) и нет лестницы правки — зато есть ОБЩИЙ на всю пачку
// флажок `undecided`, который снимает бухгалтерия после последнего решения.
// ---------------------------------------------------------------------------

/**
 * Исход решения по единице пачки (§6). Форма родственна `DecideProposalResult` намеренно
 * — экран решает единицу теми же двумя кнопками, — но `replaced` у неё нет: заменять
 * единицу нечем (лестница правки живёт у предложения, §10.3), а `already` несёт СУДЬБУ
 * единицы, а не статус предложения: у единицы статуса на прогоне не существует.
 *
 * `stale` — ЗНАЧЕНИЕ, а не исключение (рулинг Р-2, как у предложения): «состояние
 * изменилось, вот что именно» — это ответ экрану, который он рисует списком расхождений.
 */
export type DecideDeferredResult =
  | { status: 'applied'; actionId: string }
  /** Предусловия единицы (ОЧ.13) разошлись с графом; карточка при этом уже погашена. */
  | { status: 'stale'; mismatches: PreconditionMismatch[]; bodyChanged: boolean }
  | { status: 'rejected' }
  /** Судьба у единицы уже есть — своя (повтор кнопки) или чужая (гашение, второй экран). */
  | { status: 'already'; fate: RunUnit['fate'] };

/**
 * Тексты судеб, которые пишет РУКА ВЛАДЕЛЬЦА (С6 ревью спеки). Свои, а не `REJECT_CONTENT`
 * из `policy/pending.ts` и не `UNIT_REJECT_CONTENT` гашения: тамошние строки писаны про
 * предложение и про откат, и владелец, увидев «Предложение отклонено» на отложенной
 * АРХИВАЦИИ, прочитал бы неправду. Причина при этом остаётся тем же enum'ом — текст
 * только представление, и второго источника правды о судьбе он не заводит.
 */
const UNIT_REJECTED_BY_OWNER = 'Отложенное действие отклонено владельцем';
const UNIT_STALE_BY_STATE = 'Отложенное действие устарело: состояние изменилось';

/**
 * Решение владельца по ОДНОЙ единице пачки (§6, приёмки 3, 4, 10).
 *
 * Адрес — `pendingId`, и прогон через `runById` НЕ читается (Р-17): тот стоит на
 * `NOT archived`, а прогон уезжает в архив от отката — решения по единицам такого прогона
 * упирались бы в NOT_FOUND, хотя решать их владельцу никто не запрещал.
 *
 * «Принять» — `approvePending`: сохранённый payload исполняется полным конвейером (он же
 * ревалидация §7.10) с атрибуцией самой записи — `source:'routine'` + `run_id` (§9.5).
 * Атрибуция здесь не деталь: по ней действие находят журнал §7.8, «отмени последнее» и
 * откат прогона (rollback.ts), и без неё принятая единица была бы работой ниоткуда.
 * Идемпотентность — существующий replay по `batchId = pendingId`: двойной клик даёт тот же
 * `actionId` и ОДНУ запись в журнале (приёмка 10).
 *
 * «Отклонить» — `rejectPending` с причиной `owner` и СВОИМ текстом единицы; повтор
 * возвращает исходную причину (append-only, §4.6) и маппится в `already`.
 */
export async function decideDeferredUnit(
  deps: RoutineWriteDeps,
  args: { ownerId: string; pendingId: string; decision: 'approve' | 'reject' },
): Promise<DecideDeferredResult> {
  const { ownerId, pendingId } = args;
  const unit = await withIdentity(deps.db, ownerId, (tx) => unitRecord(tx, pendingId));
  // Чужая и несуществующая под RLS неразличимы — единый NOT_FOUND, как у approve/reject
  if (unit === null) {
    throw new ExecError('NOT_FOUND', `единица пачки ${pendingId} не найдена`, { pendingId });
  }
  // Fail-closed по РОДУ носителя (Б5, приёмка 19): pending без `kind` — это чатовое
  // подтверждение или ПРЕДЛОЖЕНИЕ рутины, а у предложения есть свой путь со статусом на
  // прогоне (`decideProposal`). Применив его отсюда, мы исполнили бы план, о судьбе
  // которого прогон продолжал бы говорить «ждёт решения».
  if (unit.kind === undefined || unit.runId === undefined) {
    throw new ExecError('VALIDATION', 'это не единица пачки — решать её здесь нечем', {
      pendingId,
    });
  }
  const runId = unit.runId;

  // Вопрос сюда доезжает до самой policy НАРОЧНО: гейт рода (`assertNotQuestion`) —
  // единственный источник этого отказа (С7), и второй его текст здесь разъехался бы с
  // тем, что видит чатовый путь `ai.approve`. Цена — один лишний запрос на заведомом
  // отказе; за неё берётся то, что ветка `already` ниже вопросам не достаётся: судьба
  // `answered` не превратит «на вопрос отвечают» в «уже решено».
  const decided =
    args.decision === 'approve'
      ? await approveUnit(deps, { ownerId, pendingId, runId, isAction: unit.kind === 'action' })
      : await rejectUnit(deps, { ownerId, pendingId, runId, isAction: unit.kind === 'action' });

  // Бухгалтерия — после ЛЮБОГО состоявшегося решения, включая `already` (§5, лестница
  // сбоев): «Принять» исполнилось, а снятие флажка упало — чинится следующим решением или
  // гашением, и повторное нажатие кнопки как раз и есть этот следующий раз.
  await settleUndecided(deps, ownerId, runId);
  return decided;
}

/**
 * Строка сводки «Принять все»: судьба единицы плюс её адрес. Адрес обязателен — сводка
 * приезжает СПИСКОМ, и без `pendingId` экран не знал бы, какой карточке принадлежит
 * «устарело» и какие расхождения под ней рисовать.
 */
export type DecideAllItem = { pendingId: string } & DecideDeferredResult;

/**
 * «Принять все» (ОЧ.11, приёмка 6): владелец разбирает пачку одним нажатием.
 *
 * ПОСЛЕДОВАТЕЛЬНО, НЕ АТОМАРНО. Атомарна единица (один pending = один batch executor'а,
 * инвариант 2), между единицами атомарности нет и она не обещается — тот же уровень
 * обещания, что у отката прогона (`rollback.ts`). Отсюда и форма ответа: не «получилось /
 * не получилось», а сводка по каждой единице. Одна протухшая соседей не блокирует.
 *
 * ТОЛЬКО ОТКРЫТЫЕ ДЕЙСТВИЯ. Вопросы кнопка не трогает: «принять» вопрос нельзя вовсе — у
 * него другая судьба (`answered`) и другой путь (`answerRunQuestion`). Уже решённые
 * действия не трогает тоже, и это не оптимизация: «Принять все» поверх отклонённой
 * владельцем единицы означало бы, что кнопка отменяет его собственный отказ.
 *
 * ПОРЯДОК ОБХОДА — порядок пачки (`created_at, id`), и он достаётся даром: это контракт
 * `listRunUnits`, своей сортировки здесь нет. Он же и есть Решение 7 плана — два
 * одновременных нажатия берут замки единиц в ОДНОМ порядке. Честности ради: цикла из
 * advisory-замков сегодня всё равно не построить (каждая единица берёт свой замок в
 * собственной короткой транзакции executor'а и отпускает его на коммите, `acquirePendingLock`),
 * так что сегодня общий порядок — про предсказуемость сводки и совпадение её со списком
 * карточек на экране, а не про страховку от дедлока: тот сегодня и так недостижим.
 *
 * Применение и бухгалтерия флажка НЕ дублируются: каждая единица идёт через
 * `decideDeferredUnit`, включая снятие `undecided` после последней. Повтор нажатия
 * безопасен по построению — «Принять» идемпотентно по `batchId = pendingId` (приёмка 10),
 * поэтому проигранная гонка двух кнопок даёт replay, а не второе применение.
 *
 * Пустая сводка — обычный ответ: у прогона может не быть единиц вовсе, а разобранная
 * пачка отвечает тем же пустым списком. Отказа здесь нет и на несуществующем прогоне —
 * `listRunUnits` вернёт пусто, как и `runUnits` на его экране.
 *
 * Отказ ОДНОЙ единицы, который не выражается судьбой (повреждённая запись, отказ БД),
 * прерывает обход исключением, а не тонет в сводке: четыре её исхода описывают обычную
 * жизнь пачки, и подшить туда пятый «что-то сломалось» значило бы отчитаться «разобрано»
 * там, где единица осталась открытой. Уже применённые к этому моменту единицы остаются
 * применёнными — атомарности между ними и не обещалось.
 */
export async function decideAllDeferred(
  deps: RoutineWriteDeps,
  args: { ownerId: string; runId: string },
): Promise<DecideAllItem[]> {
  const { ownerId, runId } = args;
  const units = await withIdentity(deps.db, ownerId, (tx) => listRunUnits(tx, ownerId, runId));
  const summary: DecideAllItem[] = [];
  for (const unit of units) {
    if (unit.kind !== 'action' || unit.fate !== 'open') continue;
    const decided = await decideDeferredUnit(deps, {
      ownerId,
      pendingId: unit.pendingId,
      decision: 'approve',
    });
    summary.push({ pendingId: unit.pendingId, ...decided });
  }
  return summary;
}

/** «Принять» единицу: исполнение сохранённого payload'а и разбор трёх исходов конвейера. */
async function approveUnit(
  deps: RoutineWriteDeps,
  args: { ownerId: string; pendingId: string; runId: string; isAction: boolean },
): Promise<DecideDeferredResult> {
  const { ownerId, pendingId } = args;
  const applied = await approvePending(deps.db, { ownerId, pendingId, clock: deps.clock });
  if (applied.ok) return { status: 'applied', actionId: applied.actionId };

  const divergence = divergenceOf(applied.error);
  if (divergence === null) {
    // Не «устарело». Часть таких отказов означает не сбой, а ЧУЖОЙ ХОД: единицу успели
    // отклонить (гашение новым прогоном, второй экран) между чтением и approve. Отличаем
    // по факту, а не по тексту: если у единицы с тех пор есть судьба, это `already`.
    const fate = await unitFate(deps, args);
    if (fate !== undefined && fate !== 'open') return { status: 'already', fate };
    throw toExecError(applied.error);
  }

  // Устарело НАВСЕГДА: предусловия единицы снимаются при постановке и не переснимаются
  // (§9.4, ОЧ.13), так что применимой она уже не станет. Поэтому карточка гасится, как у
  // предложения, — оставить её открытой значило бы обещать владельцу кнопку, которая не
  // сработает ни сегодня, ни завтра, и держать этим весь флажок пачки.
  const rejected = await rejectPending(deps.db, {
    ownerId,
    pendingId,
    reason: 'stale',
    text: UNIT_STALE_BY_STATE,
  });
  if (!rejected.ok) {
    // Гашение не удалось — применимее единица от этого не стала: расхождения владелец
    // получит, а неудачу логируем (следующее решение или гашение допишут судьбу)
    console.error(`[routines] устаревшая единица ${pendingId} не погашена:`, rejected.error.code);
  } else if (rejected.alreadyRejected && rejected.reason !== 'stale') {
    // Пока мы ревалидировали, единицу снял кто-то другой — его решение старше нашего
    return { status: 'already', fate: 'rejected' };
  }
  return { status: 'stale', ...divergence };
}

/** «Отклонить» единицу: append-отказ своим текстом, граф не тронут. */
async function rejectUnit(
  deps: RoutineWriteDeps,
  args: { ownerId: string; pendingId: string; runId: string; isAction: boolean },
): Promise<DecideDeferredResult> {
  const { ownerId, pendingId } = args;
  const rejected = await rejectPending(deps.db, {
    ownerId,
    pendingId,
    reason: 'owner',
    text: UNIT_REJECTED_BY_OWNER,
  });
  if (!rejected.ok) {
    // «Уже исполнено» приезжает сюда отказом (VALIDATION) — для владельца, нажавшего
    // «Отклонить» на применённой единице, это не сбой, а «поздно»
    const fate = await unitFate(deps, args);
    if (fate !== undefined && fate !== 'open') return { status: 'already', fate };
    throw toExecError(rejected.error);
  }
  // Повтор своей же кнопки и чужая причина отвечают одинаково: судьба уже записана, и
  // переписывать её нечем (журнал append-only). ЧЬЯ она — читается пачкой (`reason`).
  return rejected.alreadyRejected
    ? { status: 'already', fate: 'rejected' }
    : { status: 'rejected' };
}

/**
 * Ответ владельца на вопрос пачки (§6, приёмка 5).
 *
 * Тело — `answerPendingQuestion` (замок, перечитка обеих судеб, append-only запись, ОЧ.8);
 * здесь к нему добавлены две вещи, которых политике знать неоткуда: сверка `option` с
 * фактическими вариантами единицы и та же бухгалтерия флажка, что у решения по действию.
 */
export async function answerRunQuestion(
  deps: RoutineWriteDeps,
  args: { ownerId: string; pendingId: string; answer: string; option?: number },
): Promise<AnswerQuestionResult> {
  const { ownerId, pendingId } = args;
  const unit = await withIdentity(deps.db, ownerId, (tx) => unitRecord(tx, pendingId));
  // `null` и «не вопрос» не отвергаются здесь: NOT_FOUND и гейт рода — дело
  // `answerPendingQuestion`, и второй их текст разъехался бы с первым
  if (unit !== null && unit.kind === 'question' && args.option !== undefined) {
    assertOption(pendingId, args.option, unit.options);
  }
  const answered = await answerPendingQuestion(deps.db, {
    ownerId,
    pendingId,
    answer: args.answer,
    ...(args.option !== undefined && { option: args.option }),
  });
  if (unit?.runId !== undefined) await settleUndecided(deps, ownerId, unit.runId);
  return answered;
}

/**
 * Сверка индекса варианта с САМОЙ ЕДИНИЦЕЙ (рулинг Р3-3). Границу держит этот слой, а не
 * `answerPendingQuestion`: там на руках только вход клиента, а здесь ещё и запись — то
 * есть фактические варианты, которые владелец видел кнопками.
 *
 * Почему это не косметика: `option` уезжает в append-only metadata НАВСЕГДА (§4.6), и
 * `option:42` у вопроса с двумя кнопками не исправить уже ничем — ни правкой, ни повтором
 * ответа. Схема входа роутера ловит только диапазон 0..3 (потолок числа вариантов вообще),
 * а «столько ли их у ЭТОГО вопроса» знает только запись.
 *
 * Текст ответа с вариантом не сверяется намеренно: владелец вправе прислать свою
 * формулировку выбранного (веб отправляет `options[i]`, MCP-клиент — что угодно), и
 * равенство строк сделало бы контракт хрупким там, где он ничего не защищает — читатели
 * пачки берут ТЕКСТ, индекс им не нужен вовсе (`listRunUnits`).
 *
 * ОТРИЦАТЕЛЬНЫЙ индекс отсекается ЗДЕСЬ, а не только схемой роутера (`min(0)`): ядро
 * экспортировано, и прямой вызыватель — соседний `decideAllDeferred`, будущий MCP-путь —
 * прошёл бы сверку насквозь (`-1 >= options.length` — ложь) и уехал бы с `option:-1` в
 * append-only metadata навсегда (Minor-1 ревью Задачи 10).
 */
function assertOption(pendingId: string, option: number, options?: string[]): void {
  if (options === undefined || option < 0 || option >= options.length) {
    throw new ExecError(
      'VALIDATION',
      `у вопроса нет варианта №${option + 1}: их ${options?.length ?? 0}`,
      { pendingId, option, options: options?.length ?? 0 },
    );
  }
}

/**
 * Бухгалтерия пачки: разобранный прогон перестаёт числиться неразобранным (§9.6, ОЧ.6).
 *
 * Форма патча — ровно та же, что у гашения (`closeOpenOfRun`): ЗАПИСЬ `false`, а не
 * удаление ключа (предиката «поля нет» у грамматики §6 не существует, и запросом
 * разобранную пачку иначе не отличить от неразобранной), актор — `{ai, system}` со ссылкой
 * на прогон. Системный источник здесь — инвариант, а не стиль: пиши мы флажок от владельца,
 * «отмени последнее» после «Принять» сняло бы ФЛАЖОК вместо применённого действия
 * (`undoLast` пропускает `system`), то есть приёмка 18 ломалась бы молча.
 *
 * Порядок проверок — от дешёвой к дорогой, и это не только про скорость: флажок читается
 * с прогона одним индексным SELECT по PK, а список единиц — containment-пробой (под RLS
 * это Seq Scan, см. докблок `routineHistory`). Прогон БЕЗ флажка — самый частый случай на
 * этом пути (живой прогон флажка ещё не имеет, разобранный — уже), и платить за него
 * пробой ленты незачем. Заодно это правило «не пишем `false` тому, у кого нечего снимать»:
 * лишний патч был бы лишним действием журнала на каждое повторное нажатие кнопки.
 *
 * Ничего не бросает: флажок — величина производная, и его неснятие не повод отменять
 * состоявшееся решение владельца. Не сняли сейчас — снимет следующее решение или гашение
 * (лестница §5).
 *
 * АРХИВНЫЙ прогон патчится наравне с живым, и это проверено, а не предположено: `NOT
 * archived` стоит на ЧТЕНИИ прогона (`runById`), из-за которого решения по `pendingId` его
 * и не читают (Р-17), а правку архивной записи executor не запрещает. То есть пачка
 * откаченного прогона доразбирается до конца — включая флажок.
 */
async function settleUndecided(
  deps: RoutineWriteDeps,
  ownerId: string,
  runId: string,
): Promise<void> {
  try {
    const row = await withIdentity(deps.db, ownerId, (tx) => runRowAnyArchive(tx, runId));
    if (row?.props['orbis/undecided'] !== true) return;
    const units = await withIdentity(deps.db, ownerId, (tx) => listRunUnits(tx, ownerId, runId));
    if (units.some((u) => u.fate === 'open')) return;
    const patched = await patchRun(deps, {
      ownerId,
      id: runId,
      props: { 'orbis/undecided': false },
      actor: { ...ACCOUNTING_ACTOR, runId },
    });
    if (!patched.ok) {
      console.error(`[routines] флажок пачки не снят с ${runId}:`, patched.error.code);
    }
  } catch (e) {
    console.error(`[routines] пачка прогона ${runId} не сверена:`, e);
  }
}

/** Судьба ОДНОЙ единицы — перечитывается после проигранной гонки (образец `currentStatus`). */
async function unitFate(
  deps: RoutineWriteDeps,
  args: { ownerId: string; pendingId: string; runId: string; isAction: boolean },
): Promise<RunUnit['fate'] | undefined> {
  // Вопросу перечитка не положена: его отказ — это гейт рода (С7), а не проигранная
  // гонка, и «уже отвечен» на approve означало бы «решено», хотя решать так нельзя вовсе
  if (!args.isAction) return undefined;
  const units = await withIdentity(deps.db, args.ownerId, (tx) =>
    listRunUnits(tx, args.ownerId, args.runId),
  );
  return units.find((u) => u.pendingId === args.pendingId)?.fate;
}

/** Единица пачки в объёме, который нужен решениям: род, прогон и варианты ответа. */
interface UnitRecord {
  /** Явный род (ОЧ.2); `undefined` — запись не единица (чат, предложение рутины). */
  kind?: 'question' | 'action';
  runId?: string;
  options?: string[];
}

/**
 * Носитель единицы из ленты — проба containment'ом по `pending.id`, та же, что у
 * `storedProposal` и `findPendingMessage`. Читается СЫРОЙ формой, а не схемой
 * `pendingRecord` (она приватна в policy): решениям нужны три поля, а полный разбор —
 * дело тех, кто пишет судьбу, и он уже стоит внутри `approvePending`/`rejectPending`.
 *
 * `null` — записи не видно: её нет либо она чужая (RLS скоупит ленту владельцем).
 */
async function unitRecord(tx: Tx, pendingId: string): Promise<UnitRecord | null> {
  const probe = JSON.stringify({ pending: { id: pendingId } });
  const rows = await tx.execute(
    sql`SELECT metadata FROM chat_messages WHERE metadata @> ${probe}::jsonb LIMIT 1`,
  );
  const row = (rows as unknown as Array<Record<string, unknown>>)[0];
  if (row === undefined) return null;
  const pending = (row.metadata as { pending?: Record<string, unknown> }).pending ?? {};
  const kind = pending.kind;
  const runId = pending.run_id;
  const options = pending.options;
  return {
    ...(kind === 'question' || kind === 'action' ? { kind } : {}),
    ...(typeof runId === 'string' && { runId }),
    ...(Array.isArray(options) && { options: options.filter((o) => typeof o === 'string') }),
  };
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
 * Расхождение предложения (или отложенной единицы) с графом ЦЕЛИКОМ — оба его вида одним
 * ответом (§А7-3, РП-10). Не про расхождение вовсе — `null`.
 *
 * Видов ровно два, и они взаимоисключающие, потому что отказ у операции один:
 *  - предусловия по СВОЙСТВАМ не выполнены — `CONFLICT/precondition_failed`, список
 *    `mismatches`;
 *  - разошлось ТЕЛО — `STALE_VERSION`. У тела нет предусловия по значению: его CAS это
 *    `expectedUpdatedAt` строки, снятый при составлении (propose.ts buildUpdate). Прежде это
 *    подделывалось пунктом `{aspect:'', field:'body'}` — вторым способом сказать «здесь не
 *    свойство», у которого не было ни адреса в пространстве свойств, ни осмысленного
 *    `expected` (ехали отметки `updated_at`, владельцу они не говорят ничего). Теперь это
 *    ФЛАГ, а `mismatches` остаётся списком расхождений по свойствам.
 *
 * Для владельца оба вида — одно и то же «устарело»: запись менялась после того, как рутина
 * её видела (тело — или что угодно ещё: `updated_at` бампит любая правка).
 */
function divergenceOf(error: StructuredError): ProposalDivergence | null {
  const mismatches = preconditionMismatches(error);
  if (mismatches !== null) return { mismatches, bodyChanged: false };
  if (error.code === 'STALE_VERSION') return { mismatches: [], bodyChanged: true };
  return null;
}

/** Нота расхождения тела в аспекте прогона: отметки `updated_at` владельцу ничего не скажут. */
const BODY_MISMATCH_NOTE = 'тело изменено после составления предложения';

/**
 * Расхождения в форме, которая ложится в аспект прогона (V1.4): человекочитаемая строка
 * вместо сырых значений. Она переживает саму карточку и читается на экране прогона спустя
 * дни — «предусловие orbis/task_status не выполнено» там не сказало бы владельцу ничего.
 *
 * Единица расхождения — СВОЙСТВО (§А7-3/§А7-4), и реестр принимает у `orbis/run_proposal`
 * только форму `{property, note}`. Расхождение ТЕЛА свойством не является — оно приходит
 * флагом и записывается нотой под `BODY_NOTE_PROPERTY`: одна форма ноты на оба вида, без
 * второго способа сказать «а это не свойство».
 */
function mismatchNotes(divergence: ProposalDivergence): ProposalMismatchNote[] {
  const notes: ProposalMismatchNote[] = divergence.bodyChanged
    ? [{ property: BODY_NOTE_PROPERTY, note: BODY_MISMATCH_NOTE }]
    : [];
  for (const m of divergence.mismatches) {
    notes.push({
      property: m.property,
      note: `ожидали ${expectedText(m.expected)}, сейчас ${actualText(m.actual)}`.slice(
        0,
        MISMATCH_NOTE_MAX,
      ),
    });
  }
  return notes.slice(0, MAX_MISMATCH_NOTES);
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
  ownerId: string,
  operations: readonly StoredOperation[],
  args: { withDiff: boolean },
): Promise<ProposalOperationView[]> {
  const titles = await titlesOf(tx, referencedIds(operations));
  // Снимок реестра нужен строке СВЯЗИ: роль подписывает реестр (Ч10-С3). Строкам правки он
  // больше не нужен — адреса свойств в сохранённом payload'е уже id (`buildUpdate`).
  const reg = await loadRegistry(tx, ownerId);
  const bodies = await proposalBodyRows(tx, operations, args);
  const rows: ProposalOperationView[] = [];
  for (const [index, op] of operations.entries()) {
    if (op.tool === 'entity_create') {
      rows.push(createRow(index, op.input));
    } else if (op.tool === 'relation_create' || op.tool === 'relation_delete') {
      rows.push(relationRow(reg, index, op, titles));
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
  // Аспекты создания — СПИСОК (§А9-1); разбор один на всех читателей предложения.
  const aspects = namedAspects(input);
  return {
    index,
    tool: 'entity_create',
    // id у создания может и не быть (его выдаст executor) — тогда ссылаться не на что
    ...(typeof input.id === 'string' && { entity: { id: input.id, title } }),
    summary: aspects.length > 0 ? `Создать: ${title} (${aspects.join(', ')})` : `Создать: ${title}`,
  };
}

/**
 * Строка предложения о связи. Роль подписывает РЕЕСТР (Ч10-С3), а не её id: владелец читает
 * «Связь Тикет: …», а не «Связь ticket: …», и своя роль владельца подписывается тем же
 * движением. Фолбэк на id — для роли, которой в реестре уже нет (предложение переживает
 * правку реестра): показать id честнее, чем спрятать строку или соврать чужим словом.
 */
function relationRow(
  reg: RegistrySnapshot,
  index: number,
  op: StoredOperation,
  titles: ReadonlyMap<string, string>,
): ProposalOperationView {
  const sourceId = String(op.input.source_id);
  const targetId = String(op.input.target_id);
  const role = String(op.input.role);
  const from = titleOf(titles, sourceId);
  const to = titleOf(titles, targetId);
  const verb = op.tool === 'relation_create' ? 'Связь' : 'Убрать связь';
  return {
    index,
    tool: op.tool,
    entity: { id: sourceId, title: from },
    summary: `${verb} ${reg.roles.get(role)?.label.ru ?? role}: «${from}» → «${to}»`,
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

  // Строка на СВОЙСТВО (§А1-1), а не на пару «аспект + поле»: аспект перестал быть
  // владельцем поля, и `aspect` у строки свойства теперь не заполняется вовсе — web
  // подписывает такую строку по `field` (id свойства) до перевода Задачей 13c.
  // Адреса в сохранённом payload'е — УЖЕ id: их нормализовал `buildUpdate` при составлении
  // предложения (там же, где снял предусловия). Второй резолв здесь был бы мёртвой веткой.
  const props = (input.props as Record<string, unknown> | undefined) ?? {};
  for (const [property, after] of Object.entries(props)) {
    const known = before.get(property);
    rows.push({
      index,
      tool: 'entity_update',
      entity,
      field: property,
      ...(known !== undefined && { before: known.value }),
      after,
      summary: `«${entity.title}»: ${property}`,
    });
  }
  // Снятие значения — тоже строка: без неё владелец увидел бы предложение, которое молча
  // стирает поле. `after` у неё — литерал «—», а не `undefined`: у строки предложения
  // «станет» обязательное поле, и пустое значение читалось бы как «строку не показали».
  for (const property of (input.unset as string[] | undefined) ?? []) {
    const known = before.get(property);
    rows.push({
      index,
      tool: 'entity_update',
      entity,
      field: property,
      ...(known !== undefined && { before: known.value }),
      after: UNSET_ROW_VALUE,
      summary: `«${entity.title}»: снять ${property}`,
    });
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
 * Значения снятых предусловий по id СВОЙСТВА (§А7-3). Обёртка `{ value }` не декоративна:
 * само значение бывает `null` и `false`, и различать «предусловия нет» от «предусловие
 * есть, и оно про null» по самому значению было бы нельзя.
 */
function preconditionValues(precondition: unknown): Map<string, { value: unknown }> {
  const out = new Map<string, { value: unknown }>();
  if (!Array.isArray(precondition)) return out;
  for (const item of precondition) {
    if (typeof item !== 'object' || item === null) continue;
    const p = item as { property?: unknown; in?: unknown; absent?: unknown };
    if (typeof p.property !== 'string') continue;
    const key = p.property;
    if (p.absent === true) {
      // Литерал `'absent'` — контракт ProposalOperationView.before: «поля не было»
      out.set(key, { value: 'absent' });
    } else if (Array.isArray(p.in) && p.in.length > 0) {
      out.set(key, { value: p.in[0] });
    }
  }
  return out;
}
