import { ChevronLeft, ChevronRight } from 'lucide-react';

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

interface PeriodNavProps {
  year: number;
  month: number;
  onPrev: () => void;
  onNext: () => void;
}

export function PeriodNav({ year, month, onPrev, onNext }: PeriodNavProps) {
  return (
    <div className="flex items-center gap-1">
      <button
        onClick={onPrev}
        className="rounded-md p-1 text-text-muted transition-colors duration-150 hover:bg-surface-hover hover:text-text"
      >
        <ChevronLeft className="h-4 w-4" />
      </button>
      <span className="min-w-[120px] text-center text-xs font-medium text-text">
        {MONTH_NAMES[month - 1]} {year}
      </span>
      <button
        onClick={onNext}
        className="rounded-md p-1 text-text-muted transition-colors duration-150 hover:bg-surface-hover hover:text-text"
      >
        <ChevronRight className="h-4 w-4" />
      </button>
    </div>
  );
}
