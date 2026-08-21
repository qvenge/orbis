// Нормативное содержание схем — PRD 01 §3.1–§3.7 (поля, типы, Req, enum-порядок).
// JSON Schema реестра генерируется отсюда (единый источник, решение 7 плана 1a);
// условная обязательность occurred_on (§3.3) — доменный инвариант executor'а, не схема.
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { AspectId } from '../constants';
import { HHMM_RE, WEEKDAYS } from '../date';

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'ISO date YYYY-MM-DD');
const timestampString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/, 'ISO 8601 timestamp');
/**
 * Денежные decimal-строки (§3.3): base-10 без экспоненты. Знаковость — В ПАТТЕРНАХ,
 * а не в .refine: refine не попадает в сгенерированную JSON Schema, а стадия 2
 * executor'а валидирует через ajv ПО РЕЕСТРУ (решение 7) — реестр обязан нести знак сам.
 */
export const decimalString = z.string().regex(/^-?\d+(\.\d+)?$/, 'decimal-строка');
/**
 * Строго > 0: без минуса и не «все нули»; чисто строковая проверка, без IEEE-754.
 * ВНИМАНИЕ: negative lookahead `(?!…)` лежит ВНЕ interoperable-subset JSON Schema
 * draft-07 (регэкспы там не гарантируют lookahead). Для нашего валидатора это корректно
 * — ajv компилирует паттерн движком ECMA-262, где lookahead поддержан. Но при потребителе
 * сгенерированного реестра на не-ECMA-движке (RE2/Go — без lookahead) паттерн НЕ
 * скомпилируется. Учесть при экспорте JSON Schema во внешние рантаймы (1b MCP и далее).
 */
const positiveDecimal = z
  .string()
  .regex(/^(?!0+(\.0+)?$)\d+(\.\d+)?$/, 'строго положительная decimal-строка');
/** ≥ 0: без минуса ('-0' отклоняется как неканоническая форма — осознанно). */
const nonNegativeDecimal = z.string().regex(/^\d+(\.\d+)?$/, 'неотрицательная decimal-строка');

export const scheduleAspectSchema = z
  .object({
    start_at: timestampString,
    end_at: timestampString.optional(),
    duration_min: z.number().int().positive().optional(),
    all_day: z.boolean().optional(),
    recurrence: z
      .object({
        freq: z.enum(['daily', 'weekly', 'monthly']),
        interval: z.number().int().positive(),
        byweekday: z.array(z.string()).optional(),
        until: dateString.optional(),
      })
      .strict()
      .optional(),
    location: z.string().optional(),
    timezone: z.string().optional(),
  })
  .strict();

export const taskAspectSchema = z
  .object({
    status: z.enum(['inbox', 'planned', 'in_progress', 'waiting', 'done', 'cancelled']),
    priority: z.enum(['low', 'medium', 'high']).optional(),
    due_date: dateString.optional(),
    completed_at: timestampString.optional(),
    effort_min: z.number().int().positive().optional(),
    waiting_for: z.string().optional(),
  })
  .strict();

export const financialAspectSchema = z
  .object({
    amount: positiveDecimal,
    currency: z.string().length(3).optional(),
    direction: z.enum(['income', 'expense']),
    category_ref: z.string().uuid(),
    occurred_on: dateString.optional(), // условная обязательность — инвариант §3.3 в executor'е
    planned: z.boolean().optional(),
    recurring: z.boolean().optional(),
    payment_method: z.string().optional(),
    counterparty: z.string().optional(),
    // Стабильный ID операции из выписки банка (C2b): пишет ТОЛЬКО CSV-импорт, совпавший
    // ID закрывает пункт 3 дедуп-критерия 03-budget §3.4.1 независимо от текста.
    // Без регекспа формата (у банков он разный); max 128 — защита JSONB, не бизнес-правило.
    bank_txn_id: z.string().min(1).max(128).optional(),
  })
  .strict();

export const noteAspectSchema = z
  .object({
    content_type: z.enum(['markdown', 'plain', 'checklist']).optional(),
    pinned: z.boolean().optional(),
  })
  .strict();

export const budgetAspectSchema = z
  .object({
    category_ref: z.string().uuid(),
    limit: nonNegativeDecimal,
    currency: z.string().length(3).optional(),
    period_start: dateString,
    period_end: dateString,
    carryover: decimalString.optional(),
  })
  .strict();

