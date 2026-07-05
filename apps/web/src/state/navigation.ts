import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type Tab = 'chat' | 'browser' | 'agenda' | 'budget';
export type ScreenRef = { kind: 'entity'; id: string } | { kind: 'thread'; threadId: string };

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
