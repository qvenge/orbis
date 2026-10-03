import { useState } from 'react';
import { useOpenRecord } from '../../../app/useOpenRecord';
import { formatAmount } from '../../../lib/format';
import { fieldLabel } from '../../../lib/registry/labels';
import { useRegistry } from '../../../lib/registry/useRegistry';
import { trpc } from '../../../trpc';
import { Button } from '../../../ui/Button';
import { Card } from '../../../ui/Card';
import { useCategoryTitle } from '../../budget/categories';
// Валютный символ — общий envelopeView (одно отображение валюты для всех мест показа денег), маппинг не дублируем
import { envelopeView } from '../../budget/EnvelopeCard';
import { useExtensionEnabled } from '../../settings/extension-mask';
import { undoWithReport } from '../../undo/undo-lazy';
import type { EntityCardData } from './types';

// inline-правка полей аспекта — на detail-экране (Task 14); в чат-карточке read-only + Undo + тап в detail (MVP §2.3)
export function EntityCard({
  card,
  confirmed = true,
  readOnly = false,
  undone: undoneOnServer = false,
}: {
  card: EntityCardData;
  /** false — fast-path «⏳ ждёт отправки»: запись ещё не на сервере (02 §2.5). */
  confirmed?: boolean;
  /** Лента только для чтения (предпросмотр шаблона): без «Отменить» — переход к записи остаётся. */
  readOnly?: boolean;
  /**
   * Действие уже отменено — знает строка журнала (`journal.undone`, спека скорости §11.3): после перечитывания
   * треда карточка отменённого не предлагает «Отменить» снова. Своя отмена кладётся поверх локальным состоянием.
   */
  undone?: boolean;
}) {
  const [undoneHere, setUndone] = useState(false);
  const undone = undoneOnServer || undoneHere;
  const openRecord = useOpenRecord();
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
  // При выключенных Финансах остатка нет, и запроса конверта тоже (срез 1б §8.4); строка категории
  // в сетке полей остаётся — это показ значения записи (§8.3 «записи видны»). Отступление §15.
  const financeOn = useExtensionEnabled('finance');
  const wantRemaining =
    financeOn &&
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

  const [pending, setPending] = useState(false);

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
        onClick={() => openRecord(card.entityId)}
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
      {undoActionId && !undone && !readOnly && (
        <Button
          variant="ghost"
          size="sm"
          className="self-start"
          disabled={pending}
          onClick={() => {
            setPending(true);
            undoWithReport(undoActionId, { entityIds: [card.entityId] }, (o) => {
              setPending(false);
              if (o.kind === 'undone' || o.kind === 'already') setUndone(true);
            });
          }}
        >
          Отменить
        </Button>
      )}
      {undone && <p className="text-xs text-text-muted">Отменено</p>}
    </Card>
  );
}
