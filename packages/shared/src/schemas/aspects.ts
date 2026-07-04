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
/** Денежная decimal-строка (§3.3): base-10 без экспоненты. */
export const decimalString = z.string().regex(/^-?\d+(\.\d+)?$/, 'decimal-строка');
const positiveDecimal = decimalString.refine(
  (v) => !v.startsWith('-') && Number.parseFloat(v) > 0,
  'строго положительная decimal-строка',
);
const nonNegativeDecimal = decimalString.refine((v) => !v.startsWith('-'), '>= 0');

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

export const ASPECT_SCHEMAS = {
  'orbis/schedule': scheduleAspectSchema,
  'orbis/task': taskAspectSchema,
  'orbis/financial': financialAspectSchema,
  'orbis/note': noteAspectSchema,
  'orbis/budget': budgetAspectSchema,
  'orbis/category': categoryAspectSchema,
  'orbis/memory': memoryAspectSchema,
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
