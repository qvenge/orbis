import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type Tab = 'chat' | 'browser' | 'agenda' | 'budget';
// 'settings' — сквозной экран (не таб): push поверх активного таба, back — обычный pop/switchTab (§9.4).
// 'budget-category' — экран категории Budget (03-budget §3.2): push по тапу на карточку
// конверта (B2); id — id КАТЕГОРИИ, рендер — CategoryScreen (B3) в router.tsx.
// 'budget-transactions' — экран «Транзакции» (03-budget §3.3, B5): push из шапки Overview.
// 'budget-rollover' — Rollover-экран (03-budget §3.5, B6): push из баннера «Новый месяц»
// и кнопки шапки Overview; месяц экран берёт сам (текущий в таймзоне пользователя).
export type ScreenRef =
  | { kind: 'entity'; id: string }
  | { kind: 'thread'; threadId: string }
  | { kind: 'budget-category'; id: string }
  | { kind: 'budget-transactions' }
  | { kind: 'budget-rollover' }
  | { kind: 'settings' };

type NavState = {
  activeTab: Tab;
  stacks: Record<Tab, ScreenRef[]>;
  push: (tab: Tab, screen: ScreenRef) => void;
  pop: (tab: Tab) => void;
  switchTab: (tab: Tab) => void;
  resetTabToRoot: (tab: Tab) => void;
};

const emptyStacks = (): Record<Tab, ScreenRef[]> => ({
  chat: [],
  browser: [],
  agenda: [],
  budget: [],
});

export const useNav = create<NavState>()(
  persist(
    (set) => ({
      activeTab: 'chat',
      stacks: emptyStacks(),
      push: (tab, screen) =>
        set((s) => ({ stacks: { ...s.stacks, [tab]: [...s.stacks[tab], screen] } })),
      pop: (tab) => set((s) => ({ stacks: { ...s.stacks, [tab]: s.stacks[tab].slice(0, -1) } })),
      // §1.1: повторный тап по активному табу — свернуть до корня; иначе просто переключить.
      switchTab: (tab) =>
        set((s) =>
          s.activeTab === tab ? { stacks: { ...s.stacks, [tab]: [] } } : { activeTab: tab },
        ),
      resetTabToRoot: (tab) => set((s) => ({ stacks: { ...s.stacks, [tab]: [] } })),
    }),
    { name: 'orbis:nav:v1', partialize: (s) => ({ activeTab: s.activeTab, stacks: s.stacks }) },
  ),
);

// --- Хелперы этапа 3 (редизайн) — только поверх стора, логика push/pop не меняется. ---

// §9.4: настройки — сквозной экран поверх активного таба. Без дублей:
// не стекуем settings поверх settings (используется sidebar'ом и шапкой).
export function openSettings() {
  const { activeTab, stacks, push } = useNav.getState();
  const stack = stacks[activeTab];
  if (stack[stack.length - 1]?.kind !== 'settings') push(activeTab, { kind: 'settings' });
}

// Открыть закреплённую сущность из глобального sidebar: активный таб — browser,
// наверху browser-стека — entity. ВАЖНО: switchTab по УЖЕ активному табу сворачивает
// стек (§1.1), поэтому переключаем только когда активен другой таб, и лишь затем push.
export function openPinnedEntity(id: string) {
  const { activeTab, switchTab, push } = useNav.getState();
  if (activeTab !== 'browser') switchTab('browser');
  push('browser', { kind: 'entity', id });
}
