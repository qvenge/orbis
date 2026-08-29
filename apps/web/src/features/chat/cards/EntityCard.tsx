import { useState } from 'react';
import { formatAmount } from '../../../lib/format';
import { invalidateGraph } from '../../../lib/invalidate';
import { fieldLabel } from '../../../lib/registry/labels';
import { useRegistry } from '../../../lib/registry/useRegistry';
import { useNav } from '../../../state/navigation';
import { trpc } from '../../../trpc';
import { Button } from '../../../ui/Button';
import { Card } from '../../../ui/Card';
import { useCategoryTitle } from '../../budget/categories';
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
  // Подписи полей — из реестра (§А9-2): ключи `keyFields` это id СВОЙСТВ, и словарь имён
  // старой схемы, живший здесь раньше, не знал ни одного из них.
  const registry = useRegistry();

  // Остаток конверта (03-budget §4.1, B7): для financial-записи ПОСЛЕ подтверждения
  // сервером — «→ <категория> · осталось N ₽» по category_ref и occurred_on ЗАПИСИ.
  // Остаток «после записи» гарантирует invalidateBudget в useFastPath/onUndo: сервер
  // считает spent по факту, инвалидация перечитывает после каждой мутации.
  // Только ФАКТИЧЕСКИЙ РАСХОД (ревью B7): у income остаток — шум, planned в spent
  // не входит (§2.7) — показывать «осталось» без самой записи было бы враньём.
  const isFinancial = card.aspects.includes('orbis/financial');
  // Адреса — id СВОЙСТВ, а не имена полей старой схемы: с Задачи 12 карточку собирает
  // `keyFieldsOf` по `view_config.keyFields` реестра, где лежат именно id (§А9-2), и то же
  // самое кладёт быстрый ввод (`useFastPath`, `fastPathCard`). Прежние ключи
  // (`category_ref`, `occurred_on`, `direction`, `planned`) не совпадали ни с одним ключом
  // ответа, поэтому строка остатка конверта не рисовалась НИКОГДА, а категория показывалась
  // uuid'ом — молча, потому что промах словаря печатает ключ как есть.
  const categoryRef = card.keyFields['orbis/finance_category'];
  const occurredOn = card.keyFields['orbis/occurred_on'];
  const direction = card.keyFields['orbis/direction'];
  const planned = card.keyFields['orbis/planned'];
  const wantRemaining =
    confirmed &&
    !undone &&
    isFinancial &&
    direction === 'expense' &&
    planned !== true &&
    planned !== 'true' &&
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

  // Категория в сетке полей — НАЗВАНИЕМ, а не uuid (D6c п.2): строка остатка конверта
  // название несёт, но её нет у записи без конверта — и оставался «категория: 7d5e…».
  // Пока список категорий грузится, значение неизвестно — строки поля нет вовсе
  // (D6d п.1): иначе на холодном кэше uuid мелькал и подменялся названием.
  const {
    title: categoryTitle,
    isPending: categoryPending,
    isError: categoryFailed,
  } = useCategoryTitle(typeof categoryRef === 'string' ? categoryRef : '');

  const undo = trpc.ai.undo.useMutation({
    onSuccess: () => {
      setUndone(true);
      // Р17: Undo — такая же правка графа, как create, и списки о ней узнать обязаны
      // (раньше инвалидировался ТОЛЬКО ключ самой карточки, и отменённая запись висела
      // в Browser/Повестке до истечения staleTime, а прогресс цели считал её своей).
      invalidateGraph(utils);
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
        {Object.entries(card.keyFields).map(([k, v]) => {
          const isCategory = k === 'orbis/finance_category' && typeof v === 'string';
          // Ни на загрузке, ни на отказе списка категорий строку не рисуем: печатать
          // uuid — та же ложь, что мелькающий uuid (уборочная фаза).
          if (isCategory && (categoryPending || categoryFailed)) return null;
          return (
            <div key={k} className="col-span-2 grid grid-cols-subgrid">
              <dt className="text-text-muted">{fieldLabel(registry, k)}</dt>
              <dd className="text-text tabular-nums">{isCategory ? categoryTitle : String(v)}</dd>
            </div>
          );
        })}
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
