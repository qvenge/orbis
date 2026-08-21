// apps/server/src/agent-loop/verbs.ts
// Глаголы исполнителя (§9.3, С7): узкие инструменты, внутри которых живут правила круга.
//
// Почему глаголы, а не сырые мутации: правило нельзя охранять инструментом, который умеет
// всё. Получив `entity_update`, исполнитель поставит `done` в обход — не со зла, а потому
// что короче. Поэтому сырые мутации закрыты скоупом `worker` (tools/dispatch.ts), а
// правила («тикет закрывает не агент», «захват атомарен») лежат здесь.
//
// Глагол — НЕ обход executor'а: каждый собирает batch из существующих операций и зовёт
// `execute`. Журнал §7.8 с актором-агентом, inverse, Undo и карточки достаются даром,
// а правило «один путь мутаций» (§9.1) не двоится. Собственных INSERT/UPDATE здесь нет.
import {
  type AgentRunAspect,
  type CheckpointInput,
  type CheckpointResult,
  type ClaimTaskInput,
  type ClaimTaskResult,
  checkpointInput,
  claimTaskInput,
  type EntityUpdatePreconditionItem,
  type FinishInput,
  type FinishResult,
  finishInput,
  type MyQueueResult,
  myQueueInput,
  newId,
  type QueueTicket,
  type RunStepInput,
  type RunStepResult,
  type RunUsageInput,
  runStepInput,
  type TaskStatus,
} from '@orbis/shared';
import type { z } from 'zod';
import type { Db } from '../db/client';
import { withIdentity } from '../db/with-identity';
import { ExecError } from '../errors';
import { execute } from '../executor/executor';
import type { ActorKind, JournalSink, MutationSource, WireEntity } from '../executor/types';
import type { GrantRef } from '../oauth/grants';
import { listRunUnits } from '../policy/pending';
import type { ToolDispatchResult } from '../tools/dispatch';
import type { AGENT_VERB_NAMES } from '../tools/registry';
import {
  assignedTickets,
  parentProject,
  type RunRow,
  runById,
  runSummary,
  runsOfParent,
  type TicketRow,
  ticketById,
  ticketOfRun,
} from './queries';
import { sweepStaleRuns } from './sweep';

export type AgentVerbName = (typeof AGENT_VERB_NAMES)[number];

/**
 * Кто ведёт прогон (V1.4, V1.5). Прогон адресуется КОНКРЕТНОМУ субъекту, и субъектов
 * ровно два: внешний доступ (грант, С2) и рутина владельца. Та же развилка стоит на
 * стороне графа инвариантом «ровно одно из grant_id/routine_id» (assertRunSubject) —
 * здесь она в форме типа, чтобы «прогон без хозяина» не собирался в принципе.
 */
export type RunSubject =
  | { kind: 'grant'; grant: GrantRef }
  | { kind: 'routine'; routineId: string };

/**
 * Контекст исполнения глагола. `subject` не опционален: глагол без субъекта не к кому
 * отнести, и вызов без него диспатч отбивает гейтом `agentOnly` ещё до этого модуля.
 */
export type VerbCtx = {
  db: Db;
  ownerId: string;
  subject: RunSubject;
  clock: () => Date;
  sink: JournalSink;
};

/**
 * Актор и источник бухгалтерии прогона выводятся ИЗ СУБЪЕКТА, а не передаются полем
 * (рулинг Р-7/В1): за шагом гранта стоит внешний агент, пришедший по MCP; за шагом
 * рутины — внутренний AI, и его записи о прогоне (шаги, исход, чекпойнт) — не правка
 * графа по существу, а протокол, поэтому источник `system`, а не `routine`. Одно место
 * на обе половины: разъехавшись, они дали бы в журнале «агент» с источником `system`.
 */
export function actorOf(subject: RunSubject): {
  actorKind: ActorKind;
  source: MutationSource;
  actorGrantId?: string;
} {
  return subject.kind === 'grant'
    ? { actorKind: 'agent', source: 'mcp', actorGrantId: subject.grant.id }
    : { actorKind: 'ai', source: 'system' };
}

/** Поле аспекта прогона, которым он привязан к субъекту (V1.4). */
export function subjectField(s: RunSubject): 'grant_id' | 'routine_id' {
  return s.kind === 'grant' ? 'grant_id' : 'routine_id';
}

/** Значение этого поля: id гранта либо id рутины. */
export function subjectId(s: RunSubject): string {
  return s.kind === 'grant' ? s.grant.id : s.routineId;
}

/**
 * Envelope-схемы глаголов — карта для диспатча: он валидирует вход ДО классификации
 * §7.10, а не после. Карта здесь, а не в реестре, потому что она же задаёт типы
 * функций-глаголов ниже — два списка разъехались бы при первом новом глаголе.
 */
export const AGENT_VERB_ENVELOPES = {
  orbis_my_queue: myQueueInput,
  orbis_claim_task: claimTaskInput,
  orbis_run_step: runStepInput,
  orbis_checkpoint: checkpointInput,
  orbis_finish: finishInput,
} as const satisfies Record<AgentVerbName, z.ZodTypeAny>;

function ok(result: unknown): ToolDispatchResult {
  return { status: 'ok', result };
}

function err(code: string, message: string, details?: unknown): ToolDispatchResult {
  return { status: 'error', error: { code, message, details } };
}

/**
 * Типизация уже провалидированного входа. Диспатч валидирует envelope сам (§7.10:
 * уровень получает tool-call ПОСЛЕ структурной валидации), поэтому здесь разбор не
 * может провалиться; он стоит ради точного типа вместо `as` и остаётся fail-closed
 * второй линией для любого будущего вызывающего.
 */
function narrow<S extends z.ZodTypeAny>(schema: S, input: unknown, tool: string): z.infer<S> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new ExecError('VALIDATION', `невалидный input глагола «${tool}»`, {
      tool,
      issues: parsed.error.issues,
    });
  }
  return parsed.data;
}

