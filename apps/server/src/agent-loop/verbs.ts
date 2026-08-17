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
  type ClaimTaskInput,
  type ClaimTaskResult,
  checkpointInput,
  claimTaskInput,
  finishInput,
  type MyQueueResult,
  myQueueInput,
  newId,
  type QueueTicket,
  runStepInput,
  type TaskStatus,
} from '@orbis/shared';
import type { z } from 'zod';
import type { Db } from '../db/client';
import { withIdentity } from '../db/with-identity';
import { ExecError } from '../errors';
import { execute } from '../executor/executor';
import type { JournalSink, WireEntity } from '../executor/types';
import type { GrantRef } from '../oauth/grants';
import type { ToolDispatchResult } from '../tools/dispatch';
import type { AGENT_VERB_NAMES } from '../tools/registry';
import { assignedTickets, parentProject, runSummary, runsOfTicket, ticketById } from './queries';
import { sweepStaleRuns } from './sweep';

export type AgentVerbName = (typeof AGENT_VERB_NAMES)[number];

/**
 * Контекст исполнения глагола. `grant` не опционален: прогон адресуется КОНКРЕТНОМУ
 * доступу (С2) — глагол без гранта не к кому отнести, и вызов без него диспатч отбивает
 * гейтом `agentOnly` ещё до этого модуля.
 */
export type VerbCtx = {
  db: Db;
  ownerId: string;
  grant: GrantRef;
  clock: () => Date;
  sink: JournalSink;
};

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

export async function runAgentVerb(
  ctx: VerbCtx,
  name: AgentVerbName,
  input: unknown,
): Promise<ToolDispatchResult> {
  switch (name) {
    case 'orbis_my_queue':
      // Разбор ради fail-closed на лишних полях; своего содержимого у envelope нет
      narrow(myQueueInput, input, name);
      return myQueue(ctx);
    case 'orbis_claim_task':
      return claimTask(ctx, narrow(claimTaskInput, input, name));
    // Глаголы II (Задача 11): дефы в реестре уже есть — иначе агент не увидел бы круг
    // целиком, а парность zod↔JSON Schema проверялась бы по частям. До реализации —
    // честный структурный отказ, а не тихий успех.
    case 'orbis_run_step':
    case 'orbis_checkpoint':
    case 'orbis_finish':
      return err('VALIDATION', `глагол «${name}» ещё не реализован`, { tool: name });
  }
}

// ---------------------------------------------------------------------------
// orbis_my_queue — что мне назначено; по дороге подметает зависшие прогоны (С6)
// ---------------------------------------------------------------------------

async function myQueue(ctx: VerbCtx): Promise<ToolDispatchResult> {
  // Подметание ПЕРЕД выборкой, а не после: тикет, чей прогон только что признан
  // брошенным, обязан приехать агенту уже свободным — иначе он увидит его
  // `in_progress` и уйдёт ни с чем ровно в тот момент, когда работа освободилась.
  const { swept } = await sweepStaleRuns(ctx.db, {
    ownerId: ctx.ownerId,
    actorKind: 'agent',
    actorGrantId: ctx.grant.id,
    clock: ctx.clock,
  });

  const tickets = await withIdentity(ctx.db, ctx.ownerId, async (tx) => {
    const rows = await assignedTickets(tx, ctx.grant.id);
    const out: QueueTicket[] = [];
    for (const row of rows) {
      const task = row.aspects['orbis/task'] ?? {};
      const status = task.status as TaskStatus;
      const project = await parentProject(tx, row.id);
      const runs = await runsOfTicket(tx, row.id);
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

async function claimTask(ctx: VerbCtx, input: ClaimTaskInput): Promise<ToolDispatchResult> {
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
          { aspect: 'orbis/assignment', field: 'grant_id', in: [ctx.grant.id] },
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
            grant_id: ctx.grant.id,
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
      actorKind: 'agent',
      source: 'mcp',
      actorGrantId: ctx.grant.id,
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
  const ticketWire = r.results[0] as WireEntity;
  const runWire = r.results[1] as WireEntity;
  const actualRunId = runWire.id;

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

  const history = await withIdentity(ctx.db, ctx.ownerId, async (tx) => {
    const runs = await runsOfTicket(tx, ticket.id);
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
