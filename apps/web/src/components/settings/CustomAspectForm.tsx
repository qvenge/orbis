import { useState } from 'react';
import { X, Plus, Trash2 } from 'lucide-react';
import { trpc } from '../../lib/trpc.ts';
import { useSettingsStore } from '../../stores/settings.ts';

interface Field {
  name: string;
  type: 'string' | 'number' | 'boolean';
  description: string;
}

const FIELD_TYPES = ['string', 'number', 'boolean'] as const;

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

export function CustomAspectForm({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState('');
  const [fields, setFields] = useState<Field[]>([{ name: '', type: 'string', description: '' }]);
  const [aiInstructions, setAiInstructions] = useState('');
  const [tagMappings, setTagMappings] = useState('');
  const { fetchSettings } = useSettingsStore();

  const createMutation = trpc.aspect.create.useMutation({
    onSuccess: async () => {
      await fetchSettings();
      onClose();
    },
  });

  const id = name ? `user/${slugify(name)}` : 'user/...';

  const addField = () => setFields([...fields, { name: '', type: 'string', description: '' }]);

  const removeField = (idx: number) => setFields(fields.filter((_, i) => i !== idx));

  const updateField = (idx: number, key: keyof Field, value: string) => {
    const updated = [...fields];
    updated[idx] = { ...updated[idx], [key]: value };
    setFields(updated);
  };

  const handleSubmit = () => {
    if (!name.trim()) return;
    const validFields = fields.filter((f) => f.name.trim());
    if (validFields.length === 0) return;

    const properties: Record<string, { type: string; description?: string }> = {};
    for (const f of validFields) {
      properties[f.name.trim()] = {
        type: f.type,
        ...(f.description ? { description: f.description } : {}),
      };
    }

    const tags = tagMappings
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);

    createMutation.mutate({
      id: `user/${slugify(name)}`,
      name: name.trim(),
      schema: { type: 'object', properties },
      aiInstructions: aiInstructions.trim() || undefined,
      tagMappings: tags,
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="mx-4 w-full max-w-md rounded-xl border border-border bg-surface p-5">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-text">Create Custom Aspect</h3>
          <button onClick={onClose} className="rounded-md p-1 text-text-muted hover:text-text">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Name */}
        <div className="mb-3">
          <label className="mb-1 block text-xs text-text-secondary">Name</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Movies"
            className="w-full rounded-md border border-border bg-surface-dim px-3 py-1.5 text-sm text-text placeholder:text-text-muted focus:border-primary focus:outline-none"
          />
          <p className="mt-0.5 text-[10px] text-text-muted">ID: {id}</p>
        </div>

        {/* Fields */}
        <div className="mb-3">
          <div className="mb-1 flex items-center justify-between">
            <label className="text-xs text-text-secondary">Fields</label>
            <button onClick={addField} className="flex items-center gap-1 text-[10px] text-primary hover:text-primary/80">
              <Plus className="h-3 w-3" /> Add
            </button>
          </div>
          <div className="space-y-2">
            {fields.map((field, idx) => (
              <div key={idx} className="flex items-start gap-1.5">
                <input
                  value={field.name}
                  onChange={(e) => updateField(idx, 'name', e.target.value)}
                  placeholder="field name"
                  className="w-24 rounded-md border border-border bg-surface-dim px-2 py-1 text-xs text-text placeholder:text-text-muted focus:border-primary focus:outline-none"
                />
                <select
                  value={field.type}
                  onChange={(e) => updateField(idx, 'type', e.target.value)}
                  className="rounded-md border border-border bg-surface-dim px-1.5 py-1 text-xs text-text"
                >
                  {FIELD_TYPES.map((t) => (
                    <option key={t} value={t}>{t}</option>
                  ))}
                </select>
                <input
                  value={field.description}
                  onChange={(e) => updateField(idx, 'description', e.target.value)}
                  placeholder="description"
                  className="min-w-0 flex-1 rounded-md border border-border bg-surface-dim px-2 py-1 text-xs text-text placeholder:text-text-muted focus:border-primary focus:outline-none"
                />
                {fields.length > 1 && (
                  <button onClick={() => removeField(idx)} className="shrink-0 p-1 text-text-muted hover:text-danger">
                    <Trash2 className="h-3 w-3" />
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* AI Instructions */}
        <div className="mb-3">
          <label className="mb-1 block text-xs text-text-secondary">AI Instructions (optional)</label>
          <textarea
            value={aiInstructions}
            onChange={(e) => setAiInstructions(e.target.value)}
            placeholder="How should the AI use this aspect?"
            rows={2}
            className="w-full resize-none rounded-md border border-border bg-surface-dim px-3 py-1.5 text-xs text-text placeholder:text-text-muted focus:border-primary focus:outline-none"
          />
        </div>

        {/* Tag Mappings */}
        <div className="mb-4">
          <label className="mb-1 block text-xs text-text-secondary">Tag Mappings (comma-separated)</label>
          <input
            value={tagMappings}
            onChange={(e) => setTagMappings(e.target.value)}
            placeholder="movie, film, cinema"
            className="w-full rounded-md border border-border bg-surface-dim px-3 py-1.5 text-xs text-text placeholder:text-text-muted focus:border-primary focus:outline-none"
          />
        </div>

        {/* Actions */}
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="rounded-md px-3 py-1.5 text-xs text-text-secondary hover:bg-surface-hover">
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={!name.trim() || fields.every((f) => !f.name.trim()) || createMutation.isPending}
            className="rounded-md bg-primary px-4 py-1.5 text-xs text-white transition-colors hover:bg-primary/80 disabled:opacity-40"
          >
            {createMutation.isPending ? 'Creating...' : 'Create Aspect'}
          </button>
        </div>

        {createMutation.error && (
          <p className="mt-2 text-xs text-danger">{createMutation.error.message}</p>
        )}
      </div>
    </div>
  );
}
