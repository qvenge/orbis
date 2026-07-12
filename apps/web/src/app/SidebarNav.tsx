import { FolderOpen, type LucideIcon, MessageSquare, Settings } from 'lucide-react';
import { PinnedList } from '../features/browser/PinnedList';
import { useBudgetTabVisible } from '../features/budget/useBudget';
import { openPinnedEntity, openSettings, type Tab, useNav } from '../state/navigation';
import { useRetryBuffer } from '../state/retry';
import { BUDGET_TAB } from './router';

const NAV_ITEMS: { id: Tab; label: string; icon: LucideIcon }[] = [
  { id: 'chat', label: 'Чат', icon: MessageSquare },
  { id: 'browser', label: 'Обзор', icon: FolderOpen },
];

// Постоянный левый sidebar (десктоп, ≥768px): навигация + закреплённые + настройки.
// На мобиле скрыт (hidden md:flex) — там вместо него TabBar.
export function SidebarNav() {
  const activeTab = useNav((s) => s.activeTab);
  const switchTab = useNav((s) => s.switchTab);
  const chatBadge = useRetryBuffer((s) => s.size); // §1.5
  // Гейт вкладки Budget — как в TabBar (03-budget §1.2): без view вкладки нет.
  const budgetVisible = useBudgetTabVisible();
  const items = budgetVisible ? [...NAV_ITEMS, BUDGET_TAB] : NAV_ITEMS;

  return (
    <aside className="hidden w-60 shrink-0 flex-col border-r border-line bg-bg md:flex">
      <div className="px-4 pb-2 pt-4">
        <span className="text-sm font-semibold">Orbis</span>
      </div>

      <nav aria-label="Разделы" className="flex flex-col gap-0.5 px-2">
        {items.map((t) => {
          const active = activeTab === t.id;
          const Icon = t.icon;
          return (
            <button
              key={t.id}
              type="button"
              data-testid={`sidebar-${t.id}`}
              aria-current={active ? 'page' : undefined}
              // Повторный клик по активному пункту сворачивает стек до корня (§1.1, логика стора).
              onClick={() => switchTab(t.id)}
              className={`flex cursor-pointer items-center gap-2 rounded-control px-2 py-1.5 text-sm transition ${
                active
                  ? 'bg-surface-2 text-text'
                  : 'text-text-secondary hover:bg-surface-2/60 hover:text-text'
              }`}
            >
              <Icon size={16} aria-hidden />
              <span className="min-w-0 flex-1 truncate text-left">{t.label}</span>
              {t.id === 'chat' && chatBadge > 0 && (
                <span
                  data-testid="sidebar-chat-badge"
                  className="rounded-full bg-danger px-1.5 text-2xs text-danger-foreground"
                >
                  {chatBadge}
                </span>
              )}
            </button>
          );
        })}
      </nav>

      <div className="mt-4 flex min-h-0 flex-col overflow-y-auto px-2 pb-2">
        <p className="px-2 pb-1 text-2xs uppercase tracking-wide text-text-muted">Закреплённые</p>
        <PinnedList onOpen={openPinnedEntity} />
      </div>

      <div className="mt-auto p-2">
        <button
          type="button"
          data-testid="open-settings"
          onClick={openSettings}
          className="flex w-full cursor-pointer items-center gap-2 rounded-control px-2 py-1.5 text-sm text-text-secondary transition hover:bg-surface-2/60 hover:text-text"
        >
          <Settings size={16} aria-hidden />
          Настройки
        </button>
      </div>
    </aside>
  );
}