export const categoryAspectSchema = z
  .object({
    icon: z.string().optional(),
    color: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .optional(),
    aliases: z.array(z.string()).optional(),
    spend_class: z.enum(['fixed', 'discretionary']).optional(),
  })
  .strict();

export const memoryAspectSchema = z
  .object({
    kind: z.enum(['fact', 'rule']),
    scope: z.string().optional(),
  })
  .strict();

/**
 * Цель с измеримым прогрессом (01 §11.3). Прогресс считает СЕРВЕР (E2), обходя граф по
 * `progress_source`; `current_value` — кэш результата (правило 3 §10), не пользовательский ввод.
 *
 * `progress_source` — дискриминированное объединение по `aggregate`, а НЕ объект с `.refine`:
 * правило «field обязателен для sum и latest» обязано дожить до ajv, который валидирует ПО
 * РЕЕСТРУ (решение 7). Проверено пробоем: refine из JSON Schema исчезает бесследно и
 * {aggregate:'sum'} без field прод принял бы; объединение переживает генерацию как `anyOf`
 * с разными `required` и в strict-режиме компилируется. Та же причина, что у знаковости денег.
 */
export const goalAspectSchema = z
  .object({
    progress_source: z.discriminatedUnion('aggregate', [
      // count считает СУЩНОСТИ, поле ему не нужно: в своей ветке оно запрещено (strict)
      z.object({ query: z.string().min(1), aggregate: z.literal('count') }).strict(),
      // sum складывает, latest берёт последнее — обоим нужно, ЧТО именно
      z
        .object({
          query: z.string().min(1),
          aggregate: z.enum(['sum', 'latest']),
          field: z.string().min(1),
        })
        .strict(),
    ]),
    // Строго > 0: E2 делит на него (доля прогресса), ноль и минус смысла не имеют
    target_value: positiveDecimal,
    current_value: nonNegativeDecimal.optional(), // КЭШ: пишет сервер, не пользователь
    unit: z.string().min(1).optional(), // пустая строка приехала бы хвостом за числом
  })
  .strict();

// ─── ADE-срез 1 (спека 2026-08-14, С4) ────────────────────────────────────────
// Поле жизненного цикла названо `stage`, а не `status`: второе поле `status` в реестре сделало бы
// каждый запрос `status=…` без `aspect=` неоднозначным (query/parse.ts resolveField), включая
// сохранённые владельцем блоки. То же — `outcome` у прогона.
export const projectAspectSchema = z
  .object({ stage: z.enum(['active', 'paused', 'done']) })
  .strict();

// Кодовая специфика отдельно от общего понятия проекта (решение владельца 2026-08-17, D35).
export const repoAspectSchema = z
  .object({ url: z.string().min(1).max(512), default_branch: z.string().min(1).max(128) })
  .strict();

// Плоский объект вместо discriminatedUnion: каталог грамматики читает `properties` верхнего
// уровня, у oneOf их нет — поля стали бы невидимы для query-блоков. Условие
// «executor=agent ⇒ grant_id живого гранта владельца» держит инвариант executor'а
// (assertAssignment), потому что .refine исчезает при генерации JSON Schema, а валидирует ajv.
export const assignmentAspectSchema = z
  .object({
    executor: z.enum(['human', 'agent']),
    grant_id: z.string().uuid().optional(), // agent_grants.id; выставляет владелец, модель не выдумывает
    assignee: z.string().min(1).max(200).optional(), // executor=human: кто
    may_close: z.boolean().optional(), // отсутствует = false (С8): ajv default'ы не применяет
  })
  .strict();

/**
 * Исходы прогона. Первые четыре — ADE-срез 1 (тикетный прогон); V1 добавляет три:
 * `failed` — прогон сорвался (провайдер, дедлайн, лимит, внутренняя ошибка; причина в
 * fail_note), `answered` — владелец ответил на чекпойнт (и рутинного прогона, и тикетного —
 * прогон закрыт ответом, а не отчётом), `stale` — неотвеченный ВОПРОС (checkpoint) снят
 * новым прогоном рутины (V1.8). Судьба ПРЕДЛОЖЕНИЯ живёт не здесь, а в `proposal.status`
 * (`superseded`/`stale`): прогон с предложением остаётся `finished`.
 */
