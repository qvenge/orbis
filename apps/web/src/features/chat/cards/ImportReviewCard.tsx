// Карточка import_review в ленте чата (02-core-os §2.3, 03-budget §3.4): импорт
// инициируется и из чата («импортируй выписку»). Сам разбор файла живёт на экране
// импорта — карточка только ведёт туда, потому что файл выбирается локально (§3.4
// шаг 1) и через ленту сообщений не проходит.
import { Upload } from 'lucide-react';
import { useNav } from '../../../state/navigation';
import { Button } from '../../../ui/Button';
import { Card } from '../../../ui/Card';
import { useBudgetTabVisible } from '../../budget/useBudget';
import type { ImportReviewData } from './types';

// Карточка данных не несёт (см. ImportReviewData) — параметр принимается ради единой
// сигнатуры рендера карточек (renderCards.tsx), но не читается
export function ImportReviewCard(_props: { card: ImportReviewData }) {
  const budgetVisible = useBudgetTabVisible();

  return (
    <Card data-testid="import-review-card" className="flex flex-col gap-2">
      <p className="text-sm">Импорт выписки</p>
      {budgetVisible ? (
        <Button
          size="sm"
          className="self-start"
          onClick={() => {
            // switchTab по УЖЕ активному табу свернул бы стек (§1.1) — переключаем
            // только из другого таба, и лишь затем пушим экран импорта
            const { activeTab, switchTab, push } = useNav.getState();
            if (activeTab !== 'budget') switchTab('budget');
            push('budget', { kind: 'budget-import' });
          }}
        >
          <Upload size={14} aria-hidden />
          Открыть импорт
        </Button>
      ) : (
        <p className="text-xs text-text-muted">
          Раздел «Бюджет» не установлен — включите его в настройках, чтобы импортировать выписку.
        </p>
      )}
    </Card>
  );
}
