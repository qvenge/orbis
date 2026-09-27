import { create } from 'zustand';

/**
 * Окно поиска ⌘K на десктопе (спека 1б §6.3, §7.3): открыто или нет. Стор, а не состояние
 * компонента — окно открывают двое, не родитель и ребёнок: кнопка 🔍 хоста и горячая клавиша.
 * В модель навигации окно не пишет ничего: оно не элемент истории.
 */
export const useSearchDialog = create<{ open: boolean; show(): void; hide(): void }>()((set) => ({
  open: false,
  show: () => set({ open: true }),
  hide: () => set({ open: false }),
}));
