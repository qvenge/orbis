import { useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { useNavigationStore } from '../../stores/navigation.ts';
import { useSettingsStore } from '../../stores/settings.ts';
import { IconButton } from '../ui/IconButton.tsx';
import { ProfileTab } from './ProfileTab.tsx';
import { AspectsTab } from './AspectsTab.tsx';
import { ViewsTab } from './ViewsTab.tsx';
import { CustomAspectForm } from './CustomAspectForm.tsx';

const TABS = ['Profile', 'Aspects', 'Views'] as const;
type Tab = (typeof TABS)[number];

export function SettingsPanel() {
  const { navigate } = useNavigationStore();
  const { settings, fetchSettings, uninstallView } = useSettingsStore();
  const [tab, setTab] = useState<Tab>('Profile');
  const [showAspectForm, setShowAspectForm] = useState(false);

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      {/* Header */}
      <div className="flex items-center gap-3 border-b border-border px-4 py-3">
        <IconButton icon={ArrowLeft} label="Go back" onClick={() => navigate('hub')} />
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
        {tab === 'Aspects' && <AspectsTab onCreateCustom={() => setShowAspectForm(true)} />}
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
