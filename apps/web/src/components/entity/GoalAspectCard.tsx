import { Plus, Trash2 } from 'lucide-react';

interface Milestone {
  title: string;
  completed: boolean;
}

interface GoalAspectCardProps {
  data: Record<string, unknown>;
  onChange: (data: Record<string, unknown>) => void;
}

function parseMilestones(raw: unknown): Milestone[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((m) => ({
    title: String(m?.title ?? ''),
    completed: m?.completed === true,
  }));
}

export function GoalAspectCard({ data, onChange }: GoalAspectCardProps) {
  const targetValue = typeof data.target_value === 'number' ? data.target_value : 0;
  const currentValue = typeof data.current_value === 'number' ? data.current_value : 0;
  const progress = targetValue > 0 ? Math.min((currentValue / targetValue) * 100, 100) : 0;
  const milestones = parseMilestones(data.milestones);

  const updateMilestone = (index: number, field: keyof Milestone, value: string | boolean) => {
    const updated = milestones.map((m, i) => (i === index ? { ...m, [field]: value } : m));
    onChange({ ...data, milestones: updated });
  };

  const addMilestone = () => {
    onChange({ ...data, milestones: [...milestones, { title: '', completed: false }] });
  };

  const removeMilestone = (index: number) => {
    onChange({ ...data, milestones: milestones.filter((_, i) => i !== index) });
  };

  return (
    <div className="rounded-lg border border-border bg-surface-dim p-3">
      <p className="mb-3 text-xs font-medium uppercase tracking-wider text-text-muted">Goal</p>

      <div className="grid grid-cols-3 gap-3">
        {/* Current Value */}
        <div>
          <label className="text-xs text-text-muted">Current</label>
          <input
            type="number"
            value={currentValue || ''}
            onChange={(e) =>
              onChange({ ...data, current_value: e.target.value ? Number(e.target.value) : 0 })
            }
            placeholder="0"
            className="mt-1 block w-full rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-text placeholder:text-text-muted focus:border-primary focus:outline-none"
          />
        </div>

        {/* Target Value */}
        <div>
          <label className="text-xs text-text-muted">Target</label>
          <input
            type="number"
            value={targetValue || ''}
            onChange={(e) =>
              onChange({ ...data, target_value: e.target.value ? Number(e.target.value) : 0 })
            }
            placeholder="100"
            className="mt-1 block w-full rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-text placeholder:text-text-muted focus:border-primary focus:outline-none"
          />
        </div>

        {/* Unit */}
        <div>
          <label className="text-xs text-text-muted">Unit</label>
          <input
            type="text"
            value={(data.unit as string) ?? ''}
            onChange={(e) => onChange({ ...data, unit: e.target.value })}
            placeholder="km, books..."
            className="mt-1 block w-full rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-text placeholder:text-text-muted focus:border-primary focus:outline-none"
          />
        </div>
      </div>

      {/* Progress Bar */}
      <div className="mt-3">
        <div className="flex items-center justify-between text-xs">
          <span className="text-text-muted">Progress</span>
          <span className="font-medium text-text">{Math.round(progress)}%</span>
        </div>
        <div className="mt-1 h-2 overflow-hidden rounded-full bg-surface">
          <div
            className={`h-full rounded-full transition-all duration-300 ${
              progress >= 100 ? 'bg-success' : progress >= 60 ? 'bg-primary' : 'bg-warning'
            }`}
            style={{ width: `${progress}%` }}
          />
        </div>
      </div>

      {/* Deadline */}
      <div className="mt-3">
        <label className="text-xs text-text-muted">Deadline</label>
        <input
          type="date"
          value={(data.deadline as string) ?? ''}
          onChange={(e) => onChange({ ...data, deadline: e.target.value || undefined })}
          className="mt-1 block w-full rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-text focus:border-primary focus:outline-none"
        />
      </div>

      {/* Milestones */}
      <div className="mt-3">
        <label className="text-xs text-text-muted">Milestones</label>
        <div className="mt-2 space-y-1.5">
          {milestones.map((m, i) => (
            <div key={i} className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={m.completed}
                onChange={(e) => updateMilestone(i, 'completed', e.target.checked)}
                className="rounded border-border accent-primary"
              />
              <input
                type="text"
                value={m.title}
                onChange={(e) => updateMilestone(i, 'title', e.target.value)}
                placeholder="Milestone..."
                className={`min-w-0 flex-1 rounded-md border border-border bg-surface px-2 py-1 text-xs text-text placeholder:text-text-muted focus:border-primary focus:outline-none ${
                  m.completed ? 'line-through opacity-50' : ''
                }`}
              />
              <button
                onClick={() => removeMilestone(i)}
                className="rounded p-0.5 text-text-muted transition-colors hover:text-danger"
              >
                <Trash2 className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
        <button
          onClick={addMilestone}
          className="mt-2 flex items-center gap-1 text-xs text-primary transition-colors hover:text-primary/80"
        >
          <Plus className="h-3 w-3" /> Add milestone
        </button>
      </div>
    </div>
  );
}
