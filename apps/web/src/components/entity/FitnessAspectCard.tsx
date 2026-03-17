import { Plus, Trash2 } from 'lucide-react';

interface Exercise {
  name: string;
  sets: number;
  reps: number;
  weight_kg: number;
}

interface FitnessAspectCardProps {
  data: Record<string, unknown>;
  onChange: (data: Record<string, unknown>) => void;
}

function parseExercises(raw: unknown): Exercise[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((e) => ({
    name: String(e?.name ?? ''),
    sets: Number(e?.sets ?? 0),
    reps: Number(e?.reps ?? 0),
    weight_kg: Number(e?.weight_kg ?? 0),
  }));
}

function computeVolume(exercises: Exercise[]): number {
  return exercises.reduce((sum, e) => sum + e.sets * e.reps * e.weight_kg, 0);
}

export function FitnessAspectCard({ data, onChange }: FitnessAspectCardProps) {
  const exercises = parseExercises(data.exercises);
  const totalVolume = computeVolume(exercises);
  const effort = typeof data.perceived_effort === 'number' ? data.perceived_effort : 5;

  const updateExercise = (index: number, field: keyof Exercise, value: string | number) => {
    const updated = exercises.map((ex, i) =>
      i === index ? { ...ex, [field]: field === 'name' ? value : Number(value) || 0 } : ex,
    );
    onChange({ ...data, exercises: updated, total_volume_kg: computeVolume(updated) });
  };

  const addExercise = () => {
    const updated = [...exercises, { name: '', sets: 3, reps: 10, weight_kg: 0 }];
    onChange({ ...data, exercises: updated });
  };

  const removeExercise = (index: number) => {
    const updated = exercises.filter((_, i) => i !== index);
    onChange({ ...data, exercises: updated, total_volume_kg: computeVolume(updated) });
  };

  return (
    <div className="rounded-lg border border-border bg-surface-dim p-3">
      <p className="mb-3 text-xs font-medium uppercase tracking-wider text-text-muted">Fitness</p>

      <div className="grid grid-cols-2 gap-3">
        {/* Workout Type */}
        <div>
          <label className="text-xs text-text-muted">Workout type</label>
          <input
            type="text"
            value={(data.workout_type as string) ?? ''}
            onChange={(e) => onChange({ ...data, workout_type: e.target.value })}
            placeholder="strength, cardio..."
            className="mt-1 block w-full rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-text placeholder:text-text-muted focus:border-primary focus:outline-none"
          />
        </div>

        {/* Duration */}
        <div>
          <label className="text-xs text-text-muted">Duration (min)</label>
          <input
            type="number"
            value={(data.duration_min as number) ?? ''}
            onChange={(e) =>
              onChange({ ...data, duration_min: e.target.value ? Number(e.target.value) : undefined })
            }
            placeholder="60"
            className="mt-1 block w-full rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-text placeholder:text-text-muted focus:border-primary focus:outline-none"
          />
        </div>
      </div>

      {/* Perceived Effort */}
      <div className="mt-3">
        <label className="text-xs text-text-muted">
          Perceived effort: <span className="text-text">{effort}/10</span>
        </label>
        <input
          type="range"
          min={1}
          max={10}
          value={effort}
          onChange={(e) => onChange({ ...data, perceived_effort: Number(e.target.value) })}
          className="mt-1 block w-full accent-primary"
        />
      </div>

      {/* Exercises */}
      <div className="mt-3">
        <div className="flex items-center justify-between">
          <label className="text-xs text-text-muted">Exercises</label>
          {totalVolume > 0 && (
            <span className="text-xs text-text-secondary">
              Vol: {totalVolume.toLocaleString()} kg
            </span>
          )}
        </div>

        <div className="mt-2 space-y-2">
          {exercises.map((ex, i) => (
            <div key={i} className="flex items-center gap-1.5">
              <input
                type="text"
                value={ex.name}
                onChange={(e) => updateExercise(i, 'name', e.target.value)}
                placeholder="Exercise"
                className="min-w-0 flex-1 rounded-md border border-border bg-surface px-2 py-1 text-xs text-text placeholder:text-text-muted focus:border-primary focus:outline-none"
              />
              <input
                type="number"
                value={ex.sets || ''}
                onChange={(e) => updateExercise(i, 'sets', e.target.value)}
                placeholder="S"
                title="Sets"
                className="w-10 rounded-md border border-border bg-surface px-1.5 py-1 text-center text-xs text-text placeholder:text-text-muted focus:border-primary focus:outline-none"
              />
              <span className="text-[10px] text-text-muted">&times;</span>
              <input
                type="number"
                value={ex.reps || ''}
                onChange={(e) => updateExercise(i, 'reps', e.target.value)}
                placeholder="R"
                title="Reps"
                className="w-10 rounded-md border border-border bg-surface px-1.5 py-1 text-center text-xs text-text placeholder:text-text-muted focus:border-primary focus:outline-none"
              />
              <span className="text-[10px] text-text-muted">@</span>
              <input
                type="number"
                value={ex.weight_kg || ''}
                onChange={(e) => updateExercise(i, 'weight_kg', e.target.value)}
                placeholder="kg"
                title="Weight (kg)"
                className="w-14 rounded-md border border-border bg-surface px-1.5 py-1 text-center text-xs text-text placeholder:text-text-muted focus:border-primary focus:outline-none"
              />
              <button
                onClick={() => removeExercise(i)}
                className="rounded p-0.5 text-text-muted transition-colors hover:text-danger"
              >
                <Trash2 className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>

        <button
          onClick={addExercise}
          className="mt-2 flex items-center gap-1 text-xs text-primary transition-colors hover:text-primary/80"
        >
          <Plus className="h-3 w-3" /> Add exercise
        </button>
      </div>

      {/* Notes */}
      <div className="mt-3">
        <label className="text-xs text-text-muted">Notes</label>
        <textarea
          value={(data.notes as string) ?? ''}
          onChange={(e) => onChange({ ...data, notes: e.target.value })}
          placeholder="How did it feel?"
          rows={2}
          className="mt-1 block w-full resize-none rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-text placeholder:text-text-muted focus:border-primary focus:outline-none"
        />
      </div>
    </div>
  );
}
