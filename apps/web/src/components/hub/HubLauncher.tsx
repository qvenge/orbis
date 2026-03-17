import { useState } from 'react';
import { Wallet, Dumbbell, UtensilsCrossed, RotateCw, Plus, LayoutGrid } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { VIEW_IDS } from '@orbis/shared';
import type { CustomViewConfig } from '@orbis/shared';
import { useNavigationStore } from '../../stores/navigation.ts';
import { useSettingsStore } from '../../stores/settings.ts';
import { ViewCatalog } from './ViewCatalog.tsx';

interface ViewMeta {
  id: string;
  name: string;
  icon: LucideIcon;
  description: string;
  category: string;
}

const VIEW_CATALOG: ViewMeta[] = [
  { id: VIEW_IDS.BUDGET, name: 'Budget', icon: Wallet, description: 'Track expenses, envelopes, and spending trends', category: 'Finance' },
  { id: VIEW_IDS.FITNESS, name: 'Fitness', icon: Dumbbell, description: 'Log workouts and track progress', category: 'Health' },
  { id: VIEW_IDS.NUTRITION, name: 'Nutrition', icon: UtensilsCrossed, description: 'Track meals and macros', category: 'Health' },
  { id: VIEW_IDS.HABITS, name: 'Habits', icon: RotateCw, description: 'Build and track daily habits', category: 'Lifestyle' },
];

export { VIEW_CATALOG };
export type { ViewMeta };

export function HubLauncher() {
  const [showCatalog, setShowCatalog] = useState(false);
  const { settings } = useSettingsStore();
  const { openBudget, openFitness, openNutrition, openHabits, openCustomView } = useNavigationStore();

  const installedViews = (settings?.installedViews as string[]) ?? [];
  const installed = VIEW_CATALOG.filter((v) => installedViews.includes(v.id));
  const customViews = (
    (settings?.viewPreferences as Record<string, unknown>)?.customViews as CustomViewConfig[] ?? []
  );

  const handleViewClick = (viewId: string) => {
    if (viewId === VIEW_IDS.BUDGET) openBudget();
    else if (viewId === VIEW_IDS.FITNESS) openFitness();
    else if (viewId === VIEW_IDS.NUTRITION) openNutrition();
    else if (viewId === VIEW_IDS.HABITS) openHabits();
  };

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold text-text">Hub</h2>
        <button
          onClick={() => setShowCatalog(true)}
          className="flex items-center gap-1 rounded-md px-2.5 py-1 text-xs text-text-secondary transition-colors duration-150 hover:bg-surface-hover hover:text-text"
        >
          <Plus className="h-3.5 w-3.5" />
          Browse Catalog
        </button>
      </div>

      <div className="flex-1 p-4">
        {installed.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <div className="mb-3 rounded-xl bg-surface-dim p-4">
              <Plus className="h-8 w-8 text-text-muted" />
            </div>
            <p className="text-sm text-text-secondary">No views installed</p>
            <p className="mt-1 text-xs text-text-muted">Browse the catalog to add specialized views</p>
            <button
              onClick={() => setShowCatalog(true)}
              className="mt-4 rounded-md bg-primary px-4 py-1.5 text-xs text-white transition-colors duration-150 hover:bg-primary/80"
            >
              Browse Catalog
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4">
            {installed.map((view) => {
              const Icon = view.icon;
              const isImplemented = true;
              return (
                <button
                  key={view.id}
                  onClick={() => handleViewClick(view.id)}
                  className={`flex flex-col items-center gap-2 rounded-lg border border-border bg-surface-dim p-5 transition-colors duration-150 ${
                    isImplemented ? 'hover:bg-surface-hover' : 'opacity-60'
                  }`}
                >
                  <div className="rounded-lg bg-surface-hover p-3">
                    <Icon className="h-6 w-6 text-primary" />
                  </div>
                  <span className="text-sm font-medium text-text">{view.name}</span>
                  {!isImplemented && (
                    <span className="text-[10px] text-text-muted">Coming soon</span>
                  )}
                </button>
              );
            })}
          </div>
        )}

        {/* Custom views */}
        {customViews.length > 0 && (
          <div className="mt-4">
            <p className="mb-2 px-1 text-[10px] font-medium uppercase tracking-wider text-text-muted">Custom Views</p>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4">
              {customViews.map((view) => (
                <button
                  key={view.id}
                  onClick={() => openCustomView(view.id)}
                  className="flex flex-col items-center gap-2 rounded-lg border border-border bg-surface-dim p-5 transition-colors duration-150 hover:bg-surface-hover"
                >
                  <div className="rounded-lg bg-surface-hover p-3">
                    <LayoutGrid className="h-6 w-6 text-primary" />
                  </div>
                  <span className="text-sm font-medium text-text">{view.name}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {showCatalog && <ViewCatalog onClose={() => setShowCatalog(false)} />}
    </div>
  );
}
