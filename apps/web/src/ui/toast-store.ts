import { create } from 'zustand';

export type ToastTone = 'default' | 'danger';

/**
 * Действие тоста — сейчас это «Отменить» пачки правок (срез страниц 1а, РП-9): Undo стоит там же,
 * где человек узнал о правке. Одно и необязательное: тост — извещение, а не меню.
 */
export type ToastAction = { label: string; onSelect: () => void };

export type ToastItem = {
  id: string;
  title: string;
  tone: ToastTone;
  action?: ToastAction;
};

const AUTO_DISMISS_MS = 4000;
let counter = 0;

type ToastState = {
  toasts: ToastItem[];
  show: (title: string, tone?: ToastTone, action?: ToastAction) => string;
  dismiss: (id: string) => void;
};

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],
  show: (title, tone = 'default', action) => {
    counter += 1;
    const id = `toast-${counter}`;
    set((s) => ({ toasts: [...s.toasts, { id, title, tone, ...(action && { action }) }] }));
    // Авто-dismiss; повторный dismiss того же id — no-op (filter не найдёт).
    setTimeout(() => {
      set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
    }, AUTO_DISMISS_MS);
    return id;
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

/** Хук для фич: const { show } = useToast(); show('Сохранено') / show('Ошибка', 'danger'). */
export function useToast(): { show: ToastState['show'] } {
  const show = useToastStore((s) => s.show);
  return { show };
}
