import { Loader2 } from 'lucide-react';

export function Spinner({
  size = 16,
  'aria-label': ariaLabel = 'Загрузка',
  className = '',
}: {
  size?: number;
  'aria-label'?: string;
  className?: string;
}) {
  // role=status на обёртке: lucide ставит aria-hidden на сам svg.
  return (
    <span role="status" aria-label={ariaLabel} className={`inline-flex ${className}`}>
      <Loader2 size={size} className="animate-spin" aria-hidden />
    </span>
  );
}
