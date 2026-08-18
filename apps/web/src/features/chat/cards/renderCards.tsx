import type { ReactNode } from 'react';
import { Button } from '../../../ui/Button';
import type { ChatMessage } from '../useChatThread';
import { ConfirmationCard } from './ConfirmationCard';
import { EntityCard } from './EntityCard';
import { ErrorCard } from './ErrorCard';
import { ImportReviewCard } from './ImportReviewCard';
import { MemoryRuleCard } from './MemoryRuleCard';
import { QueryResultCard } from './QueryResultCard';
import { SystemMessage } from './SystemMessage';
import type { Card } from './types';

// Метка синтетической карточки fast-path (useFastPath): entityId+исходная строка.
type FastPathMeta = { entityId?: string; text: string; status: 'confirmed' | 'pending' };

// Обработчики chat-действий, прокидываемые сверху (ChatScreen → MessageList):
//  - onRetry: §3 — снять устаревший error_card и переслать упавшее ai.sendMessage тем же id;
//  - onReparse: «разобрать с AI» — архив fast-сущности + LLM (только у подтверждённой карточки).
export type CardHandlers = {
  onRetry?: (args: { errorMessageId: string; id: string; content: string }) => void;
  onReparse?: (entityId: string, text: string) => void;
};

type CardsMeta = {
  cards?: Card[];
  author_kind?: string;
  /**
   * Журнальная запись действия (§7.8): КТО двигал граф. Здесь только та часть формы
   * `ActionRecord`, которую читает лента, — остальное ей не нужно, а полный тип живёт на
   * сервере. Инвариант «один action на audit-сообщение» тот же, что у undo и отката: читаем
   * `actions[0]`.
   */
  actions?: Array<{ actor_kind?: string; actor_grant_id?: string }>;
  retryId?: string;
  retryText?: string;
  fastPath?: FastPathMeta;
};

function readMeta(msg: ChatMessage): { meta: CardsMeta; cards: Card[]; confirmed: boolean } {
  const meta = (msg.metadata ?? {}) as CardsMeta;
  return {
    meta,
    cards: meta.cards ?? [],
    // Fast-path-карточка «⏳» (pending) ещё НЕ на сервере — остаток конверта §4.1 ей
    // недоступен (как «Разобрать с AI» ниже); карточки без fastPath-меты серверные.
    confirmed: meta.fastPath === undefined || meta.fastPath.status === 'confirmed',
  };
}

/**
 * Текст сообщения дублирует заголовок карточки, которую лента ФАКТИЧЕСКИ отрисовала?
 * Тогда абзац печатать не нужно (MessageList): audit-сообщение действия несёт
 * content = заголовку записи (apps/server/src/executor/journal.ts), и в ленте выходило
 * «Кофе» абзацем и «Кофе» карточкой подряд.
 *
 * Признак — ФАКТ рендера (renderCard вернул не null), а не список известных kind:
 * список разъехался бы со switch'ем в renderCard, и рассинхрон стоил бы потери текста.
 * Историческая карточка без kind и любой неизвестный kind уходят в default: return null —
 * там абзац остаётся ЕДИНСТВЕННЫМ носителем смысла и обязан быть виден.
 */
export function contentDuplicatesCard(msg: ChatMessage, handlers: CardHandlers = {}): boolean {
  const text = msg.content.trim();
  if (text === '') return false;
  const { meta, cards, confirmed } = readMeta(msg);
  return cards.some(
    (card, i) =>
      'title' in card &&
      typeof card.title === 'string' &&
      card.title.trim() === text &&
      renderCard(card, i, { msg, meta, handlers, confirmed }) !== null,
  );
}

type CardCtx = {
  msg: ChatMessage;
  meta: CardsMeta;
  handlers: CardHandlers;
  confirmed: boolean;
};

/**
 * Одна карточка: null — kind неизвестен (историческая форма, карточка из будущего).
 * key — индекс карточки: карточки статичны в пределах сообщения. Подавлений правила
 * noArrayIndexKey тут больше нет: рендер вынесен из .map, и правило сюда не достаёт.
 */
function renderCard(card: Card, i: number, ctx: CardCtx): ReactNode {
  const { msg, meta, handlers, confirmed } = ctx;
  switch (card.kind) {
    case 'entity_card':
      return <EntityCard key={i} card={card} confirmed={confirmed} />;
    case 'query_result':
      return <QueryResultCard key={i} card={card} />;
    case 'confirmation_card':
      return <ConfirmationCard key={i} card={card} createdAt={msg.createdAt} />;
    case 'import_review':
      return <ImportReviewCard key={i} card={card} />;
    case 'memory_rule_suggestion':
      // §7.8: предложение правила памяти. memory_rule_declined своей ветки не имеет —
      // его текст несёт content сообщения (см. types.ts).
      // msg.id — ключ детерминированного id создаваемого правила (идемпотентность
      // «Запомнить» между монтированиями), msg.createdAt — 24ч visual-expiry.
      return <MemoryRuleCard key={i} card={card} messageId={msg.id} createdAt={msg.createdAt} />;
    case 'error_card':
      // §3: retryId+retryText есть → «Повторить» снимет этот error_card и перешлёт тем же id.
      return (
        <ErrorCard
          key={i}
          card={card}
          onRetry={
            meta.retryId && meta.retryText && handlers.onRetry
              ? () =>
                  handlers.onRetry?.({
                    errorMessageId: msg.id,
                    id: meta.retryId as string,
                    content: meta.retryText as string,
                  })
              : undefined
          }
        />
      );
    default:
      return null;
  }
}

// Диспетчер по metadata.cards[]: серверный Card-union рендерится клиентом (Task 10).
// Сообщение агента (author_kind) и действие агента (actions[0].actor_kind) оборачиваются в
// SystemMessage (🤖 агент, 02 §2.3) — см. разбор у самой ветки.
export function renderCards(msg: ChatMessage, handlers: CardHandlers = {}): ReactNode {
  const { meta, cards, confirmed } = readMeta(msg);
  const body = cards.map((card, i) => renderCard(card, i, { msg, meta, handlers, confirmed }));

  // «Разобрать с AI» — только у подтверждённой fast-карточки (офлайн «⏳» недоступна до confirm).
  const fp = meta.fastPath;
  if (fp?.status === 'confirmed' && fp.entityId && handlers.onReparse) {
    body.push(
      <Button
        key="reparse"
        variant="ghost"
        size="sm"
        className="self-start"
        onClick={() => handlers.onReparse?.(fp.entityId as string, fp.text)}
      >
        Разобрать с AI
      </Button>,
    );
  }

  /**
   * Метка агента — по ЛЮБОМУ из двух признаков, а не по одному вместо другого (приёмка 14).
   *
   * `author_kind` помечает сообщение, которое агент написал САМ (02 §2.3). Но работу внешнего
   * исполнителя владелец видит иначе: её приносит audit-запись действия, а её пишет сервер от
   * системы — `author_kind` там не агентский, зато `actions[0].actor_kind === 'agent'`. Считать
   * только второе значило бы потерять первое; заменить одно другим — тоже. Источника два,
   * метка одна: «это делал не ты».
   */
  const byAction = meta.actions?.[0]?.actor_kind === 'agent';
  if (meta.author_kind === 'agent' || byAction) return <SystemMessage>{body}</SystemMessage>;
  return <>{body}</>;
}
