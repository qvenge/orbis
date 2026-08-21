// Вопрос рутины владельцу (D42 ОЧ.5, §7) — единица «Пачки решений», на которую ОТВЕЧАЮТ.
//
// Карточка одна на два места: лента треда рутины (`renderCards` по `metadata.cards`) и блок
// пачки на экране прогона. Разделение источников такое же, как у предложения (`ProposalCard`),
// но по своей причине:
//
// 1. ТЕКСТ вопроса берётся ИЗ СООБЩЕНИЯ, а не с сервера. Вопрос неизменяем (append-only §4.6),
//    он уже лежит в ленте, и второй запрос за ним означал бы пустую карточку на холодной
//    вкладке ради данных, которые никогда не меняются.
// 2. СУДЬБА — только с сервера (`routine.runUnits`, Р-10): между открытием вкладки и нажатием
//    вопрос могли уже отвечать со второго устройства (`already`, С5) или снять следующим
//    прогоном (`stale`, §14 В2). Локальное «отвечено» после нажатия — приём `ConfirmationCard`
//    (`:20`, `:79-80`) — врало бы ровно в этих случаях.
//
// Своя карточка, а не `confirmation_card`: её кнопки «Принять»/«Отклонить» вели бы владельца
// прямо в структурный отказ гейта рода (server `policy/pending.ts`, assertNotQuestion).
import { useId, useState } from 'react';
import { Markdown } from '../../../lib/markdown/Markdown';
import { openEntity } from '../../../state/navigation';
import { type RouterOutputs, trpc } from '../../../trpc';
import { Button } from '../../../ui/Button';
import { Card } from '../../../ui/Card';
import type { QuestionCardData } from './types';
import { QUESTION_STALE_NOTE, questionFateNote } from './unit-text';
import { useRunUnit } from './useRunUnit';

/** Исход, при котором ответ владельца НЕ записан; `answered` сюда не входит — он и есть успех. */
type AnswerOutcome = Exclude<RouterOutputs['routine']['answerQuestion'], { status: 'answered' }>;

