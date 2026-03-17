import { useState, lazy, Suspense } from 'react';
import { MessageSquare, List } from 'lucide-react';
import { useAuthStore } from '../stores/auth.ts';
import { useNavigationStore } from '../stores/navigation.ts';
import { Sidebar } from '../components/sidebar/Sidebar.tsx';
import { EntityList } from '../components/entity/EntityList.tsx';
import { OfflineIndicator } from '../components/common/OfflineIndicator.tsx';
import { ViewSkeleton } from '../components/common/ViewSkeleton.tsx';
import { StatusStrip } from '../components/common/StatusStrip.tsx';
import { useSettingsStore } from '../stores/settings.ts';
import type { CustomViewConfig } from '@orbis/shared';

// Lazy-loaded views
const ChatPanel = lazy(() => import('../components/chat/ChatPanel.tsx').then((m) => ({ default: m.ChatPanel })));
const EntityDetail = lazy(() => import('../components/entity/EntityDetail.tsx').then((m) => ({ default: m.EntityDetail })));
const WeekCalendar = lazy(() => import('../components/calendar/WeekCalendar.tsx').then((m) => ({ default: m.WeekCalendar })));
const HubLauncher = lazy(() => import('../components/hub/HubLauncher.tsx').then((m) => ({ default: m.HubLauncher })));
const BudgetView = lazy(() => import('../components/budget/BudgetView.tsx').then((m) => ({ default: m.BudgetView })));
const FitnessView = lazy(() => import('../components/fitness/FitnessView.tsx').then((m) => ({ default: m.FitnessView })));
const NutritionView = lazy(() => import('../components/nutrition/NutritionView.tsx').then((m) => ({ default: m.NutritionView })));
const HabitsView = lazy(() => import('../components/habits/HabitsView.tsx').then((m) => ({ default: m.HabitsView })));
const SettingsPanel = lazy(() => import('../components/settings/SettingsPanel.tsx').then((m) => ({ default: m.SettingsPanel })));
const CustomViewRenderer = lazy(() => import('../components/views/CustomViewRenderer.tsx').then((m) => ({ default: m.CustomViewRenderer })));

export function HomePage() {
  const { user, signOut } = useAuthStore();
  const { activeView, customViewId } = useNavigationStore();
  const { settings } = useSettingsStore();
  const [chatOpen, setChatOpen] = useState(true);

  function renderMainContent() {
    if (activeView === 'calendar') return <WeekCalendar />;
    if (activeView === 'hub') return <HubLauncher />;
    if (activeView === 'budget') return <BudgetView />;
    if (activeView === 'fitness') return <FitnessView />;
    if (activeView === 'nutrition') return <NutritionView />;
    if (activeView === 'habits') return <HabitsView />;
    if (activeView === 'settings') return <SettingsPanel />;
    if (activeView === 'custom-view' && customViewId) {
      const config = ((settings?.viewPreferences as Record<string, unknown>)?.customViews as CustomViewConfig[] ?? [])
        .find((v) => v.id === customViewId) ?? { id: '', name: 'View', aspectId: '', layout: 'list' as const, columns: [] };
      return <CustomViewRenderer config={config} />;
    }
    if (activeView === 'detail') return <EntityDetail />;
    return <EntityList />;
  }

  return (
    <div className="flex h-dvh flex-col bg-surface">
      <OfflineIndicator />
      <StatusStrip />
      {/* Header */}
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-border px-4">
        <span className="text-sm font-semibold tracking-wide text-text">Orbis</span>
        <div className="flex items-center gap-2">
          {/* Mobile chat toggle */}
          <button
            onClick={() => setChatOpen((o) => !o)}
            className="flex items-center justify-center rounded-md p-1.5 text-text-secondary transition-colors hover:bg-surface-hover md:hidden"
          >
            {chatOpen ? <List className="h-4 w-4" /> : <MessageSquare className="h-4 w-4" />}
          </button>
          <span className="hidden text-xs text-text-muted sm:block">{user?.email}</span>
          <button
            onClick={signOut}
            className="rounded-md px-2.5 py-1 text-xs text-text-secondary transition-colors duration-150 hover:bg-surface-hover hover:text-text"
          >
            Sign out
          </button>
        </div>
      </header>

      {/* Main layout */}
      <div className="flex flex-1 overflow-hidden">
        <Sidebar />

        {/* Main Content */}
        <div className={`flex-1 ${chatOpen ? 'hidden md:flex' : 'flex'} flex-col`}>
          <Suspense fallback={<ViewSkeleton />}>
            {renderMainContent()}
          </Suspense>
        </div>

        {/* Chat Panel */}
        <div
          className={`${chatOpen ? 'flex' : 'hidden'} w-full flex-col border-l border-border md:flex md:w-[380px] md:shrink-0`}
        >
          <Suspense fallback={<ViewSkeleton />}>
            <ChatPanel />
          </Suspense>
        </div>
      </div>
    </div>
  );
}
