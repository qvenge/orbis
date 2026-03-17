import { RotateCw } from 'lucide-react';
import { useNavigationStore } from '../../stores/navigation.ts';

interface TransactionRowProps {
  entity: {
    id: string;
    title: string;
    createdAt: Date | string;
    aspects?: unknown;
  };
  currency: string;
}

function formatDate(date: Date | string): string {
  const d = new Date(date);
  const now = new Date();
  const diff = now.getTime() - d.getTime();
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));

  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return d.toLocaleDateString('en-US', { day: 'numeric', month: 'short' });
}

function formatAmount(amount: number, currency: string): string {
  return new Intl.NumberFormat('ru-RU', {
    style: 'currency',
    currency,
    maximumFractionDigits: 0,
  }).format(amount);
}

export function TransactionRow({ entity, currency }: TransactionRowProps) {
  const { openEntity } = useNavigationStore();
  const aspects = entity.aspects as Record<string, Record<string, unknown>>;
  const fin = aspects?.['orbis/financial'];

  if (!fin) return null;

  const amount = typeof fin.amount === 'number' ? fin.amount : 0;
  const direction = String(fin.direction ?? 'expense');
  const category = String(fin.category ?? 'other');
  const recurring = fin.recurring === true;
  const isIncome = direction === 'income';

  return (
    <button
      onClick={() => openEntity(entity.id)}
      className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors duration-150 hover:bg-surface-hover"
    >
      {/* Date */}
      <span className="w-16 shrink-0 text-xs text-text-muted">
        {formatDate(entity.createdAt)}
      </span>

      {/* Title + Category */}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-sm text-text">{entity.title}</span>
        <div className="flex items-center gap-1.5">
          <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] capitalize text-primary">
            {category}
          </span>
          {recurring && <RotateCw className="h-2.5 w-2.5 text-text-muted" />}
        </div>
      </div>

      {/* Amount */}
      <span className={`shrink-0 text-sm font-medium ${isIncome ? 'text-success' : 'text-danger'}`}>
        {isIncome ? '+' : '-'}{formatAmount(amount, currency)}
      </span>
    </button>
  );
}
