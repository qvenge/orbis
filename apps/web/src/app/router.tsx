import { FolderOpen, type LucideIcon, MessageSquare, Wallet } from 'lucide-react';
import { BrowserScreen } from '../features/browser/BrowserScreen';
import { BudgetScreen } from '../features/budget/BudgetScreen';
import { CategoryScreen } from '../features/budget/CategoryScreen';
import { RolloverScreen } from '../features/budget/RolloverScreen';
import { TransactionsScreen } from '../features/budget/TransactionsScreen';
import { useBudgetTabVisible } from '../features/budget/useBudget';
import { ChatScreen } from '../features/chat/ChatScreen';
import { ChatThread } from '../features/chat/ChatThread';
import { DetailScreen } from '../features/entity-detail/DetailScreen';
import { SettingsScreen } from '../features/settings/SettingsScreen';
import { type ScreenRef, type Tab, useNav } from '../state/navigation';
import { useRetryBuffer } from '../state/retry';
import { ScreenHeader } from './ScreenHeader';

// Базовые разделы; budget добавляется по гейту installedViews (03-budget §1.2),
// agenda в навигации нет (тип Tab в navigation.ts шире — persist 'orbis:nav:v1'
// может содержать старые стеки, его не сужаем).
const BASE_TABS: { id: Tab; label: string; icon: LucideIcon }[] = [
  { id: 'chat', label: 'Чат', icon: MessageSquare },
  { id: 'browser', label: 'Обзор', icon: FolderOpen },
];
export const BUDGET_TAB = { id: 'budget', label: 'Бюджет', icon: Wallet } as const;

// Нижний tab-bar — только мобила (md:hidden); на десктопе навигация в SidebarNav.
export function TabBar() {
  const activeTab = useNav((s) => s.activeTab);
  const switchTab = useNav((s) => s.switchTab);
  const chatBadge = useRetryBuffer((s) => s.size); // §1.5
  const budgetVisible = useBudgetTabVisible();
  const tabs = budgetVisible ? [...BASE_TABS, BUDGET_TAB] : BASE_TABS;

  // Мобила: safe-area снизу; на десктопе скрыт (md:hidden) — навигация в SidebarNav.
  const cls = 'flex border-t border-line bg-surface pb-[env(safe-area-inset-bottom)] md:hidden';
  return (
    // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: tablist — корректная роль для таб-бара; nav сохраняем как landmark
    <nav role="tablist" aria-label="Разделы" className={cls}>
      {tabs.map((t) => {
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
              active ? 'text-accent' : 'text-text-secondary'
            }`}
          >
            {/* Активный таб помечен accent-цветом иконки/подписи (Notion-style) — без
                отдельной плавающей полосы, которая под композером читалась артефактом. */}
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
    if (activeTab === 'budget') return <BudgetScreen />;
  } else if (top.kind === 'entity') {
    return <DetailScreen entityId={top.id} />;
  } else if (top.kind === 'thread') {
    return <ThreadScreen threadId={top.threadId} />;
  } else if (top.kind === 'budget-category') {
    // Экран категории Budget (03-budget §3.2, Task B3); id — id КАТЕГОРИИ (пушит B2).
    return <CategoryScreen categoryId={top.id} />;
  } else if (top.kind === 'budget-transactions') {
    // Экран «Транзакции» (03-budget §3.3, Task B5); вход — шапка Overview.
    return <TransactionsScreen />;
  } else if (top.kind === 'budget-rollover') {
    // Rollover-экран (03-budget §3.5, Task B6); вход — баннер «Новый месяц» и шапка Overview.
    return <RolloverScreen />;
  } else if (top.kind === 'settings') {
    return <SettingsScreen />;
  }
  // Достижимо только для корня «неизвестного» таба (agenda из старого persist).
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
