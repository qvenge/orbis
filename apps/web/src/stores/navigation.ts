import { create } from 'zustand';

function getWeekStart(date: Date): Date {
  const d = new Date(date);
  const day = d.getDay();
  // Monday as start (0=Sun, 1=Mon, ...)
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

type View = 'list' | 'detail' | 'calendar' | 'hub' | 'budget' | 'fitness' | 'nutrition' | 'habits' | 'settings' | 'custom-view';

interface NavigationState {
  activeView: View;
  selectedEntityId: string | null;
  customViewId: string | null;
  calendarWeek: Date;
  sidebarOpen: boolean;
  filters: {
    tags?: string[];
    aspects?: string[];
    search?: string;
    archived: boolean;
    sortBy: 'created_at' | 'updated_at' | 'title';
    sortOrder: 'asc' | 'desc';
  };
  navigate: (view: View, params?: { entityId?: string; customViewId?: string }) => void;
  openEntity: (id: string) => void;
  goBack: () => void;
  toggleSidebar: () => void;
  closeSidebar: () => void;
  setFilters: (filters: Partial<NavigationState['filters']>) => void;
  setCalendarWeek: (date: Date) => void;
  prevWeek: () => void;
  nextWeek: () => void;
  goToThisWeek: () => void;
}

export const useNavigationStore = create<NavigationState>((set) => ({
  activeView: 'list',
  selectedEntityId: null,
  customViewId: null,
  calendarWeek: getWeekStart(new Date()),
  sidebarOpen: false,
  filters: {
    archived: false,
    sortBy: 'updated_at',
    sortOrder: 'desc',
  },

  navigate: (view, params) =>
    set({
      activeView: view,
      selectedEntityId: params?.entityId ?? null,
      customViewId: params?.customViewId ?? null,
      sidebarOpen: false,
    }),
  openEntity: (id) => set({ activeView: 'detail', selectedEntityId: id, sidebarOpen: false }),
  goBack: () => set({ activeView: 'list', selectedEntityId: null }),
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  closeSidebar: () => set({ sidebarOpen: false }),
  setFilters: (filters) =>
    set((s) => ({ filters: { ...s.filters, ...filters } })),
  setCalendarWeek: (date) => set({ calendarWeek: getWeekStart(date) }),
  prevWeek: () =>
    set((s) => {
      const prev = new Date(s.calendarWeek);
      prev.setDate(prev.getDate() - 7);
      return { calendarWeek: prev };
    }),
  nextWeek: () =>
    set((s) => {
      const next = new Date(s.calendarWeek);
      next.setDate(next.getDate() + 7);
      return { calendarWeek: next };
    }),
  goToThisWeek: () => set({ calendarWeek: getWeekStart(new Date()) }),
}));
