import { trpc } from '../../lib/trpc.ts';
import { useSettingsStore } from '../../stores/settings.ts';

interface AspectsTabProps {
  onCreateCustom: () => void;
}

export function AspectsTab({ onCreateCustom }: AspectsTabProps) {
  const { data: aspects } = trpc.aspect.list.useQuery();
  const { settings, fetchSettings } = useSettingsStore();
  const activateMutation = trpc.aspect.activate.useMutation({ onSuccess: () => fetchSettings() });
  const deactivateMutation = trpc.aspect.deactivate.useMutation({ onSuccess: () => fetchSettings() });

  const statuses = (settings?.aspectStatuses as Record<string, string>) ?? {};

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-text-muted uppercase tracking-wider">Aspects</span>
        <button
          onClick={onCreateCustom}
          className="rounded-md bg-primary px-3 py-1 text-xs text-white transition-colors hover:bg-primary/80"
        >
          Create Custom
        </button>
      </div>

      {aspects?.map((aspect) => {
        const status = statuses[aspect.id] ?? 'inactive';
        const isActive = status === 'active';
        const isBuiltIn = !aspect.userId;

        return (
          <div key={aspect.id} className="flex items-center justify-between rounded-lg border border-border bg-surface-dim px-3 py-2">
            <div className="min-w-0">
              <p className="text-xs font-medium text-text">{aspect.name}</p>
              <p className="text-[10px] text-text-muted">{aspect.id}{isBuiltIn ? '' : ' (custom)'}</p>
            </div>
            <button
              onClick={() => {
                if (isActive) deactivateMutation.mutate({ aspectId: aspect.id });
                else activateMutation.mutate({ aspectId: aspect.id });
              }}
              className={`rounded-full px-2.5 py-0.5 text-[10px] font-medium transition-colors ${
                isActive
                  ? 'bg-success/15 text-success'
                  : 'bg-surface-hover text-text-muted'
              }`}
            >
              {isActive ? 'Active' : 'Inactive'}
            </button>
          </div>
        );
      })}
    </div>
  );
}
