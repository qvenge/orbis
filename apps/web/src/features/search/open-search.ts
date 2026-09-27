import { currentEntry } from '@orbis/shared/nav';
import { useNav } from '../../state/navigation';
import { useSearchDialog } from './search-dialog-store';

/**
 * Открыть поиск хоста — один путь для 🔍 и ⌘K / Ctrl+K (спека 1б §6.3, §6.4): десктоп — окно вверху по
 * центру (не элемент истории, §7.3), телефон — экран хоста поверх раздела.
 *
 * Уже на экране поиска — ничего: `openHostScreen('search')` без строки заменил бы место на пустой
 * `/search` (на сайте — лишний шаг истории), а экран поиска не перемонтировался бы и показывал
 * прежнюю строку — адрес и экран разошлись бы (гейт 24, M-2).
 */
export function openSearch(desktop: boolean): void {
  if (desktop) {
    useSearchDialog.getState().show();
    return;
  }
  const nav = useNav.getState();
  const here = currentEntry(nav.model).address;
  if (nav.overlay === null && here.kind === 'host-screen' && here.screen === 'search') return;
  nav.openHostScreen('search');
}
