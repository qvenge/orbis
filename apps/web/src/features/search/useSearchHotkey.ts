import { useEffect } from 'react';
import { isDesktop } from '../../app/frame/useViewport';
import { openSearch } from './open-search';

/**
 * ⌘K / Ctrl+K — поиск хоста (спека 1б §6.3): тот же путь, что у 🔍 (`openSearch`).
 *
 * Клавиша — по символу (`key === 'k'`), а по физической (`code === 'KeyK'`) — только когда символ НЕ
 * латинская буква: в русской раскладке Ctrl+K даёт `key === 'л'`, и проверка одного символа отдала
 * бы клавишу браузеру (его строка поиска или адреса) — а интерфейс и данные у продукта русские (гейт
 * 24, M-3). В латинских раскладках, где K стоит не на месте QWERTY-клавиши (Colemak, Dvorak), на
 * физической K — другая буква, и её сочетание (Ctrl+E, Ctrl+T) принадлежит браузеру: его не
 * перехватываем (остаток М-13, финал C1 M-6).
 *
 * Слушатель на `window` и `preventDefault()`: у браузера на ⌘K своё действие (строка поиска Firefox,
 * адресная строка Chrome на Ctrl+K). Ставит `AppShell` — один раз на приложение.
 */
export function useSearchHotkey(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      const key = e.key.toLowerCase();
      const byCode = e.code === 'KeyK' && !/^[a-z]$/.test(key);
      if (key !== 'k' && !byCode) return;
      e.preventDefault();
      openSearch(isDesktop());
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
