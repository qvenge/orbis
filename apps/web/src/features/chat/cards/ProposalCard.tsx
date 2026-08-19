// Предложение рутины (V1.6, V1.9, V1.14): что рутина хочет изменить в графе — ПОСТРОЧНО, с
// объяснением прозой и решением владельца.
//
// Карточка одна на два места: лента треда рутины (renderCards по metadata.cards) и экран
// самого прогона (RunFeed). Поэтому от чат-контекста она чиста — единственный вход `runId`,
// а всё остальное приезжает с сервера (`routine.proposal`).
//
// Два решения, ради которых эта карточка не переиспользует ConfirmationCard:
//
// 1. Операции ПЕРЕЧИСЛЯЮТСЯ, а не пересказываются. Подтверждение из чата отвечает на вопрос
//    «выполнить то, о чём мы только что говорили?», и «50 операций» там — уместное резюме
//    разговора, который владелец только что вёл. Предложение рутины владелец видит УТРОМ и
//    разговора за ним нет: принять «50 операций» вслепую значит отдать граф модели (V1.14).
// 2. Клиентского срока годности (EXPIRY_MS) здесь НЕТ (Р-17). Судьбу предложения решает
//    сервер: сверка предусловий на «Принять», гашение новым прогоном, решение со второго
//    экрана. Часы вкладки об этом не знают ничего, и «устарело» по возрасту сообщения
//    гасило бы кнопки живого предложения — и наоборот.
import { useState } from 'react';
import { EntityRef } from '../../../lib/entity-ref/EntityRef';
import { aspectLabel, fieldLabel } from '../../../lib/field-labels';
import { formatDate } from '../../../lib/format';
import { invalidateGraph } from '../../../lib/invalidate';
import { openEntity } from '../../../state/navigation';
import { type RouterOutputs, trpc } from '../../../trpc';
import { Button } from '../../../ui/Button';
import { Card } from '../../../ui/Card';

type ProposalView = NonNullable<RouterOutputs['routine']['proposal']>;
type Operation = ProposalView['operations'][number];
type DecideResult = RouterOutputs['routine']['decideProposal'];
/** Сырое расхождение предусловия — форма ответа `decideProposal` (не note-форма аспекта). */
type Mismatch = Extract<DecideResult, { status: 'stale' }>['mismatches'][number];

/**
 * Судьба предложения словами. `approved` в словаре нет: у него печатается ещё и дата решения,
 * а «Принято» без даты через неделю ничего не сообщает.
 */
const STATUS_NOTES: Record<string, string> = {
  rejected: 'Отклонено',
  superseded: 'Заменено новым прогоном',
  stale: 'Устарело',
};

/**
 * Прогон в архиве — след ОТКАТА (rollback.ts): откат гасит открытое у прогона (`stale`), и
 * у `stale` без расхождений архив означает именно «прогон откачен», а не «граф разошёлся».
 * `pending` под архивом — запись до этого хвоста (или гонка: откат уже архивировал, гашение
 * ещё не доехало): решать по ней нельзя (сервер ответит NOT_FOUND), кнопок нет.
 */
const ARCHIVED_NOTES: Record<string, string> = {
  stale: 'Устарело — прогон откачен',
  pending: 'Прогон откачен — предложение снято',
};

/**
 * Значение поля строкой. Пустая строка и `null` — «пусто», а не пропуск: в правке они
 * означают снятие значения, и молчание о них читалось бы как «поле не тронут».
 */
function fmt(value: unknown): string {
  if (value === undefined) return '—';
  if (value === null) return 'пусто';
  if (typeof value === 'string') return value === '' ? 'пусто' : value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.length === 0 ? 'пусто' : value.map(fmt).join(', ');
  return JSON.stringify(value);
}

/** «Было» из снятого предусловия: литерал `'absent'` — контракт сервера «поля не было». */
function beforeText(value: unknown): string {
  return value === 'absent' ? '(не было)' : fmt(value);
}

/**
 * Подпись строки. Поле аспекта — по-русски (`orbis/task` + `due_date` → «Задача · срок»);
 * всё остальное (создание записи, связь, поля вне аспектов) — запасным текстом сервера: он
 * уже собран из тех же имён, а второй словарь на клиенте разошёлся бы с ним первой же схемой.
 */
function rowLabel(op: Operation): string {
  return op.aspect !== undefined && op.field !== undefined
    ? `${aspectLabel(op.aspect)} · ${fieldLabel(op.field)}`
    : op.summary;
}

