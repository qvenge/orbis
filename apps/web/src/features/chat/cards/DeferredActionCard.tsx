// Отложенное действие рутины (D42 ОЧ.4/ОЧ.13, §7) — единица «Пачки решений», которую владелец
// ПРИНИМАЕТ или ОТКЛОНЯЕТ.
//
// Карточка одна на два места: лента треда рутины (`renderCards` по `metadata.cards`) и блок
// пачки на экране прогона. Источники разведены так же, как у вопроса:
//
// 1. ТЕКСТ (`summary`, строки «было → станет») — ИЗ СООБЩЕНИЯ. «Было» это снятое ПРЕДУСЛОВИЕ
//    (ОЧ.13), а не значение графа «сейчас»: единица сверится именно с ним, и показать текущее
//    значение значило бы нарисовать согласие там, где будет отказ. Предусловия снимаются один
//    раз и не переснимаются — значит текст карточки неизменяем, и дочитывать его нечем.
// 2. СУДЬБА — только с сервера (`routine.runUnits`, Р-10): единицу могли решить со второго
//    экрана, погасить следующим прогоном или снять откатом прогона.
//
// Своя карточка, а не `confirmation_card`: там вопрос «выполнить то, о чём мы только что
// говорили?», а здесь разговора за спиной нет — владелец разбирает пачку утром, и решает он
// не пересказ, а перечень полей.
import { useState } from 'react';
import { trpc } from '../../../trpc';
import { Button } from '../../../ui/Button';
import { Card } from '../../../ui/Card';
import { beforeText, fmt, mismatchText } from './proposal-text';
import type { DeferredActionCardData } from './types';
import {
  actionFateNote,
  UNIT_FATE_NOTES,
  type UnitFate,
  type UnitMismatch,
  unitRowLabel,
} from './unit-text';
import { useRunUnit } from './useRunUnit';

