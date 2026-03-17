import { HABIT_TYPES } from '@orbis/shared';

interface HabitAspectCardProps {
  data: Record<string, unknown>;
  onChange: (data: Record<string, unknown>) => void;
}

export function HabitAspectCard({ data, onChange }: HabitAspectCardProps) {
  const habitType = (data.habit_type as string) ?? 'binary';
  const active = data.active !== false;
  const currentStreak = typeof data.current_streak === 'number' ? data.current_streak : 0;
  const bestStreak = typeof data.best_streak === 'number' ? data.best_streak : 0;
  const frequencyType = (data.frequency as Record<string, unknown>)?.type as string | undefined;
  const frequencyValue = (data.frequency as Record<string, unknown>)?.value as number | undefined;

  return (
    <div className="rounded-lg border border-border bg-surface-dim p-3">
      <div className="mb-3 flex items-center justify-between">
        <p className="text-xs font-medium uppercase tracking-wider text-text-muted">Habit</p>
        <label className="flex items-center gap-1.5 text-xs text-text-muted">
          <input
            type="checkbox"
            checked={active}
            onChange={(e) => onChange({ ...data, active: e.target.checked })}
            className="rounded border-border accent-primary"
          />
          Active
        </label>
      </div>

      <div className="grid grid-cols-2 gap-3">
        {/* Habit Type */}
        <div>
          <label className="text-xs text-text-muted">Type</label>
          <select
            value={habitType}
            onChange={(e) => onChange({ ...data, habit_type: e.target.value })}
            className="mt-1 block w-full rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-text focus:border-primary focus:outline-none"
          >
            {HABIT_TYPES.map((t) => (
              <option key={t} value={t}>
                {t.charAt(0).toUpperCase() + t.slice(1)}
              </option>
            ))}
          </select>
        </div>

        {/* Frequency */}
        <div>
          <label className="text-xs text-text-muted">Frequency</label>
          <div className="mt-1 flex gap-1.5">
            <select
              value={frequencyType ?? 'daily'}
              onChange={(e) =>
                onChange({
                  ...data,
                  frequency: { type: e.target.value, value: frequencyValue ?? 1 },
                })
              }
              className="flex-1 rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-text focus:border-primary focus:outline-none"
            >
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
              <option value="custom">Custom</option>
            </select>
            {frequencyType === 'weekly' && (
              <input
                type="number"
                value={frequencyValue ?? 1}
                onChange={(e) =>
                  onChange({
                    ...data,
                    frequency: { type: 'weekly', value: Number(e.target.value) || 1 },
                  })
                }
                min={1}
                max={7}
                title="Times per week"
                className="w-12 rounded-md border border-border bg-surface px-1.5 py-1.5 text-center text-sm text-text focus:border-primary focus:outline-none"
              />
            )}
          </div>
        </div>

        {/* Target (for quantitative) */}
        {habitType === 'quantitative' && (
          <>
            <div>
              <label className="text-xs text-text-muted">Target value</label>
              <input
                type="number"
                value={(data.target_value as number) ?? ''}
                onChange={(e) =>
                  onChange({ ...data, target_value: e.target.value ? Number(e.target.value) : undefined })
                }
                placeholder="10"
                className="mt-1 block w-full rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-text placeholder:text-text-muted focus:border-primary focus:outline-none"
              />
            </div>
            <div>
              <label className="text-xs text-text-muted">Unit</label>
              <input
                type="text"
                value={(data.unit as string) ?? ''}
                onChange={(e) => onChange({ ...data, unit: e.target.value })}
                placeholder="glasses, pages..."
                className="mt-1 block w-full rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-text placeholder:text-text-muted focus:border-primary focus:outline-none"
              />
            </div>
          </>
        )}

        {/* Started at */}
        <div>
          <label className="text-xs text-text-muted">Started</label>
          <input
            type="date"
            value={(data.started_at as string) ?? ''}
            onChange={(e) => onChange({ ...data, started_at: e.target.value || undefined })}
            className="mt-1 block w-full rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-text focus:border-primary focus:outline-none"
          />
        </div>
      </div>

      {/* Streaks */}
      <div className="mt-3 flex gap-4 rounded-md bg-surface px-2.5 py-2">
        <div className="text-center">
          <p className="text-lg font-semibold text-primary">{currentStreak}</p>
          <p className="text-[10px] text-text-muted">Current streak</p>
        </div>
        <div className="text-center">
          <p className="text-lg font-semibold text-text-secondary">{bestStreak}</p>
          <p className="text-[10px] text-text-muted">Best streak</p>
        </div>
      </div>
    </div>
  );
}
