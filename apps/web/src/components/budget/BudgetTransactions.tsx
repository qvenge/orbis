import { useState } from 'react';
import { Search } from 'lucide-react';
import { trpc } from '../../lib/trpc.ts';
import { useSettingsStore } from '../../stores/settings.ts';
import { TransactionRow } from './TransactionRow.tsx';

interface BudgetTransactionsProps {
  year: number;
  month: number;
}

const DIRECTION_OPTIONS = [
  { value: undefined, label: 'All' },
  { value: 'expense' as const, label: 'Expenses' },
  { value: 'income' as const, label: 'Income' },
];

export function BudgetTransactions({ year, month }: BudgetTransactionsProps) {
  const { settings } = useSettingsStore();
  const currency = (settings?.defaultCurrency as string) ?? 'RUB';

  const [category, setCategory] = useState<string | undefined>();
  const [direction, setDirection] = useState<'income' | 'expense' | undefined>();
  const [search, setSearch] = useState('');

  const { data: categories } = trpc.entity.financialCategories.useQuery(undefined, {
    staleTime: 60_000,
  });

  const { data, isLoading } = trpc.entity.financialTransactions.useQuery(
    {
      year,
      month,
      category,
      direction,
      search: search || undefined,
    },
    { staleTime: 30_000 },
  );

  return (
    <div className="flex h-full flex-col">
      {/* Filters */}
      <div className="shrink-0 space-y-2 border-b border-border/40 px-4 py-3">
        {/* Direction toggle */}
        <div className="flex gap-1">
          {DIRECTION_OPTIONS.map((opt) => (
            <button
              key={opt.label}
              onClick={() => setDirection(opt.value)}
              className={`rounded-md px-2.5 py-1 text-xs transition-colors duration-150 ${
                direction === opt.value
                  ? 'bg-primary/10 text-primary'
                  : 'text-text-muted hover:bg-surface-hover hover:text-text-secondary'
              }`}
            >
              {opt.label}
            </button>
          ))}

          {/* Category dropdown */}
          {categories && categories.length > 0 && (
            <select
              value={category ?? ''}
              onChange={(e) => setCategory(e.target.value || undefined)}
              className="ml-auto rounded-md border border-border bg-surface-dim px-2 py-1 text-xs text-text focus:border-primary focus:outline-none"
            >
              <option value="">All categories</option>
              {categories.map((cat) => (
                <option key={cat} value={cat}>
                  {cat}
                </option>
              ))}
            </select>
          )}
        </div>

        {/* Search */}
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-muted" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search transactions..."
            className="w-full rounded-md border border-border bg-surface-dim py-1.5 pl-8 pr-3 text-xs text-text placeholder:text-text-muted focus:border-primary focus:outline-none"
          />
        </div>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto">
        {isLoading ? (
          <div className="flex items-center justify-center py-16">
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-border-light border-t-primary" />
          </div>
        ) : !data?.items.length ? (
          <div className="flex flex-col items-center py-16 text-center">
            <p className="text-sm text-text-secondary">No transactions found</p>
            <p className="mt-1 text-xs text-text-muted">
              {search || category || direction
                ? 'Try adjusting your filters'
                : 'Log expenses via Chat or the Quick Add bar'}
            </p>
          </div>
        ) : (
          <div className="divide-y divide-border/40">
            {data.items.map((entity) => (
              <TransactionRow key={entity.id} entity={entity} currency={currency} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
