import { Inbox, Calendar, LayoutGrid, MessageSquare, Settings } from 'lucide-react';
import { useNavigationStore } from '../../stores/navigation.ts';

interface MobileBottomNavProps {
  chatOpen: boolean;
  onToggleChat: () => void;
}

const NAV_ITEMS = [
  { view: 'list' as const, icon: Inbox, label: 'Entities', matchViews: ['list', 'detail'] },
  { view: 'calendar' as const, icon: Calendar, label: 'Calendar', matchViews: ['calendar'] },
  { view: 'hub' as const, icon: LayoutGrid, label: 'Hub', matchViews: ['hub', 'budget', 'fitness', 'nutrition', 'habits', 'custom-view'] },
  { view: 'chat' as const, icon: MessageSquare, label: 'Chat', matchViews: [] },
  { view: 'settings' as const, icon: Settings, label: 'Settings', matchViews: ['settings'] },
] as const;

export function MobileBottomNav({ chatOpen, onToggleChat }: MobileBottomNavProps) {
  const { activeView, navigate, goBack } = useNavigationStore();

  return (
    <nav className="flex shrink-0 items-center border-t border-border bg-surface-dim pb-[env(safe-area-inset-bottom)] md:hidden">
      {NAV_ITEMS.map((item) => {
        const isChat = item.view === 'chat';
        const isActive = isChat
          ? chatOpen
          : item.matchViews.includes(activeView as typeof item.matchViews[number]);

        return (
          <button
            key={item.view}
            onClick={() => {
              if (isChat) {
                onToggleChat();
              } else {
                if (item.view === 'list') {
                  goBack();
                } else {
                  navigate(item.view);
                }
              }
            }}
            className={`flex flex-1 flex-col items-center gap-0.5 py-2 text-[10px] transition-colors ${
              isActive
                ? 'text-primary'
                : 'text-text-muted'
            }`}
            aria-label={item.label}
          >
            <item.icon className="h-5 w-5" />
            <span>{item.label}</span>
          </button>
        );
      })}
    </nav>
  );
}
