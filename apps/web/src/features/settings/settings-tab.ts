import { create } from 'zustand';
import { useNav } from '../../state/navigation';

/**
 * На какую вкладку открыть настройки (срез 1б §6.4, §8.6): пункт «⋯ → Приложения и расширения»
 * ведёт на свою вкладку, «Настройки» — на «Общие». У экрана хоста `settings` адреса вкладки нет
 * (`/settings`), поэтому просьба живёт здесь: экран настроек читает её при открытии и гасит, а если
 * он уже открыт — переключается на неё сразу.
 */
export const useSettingsTabRequest = create<{ tab: string | null }>(() => ({ tab: null }));

/** Открыть настройки на вкладке `tab` (значение вкладки `SettingsScreen`). */
export function openSettings(tab: string): void {
  useSettingsTabRequest.setState({ tab });
  useNav.getState().openHostScreen('settings');
}