export function QuestionCard({
  card,
  threadId,
}: {
  card: QuestionCardData;
  /** Тред, в ленте которого стоит карточка; `undefined` — экран прогона (рулинг П-5). */
  threadId?: string;
}) {
  const { unit, loaded, isError, errorMessage, isFetching, settled } = useRunUnit({
    runId: card.runId,
    pendingId: card.pendingId,
    threadId,
  });
  const answerId = useId();
  const [draft, setDraft] = useState('');
  /**
   * Развёрнут ли РАЗБОР решённой карточки. Состояние локальное и живёт В САМОЙ карточке (в
   * отличие от `ProposalOverlay`, где оно поднято в родителя ради «спрятать тело записи»):
   * снаружи от разворота не зависит ничего, а родителя у карточки в ленте нет вовсе —
   * `renderCards` чистая функция без состояния.
   *
   * Компонент при сворачивании НЕ размонтируется, свёрнут лишь разбор: набранный ответ и
   * подпись исхода обязаны пережить случайное сворачивание (правило `ProposalOverlay`).
   */
  const [expanded, setExpanded] = useState(false);
  /**
   * Исход ПОСЛЕДНЕГО нажатия, а не судьба: `already` несёт ЧУЖОЙ применившийся ответ (С5), а
   * `stale` — что вопрос сняли между открытием вкладки и нажатием (В2). Перечитанная единица
   * расскажет про судьбу, но не про то, что случилось с ЭТИМ нажатием, — и владелец увидел бы
   * «ничего не произошло».
   */
  const [outcome, setOutcome] = useState<AnswerOutcome | null>(null);

  const answer = trpc.routine.answerQuestion.useMutation({
    onSuccess: (result) => {
      setOutcome(result.status === 'answered' ? null : result);
      if (result.status === 'answered') setDraft('');
      // Ответ графа не пишет, но снимает флажок `undecided` с аспекта прогона (§9.6) —
      // поэтому «применённым» он не считается, а инвалидация графа нужна (см. `settled`).
      settled({ applied: false });
    },
  });

  const fateNote = unit === undefined ? null : questionFateNote(unit);
  /** Решённый или погашенный — то есть отвечать больше не на что. */
  const resolved = fateNote !== null;
  /**
   * Кнопки заблокированы и на время ПЕРЕЧИТЫВАНИЯ судьбы, а не только полёта мутации: между
   * ответом сервера и приездом новой судьбы форма ещё жива, и второй клик уходил бы в уже
   * отвеченный вопрос (тот же довод, что у `ProposalCard`).
   */
  const busy = answer.isPending || isFetching;

  return (
    <Card data-testid="question-card" className="flex flex-col gap-3">
      {resolved ? (
        // Строка-итог решённого: «прячем всё, кроме требующего ответа» (§7). Сам вопрос стоит
        // в ней ЦЕЛИКОМ — в ленте с несколькими вопросами «отвечен» без слов вопроса не
        // сообщает владельцу, о чём он.
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
          className="flex cursor-pointer flex-wrap items-baseline gap-x-1 text-left text-sm"
        >
          {/* Одна СТРОКА и в буквальном смысле: вопрос пишет модель, и он бывает в абзац.
              Обрезка визуальная (line-clamp), а не по символам, — развернув карточку,
              владелец получает тот же текст целиком, разметкой и без потерь. */}
          <span className="line-clamp-1 min-w-0">Вопрос: «{card.question}»</span>
          <span className="text-text-muted">— {fateNote}</span>
        </button>
      ) : (
        <p className="text-text-muted text-xs">Вопрос рутины</p>
      )}

      {/* Исход нажатия — СНАРУЖИ разворота, у самой шапки: решённая карточка сворачивается
          в ту же секунду, и подпись, спрятанная в разбор, исчезла бы вместе с ним — ровно
          там, где владелец её и ждёт (правило ProposalOverlay «важное — у шапки»). */}
      {outcome !== null && (
        <p role="status" data-testid="question-outcome" className="text-text-muted text-xs">
          {outcome.status === 'already'
            ? // С5: ответ не записан, потому что раньше применился ДРУГОЙ — и владелец обязан
              // увидеть, какой именно, иначе решит, что ответил он
              `Ответ не записан: раньше применился другой — «${outcome.answer}»`
            : // В2: вопрос погашен следующим прогоном, ответа сервер не принимает
              `Ответ не записан: вопрос ${QUESTION_STALE_NOTE}.`}
        </p>
      )}

      {(!resolved || expanded) && (
        <div className="flex flex-col gap-3" data-testid="question-body">
          {/* Разметкой, а не сырым текстом: вопрос пишет модель, и пишет она markdown'ом.
              `onEntityLink` не украшение — без него ссылка `[[entity:…]]` из вопроса
              ПЕРЕЗАГРУЖАЕТ SPA (контракт Markdown.tsx). */}
          <Markdown source={card.question} className="text-sm" onEntityLink={openEntity} />

          {!loaded ? (
            // Отказ чтения — СЛОВАМИ сервера, а не вечным многоточием: карточка приезжает из
            // ленты и на холодной вкладке, и «…» на месте кнопок читалось бы как «ещё грузится»
            <p className="text-sm text-text-muted">{isError ? errorMessage : '…'}</p>
          ) : (
            unit === undefined && (
              // Единица прогона не найдена (архив ленты старше пачки, чужой прогон): текст
              // вопроса выше остаётся, а отвечать не предлагаем — сервер откажет.
              <p className="text-sm text-text-muted">
                Единица не найдена в прогоне — отвечать нечего.
              </p>
            )
          )}

          {unit?.fate === 'open' && (
            <>
              {card.options !== undefined && card.options.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {card.options.map((option, i) => (
                    <Button
                      // biome-ignore lint/suspicious/noArrayIndexKey: индекс здесь не «порядок в массиве», а ЧАСТЬ ДАННЫХ — он уезжает на сервер полем `option` (и сверяется там с фактическими вариантами, Р3-3); список вариантов вопроса неизменяем (append-only §4.6), а тексты в нём могут повторяться
                      key={`${i}:${option}`}
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      // Текст варианта едет ТЕМ ЖЕ полем, что и свободный ответ, а индекс —
                      // отдельным: сверку индекса с фактическими вариантами делает сервер (Р3-3)
                      onClick={() =>
                        answer.mutate({
                          pendingId: card.pendingId,
                          answer: option,
                          option: i,
                        })
                      }
                    >
                      {option}
                    </Button>
                  ))}
                </div>
              )}

              {/* Свободное поле стоит РЯДОМ с вариантами, а не вместо них: готовые ответы
                  рутины не обязаны исчерпывать то, что владелец хочет сказать (§7). */}
              <div className="flex flex-col gap-1">
                <label htmlFor={answerId} className="text-sm text-text-secondary">
                  Свой ответ
                </label>
                <textarea
                  id={answerId}
                  rows={3}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  className="w-full rounded-control border border-line bg-surface px-3 py-2 text-sm text-text outline-none transition focus-visible:ring-2 focus-visible:ring-accent/40"
                />
              </div>
              {answer.isError && (
                <p role="alert" className="text-danger text-sm">
                  {answer.error.message}
                </p>
              )}
              <Button
                size="sm"
                className="self-start"
                // Пустой ответ сервер отклонит (min(1)) — не отправляем его вовсе.
                disabled={draft.trim() === '' || busy}
                // `option` НЕ шлётся: индекс — это «нажата такая-то кнопка», и `option:0` у
                // свободного ответа уехал бы в append-only metadata навсегда (Р3-3).
                onClick={() => answer.mutate({ pendingId: card.pendingId, answer: draft.trim() })}
              >
                Ответить
              </Button>
            </>
          )}
        </div>
      )}
    </Card>
  );
}
