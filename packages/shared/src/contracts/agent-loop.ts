// packages/shared/src/contracts/agent-loop.ts
// Контракт круга исполнителя (§9.3, ADE-срез 1): envelope-схемы глаголов и формы их
// ответов. Схемы живут здесь, рядом с остальными тул-контрактами (contracts/tools.ts),
// по той же причине: рукописные JSON Schema реестра (server/tools/registry.ts) обязаны
// быть ПАРНЫ им, и тест парности читает оба представления из одного места.
//
// Ответы (QueueTicket/RunSummary/…) — wire-формы, а не таблицы: их собирает сервер
// (server/agent-loop/verbs.ts) и отдаёт агенту по MCP. Тип здесь нужен обеим сторонам —
// серверу как контракт сборки, web-клиенту среза (экран прогонов) как форма чтения.
import { z } from 'zod';
import type { AgentRunAspect, AgentRunStep, TaskAspect } from '../schemas/aspects';

/** Статус тикета (`orbis/task.status`) — источник один, дублирующего enum здесь нет. */
export type TaskStatus = TaskAspect['status'];
/** Исход прогона (`orbis/agent-run.outcome`). */
export type RunOutcome = AgentRunAspect['outcome'];
/** Статус предложения рутины (`orbis/agent-run.proposal.status`, V1.1). */
export type ProposalStatus = NonNullable<AgentRunAspect['proposal']>['status'];

/**
 * Расход прогона (§9.3, С2): агент сообщает его сам — проверить его сервер не может,
 * поэтому все поля опциональны и ни одно не участвует в правилах.
 */
export const runUsageInput = z
  .object({
    input_tokens: z.number().int().nonnegative().optional(),
    output_tokens: z.number().int().nonnegative().optional(),
    cost_usd: z.number().nonnegative().optional(),
  })
  .strict();

/**
 * Очередь исполнителя: входа нет намеренно — «что назначено МНЕ» полностью задано
 * грантом вызова, и любой параметр здесь был бы способом спросить про чужое.
 */
export const myQueueInput = z.object({}).strict();

/**
 * Захват тикета. `id` — ключ идемпотентности вызова (= batchId action'а §7.8): повтор с
 * тем же id возвращает тот же прогон, а не заводит второй (С7). `session_url` — ссылка
 * на сессию агента, чтобы владелец мог посмотреть, что именно шло в работе.
 */
export const claimTaskInput = z
  .object({
    ticket_id: z.string().uuid(),
    id: z.string().uuid().optional(),
    session_url: z.string().url().optional(),
  })
  .strict();

/** Шаг прогона: короткая сводка + признак «тронул внешнее» (С5, С6). */
export const runStepInput = z
  .object({
    run_id: z.string().uuid(),
    summary: z.string().min(1).max(500),
    external: z.boolean().optional(),
    id: z.string().uuid().optional(),
  })
  .strict();

/** Чекпойнт: вопрос владельцу, прогон останавливается (С3). */
export const checkpointInput = z
  .object({
    run_id: z.string().uuid(),
    question: z.string().min(1).max(4000),
    usage: runUsageInput.optional(),
    session_url: z.string().url().optional(),
    id: z.string().uuid().optional(),
  })
  .strict();

/** Итог прогона: «готово, проверь» (С8) — тикет закрывает не агент. */
export const finishInput = z
  .object({
    run_id: z.string().uuid(),
    report: z.string().min(1).max(20000),
    usage: runUsageInput.optional(),
    session_url: z.string().url().optional(),
    id: z.string().uuid().optional(),
  })
  .strict();

export type RunUsageInput = z.infer<typeof runUsageInput>;
export type MyQueueInput = z.infer<typeof myQueueInput>;
export type ClaimTaskInput = z.infer<typeof claimTaskInput>;
export type RunStepInput = z.infer<typeof runStepInput>;
export type CheckpointInput = z.infer<typeof checkpointInput>;
export type FinishInput = z.infer<typeof finishInput>;

/**
 * Сводка прогона для агента и экранов: всё, что нужно понять «что было», без чтения
 * самой сущности прогона. Шаги обрезаны последними десятью — полный массив (до 500)
 * раздул бы каждый ответ очереди, а нужен он только на экране прогона.
 */
export interface RunSummary {
  id: string;
  outcome: RunOutcome;
  started_at: string;
  finished_at?: string;
  step_count: number;
  report?: string;
  checkpoint?: { question: string; asked_at: string };
  reply?: { text: string; at: string };
  abandon_note?: string;
  session_url?: string;
  /** Последние ≤10 шагов прогона (хвост `steps`). */
  last_steps: AgentRunStep[];
  // V1: рутинный прогон. Субъект и слот нужны истории самой рутины («что было вчера в 07:00»),
  // а fail_note и судьба предложения — единственный способ понять, почему ничего не изменилось.
  routine_id?: string;
  bucket?: string;
  attempt?: number;
  fail_note?: string;
  proposal?: { pending_id: string; status: ProposalStatus; decided_at?: string };
}

/** Строка очереди исполнителя: тикет + чей он проект + чем кончился прошлый прогон. */
export interface QueueTicket {
  id: string;
  title: string;
  status: TaskStatus;
  priority?: string;
  due_date?: string;
  /** Можно ли брать в работу прямо сейчас: статус ∈ {inbox, planned}. */
  claimable: boolean;
  project?: { id: string; title: string };
  last_run?: RunSummary;
}

