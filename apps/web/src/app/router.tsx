import { BrowserScreen } from '../features/browser/BrowserScreen';
import { ChatScreen } from '../features/chat/ChatScreen';
import { DetailScreen } from '../features/entity-detail/DetailScreen';
import { SettingsScreen } from '../features/settings/SettingsScreen';
import { type ScreenRef, type Tab, useNav } from '../state/navigation';
import { useRetryBuffer } from '../state/retry';

const TABS: { id: Tab; label: string; icon: string; enabled: boolean }[] = [
  { id: 'chat', label: 'Chat', icon: '💬', enabled: true },
  { id: 'browser', label: 'Browser', icon: '🗂', enabled: true },
  { id: 'agenda', label: 'Agenda', icon: '📅', enabled: false },
  { id: 'budget', label: 'Budget', icon: '💸', enabled: false },
];

export function TabBar() {
  const activeTab = useNav((s) => s.activeTab);
  const switchTab = useNav((s) => s.switchTab);
  const chatBadge = useRetryBuffer((s) => s.size); // §1.5

  return (
    // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: tablist — корректная роль для таб-бара; nav сохраняем как landmark
    <nav role="tablist" aria-label="Разделы" className="flex border-t border-line bg-surface">
      {TABS.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          aria-selected={activeTab === t.id}
          aria-label={t.label}
          disabled={!t.enabled}
          data-testid={`tab-${t.id}`}
          onClick={() => t.enabled && switchTab(t.id)}
          className="relative flex flex-1 flex-col items-center gap-0.5 py-2 text-xs disabled:opacity-40 aria-selected:text-accent"
        >
          <span aria-hidden>{t.icon}</span>
          {t.label}
          {t.id === 'chat' && chatBadge > 0 && (
            <span
              data-testid="chat-badge"
              className="absolute right-4 top-1 rounded-full bg-danger px-1.5 text-[10px] text-danger-foreground"
            >
              {chatBadge}
            </span>
          )}
        </button>
      ))}
    </nav>
  );
}

// Расширяется задачами 9/12/14: рендер реальных экранов по верхушке стека.
export function ActiveScreen() {
  const activeTab = useNav((s) => s.activeTab);
  const stack = useNav((s) => s.stacks[activeTab]);
  const top = stack[stack.length - 1];
  return (
    <main
      data-testid="tab-content"
      data-tab={activeTab}
      data-depth={stack.length}
      className="flex-1 overflow-y-auto"
    >
      {renderScreen(activeTab, top)}
    </main>
  );
}

function renderScreen(activeTab: Tab, top: ScreenRef | undefined) {
  if (!top) {
    if (activeTab === 'chat') return <ChatScreen />;
    if (activeTab === 'browser') return <BrowserScreen />;
  } else if (top.kind === 'entity') {
    return <DetailScreen entityId={top.id} />;
  } else if (top.kind === 'settings') {
    return <SettingsScreen />;
  }
  return (
    <div className="p-4 text-sm text-text-secondary">
      {top ? `${top.kind}` : `Экран: ${activeTab}`}
    </div>
  );
}
