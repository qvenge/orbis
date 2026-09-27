import { useEffect } from 'react';
import { isDesktop } from '../../app/frame/useViewport';
import { openSearch } from './open-search';

/**
 * ⌘K / Ctrl+K — поиск хоста (спека 1б §6.3): тот же путь, что у 🔍 (`openSearch`).
 *
 * Клавиша — по физической (`code === 'KeyK'`) ИЛИ по символу (`key === 'k'`): в русской раскладке
 * Ctrl+K даёт `key === 'л'`, и проверка одного символа отдала бы клавишу браузеру (его строка поиска
 * или адреса) — а интерфейс и данные у продукта русские (гейт 24, M-3). Символ оставлен ради раскладок,
 * где K стоит не на месте QWERTY-клавиши.
 *
 * Слушатель на `window` и `preventDefault()`: у браузера на ⌘K своё действие (строка поиска Firefox,
 * адресная строка Chrome на Ctrl+K). Ставит `AppShell` — один раз на приложение.
 */
export function useSearchHotkey(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.code !== 'KeyK' && e.key.toLowerCase() !== 'k') return;
      e.preventDefault();
      openSearch(isDesktop());
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
