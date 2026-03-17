import { X, Check, Download } from 'lucide-react';
import { useSettingsStore } from '../../stores/settings.ts';
import { VIEW_CATALOG } from './HubLauncher.tsx';

interface ViewCatalogProps {
  onClose: () => void;
}

const CATEGORIES = ['Finance', 'Health', 'Lifestyle'];

export function ViewCatalog({ onClose }: ViewCatalogProps) {
  const { settings, installView, uninstallView } = useSettingsStore();
  const installedViews = (settings?.installedViews as string[]) ?? [];

  const handleToggle = async (viewId: string) => {
    if (installedViews.includes(viewId)) {
      await uninstallView(viewId);
    } else {
      await installView(viewId);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="mx-4 w-full max-w-md rounded-xl border border-border bg-surface-raised shadow-2xl">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h3 className="text-sm font-semibold text-text">View Catalog</h3>
          <button
            onClick={onClose}
            className="rounded-md p-1 text-text-muted transition-colors duration-150 hover:bg-surface-hover hover:text-text"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="max-h-[60vh] overflow-y-auto p-4">
          {CATEGORIES.map((category) => {
            const views = VIEW_CATALOG.filter((v) => v.category === category);
            if (views.length === 0) return null;
            return (
              <div key={category} className="mb-4 last:mb-0">
                <p className="mb-2 text-[11px] font-medium uppercase tracking-wider text-text-muted">
                  {category}
                </p>
                <div className="space-y-2">
                  {views.map((view) => {
                    const Icon = view.icon;
                    const isInstalled = installedViews.includes(view.id);
                    return (
                      <div
                        key={view.id}
                        className="flex items-center gap-3 rounded-lg border border-border bg-surface-dim p-3"
                      >
                        <div className="rounded-md bg-surface-hover p-2">
                          <Icon className="h-4 w-4 text-primary" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-text">{view.name}</p>
                          <p className="text-xs text-text-muted">{view.description}</p>
                        </div>
                        <button
                          onClick={() => handleToggle(view.id)}
                          className={`flex shrink-0 items-center gap-1 rounded-md px-2.5 py-1 text-xs transition-colors duration-150 ${
                            isInstalled
                              ? 'bg-success/10 text-success hover:bg-danger/10 hover:text-danger'
                              : 'bg-primary/10 text-primary hover:bg-primary/20'
                          }`}
                        >
                          {isInstalled ? (
                            <>
                              <Check className="h-3 w-3" />
                              Installed
                            </>
                          ) : (
                            <>
                              <Download className="h-3 w-3" />
                              Install
                            </>
                          )}
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
