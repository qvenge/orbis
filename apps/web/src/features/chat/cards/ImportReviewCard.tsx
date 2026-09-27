// Карточка import_review в ленте чата (02-core-os §2.3, 03-budget §3.4): импорт инициируется и из
// чата («импортируй выписку»). Экран импорта ушёл из интерфейса вместе с экранами Бюджета (срез 1б
// §8.6, РП-31: код лежит в `legacy-1v/` до 1в) — карточка честно говорит, где импорт окажется, а не
// ведёт в пустоту.
import { Upload } from 'lucide-react';
import { Card } from '../../../ui/Card';
import type { ImportReviewData } from './types';

// Карточка данных не несёт (см. ImportReviewData) — параметр принимается ради единой
// сигнатуры рендера карточек (renderCards.tsx), но не читается
export function ImportReviewCard(_props: { card: ImportReviewData }) {
  return (
    <Card data-testid="import-review-card" className="flex flex-col gap-2">
      <p className="flex items-center gap-1.5 text-sm">
        <Upload size={14} aria-hidden />
        Импорт выписки
      </p>
      <p className="text-xs text-text-muted">
        Импорт откроется в приложении «Бюджет» — следующий срез
      </p>
    </Card>
  );
}