/** Статусы, из которых тикет можно взять в работу (единственное место правила). */
const CLAIMABLE_STATUSES: readonly TaskStatus[] = ['inbox', 'planned'];

function iso(d: Date): string {
  return d.toISOString();
}

/**
 * Сущность из результата `execute`. Приведение через проверку, а не `as`: на
 * идемпотентном повторе (§7.8) results — это ЧУЖОЙ сохранённый ответ, форму которого мы
 * не выбирали, и голое приведение превращало бы повтор с занятым id в TypeError (500)
 * вместо структурного отказа.
 */
function wireEntityAt(results: unknown[], index: number): WireEntity | null {
  const row = results[index];
  if (typeof row !== 'object' || row === null) return null;
  const wire = row as Partial<WireEntity>;
  if (typeof wire.id !== 'string') return null;
  if (typeof wire.aspects !== 'object' || wire.aspects === null) return null;
  return wire as WireEntity;
}

/**
 * Отказ «под этим id вызова лежит не наш результат». Один текст на все глаголы: агенту
 * важно ровно одно действие — взять новый id, а разбор того, чей именно ответ там лежал,
 * ему не поможет (и знать чужое ему незачем).
 */
function replayMismatch(verb: string, batchId: string): ToolDispatchResult {
  return err('CONFLICT', `id вызова уже использован другим действием — возьми новый`, {
    tool: verb,
    id: batchId,
  });
}

/**
 * Поле провалившегося предусловия из details CONFLICT'а. Executor кладёт туда ПЕРВЫЙ
 * провалившийся элемент (полный список — в `details.mismatches`): глаголу нужен ровно
 * один ответ — «прогон уже закрыт» это или что-то другое, — и первого пункта для него
 * достаточно, а разбор всех расхождений адресован владельцу, не агенту.
 */
function preconditionField(details: unknown): string | undefined {
  if (typeof details !== 'object' || details === null) return undefined;
  const precondition = (details as { precondition?: unknown }).precondition;
  if (typeof precondition !== 'object' || precondition === null) return undefined;
  const field = (precondition as { field?: unknown }).field;
  return typeof field === 'string' ? field : undefined;
}

/** Найденный прогон либо готовый структурный отказ — «или/или» без исключений. */
type RunLookup =
  | { run: RunRow; error?: undefined }
  | { run?: undefined; error: ToolDispatchResult };

/**
 * Прогон под RLS владельца + проверки принадлежности, общие трём глаголам.
 *
 * Два разных отказа намеренно: чужой владелец — `NOT_FOUND` (прогон за пределами графа
 * агента для него не существует), чужой СУБЪЕКТ того же владельца — `CONFLICT` (прогон
 * есть, но он не твой: у владельца может работать второй исполнитель и десяток рутин).
 * Проверка субъекта остаётся ПРЕДпроверкой и при повторе с тем же `id`: replay
 * executor'а отдаёт сохранённый ответ, не спрашивая, кто пришёл, — и чужой исполнитель
 * получил бы чужой прогон.
 *
 * Терминальности здесь НЕТ: она зависит от того, послан ли ключ идемпотентности, и
 * решается в самих глаголах (см. `terminalError`).
 */
async function readRun(ctx: VerbCtx, runId: string): Promise<RunLookup> {
  const row = await withIdentity(ctx.db, ctx.ownerId, (tx) => runById(tx, runId));
  if (row === null) return { error: err('NOT_FOUND', 'прогон не найден', { run_id: runId }) };
  if (row.run[subjectField(ctx.subject)] !== subjectId(ctx.subject)) {
    return {
      error: err('CONFLICT', 'прогон принадлежит другому субъекту', { run_id: runId }),
    };
  }
  return { run: row };
}

/**
 * Отказ по терминальному прогону (инвариант 5): агент из ответа понимает, ЧТО случилось
 * с его работой, и не повторяет вызов.
 *
 * Строится в двух местах — предпроверкой (вызов БЕЗ `id`) и по провалившемуся
 * предусловию `outcome` (вызов со СВЕЖИМ `id`), — поэтому текст и details живут одной
 * функцией: ответ обязан быть одинаковым независимо от того, послал агент ключ
 * идемпотентности или нет.
 */
function terminalError(
  runId: string,
  outcome: string,
  note: string | undefined,
  tail: string,
): ToolDispatchResult {
  return err('CONFLICT', `прогон завершён (${outcome}) — ${tail}`, {
    run_id: runId,
    outcome,
    ...(note !== undefined && { note }),
  });
}

/**
 * Терминальность ДО записи — только для вызова без ключа идемпотентности.
 *
 * С `id` отказывать по прочитанному состоянию нельзя: повтор того же вызова обязан
 * вернуть сохранённый ответ (§7.8, С7), а replay executor проверяет ДО предусловий
 * (executor.ts:380-385) — то есть уже внутри `execute`. Отказали бы здесь — повтор
 * checkpoint/finish (и шага по закрытому прогону) навсегда получал бы CONFLICT вместо
 * своего же результата, и агент считал бы работу несделанной.
 */
function terminalBeforeWrite(
  run: AgentRunAspect,
  runId: string,
  callId: string | undefined,
  tail: string,
): ToolDispatchResult | null {
  if (run.outcome === 'running' || callId !== undefined) return null;
  return terminalError(runId, run.outcome, closeNote(run), tail);
}

/**
 * Заметка о том, ЧЕМ кончился прогон, для details отказа. Две колонки, а не одна:
 * `abandon_note` пишет подметание грантового прогона (С6), `fail_note` — рутинного (V1.12)
 * и раннер при сбое. Читая только первую, отказ по рутинному прогону молчал бы о причине —
 * ровно там, где она единственное, что объясняет «почему мою работу не приняли».
 */
function closeNote(run: AgentRunAspect): string | undefined {
  return run.abandon_note ?? run.fail_note;
}

