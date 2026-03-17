import { useState, useRef } from 'react';
import { ArrowLeft, Download, Upload } from 'lucide-react';
import { useNavigationStore } from '../../stores/navigation.ts';
import { useSettingsStore } from '../../stores/settings.ts';
import { trpc } from '../../lib/trpc.ts';
import { CustomAspectForm } from './CustomAspectForm.tsx';
import { exportViewPackage, validateViewPackage } from '@orbis/shared';
import type { CustomViewConfig } from '@orbis/shared';

const TABS = ['Profile', 'Aspects', 'Views'] as const;
type Tab = (typeof TABS)[number];

const TIMEZONES = [
  'Europe/Moscow',
  'Europe/London',
  'America/New_York',
  'America/Chicago',
  'America/Los_Angeles',
  'Asia/Tokyo',
  'Asia/Shanghai',
  'Asia/Kolkata',
  'Australia/Sydney',
];

const CURRENCIES = ['RUB', 'USD', 'EUR', 'GBP', 'JPY', 'CNY', 'INR', 'KZT'];
const WEEK_DAYS = ['monday', 'sunday', 'saturday'];

export function SettingsPanel() {
  const { openHub } = useNavigationStore();
  const { settings, fetchSettings, uninstallView } = useSettingsStore();
  const [tab, setTab] = useState<Tab>('Profile');
  const [showAspectForm, setShowAspectForm] = useState(false);

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      {/* Header */}
      <div className="flex items-center gap-3 border-b border-border px-4 py-3">
        <button onClick={openHub} className="rounded-md p-1 text-text-secondary transition-colors hover:bg-surface-hover hover:text-text">
          <ArrowLeft className="h-4 w-4" />
        </button>
        <h2 className="text-sm font-semibold text-text">Settings</h2>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-border/40 px-4">
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`border-b-2 px-3 py-2 text-xs font-medium transition-colors ${
              tab === t
                ? 'border-primary text-primary'
                : 'border-transparent text-text-secondary hover:text-text'
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="flex-1 p-4">
        {tab === 'Profile' && <ProfileTab />}
        {tab === 'Aspects' && (
          <AspectsTab
            onCreateCustom={() => setShowAspectForm(true)}
          />
        )}
        {tab === 'Views' && (
          <ViewsTab
            installedViews={(settings?.installedViews as string[]) ?? []}
            onUninstall={async (id) => {
              await uninstallView(id);
              await fetchSettings();
            }}
          />
        )}
      </div>

      {showAspectForm && (
        <CustomAspectForm onClose={() => setShowAspectForm(false)} />
      )}
    </div>
  );
}

function ProfileTab() {
  const { settings, fetchSettings } = useSettingsStore();
  const updateMutation = trpc.user.updateSettings.useMutation({
    onSuccess: () => fetchSettings(),
  });

  if (!settings) return null;

  const handleChange = (field: string, value: string) => {
    updateMutation.mutate({ [field]: value });
  };

  return (
    <div className="space-y-4">
      <SettingRow label="Timezone">
        <select
          value={settings.timezone ?? 'Europe/Moscow'}
          onChange={(e) => handleChange('timezone', e.target.value)}
          className="rounded-md border border-border bg-surface-dim px-2.5 py-1.5 text-xs text-text"
        >
          {TIMEZONES.map((tz) => (
            <option key={tz} value={tz}>{tz}</option>
          ))}
        </select>
      </SettingRow>

      <SettingRow label="Currency">
        <select
          value={settings.defaultCurrency ?? 'RUB'}
          onChange={(e) => handleChange('defaultCurrency', e.target.value)}
          className="rounded-md border border-border bg-surface-dim px-2.5 py-1.5 text-xs text-text"
        >
          {CURRENCIES.map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
      </SettingRow>

      <SettingRow label="Week starts on">
        <select
          value={settings.weekStartDay ?? 'monday'}
          onChange={(e) => handleChange('weekStartDay', e.target.value)}
          className="rounded-md border border-border bg-surface-dim px-2.5 py-1.5 text-xs text-text"
        >
          {WEEK_DAYS.map((d) => (
            <option key={d} value={d}>{d.charAt(0).toUpperCase() + d.slice(1)}</option>
          ))}
        </select>
      </SettingRow>
    </div>
  );
}

function SettingRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-xs text-text-secondary">{label}</span>
      {children}
    </div>
  );
}

function AspectsTab({ onCreateCustom }: { onCreateCustom: () => void }) {
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

function ViewsTab({ installedViews, onUninstall }: { installedViews: string[]; onUninstall: (id: string) => void }) {
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

      // Create aspect if it doesn't exist
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

      // Add view to settings
      const updatedViews = [...customViews, result.view];
      const viewPrefs = (settings?.viewPreferences as Record<string, unknown>) ?? {};
      await updateSettingsMutation.mutateAsync({
        viewPreferences: { ...viewPrefs, customViews: updatedViews },
      });
    };
    reader.readAsText(file);

    // Reset input
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
