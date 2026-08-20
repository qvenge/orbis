// Предложение рутины (V1.6, V1.9, V1.14): что рутина хочет изменить в графе — ПОСТРОЧНО, с
// объяснением прозой и решением владельца.
//
// Карточка одна на два места: лента треда рутины (renderCards по metadata.cards) и экран
// самого прогона (RunFeed). Всё содержимое приезжает с сервера (`routine.proposal`); из
// контекста карточка берёт ровно два признака, и оба — про АДРЕС, а не про данные:
// `pendingId` (какое именно предложение эта карточка показывает) и `threadId` (лежит ли она
// в ленте). Ш1.3 без них не строится: после правки владельца у одного прогона два
// предложения, а `routine.proposal` отвечает только про живое.
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
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { EntityRef } from '../../../lib/entity-ref/EntityRef';
import { aspectLabel, fieldLabel } from '../../../lib/field-labels';
import { formatDate } from '../../../lib/format';
import { invalidateGraph } from '../../../lib/invalidate';
import { openEntity } from '../../../state/navigation';
import { type RouterOutputs, trpc } from '../../../trpc';
import { Button } from '../../../ui/Button';
import { Card } from '../../../ui/Card';
import { chatThreadKey } from '../useChatThread';

type ProposalView = NonNullable<RouterOutputs['routine']['proposal']>;
type Operation = ProposalView['operations'][number];
type DecideResult = RouterOutputs['routine']['decideProposal'];
/** Сырое расхождение предусловия — форма ответа `decideProposal` (не note-форма аспекта). */
type Mismatch = Extract<DecideResult, { status: 'stale' }>['mismatches'][number];
/** Почему умерло предложение, по которому владелец решал (ответ `replaced`). */
type ReplacedReason = Extract<DecideResult, { status: 'replaced' }>['reason'];
type BodyDiff = NonNullable<Operation['bodyDiff']>;
/** Единица показа диффа тела — блок документа в терминах `@orbis/shared/doc/diff`. */
type DiffUnit = Extract<BodyDiff, { units: unknown }>['units'][number];

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
 * Прогон в архиве. Путей в архив два — откат прогона (rollback.ts: он гасит открытое у прогона
 * `stale` ДО архивации) и рука владельца из меню ⋮ «Архивировать», — и различить их здесь
 * нечем, поэтому подпись нейтральная, как бейдж RunFeed: «прогон в архиве». У `stale` без
 * расхождений она уточняет, что «устарело» — не про разошедшийся граф; `pending` под архивом —
 * запись до этого хвоста либо архив рукой владельца: решать по ней нельзя (сервер под архивом
 * прогон не находит — NOT_FOUND), кнопок нет.
 */
const ARCHIVED_NOTES: Record<string, string> = {
  stale: 'Устарело — прогон в архиве',
  pending: 'Прогон в архиве — решение недоступно',
};

/**
 * Почему различия тела нет — СЛОВАМИ (Ш1.1). Причины три, и они означают разное: у
 * `body_changed` предложение вдобавок предскажет `stale` на «Принять», у остальных двух
 * предложение живо и принимается целиком — не построилась только картинка.
 *
 * Отсутствие `bodyDiff` вовсе в этот словарь НЕ входит и пометки не даёт: «диффа нет» — это
 * не «дифф не построен», и лишняя строка под решённым предложением была бы шумом.
 *
 * Экспортом — для слоя предложения на записи (Ш1.3, Задача 10): там те же три причины и
 * тот же владелец, а вторая копия словаря разошлась бы с этой на первой же правке текста.
 */
export const BODY_DIFF_SKIP_NOTES: Record<string, string> = {
  body_changed: 'Тело изменилось после составления',
  too_large: 'Слишком большое тело — дифф не построен',
  rewritten: 'Тело переписано целиком — дифф не построен',
};

/**
 * Судьба АДРЕСОВАННОГО предложения в ответе `replaced` — по причине его отказа, а не по
 * статусу живого. Тексты зеркалят серверные (`policy/pending.ts` REJECT_CONTENT): владелец
 * читает ленту и карточку подряд, и два разных слова про одно событие читались бы как два
 * события.
 */
const REPLACED_NOTES: Record<string, string> = {
  edited: 'Заменено правкой владельца',
  superseded: 'Заменено новым прогоном',
  stale: 'Устарело — состояние изменилось',
  owner: 'Отклонено',
};