/**
 * Тот же терминальный отказ, но по ответу executor'а: предусловие `outcome` провалилось,
 * значит вызов пришёл со свежим `id` на уже закрытый прогон. Исход берём из `actual`
 * (состояние ПОД замком), заметку об обрыве — из прочитанного прогона.
 */
function terminalFromPrecondition(
  details: unknown,
  run: AgentRunAspect,
  runId: string,
  tail: string,
): ToolDispatchResult {
  const actual = (details as { actual?: unknown } | null)?.actual;
  return terminalError(
    runId,
    typeof actual === 'string' ? actual : run.outcome,
    closeNote(run),
    tail,
  );
}

/** Прогон из сохранённого ответа — тот же самый, наш и в ожидаемом исходе? */
function savedRunMatches(
  wire: WireEntity | null,
  runId: string,
  subject: RunSubject,
  outcome: string,
): boolean {
  if (wire === null || wire.id !== runId) return false;
  const saved = wire.aspects['orbis/agent-run'];
  // Субъект — как в захвате: replay отдаёт сохранённый ответ, не спрашивая, кто пришёл.
  // Исход — против переиспользования id между глаголами: под id чекпойнта лежит прогон
  // в `checkpoint`, и отдать его как результат шага значило бы соврать про состояние.
  return saved?.[subjectField(subject)] === subjectId(subject) && saved?.outcome === outcome;
}

/** Предусловия «прогон всё ещё мой и всё ещё идёт» — общие шагу, чекпойнту и итогу. */
function runStillMine(subject: RunSubject): EntityUpdatePreconditionItem[] {
  return [
    { aspect: 'orbis/agent-run', field: 'outcome', in: ['running'] },
    { aspect: 'orbis/agent-run', field: subjectField(subject), in: [subjectId(subject)] },
  ];
}

/**
 * Отказ «этот глагол — только для гранта» (V1.5). Очередь и захват стоят на тикетах и
 * назначениях: они спрашивают «что назначено МНЕ» и «отдай мне вот это в работу», а
 * рутине не назначают — её прогон заводит раннер по расписанию, и брать ей нечего.
 *
 * Fail-closed вторая линия, а не мёртвая ветка: белый список `allowed_tools` рутины —
 * произвольные имена от владельца, и вписанный туда `orbis_claim_task` гейт режима
 * пропустит (он сверяет имя, а не смысл).
 */
function grantOnlyVerb(name: AgentVerbName): ToolDispatchResult {
  return err(
    'VALIDATION',
    `глагол «${name}» — только для гранта: у прогона рутины нет ни очереди, ни тикета (V1.5)`,
    { tool: name },
  );
}

export async function runAgentVerb(
  ctx: VerbCtx,
  name: AgentVerbName,
  input: unknown,
): Promise<ToolDispatchResult> {
  switch (name) {
    case 'orbis_my_queue': {
      // Разбор ради fail-closed на лишних полях; своего содержимого у envelope нет
      narrow(myQueueInput, input, name);
      if (ctx.subject.kind !== 'grant') return grantOnlyVerb(name);
      return myQueue(ctx, ctx.subject.grant);
    }
    case 'orbis_claim_task': {
      const parsed = narrow(claimTaskInput, input, name);
      if (ctx.subject.kind !== 'grant') return grantOnlyVerb(name);
      return claimTask(ctx, ctx.subject.grant, parsed);
    }
    case 'orbis_run_step':
      return runStep(ctx, narrow(runStepInput, input, name));
    case 'orbis_checkpoint':
      return checkpoint(ctx, narrow(checkpointInput, input, name));
    case 'orbis_finish':
      return finish(ctx, narrow(finishInput, input, name));
  }
}

// ---------------------------------------------------------------------------
// orbis_my_queue — что мне назначено; по дороге подметает зависшие прогоны (С6)
// ---------------------------------------------------------------------------

async function myQueue(ctx: VerbCtx, grant: GrantRef): Promise<ToolDispatchResult> {
  // Подметание ПЕРЕД выборкой, а не после: тикет, чей прогон только что признан
  // брошенным, обязан приехать агенту уже свободным — иначе он увидит его
  // `in_progress` и уйдёт ни с чем ровно в тот момент, когда работа освободилась.
  const { swept } = await sweepStaleRuns(ctx.db, {
    ownerId: ctx.ownerId,
    actorKind: 'agent',
    actorGrantId: grant.id,
    clock: ctx.clock,
  });

  const tickets = await withIdentity(ctx.db, ctx.ownerId, async (tx) => {
    const rows = await assignedTickets(tx, grant.id);
    const out: QueueTicket[] = [];
    for (const row of rows) {
      const task = row.aspects['orbis/task'] ?? {};
      const status = task.status as TaskStatus;
      const project = await parentProject(tx, row.id);
      const runs = await runsOfParent(tx, row.id);
      const last = runs.at(-1);
      out.push({
        id: row.id,
        title: row.title,
        status,
        claimable: CLAIMABLE_STATUSES.includes(status),
        ...(typeof task.priority === 'string' && { priority: task.priority }),
        ...(typeof task.due_date === 'string' && { due_date: task.due_date }),
        ...(project !== null && { project: { id: project.id, title: project.title } }),
        ...(last !== undefined && { last_run: runSummary(last) }),
      });
    }
    return out;
  });

  const result: MyQueueResult = { tickets, swept };
  return ok(result);
}

// ---------------------------------------------------------------------------
// orbis_claim_task — атомарный захват (С7, инвариант 1)
// ---------------------------------------------------------------------------

