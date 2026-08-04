// Нормативное содержание схем — PRD 01 §3.1–§3.7 (поля, типы, Req, enum-порядок).
// JSON Schema реестра генерируется отсюда (единый источник, решение 7 плана 1a);
// условная обязательность occurred_on (§3.3) — доменный инвариант executor'а, не схема.
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { AspectId } from '../constants';

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
    unit: z.string().optional(),
  })
  .strict();

export const ASPECT_SCHEMAS = {
  'orbis/schedule': scheduleAspectSchema,
  'orbis/task': taskAspectSchema,
  'orbis/financial': financialAspectSchema,
  'orbis/note': noteAspectSchema,
  'orbis/budget': budgetAspectSchema,
  'orbis/category': categoryAspectSchema,
  'orbis/memory': memoryAspectSchema,
  'orbis/goal': goalAspectSchema,
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
