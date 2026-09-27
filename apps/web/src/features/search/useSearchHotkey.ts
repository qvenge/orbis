import { currentEntry } from '@orbis/shared/nav';
import { useEffect } from 'react';
import { isDesktop } from '../../app/frame/useViewport';
import { useNav } from '../../state/navigation';
import { useSearchDialog } from './search-dialog-store';

/**
 * ⌘K / Ctrl+K — поиск хоста (спека 1б §6.3): тот же путь, что у 🔍. Десктоп — окно вверху по центру
 * (не элемент истории, §7.3), телефон (клавиатура у планшета) — экран хоста поверх раздела. Уже на
 * экране поиска клавиша ничего не переоткрывает: `openHostScreen('search')` без строки заменил бы
 * найденное пустым поиском.
 *
 * Слушатель на `window` и `preventDefault()`: у браузера на ⌘K своё действие (строка поиска Firefox,
 * адресная строка Chrome на Ctrl+K). Ставит `AppShell` — один раз на приложение.
 */
export function useSearchHotkey(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'k') return;
      e.preventDefault();
      if (isDesktop()) {
        useSearchDialog.getState().show();
        return;
      }
      const nav = useNav.getState();
      const here = currentEntry(nav.model).address;
      if (nav.overlay === null && here.kind === 'host-screen' && here.screen === 'search') return;
      nav.openHostScreen('search');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