async function claimTask(
  ctx: VerbCtx,
  grant: GrantRef,
  input: ClaimTaskInput,
): Promise<ToolDispatchResult> {
  const ticket = await withIdentity(ctx.db, ctx.ownerId, (tx) => ticketById(tx, input.ticket_id));
  // Чужой и несуществующий тикет под RLS неразличимы намеренно: исполнителю не с чего
  // узнавать, что за пределами его назначений вообще что-то есть.
  if (ticket === null) {
    return err('NOT_FOUND', 'тикет не найден', { ticket_id: input.ticket_id });
  }
  const project = await withIdentity(ctx.db, ctx.ownerId, (tx) =>
    parentProject(tx, input.ticket_id),
  );

  const runId = newId();
  // `id` вызова = batch_id action'а §7.8: ретрай вебхука/сети с тем же id вернёт тот же
  // прогон, а не заведёт вторую работу (С7). Без id повтор неотличим от нового захвата —
  // но его отобьёт предусловие: тикет уже `in_progress`.
  const batchId = input.id ?? newId();
  const now = ctx.clock();
  const nowIso = now.toISOString();

  const operations = [
    {
      tool: 'entity_update',
      input: {
        id: ticket.id,
        // Захват — CAS-расширение стадий 4–5 (С7): «тикет всё ещё свободен И всё ещё
        // назначен ЭТОМУ гранту» проверяется по строке под FOR UPDATE и применяется той
        // же транзакцией. Отсюда инвариант 1: два конкурентных захвата не могут оба
        // увидеть `planned`. Три условия, а не одно: отобрать чужой тикет так же
        // недопустимо, как перехватить уже начатый.
        precondition: [
          { aspect: 'orbis/task', field: 'status', in: [...CLAIMABLE_STATUSES] },
          { aspect: 'orbis/assignment', field: 'executor', in: ['agent'] },
          { aspect: 'orbis/assignment', field: 'grant_id', in: [grant.id] },
        ],
        aspects: { 'orbis/task': { status: 'in_progress' } },
      },
    },
    {
      tool: 'entity_create',
      input: {
        id: runId,
        title: `Прогон: ${ticket.title}`,
        tags: [],
        aspects: {
          'orbis/agent-run': {
            grant_id: grant.id,
            // Денормализация проекта на прогон: прогоны — внуки проекта, а `this`
            // грамматики §6 достаёт только детей (блок «Последние прогоны» заготовки С10)
            ...(project !== null && { project_id: project.id }),
            outcome: 'running',
            started_at: nowIso,
            last_step_at: nowIso,
            step_count: 0,
            steps: [],
            ...(input.session_url !== undefined && { session_url: input.session_url }),
          },
        },
      },
    },
    {
      tool: 'relation_create',
      input: { source_id: ticket.id, target_id: runId, relation_type: 'parent' },
    },
  ];

  const r = await execute(
    ctx.db,
    {
      actorUserId: ctx.ownerId,
      ...actorOf(ctx.subject),
      runId,
      batchId,
      operations,
      clock: ctx.clock,
    },
    { sink: ctx.sink },
  );
  if (!r.ok) {
    if (r.error.code === 'CONFLICT') {
      // Одно сообщение на все три предусловия намеренно: агенту важно «не мой/уже занят —
      // не повторяй, возьми другой», а какое именно поле разошлось, он всё равно не
      // исправит. Разбор остаётся в details (`precondition`, `actual`) — для человека.
      return err(
        'CONFLICT',
        'тикет уже в работе или не назначен этому исполнителю',
        r.error.details,
      );
    }
    return { status: 'error', error: r.error };
  }

  // Порядок результатов = порядок операций. При идемпотентном повторе (§7.8) операции не
  // исполнялись вовсе, и локальный runId — не тот, что в графе: правду берём из
  // сохранённого ответа, иначе агент получил бы id несуществующего прогона.
  const ticketWire = wireEntityAt(r.results, 0);
  const runWire = wireEntityAt(r.results, 1);
  // Форму сохранённого ответа мы не выбирали: под тем же id мог лечь ЛЮБОЙ batch
  // владельца (правка заметки — тоже batch). Проверка формы, а не приведение: иначе
  // повтор чужого id падал бы TypeError'ом в 500 вместо структурного отказа.
  if (ticketWire === null || runWire === null) {
    return replayMismatch('orbis_claim_task', batchId);
  }

  // Ключ идемпотентности — ключ ВЫЗОВА, а не тикета: если агент переиспользовал `id` для
  // другого тикета, replay вернул бы ему чужой прогон, и шаги поехали бы не туда. Замена
  // тихой подмены на честный отказ; при нормальном (свежем) id ветка недостижима.
  if (ticketWire.id !== ticket.id) {
    return err('CONFLICT', 'id вызова уже использован другим захватом — возьми новый', {
      tool: 'orbis_claim_task',
      id: batchId,
      ticket_id: ticket.id,
      claimed: ticketWire.id,
    });
  }
  // …и ключ ОДНОГО исполнителя: audit-id считается по владельцу и batch_id, поэтому
  // второй грант того же владельца, повторив id первого, получил бы на replay его прогон
  // и начал бы писать в него шаги. Тикет здесь совпадает — различает только грант.
  const runGrantId = runWire.aspects['orbis/agent-run']?.grant_id;
  if (runGrantId !== grant.id) {
    return err('CONFLICT', 'id вызова уже использован другим исполнителем — возьми новый', {
      tool: 'orbis_claim_task',
      id: batchId,
      ticket_id: ticket.id,
    });
  }
  const actualRunId = runWire.id;

  const history = await withIdentity(ctx.db, ctx.ownerId, async (tx) => {
    const runs = await runsOfParent(tx, ticket.id);
    return runs.filter((row) => row.id !== actualRunId).map(runSummary);
  });

  const result: ClaimTaskResult = {
    run_id: actualRunId,
    action_id: r.actionId,
    ticket: {
      id: ticketWire.id,
      title: ticketWire.title,
      body: ticketWire.body,
      aspects: ticketWire.aspects,
    },
    project,
    // Процесс проекта — это его тело (С10): агент читает раздел «Процесс» при захвате.
    process: project === null ? null : project.body,
    history,
    replayed: r.idempotentReplay,
  };
  return ok(result);
}

