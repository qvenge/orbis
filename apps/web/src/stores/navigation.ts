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

interface NavigationState {
  activeView: 'list' | 'detail' | 'calendar' | 'hub' | 'budget' | 'fitness' | 'nutrition' | 'habits' | 'settings' | 'custom-view';
  selectedEntityId: string | null;
  customViewId: string | null;
  calendarWeek: Date;
  filters: {
    tags?: string[];
    aspects?: string[];
    search?: string;
    archived: boolean;
    sortBy: 'created_at' | 'updated_at' | 'title';
    sortOrder: 'asc' | 'desc';
  };
  openEntity: (id: string) => void;
  goBack: () => void;
  setFilters: (filters: Partial<NavigationState['filters']>) => void;
  openCalendar: () => void;
  openHub: () => void;
  openBudget: () => void;
  openFitness: () => void;
  openNutrition: () => void;
  openHabits: () => void;
  openSettings: () => void;
  openCustomView: (id: string) => void;
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
  filters: {
    archived: false,
    sortBy: 'updated_at',
    sortOrder: 'desc',
  },

  openEntity: (id) => set({ activeView: 'detail', selectedEntityId: id }),
  goBack: () => set({ activeView: 'list', selectedEntityId: null }),
  setFilters: (filters) =>
    set((s) => ({ filters: { ...s.filters, ...filters } })),
  openCalendar: () => set({ activeView: 'calendar' }),
  openHub: () => set({ activeView: 'hub' }),
  openBudget: () => set({ activeView: 'budget' }),
  openFitness: () => set({ activeView: 'fitness' }),
  openNutrition: () => set({ activeView: 'nutrition' }),
  openHabits: () => set({ activeView: 'habits' }),
  openSettings: () => set({ activeView: 'settings' }),
  openCustomView: (id) => set({ activeView: 'custom-view', customViewId: id }),
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
