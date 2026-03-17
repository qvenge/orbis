import { useState } from 'react';
import { Check, Flame } from 'lucide-react';
import { trpc } from '../../lib/trpc.ts';

interface HabitRowProps {
  entity: {
    id: string;
    title: string;
    emoji: string | null;
    aspects?: unknown;
  };
  checkedIn: boolean;
  currentStreak: number;
}

export function HabitRow({ entity, checkedIn, currentStreak }: HabitRowProps) {
  const utils = trpc.useUtils();
  const [optimisticChecked, setOptimisticChecked] = useState(checkedIn);

  const aspects = entity.aspects as Record<string, Record<string, unknown>> | undefined;
  const hab = aspects?.['orbis/habit'];
  const habitType = String(hab?.habit_type ?? 'binary');
  const targetValue = typeof hab?.target_value === 'number' ? hab.target_value : undefined;
  const unit = typeof hab?.unit === 'string' ? hab.unit : '';

  const [quantValue, setQuantValue] = useState('');

  const checkIn = trpc.entity.habitCheckIn.useMutation({
    onSuccess: () => {
      utils.entity.habitsToday.invalidate();
      utils.entity.habitsHistory.invalidate();
    },
  });

  const today = new Date().toISOString().slice(0, 10);

  const handleToggle = () => {
    const newState = !optimisticChecked;
    setOptimisticChecked(newState);
    checkIn.mutate({
      entityId: entity.id,
      date: today,
      completed: newState,
    });
  };

  const handleQuantSubmit = () => {
    const val = parseFloat(quantValue);
    if (!val || val <= 0) return;
    setOptimisticChecked(true);
    checkIn.mutate({
      entityId: entity.id,
      date: today,
      value: val,
      completed: true,
    });
    setQuantValue('');
  };

  return (
    <div className="flex items-center gap-3 px-4 py-3">
      {/* Check-in button */}
      {habitType === 'binary' ? (
        <button
          onClick={handleToggle}
          disabled={checkIn.isPending}
          className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full border-2 transition-all duration-200 ${
            optimisticChecked
              ? 'border-success bg-success text-white'
              : 'border-border text-transparent hover:border-success/50'
          }`}
        >
          <Check className="h-3.5 w-3.5" />
        </button>
      ) : (
        <div className="flex shrink-0 items-center gap-1">
          <input
            type="number"
            value={quantValue}
            onChange={(e) => setQuantValue(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleQuantSubmit()}
            placeholder={String(targetValue ?? '0')}
            className="w-12 rounded-md border border-border bg-surface px-1.5 py-1 text-center text-xs text-text placeholder:text-text-muted focus:border-primary focus:outline-none"
          />
          {unit && <span className="text-[10px] text-text-muted">{unit}</span>}
        </div>
      )}

      {/* Title */}
      <div className="flex min-w-0 flex-1 items-center gap-2">
        {entity.emoji && <span className="text-sm">{entity.emoji}</span>}
        <span className={`truncate text-sm ${optimisticChecked ? 'text-text-muted line-through' : 'text-text'}`}>
          {entity.title}
        </span>
      </div>

      {/* Streak */}
      {currentStreak > 0 && (
        <div className="flex shrink-0 items-center gap-0.5 text-xs">
          <Flame className="h-3 w-3 text-warning" />
          <span className="font-medium text-text-secondary">{currentStreak}</span>
        </div>
      )}
    </div>
  );
}
