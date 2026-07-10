// packages/shared/src/contracts/budget.ts
// Wire-контракты Budget-агрегатов (Task A6, 03-budget §2.4, §3.1) — общий словарь
// tRPC-роутера budget, LLM/MCP-тула budget_status и web-клиента (слайс 2).
// Все суммы — decimal-строки (01-arch §3.3); формулы считает ТОЛЬКО сервер
// (aggregates.ts), клиент отображает готовые значения.
import { z } from 'zod';
import { entitySchema } from '../schemas/entity';

const decimal = z.string().regex(/^-?\d+(\.\d+)?$/, 'decimal-строка');
const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'ISO date YYYY-MM-DD');
/** Месяц Overview (§3.1): заголовок периода с переключателем [◀ месяц ▶]. */
export const monthString = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'месяц YYYY-MM');

/**
 * Статус конверта (§2.4, §2.9): формулы посчитаны сервером; dailyPace = null вне
 * активного периода И при remaining < 0 — UI показывает «—/день» / подписи фаз §2.9.
 */
export const envelopeStatusSchema = z.object({
  envelope: entitySchema, // сущность конверта (orbis/budget)
  category: z.object({
    id: z.string().uuid(),
    title: z.string(),
    icon: z.string().nullable(),
    color: z.string().nullable(),
  }),
  spent: decimal, // §2.2: факт-расходы валюты конверта до сегодня
  effectiveLimit: decimal, // limit + carryover (§2.4)
  remaining: decimal, // effectiveLimit − spent
  dailyPace: decimal.nullable(), // remaining / дней до конца периода включительно
  phase: z.enum(['upcoming', 'active', 'closed']), // §2.9: сегодня до/в/после периода
});

/** Состав Overview (§3.1): баланс, конверты, прогнозы, Unbudgeted, бейдж §6.1. */
export const budgetOverviewSchema = z.object({
  period: z.object({ start: dateString, end: dateString }), // запрошенный месяц
  balance: z.object({ income: decimal, expense: decimal, balance: decimal }), // §2.5
  envelopes: z.array(envelopeStatusSchema), // месячные + произвольные, пересекающие месяц
  // Coming up — материализованные recurring-инстансы на 14 дней вперёд (§2.8)
  comingUp: z.array(
    z.object({
      entity: entitySchema,
      occurredOn: dateString,
      amount: decimal,
      direction: z.string(),
    }),
  ),
  // Planned — ручные запланированные покупки (§2.7; без derived_from)
  planned: z.array(z.object({ entity: entitySchema, amount: decimal, categoryTitle: z.string() })),
  // Unbudgeted — категории с фактическими тратами периода без конверта (§2.3 шаг 5)
  unbudgeted: z.array(
    z.object({
      category: z.object({ id: z.string().uuid(), title: z.string(), icon: z.string().nullable() }),
      total: decimal,
    }),
  ),
  alertCount: z.number().int(), // конверты spent > 85% × effectiveLimit (§6.1)
});

/** Точка мини-тренда категории (§3.2): месяц, spent конвертов, суммарный limit. */
export const categoryTrendPointSchema = z.object({
  period: monthString,
  spent: decimal,
  limit: decimal.nullable(), // null — в этом месяце конверта не было
});

// --- входы процедур tRPC-роутера budget ------------------------------------

export const budgetOverviewInput = z.object({ month: monthString }).strict();
export const categoryTrendInput = z
  .object({ categoryId: z.string().uuid(), months: z.number().int().min(1).max(24) })
  .strict();
export const envelopeForCategoryInput = z
  .object({ categoryId: z.string().uuid(), date: dateString })
  .strict();

// --- тул budget_status (LLM/MCP, §4.3/§4.5/§4.7) ----------------------------

/** Вход тула budget_status: месяц опционален — дефолт «текущий месяц пользователя». */
export const budgetStatusInput = z.object({ month: monthString.optional() }).strict();

/**
 * Результат budget_status: BudgetOverview + spend_class категорий (§4.3 — расчёт
 * «могу позволить?» требует классификацию fixed/discretionary; null = не классифицирована,
 * молча в расчёт не включается — модель обязана явно попросить классификацию).
 */
export const budgetStatusResultSchema = budgetOverviewSchema.extend({
  categories: z.array(
    z.object({
      id: z.string().uuid(),
      title: z.string(),
      spendClass: z.enum(['fixed', 'discretionary']).nullable(),
    }),
  ),
});

export type EnvelopeStatus = z.infer<typeof envelopeStatusSchema>;
export type BudgetOverview = z.infer<typeof budgetOverviewSchema>;
export type CategoryTrendPoint = z.infer<typeof categoryTrendPointSchema>;
export type BudgetOverviewInput = z.infer<typeof budgetOverviewInput>;
export type CategoryTrendInput = z.infer<typeof categoryTrendInput>;
export type EnvelopeForCategoryInput = z.infer<typeof envelopeForCategoryInput>;
export type BudgetStatusInput = z.infer<typeof budgetStatusInput>;
export type BudgetStatusResult = z.infer<typeof budgetStatusResultSchema>;