/**
 * Сколько блоков различия показывает карточка (Развилка 10). Карточка в ленте отвечает на
 * вопрос «стоит ли идти смотреть», а не заменяет запись: полный дифф — на записи (Ш1.3).
 */
const COLLAPSED_DIFF_UNITS = 3;

const PART_CLASS: Record<string, string> = {
  same: '',
  added: 'text-accent',
  removed: 'text-text-muted line-through',
};

/**
 * Единицы различия тела списком — по одной строке на блок документа.
 *
 * Что рисуется: `added` — только «стало», `removed` — только «было» зачёркнутым, `changed` —
 * внутриблочные куски (`parts`), а если их нет (блок длиннее потолка слов) — «было → стало»
 * целиком. `same` в списке остаётся серым: он не мусор, а контекст, по которому владелец
 * узнаёт место правки.
 *
 * Экспортом — тому же слою на записи (Задача 10) и клиентскому диффу режима правки
 * (Задача 11): у них те же `DiffUnit` из `@orbis/shared/doc/diff` и то же правило показа.
 * ВАЖНО: компонент читает только структуру единиц и НИЧЕГО не импортирует из
 * `@orbis/shared/doc` — карточка живёт в эагерном чанке чата, и ребро на схему Tiptap
 * стоило бы там +154 кБ gzip (страж `scripts/check-lazy-chunks.ts`).
 */
export function BodyDiffUnits({ units }: { units: readonly DiffUnit[] }) {
  return (
    <ul data-testid="proposal-body-diff" className="flex w-full flex-col gap-0.5">
      {units.map((unit, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: порядок единиц документный и жёсткий (diff.ts), тексты блоков повторяются — место в списке и есть личность единицы
        <li key={i} className="flex flex-wrap items-baseline gap-x-1">
          {unit.parts !== undefined ? (
            unit.parts.map((part, p) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: куски идут в порядке слов блока — место и есть личность куска
              <span key={p} className={PART_CLASS[part.kind]}>
                {part.text}
              </span>
            ))
          ) : (
            <>
              {unit.kind !== 'same' && unit.before !== undefined && (
                <span className="text-text-muted line-through">{unit.before}</span>
              )}
              {unit.kind === 'changed' && unit.after !== undefined && <span aria-hidden>→</span>}
              {unit.after !== undefined && (
                <span className={unit.kind === 'same' ? 'text-text-muted' : 'text-accent'}>
                  {unit.after}
                </span>
              )}
            </>
          )}
        </li>
      ))}
    </ul>
  );
}

/** Сколько блоков добавлено, удалено и изменено — одним проходом по единицам. */
function diffCounts(units: readonly DiffUnit[]): {
  added: number;
  removed: number;
  changed: number;
} {
  const counts = { added: 0, removed: 0, changed: 0 };
  for (const unit of units) {
    if (unit.kind === 'added') counts.added += 1;
    else if (unit.kind === 'removed') counts.removed += 1;
    else if (unit.kind === 'changed') counts.changed += 1;
  }
  return counts;
}

/**
 * Свёрнутый дифф тела в карточке (Развилка 10): счётчики и первые три блока различия,
 * дальше — переход на запись.
 *
 * Блоки `same` в карточку не едут вовсе: в ленте у различия нет места на контекст, и три
 * неизменённых строки вытеснили бы единственную изменённую. На записи — наоборот (Задача 10).
 */
function CollapsedBodyDiff({ units, entityId }: { units: readonly DiffUnit[]; entityId?: string }) {
  const changed = units.filter((unit) => unit.kind !== 'same');
  const counts = diffCounts(changed);
  const rest = changed.length - COLLAPSED_DIFF_UNITS;
  if (changed.length === 0) {
    // Тело в предложении есть, а различий нет: показывать пустой список — значит заставить
    // владельца искать глазами то, чего нет.
    return <span className="text-text-muted text-xs">Тело не меняется</span>;
  }
  return (
    <span className="flex w-full flex-col gap-1">
      <span className="text-text-secondary text-xs">
        +{counts.added} −{counts.removed} ~{counts.changed}
      </span>
      <BodyDiffUnits units={changed.slice(0, COLLAPSED_DIFF_UNITS)} />
      {rest > 0 && entityId !== undefined && (
        <button
          type="button"
          onClick={() => openEntity(entityId)}
          className="cursor-pointer self-start text-text-muted text-xs hover:underline"
        >
          …и ещё {rest} — открыть запись
        </button>
      )}
    </span>
  );
}

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

