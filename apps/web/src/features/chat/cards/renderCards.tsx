import type { ReactNode } from 'react';
import { Button } from '../../../ui/Button';
import type { ChatMessage } from '../useChatThread';
import { ConfirmationCard } from './ConfirmationCard';
import { DeferredActionCard } from './DeferredActionCard';
import { EntityCard } from './EntityCard';
import { ErrorCard } from './ErrorCard';
import { ImportReviewCard } from './ImportReviewCard';
import { MemoryRuleCard } from './MemoryRuleCard';
import { ProposalCard } from './ProposalCard';
import { QueryResultCard } from './QueryResultCard';
import { QuestionCard } from './QuestionCard';
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
  /**
   * КТО написал сообщение, если не владелец: `'agent'` — внешний исполнитель по гранту,
   * `'ai'` — внутренний AI (чат либо прогон рутины). Пишет только `thread_post`
   * (tools/dispatch.ts runThreadPost); у сообщений самого владельца поля нет.
   */
  author_kind?: string;
  /** Прогон и рутина, из которых сделан пост (`thread_post` в прогоне рутины, V1.6). */
  run_id?: string;
  routine_id?: string;
  /**
   * Журнальная запись действия (§7.8): КТО двигал граф. Здесь только та часть формы
   * `ActionRecord`, которую читает лента, — остальное ей не нужно, а полный тип живёт на
   * сервере. Инвариант «один action на audit-сообщение» тот же, что у undo и отката: читаем
   * `actions[0]`.
   *
   * `source` — ОТКУДА пришла правка (`MutationSource`). Ленте он нужен ровно за одним:
   * рутина пишет граф от «ai», как и чат-агент, и по `actor_kind` они неотличимы (V1.9).
   */
  actions?: Array<{ actor_kind?: string; actor_grant_id?: string; source?: string }>;
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
 * Текст строки ленты, который карточка несёт САМА, — или `undefined`, если такого текста у
 * неё нет. Сверка ниже ДОСЛОВНАЯ, поэтому формат здесь обязан быть копией серверного.
 *
 * Заголовок карточки — исходный случай: audit-сообщение действия несёт content = заголовку
 * записи (apps/server/src/executor/journal.ts), и в ленте выходило «Кофе» абзацем и «Кофе»
 * карточкой подряд.
 *
 * Единицы «Пачки решений» (D42) заголовка не имеют вовсе, а строку ленты сервер пишет ИЗ ТОГО
 * ЖЕ текста, что кладёт в карточку: вопрос — `routines/ask.ts`, отложенное действие —
 * `tools/dispatch.ts`. Без этих двух веток владелец читал бы вопрос дважды подряд — абзацем и
 * карточкой (Ф-6a ревью Задачи 6). Расхождение формата с сервером НЕ опасно: сверка дословная,
 * и разойдясь, она просто перестанет гасить абзац, а не спрячет что-то лишнее.
 */
function cardEchoText(card: Card): string | undefined {
  if ('title' in card && typeof card.title === 'string') return card.title;
  if (card.kind === 'question_card') return `Вопрос владельцу: «${card.question}»`;
  if (card.kind === 'deferred_action_card') return `Отложено до решения: ${card.summary}`;
  return undefined;
}

