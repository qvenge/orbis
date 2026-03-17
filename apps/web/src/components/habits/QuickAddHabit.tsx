import { useState } from 'react';
import { Check } from 'lucide-react';
import { trpc } from '../../lib/trpc.ts';

export function QuickAddHabit() {
  const utils = trpc.useUtils();

  const [name, setName] = useState('');
  const [habitType, setHabitType] = useState<'binary' | 'quantitative'>('binary');
  const [showSuccess, setShowSuccess] = useState(false);

  const createEntity = trpc.entity.create.useMutation({
    onSuccess: () => {
      setName('');
      setShowSuccess(true);
      setTimeout(() => setShowSuccess(false), 1200);
      utils.entity.habitsToday.invalidate();
      utils.entity.habitsHistory.invalidate();
      utils.entity.list.invalidate();
    },
  });

  const handleSubmit = () => {
    const title = name.trim();
    if (!title) return;

    createEntity.mutate({
      title,
      aspects: {
        'orbis/habit': {
          habit_type: habitType,
          active: true,
          started_at: new Date().toISOString().slice(0, 10),
          frequency: { type: 'daily', value: 1 },
          check_ins: [],
          current_streak: 0,
          best_streak: 0,
        },
      },
      tags: ['habit'],
    });
  };

  return (
    <div className="shrink-0 border-t border-border bg-surface-dim px-3 py-2">
      {/* Type toggle */}
      <div className="mb-2 flex gap-1">
        <button
          onClick={() => setHabitType('binary')}
          className={`rounded-full px-2.5 py-0.5 text-[11px] transition-colors duration-150 ${
            habitType === 'binary'
              ? 'bg-primary text-white'
              : 'bg-surface-hover text-text-secondary hover:text-text'
          }`}
        >
          Yes/No
        </button>
        <button
          onClick={() => setHabitType('quantitative')}
          className={`rounded-full px-2.5 py-0.5 text-[11px] transition-colors duration-150 ${
            habitType === 'quantitative'
              ? 'bg-primary text-white'
              : 'bg-surface-hover text-text-secondary hover:text-text'
          }`}
        >
          Quantitative
        </button>
      </div>

      {/* Input row */}
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
          placeholder="New habit name..."
          className="flex-1 rounded-md border border-border bg-surface px-3 py-1.5 text-sm text-text placeholder:text-text-muted focus:border-primary focus:outline-none"
        />

        <button
          onClick={handleSubmit}
          disabled={!name.trim() || createEntity.isPending}
          className="flex shrink-0 items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-white transition-colors duration-150 hover:bg-primary/80 disabled:opacity-40"
        >
          {showSuccess ? <Check className="h-3.5 w-3.5" /> : 'Create'}
        </button>
      </div>
    </div>
  );
}
