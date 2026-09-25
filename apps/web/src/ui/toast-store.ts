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
/**
 * Тост с действием живёт дольше: «Отменить» — единственный вход Undo пачки в web, и за четыре
 * секунды его не успеть ни прочитать, ни достать с клавиатуры (`type="background"` фокус не
 * берёт). Наведение и фокус ставят таймер на паузу (`pause`/`resume`, финальное ревью, C1-M3).
 */
export const ACTION_DISMISS_MS = 10_000;
let counter = 0;

/** Таймер тоста: ручка, остаток и момент, с которого он идёт (`null` — на паузе). */
type Timer = { handle: ReturnType<typeof setTimeout> | null; remaining: number; startedAt: number };
const timers = new Map<string, Timer>();

type ToastState = {
  toasts: ToastItem[];
  show: (title: string, tone?: ToastTone, action?: ToastAction) => string;
  dismiss: (id: string) => void;
  /** Остановить отсчёт (наведение, фокус внутри тоста); повторная пауза — no-op. */
  pause: (id: string) => void;
  /** Продолжить отсчёт с остатка; без паузы — no-op. */
  resume: (id: string) => void;
};

export const useToastStore = create<ToastState>((set, get) => {
  const run = (id: string, ms: number) => {
    timers.set(id, {
      handle: setTimeout(() => get().dismiss(id), ms),
      remaining: ms,
      startedAt: Date.now(),
    });
  };
  return {
    toasts: [],
    show: (title, tone = 'default', action) => {
      counter += 1;
      const id = `toast-${counter}`;
      set((s) => ({ toasts: [...s.toasts, { id, title, tone, ...(action && { action }) }] }));
      run(id, action === undefined ? AUTO_DISMISS_MS : ACTION_DISMISS_MS);
      return id;
    },
    // Повторный dismiss того же id — no-op (filter не найдёт).
    dismiss: (id) => {
      const timer = timers.get(id);
      if (timer?.handle != null) clearTimeout(timer.handle);
      timers.delete(id);
      set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
    },
    pause: (id) => {
      const timer = timers.get(id);
      if (timer === undefined || timer.handle === null) return;
      clearTimeout(timer.handle);
      timers.set(id, {
        handle: null,
        remaining: Math.max(0, timer.remaining - (Date.now() - timer.startedAt)),
        startedAt: timer.startedAt,
      });
    },
    resume: (id) => {
      const timer = timers.get(id);
      if (timer === undefined || timer.handle !== null) return;
      run(id, timer.remaining);
    },
  };
});

/** Хук для фич: const { show } = useToast(); show('Сохранено') / show('Ошибка', 'danger'). */
export function useToast(): { show: ToastState['show'] } {
  const show = useToastStore((s) => s.show);
  return { show };
}