export function DeferredActionCard({
  card,
  threadId,
}: {
  card: DeferredActionCardData;
  /** Тред, в ленте которого стоит карточка; `undefined` — экран прогона (рулинг П-5). */
  threadId?: string;
}) {
  const { unit, loaded, isError, errorMessage, isFetching, settled } = useRunUnit({
    runId: card.runId,
    pendingId: card.pendingId,
    threadId,
  });
  /**
   * Развёрнуты ли строки решённой карточки. Локально В САМОЙ карточке — тот же довод, что у
   * `QuestionCard`: снаружи от разворота не зависит ничего, а у карточки в ленте родителя с
   * состоянием нет вовсе. Компонент при сворачивании не размонтируется — расхождения
   * последнего нажатия обязаны его пережить.
   */
  const [expanded, setExpanded] = useState(false);
  /**
   * Расхождения ПОСЛЕДНЕГО нажатия «Принять» — в сыром виде, как их вернул сервер: ответ
   * мутации несёт значения («ожидали false, сейчас true»), и это точнее любого пересказа.
   * Держим состоянием, потому что перечитанная единица про них не расскажет: сервер уже
   * ПОГАСИЛ протухшую единицу, и в пачке она лежит просто отклонённой по причине `stale`.
   */
  const [mismatches, setMismatches] = useState<readonly UnitMismatch[] | null>(null);
  /**
   * Ответ `already` последнего нажатия: решать было нечего — судьба у единицы уже есть, своя
   * (повтор кнопки) или чужая (второй экран, гашение). Держим по той же причине, что и
   * расхождения: перечитанная единица покажет судьбу, но не то, что случилось с ЭТИМ нажатием.
   */
  const [alreadyFate, setAlreadyFate] = useState<UnitFate | null>(null);

  const decide = trpc.routine.decideDeferred.useMutation({
    onSuccess: (result) => {
      setMismatches(result.status === 'stale' ? result.mismatches : null);
      setAlreadyFate(result.status === 'already' ? result.fate : null);
      // Бюджет перечитывается только у ПРИМЕНЁННОГО: отложенная правка могла тронуть сумму,
      // категорию или статус траты (см. `settled`).
      settled({ applied: result.status === 'applied' });
    },
  });

  const fateNote = unit === undefined ? null : actionFateNote(unit);
  /** Решено — принято, отклонено, погашено или снято: кнопок больше нет. */
  const resolved = fateNote !== null;
  /**
   * Кнопки заблокированы и на время ПЕРЕЧИТЫВАНИЯ судьбы, а не только полёта мутации: между
   * ответом сервера и приездом новой судьбы «Принять» ещё жива, и второй клик уходил бы в уже
   * решённую единицу (тот же довод, что у `ProposalCard`).
   */
  const busy = decide.isPending || isFetching;
  /**
   * Сводка сервера ставится в строку БЕЗ своих кавычек: она уже несёт их вокруг заголовка цели
   * («Архивация: «Старый проект»»), и вторая пара дала бы вложенные ёлочки.
   */
  const summaryLine = `Отложено: ${card.summary}`;

  return (
    <Card data-testid="deferred-action-card" className="flex flex-col gap-3">
      {resolved ? (
        // Строка-итог решённого: «прячем всё, кроме требующего ответа» (§7). Судьба стоит
        // В САМОЙ строке, а не в разборе: свёрнутая карточка — всё, что увидит владелец,
        // решивший её не разворачивать (правило `ProposalOverlay`).
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
          className="flex cursor-pointer flex-wrap items-baseline gap-x-1 text-left text-sm"
        >
          {/* Строка-итог остаётся одной строкой: заголовок цели в сводке бывает длинным
              (потолок значения сервер держит только у строк «было → станет»). */}
          <span className="line-clamp-1 min-w-0">{summaryLine}</span>
          <span className="text-text-muted">— {fateNote}</span>
        </button>
      ) : (
        <p className="text-sm">{summaryLine}</p>
      )}

      {/* Исход нажатия — СНАРУЖИ разворота, у самой шапки: единица сворачивается в ту же
          секунду, и расхождения, спрятанные в разбор, исчезли бы вместе с ним — то есть ровно
          там, где владелец их и ждёт после своего нажатия. */}
      {mismatches !== null && (
        <div
          // `stale` — ЗНАЧЕНИЕ ответа, а не сбой (Р-2): граф разошёлся с единицей, и владельцу
          // показывают, ЧЕМ именно, а не плашку ошибки. `status`, а не `alert`: ответ приезжает
          // по его же жесту, перебивать чтение нечем.
          role="status"
          data-testid="deferred-stale"
          className="flex flex-col gap-1 rounded-control border border-line bg-surface-2/40 p-3 text-sm"
        >
          <p>Устарело — состояние изменилось.</p>
          <ul className="flex flex-col gap-1 text-text-secondary text-xs">
            {mismatches.map((m) => (
              <li key={`${m.aspect}:${m.field}`}>{mismatchText(m)}</li>
            ))}
          </ul>
        </div>
      )}
      {alreadyFate !== null && (
        <p role="status" data-testid="deferred-outcome" className="text-text-muted text-xs">
          {`Решать было нечего: единица уже решена — ${UNIT_FATE_NOTES[alreadyFate]}`}
        </p>
      )}

      {(!resolved || expanded) && (
        <ul data-testid="deferred-rows" className="flex flex-col gap-1 text-sm">
          {card.rows.map((row) => (
            // Ключ — ПАРОЙ (аспект + поле): одна единица правит несколько полей, и поле
            // аспекта может совпасть по имени с полем самой записи.
            <li
              key={`${row.aspect ?? ''}:${row.field}`}
              className="flex flex-wrap items-baseline gap-x-2 border-line/60 border-b py-1 last:border-b-0"
            >
              <span className="text-text-secondary">{unitRowLabel(row)}</span>
              <span className="flex flex-wrap items-baseline gap-x-1">
                {/* «Было» — снятое ПРЕДУСЛОВИЕ, а не значение сейчас (ОЧ.13). У полей, которых
                    у цели не было, предусловия нет вовсе — такая строка едет одним «станет». */}
                {row.before !== undefined && (
                  <span className="text-text-muted line-through">{beforeText(row.before)}</span>
                )}
                <span aria-hidden>→</span>
                <span className="text-accent">{fmt(row.after)}</span>
              </span>
            </li>
          ))}
        </ul>
      )}

      {decide.isError && (
        <p role="alert" className="text-danger text-sm">
          {decide.error.message}
        </p>
      )}

      {!loaded ? (
        // Отказ чтения — СЛОВАМИ сервера, а не вечным многоточием: карточка приезжает из ленты
        // и на холодной вкладке, и «…» на месте кнопок читалось бы как «ещё грузится».
        <p className="text-sm text-text-muted">{isError ? errorMessage : '…'}</p>
      ) : unit === undefined ? (
        // Единица прогона не найдена: строки выше остаются (владелец видит, что предлагалось),
        // а кнопок нет — сервер по ней откажет.
        <p className="text-sm text-text-muted">Единица не найдена в прогоне — решать нечего.</p>
      ) : (
        unit.fate === 'open' && (
          <div className="flex flex-wrap gap-2">
            <Button
              variant="primary"
              disabled={busy}
              // Адрес — только `pendingId`: прогон сервер читает из самой записи (routers/routine.ts)
              onClick={() => decide.mutate({ pendingId: card.pendingId, decision: 'approve' })}
            >
              Принять
            </Button>
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => decide.mutate({ pendingId: card.pendingId, decision: 'reject' })}
            >
              Отклонить
            </Button>
          </div>
        )
      )}
    </Card>
  );
}
