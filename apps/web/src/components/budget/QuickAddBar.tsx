import { useState } from 'react';
import { Check, ArrowUpDown } from 'lucide-react';
import { trpc } from '../../lib/trpc.ts';
import { useSettingsStore } from '../../stores/settings.ts';

interface QuickAddBarProps {
  year: number;
  month: number;
}

const DEFAULT_CATEGORIES = ['food', 'transport', 'housing', 'health', 'other'];

export function QuickAddBar({ year: _year, month: _month }: QuickAddBarProps) {
  const { settings } = useSettingsStore();
  const currency = (settings?.defaultCurrency as string) ?? 'RUB';
  const utils = trpc.useUtils();

  const [amount, setAmount] = useState('');
  const [direction, setDirection] = useState<'expense' | 'income'>('expense');
  const [selectedCategory, setSelectedCategory] = useState('food');
  const [showSuccess, setShowSuccess] = useState(false);

  const { data: userCategories } = trpc.entity.financialCategories.useQuery(undefined, {
    staleTime: 60_000,
  });

  const categories = userCategories && userCategories.length > 0
    ? userCategories.slice(0, 5)
    : DEFAULT_CATEGORIES;

  const createEntity = trpc.entity.create.useMutation({
    onSuccess: () => {
      setAmount('');
      setShowSuccess(true);
      setTimeout(() => setShowSuccess(false), 1200);
      utils.entity.financialSummary.invalidate();
      utils.entity.financialTransactions.invalidate();
      utils.entity.financialCategories.invalidate();
      utils.entity.list.invalidate();
    },
  });

  const handleSubmit = () => {
    const parsed = parseFloat(amount);
    if (!parsed || parsed <= 0) return;

    const title = `${selectedCategory} ${direction}`;
    createEntity.mutate({
      title,
      aspects: {
        'orbis/financial': {
          amount: parsed,
          direction,
          category: selectedCategory,
          currency,
        },
        'orbis/schedule': {
          start_at: new Date().toISOString(),
        },
      },
      tags: [direction, selectedCategory],
    });
  };

  const handleAmountChange = (value: string) => {
    // Allow only digits and one decimal point
    const cleaned = value.replace(/[^\d.]/g, '');
    const parts = cleaned.split('.');
    if (parts.length > 2) return;
    setAmount(cleaned);
  };

  return (
    <div className="shrink-0 border-t border-border bg-surface-dim px-3 py-2">
      {/* Category pills */}
      <div className="mb-2 flex gap-1 overflow-x-auto">
        {categories.map((cat) => (
          <button
            key={cat}
            onClick={() => setSelectedCategory(cat)}
            className={`shrink-0 rounded-full px-2.5 py-0.5 text-[11px] capitalize transition-colors duration-150 ${
              selectedCategory === cat
                ? 'bg-primary text-white'
                : 'bg-surface-hover text-text-secondary hover:text-text'
            }`}
          >
            {cat}
          </button>
        ))}
      </div>

      {/* Input row */}
      <div className="flex items-center gap-2">
        <button
          onClick={() => setDirection(direction === 'expense' ? 'income' : 'expense')}
          className={`flex shrink-0 items-center gap-1 rounded-md px-2 py-1.5 text-xs font-medium transition-colors duration-150 ${
            direction === 'expense'
              ? 'bg-danger/10 text-danger'
              : 'bg-success/10 text-success'
          }`}
        >
          <ArrowUpDown className="h-3 w-3" />
          {direction === 'expense' ? 'Expense' : 'Income'}
        </button>

        <input
          type="text"
          inputMode="decimal"
          value={amount}
          onChange={(e) => handleAmountChange(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
          placeholder="Amount"
          className="flex-1 rounded-md border border-border bg-surface px-3 py-1.5 text-sm text-text placeholder:text-text-muted focus:border-primary focus:outline-none"
        />

        <button
          onClick={handleSubmit}
          disabled={!amount || parseFloat(amount) <= 0 || createEntity.isPending}
          className="flex shrink-0 items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-white transition-colors duration-150 hover:bg-primary/80 disabled:opacity-40"
        >
          {showSuccess ? (
            <Check className="h-3.5 w-3.5" />
          ) : (
            'Log'
          )}
        </button>
      </div>
    </div>
  );
}
