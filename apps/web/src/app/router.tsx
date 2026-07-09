import { FolderOpen, type LucideIcon, MessageSquare } from 'lucide-react';
import { BrowserScreen } from '../features/browser/BrowserScreen';
import { ChatScreen } from '../features/chat/ChatScreen';
import { ChatThread } from '../features/chat/ChatThread';
import { DetailScreen } from '../features/entity-detail/DetailScreen';
import { SettingsScreen } from '../features/settings/SettingsScreen';
import { type ScreenRef, type Tab, useNav } from '../state/navigation';
import { useRetryBuffer } from '../state/retry';
import { ScreenHeader } from './ScreenHeader';

// Только реальные разделы: agenda/budget убраны из навигации (тип Tab в navigation.ts
// шире — persist 'orbis:nav:v1' может содержать старые стеки, его не сужаем).
const TABS: { id: Tab; label: string; icon: LucideIcon }[] = [
  { id: 'chat', label: 'Чат', icon: MessageSquare },
  { id: 'browser', label: 'Обзор', icon: FolderOpen },
];

// Нижний tab-bar — только мобила (md:hidden); на десктопе навигация в SidebarNav.
export function TabBar() {
  const activeTab = useNav((s) => s.activeTab);
  const switchTab = useNav((s) => s.switchTab);
  const chatBadge = useRetryBuffer((s) => s.size); // §1.5

  // Мобила: safe-area снизу; на десктопе скрыт (md:hidden) — навигация в SidebarNav.
  const cls = 'flex border-t border-line bg-surface pb-[env(safe-area-inset-bottom)] md:hidden';
  return (
    // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: tablist — корректная роль для таб-бара; nav сохраняем как landmark
    <nav role="tablist" aria-label="Разделы" className={cls}>
      {TABS.map((t) => {
        const active = activeTab === t.id;
        const Icon = t.icon;
        return (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={active}
            aria-label={t.label}
            data-testid={`tab-${t.id}`}
            onClick={() => switchTab(t.id)}
            className={`relative flex flex-1 cursor-pointer flex-col items-center gap-0.5 py-2 text-xs transition ${
              active ? 'text-text' : 'text-text-secondary'
            }`}
          >
            {/* Спокойный accent-индикатор активного таба */}
            {active && (
              <span
                aria-hidden
                className="absolute inset-x-8 top-0 h-0.5 rounded-b-full bg-accent"
              />
            )}
            <Icon size={18} aria-hidden />
            {t.label}
            {t.id === 'chat' && chatBadge > 0 && (
              <span
                data-testid="chat-badge"
                className="absolute right-4 top-1 rounded-full bg-danger px-1.5 text-2xs text-danger-foreground"
              >
                {chatBadge}
              </span>
            )}
          </button>
        );
      })}
    </nav>
  );
}

// <main> — единственный вертикальный скролл-контейнер уровня приложения: sticky
// ScreenHeader внутри экранов прилипает к его верху (между main и шапкой нет
// overflow-обёрток). Контейнер ширины (max-w-3xl/5xl) живёт в самих экранах,
// НИЖЕ шапки: header на всю ширину, контент центрирован.
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
  } else if (top.kind === 'thread') {
    return <ThreadScreen threadId={top.threadId} />;
  } else if (top.kind === 'settings') {
    return <SettingsScreen />;
  }
  // Достижимо только для корня «неизвестного» таба (agenda/budget из старого persist).
  return <div className="p-4 text-sm text-text-secondary">Экран: {activeTab}</div>;
}

// Экран треда сущности поверх стека: шапка с «Назад» + общий чат-компонент (§2.2).
function ThreadScreen({ threadId }: { threadId: string }) {
  return (
    <div className="flex h-full flex-col">
      <ScreenHeader title="Тред" />
      <div className="mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col">
        <ChatThread threadId={threadId} />
      </div>
    </div>
  );
}