/**
 * Текст сообщения дублирует то, что несёт карточка, которую лента ФАКТИЧЕСКИ отрисовала?
 * Тогда абзац печатать не нужно (MessageList).
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
  return cards.some((card, i) => {
    const echo = cardEchoText(card);
    return (
      echo !== undefined &&
      echo.trim() === text &&
      renderCard(card, i, { msg, meta, handlers, confirmed }) !== null
    );
  });
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
    case 'proposal_card':
      // V1.6: содержимое карточка читает с сервера (routine.proposal) — поля сообщения были
      // бы снимком момента отправки, а решают предложение и позже, и с другого экрана.
      // Из сообщения едет только АДРЕС: `pendingId` — какое предложение эта карточка
      // показывает (после правки владельца их у прогона два, Ш1.3), `threadId` — что она
      // стоит в ленте, которую решение обязано перечитать. Компонент тот же, что на экране
      // прогона (RunFeed), и `threadId` там не передаётся: ленты у прогона нет.
      return (
        <ProposalCard
          key={i}
          runId={card.runId}
          pendingId={card.pendingId}
          threadId={msg.threadId}
        />
      );
    case 'deferred_action_card':
    case 'question_card':
      // D42 §7: единицы «Пачки решений». ТЕКСТ карточка берёт из сообщения (он неизменяем —
      // предусловия и вопрос снимаются один раз), а СУДЬБУ читает с сервера сама
      // (`routine.runUnits`, Р-10): пачку решают и позже, и с экрана прогона, и её гасит
      // следующий прогон. `threadId` — признак «я в ленте»: по нему решение перечитывает
      // тред (Р0-11); на экране прогона его нет вовсе (рулинг П-5, как у ProposalCard).
      return card.kind === 'question_card' ? (
        <QuestionCard key={i} card={card} threadId={msg.threadId} />
      ) : (
        <DeferredActionCard key={i} card={card} threadId={msg.threadId} />
      );
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

/**
 * Подпись «кто это делал», если не владелец, — по ЛЮБОМУ из носителей метки, а не по одному
 * вместо другого (приёмка 14, V1.9, Р-16); `undefined` — сообщение или действие владельца.
 *
 * `author_kind` помечает сообщение, которое написали САМИ агент или AI (thread_post, 02 §2.3).
 * Но работу внешнего исполнителя владелец видит иначе: её приносит audit-запись действия, а её
 * пишет сервер от системы — `author_kind` там не агентский, зато `actions[0].actor_kind ===
 * 'agent'`. Считать только второе значило бы потерять первое; заменить одно другим — тоже.
 *
 * Рутина — САМЫЙ точный носитель из всех: её правки приходят audit-записью от «ai» (по
 * `actor_kind` неотличимо от чат-агента), а её пост в тред — `author_kind: 'ai'` плюс
 * `routine_id`/`run_id`. Владельцу разница видна сразу: агент отвечает ему в разговоре,
 * рутина правит граф и пишет в треды ночью, пока его нет. Поэтому источник проверяется
 * ПЕРВЫМ: «агент» поверх ночной правки был бы не полуправдой, а указанием не на того.
 * Пост внутреннего AI из чата (`author_kind: 'ai'` без прогона) — «AI»: это тоже не слова
 * владельца, и в пузыре владельца ему не место (финальное ревью V1, B1-1/D-1).
 */
export function authorLabel(msg: ChatMessage): string | undefined {
  const meta = (msg.metadata ?? {}) as CardsMeta;
  const action = meta.actions?.[0];
  if (action?.source === 'routine') return 'рутина';
  if (meta.author_kind === 'ai' && (meta.routine_id !== undefined || meta.run_id !== undefined)) {
    return 'рутина';
  }
  if (meta.author_kind === 'agent' || action?.actor_kind === 'agent') return 'агент';
  if (meta.author_kind === 'ai') return 'AI';
  return undefined;
}

/**
 * Карточки сообщения БЕЗ обёртки-метки — для ленты, которая ставит метку сама, вокруг
 * текста и карточек вместе (MessageList: пост рутины/агента/AI в тред). `renderCards` ниже —
 * то же плюс метка; два входа, а не флаг, чтобы вызывающий не мог забыть про метку молча.
 */
export function renderCardBodies(msg: ChatMessage, handlers: CardHandlers = {}): ReactNode[] {
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
  return body;
}

// Диспетчер по metadata.cards[]: серверный Card-union рендерится клиентом (Task 10).
// Сообщение агента (author_kind) и действие агента (actions[0].actor_kind) оборачиваются в
// SystemMessage (🤖 агент, 02 §2.3) — см. authorLabel.
export function renderCards(msg: ChatMessage, handlers: CardHandlers = {}): ReactNode {
  const body = renderCardBodies(msg, handlers);
  const label = authorLabel(msg);
  if (label !== undefined) return <SystemMessage label={label}>{body}</SystemMessage>;
  return <>{body}</>;
}
