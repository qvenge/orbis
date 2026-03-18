import { useState, useRef } from 'react';
import { Download, Upload } from 'lucide-react';
import { useSettingsStore } from '../../stores/settings.ts';
import { trpc } from '../../lib/trpc.ts';
import { exportViewPackage, validateViewPackage } from '@orbis/shared';
import type { CustomViewConfig } from '@orbis/shared';

interface ViewsTabProps {
  installedViews: string[];
  onUninstall: (id: string) => void;
}

export function ViewsTab({ installedViews, onUninstall }: ViewsTabProps) {
  const { settings, fetchSettings } = useSettingsStore();
  const { data: aspects } = trpc.aspect.list.useQuery();
  const createAspectMutation = trpc.aspect.create.useMutation({ onSuccess: () => fetchSettings() });
  const updateSettingsMutation = trpc.user.updateSettings.useMutation({ onSuccess: () => fetchSettings() });
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [importError, setImportError] = useState<string | null>(null);

  const customViews = ((settings?.viewPreferences as Record<string, unknown>)?.customViews as CustomViewConfig[]) ?? [];

  function handleExport(view: CustomViewConfig) {
    const aspectDef = aspects?.find((a) => a.id === view.aspectId);
    if (!aspectDef) return;

    const json = exportViewPackage(
      {
        id: aspectDef.id,
        name: aspectDef.name,
        schema: aspectDef.schema as Record<string, unknown>,
        aiInstructions: aspectDef.aiInstructions ?? undefined,
        tagMappings: aspectDef.tagMappings,
      },
      view,
    );

    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `orbis-view-${view.id}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function handleImportFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setImportError(null);

    const reader = new FileReader();
    reader.onload = async (ev) => {
      const json = ev.target?.result as string;
      const result = validateViewPackage(json);

      if ('error' in result) {
        setImportError(result.error);
        return;
      }

      const existing = aspects?.find((a) => a.id === result.aspect.id);
      if (!existing) {
        await createAspectMutation.mutateAsync({
          id: result.aspect.id,
          name: result.aspect.name,
          schema: result.aspect.schema,
          aiInstructions: result.aspect.aiInstructions,
          tagMappings: result.aspect.tagMappings,
        });
      }

      const updatedViews = [...customViews, result.view];
      const viewPrefs = (settings?.viewPreferences as Record<string, unknown>) ?? {};
      await updateSettingsMutation.mutateAsync({
        viewPreferences: { ...viewPrefs, customViews: updatedViews },
      });
    };
    reader.readAsText(file);

    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-text-muted uppercase tracking-wider">Installed Views</span>
        <button
          onClick={() => fileInputRef.current?.click()}
          className="flex items-center gap-1 rounded-md bg-primary px-2.5 py-1 text-xs text-white transition-colors hover:bg-primary/80"
        >
          <Upload className="h-3 w-3" />
          Import
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".json"
          onChange={handleImportFile}
          className="hidden"
        />
      </div>

      {importError && (
        <p className="text-xs text-danger">{importError}</p>
      )}

      {installedViews.length === 0 && customViews.length === 0 ? (
        <p className="text-xs text-text-muted">No views installed. Browse the Hub catalog to add views.</p>
      ) : (
        <>
          {installedViews.map((viewId) => (
            <div key={viewId} className="flex items-center justify-between rounded-lg border border-border bg-surface-dim px-3 py-2">
              <span className="text-xs font-medium text-text">{viewId}</span>
              <button
                onClick={() => onUninstall(viewId)}
                className="text-[10px] text-danger hover:text-danger/80"
              >
                Uninstall
              </button>
            </div>
          ))}

          {customViews.map((view) => (
            <div key={view.id} className="flex items-center justify-between rounded-lg border border-border bg-surface-dim px-3 py-2">
              <div className="min-w-0">
                <p className="text-xs font-medium text-text">{view.name}</p>
                <p className="text-[10px] text-text-muted">{view.aspectId} ({view.layout})</p>
              </div>
              <button
                onClick={() => handleExport(view)}
                className="flex items-center gap-1 rounded-md px-2 py-0.5 text-[10px] text-text-secondary transition-colors hover:bg-surface-hover hover:text-text"
              >
                <Download className="h-3 w-3" />
                Export
              </button>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
