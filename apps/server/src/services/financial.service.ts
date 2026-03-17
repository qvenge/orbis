import { eq, and, sql, desc } from 'drizzle-orm';
import { entities, relations as relationsTable } from '../db/schema.ts';
import type { Database } from '../db/client.ts';
import { getMonthRange } from '../utils/date-range.ts';
import type { FinancialAspect } from '../utils/aspect-types.ts';

export async function computeFinancialSummary(db: Database, userId: string, year: number, month: number) {
  const { start: periodStart, end: periodEnd } = getMonthRange(year, month);

  const financialEntities = await db
    .select()
    .from(entities)
    .where(
      and(
        eq(entities.userId, userId),
        eq(entities.archived, false),
        sql`${entities.aspects} ? 'orbis/financial'`,
        sql`${entities.createdAt} >= ${periodStart.toISOString()}::timestamptz`,
        sql`${entities.createdAt} <= ${periodEnd.toISOString()}::timestamptz`,
      ),
    )
    .orderBy(desc(entities.createdAt));

  let totalIncome = 0;
  let totalExpenses = 0;
  const categoryTotals: Record<string, { income: number; expense: number }> = {};
  const envelopeCategories = new Set<string>();
  const dailyExpenses: Record<string, number> = {};

  const envelopes: Array<{
    entityId: string;
    title: string;
    category: string;
    limit: number;
    effectiveLimit: number;
    spent: number;
    remaining: number;
  }> = [];

  for (const entity of financialEntities) {
    const aspects = entity.aspects as Record<string, unknown>;
    const fin = aspects['orbis/financial'] as FinancialAspect | undefined;
    if (!fin || typeof fin.amount !== 'number') continue;

    const category = fin.category ?? 'other';
    const direction = fin.direction ?? 'expense';

    if (direction === 'budget') {
      const meta = (entity.meta ?? {}) as Record<string, unknown>;
      const carryover = typeof meta.carryover === 'number' ? meta.carryover : 0;
      envelopes.push({
        entityId: entity.id,
        title: entity.title,
        category,
        limit: fin.amount,
        effectiveLimit: fin.amount + carryover,
        spent: 0,
        remaining: fin.amount + carryover,
      });
      envelopeCategories.add(category);
    } else if (direction === 'income') {
      totalIncome += fin.amount;
      if (!categoryTotals[category]) categoryTotals[category] = { income: 0, expense: 0 };
      categoryTotals[category].income += fin.amount;
    } else {
      totalExpenses += fin.amount;
      if (!categoryTotals[category]) categoryTotals[category] = { income: 0, expense: 0 };
      categoryTotals[category].expense += fin.amount;
      const day = entity.createdAt.toISOString().slice(0, 10);
      dailyExpenses[day] = (dailyExpenses[day] ?? 0) + fin.amount;
    }
  }

  // Compute spent per envelope — match by category
  for (const env of envelopes) {
    const catTotal = categoryTotals[env.category];
    env.spent = catTotal?.expense ?? 0;
    env.remaining = env.effectiveLimit - env.spent;
  }

  // Also compute spent via parent relations for more accuracy
  if (envelopes.length > 0) {
    const envelopeIds = envelopes.map((e) => e.entityId);
    const childExpenses = await db
      .select({
        parentId: relationsTable.targetId,
        total: sql<number>`COALESCE(SUM((${entities.aspects}->'orbis/financial'->>'amount')::numeric), 0)`,
      })
      .from(relationsTable)
      .innerJoin(entities, eq(entities.id, relationsTable.sourceId))
      .where(
        and(
          sql`${relationsTable.targetId} = ANY(${envelopeIds})`,
          eq(relationsTable.relationType, 'parent'),
          sql`${entities.aspects}->'orbis/financial'->>'direction' = 'expense'`,
        ),
      )
      .groupBy(relationsTable.targetId);

    for (const row of childExpenses) {
      const env = envelopes.find((e) => e.entityId === row.parentId);
      if (env && row.total > 0) {
        if (row.total > env.spent) {
          env.spent = Number(row.total);
          env.remaining = env.effectiveLimit - env.spent;
        }
      }
    }
  }

  // Unbudgeted: expense categories without an envelope
  let unbudgetedTotal = 0;
  for (const [category, totals] of Object.entries(categoryTotals)) {
    if (!envelopeCategories.has(category) && totals.expense > 0) {
      unbudgetedTotal += totals.expense;
    }
  }

  // Category breakdown
  const categoryBreakdown = Object.entries(categoryTotals).flatMap(([category, totals]) => {
    const result: Array<{ category: string; total: number; direction: string }> = [];
    if (totals.income > 0) result.push({ category, total: totals.income, direction: 'income' });
    if (totals.expense > 0) result.push({ category, total: totals.expense, direction: 'expense' });
    return result;
  });

  // Build daily spending array for the period
  const daysInMonth = new Date(year, month, 0).getDate();
  const dailySpending: Array<{ date: string; amount: number }> = [];
  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    dailySpending.push({ date: dateStr, amount: dailyExpenses[dateStr] ?? 0 });
  }

  return {
    totalIncome,
    totalExpenses,
    balance: totalIncome - totalExpenses,
    envelopes,
    categoryBreakdown,
    unbudgetedTotal,
    dailySpending,
  };
}

export async function queryFinancialTransactions(
  db: Database,
  userId: string,
  input: { year: number; month: number; category?: string; direction?: string; search?: string; limit: number; offset: number },
) {
  const { start: periodStart, end: periodEnd } = getMonthRange(input.year, input.month);

  const conditions = [
    eq(entities.userId, userId),
    eq(entities.archived, false),
    sql`${entities.aspects} ? 'orbis/financial'`,
    sql`${entities.createdAt} >= ${periodStart.toISOString()}::timestamptz`,
    sql`${entities.createdAt} <= ${periodEnd.toISOString()}::timestamptz`,
    sql`${entities.aspects}->'orbis/financial'->>'direction' != 'budget'`,
  ];

  if (input.category) {
    conditions.push(sql`${entities.aspects}->'orbis/financial'->>'category' = ${input.category}`);
  }
  if (input.direction) {
    conditions.push(sql`${entities.aspects}->'orbis/financial'->>'direction' = ${input.direction}`);
  }
  if (input.search) {
    conditions.push(
      sql`(to_tsvector('simple', ${entities.title}) || to_tsvector('simple', ${entities.body})) @@ plainto_tsquery('simple', ${input.search})`,
    );
  }

  const items = await db
    .select()
    .from(entities)
    .where(and(...conditions))
    .orderBy(desc(entities.createdAt))
    .limit(input.limit)
    .offset(input.offset);

  return { items, total: items.length };
}

export async function getFinancialCategories(db: Database, userId: string) {
  const result = await db
    .select({
      category: sql<string>`DISTINCT ${entities.aspects}->'orbis/financial'->>'category'`,
    })
    .from(entities)
    .where(
      and(
        eq(entities.userId, userId),
        eq(entities.archived, false),
        sql`${entities.aspects} ? 'orbis/financial'`,
        sql`${entities.aspects}->'orbis/financial'->>'category' IS NOT NULL`,
      ),
    );

  return result.map((r) => r.category).filter(Boolean);
}
