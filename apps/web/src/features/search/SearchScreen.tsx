import { currentEntry } from '@orbis/shared/nav';
import { useEffect, useState } from 'react';
import { ScreenHeader } from '../../app/ScreenHeader';
import { useNav } from '../../state/navigation';
import { SearchPanel } from './SearchPanel';
import { useDebounced } from './useSearch';

/** Строка поиска текущего места, если это экран поиска. */
function searchQueryOfPlace(): string | null {
  const a = currentEntry(useNav.getState().model).address;
  return a.kind === 'host-screen' && a.screen === 'search' ? (a.q ?? '') : null;
}

/**
 * Экран хоста «Поиск» (`/search?q=…`, спека 1б §6.4, §7.3) — телефонная форма поиска: экран поверх
 * текущего раздела, «‹» — обратно в раздел; найденное открывается из хоста правилом открытия, и
 * экран снимается (источник перехода — раздел под ним). Ссылки ведёт рамка экрана хоста, которую
 * ставит роутер (`FrameAppContext`, `via: 'host-screen'`).
 *
 * Раскладка — столбец: результаты растут и скроллятся сами, поле — ПОСЛЕДНЕЙ строкой, над отступом
 * под капсулу кнопок хоста: на телефоне строка ввода внизу, над клавиатурой (Android поднимает её
 * `interactive-widget=resizes-content` в `index.html`, iOS — фокусом сам).
 *
 * Ввод пишет адрес ЗАМЕНОЙ (`replacePlace`) после той же паузы, что и запрос: набор — не шаги
 * истории, а ссылка `/search?q=…` всегда показывает то, что на экране. Начальная строка — из адреса
 * (старт по ссылке, возврат «‹» на поиск).
 *
 * Модуль ЛЕНИВЫЙ (R-35): входной чанк входит в замыкание экрана записи, а поиск нужен после жеста.
 */
export function SearchScreen() {
  const [q, setQ] = useState(() => searchQueryOfPlace() ?? '');
  const settled = useDebounced(q);
  useEffect(() => {
    const shown = searchQueryOfPlace();
    // Уже не на поиске (ушли по результату раньше паузы) или адрес уже тот — писать нечего.
    if (shown === null || shown === settled) return;
    useNav.getState().replacePlace({ kind: 'host-screen', screen: 'search', q: settled });
  }, [settled]);
  return (
    <div className="flex h-full flex-col">
      <ScreenHeader title="Поиск" />
      <div className="mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col">
        <SearchPanel value={q} onChange={setQ} fieldAt="bottom" />
      </div>
    </div>
  );
}
