import { create } from 'zustand';

/**
 * Боковой чат десктопа (спека 1б §6.3, §7.3): открыт или нет. Вне модели навигации намеренно —
 * боковой чат не элемент истории: 💬 его открывает и закрывает, а адрес, история браузера и стопки
 * разделов остаются как были (С1б-3). На телефоне 💬 — экран хоста `/chat`, и стор не читается.
 */
export const useSideChat = create<{ open: boolean; toggle(): void; close(): void }>()((set) => ({
  open: false,
  toggle: () => set((s) => ({ open: !s.open })),
  close: () => set({ open: false }),
}));
