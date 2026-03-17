import { useState } from 'react';
import { X } from 'lucide-react';
import type { CustomViewConfig } from '@orbis/shared';
import { trpc } from '../../lib/trpc.ts';
import { useSettingsStore } from '../../stores/settings.ts';

interface CustomViewFormProps {
  onClose: () => void;
}

export function CustomViewForm({ onClose }: CustomViewFormProps) {
  const { data: aspects } = trpc.aspect.list.useQuery();
  const { settings, fetchSettings } = useSettingsStore();
  const updateMutation = trpc.user.updateSettings.useMutation({
    onSuccess: async () => {
      await fetchSettings();
      onClose();
    },
  });

  const [step, setStep] = useState(1);
  const [aspectId, setAspectId] = useState('');
  const [layout, setLayout] = useState<'list' | 'table'>('list');
  const [columns, setColumns] = useState<string[]>([]);
  const [name, setName] = useState('');

  // Get user-created aspects
  const userAspects = aspects?.filter((a) => a.userId) ?? [];
  const selectedAspect = aspects?.find((a) => a.id === aspectId);
  const schemaProps = selectedAspect
    ? Object.keys((selectedAspect.schema as { properties?: Record<string, unknown> })?.properties ?? {})
    : [];

  const handleCreate = () => {
    if (!name.trim() || !aspectId) return;

    const config: CustomViewConfig = {
      id: `custom-${Date.now()}`,
      name: name.trim(),
      aspectId,
      layout,
      columns,
    };

    const existing = (settings?.viewPreferences as Record<string, unknown>) ?? {};
    const customViews = Array.isArray(existing.customViews) ? [...existing.customViews, config] : [config];

    updateMutation.mutate({
      viewPreferences: { ...existing, customViews },
    });
  };

  const toggleColumn = (col: string) => {
    setColumns((prev) =>
      prev.includes(col) ? prev.filter((c) => c !== col) : [...prev, col],
    );
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="mx-4 w-full max-w-sm rounded-xl border border-border bg-surface p-5">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-text">Create Custom View</h3>
          <button onClick={onClose} className="rounded-md p-1 text-text-muted hover:text-text">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Step 1: Select Aspect */}
        {step === 1 && (
          <div>
            <p className="mb-2 text-xs text-text-secondary">Select an aspect</p>
            {userAspects.length === 0 ? (
              <p className="py-4 text-center text-xs text-text-muted">
                No custom aspects yet. Create one in Settings → Aspects first.
              </p>
            ) : (
              <div className="space-y-1.5">
                {userAspects.map((a) => (
                  <button
                    key={a.id}
                    onClick={() => { setAspectId(a.id); setStep(2); }}
                    className={`w-full rounded-lg border px-3 py-2 text-left text-xs transition-colors ${
                      aspectId === a.id ? 'border-primary bg-primary/10' : 'border-border hover:bg-surface-hover'
                    }`}
                  >
                    <span className="font-medium text-text">{a.name}</span>
                    <span className="ml-2 text-text-muted">{a.id}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Step 2: Layout */}
        {step === 2 && (
          <div>
            <p className="mb-2 text-xs text-text-secondary">Choose layout</p>
            <div className="flex gap-2">
              {(['list', 'table'] as const).map((l) => (
                <button
                  key={l}
                  onClick={() => { setLayout(l); setStep(3); }}
                  className={`flex-1 rounded-lg border px-3 py-3 text-center text-xs font-medium transition-colors ${
                    layout === l ? 'border-primary bg-primary/10 text-primary' : 'border-border text-text-secondary hover:bg-surface-hover'
                  }`}
                >
                  {l.charAt(0).toUpperCase() + l.slice(1)}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Step 3: Columns */}
        {step === 3 && (
          <div>
            <p className="mb-2 text-xs text-text-secondary">Select columns to display</p>
            <div className="space-y-1.5">
              {schemaProps.map((prop) => (
                <label key={prop} className="flex items-center gap-2 text-xs text-text">
                  <input
                    type="checkbox"
                    checked={columns.includes(prop)}
                    onChange={() => toggleColumn(prop)}
                    className="rounded"
                  />
                  {prop}
                </label>
              ))}
            </div>
            <button
              onClick={() => setStep(4)}
              disabled={columns.length === 0}
              className="mt-3 w-full rounded-md bg-primary px-3 py-1.5 text-xs text-white disabled:opacity-40"
            >
              Next
            </button>
          </div>
        )}

        {/* Step 4: Name */}
        {step === 4 && (
          <div>
            <p className="mb-2 text-xs text-text-secondary">Name your view</p>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. My Movies"
              className="mb-3 w-full rounded-md border border-border bg-surface-dim px-3 py-1.5 text-sm text-text placeholder:text-text-muted focus:border-primary focus:outline-none"
              autoFocus
            />
            <button
              onClick={handleCreate}
              disabled={!name.trim() || updateMutation.isPending}
              className="w-full rounded-md bg-primary px-3 py-1.5 text-xs text-white disabled:opacity-40"
            >
              {updateMutation.isPending ? 'Creating...' : 'Create View'}
            </button>
          </div>
        )}

        {/* Back button for steps > 1 */}
        {step > 1 && (
          <button
            onClick={() => setStep(step - 1)}
            className="mt-2 text-xs text-text-muted hover:text-text"
          >
            Back
          </button>
        )}
      </div>
    </div>
  );
}