export const RUN_OUTCOMES = [
  'running',
  'checkpoint',
  'finished',
  'abandoned',
  'failed',
  'answered',
  'stale',
] as const;
const runStepSchema = z
  .object({
    seq: z.number().int().positive(),
    at: timestampString,
    summary: z.string().min(1).max(500),
    external: z.boolean(), // «тронул внешнее»: ветка, файлы, сеть — вне Orbis (С5, С6)
    action_id: z.string().uuid().optional(), // action §7.8 этого шага (= batchId вызова)
  })
  .strict();
const runUsageSchema = z
  .object({
    input_tokens: z.number().int().nonnegative().optional(),
    output_tokens: z.number().int().nonnegative().optional(),
    cost_usd: z.number().nonnegative().optional(),
  })
  .strict();
/** Статусы предложения рутины (V1.1): решение владельца и две причины снятия. */
export const PROPOSAL_STATUSES = [
  'pending',
  'approved',
  'rejected',
  'superseded',
  'stale',
] as const;

export const agentRunAspectSchema = z
  .object({
    // Субъект прогона — РОВНО ОДНО из grant_id/routine_id (V1.4). Схемой это не выражается:
    // oneOf сделал бы поля невидимыми для каталога грамматики (тот читает properties верхнего
    // уровня), а .refine исчезает при генерации JSON Schema. Инвариант держит executor
    // (assertRunSubject) — единственный путь записи в граф.
    grant_id: z.string().uuid().optional(), // тикетный прогон: чьим доступом работает исполнитель
    routine_id: z.string().uuid().optional(), // рутинный прогон: чьё расписание его породило
    /** Слот расписания 'YYYY-MM-DDTЧЧ:ММ' в локальном времени владельца либо 'manual:<ISO>'. */
    bucket: z
      .string()
      .regex(/^(\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d|manual:\S+)$/, 'слот расписания рутины')
      .optional(),
    attempt: z.number().int().min(1).optional(), // номер попытки бакета (ретраи после failed)
    fail_note: z.string().max(2000).optional(), // почему прогон кончился failed
    /** Предложение режима propose: карточка на подтверждение и её судьба. */
    proposal: z
      .object({
        pending_id: z.string().uuid(),
        status: z.enum(PROPOSAL_STATUSES),
        decided_at: timestampString.optional(),
        // Расхождения предусловия, из-за которых предложение снято (V1.4): показываются
        // владельцу вместо «предусловие не выполнено» без объяснения.
        mismatches: z
          .array(
            z.object({ aspect: z.string(), field: z.string(), note: z.string().max(500) }).strict(),
          )
          .max(50)
          .optional(),
        // Ш1.8: предложение рождено правкой владельца — здесь id ИСХОДНОГО pending'а,
        // который эта правка погасила. Отдельного статуса «правлено» нет намеренно:
        // статус описывает судьбу ЖИВОГО предложения, а правка — его происхождение.
        // Поле опционально: прогоны до Ш1 его не несут, бэкфилла нет.
        edited_from: z.string().uuid().optional(),
      })
      .strict()
      .optional(),
    // D42 ОЧ.6: у прогона есть нерешённые единицы пачки (отложенные действия и вопросы).
    // Скаляр, а не массив деталей (D31): детали живут в треде, здесь — то, по чему бейдж и
    // смарт-лист фильтруют прогоны, а значит поле обязано быть на ВЕРХНЕМ уровне аспекта
    // (каталог грамматики читает properties верхнего уровня).
    // Снятие флажка — ЗАПИСЬ `false`, а НЕ удаление ключа: предиката «поля нет» у грамматики
    // §6 не существует, и разобранную пачку иначе нечем отличить запросом от неразобранной.
    undecided: z.boolean().optional(),
    project_id: z.string().uuid().optional(), // денормализация: `this` грамматики не достаёт внуков
    outcome: z.enum(RUN_OUTCOMES),
    started_at: timestampString,
    finished_at: timestampString.optional(),
    last_step_at: timestampString, // отметка живости = время последнего шага (С6)
    step_count: z.number().int().nonnegative(), // CAS-счётчик для конкурентных шагов + фильтруемая длина
    steps: z.array(runStepSchema).max(500),
    session_url: z.string().url().optional(),
    report: z.string().max(20000).optional(), // «готово, проверь» (С8)
    checkpoint: z
      .object({ question: z.string().min(1).max(4000), asked_at: timestampString })
      .strict()
      .optional(),
    reply: z
      .object({ text: z.string().min(1).max(4000), at: timestampString })
      .strict()
      .optional(), // ответ владельца
    usage: runUsageSchema.optional(),
    abandon_note: z.string().max(2000).optional(), // подметание С6
  })
  .strict();