/** Чего ждало предложение: список допустимых значений либо «поля не было». */
function expectedText(expected: Mismatch['expected']): string {
  return expected === 'absent' ? 'поля не было' : expected.map(fmt).join(' / ');
}

/**
 * Расхождение по ТЕЛУ сервер отдаёт с `aspect: ''`, `field: 'body'` (тело — вне аспектов), а
 * ожидали/сейчас у него — отметки `updated_at` строки: CAS тела сравнивает версии, а не текст.
 * Печатать владельцу два timestamp'а — значит показать ему то, что не читается; смысл один:
 * запись менялась после того, как рутина её видела.
 */
function isBodyMismatch(m: { aspect: string; field: string }): boolean {
  return m.aspect === '' && m.field === 'body';
}

const BODY_MISMATCH_TEXT = 'Тело: запись изменилась после составления предложения';

/** Строка разбора расхождения из ответа `decideProposal` (сырые значения). */
function mismatchText(m: Mismatch): string {
  if (isBodyMismatch(m)) return BODY_MISMATCH_TEXT;
  return `${aspectLabel(m.aspect)} · ${fieldLabel(m.field)}: ожидали ${expectedText(m.expected)}, сейчас ${fmt(m.actual)}`;
}

/** Строка разбора из аспекта прогона (нота уже словами). */
function noteText(m: { aspect: string; field: string; note: string }): string {
  if (isBodyMismatch(m)) return BODY_MISMATCH_TEXT;
  return `${aspectLabel(m.aspect)} · ${fieldLabel(m.field)}: ${m.note}`;
}

