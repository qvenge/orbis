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
import { newId } from '@orbis/shared';
import { useRef, useState } from 'react';
import { trpc } from '../../../trpc';
import { Button } from '../../../ui/Button';
import { Card } from '../../../ui/Card';
import type { MemoryRuleSuggestionData } from './types';

export function MemoryRuleCard({ card }: { card: MemoryRuleSuggestionData }) {
  // Локальный итог — как у ConfirmationCard: серверная запись про отказ уедет новым
  // сообщением, а уже показанная карточка правится только своим state.
  const [resolved, setResolved] = useState<null | 'remembered' | 'declined'>(null);
  const [postError, setPostError] = useState<string | null>(null);
  // Урок B4: client-UUID генерируется ОДИН раз на показ карточки, а не на клик —
  // повтор после ошибки уходит с тем же id и идемпотентен на сервере (иначе
  // «нажал ещё раз, когда упало» породило бы второе правило).
  const idRef = useRef(newId());
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
      void utils.entity.query.invalidate();
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
  const busy = create.isPending || decline.isPending;

  function remember() {
    if (inFlight.current || resolved !== null) return;
    inFlight.current = true;
    setPostError(null);
    create.mutate({
      input: {
        id: idRef.current,
        title: card.ruleText,
        tags: [],
        // Короткое пояснение, откуда правило взялось: пользователь курирует память
        // сам (§7.4), и через месяц строка «кофе → Развлечения» должна объясняться.
        body: `Правило создано из повторных исправлений категории на «${card.categoryTitle}».`,
        aspects: { 'orbis/memory': { kind: 'rule', scope: 'orbis/financial' } },
      },
      source: 'ui',
    });
  }

  function declineRule() {
    if (inFlight.current || resolved !== null) return;
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
      <p className="text-sm">Запомнить правило: „{card.ruleText}“?</p>
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
    </Card>
  );
}
