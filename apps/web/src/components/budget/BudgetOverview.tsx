import { TrendingUp, TrendingDown, AlertTriangle } from 'lucide-react';
import { trpc } from '../../lib/trpc.ts';
import { useSettingsStore } from '../../stores/settings.ts';
import { EnvelopeCard } from './EnvelopeCard.tsx';
import { DonutChart } from '../common/DonutChart.tsx';
import { MiniBarChart } from '../common/MiniBarChart.tsx';

interface BudgetOverviewProps {
  year: number;
  month: number;
}

const CATEGORY_COLORS = [
  '#6366f1', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6',
  '#ec4899', '#06b6d4', '#f97316', '#14b8a6', '#a855f7',
];

function formatAmount(amount: number, currency: string): string {
  return new Intl.NumberFormat('ru-RU', {
    style: 'currency',
    currency,
    maximumFractionDigits: 0,
  }).format(amount);
}

export function BudgetOverview({ year, month }: BudgetOverviewProps) {
  const { settings } = useSettingsStore();
  const currency = (settings?.defaultCurrency as string) ?? 'RUB';

  const { data, isLoading } = trpc.entity.financialSummary.useQuery(
    { year, month },
    { staleTime: 30_000 },
  );

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16">
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-border-light border-t-primary" />
      </div>
    );
  }

  if (!data) {
    return (
      <div className="flex flex-col items-center py-16 text-center">
        <p className="text-sm text-text-secondary">No financial data for this month</p>
        <p className="mt-1 text-xs text-text-muted">Log expenses via Chat or the Quick Add bar below</p>
      </div>
    );
  }

  const { totalIncome, totalExpenses, balance, envelopes, unbudgetedTotal } = data;
  const hasData = totalIncome > 0 || totalExpenses > 0;

  if (!hasData) {
    return (
      <div className="flex flex-col items-center py-16 text-center">
        <p className="text-sm text-text-secondary">No transactions this month</p>
        <p className="mt-1 text-xs text-text-muted">Log expenses via Chat or the Quick Add bar below</p>
      </div>
    );
  }

  const expenseCategories = data.categoryBreakdown
    .filter((c) => c.direction === 'expense')
    .sort((a, b) => b.total - a.total);

  const donutSegments = expenseCategories.map((cat, i) => ({
    label: cat.category,
    value: cat.total,
    color: CATEGORY_COLORS[i % CATEGORY_COLORS.length],
  }));

  const dailyBars = (data.dailySpending ?? [])
    .filter((d) => d.amount > 0 || new Date(d.date) <= new Date())
    .slice(-14)
    .map((d) => ({
      label: String(new Date(d.date).getDate()),
      value: d.amount,
    }));

  return (
    <div className="space-y-4 p-4">
      {/* Balance card */}
      <div className="rounded-lg border border-border bg-surface-dim p-4">
        <p className={`text-2xl font-bold ${balance >= 0 ? 'text-success' : 'text-danger'}`}>
          {balance >= 0 ? '+' : ''}{formatAmount(balance, currency)}
        </p>
        <div className="mt-2 flex items-center gap-4">
          <div className="flex items-center gap-1.5">
            <TrendingUp className="h-3.5 w-3.5 text-success" />
            <span className="text-xs text-text-secondary">Income: {formatAmount(totalIncome, currency)}</span>
          </div>
          <div className="flex items-center gap-1.5">
            <TrendingDown className="h-3.5 w-3.5 text-danger" />
            <span className="text-xs text-text-secondary">Expenses: {formatAmount(totalExpenses, currency)}</span>
          </div>
        </div>
      </div>

      {/* Category donut + Daily spending — side by side */}
      {(donutSegments.length > 0 || dailyBars.length > 0) && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {/* Donut chart */}
          {donutSegments.length > 0 && (
            <div className="rounded-lg border border-border bg-surface-dim p-3">
              <p className="mb-3 text-[11px] font-medium uppercase tracking-wider text-text-muted">
                By Category
              </p>
              <div className="flex justify-center">
                <DonutChart
                  segments={donutSegments}
                  size={110}
                  strokeWidth={12}
                  formatTotal={(v) => formatAmount(v, currency)}
                />
              </div>
            </div>
          )}

          {/* Daily spending bar chart */}
          {dailyBars.length > 0 && (
            <div className="rounded-lg border border-border bg-surface-dim p-3">
              <p className="mb-3 text-[11px] font-medium uppercase tracking-wider text-text-muted">
                Daily Spending
              </p>
              <MiniBarChart
                data={dailyBars}
                color="var(--color-danger)"
                height={130}
                formatValue={(v) => formatAmount(v, currency)}
              />
            </div>
          )}
        </div>
      )}

      {/* Envelopes */}
      {envelopes.length > 0 && (
        <div>
          <p className="mb-2 text-[11px] font-medium uppercase tracking-wider text-text-muted">
            Envelopes ({envelopes.length})
          </p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {envelopes.map((env) => (
              <EnvelopeCard
                key={env.entityId}
                category={env.category}
                spent={env.spent}
                limit={env.limit}
                effectiveLimit={env.effectiveLimit}
                remaining={env.remaining}
                currency={currency}
              />
            ))}
          </div>
        </div>
      )}

      {/* Unbudgeted */}
      {unbudgetedTotal > 0 && (
        <div className="flex items-center gap-2.5 rounded-lg border border-warning/30 bg-warning/5 p-3">
          <AlertTriangle className="h-4 w-4 shrink-0 text-warning" />
          <div>
            <p className="text-xs font-medium text-text">
              Unbudgeted expenses: {formatAmount(unbudgetedTotal, currency)}
            </p>
            <p className="text-[11px] text-text-muted">
              Create envelopes via Chat to track these categories
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
