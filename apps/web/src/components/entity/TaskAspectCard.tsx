import { TASK_STATUSES, TASK_PRIORITIES } from '@orbis/shared';

interface TaskAspectCardProps {
  data: Record<string, unknown>;
  onChange: (data: Record<string, unknown>) => void;
}

const PRIORITY_COLORS: Record<string, string> = {
  none: 'bg-text-muted',
  low: 'bg-success',
  medium: 'bg-warning',
  high: 'bg-danger',
  urgent: 'bg-urgent',
};

export function TaskAspectCard({ data, onChange }: TaskAspectCardProps) {
  return (
    <div className="rounded-lg border border-border bg-surface-dim p-3">
      <p className="mb-3 text-xs font-medium uppercase tracking-wider text-text-muted">Task</p>

      <div className="grid grid-cols-2 gap-3">
        {/* Status */}
        <div>
          <label className="text-xs text-text-muted">Status</label>
          <select
            value={(data.status as string) ?? 'inbox'}
            onChange={(e) => onChange({ ...data, status: e.target.value })}
            className="mt-1 block w-full rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-text focus:border-primary focus:outline-none"
          >
            {TASK_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s.replace('_', ' ')}
              </option>
            ))}
          </select>
        </div>

        {/* Priority */}
        <div>
          <label className="text-xs text-text-muted">Priority</label>
          <div className="mt-1.5 flex gap-2">
            {TASK_PRIORITIES.map((p) => (
              <button
                key={p}
                onClick={() => onChange({ ...data, priority: p })}
                title={p}
                className={`h-4 w-4 rounded-full transition-transform duration-150 ${
                  data.priority === p ? 'scale-125 ring-2 ring-text ring-offset-1 ring-offset-surface-dim' : ''
                } ${PRIORITY_COLORS[p]}`}
              />
            ))}
          </div>
        </div>

        {/* Due date */}
        <div>
          <label className="text-xs text-text-muted">Due date</label>
          <input
            type="date"
            value={(data.due_date as string) ?? ''}
            onChange={(e) =>
              onChange({ ...data, due_date: e.target.value || undefined })
            }
            className="mt-1 block w-full rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-text focus:border-primary focus:outline-none"
          />
        </div>

        {/* Effort */}
        <div>
          <label className="text-xs text-text-muted">Effort (min)</label>
          <input
            type="number"
            value={(data.effort_min as number) ?? ''}
            onChange={(e) =>
              onChange({ ...data, effort_min: e.target.value ? Number(e.target.value) : undefined })
            }
            placeholder="30"
            className="mt-1 block w-full rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-text placeholder:text-text-muted focus:border-primary focus:outline-none"
          />
        </div>
      </div>
    </div>
  );
}
