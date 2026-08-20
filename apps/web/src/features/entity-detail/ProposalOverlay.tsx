// Слой предложения рутины на экране записи (Ш1.3, Ш1.4).
//
// Зачем он есть. Предложение рутины живёт карточкой в ленте её треда, и до Ш1 путь к нему был
// один: открыть чат рутины и найти сообщение. Но правит-то оно ЗАПИСИ — и владелец, открывший
// задачу, обязан увидеть, что по ней есть неотвеченный план, а не узнать об этом случайно.
// Отсюда обратный вопрос серверу: «есть ли по ЭТОЙ записи открытые предложения»
// (`routine.proposalsForEntity`, Ш1.3).
//
// Три решения, которые в этом файле стоят дороже кода:
//
// 1. ПЛАШКА НА КАЖДОЕ предложение, а не одна на запись (приёмка 18). Одну запись законно
//    трогают предложения РАЗНЫХ рутин, и «выбери предложение» скрыло бы второе за первым;
//    решение по каждому своё — свой `runId`, свой `pendingId`, свои кнопки.
//
// 2. РАЗВЁРНУТЫЙ СЛОЙ ПРЯЧЕТ ТЕЛО ЗАПИСИ КЛАССОМ (Р-18), а не размонтирует его. Вкладка
//    «Сущность» живёт под `display:none` (keepMounted) вместе со своим `useBodySave`: клик в
//    тело под слоем через две секунды сдвинул бы `updated_at` — и предложение стало бы `stale`
//    само от себя (CAS `expectedUpdatedAt`, propose.ts). Размонтирование же дёрнуло бы `flush`
//    отложенной правки, то есть сделало бы ровно то, от чего мы прячемся. Класс вешает
//    DetailScreen — он владеет разметкой вкладок; слой лишь сообщает ему, развёрнут ли.
//
// 3. ПРАВКА ЗНАЧЕНИЯ ЛОЖИТСЯ В БУФЕР, а не в граф (Р-16). Тот же `AspectField` на самой записи
//    сохраняет по blur немедленно (`useEntityUpdate`); здесь это было бы катастрофой —
//    правка предложения ушла бы в запись ДО того, как владелец нажал «Принять», и заодно
//    сделала бы предложение устаревшим. Граф двигает только «Принять».
//
// Чего здесь НЕТ намеренно: режима правки тела (Задача 11 — редактор без `useBodySave`),
// deep-link'а `?proposal=` (Развилка 5: шов назван, но не строится) и всякого импорта из
// `@orbis/shared/doc` — слой эагерно достижим из чанка записи, и схема Tiptap стоила бы там
// +154 кБ gzip в первом кадре (страж `scripts/check-lazy-chunks.ts`).
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { EntityRef } from '../../lib/entity-ref/EntityRef';
import { invalidateGraph } from '../../lib/invalidate';
import { ThisEntityProvider } from '../../lib/query-blocks/this-entity';
import { openEntity } from '../../state/navigation';
import { type RouterInputs, type RouterOutputs, trpc } from '../../trpc';
import { Button } from '../../ui/Button';
import { Card } from '../../ui/Card';
import { BODY_DIFF_SKIP_NOTES, BodyDiffUnits } from '../chat/cards/BodyDiff';
import {
  beforeText,
  fmt,
  type Mismatch,
  mismatchText,
  type ProposalRow,
  REPLACED_NOTES,
  type ReplacedReason,
  rowLabel,
} from '../chat/cards/proposal-text';
import { AspectField, coerce, isScalar, readOnlyText } from './AspectCards';

type DetailEntity = RouterOutputs['entity']['get']['entity'];
type ProposalView = RouterOutputs['routine']['proposalsForEntity'][number];
/** Правка одного значения — форма входа `decideProposal.edits.fields` (routines/edits.ts). */
type FieldEdit = NonNullable<
  NonNullable<RouterInputs['routine']['decideProposal']['edits']>['fields']
>[number];

/**
 * Ключ строки предложения — та же тройка, которой строки адресует и сервер
 * (`routines/edits.ts` rowKey): у одной операции строк столько, сколько полей она правит, и
 * `index` у них общий.
 */
function rowKey(op: ProposalRow): string {
  return `${op.index}:${op.aspect ?? ''}:${op.field ?? ''}`;
}