/**
 * «Принято» с двумя оговорками, каждая по своему признаку: `editedFrom` — применено не то,
 * что составила рутина, а правка владельца (инвариант 8); архив прогона — принятое уже
 * откачено (rollback.ts).
 */
function approvedNote(view: ProposalView): string {
  const accepted = view.editedFrom !== undefined ? 'Принято (с правками)' : 'Принято';
  return view.runArchived ? `${accepted}, затем откачено` : accepted;
}

/**
 * Подпись карточки, чьё предложение больше НЕ живое (сверка `pendingId` разошлась).
 *
 * Причина берётся из данных, а не из статуса: `view.status` описывает судьбу ЖИВОГО
 * предложения и у пары «исходное + правленое» рассказал бы про чужое (в том числе бодрое
 * «ждёт решения» под замещённой карточкой). Единственное доказательство правки — `editedFrom`
 * живого: он и означает «моё погасила правка владельца». Дальше одного звена цепочки правок
 * доказательства нет, и карточка молчит о причине, а не угадывает её.
 *
 * «Ниже» — про ЛЕНТУ: правленое предложение приходит следующим сообщением треда и стоит под
 * этой карточкой. На экране прогона (треда нет) обещать «ниже» нечего.
 */
function replacedNote(view: ProposalView, pendingId: string, inThread: boolean): string {
  const cause = view.editedFrom === pendingId ? 'Заменено правкой владельца' : 'Заменено';
  return inThread ? `${cause} — живое предложение ниже` : cause;
}

