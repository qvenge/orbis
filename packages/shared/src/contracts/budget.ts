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
/** Бейдж вкладки Budget (§6.1): month опционален — текущий месяц пользователя. */
export const budgetAlertCountInput = z.object({ month: monthString.optional() }).strict();
export const categoryTrendInput = z
  .object({ categoryId: z.string().uuid(), months: z.number().int().min(1).max(24) })
  .strict();
export const envelopeForCategoryInput = z
  .object({ categoryId: z.string().uuid(), date: dateString })
  .strict();

// --- Rollover (§2.6, §3.5, Task A7) ------------------------------------------

const nonNegativeDecimal = z.string().regex(/^\d+(\.\d+)?$/, 'неотрицательная decimal-строка');

/**
 * Строка превью rollover (§3.5): категория с месячным конвертом прошлого календарного
 * месяца без конверта-преемника в целевом ЛИБО (когда история есть) категория с
 * фактическими тратами прошлого месяца без конверта. Произвольные периоды (§2.9)
 * не участвуют. Всё в defaultCurrency (валютная граница — как categoryTrend, §5).
 */
export const rolloverPreviewRowSchema = z.object({
  categoryId: z.string().uuid(),
  categoryTitle: z.string(),
  categoryIcon: z.string().nullable(),
  prevSpent: decimal, // факт закрытого месячного конверта прошлого периода (§2.2)
  carryover: decimal, // remaining прошлого периода (§2.6), включая отрицательный
  suggestedLimit: decimal, // limit прошлого конверта; без истории лимита — spent вверх до 100
});

export const rolloverPreviewSchema = z.object({
  month: monthString, // целевой (новый) месяц
  rows: z.array(rolloverPreviewRowSchema),
  needsSetup: z.boolean(), // первый месяц без истории (§3.5): rows пуст, есть траты
});

export const rolloverPreviewInput = z.object({ month: monthString }).strict();

/** Вход мутации rollover: подтверждённые пользователем лимиты/carryover (§3.5). */
export const rolloverInput = z
  .object({
    month: monthString,
    rows: z
      .array(
        z
          .object({
            categoryId: z.string().uuid(),
            limit: nonNegativeDecimal, // как orbis/budget.limit — отрицательный невалиден
            carryover: decimal, // может быть отрицательным (§2.6) или обнулённым
          })
          .strict(),
      )
      .min(1),
    batchId: z.string().uuid(), // идемпотентность batch_execute (§7.8) — id от клиента
  })
  .strict();

/** Результат rollover: один action = batchId, Undo откатывает всю группу (§3.5). */
export const rolloverResultSchema = z.object({
  actionId: z.string().uuid(),
  envelopeIds: z.array(z.string().uuid()),
  idempotentReplay: z.boolean(),
});

// --- Plan → fact (§2.7, §7.6, Task A8): перевод planned-покупки в факт одним batch --

/**
 * Вход подтверждения покупки (§2.7): перевод РУЧНОЙ planned-покупки в факт одним batch.
 * occurredOn — фактическая дата (редактируема, default «сегодня» ставит UI; будущая
 * дата валидна). batchId — идемпотентность и Undo всей группы (§7.8): один action = batchId.
 */
export const confirmPurchaseInput = z
  .object({
    entityId: z.string().uuid(),
    occurredOn: dateString,
    batchId: z.string().uuid(),
  })
  .strict();

/** Результат: один action = batchId; Undo восстанавливает план и прежнюю привязку (§2.7). */
export const confirmPurchaseResultSchema = z.object({
  actionId: z.string().uuid(),
  idempotentReplay: z.boolean(),
});

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
export type BudgetAlertCountInput = z.infer<typeof budgetAlertCountInput>;
export type CategoryTrendInput = z.infer<typeof categoryTrendInput>;
export type EnvelopeForCategoryInput = z.infer<typeof envelopeForCategoryInput>;
export type BudgetStatusInput = z.infer<typeof budgetStatusInput>;
export type BudgetStatusResult = z.infer<typeof budgetStatusResultSchema>;
export type RolloverPreview = z.infer<typeof rolloverPreviewSchema>;
export type RolloverPreviewInput = z.infer<typeof rolloverPreviewInput>;
export type RolloverInput = z.infer<typeof rolloverInput>;
export type RolloverResult = z.infer<typeof rolloverResultSchema>;
export type ConfirmPurchaseInput = z.infer<typeof confirmPurchaseInput>;
export type ConfirmPurchaseResult = z.infer<typeof confirmPurchaseResultSchema>;