export function ProposalCard({ runId }: { runId: string }) {
  const utils = trpc.useUtils();
  const tz = trpc.user.getSettings.useQuery().data?.timezone;
  const proposal = trpc.routine.proposal.useQuery({ runId });
  /**
   * Расхождения ПОСЛЕДНЕГО нажатия «Принять» — в сыром виде, как их вернул сервер. Держать их
   * состоянием, а не читать из перечитанного предложения, нужно ради формы: ответ мутации
   * несёт значения (`ожидали inbox, сейчас done`), а аспект прогона — уже готовую ноту.
   * Первая точнее, вторая переживает перезагрузку; рисуем ту, что есть (см. `staleRows`).
   */
  const [mismatches, setMismatches] = useState<Mismatch[] | null>(null);

  const decide = trpc.routine.decideProposal.useMutation({
    onSuccess: (result) => {
      /**
       * Граф двигает ЛЮБОЕ решение, а не только принятое, — и это не перестраховка.
       * `approve` исполняет пачку правок; но и `reject`, и `stale` пишут судьбу предложения в
       * аспект самого прогона (`proposal.status`, `decided_at`, `mismatches`) обычным
       * executor'ом, то есть меняют запись графа. Без инвалидации кэш держит её ещё 30 секунд
       * (staleTime): история прогонов на экране рутины продолжала бы показывать «предложение:
       * ждёт решения» после отказа, а обзор рутины — прежнее «ждёт».
       */
      invalidateGraph(utils);
      // Принятое предложение правит и деньги (перенос категории, сумма, статус траты) —
      // бюджетные агрегаты живут своим ключом и в invalidateGraph не входят (ConfirmationCard).
      if (result.status === 'applied') void utils.budget.invalidate();
      setMismatches(result.status === 'stale' ? result.mismatches : null);
      // Статус карточки — с сервера ВСЕГДА, в том числе после своего же нажатия: `already`
      // значит, что предложение решили без нас, и локальное «принято» было бы неправдой.
      void proposal.refetch();
    },
  });

  const view = proposal.data;
  const staleRows =
    mismatches !== null
      ? mismatches.map((m) => ({ key: `${m.aspect}:${m.field}`, text: mismatchText(m) }))
      : view?.status === 'stale' && view.mismatches !== undefined
        ? view.mismatches.map((m) => ({ key: `${m.aspect}:${m.field}`, text: noteText(m) }))
        : null;

  /**
   * Кнопки заблокированы и на время ПЕРЕЧИТЫВАНИЯ статуса, а не только полёта мутации: между
   * ответом сервера и приездом нового статуса кнопка «Принять» ещё жива, и второй клик уходил
   * бы в уже решённое предложение (сервер ответит `already`, но окно врать владельцу о
   * состоянии карточки заводить незачем).
   */
  const busy = decide.isPending || proposal.isFetching;

  return (
    <Card data-testid="proposal-card" className="flex flex-col gap-3">
      {view === undefined ? (
        // Отказ чтения — СЛОВАМИ сервера, а не вечным многоточием: карточка приезжает из
        // ленты и на холодной вкладке, и «…» на месте кнопок читалось бы как «ещё грузится».
        <p className="text-sm text-text-muted">{proposal.isError ? proposal.error.message : '…'}</p>
      ) : view === null ? (
        // `null` — не только «предложения нет»: прогон удалён, откачен или это вовсе не
        // рутинный прогон (routers/routine.ts). Для владельца все случаи одно и то же
        // «показывать нечего», и спиннер навсегда вместо строки был бы обманом.
        <p className="text-sm text-text-muted">Предложение недоступно — прогон не найден.</p>
      ) : (
        <>
          {view.explanation !== '' && <p className="text-sm">{view.explanation}</p>}

          <ul data-testid="proposal-operations" className="flex flex-col gap-1 text-sm">
            {view.operations.map((op) => (
              // Ключ — ПАРОЙ (операция + поле): у одной операции `entity_update` строк
              // столько, сколько полей она правит, и `index` у них общий (task-11-report).
              <li
                key={`${op.index}:${op.aspect ?? ''}:${op.field ?? ''}`}
                className="flex flex-wrap items-baseline gap-x-2 border-line/60 border-b py-1 last:border-b-0"
              >
                {op.entity !== undefined && (
                  <span className="font-medium">
                    <EntityRef id={op.entity.id} onOpen={openEntity} />
                  </span>
                )}
                <span className="text-text-secondary">{rowLabel(op)}</span>
                {(op.before !== undefined || op.after !== undefined) && (
                  <span className="flex flex-wrap items-baseline gap-x-1">
                    {/* «Было» — снятое ПРЕДУСЛОВИЕ, а не значение сейчас: именно с ним
                        предложение сверится на «Принять» (V1.7). У полей вне аспектов
                        предусловия нет вовсе — такая строка едет одним «станет». */}
                    {op.before !== undefined && (
                      <span className="text-text-muted line-through">{beforeText(op.before)}</span>
                    )}
                    <span aria-hidden>→</span>
                    <span className="text-accent">{fmt(op.after)}</span>
                  </span>
                )}
              </li>
            ))}
          </ul>

          {decide.isError && (
            <p role="alert" className="text-danger text-sm">
              {decide.error.message}
            </p>
          )}

          {staleRows !== null && (
            <div
              // `stale` — ЗНАЧЕНИЕ ответа, а не сбой (Р-2): граф разошёлся с предложением, и
              // владельцу показывают, чем именно, а не плашку ошибки. `status`, а не `alert`:
              // ответ приезжает по его же жесту, перебивать чтение нечем.
              role="status"
              data-testid="proposal-stale"
              className="flex flex-col gap-1 rounded-control border border-line bg-surface-2/40 p-3 text-sm"
            >
              <p>Устарело — состояние изменилось.</p>
              <ul className="flex flex-col gap-1 text-text-secondary text-xs">
                {staleRows.map((row) => (
                  <li key={row.key}>{row.text}</li>
                ))}
              </ul>
            </div>
          )}

          {view.status === 'pending' && !view.runArchived ? (
            <div className="flex flex-wrap gap-2">
              <Button
                variant="primary"
                disabled={busy}
                onClick={() => decide.mutate({ runId, decision: 'approve' })}
              >
                Принять
              </Button>
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() => decide.mutate({ runId, decision: 'reject' })}
              >
                Отклонить
              </Button>
            </div>
          ) : (
            // Слово «Устарело» печатается ОДИН раз: у статуса `stale` его уже несёт заголовок
            // блока расхождений, и вторая строка рядом читалась бы как второе сообщение.
            (view.status !== 'stale' || staleRows === null) && (
              <p className="text-text-muted text-xs">
                {view.status === 'approved'
                  ? // Прогон в архиве — след ОТКАТА (rollback.ts): принятый план уже снят, и
                    // «Принято» без оговорки читалось бы как действующий
                    `${view.runArchived ? 'Принято, затем откачено' : 'Принято'}${view.decidedAt === undefined ? '' : ` ${formatDate(view.decidedAt, tz)}`}`
                  : ((view.runArchived ? ARCHIVED_NOTES[view.status] : undefined) ??
                    STATUS_NOTES[view.status] ??
                    view.status)}
              </p>
            )
          )}
        </>
      )}
    </Card>
  );
}
