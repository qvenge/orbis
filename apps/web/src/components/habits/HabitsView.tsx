import { ArrowLeft } from 'lucide-react';
import { useNavigationStore } from '../../stores/navigation.ts';
import { IconButton } from '../ui/IconButton.tsx';
import { HabitTodayList } from './HabitTodayList.tsx';
import { HabitHistory } from './HabitHistory.tsx';
import { QuickAddHabit } from './QuickAddHabit.tsx';

export function HabitsView() {
  const { navigate } = useNavigationStore();

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="shrink-0 border-b border-border px-4 py-3">
        <div className="flex items-center gap-3">
          <IconButton icon={ArrowLeft} label="Go back" onClick={() => navigate('hub')} />
          <h2 className="text-sm font-semibold text-text">Habits</h2>
          <div className="flex-1" />
          <span className="text-xs text-text-muted">
            {new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })}
          </span>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        <HabitTodayList />
        <HabitHistory />
      </div>

      {/* Quick Add */}
      <QuickAddHabit />
    </div>
  );
}
