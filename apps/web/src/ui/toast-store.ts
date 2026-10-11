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
  description?: string;
};

const AUTO_DISMISS_MS = 4000;
/** Тост с действием живёт 10 секунд; hover/focus/touch/hidden независимо удерживают остаток.
 * Плашка и описание доступны через Tab и aria-live; отмена остаётся доступна также из карточки.
 */
export const ACTION_DISMISS_MS = 10_000;
let counter = 0;
let actionGeneration = 0;
export const toastActionGeneration = () => actionGeneration;

/** Таймер тоста: ручка, остаток и момент, с которого он идёт (`null` — на паузе). */
export type PauseReason = 'hover' | 'focus' | 'touch' | 'hidden';
type Timer = {
  handle: ReturnType<typeof setTimeout> | null;
  remaining: number;
  startedAt: number;
  paused: Set<PauseReason>;
};
const hiddenNow = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';
const timers = new Map<string, Timer>();

type ToastState = {
  toasts: ToastItem[];
  show: (title: string, tone?: ToastTone, action?: ToastAction, description?: string) => string;
  dismiss: (id: string) => void;
  /** Остановить отсчёт (наведение, фокус внутри тоста); повторная пауза — no-op. */
  pause: (id: string, reason: PauseReason) => void;
  /** Продолжить отсчёт с остатка; без паузы — no-op. */
  resume: (id: string, reason: PauseReason) => void;
};

export const useToastStore = create<ToastState>((set, get) => {
  const run = (id: string) => {
    const t = timers.get(id);
    if (!t || t.paused.size > 0) return;
    t.startedAt = Date.now();
    t.handle = setTimeout(() => get().dismiss(id), t.remaining);
  };
  return {
    toasts: [],
    show: (title, tone = 'default', action, description) => {
      counter += 1;
      if (action !== undefined) actionGeneration += 1;
      const id = `toast-${counter}`;
      if (action !== undefined)
        for (const t of get().toasts) if (t.action !== undefined) get().dismiss(t.id);
      timers.set(id, {
        handle: null,
        remaining: action === undefined ? AUTO_DISMISS_MS : ACTION_DISMISS_MS,
        startedAt: Date.now(),
        paused: new Set(hiddenNow() ? ['hidden'] : []),
      });
      set((s) => ({
        toasts: [
          ...s.toasts,
          {
            id,
            title,
            tone,
            ...(action && { action }),
            ...(description !== undefined && { description }),
          },
        ],
      }));
      run(id);
      return id;
    },
    // Повторный dismiss того же id — no-op (filter не найдёт).
    dismiss: (id) => {
      const timer = timers.get(id);
      if (timer?.handle != null) clearTimeout(timer.handle);
      timers.delete(id);
      set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
    },
    pause: (id, reason) => {
      const t = timers.get(id);
      if (!t) return;
      if (t.handle !== null) {
        clearTimeout(t.handle);
        t.remaining = Math.max(0, t.remaining - (Date.now() - t.startedAt));
        t.handle = null;
      }
      t.paused.add(reason);
    },
    resume: (id, reason) => {
      const t = timers.get(id);
      if (!t || !t.paused.delete(reason) || t.paused.size > 0) return;
      run(id);
    },
  };
});

/** Хук для фич: const { show } = useToast(); show('Сохранено') / show('Ошибка', 'danger'). */
export function useToast(): { show: ToastState['show'] } {
  const show = useToastStore((s) => s.show);
  return { show };
}

// Подписка одна на оболочку, поэтому пауза переживает смену экрана.
if (typeof document !== 'undefined')
  document.addEventListener('visibilitychange', () => {
    const { toasts, pause, resume } = useToastStore.getState();
    for (const t of toasts) (hiddenNow() ? pause : resume)(t.id, 'hidden');
  });