/**
 * Правится ли строка. Границу ставит СЕРВЕР (`assertRowEditable`, рулинг Задачи 3), и экран
 * обязан её знать, а не узнавать из отказа на кнопке:
 *  - только `entity_update`: у создания записи предусловий нет, а «поправить заголовок
 *    записи, которой ещё нет» — это не правка предложения; у связей полей нет вовсе;
 *  - тело правится ДОКУМЕНТОМ, отдельным списком (Ш1.11, Задача 11), а не значением поля;
 *  - только скаляр: инпут отдаёт строку, и обратно в массив или объект она не превращается
 *    ничем — ровно поэтому теги, `recurrence` и `aliases` не правятся и на самой записи
 *    (isScalar в AspectCards).
 */
function editableRow(op: ProposalRow): boolean {
  return (
    op.tool === 'entity_update' &&
    op.field !== undefined &&
    op.field !== 'body' &&
    isScalar(op.after)
  );
}

/**
 * Значение строкой. Скаляр — как в карточке ленты, нескалярное — как на самой записи
 * (`readOnlyText`): владелец видит `progress_source` цели или `aliases` категории в той же
 * форме, в какой они стоят в свойствах, а не в двух разных.
 */
function valueText(value: unknown): string {
  return isScalar(value) ? fmt(value) : readOnlyText(value);
}

/** Русское согласование числа: «1 правка», «2 правки», «5 правок». */
function editsWord(n: number): string {
  const hundred = n % 100;
  if (hundred >= 11 && hundred <= 14) return 'правок';
  const ten = n % 10;
  if (ten === 1) return 'правка';
  if (ten >= 2 && ten <= 4) return 'правки';
  return 'правок';
}

/**
 * Слой предложений над вкладками записи. `null` — предложений нет: обычное состояние обычной
 * записи, и место под несуществующую плашку экран не держит.
 *
 * Отказ чтения тоже даёт `null`, и это осознанно: список спрашивается фоном, на открытии
 * записи, без жеста владельца — плашка «не удалось прочитать предложения» над каждой записью
 * была бы шумом о том, чего человек не просил. Цена названа: сеть легла — предложение не
 * показалось. Ленту треда рутины это не задевает, там своя карточка.
 */
export function ProposalOverlay({
  entity,
  onOverlayExpanded,
}: {
  entity: DetailEntity;
  /** Развёрнута ли ХОТЬ ОДНА плашка — экран по этому признаку прячет тело записи (Р-18). */
  onOverlayExpanded: (open: boolean) => void;
}) {
  const list = trpc.routine.proposalsForEntity.useQuery({ entityId: entity.id });
  // Array.isArray — та же защита, что у пикера категорий: слой живёт на общем экране записи,
  // и неожиданная форма ответа не должна ронять всю страницу.
  const proposals = Array.isArray(list.data) ? list.data : [];
  const [expanded, setExpanded] = useState<readonly string[]>([]);
  /**
   * Ответ `replaced` последнего нажатия — ЗДЕСЬ, а не в плашке, и это не вкусовщина.
   *
   * `replaced` значит «решать было нечего: прогон живёт другим предложением», и сразу за ним
   * список перечитывается — плашка с мёртвым `pendingId` исчезает, а её место занимает плашка
   * живого. Держи подпись внутри плашки — она умерла бы вместе с ней, и нажатие выглядело бы
   * как «список моргнул сам собой» (приёмка 15). Здесь она переживает подмену и стоит НАД
   * тем предложением, которое эту подмену объясняет.
   */
  const [replacedReason, setReplacedReason] = useState<ReplacedReason | null>(null);

  /**
   * Развёрнутыми считаются только те, что ЕСТЬ В СЕГОДНЯШНЕМ списке. Принятое предложение
   * исчезает из ответа при перечитке, и остаточный id в наборе держал бы тело записи
   * спрятанным навсегда — под слоем, которого на экране уже нет.
   */
  const openCount = proposals.filter((view) => expanded.includes(view.pendingId)).length;
  useEffect(() => {
    onOverlayExpanded(openCount > 0);
  }, [openCount, onOverlayExpanded]);

  // Пустой список — ещё не повод исчезнуть: ответ `replaced` мог прийти по предложению,
  // живой наследник которого решён в другой вкладке, и тогда список пуст, а сказать владельцу
  // есть что.
  if (proposals.length === 0 && replacedReason === null) return null;
  return (
    <div
      data-testid="proposal-overlay"
      className="mx-auto flex w-full max-w-3xl flex-col gap-2 px-4 pt-3 md:px-6"
    >
      {/* Приёмка 15: молча не проигрывает никто. Вкладка, открытая до правки, шлёт решение по
          мёртвому предложению — сервер отвечает `replaced`, и без этой строки нажатие
          выглядело бы как «ничего не случилось», хотя список под ней уже сменился. Про «ниже»
          говорим, только если там правда что-то есть. */}
      {replacedReason !== null && (
        <p role="status" data-testid="proposal-replaced-answer" className="text-text-muted text-xs">
          {`${REPLACED_NOTES[replacedReason]}${proposals.length > 0 ? ' — ниже живое предложение' : ''}`}
        </p>
      )}
      {proposals.map((view) => (
        <ProposalPlate
          key={view.pendingId}
          view={view}
          entityId={entity.id}
          open={expanded.includes(view.pendingId)}
          // Пока список перечитывается, решать нельзя ни по одной плашке: между ответом
          // сервера и приездом нового списка кнопка «Принять» ещё жива, и второй клик ушёл бы
          // в уже решённое предложение (тот же довод, что в ProposalCard).
          busy={list.isFetching}
          onToggle={(next) =>
            setExpanded((ids) =>
              next ? [...ids, view.pendingId] : ids.filter((id) => id !== view.pendingId),
            )
          }
          onAnswer={setReplacedReason}
        />
      ))}
    </div>
  );
}