// ---------------------------------------------------------------------------
// orbis_run_step — след работы и отметка живости (С5, С6)
// ---------------------------------------------------------------------------

/**
 * Сколько раз глагол перечитывает прогон, проиграв CAS. Шесть, а не «пока не выйдет»:
 * вечный ретрай под нагрузкой держал бы соединение вместо честного «повтори вызов».
 *
 * Почему не три: конкурируют шаги ОДНОГО прогона, но агент зовёт тулы параллельно —
 * Claude Code выпускает несколько tool-call'ов одним ходом. При N одновременных шагах
 * k-му по порядку победы нужно k попыток (все читают один и тот же step_count, дальше
 * побеждают по одному), то есть трёх не хватало уже на четырёх параллельных шагах —
 * и агент получал CONFLICT там, где сервер обязан был просто перечитать.
 */
const STEP_CAS_ATTEMPTS = 6;

/**
 * Шаг прогона: строка в массиве `steps` + счётчик + отметка живости.
 *
 * Почему шаги живут на прогоне, а не только в журнале §7.8: сводка обязана пережить
 * журнал (С5). Журнал — про мутации графа и Undo, он подрезается и читается по треду; а
 * «что агент успел сделать» нужно человеку в карточке прогона и подметанию (С6, признак
 * `external`) — спустя недели и без чтения чата.
 *
 * Почему CAS по счётчику, а не просто «допиши в массив»: агент зовёт тулы параллельно,
 * а `steps` патчится целым массивом (merge аспекта — по полям). Без предусловия
 * `step_count in [n]` второй шаг записал бы массив, собранный из состояния ДО первого, и
 * первый шаг молча исчез бы. Предусловие превращает потерю в CONFLICT, а CONFLICT —
 * в перечитывание: снаружи оба вызова успешны, порядок seq строгий.
 */
async function runStep(ctx: VerbCtx, input: RunStepInput): Promise<ToolDispatchResult> {
  // `id` вызова = batch_id action'а §7.8. Считается ОДИН раз, до цикла: между попытками
  // он обязан оставаться тем же (проигравшая попытка ничего не записала, а ключ
  // идемпотентности, меняющийся сам собой, раздвоил бы шаг при повторе от агента).
  const batchId = input.id ?? newId();
  const tail = 'новые шаги не принимаются';
  let lastConflict: ToolDispatchResult | null = null;

  for (let attempt = 0; attempt < STEP_CAS_ATTEMPTS; attempt++) {
    const found = await readRun(ctx, input.run_id);
    if (found.error !== undefined) return found.error;
    const run = found.run.run;
    const terminal = terminalBeforeWrite(run, input.run_id, input.id, tail);
    if (terminal !== null) return terminal;

    const now = ctx.clock();
    const n = run.step_count;
    const step = {
      seq: n + 1,
      at: iso(now),
      summary: input.summary,
      external: input.external === true,
      action_id: batchId,
    };

    const r = await execute(
      ctx.db,
      {
        actorUserId: ctx.ownerId,
        ...actorOf(ctx.subject),
        runId: found.run.id,
        batchId,
        operations: [
          {
            tool: 'entity_update',
            input: {
              id: found.run.id,
              precondition: [
                ...runStillMine(ctx.subject),
                // CAS: конкурентный шаг успел лечь → CONFLICT → перечитать и повторить
                { aspect: 'orbis/agent-run', field: 'step_count', in: [n] },
              ],
              aspects: {
                'orbis/agent-run': {
                  steps: [...run.steps, step],
                  step_count: n + 1,
                  last_step_at: iso(now),
                },
              },
            },
          },
        ],
        clock: ctx.clock,
      },
      { sink: ctx.sink },
    );

    if (r.ok) {
      const runWire = wireEntityAt(r.results, 0);
      // На повторе с тем же id (§7.8) операции не исполнялись, и в results лежит
      // сохранённый ответ — снимок прогона на момент ТОГО шага (исход тогда был
      // `running`, даже если прогон закрыли позже).
      if (runWire === null || !savedRunMatches(runWire, found.run.id, ctx.subject, 'running')) {
        return replayMismatch('orbis_run_step', batchId);
      }
      // Счётчик — из сохранённого ответа, а не локальное n+1: правда о прогоне лежит там
      const saved = runWire.aspects['orbis/agent-run']?.step_count;
      const result: RunStepResult = {
        run_id: runWire.id,
        step_count: typeof saved === 'number' ? saved : n + 1,
        action_id: r.actionId,
      };
      return ok(result);
    }
    if (r.error.code === 'CONFLICT') {
      const field = preconditionField(r.error.details);
      if (field === 'step_count') {
        lastConflict = { status: 'error', error: r.error };
        continue;
      }
      // Свежий id на уже закрытом прогоне: предпроверка его пропустила ради replay,
      // отказ пришёл предусловием — но ответ агенту обязан быть тем же (инвариант 5)
      if (field === 'outcome') {
        return terminalFromPrecondition(r.error.details, run, input.run_id, tail);
      }
    }
    // Разошлось не по счётчику и не по исходу — повторять нечего
    return { status: 'error', error: r.error };
  }
  // Три подряд проигранных CAS — отдаём последний отказ как есть (со всеми details):
  // это не «сервер сдался», а «прогон меняется быстрее, чем мы успеваем», и агенту
  // честнее увидеть конфликт, чем молчаливо потерянный шаг.
  return (
    lastConflict ??
    err('CONFLICT', 'шаг не записан: прогон меняется конкурентно — повтори вызов', {
      run_id: input.run_id,
    })
  );
}

// ---------------------------------------------------------------------------
// orbis_checkpoint / orbis_finish — прогон терминален, тикет возвращается человеку
// ---------------------------------------------------------------------------

