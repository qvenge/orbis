import { EntityRef } from '../../../lib/entity-ref/EntityRef';
import { aggregateLabel } from '../../../lib/field-labels';
import { Card } from '../../../ui/Card';
import type { QueryResultData } from './types';

// D-d: без aggregate — native-список из entityIds; с aggregate — одно число.
// Строки — EntityRef (title вместо сырого UUID, этап 4).
export function QueryResultCard({ card }: { card: QueryResultData }) {
  // Сервер шлёт entityIds:[] в двух РАЗНЫХ случаях: поиск ничего не нашёл (тогда карточка
  // обязана сказать это словами) и агрегат (id он не выбирает по замыслу — dispatch.ts:426).
  const hasList = card.entityIds.length > 0;
  return (
    <Card data-testid="query-result-card" className="flex flex-col gap-2">
      {card.title && <p className="text-sm font-medium">{card.title}</p>}
      {card.aggregate ? (
        <div className="flex flex-col gap-1">
          <span className="text-2xs uppercase tracking-wide text-text-muted">
            {aggregateLabel(card.aggregate.op)}
          </span>
          <span
            data-testid="qr-aggregate"
            className="text-2xl font-semibold tabular-nums tracking-tight"
          >
            {card.aggregate.value}
          </span>
          {/* count у агрегата — это count(*) по ВСЕЙ выборке (`compile-ast.ts`, compileSumAst), то есть
              число, которого на экране больше нет нигде. У op='count' оно совпадает со
              значением агрегата — дубль не печатаем. */}
          {card.aggregate.op !== 'count' && (
            <span data-testid="qr-count" className="text-xs text-text-secondary">
              Записей: {card.count}
            </span>
          )}
          {/* Разворота списка здесь нет — не спрятан, а снят (Р11). Единственный
              производитель агрегатной карточки, aggregateCard (dispatch.ts:417-430),
              кладёт entityIds:[] всегда: разворачивать нечего, и кнопка «Показать
              список» с её <ul> была кодом, до которого не доехать ни одной выдачей.
              Если сервер когда-нибудь начнёт слать ids вместе с агрегатом — разворот
              возвращать осознанно, вместе с тестом на непустой список. */}
        </div>
      ) : hasList ? (
        <>
          {/* Формулировка и регистр — как у счётчика виджета запроса (QueryBlock.tsx:88-90),
              чтобы список в чате и список на экране читались одинаково. */}
          <span data-testid="qr-count" className="text-xs text-text-secondary">
            Совпадений: {card.count}
          </span>
          <ul className="flex flex-col gap-1" data-testid="qr-list">
            {card.entityIds.map((id) => (
              <li key={id} data-testid="qr-item" className="text-sm text-text-secondary">
                <EntityRef id={id} />
              </li>
            ))}
          </ul>
        </>
      ) : (
        // Тихий регистр пустоты репозитория («Нет транзакций», «день свободен»), а не
        // EmptyState: py-10 с иконкой 32px внутри карточки ленты выше самой карточки.
        <p data-testid="qr-empty" className="text-sm text-text-muted">
          Ничего не найдено
        </p>
      )}
    </Card>
  );
}
