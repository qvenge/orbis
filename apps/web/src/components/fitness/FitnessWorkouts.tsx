import { useState } from 'react';
import { Dumbbell } from 'lucide-react';
import { trpc } from '../../lib/trpc.ts';
import { WorkoutRow } from './WorkoutRow.tsx';

interface FitnessWorkoutsProps {
  year: number;
  month: number;
}

export function FitnessWorkouts({ year, month }: FitnessWorkoutsProps) {
  const [selectedType, setSelectedType] = useState<string>('');

  const { data: workoutTypes } = trpc.entity.fitnessWorkoutTypes.useQuery(undefined, {
    staleTime: 60_000,
  });

  const { data, isLoading } = trpc.entity.fitnessWorkouts.useQuery({
    year,
    month,
    workoutType: selectedType || undefined,
    limit: 100,
  });

  return (
    <div>
      {/* Filter bar */}
      <div className="border-b border-border/40 px-3 py-2">
        <div className="flex gap-1.5 overflow-x-auto">
          <button
            onClick={() => setSelectedType('')}
            className={`shrink-0 rounded-full px-2.5 py-0.5 text-[11px] transition-colors duration-150 ${
              !selectedType
                ? 'bg-primary text-white'
                : 'bg-surface-hover text-text-secondary hover:text-text'
            }`}
          >
            All
          </button>
          {workoutTypes?.map((type) => (
            <button
              key={type}
              onClick={() => setSelectedType(type)}
              className={`shrink-0 rounded-full px-2.5 py-0.5 text-[11px] capitalize transition-colors duration-150 ${
                selectedType === type
                  ? 'bg-primary text-white'
                  : 'bg-surface-hover text-text-secondary hover:text-text'
              }`}
            >
              {type}
            </button>
          ))}
        </div>
      </div>

      {/* List */}
      {isLoading ? (
        <div className="flex h-32 items-center justify-center">
          <div className="h-5 w-5 animate-spin rounded-full border-2 border-border-light border-t-primary" />
        </div>
      ) : !data || data.items.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-2 px-4 py-12 text-center">
          <Dumbbell className="h-8 w-8 text-text-muted" />
          <p className="text-sm text-text-muted">No workouts found</p>
        </div>
      ) : (
        <div className="divide-y divide-border/40">
          {data.items.map((entity) => (
            <WorkoutRow key={entity.id} entity={entity} />
          ))}
        </div>
      )}
    </div>
  );
}
