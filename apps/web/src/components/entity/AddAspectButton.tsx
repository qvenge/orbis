import { useState } from 'react';
import { Plus, Zap } from 'lucide-react';
import { ASPECT_IDS } from '@orbis/shared';
import { trpc } from '../../lib/trpc.ts';
import { useSettingsStore } from '../../stores/settings.ts';

interface AddAspectButtonProps {
  currentAspects: string[];
  onAspectAdd: (aspectId: string, defaultData: Record<string, unknown>) => void;
}

const ASPECT_LABELS: Record<string, string> = {
  [ASPECT_IDS.TASK]: 'Task',
  [ASPECT_IDS.SCHEDULE]: 'Schedule',
  [ASPECT_IDS.FINANCIAL]: 'Financial',
  [ASPECT_IDS.FITNESS]: 'Fitness',
  [ASPECT_IDS.NUTRITION]: 'Nutrition',
  [ASPECT_IDS.HABIT]: 'Habit',
  [ASPECT_IDS.NOTE]: 'Note',
  [ASPECT_IDS.GOAL]: 'Goal',
};

const ASPECT_DEFAULTS: Record<string, Record<string, unknown>> = {
  [ASPECT_IDS.TASK]: { status: 'inbox', priority: 'none' },
  [ASPECT_IDS.SCHEDULE]: { start_at: new Date().toISOString() },
  [ASPECT_IDS.FINANCIAL]: { amount: 0, direction: 'expense', category: 'other' },
  [ASPECT_IDS.FITNESS]: {},
  [ASPECT_IDS.NUTRITION]: {},
  [ASPECT_IDS.HABIT]: { frequency: { type: 'daily' } },
  [ASPECT_IDS.NOTE]: {},
  [ASPECT_IDS.GOAL]: { target_value: 100, current_value: 0 },
};

export function AddAspectButton({ currentAspects, onAspectAdd }: AddAspectButtonProps) {
  const [open, setOpen] = useState(false);
  const [confirmingAspect, setConfirmingAspect] = useState<string | null>(null);
  const { settings, fetchSettings } = useSettingsStore();

  const activateAspect = trpc.aspect.activate.useMutation({
    onSuccess: () => fetchSettings(),
  });

  const aspectStatuses = (settings?.aspectStatuses ?? {}) as Record<string, string>;

  // Available aspects = all aspects minus already attached
  const allAspects = Object.values(ASPECT_IDS);
  const available = allAspects.filter((id) => !currentAspects.includes(id));

  if (available.length === 0) return null;

  const handleSelect = (aspectId: string) => {
    const status = aspectStatuses[aspectId] ?? 'passive';

    if (status === 'passive') {
      // Show confirmation for passive aspect activation
      setConfirmingAspect(aspectId);
      return;
    }

    // Active or already active — just add the aspect
    onAspectAdd(aspectId, ASPECT_DEFAULTS[aspectId] ?? {});
    setOpen(false);
  };

  const handleConfirmActivation = async () => {
    if (!confirmingAspect) return;
    await activateAspect.mutateAsync({ aspectId: confirmingAspect });
    onAspectAdd(confirmingAspect, ASPECT_DEFAULTS[confirmingAspect] ?? {});
    setConfirmingAspect(null);
    setOpen(false);
  };

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 text-xs text-text-muted transition-colors duration-150 hover:text-text-secondary"
      >
        <Plus className="h-3 w-3" /> Add aspect
      </button>

      {open && !confirmingAspect && (
        <div className="absolute left-0 top-6 z-10 w-48 overflow-hidden rounded-lg border border-border-light bg-surface-raised shadow-lg">
          {available.map((aspectId) => {
            const status = aspectStatuses[aspectId] ?? 'passive';
            return (
              <button
                key={aspectId}
                onClick={() => handleSelect(aspectId)}
                className="flex w-full items-center justify-between px-3 py-2 text-left text-xs text-text-secondary transition-colors duration-150 hover:bg-surface-hover hover:text-text"
              >
                <span>{ASPECT_LABELS[aspectId] ?? aspectId}</span>
                {status === 'passive' && (
                  <span className="rounded bg-warning/10 px-1.5 py-0.5 text-[10px] text-warning">
                    passive
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}

      {/* Activation confirmation dialog */}
      {confirmingAspect && (
        <div className="absolute left-0 top-6 z-10 w-64 rounded-lg border border-border-light bg-surface-raised p-3 shadow-lg">
          <div className="flex items-start gap-2">
            <Zap className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
            <div>
              <p className="text-xs font-medium text-text">
                Activate {ASPECT_LABELS[confirmingAspect]}?
              </p>
              <p className="mt-1 text-[11px] text-text-secondary">
                This will enable AI to automatically track this aspect for future entities.
              </p>
              <div className="mt-2 flex gap-2">
                <button
                  onClick={handleConfirmActivation}
                  disabled={activateAspect.isPending}
                  className="rounded-md bg-primary px-2.5 py-1 text-[11px] text-white transition-colors duration-150 hover:bg-primary/80 disabled:opacity-50"
                >
                  {activateAspect.isPending ? 'Activating...' : 'Activate & Add'}
                </button>
                <button
                  onClick={() => setConfirmingAspect(null)}
                  className="rounded-md px-2.5 py-1 text-[11px] text-text-secondary transition-colors duration-150 hover:bg-surface-hover"
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
