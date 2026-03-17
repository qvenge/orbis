import { NOTE_CONTENT_TYPES } from '@orbis/shared';

interface NoteAspectCardProps {
  data: Record<string, unknown>;
  onChange: (data: Record<string, unknown>) => void;
}

export function NoteAspectCard({ data, onChange }: NoteAspectCardProps) {
  return (
    <div className="rounded-lg border border-border bg-surface-dim p-3">
      <p className="mb-3 text-xs font-medium uppercase tracking-wider text-text-muted">Note</p>

      <div className="grid grid-cols-2 gap-3">
        {/* Content Type */}
        <div>
          <label className="text-xs text-text-muted">Content type</label>
          <select
            value={(data.content_type as string) ?? 'markdown'}
            onChange={(e) => onChange({ ...data, content_type: e.target.value })}
            className="mt-1 block w-full rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-text focus:border-primary focus:outline-none"
          >
            {NOTE_CONTENT_TYPES.map((t) => (
              <option key={t} value={t}>
                {t.charAt(0).toUpperCase() + t.slice(1)}
              </option>
            ))}
          </select>
        </div>

        {/* Pinned */}
        <div className="flex items-end pb-1">
          <label className="flex items-center gap-2 text-xs text-text-muted">
            <input
              type="checkbox"
              checked={data.pinned === true}
              onChange={(e) => onChange({ ...data, pinned: e.target.checked })}
              className="rounded border-border accent-primary"
            />
            Pinned
          </label>
        </div>
      </div>
    </div>
  );
}
