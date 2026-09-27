import { useState } from 'react';
import { EntityList } from './EntityList';
import { Filters } from './Filters';
import { QuickCapture } from './QuickCapture';

/**
 * Блок «Записи» (`{{records}}`, спека 1б §3.5): сегодняшний экран Browser одним блоком — фильтр по
 * тегу, переключатель страниц и приложений, список с «Показать ещё» и быстрый ввод. Блок —
 * экран кодом до среза 2 (фильтры — параметры, быстрый ввод — форма), отступление §15 спеки.
 *
 * Модуль ЛЕНИВЫЙ и грузится только через `RecordsBlockSlot` (своя точка лени, спека §12, Н-9):
 * рендерер страниц живёт в первом кадре экрана записи, а список со строками, фильтром и формой
 * ввода нужен одной странице «Записи». Статический импорт этого файла вернул бы его вес в чанк
 * `DetailScreen` — это сторожит `scripts/check-lazy-chunks.ts` (чанк `RecordsBlock` и порог gzip).
 *
 * Раскладка — без своего скролла: список растёт в потоке страницы, прокручивает её тот, кто её
 * показывает. Вложенная прокрутка внутри страницы — вторая полоса и потерянный жест на телефоне.
 */
export function RecordsBlock({ onOpen }: { onOpen: (id: string) => void }) {
  const [filters, setFilters] = useState('');
  // Выключен по умолчанию (§9.6): страницы и приложения — обёртки над записями, в общем списке их
  // не показывают; переключатель — для того, кто ищет именно их.
  const [showPagesAndApps, setShowPagesAndApps] = useState(false);
  return (
    <section data-testid="records-block" aria-label="Записи" className="flex flex-col">
      <Filters onApply={setFilters} />
      <label className="flex cursor-pointer items-center gap-2 self-start px-4 pb-1 text-sm text-text-muted">
        <input
          type="checkbox"
          className="size-4 accent-accent"
          checked={showPagesAndApps}
          onChange={(e) => setShowPagesAndApps(e.target.checked)}
        />
        Показать страницы и приложения
      </label>
      <EntityList filters={filters} showPagesAndApps={showPagesAndApps} onOpen={onOpen} />
      <QuickCapture context={{ kind: 'root' }} />
    </section>
  );
}