/**
 * Осталось ли у прогона нерешённое — проба ПЕРЕД сборкой close-патча (D42 ОЧ.6).
 *
 * Зачем флажок на аспекте вообще: `undecided` — единственный дешёвый способ спросить «у
 * этого прогона осталось нерешённое?» без проб по треду. Его читают бейдж рутины,
 * смарт-лист «Ждут ответа» и экран прогона — все аспектным фильтром. Поэтому проба стоит у
 * КАЖДОГО пути закрытия (их три, Р-5), а не в одном «главном»: путь, забывший поставить
 * флажок, оставляет владельцу пачку, о которой он никогда не узнает, — карточки в треде
 * лежат, а позвать его некому.
 *
 * Своё `withIdentity`, а не переданная транзакция: `VerbCtx` несёт `db`, открытого tx вокруг
 * глагола нет — как у соседних чтений (`readRun`, `ticketOfRun`). Владелец тот же, что в
 * `ctx`, и это КОНТРАКТ `listRunUnits`, а не деталь стиля: под чужой идентичностью судьбы
 * молча не найдутся и вся пачка прочитается открытой (её докблок).
 */
async function hasOpenUnits(ctx: VerbCtx, runId: string): Promise<boolean> {
  const units = await withIdentity(ctx.db, ctx.ownerId, (tx) =>
    listRunUnits(tx, ctx.ownerId, runId),
  );
  return units.some((u) => u.fate === 'open');
}

/** Патч тикета вместе с его собственными предусловиями (у итога — право на `done`). */
interface TicketUpdate {
  aspects: Record<string, unknown>;
  /** Сверх общего «тикет ещё в работе». */
  precondition?: EntityUpdatePreconditionItem[];
}

/** Общая часть завершающих вызовов: что писать в прогон и что — в тикет. */
interface CloseRunArgs {
  /** Кто закрывает — имя глагола либо внутренний вызов раннера; едет в details отказов. */
  verb: 'orbis_checkpoint' | 'orbis_finish' | 'closeRoutineRun';
  run_id: string;
  id?: string;
  usage?: RunUsageInput;
  session_url?: string;
  /** Отказ по терминальному прогону: хвост сообщения «прогон завершён (…) — …». */
  terminalTail: string;
  /**
   * Исход, в который вызов переводит прогон (он же — ожидаемый на replay). `failed` —
   * только у рутинного субъекта (V1.4): внешнему исполнителю провал сообщать нечем, его
   * оборванный прогон подметается (С6).
   */
  outcome: 'checkpoint' | 'finished' | 'failed';
  /**
   * Патч прогона поверх общего хвоста (finished_at, last_step_at, usage, session_url).
   * Функция от `now`, а не готовый объект: `asked_at` чекпойнта обязан совпасть с
   * `finished_at` того же прогона — два вызова часов дали бы разъехавшиеся отметки
   * одного события.
   */
  runPatch: (now: Date) => Record<string, unknown>;
  /**
   * Обновление тикета; у итога зависит от may_close самого тикета (С8). Обязательно для
   * грантового субъекта и не нужно рутинному: прогон рутины — её дитя (V1.4), тикета у
   * него нет, и тикетная логика его не видит.
   */
  ticketUpdate?: (ticket: TicketRow) => TicketUpdate;
  /** Статусы тикета, допустимые в ответе: иное = сохранённый ответ чужого вызова. */
  expected?: readonly TaskStatus[];
}

/**
 * Завершение прогона: ОДИН batch из двух `entity_update` — прогон и его тикет.
 *
 * Одним batch'ем, а не двумя вызовами, потому что состояния «прогон закрыт, а тикет всё
 * ещё in_progress» быть не должно ни на миг: подметание (С6) увидело бы тикет в работе
 * без живого прогона, а владелец — работу, о которой никто не отчитался. Атомарность
 * даёт executor: обе операции в одной транзакции, один action §7.8, откат — общий.
 *
 * У рутинного субъекта операция ОДНА (V1.4): тикета нет, отчитываться некуда, а весь
 * итог рутины — это сам прогон (отчёт, `fail_note`, судьба предложения). Батчем он
 * остаётся ради ключа идемпотентности: ретрай тика обязан вернуть свой прежний ответ.
 */
