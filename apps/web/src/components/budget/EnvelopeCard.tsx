interface EnvelopeCardProps {
  category: string;
  spent: number;
  limit: number;
  effectiveLimit: number;
  remaining: number;
  currency: string;
}

function formatAmount(amount: number, currency: string): string {
  return new Intl.NumberFormat('ru-RU', {
    style: 'currency',
    currency,
    maximumFractionDigits: 0,
  }).format(amount);
}

export function EnvelopeCard({ category, spent, effectiveLimit, remaining, currency }: EnvelopeCardProps) {
  const percentage = effectiveLimit > 0 ? (spent / effectiveLimit) * 100 : 0;
  const barWidth = Math.min(100, percentage);
  const isOver = remaining < 0;

  const barColor =
    percentage >= 100
      ? 'bg-urgent'
      : percentage >= 85
        ? 'bg-danger'
        : percentage >= 60
          ? 'bg-warning'
          : 'bg-success';

  const daysInMonth = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate();
  const currentDay = new Date().getDate();
  const daysLeft = Math.max(1, daysInMonth - currentDay + 1);
  const dailyPace = remaining > 0 ? remaining / daysLeft : 0;

  return (
    <div className="rounded-lg border border-border bg-surface-dim p-3 transition-colors duration-150 hover:bg-surface-hover">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-sm font-medium capitalize text-text">{category}</span>
        <span className={`text-xs font-medium ${isOver ? 'text-danger' : 'text-text-secondary'}`}>
          {isOver ? `${formatAmount(Math.abs(remaining), currency)} over` : `${formatAmount(remaining, currency)} left`}
        </span>
      </div>

      {/* Progress bar */}
      <div className="mb-2 h-2 overflow-hidden rounded-full bg-surface-hover">
        <div
          className={`h-full rounded-full transition-all duration-300 ${barColor}`}
          style={{ width: `${barWidth}%` }}
        />
      </div>

      <div className="flex items-center justify-between">
        <span className="text-xs text-text-muted">
          {formatAmount(spent, currency)} / {formatAmount(effectiveLimit, currency)}
        </span>
        {remaining > 0 && (
          <span className="text-[11px] text-text-muted">
            ~{formatAmount(dailyPace, currency)}/day
          </span>
        )}
      </div>
    </div>
  );
}