/**
 * Одна плашка: свёрнутая — «есть предложение, вот от кого и на сколько правок»; развёрнутая —
 * весь разбор и решение.
 *
 * Компонент смонтирован ВСЕГДА, свёрнут лишь его разбор: буфер правок и расхождения последнего
 * нажатия обязаны пережить случайное сворачивание — иначе владелец, свернувший плашку, молча
 * терял бы набранное.
 */
function ProposalPlate({
  view,
  entityId,
  open,
  busy: listBusy,
  onToggle,
  onAnswer,
}: {
  view: ProposalView;
  entityId: string;
  open: boolean;
  /** Список перечитывается — решать нельзя ни по одной плашке (см. вызов). */
  busy: boolean;
  onToggle: (next: boolean) => void;
  /** Ответ `replaced` наверх: подпись обязана пережить подмену этой плашки живой. */
  onAnswer: (reason: ReplacedReason | null) => void;
}) {
  const utils = trpc.useUtils();
  const queryClient = useQueryClient();
  /**
   * Буфер правок значений — ПО КЛЮЧУ СТРОКИ, а не массивом: владелец правит одно поле
   * несколько раз (набрал, стёр, набрал заново), и массив копил бы дубли, которые сервер
   * отверг бы как `edit_duplicate`.
   */
  const [edits, setEdits] = useState<Record<string, FieldEdit>>({});
  /** Расхождения ПОСЛЕДНЕГО нажатия «Принять» — в сыром виде, как их вернул сервер. */
  const [mismatches, setMismatches] = useState<Mismatch[] | null>(null);

  const decide = trpc.routine.decideProposal.useMutation({
    onSuccess: (result) => {
      /**
       * Граф двигает ЛЮБОЕ решение, а не только принятое: и отказ, и `stale` пишут судьбу
       * предложения в аспект самого прогона — то есть меняют запись графа (тот же довод, что
       * в ProposalCard).
       */
      invalidateGraph(utils);
      // Принятое предложение правит и деньги (перенос категории, сумма, статус траты) —
      // бюджетные агрегаты живут своим ключом и в invalidateGraph не входят.
      if (result.status === 'applied') void utils.budget.invalidate();
      setMismatches(result.status === 'stale' ? result.mismatches : null);
      onAnswer(result.status === 'replaced' ? result.reason : null);
      /**
       * Список предложений записи о решении сам не узнает — перечитываем его явно; вместе с
       * ним и `routine.proposal`, по которому живут карточки в лентах и на экране прогона.
       *
       * КРОМЕ `stale`, и это осознанное исключение. Устаревшее предложение сервер тут же
       * гасит (`rejectPending(reason:'stale')`), то есть из ответа `proposalsForEntity` оно
       * уходит — а вместе с плашкой ушёл бы и разбор расхождений, ради которого владелец
       * сюда и смотрит. Список перечитается сам при следующем открытии записи; до тех пор
       * плашка стоит без кнопок и говорит, ЧЕМ именно граф разошёлся с предложением.
       */
      if (result.status !== 'stale') {
        void utils.routine.proposalsForEntity.invalidate();
      }
      void utils.routine.proposal.invalidate();
      /**
       * Лента треда рутины — ПО ПРЕФИКСУ ключа (`chatThreadKey` = `['chatThread', id]`).
       * Слой стоит на записи и `threadId` рутины не знает вовсе, а тред от решения меняется
       * всегда: отказ дописывает свою строку, принятие с правками рождает ВТОРУЮ карточку
       * предложения (Ш1.5). Без этого открытая рядом лента показала бы её только через
       * `staleTime` (30 с) или после смены вкладки — половина приёмки 9. Цена префикса —
       * лишняя пометка чужих тредов протухшими; они и так перечитываются лениво.
       */
      void queryClient.invalidateQueries({ queryKey: ['chatThread'] });
      // Принятое решать больше нечем: сворачиваем сами, не дожидаясь перечитки, — тело
      // записи обязано вернуться в ту же секунду, а не «когда приедет список».
      if (result.status === 'applied') onToggle(false);
      // `rejected` и `already` своей подписи не получают намеренно: оба означают «решено», и
      // перечитанный список уносит плашку целиком — вторая строка про то же самое стояла бы
      // ровно до следующего кадра.
    },
  });

  const fieldEdits = Object.values(edits);
  const busy = decide.isPending || listBusy;

  function send(decision: 'approve' | 'reject'): void {
    // `edits` уходят только с принятием и только непустыми: пустая правка — это ровно
    // сегодняшний путь (ни P2, ни лестницы, Развилка 12), и слать её значило бы плодить
    // предложения на каждое нажатие.
    const withEdits = decision === 'approve' && fieldEdits.length > 0;
    decide.mutate({
      runId: view.runId,
      pendingId: view.pendingId,
      decision,
      ...(withEdits && { edits: { fields: fieldEdits } }),
    });
  }

  return (
    <Card data-testid="proposal-plate" className="flex flex-col gap-3">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => onToggle(!open)}
        className="flex cursor-pointer flex-wrap items-baseline gap-x-1 text-left text-sm"
      >
        <span>Предложение рутины</span>
        {/* Имя рутины, а не её uuid: плашка отвечает на вопрос «кто это предлагает».
            Без `onOpen` — EntityRef рисует простой span: кнопка внутри кнопки была бы и
            невалидной разметкой, и вторым смыслом у одного нажатия. */}
        <span className="font-medium">
          «<EntityRef id={view.routineId} />»
        </span>
        <span className="text-text-muted">
          — {view.operations.length} {editsWord(view.operations.length)}
        </span>
      </button>

      {open && (
        /* Провайдер — потому что развёрнутый слой показывает ЧУЖОЙ ТЕКСТ этой записи, и
           query-блоки в нём должны понимать `this` как её же (Развилка 5: исполнять их —
           чтение, принято). Сегодня их рисует только режим правки тела (Задача 11), но
           контекст ставится здесь, у границы слоя, а не там, где однажды понадобится. */
        <ThisEntityProvider id={entityId}>
          <div className="flex flex-col gap-3">
            {view.explanation !== '' && <p className="text-sm">{view.explanation}</p>}
            <ul data-testid="proposal-rows" className="flex flex-col gap-2 text-sm">
              {view.operations.map((op) => (
                <ProposalRowView
                  key={rowKey(op)}
                  op={op}
                  edited={edits[rowKey(op)]?.value}
                  onEdit={(raw) =>
                    setEdits((prev) => ({
                      ...prev,
                      [rowKey(op)]: {
                        index: op.index,
                        ...(op.aspect !== undefined && { aspect: op.aspect }),
                        // `field` у правимой строки есть всегда (см. editableRow) — пустая
                        // строка тут недостижима и стоит лишь ради сужения типа.
                        field: op.field ?? '',
                        // Тип значения восстанавливаем по ПРЕДЛОЖЕННОМУ: инпут отдаёт строку,
                        // а схема поля ждёт число или флаг ровно там, где их предложила рутина.
                        value: coerce(op.after, raw) as FieldEdit['value'],
                      },
                    }))
                  }
                />
              ))}
            </ul>

            {decide.isError && (
              <p role="alert" className="text-danger text-sm">
                {decide.error.message}
              </p>
            )}

            {mismatches !== null && (
              <div
                // `stale` — ЗНАЧЕНИЕ ответа, а не сбой (Р-2): граф разошёлся с предложением, и
                // владельцу показывают, чем именно, а не плашку ошибки.
                role="status"
                data-testid="proposal-stale"
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

            {/* Кнопок нет у УСТАРЕВШЕГО: сервер погасил это предложение вместе с ответом
                (`rejectPending(reason:'stale')`), и второе нажатие получило бы `already` —
                кнопка, которая молча ничего не делает, хуже отсутствующей. */}
            {mismatches === null && (
              <div className="flex flex-wrap gap-2">
                <Button variant="primary" disabled={busy} onClick={() => send('approve')}>
                  Принять
                </Button>
                <Button variant="ghost" disabled={busy} onClick={() => send('reject')}>
                  Отклонить
                </Button>
              </div>
            )}
          </div>
        </ThisEntityProvider>
      )}
    </Card>
  );
}

/** Сетка «подпись → значение» — та же, что у свойств записи (см. AspectCards). */
const FIELD_GRID =
  'grid grid-cols-[minmax(7rem,max-content)_1fr] items-center gap-x-3 gap-y-0.5 text-sm';

/**
 * Одна строка предложения: чью запись трогаем, что именно и во что превращаем.
 *
 * Строк показываются ВСЕ, включая те, что правят соседнюю запись: принимается предложение
 * целиком, одной кнопкой, и показать половину значило бы дать согласие на непрочитанное.
 * Поэтому у каждой строки стоит её собственная запись.
 */
function ProposalRowView({
  op,
  edited,
  onEdit,
}: {
  op: ProposalRow;
  /** Значение из буфера правок, если владелец эту строку уже трогал. */
  edited?: unknown;
  onEdit: (raw: string) => void;
}) {
  // Различие тела едет отдельным полем и только у строки тела живого предложения (Ш1.1):
  // `units` — дифф, `skipped` — прежняя форма плюс причина словами, отсутствие поля вовсе —
  // просто прежняя форма (это «диффа нет», а не «дифф не построен»).
  const diff = op.bodyDiff;
  const units = diff !== undefined && 'units' in diff ? diff.units : undefined;
  const skipped = diff !== undefined && 'skipped' in diff ? diff.skipped : undefined;
  const editable = editableRow(op);

  return (
    <li className="flex flex-col gap-1 border-line/60 border-b pb-2 last:border-b-0 last:pb-0">
      <span className="flex flex-wrap items-baseline gap-x-2">
        {op.entity !== undefined && (
          <span className="font-medium">
            <EntityRef id={op.entity.id} onOpen={openEntity} />
          </span>
        )}
        <span className="text-text-secondary">{rowLabel(op)}</span>
        {/* «Было» — снятое ПРЕДУСЛОВИЕ, а не значение сейчас: именно с ним предложение
            сверится на «Принять» (V1.7). У полей вне аспектов предусловия нет вовсе. */}
        {op.before !== undefined && (
          <span className="text-text-muted line-through">{beforeText(op.before)}</span>
        )}
      </span>

      {units !== undefined ? (
        // Полный дифф, со всеми единицами: это запись, а не лента, и контекстные `same` здесь
        // не шум, а то, по чему владелец узнаёт место правки (Развилка 10).
        <BodyDiffUnits units={units} />
      ) : editable ? (
        <dl className={FIELD_GRID}>
          <AspectField
            aspectId={op.aspect ?? ''}
            field={op.field ?? ''}
            // Показываем ПРАВЛЕНОЕ, если владелец эту строку уже трогал: иначе свернул и
            // развернул бы плашку — и увидел значение рутины над буфером со своим.
            value={edited ?? op.after}
            onSave={onEdit}
          />
        </dl>
      ) : (
        op.after !== undefined && <span className="text-accent">{valueText(op.after)}</span>
      )}

      {/* Приёмка 16: дифф не построен — но предложение живо и принимается целиком, поэтому
          рядом с прежней формой стоит причина, а не пустота. */}
      {skipped !== undefined && (
        <span className="text-text-muted text-xs">{BODY_DIFF_SKIP_NOTES[skipped]}</span>
      )}
    </li>
  );
}
