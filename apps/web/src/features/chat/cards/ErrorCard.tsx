import { Button } from '../../../ui/Button';
import { Card } from '../../../ui/Card';
import type { ErrorCardData } from './types';

// §7.9: временные сбои (LLM недоступен / сеть) — предлагаем «Повторить»; иначе — «проверьте данные».
// Фактическую пере-отправку сообщения проводит useSendMessage (Task 11) через onRetry.
function isRetryable(code: string): boolean {
  return /llm_unavailable|network|timeout|unavailable|econn|fetch/i.test(code);
}

export function ErrorCard({ card, onRetry }: { card: ErrorCardData; onRetry?: () => void }) {
  const retryable = isRetryable(card.code);
  return (
    <Card role="alert" data-testid="error-card" className="flex flex-col gap-1 border-danger">
      <p className="text-sm text-danger">{card.message}</p>
      <p className="text-xs text-text-muted">{card.code}</p>
      <p className="text-xs text-text-secondary">
        {retryable
          ? 'Временный сбой — попробуйте ещё раз.'
          : 'Проверьте данные и попробуйте иначе.'}
      </p>
      {retryable && onRetry && (
        <Button variant="ghost" onClick={onRetry}>
          Повторить
        </Button>
      )}
    </Card>
  );
}
