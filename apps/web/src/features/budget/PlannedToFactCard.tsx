// Карточка перевода покупки plan→fact (Task B6, 03-budget §2.7): «Покупка совершена?
// <сумма> → <категория>» с date-инпутом (default сегодня в таймзоне пользователя,
// редактируем) — [Перевести в факт] зовёт budget.confirmPurchase одним batch (сервер
// A8: planned=false + occurred_on + переселект конверта §2.3, Undo целиком);
// [Оставить план] закрывает без мутации. batchId — client-UUIDv7 ОДИН на показ
// карточки (урок B4: повтор после ошибки — тот же id; CONFLICT — честная ошибка +
// новый id). Инлайн-Card под строкой задачи — как в мокапе §2.7, не модалка.
import { newId } from '@orbis/shared';
import { TRPCClientError } from '@trpc/client';
import { useState } from 'react';
import { formatMoney, type MoneyTone } from '../../lib/format';
import { trpc } from '../../trpc';
import { Button } from '../../ui/Button';
import { Card } from '../../ui/Card';
import { Input } from '../../ui/Input';
import { Spinner } from '../../ui/Spinner';
import { invalidateBudget, todayISO } from './useBudget';
import type { PlanToFactPrompt } from './usePlanToFactPrompt';

const TONE_CLASS: Record<MoneyTone, string> = { danger: 'text-danger', positive: 'text-success' };
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function PlannedToFactCard({
  prompt,
  onClose,
}: {
  prompt: PlanToFactPrompt;
  onClose: () => void;
}) {
  const utils = trpc.useUtils();
  const settings = trpc.user.getSettings.useQuery();
  // Название категории — по category_ref (сущность orbis/category); без ref не грузим
  const categoryQ = trpc.entity.get.useQuery(
    { id: prompt.categoryRef ?? '' },
    { enabled: prompt.categoryRef !== null },
  );
  const confirm = trpc.budget.confirmPurchase.useMutation();

  // Дефолт даты — «сегодня» локально (§2.7); настройки уже в кэше (их грузит Detail),
  // расхождение с браузерной tz возможно лишь в часы у границы суток — редактируемо.
  const [date, setDate] = useState(() => todayISO(settings.data?.timezone));
  // batchId ОДИН на показ карточки: повтор после ошибки шлёт тот же id (§7.8)
  const [batchId, setBatchId] = useState(newId);
  const [error, setError] = useState<string | null>(null);

  const money = formatMoney(prompt.amount, prompt.direction);
  const categoryTitle =
    prompt.categoryRef === null ? 'без категории' : (categoryQ.data?.entity.title ?? '…');

  async function submit() {
    if (confirm.isPending || !DATE_RE.test(date)) return;
    setError(null);
    try {
      await confirm.mutateAsync({ entityId: prompt.entityId, occurredOn: date, batchId });
    } catch (err) {
      // CONFLICT — batchId непригоден (чужая запись): успех НЕ фабрикуем (урок B4-фикса),
      // ошибка + свежий id; прочие сбои сохраняют batchId — честный повтор = replay-успех.
      if (err instanceof TRPCClientError && err.data?.code === 'CONFLICT') {
        setBatchId(newId());
        setError('Не удалось перевести — попробуйте ещё раз');
      } else {
        setError(err instanceof Error ? err.message : 'Не удалось перевести');
      }
      return;
    }
    await invalidateBudget(utils);
    void utils.entity.get.invalidate();
    void utils.entity.query.invalidate();
    onClose();
  }

  return (
    <Card data-testid="plan-to-fact-card" className="flex flex-col gap-2 p-3">
      <p className="text-sm font-medium">Покупка совершена?</p>
      <p className="text-sm">
        <span className={`tabular-nums ${TONE_CLASS[money.tone]}`}>{money.text}</span>
        <span className="text-text-secondary"> → {categoryTitle} (план → факт)</span>
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          type="date"
          aria-label="Дата покупки"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className="px-2 py-1 text-sm"
        />
        <Button
          size="sm"
          disabled={confirm.isPending || !DATE_RE.test(date)}
          onClick={() => void submit()}
        >
          {confirm.isPending ? <Spinner size={14} aria-label="Перевод" /> : 'Перевести в факт'}
        </Button>
        <Button size="sm" variant="outline" onClick={onClose} disabled={confirm.isPending}>
          Оставить план
        </Button>
      </div>
      {error !== null && (
        <p data-testid="plan-to-fact-error" className="text-xs text-danger">
          {error}
        </p>
      )}
    </Card>
  );
}
