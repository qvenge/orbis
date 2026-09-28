import type { AppKey } from '@orbis/shared/nav';
import { createPortal } from 'react-dom';
import { SectionList } from './SectionList';

/**
 * Лист разделов формы «список из заголовка» (спека 1б §6.2 п. 2, §9.3): заголовок шапки
 * «иконка · раздел ▾» раскрывает сверху разделы приложения. Строки — общий `SectionList` (с
 * сайдбаром десктопа, задача 25): заголовок, эмодзи, бейдж, «где остановились», архивный раздел
 * плашкой, ярлык «↗ Дом», плашка оболочки по эталону.
 *
 * Бейджи и «Дом» разделов — только пока лист открыт (строки нарисованы только тогда): на холодном
 * старте лист закрыт, и запросов за ними нет (С1б-16).
 *
 * Лист и подложка — порталом в `body`, а не внутри шапки: у шапки `backdrop-blur`, а
 * `backdrop-filter` делает элемент containing block для `fixed`-потомков (Filter Effects L2) —
 * подложка покрыла бы одну шапку, касание по экрану лист не закрывало бы, а капсула кнопок хоста
 * ложилась бы поверх листа (гейт 19, Fable M-5). Слои: кнопки хоста `z-30` < подложка `z-40` <
 * лист `z-50`. Лист стоит под строкой присутствия хоста (её высота — `h-14`).
 */
export function NavSheet({
  app,
  activeSection,
  onClose,
}: {
  app: AppKey;
  activeSection: string;
  onClose: () => void;
}) {
  return createPortal(
    <>
      {/* Подложка: касание мимо листа закрывает его. */}
      <button
        type="button"
        aria-label="Закрыть разделы"
        data-testid="nav-sheet-backdrop"
        tabIndex={-1}
        onClick={onClose}
        className="fixed inset-0 z-40 cursor-default bg-overlay/20"
      />
      <div
        role="dialog"
        aria-label="Разделы"
        data-testid="nav-sheet"
        className="fixed inset-x-2 top-15 z-50 mx-auto max-h-[70vh] max-w-3xl overflow-y-auto rounded-card border border-line bg-surface p-1 shadow-pop"
      >
        <SectionList app={app} activeSection={activeSection} onPicked={onClose} />
      </div>
    </>,
    document.body,
  );
}