async function closeRun(ctx: VerbCtx, args: CloseRunArgs): Promise<ToolDispatchResult> {
  const found = await readRun(ctx, args.run_id);
  if (found.error !== undefined) return found.error;
  const run = found.run;
  // Терминальность отдаётся сразу только без ключа идемпотентности: с ним вызов идёт в
  // executor, потому что повтор ТОГО ЖЕ вызова обязан вернуть свой сохранённый ответ.
  const terminal = terminalBeforeWrite(run.run, args.run_id, args.id, args.terminalTail);
  if (terminal !== null) return terminal;

  // Тикет ищется ТОЛЬКО грантовому прогону: у рутинного его нет по устройству, и общий
  // запрос вернул бы null, который здесь значит «прогон-сирота» — отказ там, где всё в
  // порядке. Родитель рутинного прогона — сама рутина (связь parent), а не тикет.
  let ticket: TicketRow | null = null;
  let ticketUpdate: TicketUpdate | null = null;
  if (ctx.subject.kind === 'grant') {
    ticket = await withIdentity(ctx.db, ctx.ownerId, (tx) => ticketOfRun(tx, run.id));
    // Прогон-сирота: закрывать нечего и некуда отчитываться. Случай не гипотетический —
    // связь мог снять владелец, — и молча закрыть один прогон было бы хуже отказа.
    if (ticket === null) {
      return err('NOT_FOUND', 'у прогона нет тикета — некуда записать итог', { run_id: run.id });
    }
    if (args.ticketUpdate === undefined) {
      // Недостижимо: оба грантовых глагола несут тикетную половину. Fail-closed, чтобы
      // будущий вызывающий не закрыл прогон, оставив тикет висеть `in_progress`.
      return err('VALIDATION', 'закрытие грантового прогона без обновления тикета', {
        run_id: run.id,
      });
    }
    ticketUpdate = args.ticketUpdate(ticket);
  }

  const now = ctx.clock();
  const batchId = args.id ?? newId();
  const operations: Array<{ tool: string; input: unknown }> = [
    {
      tool: 'entity_update',
      input: {
        id: run.id,
        precondition: runStillMine(ctx.subject),
        aspects: {
          'orbis/agent-run': {
            ...args.runPatch(now),
            finished_at: iso(now),
            last_step_at: iso(now),
            ...(args.usage !== undefined && { usage: args.usage }),
            ...(args.session_url !== undefined && { session_url: args.session_url }),
          },
        },
      },
    },
  ];
  if (ctx.subject.kind === 'grant' && ticket !== null && ticketUpdate !== null) {
    operations.push({
      tool: 'entity_update',
      input: {
        id: ticket.id,
        // Тикет обязан быть ещё в работе И всё ещё назначен ЭТОМУ гранту: владелец мог
        // вернуть его руками (тогда отчёт агента поверх его решения был бы перезаписью
        // чужого действия) или отдать другому исполнителю — а из назначения читается
        // `may_close` (С8), и без этой сверки право закрытия бралось бы из ЧУЖОГО
        // назначения. Пара условий, как в захвате: «мой» и «свободен» — разные вопросы.
        precondition: [
          { aspect: 'orbis/task', field: 'status', in: ['in_progress'] },
          { aspect: 'orbis/assignment', field: 'executor', in: ['agent'] },
          { aspect: 'orbis/assignment', field: 'grant_id', in: [ctx.subject.grant.id] },
          ...(ticketUpdate.precondition ?? []),
        ],
        aspects: { 'orbis/task': ticketUpdate.aspects },
      },
    });
  }

  const r = await execute(
    ctx.db,
    {
      actorUserId: ctx.ownerId,
      ...actorOf(ctx.subject),
      runId: run.id,
      batchId,
      operations,
      clock: ctx.clock,
    },
    { sink: ctx.sink },
  );
  if (!r.ok) {
    if (r.error.code === 'CONFLICT') {
      const field = preconditionField(r.error.details);
      // Свежий id на уже закрытом прогоне — тот же ответ, что дала бы предпроверка
      if (field === 'outcome') {
        return terminalFromPrecondition(r.error.details, run.run, args.run_id, args.terminalTail);
      }
      // Одно сообщение на остальные предусловия — как в захвате: агент не исправит ни
      // статус тикета, ни снятое право закрытия, а разбор остаётся в details.
      return err(
        'CONFLICT',
        ticket === null
          ? 'прогон уже завершён либо принадлежит другой рутине'
          : 'прогон уже завершён либо его тикет больше не в работе или не твой — начни с orbis_my_queue',
        r.error.details,
      );
    }
    return { status: 'error', error: r.error };
  }

  const runWire = wireEntityAt(r.results, 0);
  // Повтор с занятым id (§7.8): под ним лежит ответ другого вызова — отдать его значило
  // бы соврать агенту про состояние ЕГО прогона.
  if (runWire === null || !savedRunMatches(runWire, run.id, ctx.subject, args.outcome)) {
    return replayMismatch(args.verb, batchId);
  }
  if (ticket === null) {
    // Рутинный прогон: тикета нет — и ключей о нём в ответе тоже (V1.4)
    const result: FinishResult = { run_id: runWire.id, action_id: r.actionId };
    return ok(result);
  }

  const ticketWire = wireEntityAt(r.results, 1);
  const status = ticketWire?.aspects['orbis/task']?.status;
  if (
    ticketWire === null ||
    ticketWire.id !== ticket.id ||
    typeof status !== 'string' ||
    !((args.expected ?? []) as readonly string[]).includes(status)
  ) {
    return replayMismatch(args.verb, batchId);
  }

  const result: FinishResult = {
    run_id: runWire.id,
    ticket_id: ticketWire.id,
    ticket_status: status === 'done' ? 'done' : 'waiting',
    action_id: r.actionId,
  };
  return ok(result);
}

/**
 * Чекпойнт (С3): агент останавливается вопросом. Тикет уходит в `waiting` с вопросом в
 * `waiting_for` — то есть в то же состояние, что и при любом другом ожидании человека, и
 * владелец видит вопрос там, где привык, а не в отдельном месте для агентских дел.
 */
async function checkpoint(ctx: VerbCtx, input: CheckpointInput): Promise<ToolDispatchResult> {
  // Терминальный вопрос и пачка СОСУЩЕСТВУЮТ (ОЧ.6: «или checkpoint — тогда у прогона и
  // терминальный вопрос, и пачка»): исход прогона от нерешённых единиц не меняется,
  // `RUN_OUTCOMES` не расширяется, — но флажок обязан лечь и здесь. Это третий путь
  // закрытия рутинного прогона (Р-5), и он единственный, где глагол сам смотрит на субъекта:
  // грантовой половине проба не нужна и не положена — единиц у гранта не бывает по
  // построению (`orbis_ask` внешнему исполнителю закрыт гейтом ОЧ.12), а лишнее чтение по
  // его прогону меняло бы грантовый путь ради заведомо пустого ответа.
  const undecided = ctx.subject.kind === 'routine' ? await hasOpenUnits(ctx, input.run_id) : false;
  const out = await closeRun(ctx, {
    verb: 'orbis_checkpoint',
    run_id: input.run_id,
    ...(input.id !== undefined && { id: input.id }),
    ...(input.usage !== undefined && { usage: input.usage }),
    ...(input.session_url !== undefined && { session_url: input.session_url }),
    terminalTail: 'чекпойнт не принимается',
    outcome: 'checkpoint',
    runPatch: (now) => ({
      outcome: 'checkpoint',
      checkpoint: { question: input.question, asked_at: iso(now) },
      // Флажок — ТЕМ ЖЕ патчем, что исход (довод тот же, что у `proposal` в
      // closeRoutineRun): отдельной дозаписью он дал бы миг «прогон закрыт, а нерешённого
      // при нём нет» — ровно то состояние, по которому бейдж решает, звать ли владельца.
      // Актор патча при этом прежний (`{ai, system}`, `actorOf`) — инвариант §9.6.
      ...(undecided && { undecided: true }),
    }),
    ticketUpdate: () => ({ aspects: { status: 'waiting', waiting_for: input.question } }),
    expected: ['waiting'],
  });
  // Ответ — CheckpointResult, сужение FinishResult: `ticket_status` у чекпойнта всегда
  // 'waiting', и closeRun уже сверил его со списком `expected`. У рутинного прогона
  // тикета нет вовсе — тогда сужать нечего, ключи о тикете в ответе не появляются.
  if (out.status === 'ok') {
    const fin = out.result as FinishResult;
    const result: CheckpointResult =
      fin.ticket_id === undefined
        ? { run_id: fin.run_id, action_id: fin.action_id }
        : { ...fin, ticket_id: fin.ticket_id, ticket_status: 'waiting' };
    return ok(result);
  }
  return out;
}

