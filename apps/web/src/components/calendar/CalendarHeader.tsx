import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useNavigationStore } from '../../stores/navigation.ts';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function CalendarHeader() {
  const { calendarWeek, prevWeek, nextWeek, goToThisWeek } = useNavigationStore();

  const weekEnd = new Date(calendarWeek);
  weekEnd.setDate(weekEnd.getDate() + 6);

  const startMonth = MONTHS[calendarWeek.getMonth()];
  const endMonth = MONTHS[weekEnd.getMonth()];
  const startDay = calendarWeek.getDate();
  const endDay = weekEnd.getDate();
  const year = calendarWeek.getFullYear();

  const rangeLabel =
    startMonth === endMonth
      ? `${startMonth} ${startDay} - ${endDay}, ${year}`
      : `${startMonth} ${startDay} - ${endMonth} ${endDay}, ${year}`;

  return (
    <div className="flex items-center justify-between border-b border-border px-4 py-2">
      <div className="flex items-center gap-2">
        <button
          onClick={prevWeek}
          className="rounded-md p-1 text-text-secondary transition-colors duration-150 hover:bg-surface-hover hover:text-text"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
        <button
          onClick={nextWeek}
          className="rounded-md p-1 text-text-secondary transition-colors duration-150 hover:bg-surface-hover hover:text-text"
        >
          <ChevronRight className="h-4 w-4" />
        </button>
        <span className="text-sm font-medium text-text">{rangeLabel}</span>
      </div>
      <button
        onClick={goToThisWeek}
        className="rounded-md px-2.5 py-1 text-xs text-text-secondary transition-colors duration-150 hover:bg-surface-hover hover:text-text"
      >
        Today
      </button>
    </div>
  );
}
