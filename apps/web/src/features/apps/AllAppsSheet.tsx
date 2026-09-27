import { createPortal } from 'react-dom';
import { AppsBlock } from './AppsBlock';

/**
 * «Все приложения» — запасной путь переключателя (срез 1б §6.2 п. 3, §6.4; С1б-7): тот же список,
 * что блок «Приложения» на «Домой», листом из хостового раздела «⋯». Нужен, когда блок с «Домой»
 * убрали или до «Домой» далеко.
 *
 * Модуль ЛЕНИВЫЙ (`ScreenMenu` грузит его выбором пункта): первому кадру лист ни к чему. Порталом в
 * `body` и тем же слоем, что лист разделов (`NavSheet`): подложка `z-40` закрывает касанием, лист
 * `z-50` выше кнопок хоста.
 */
export function AllAppsSheet({ onClose }: { onClose: () => void }) {
  return createPortal(
    <>
      <button
        type="button"
        aria-label="Закрыть приложения"
        tabIndex={-1}
        onClick={onClose}
        className="fixed inset-0 z-40 cursor-default bg-overlay/20"
      />
      <div
        role="dialog"
        aria-label="Все приложения"
        className="fixed inset-x-2 top-15 z-50 mx-auto max-h-[70vh] max-w-3xl overflow-y-auto rounded-card border border-line bg-surface p-3 shadow-pop"
      >
        <AppsBlock onPick={onClose} />
      </div>
    </>,
    document.body,
  );
}
