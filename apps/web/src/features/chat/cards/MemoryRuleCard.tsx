// Карточка предложения memory-правила (01-arch §7.8 «Эскалация в правило», D3b).
// Производитель — серверная эскалация (ai/escalation.ts): после двух одинаковых
// исправлений категории она пишет системное сообщение с этой карточкой.
//
// «Запомнить» — обычный entity.create, своей процедуры у кнопки НЕТ: правило это
// сущность с аспектом orbis/memory {kind:'rule', scope:'orbis/financial'}, а вся
// машиночитаемая часть правила лежит в title (packages/shared/src/memory/rule.ts).
// «Не надо» — ai.declineMemoryRule: chat_messages append-only (§4.6), поэтому отказ
// не правит карточку, а пишется НОВЫМ системным сообщением (K4), которое заодно
// подавляет повторное предложение по этой паре категорий.
import { memoryRuleEntityId } from '@orbis/shared';
import { useRef, useState } from 'react';
import { invalidateGraph } from '../../../lib/invalidate';
import { trpc } from '../../../trpc';
import { Button } from '../../../ui/Button';
import { Card } from '../../../ui/Card';
import { MEMORY_RULES_QUERY, MEMORY_RULES_STALE_TIME } from '../memoryRules';
import type { MemoryRuleSuggestionData } from './types';

/** Тот же 24ч visual-expiry, что у ConfirmationCard (D-a). */
const EXPIRY_MS = 24 * 60 * 60 * 1000;

export function MemoryRuleCard({
  card,
  messageId,
  createdAt,
  now = Date.now(),
}: {
  card: MemoryRuleSuggestionData;
  messageId: string;
  createdAt: string;
  now?: number; // инъектируемое время (детерминизм тестов); по умолчанию — настенные часы
}) {
  // Локальный итог — как у ConfirmationCard: серверная запись про отказ уедет новым
  // сообщением, а уже показанная карточка правится только своим state.
  const [resolved, setResolved] = useState<null | 'remembered' | 'declined'>(null);
  const [postError, setPostError] = useState<string | null>(null);
  // Урок B4: client-UUID НЕ генерируется на клик. Больше того — он не случайный:
  // id правила детерминирован сообщением-предложением и самим правилом
  // (memoryRuleEntityId), потому что «решённость» карточки живёт только в state,
  // а сообщение остаётся в append-only ленте с живыми кнопками. Случайный uuidv7
  // на КАЖДОЕ монтирование означал бы второе одноимённое правило после
  // перезагрузки вкладки или с другого устройства; детерминированный id попадает
  // в ON CONFLICT DO NOTHING сервера и возвращается replay'ем той же сущности.
  const entityId = memoryRuleEntityId({
    messageId,
    pattern: card.pattern,
    toCategoryId: card.toCategoryId,
  });
  // Карточка старше суток — уже отвеченный или забытый вопрос: «решённость» в
  // ленту не пишется (journal append-only, K4), поэтому старое предложение всегда
  // выглядит неотвеченным. Гасим кнопки, как у ConfirmationCard; правило по-прежнему
  // можно попросить у AI в чате (§7.4 — память курирует пользователь).
  const expired = now - new Date(createdAt).getTime() > EXPIRY_MS;
  const utils = trpc.useUtils();
  // Защёлка двойного клика: isPending приезжает следующим рендером, поэтому два
  // клика подряд успели бы отправить два запроса. Ошибка защёлку снимает — повтор
  // руками разрешён (и безопасен: id тот же).
  const inFlight = useRef(false);

  const create = trpc.entity.create.useMutation({
    onSuccess: () => {
      setResolved('remembered');
      // Экран «Память AI» и Browser читают entity.query — новое правило должно
      // появиться там без ручного обновления (тот же приём, что у QuickCapture).
      invalidateGraph(utils);
      // Инвалидации МАЛО: быстрый ввод читает правила из тёплого кэша (сеть перед каждым
      // вводом стоила бы мгновенности карточки «⚡ без AI», §2.5), а у запроса правил нет
      // подписчиков — сам он не перечитается. Освежаем точечно здесь: «кофе 300» сразу
      // после [Запомнить] обязан уйти в новую категорию, а не в прежнюю по алиасу.
      void utils.entity.query
        .fetch(MEMORY_RULES_QUERY, { staleTime: MEMORY_RULES_STALE_TIME })
        .catch(() => {});
    },
    onError: (e) => {
      inFlight.current = false;
      setPostError(e.message);
    },
  });
  const decline = trpc.ai.declineMemoryRule.useMutation({
    onSuccess: () => setResolved('declined'),
    onError: (e) => {
      inFlight.current = false;
      setPostError(e.message);
    },
  });
  const busy = create.isPending || decline.isPending || expired;

  function remember() {
    if (inFlight.current || resolved !== null || expired) return;
    inFlight.current = true;
    setPostError(null);
    create.mutate({
      input: {
        id: entityId,
        title: card.ruleText,
        tags: [],
        // Короткое пояснение, откуда правило взялось: пользователь курирует память
        // сам (§7.4), и через месяц строка «кофе → Развлечения» должна объясняться.
        body: `Правило создано из повторных исправлений категории на «${card.categoryTitle}».`,
        aspects: { 'orbis/memory': { kind: 'rule', scope: 'orbis/money-movement' } },
      },
      source: 'ui',
    });
  }

  function declineRule() {
    if (inFlight.current || resolved !== null || expired) return;
    inFlight.current = true;
    setPostError(null);
    // pattern уходит РОВНО как пришёл, без повторной нормализации: на сервере это
    // ключ подавления по сходству (ai/escalation.ts alreadyOffered).
    decline.mutate({
      pattern: card.pattern,
      fromCategoryId: card.fromCategoryId,
      toCategoryId: card.toCategoryId,
    });
  }

  return (
    <Card data-testid="memory-rule-card" className="flex flex-col gap-2">
      {/* Только текст правила: вопрос «Запомнить правило „…“?» уже задан content'ом
          самого сообщения (ai/escalation.ts) — карточка под ним его не повторяет. */}
      <p className="text-sm font-medium">{card.ruleText}</p>
      {postError && (
        <p role="alert" className="text-xs text-danger">
          {postError}
        </p>
      )}
      {resolved === null ? (
        <div className="flex gap-2">
          <Button size="sm" disabled={busy} onClick={remember}>
            Запомнить
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={declineRule}>
            Не надо
          </Button>
        </div>
      ) : resolved === 'remembered' ? (
        <p className="text-xs text-accent">Запомнил — правило в «Памяти AI»</p>
      ) : (
        <p className="text-xs text-text-muted">Не буду предлагать это правило</p>
      )}
      {expired && resolved === null && (
        <p className="text-xs text-text-muted">Устарело — переспросите AI</p>
      )}
    </Card>
  );
}