/**
 * Итог (С8): «готово, проверь». Тикет закрывает НЕ агент — по умолчанию он уходит в
 * `waiting` с отчётом, и решение «сделано» остаётся за человеком. `done` возможен
 * только там, где владелец разрешил это заранее, назначением (`may_close`): разрешение
 * даётся до работы и на конкретный тикет, а не выпрашивается по её итогам.
 */
async function finish(ctx: VerbCtx, input: FinishInput): Promise<ToolDispatchResult> {
  return closeRun(ctx, {
    verb: 'orbis_finish',
    run_id: input.run_id,
    ...(input.id !== undefined && { id: input.id }),
    ...(input.usage !== undefined && { usage: input.usage }),
    ...(input.session_url !== undefined && { session_url: input.session_url }),
    terminalTail: 'итог не принимается',
    outcome: 'finished',
    runPatch: () => ({ outcome: 'finished', report: input.report }),
    ticketUpdate: (ticket) =>
      // Отсутствие may_close = запрет (С8): ajv default'ов не применяет, и «не сказано» —
      // это «нельзя», а не «можно».
      ticket.aspects['orbis/assignment']?.may_close === true
        ? {
            // Право сверяется ещё раз под замком: владелец мог снять may_close между
            // нашим чтением и записью, и тогда `done` стал бы решением агента, а не его.
            precondition: [{ aspect: 'orbis/assignment', field: 'may_close', in: [true] }],
            // Уходя из waiting — снимаем waiting_for (конвенция среза, как в подметании):
            // вопрос прошлого чекпойнта рядом с `done` читался бы как незакрытый.
            aspects: { status: 'done', waiting_for: null },
          }
        : { aspects: { status: 'waiting', waiting_for: input.report } },
    expected: ['waiting', 'done'],
  });
}

/**
 * Закрытие прогона рутины исходом — ВНУТРЕННИЙ вызов раннера (V1.4), а не тул.
 *
 * Тулом ему быть нечем: за рутинным прогоном стоит не внешний агент, который отчитается
 * сам, а наш же раннер, и итог он подводит в том числе тогда, когда модель кончилась
 * отказом или дедлайном (`failed`) — то есть когда звать её уже некого.
 *
 * Идёт через тот же `closeRun`, что глаголы, а не мимо: предусловие «прогон всё ещё мой
 * и всё ещё идёт», ключ идемпотентности и подмена ответа на replay обязаны быть теми же —
 * иначе ретрай тика закрывал бы один прогон дважды и второй раз врал бы про исход.
 */
export async function closeRoutineRun(
  ctx: VerbCtx,
  args: {
    runId: string;
    outcome: 'finished' | 'failed';
    report?: string;
    failNote?: string;
    usage?: RunUsageInput;
    /**
     * Судьба предложения (Задача 8) кладётся ТЕМ ЖЕ патчем, что исход: два патча дали бы
     * миг «прогон закрыт, а предложения при нём нет» — ровно то состояние, по которому
     * экран рутины решает, ждёт ли она ответа владельца.
     */
    proposal?: { pending_id: string; status: 'pending' };
    id?: string;
  },
): Promise<ToolDispatchResult> {
  if (ctx.subject.kind !== 'routine') {
    // Fail-closed: у грантового прогона своя пара глаголов, и его закрытие обязано вести
    // тикет (С8). Молча закрыть его здесь значило бы оставить тикет висеть in_progress.
    return err('VALIDATION', 'closeRoutineRun закрывает только прогон рутины (V1.4)', {
      run_id: args.runId,
    });
  }
  // Финальная сверка пачки (ОЧ.6): список единиц раннер ведёт в памяти, но истина о них —
  // в ленте, и только она знает, что владелец успел решить, пока прогон работал.
  const undecided = await hasOpenUnits(ctx, args.runId);
  return closeRun(ctx, {
    verb: 'closeRoutineRun',
    run_id: args.runId,
    ...(args.id !== undefined && { id: args.id }),
    ...(args.usage !== undefined && { usage: args.usage }),
    terminalTail: 'итог не принимается',
    outcome: args.outcome,
    runPatch: () => ({
      outcome: args.outcome,
      ...(args.report !== undefined && { report: args.report }),
      ...(args.failNote !== undefined && { fail_note: args.failNote }),
      ...(args.proposal !== undefined && { proposal: args.proposal }),
      // Флажок пачки — тем же патчем и по тому же доводу, что судьба предложения выше.
      // Пишется ТОЛЬКО `true`: «нерешённого нет» и «пачки не было» здесь одно и то же
      // событие, а `false` на аспекте значит «пачка была и разобрана» — это уже запись
      // процедур решения и гашения, а не закрытия прогона.
      ...(undecided && { undecided: true }),
    }),
  });
}