export function ProposalCard({
  runId,
  pendingId,
  threadId,
}: {
  runId: string;
  /**
   * Какое именно предложение показывает ЭТА карточка (metadata сообщения либо указатель
   * прогона). `undefined` — историческая карточка без адреса: тогда сверять нечего и
   * карточка показывает живое, как до Ш1.
   */
  pendingId?: string;
  /** Тред, в ленте которого карточка стоит; `undefined` — экран прогона (ленты нет). */
  threadId?: string;
}) {
  const utils = trpc.useUtils();
  const queryClient = useQueryClient();
  const tz = trpc.user.getSettings.useQuery().data?.timezone;
  const proposal = trpc.routine.proposal.useQuery({ runId });
  /**
   * Расхождения ПОСЛЕДНЕГО нажатия «Принять» — в сыром виде, как их вернул сервер. Держать их
   * состоянием, а не читать из перечитанного предложения, нужно ради формы: ответ мутации
   * несёт значения (`ожидали inbox, сейчас done`), а аспект прогона — уже готовую ноту.
   * Первая точнее, вторая переживает перезагрузку; рисуем ту, что есть (см. `staleRows`).
   */
  const [mismatches, setMismatches] = useState<Mismatch[] | null>(null);
  /**
   * Ответ `replaced` последнего нажатия: решать было нечего — прогон живёт ДРУГИМ
   * предложением. Держим состоянием ровно затем, зачем и расхождения: перечитанный `view`
   * расскажет про живое, а владельцу надо сказать, что случилось с ЕГО нажатием.
   */
  const [replacedReason, setReplacedReason] = useState<ReplacedReason | null>(null);

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
      setReplacedReason(result.status === 'replaced' ? result.reason : null);
      /**
       * Лента треда живёт СВОИМ ключом react-query, и `invalidateGraph` его не касается
       * (lib/invalidate.ts — там ровно entity.query/get/count). А тред от решения меняется
       * всегда: отказ дописывает свою строку, а правка владельца рождает ВТОРУЮ карточку
       * предложения (Ш1.5). Без этой инвалидации ни то, ни другое не появилось бы до ухода
       * с вкладки и возврата спустя `staleTime` (30 с) — приёмка 9 сорвалась бы молча.
       *
       * Только при известном треде: на экране прогона (RunFeed) ленты нет вовсе, и ключа
       * тоже — рулинг П-5.
       */
      if (threadId !== undefined) {
        void queryClient.invalidateQueries({ queryKey: chatThreadKey(threadId) });
      }
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

  /**
   * Эта карточка показывает НЕ то предложение, которым прогон живёт сейчас (Ш1.3).
   *
   * Указатель прогона двигает единственный механизм — лестница правки владельца (Ш1.5),
   * поэтому расхождение всегда означает «моё предложение заменено». Показывать при этом
   * содержимое живого нельзя: `routine.proposal` ключуется одним лишь `{runId}`, обе
   * карточки треда делят кэш, и список операций (как и проза) под шапкой исходного
   * предложения оказался бы ЧУЖИМ — Р-7. Остаётся подпись и указание, где живое.
   */
  const replacedText =
    view !== undefined && view !== null && pendingId !== undefined && view.pendingId !== pendingId
      ? replacedNote(view, pendingId, threadId !== undefined)
      : null;

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
      ) : replacedText !== null ? (
        <p data-testid="proposal-replaced" className="text-text-muted text-xs">
          {replacedText}
        </p>
      ) : (
        <>
          {view.explanation !== '' && <p className="text-sm">{view.explanation}</p>}

          {/* Инвариант 8: живое предложение рождено ПРАВКОЙ ВЛАДЕЛЬЦА, и он обязан это
              видеть — иначе принимает свой же текст как предложение рутины. Признак — не
              статус (его у правки нет и не будет), а происхождение: `editedFrom`. */}
          {view.editedFrom !== undefined && (
            <p data-testid="proposal-edited" className="text-text-muted text-xs">
              {threadId !== undefined
                ? 'Правка владельца — исходное предложение выше'
                : 'Правка владельца'}
            </p>
          )}

          <ul data-testid="proposal-operations" className="flex flex-col gap-1 text-sm">
            {view.operations.map((op) => {
              // Различие тела едет отдельным полем и только у строки тела живого предложения
              // (Ш1.1): `units` — свёрнутый дифф вместо стены нового текста, `skipped` —
              // прежняя форма плюс пометка, отсутствие поля — просто прежняя форма.
              const diff = op.bodyDiff;
              const units = diff !== undefined && 'units' in diff ? diff.units : undefined;
              const skipped = diff !== undefined && 'skipped' in diff ? diff.skipped : undefined;
              return (
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
                  {units !== undefined ? (
                    <CollapsedBodyDiff units={units} entityId={op.entity?.id} />
                  ) : (
                    <>
                      {(op.before !== undefined || op.after !== undefined) && (
                        <span className="flex flex-wrap items-baseline gap-x-1">
                          {/* «Было» — снятое ПРЕДУСЛОВИЕ, а не значение сейчас: именно с ним
                              предложение сверится на «Принять» (V1.7). У полей вне аспектов
                              предусловия нет вовсе — такая строка едет одним «станет». */}
                          {op.before !== undefined && (
                            <span className="text-text-muted line-through">
                              {beforeText(op.before)}
                            </span>
                          )}
                          <span aria-hidden>→</span>
                          <span className="text-accent">{fmt(op.after)}</span>
                        </span>
                      )}
                      {/* Приёмка 16: дифф не построен — но предложение живо и принимается
                          целиком, поэтому рядом с прежней формой стоит причина, а не пустота. */}
                      {skipped !== undefined && (
                        <span className="w-full text-text-muted text-xs">
                          {BODY_DIFF_SKIP_NOTES[skipped] ?? 'Различие тела не построено'}
                        </span>
                      )}
                    </>
                  )}
                </li>
              );
            })}
          </ul>

          {decide.isError && (
            <p role="alert" className="text-danger text-sm">
              {decide.error.message}
            </p>
          )}

          {/* Приёмка 15: молча не проигрывает никто. Вкладка, открытая до правки, шлёт
              решение по мёртвому предложению — сервер отвечает `replaced`, и без этой строки
              нажатие выглядело бы как «ничего не случилось». Подпись снимается, когда своё
              слово скажет перечитанная карточка (ветка `replacedText` выше). */}
          {replacedReason !== null && (
            <p
              role="status"
              data-testid="proposal-replaced-answer"
              className="text-text-muted text-xs"
            >
              {`${REPLACED_NOTES[replacedReason] ?? 'Заменено'} — живое предложение обновлено`}
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
                onClick={() =>
                  decide.mutate({ runId, pendingId: view.pendingId, decision: 'approve' })
                }
              >
                Принять
              </Button>
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() =>
                  decide.mutate({ runId, pendingId: view.pendingId, decision: 'reject' })
                }
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
                    // «Принято» без оговорки читалось бы как действующий. «С правками» —
                    // инвариант 8: применено НЕ то, что составила рутина, а правка владельца
                    `${approvedNote(view)}${view.decidedAt === undefined ? '' : ` ${formatDate(view.decidedAt, tz)}`}`
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
