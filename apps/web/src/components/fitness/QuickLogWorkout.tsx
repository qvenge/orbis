import { useState } from 'react';
import { Check } from 'lucide-react';
import { trpc } from '../../lib/trpc.ts';

const DEFAULT_TYPES = ['strength', 'cardio', 'flexibility', 'hiit', 'other'];

export function QuickLogWorkout() {
  const utils = trpc.useUtils();

  const [workoutType, setWorkoutType] = useState('strength');
  const [duration, setDuration] = useState('');
  const [effort, setEffort] = useState('5');
  const [showSuccess, setShowSuccess] = useState(false);

  const { data: userTypes } = trpc.entity.fitnessWorkoutTypes.useQuery(undefined, {
    staleTime: 60_000,
  });

  const types = userTypes && userTypes.length > 0 ? userTypes.slice(0, 5) : DEFAULT_TYPES;

  const createEntity = trpc.entity.create.useMutation({
    onSuccess: () => {
      setDuration('');
      setEffort('5');
      setShowSuccess(true);
      setTimeout(() => setShowSuccess(false), 1200);
      utils.entity.fitnessSummary.invalidate();
      utils.entity.fitnessWorkouts.invalidate();
      utils.entity.fitnessWorkoutTypes.invalidate();
      utils.entity.list.invalidate();
    },
  });

  const handleSubmit = () => {
    const durationMin = parseInt(duration);
    if (!durationMin || durationMin <= 0) return;

    createEntity.mutate({
      title: `${workoutType} workout`,
      aspects: {
        'orbis/fitness': {
          workout_type: workoutType,
          duration_min: durationMin,
          perceived_effort: parseInt(effort) || 5,
          exercises: [],
          total_volume_kg: 0,
        },
        'orbis/schedule': {
          start_at: new Date().toISOString(),
        },
      },
      tags: ['workout', workoutType],
    });
  };

  return (
    <div className="shrink-0 border-t border-border bg-surface-dim px-3 py-2">
      {/* Type pills */}
      <div className="mb-2 flex gap-1 overflow-x-auto">
        {types.map((type) => (
          <button
            key={type}
            onClick={() => setWorkoutType(type)}
            className={`shrink-0 rounded-full px-2.5 py-0.5 text-[11px] capitalize transition-colors duration-150 ${
              workoutType === type
                ? 'bg-primary text-white'
                : 'bg-surface-hover text-text-secondary hover:text-text'
            }`}
          >
            {type}
          </button>
        ))}
      </div>

      {/* Input row */}
      <div className="flex items-center gap-2">
        <input
          type="number"
          value={duration}
          onChange={(e) => setDuration(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
          placeholder="Duration (min)"
          className="flex-1 rounded-md border border-border bg-surface px-3 py-1.5 text-sm text-text placeholder:text-text-muted focus:border-primary focus:outline-none"
        />

        <div className="flex items-center gap-1">
          <span className="text-[10px] text-text-muted">RPE</span>
          <input
            type="number"
            min={1}
            max={10}
            value={effort}
            onChange={(e) => setEffort(e.target.value)}
            className="w-10 rounded-md border border-border bg-surface px-1.5 py-1.5 text-center text-sm text-text focus:border-primary focus:outline-none"
          />
        </div>

        <button
          onClick={handleSubmit}
          disabled={!duration || parseInt(duration) <= 0 || createEntity.isPending}
          className="flex shrink-0 items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-white transition-colors duration-150 hover:bg-primary/80 disabled:opacity-40"
        >
          {showSuccess ? <Check className="h-3.5 w-3.5" /> : 'Log'}
        </button>
      </div>
    </div>
  );
}
