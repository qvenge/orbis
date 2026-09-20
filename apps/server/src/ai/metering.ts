// apps/server/src/ai/metering.ts
// Метеринг LLM-вызовов (§4.7 ai_usage, §8): upsert-инкремент строки
// (graph_id, date, model). Решение 8 плана 1b: запись — ВНЕ tx executor'а/цикла,
// отдельной короткой транзакцией ПОСЛЕ tool-цикла, суммой всех шагов.
// Таблица под RLS (owner_owns_row) — пишем под withIdentity владельца.
// День — календарный в UTC (§4.7); clock инжектируется тестами.
import { sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { aiUsage } from '../db/schema';
import { withIdentity } from '../db/with-identity';
import type { Identity } from '../identity';

/** Суммарный расход tool-цикла: input/output-токены и число вызовов провайдера. */
export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  requestCount: number;
}

/** День UTC (yyyy-mm-dd) для PK ai_usage — единственная точка форматирования даты. */
export function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Инкремент дневных счётчиков: INSERT … ON CONFLICT (graph_id, date, model)
 * DO UPDATE SET counter = ai_usage.counter + excluded.counter. Атомарно на уровне
 * PG — конкурентные вызовы не теряют инкременты. Ошибки НЕ глотает: решение
 * «сбой метеринга не ломает ответ пользователю» реализует вызывающий
 * (sendMessage: try/catch + console.error) — модуль остаётся честным примитивом.
 */
export async function recordUsage(
  db: Db,
  args: { identity: Identity; model: string; usage: UsageTotals; clock?: () => Date },
): Promise<void> {
  const date = utcDay((args.clock ?? (() => new Date()))());
  // Строка расхода — НА ГРАФ (В-Г-4): токены жжёт работа в графе, и в графе компании счёт
  // общий. Субъект ТАРИФА при этом — аккаунт (Р-КГ-6, entitlements.ts): это разные вещи.
  await withIdentity(db, args.identity, (tx) =>
    tx
      .insert(aiUsage)
      .values({
        graphId: args.identity.graph,
        date,
        model: args.model,
        inputTokens: args.usage.inputTokens,
        outputTokens: args.usage.outputTokens,
        requestCount: args.usage.requestCount,
      })
      .onConflictDoUpdate({
        target: [aiUsage.graphId, aiUsage.date, aiUsage.model],
        set: {
          inputTokens: sql`${aiUsage.inputTokens} + excluded.input_tokens`,
          outputTokens: sql`${aiUsage.outputTokens} + excluded.output_tokens`,
          requestCount: sql`${aiUsage.requestCount} + excluded.request_count`,
        },
      }),
  );
}
