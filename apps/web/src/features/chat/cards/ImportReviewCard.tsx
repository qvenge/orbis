// Карточка import_review в ленте чата (02-core-os §2.3, 03-budget §3.4). Экрана импорта нет: срез 1б
// увёл его из интерфейса вместе с экранами Бюджета, 1в удалил код (спека 1в §8.1), а инструмент
// агента, начинавший импорт из чата, снят (§7.4). Карточка честно говорит, где импорт окажется, а не
// ведёт в пустоту: в приложении «Бюджет», которое придёт отдельным срезом.
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
        Импорт откроется в приложении «Бюджет» — отдельным срезом
      </p>
    </Card>
  );
}
