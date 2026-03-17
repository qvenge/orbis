import { Wallet, TrendingUp, TrendingDown } from 'lucide-react';

interface BudgetSummaryCardProps {
  totalIncome: number;
  totalExpenses: number;
  balance: number;
  currency: string;
}

export function BudgetSummaryCard({ totalIncome, totalExpenses, balance, currency }: BudgetSummaryCardProps) {
  const fmt = (n: number) =>
    new Intl.NumberFormat('ru-RU', { style: 'currency', currency, maximumFractionDigits: 0 }).format(n);

  return (
    <div className="rounded-lg border border-border bg-surface-dim p-3">
      <div className="mb-2 flex items-center gap-2">
        <Wallet className="h-4 w-4 text-primary" />
        <span className="text-xs font-medium text-text">Budget Summary</span>
      </div>
      <div className={`text-lg font-semibold ${balance >= 0 ? 'text-success' : 'text-danger'}`}>
        {fmt(balance)}
      </div>
      <div className="mt-2 flex gap-4 text-xs">
        <div className="flex items-center gap-1 text-success">
          <TrendingUp className="h-3 w-3" />
          <span>{fmt(totalIncome)}</span>
        </div>
        <div className="flex items-center gap-1 text-danger">
          <TrendingDown className="h-3 w-3" />
          <span>{fmt(totalExpenses)}</span>
        </div>
      </div>
    </div>
  );
}