// ─── V1 «Рутины» (спека 2026-08-18, V1.1) ─────────────────────────────────────
export const ROUTINE_STAGES = ['active', 'paused'] as const;
export const ROUTINE_MODES = ['propose', 'act'] as const;

/**
 * Рутина: «что делать» лежит в ТЕЛЕ сущности (как у заметки и проекта), здесь — только
 * расписание и права. Поле жизненного цикла названо `stage` в тон orbis/project: третье
 * `status` в реестре сделало бы `status=` без `aspect=` неоднозначным. Обратная сторона —
 * теперь `stage=` тоже неоднозначен (project + routine), поэтому запросы к рутинам всегда
 * пишутся с `aspect=orbis/routine`.
 */
export const routineAspectSchema = z
  .object({
    stage: z.enum(ROUTINE_STAGES),
    at: z.string().regex(HHMM_RE, 'время ЧЧ:ММ'), // локальное время владельца, не UTC
    days: z.array(z.enum(WEEKDAYS)).min(1).optional(), // поля нет = каждый день
    // Режим ОБЯЗАТЕЛЕН и без умолчания (V1.1): умолчание act раздавало бы право писать в
    // граф молча, умолчание propose — тихо разоружало бы уже заведённую act-рутину.
    mode: z.enum(ROUTINE_MODES),
    allowed_tools: z.array(z.string().min(1)).max(50).optional(), // имеет смысл только при mode=act
  })
  .strict();

/**
 * Реестр схем аспектов. Имя `orbis/entity` в него НЕ входит и входить не должно: оно
 * зарезервировано под предусловия по КОЛОНКАМ записи (`ENTITY_PSEUDO_ASPECT`,
 * server/executor/executor.ts) — аспекта с таким id нет, и появление его здесь сделало бы
 * псевдо-аспект настоящим, а предусловие `{aspect:'orbis/entity', field:'archived'}` —
 * двусмысленным (Minor Ф-4b-2 ревью Задачи 4b; сегодня это стережёт только соседний тест).
 */
export const ASPECT_SCHEMAS = {
  'orbis/schedule': scheduleAspectSchema,
  'orbis/task': taskAspectSchema,
  'orbis/financial': financialAspectSchema,
  'orbis/note': noteAspectSchema,
  'orbis/budget': budgetAspectSchema,
  'orbis/category': categoryAspectSchema,
  'orbis/memory': memoryAspectSchema,
  'orbis/goal': goalAspectSchema,
  'orbis/project': projectAspectSchema,
  'orbis/repo': repoAspectSchema,
  'orbis/assignment': assignmentAspectSchema,
  'orbis/agent-run': agentRunAspectSchema,
  'orbis/routine': routineAspectSchema,
} as const satisfies Record<AspectId, z.ZodTypeAny>;

export function aspectJsonSchema(id: AspectId): Record<string, unknown> {
  return zodToJsonSchema(ASPECT_SCHEMAS[id], { $refStrategy: 'none' }) as Record<string, unknown>;
}

export type ScheduleAspect = z.infer<typeof scheduleAspectSchema>;
export type TaskAspect = z.infer<typeof taskAspectSchema>;
export type FinancialAspect = z.infer<typeof financialAspectSchema>;
export type NoteAspect = z.infer<typeof noteAspectSchema>;
export type BudgetAspect = z.infer<typeof budgetAspectSchema>;
export type CategoryAspect = z.infer<typeof categoryAspectSchema>;
export type MemoryAspect = z.infer<typeof memoryAspectSchema>;
export type GoalAspect = z.infer<typeof goalAspectSchema>;
export type ProjectAspect = z.infer<typeof projectAspectSchema>;
export type RepoAspect = z.infer<typeof repoAspectSchema>;
export type AssignmentAspect = z.infer<typeof assignmentAspectSchema>;
export type AgentRunAspect = z.infer<typeof agentRunAspectSchema>;
export type AgentRunStep = z.infer<typeof runStepSchema>;
export type RoutineAspect = z.infer<typeof routineAspectSchema>;
