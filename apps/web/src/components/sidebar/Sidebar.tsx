import { useEffect } from 'react';
import { Inbox, Calendar, LayoutGrid, Settings, Pin, X } from 'lucide-react';
import { useNavigationStore } from '../../stores/navigation.ts';
import { useSettingsStore } from '../../stores/settings.ts';
import { trpc } from '../../lib/trpc.ts';

interface PinnedEntity {
  id: string;
  order: number;
}

export function Sidebar() {
  const { activeView, selectedEntityId, goBack, openCalendar, openHub, openSettings, openEntity } = useNavigationStore();
  const { settings, fetchSettings, unpinEntity } = useSettingsStore();

  useEffect(() => {
    fetchSettings();
  }, [fetchSettings]);

  const pinnedEntities = (settings?.pinnedEntities ?? []) as PinnedEntity[];

  return (
    <aside className="hidden w-[200px] shrink-0 flex-col border-r border-border bg-surface-dim md:flex">
      {/* Navigation */}
      <nav className="flex-1 p-2">
        <button
          onClick={goBack}
          className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm transition-colors duration-150 ${
            activeView === 'list' || activeView === 'detail'
              ? 'bg-surface-hover text-text'
              : 'text-text-secondary hover:bg-surface-hover hover:text-text'
          }`}
        >
          <Inbox className="h-4 w-4 shrink-0" />
          <span>All Entities</span>
        </button>

        <button
          onClick={openCalendar}
          className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm transition-colors duration-150 ${
            activeView === 'calendar'
              ? 'bg-surface-hover text-text'
              : 'text-text-secondary hover:bg-surface-hover hover:text-text'
          }`}
        >
          <Calendar className="h-4 w-4 shrink-0" />
          <span>Calendar</span>
        </button>

        <button
          onClick={openHub}
          className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm transition-colors duration-150 ${
            activeView === 'hub' || activeView === 'budget' || activeView === 'fitness' || activeView === 'nutrition' || activeView === 'habits' || activeView === 'custom-view'
              ? 'bg-surface-hover text-text'
              : 'text-text-secondary hover:bg-surface-hover hover:text-text'
          }`}
        >
          <LayoutGrid className="h-4 w-4 shrink-0" />
          <span>Hub</span>
        </button>

        {/* Pinned section */}
        {pinnedEntities.length > 0 && (
          <div className="mt-6 px-2.5">
            <div className="flex items-center gap-1.5">
              <Pin className="h-3 w-3 text-text-muted" />
              <span className="text-[11px] font-medium uppercase tracking-wider text-text-muted">
                Pinned
              </span>
            </div>
            <div className="mt-2 space-y-0.5">
              {pinnedEntities
                .sort((a, b) => a.order - b.order)
                .map((pin) => (
                  <PinnedEntityRow
                    key={pin.id}
                    entityId={pin.id}
                    isActive={selectedEntityId === pin.id}
                    onOpen={() => openEntity(pin.id)}
                    onUnpin={() => unpinEntity(pin.id)}
                  />
                ))}
            </div>
          </div>
        )}
      </nav>

      {/* Footer */}
      <div className="border-t border-border p-2">
        <button
          onClick={openSettings}
          className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm transition-colors duration-150 ${
            activeView === 'settings'
              ? 'bg-surface-hover text-text'
              : 'text-text-secondary hover:bg-surface-hover hover:text-text'
          }`}
        >
          <Settings className="h-4 w-4 shrink-0" />
          <span>Settings</span>
        </button>
        <p className="mt-1 px-2.5 text-[11px] text-text-muted">Orbis v0.1</p>
      </div>
    </aside>
  );
}

function PinnedEntityRow({
  entityId,
  isActive,
  onOpen,
  onUnpin,
}: {
  entityId: string;
  isActive: boolean;
  onOpen: () => void;
  onUnpin: () => void;
}) {
  const { data: entity } = trpc.entity.get.useQuery({ id: entityId });

  if (!entity) return null;

  return (
    <div
      className={`group flex items-center gap-1.5 rounded-md px-2 py-1 transition-colors duration-150 ${
        isActive ? 'bg-surface-hover text-text' : 'text-text-secondary hover:bg-surface-hover hover:text-text'
      }`}
    >
      <button onClick={onOpen} className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
        {entity.emoji && <span className="text-xs">{entity.emoji}</span>}
        <span className="truncate text-xs">{entity.title}</span>
      </button>
      <button
        onClick={(e) => {
          e.stopPropagation();
          onUnpin();
        }}
        className="hidden shrink-0 rounded p-0.5 text-text-muted hover:text-text group-hover:block"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}
