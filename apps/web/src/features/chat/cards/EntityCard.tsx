import { useState } from 'react';
import { fieldLabel } from '../../../lib/field-labels';
import { formatAmount } from '../../../lib/format';
import { useNav } from '../../../state/navigation';
import { trpc } from '../../../trpc';
import { Button } from '../../../ui/Button';
import { Card } from '../../../ui/Card';
// Валютный символ — общий envelopeView (B4-прецедент QuickAddBar), маппинг не дублируем
import { envelopeView } from '../../budget/EnvelopeCard';
import type { EntityCardData } from './types';

// inline-правка полей аспекта — на detail-экране (Task 14); в чат-карточке read-only + Undo + тап в detail (MVP §2.3)
export function EntityCard({
  card,
  confirmed = true,
}: {
  card: EntityCardData;
  /** false — fast-path «⏳ ждёт отправки»: запись ещё не на сервере (02 §2.5). */
  confirmed?: boolean;
}) {
  const [undone, setUndone] = useState(false);
  const push = useNav((s) => s.push);
  const activeTab = useNav((s) => s.activeTab);
  const utils = trpc.useUtils();

  // Остаток конверта (03-budget §4.1, B7): для financial-записи ПОСЛЕ подтверждения
  // сервером — «→ <категория> · осталось N ₽» по category_ref и occurred_on ЗАПИСИ.
  // Остаток «после записи» гарантирует invalidateBudget в useFastPath/onUndo: сервер
  // считает spent по факту, инвалидация перечитывает после каждой мутации.
  const isFinancial = card.aspects.includes('orbis/financial');
  const categoryRef = card.keyFields.category_ref;
  const occurredOn = card.keyFields.occurred_on;
  const wantRemaining =
    confirmed &&
    !undone &&
    isFinancial &&
    typeof categoryRef === 'string' &&
    typeof occurredOn === 'string';
  const envQ = trpc.budget.envelopeForCategory.useQuery(
    {
      categoryId: typeof categoryRef === 'string' ? categoryRef : '',
      date: typeof occurredOn === 'string' ? occurredOn : '',
    },
    { enabled: wantRemaining },
  );
  // null (Unbudgeted) и ошибка чтения → без строки остатка (§4.1: без конверта — ничего)
  const env = wantRemaining && envQ.data ? envQ.data : null;

  const undo = trpc.ai.undo.useMutation({
    onSuccess: () => {
      setUndone(true);
      void utils.entity.get.invalidate({ id: card.entityId });
      // Undo транзакции меняет агрегаты Budget (остаток, бейдж §6.1) — B2+-правило
      if (isFinancial) void utils.budget.invalidate();
    },
  });

  const undoActionId = card.undoActionId;

  return (
    <Card
      data-testid="entity-card"
      data-undone={String(undone)}
      className={`flex flex-col gap-2 ${undone ? 'opacity-50' : ''}`}
    >
      <button
        type="button"
        className="cursor-pointer text-left text-sm font-medium transition hover:text-accent disabled:cursor-default disabled:hover:text-text"
        disabled={undone}
        onClick={() => push(activeTab, { kind: 'entity', id: card.entityId })}
      >
        {card.title}
      </button>
      {/* Свойства — тихая сетка «подпись: значение», числа таблично. */}
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-xs">
        {Object.entries(card.keyFields).map(([k, v]) => (
          <div key={k} className="col-span-2 grid grid-cols-subgrid">
            <dt className="text-text-muted">{fieldLabel(k)}</dt>
            <dd className="text-text tabular-nums">{String(v)}</dd>
          </div>
        ))}
      </dl>
      {env !== null && (
        <p data-testid="envelope-remaining" className="text-xs tabular-nums text-text-secondary">
          → {env.category.title} · осталось {formatAmount(env.remaining)} {envelopeView(env).sym}
        </p>
      )}
      {undoActionId && !undone && (
        <Button
          variant="ghost"
          size="sm"
          className="self-start"
          onClick={() => undo.mutate({ actionId: undoActionId })}
        >
          Отменить
        </Button>
      )}
      {undone && <p className="text-xs text-text-muted">Отменено</p>}
    </Card>
  );
}