/** Ответ `orbis_my_queue`: очередь + сколько прогонов подмели по дороге (С6). */
export interface MyQueueResult {
  tickets: QueueTicket[];
  swept: number;
}

/**
 * Ответ `orbis_claim_task` — всё для работы одним вызовом: задание, процесс проекта и
 * история прошлых прогонов (их отчёты, вопросы и ответы владельца).
 */
export interface ClaimTaskResult {
  run_id: string;
  action_id: string;
  ticket: { id: string; title: string; body: string; aspects: Record<string, unknown> };
  project: { id: string; title: string; body: string } | null;
  /** Тело проекта с разделом «Процесс» (С10); null — тикет вне проекта. */
  process: string | null;
  history: RunSummary[];
  /** true — повтор вызова с тем же `id`: работа не делалась заново (§7.8). */
  replayed: boolean;
}

/**
 * Ответ `orbis_run_step`. `step_count` возвращается не ради статистики: он же — признак,
 * что шаг лёг именно этим вызовом (конкурентные шаги сервер сериализует CAS'ом), а
 * `action_id` даёт владельцу адрес записи в журнале §7.8.
 */
export interface RunStepResult {
  run_id: string;
  step_count: number;
  action_id: string;
}

/**
 * Ответ `orbis_checkpoint`: прогон остановлен вопросом, тикет ушёл ждать владельца (С3).
 *
 * Пара ключей о тикете опциональна с V1: у прогона РУТИНЫ тикета нет по устройству (V1.4,
 * прогон — дитя рутины), и «этого не было» здесь выражается отсутствием ключа, а не
 * пустышкой — иначе внешний исполнитель читал бы `ticket_id: null` как потерянный тикет.
 */
export interface CheckpointResult {
  run_id: string;
  ticket_id?: string;
  ticket_status?: 'waiting';
  action_id: string;
}

/**
 * Ответ `orbis_finish`. `ticket_status` — 'waiting' («готово, проверь», С8) и лишь при
 * заранее выданном `may_close` — 'done': тикет закрывает не агент, а разрешение владельца.
 * Ключей о тикете нет у закрытия рутинного прогона (V1.4) — см. CheckpointResult.
 */
export interface FinishResult {
  run_id: string;
  ticket_id?: string;
  ticket_status?: 'waiting' | 'done';
  action_id: string;
}

// ---------------------------------------------------------------------------
// Предложение рутины (V1.6, V1.7) — терминальный глагол режима `propose`
// ---------------------------------------------------------------------------

/**
 * Что рутина вправе ПРЕДЛОЖИТЬ (V1.6). Форма сужена относительно реестра сознательно.
 *
 * `attach_*` здесь нет, хотя аспект он вешает тот же, что `entity_update`: имя attach-тула
 * зависит от реестра аспектов владельца (§7.6), то есть форма предложения зависела бы от
 * содержимого его базы — а предложение лежит в треде до решения владельца и обязано
 * пережить любую правку реестра. Всё то же выражается `entity_update` с `aspects`.
 *
 * `batch_execute` нет по той же причине, по какой он закрыт рутине вовсе (registry.ts):
 * список операций у предложения СВОЙ, и обёртка провозила бы внутрь непроверенное.
 * `thread_post` и глаголы — не правки графа: их нечего откатывать и не о чем спрашивать.
 */
export const PROPOSAL_ALLOWED_TOOLS = [
  'entity_create',
  'entity_update',
  'relation_create',
  'relation_delete',
] as const;
export type ProposalAllowedTool = (typeof PROPOSAL_ALLOWED_TOOLS)[number];

/**
 * Одна операция предложения. `input` здесь намеренно `unknown`: его разбирает СТРОГАЯ
 * схема своего тула уже на сервере (routines/propose.ts) — валидировать его дважды и
 * по-разному значило бы завести второй контракт тула, который разъедется с первым.
 */
export const proposeOperation = z
  .object({ tool: z.enum(PROPOSAL_ALLOWED_TOOLS), input: z.unknown() })
  .strict();

/**
 * Вход `orbis_propose` (V1.6). `explanation` ОБЯЗАТЕЛЕН и не имеет умолчания: предложение
 * читает владелец, и без прозы «зачем» список операций — это просьба довериться молча.
 * Потолок 50 операций — тот же, что у раннера (server/routines/constants.ts).
 */
export const proposeInput = z
  .object({
    run_id: z.string().uuid(),
    explanation: z.string().min(1).max(4000),
    operations: z.array(proposeOperation).min(1).max(50),
    id: z.string().uuid().optional(), // ключ идемпотентности вызова (= batchId §7.8)
  })
  .strict();

export type ProposeOperation = z.infer<typeof proposeOperation>;
export type ProposeInput = z.infer<typeof proposeInput>;

/**
 * Ответ `orbis_propose`: прогон закрыт, предложение лежит в треде рутины и ждёт владельца.
 * `replayed` — повтор вызова с тем же `id`: второго предложения не создано (§7.8).
 */
export interface ProposeResult {
  run_id: string;
  pending_id: string;
  operations: number;
  replayed: boolean;
}
