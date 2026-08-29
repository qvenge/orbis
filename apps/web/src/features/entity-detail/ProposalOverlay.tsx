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
// 4. ТЕЛО ПРАВИТСЯ РЕДАКТОРОМ БЕЗ `useBodySave` и без черновиков (Ш1.4, С8). Тот же
//    `EditorShell`, что и у тела записи, но без единой связи с сохранением: автосохранение
//    записало бы предложенный текст в САМУ ЗАПИСЬ с первого штриха и бампнуло `updated_at` —
//    предложение сделало бы себя `stale` само от себя. Дифф в этом режиме считает клиент
//    (Ш1.2) и по ПАУЗЕ: текущее тело уже на экране (DETAIL_INCLUDE), второй сети не нужно.
//
// Чего здесь НЕТ намеренно: deep-link'а `?proposal=` (Развилка 5: шов назван, но не строится)
// и всякого импорта из `@orbis/shared/doc` БЕЗ `/diff` — слой эагерно достижим из чанка
// записи, и схема Tiptap стоила бы там +154 кБ gzip в первом кадре. Сам `@orbis/shared/doc/diff`
// ЛИСТОВОЙ и стоит +0.85 кБ gzip (замерено разведкой); правило `useBodySave.ts:28-34`
// наследуется целиком, а сторожат его `scripts/check-lazy-chunks.ts` (состав чанка) и список
// файлов в `save.test.tsx`.
import { type BodyDiffResult, diffBodyDocs } from '@orbis/shared/doc/diff';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { EntityRef } from '../../lib/entity-ref/EntityRef';
import { invalidateGraph } from '../../lib/invalidate';
import { ThisEntityProvider } from '../../lib/query-blocks/this-entity';
import type { RegistryLookup } from '../../lib/registry/labels';
import { useRegistry } from '../../lib/registry/useRegistry';
import { openEntity } from '../../state/navigation';
import { type RouterInputs, type RouterOutputs, trpc } from '../../trpc';
import { Button } from '../../ui/Button';
import { Card } from '../../ui/Card';
import { BODY_DIFF_SKIP_NOTES, BodyDiffUnits } from '../chat/cards/BodyDiff';
import {
  beforeText,
  divergenceRows,
  fmt,
  OWNER_EDIT_NOTE,
  type ProposalRow,
  REPLACED_NOTES,
  type ReplacedReason,
  rowLabel,
  type StaleRow,
} from '../chat/cards/proposal-text';
import { EditorShell } from '../entity-editor/EditorShell';
import { sameDoc } from '../entity-editor/strip-ids';
import type { BodyDoc } from '../entity-editor/useBodySave';
import { AspectField, coerce, isScalar, readOnlyText } from './AspectCards';

type DetailEntity = RouterOutputs['entity']['get']['entity'];
type ProposalView = RouterOutputs['routine']['proposalsForEntity'][number];
/** Правка одного значения — форма входа `decideProposal.edits.fields` (routines/edits.ts). */
type FieldEdit = NonNullable<
  NonNullable<RouterInputs['routine']['decideProposal']['edits']>['fields']
>[number];
/** Правка тела — форма входа `decideProposal.edits.body`: тело едет ДОКУМЕНТОМ (Ш1.11). */
type BodyEdit = NonNullable<
  NonNullable<RouterInputs['routine']['decideProposal']['edits']>['body']
>[number];

/**
 * Пауза клиентского пересчёта диффа в режиме правки (Ш1.2).
 *
 * Пересчёт НА ШТРИХ отменил бы замеренное решение экрана записи: показанный документ живёт
 * там в рефе именно потому, что перерисовка на каждое нажатие стоит +3 мс (DetailScreen,
 * замер на теле из сорока блоков), а сам `diffBodyDocs` на худшем реальном теле — 21 мс.
 * Правленый документ поэтому копится в рефе, а дифф считается, когда владелец остановился.
 */
const DIFF_PAUSE_MS = 400;

/**
 * Форма документа в кэше и в payload'е уже, чем `BodyDoc` (Record против JSONContent) — сводим
 * приведением, тем же, что у тела записи (`asBodyDoc` в DetailScreen).
 */
function asBodyDoc(stored: { v: number; doc: unknown }): BodyDoc {
  return { v: stored.v, doc: stored.doc as BodyDoc['doc'] };
}

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

/**
 * Тело записи «сейчас» — сторона «было» клиентского диффа (Ш1.2). Берётся из УЖЕ загруженного
 * ответа экрана (`DETAIL_INCLUDE` просит `bodyDoc` всегда), поэтому второй сети режим правки
 * не стоит вовсе.
 *
 * `null` — документа у записи нет. Случай не штатный (сервер собирает документ даже для
 * записей без колонки, `readBodyDoc`), но по wire-схеме возможен, и тогда правка тела не
 * открывается: сравнивать набранное было бы не с чем, а показанный серверный дифф под
 * редактором с чужим текстом врал бы.
 */
function currentBodyDoc(entity: DetailEntity): BodyDoc['doc'] | null {
  return entity.bodyDoc == null ? null : asBodyDoc(entity.bodyDoc).doc;
}

/**
 * Русское согласование числа: «1 правка», «2 правки», «5 правок».
 *
 * Зеркало серверного `editsNoun` (routines/constants.ts) — типы клиента и сервера здесь
 * намеренно не общие. Считается тем же, чем считает сервер, — СТРОКАМИ предложения
 * (`view.operations.length`, см. `countProposalRows`): один и тот же владелец читает эту
 * плашку и строку ленты в треде, и два числа у одного предложения он списал бы на ошибку
 * (смоук Ш1, 4.6.1). Строки, а не операции, потому что строки он и видит списком ниже.
 */
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
          currentDoc={currentBodyDoc(entity)}
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
  currentDoc,
  open,
  busy: listBusy,
  onToggle,
  onAnswer,
}: {
  view: ProposalView;
  entityId: string;
  /** Тело записи «сейчас» — сторона «было» клиентского диффа; `null` — документа нет. */
  currentDoc: BodyDoc['doc'] | null;
  open: boolean;
  /** Список перечитывается — решать нельзя ни по одной плашке (см. вызов). */
  busy: boolean;
  onToggle: (next: boolean) => void;
  /** Ответ `replaced` наверх: подпись обязана пережить подмену этой плашки живой. */
  onAnswer: (reason: ReplacedReason | null) => void;
}) {
  const utils = trpc.useUtils();
  const queryClient = useQueryClient();
  // Подписи строк и разбора расхождений — из реестра (§А9-2); ОДИН снимок на всю плашку,
  // дальше уходит пропом в строки.
  const registry = useRegistry();
  /**
   * Буфер правок значений — ПО КЛЮЧУ СТРОКИ, а не массивом: владелец правит одно поле
   * несколько раз (набрал, стёр, набрал заново), и массив копил бы дубли, которые сервер
   * отверг бы как `edit_duplicate`.
   */
  const [edits, setEdits] = useState<Record<string, FieldEdit>>({});
  /** Расхождения ПОСЛЕДНЕГО нажатия «Принять» — в сыром виде, как их вернул сервер. */
  const [staleRows, setStaleRows] = useState<StaleRow[] | null>(null);

  /**
   * Правленые ДОКУМЕНТЫ тела по номеру операции — В РЕФЕ, а не в состоянии, и это замер, а не
   * вкус: новый `doc` на каждый штрих означал бы перерисовку плашки, эффект приезда в
   * `BodyEditor` и сравнение по смыслу двух целых документов на КАЖДОЕ нажатие (замер экрана
   * записи: 7.6–8.1 мс против 4.75–4.88). Реф живёт в ПЛАШКЕ, а не в строке: свернул плашку —
   * строки размонтировались, а набранное обязано пережить это ровно так же, как переживает
   * буфер правок значений.
   */
  const bodyEditsRef = useRef(new Map<number, BodyDoc>());
  /**
   * Клиентский дифф по номеру операции — состояние (его показывают), считается по паузе.
   * Тоже в плашке: иначе сворачивание уносило бы картинку, и под редактором с набранным
   * текстом снова вставал бы СЕРВЕРНЫЙ дифф, описывающий не то, что в редакторе.
   */
  const [bodyDiffs, setBodyDiffs] = useState<Record<number, BodyDiffResult>>({});
  /** Какие строки тела открыты редактором. Переживает сворачивание по той же причине. */
  const [editingBody, setEditingBody] = useState<readonly number[]>([]);
  /** Отложенный пересчёт диффа — по таймеру на строку (см. DIFF_PAUSE_MS). */
  const diffTimers = useRef(new Map<number, number>());
  useEffect(
    () => () => {
      for (const id of diffTimers.current.values()) clearTimeout(id);
    },
    [],
  );

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
      setStaleRows(result.status === 'stale' ? divergenceRows(registry, result) : null);
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

  /**
   * Правленый документ пришёл из редактора строки: кладём в буфер и заводим паузу пересчёта.
   *
   * Порядок важен: документ в реф — СРАЗУ, дифф — потом. «Принять», нажатое до истечения
   * паузы, обязано послать последний набранный текст, а не тот, до которого успел досчитаться
   * показ, — поэтому решение не ждёт диффа и кнопки на время паузы не гасятся.
   */
  function onBodyChange(index: number, next: BodyDoc): void {
    bodyEditsRef.current.set(index, next);
    if (currentDoc === null) return;
    const timers = diffTimers.current;
    const pending = timers.get(index);
    if (pending !== undefined) clearTimeout(pending);
    timers.set(
      index,
      window.setTimeout(() => {
        setBodyDiffs((all) => ({ ...all, [index]: diffBodyDocs(currentDoc, next.doc) }));
      }, DIFF_PAUSE_MS),
    );
  }

  /**
   * Правки тела к отправке. Документ, не отличающийся от предложенного ПО СМЫСЛУ, правкой не
   * считается (Развилка 12): при монтировании редактор проставляет блочные id, и без снятия
   * их `sameDoc`'ом каждое открытие редактора рождало бы новое предложение на пустом месте.
   *
   * Отличающийся уезжает КАК ЕСТЬ, вместе с блочными id: их исполнитель пишет не теряя, и
   * «показано = применится» держится ровно на том, что в запись уедет этот самый документ, а
   * не его пересборка.
   */
  function bodyEdits(): BodyEdit[] {
    const out: BodyEdit[] = [];
    for (const [index, edited] of bodyEditsRef.current) {
      // Строк у одной операции бывает несколько (`index` у них общий), а документ — только у
      // строки тела; поэтому ищем по наличию `proposedDoc`, а не по номеру.
      const proposed = view.operations.find(
        (op) => op.index === index && op.proposedDoc !== undefined,
      )?.proposedDoc;
      if (proposed !== undefined && sameDoc(edited.doc, asBodyDoc(proposed).doc)) continue;
      out.push({ index, bodyDoc: edited as BodyEdit['bodyDoc'] });
    }
    return out;
  }

  function send(decision: 'approve' | 'reject'): void {
    // `edits` уходят только с принятием и только непустыми: пустая правка — это ровно
    // сегодняшний путь (ни P2, ни лестницы, Развилка 12), и слать её значило бы плодить
    // предложения на каждое нажатие. Пустые половины не досылаются по той же причине: у
    // правки есть УСТОЙЧИВАЯ ЛИЧНОСТЬ (hash), и лишний ключ менял бы её без смысла.
    const body = decision === 'approve' ? bodyEdits() : [];
    const withEdits = decision === 'approve' && (fieldEdits.length > 0 || body.length > 0);
    decide.mutate({
      runId: view.runId,
      pendingId: view.pendingId,
      decision,
      ...(withEdits && {
        edits: {
          ...(fieldEdits.length > 0 && { fields: fieldEdits }),
          ...(body.length > 0 && { body }),
        },
      }),
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

      {/* Инвариант 8: это предложение рождено ПРАВКОЙ ВЛАДЕЛЬЦА, и он обязан это видеть —
          иначе принимает свой же текст как план рутины. Признак — не статус (его у правки нет
          и не будет), а происхождение: `editedFrom`.

          Место — СНАРУЖИ разворота, у самой шапки, и это не украшение. Свёрнутая плашка —
          всё, что увидит владелец, решивший не разворачивать; спрячь подпись внутрь разбора,
          и обман жил бы ровно там, где его не видно. Достижимо это состояние `stale`-хвостом
          лестницы: правка принята, применение ответило `stale` — правленое предложение
          осталось живым и приезжает в список обычной строкой. */}
      {view.editedFrom !== undefined && (
        <p data-testid="proposal-edited" className="text-text-muted text-xs">
          {OWNER_EDIT_NOTE}
        </p>
      )}

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
                  registry={registry}
                  entityId={entityId}
                  hasCurrentDoc={currentDoc !== null}
                  bodyOpen={editingBody.includes(op.index)}
                  liveDiff={bodyDiffs[op.index]}
                  onOpenEditor={() => setEditingBody((ids) => [...ids, op.index])}
                  // Документ, с которого начинается правка: уже правленый, если владелец эту
                  // строку трогал и свернул плашку, — иначе он увидел бы под своим текстом
                  // текст рутины. Функцией, а не значением: строка снимает его РОВНО ОДИН раз,
                  // при первом рендере режима правки (см. startRef).
                  startDoc={() =>
                    bodyEditsRef.current.get(op.index) ??
                    (op.proposedDoc === undefined ? null : asBodyDoc(op.proposedDoc))
                  }
                  onBodyChange={(next) => onBodyChange(op.index, next)}
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

            {staleRows !== null && (
              <div
                // `stale` — ЗНАЧЕНИЕ ответа, а не сбой (Р-2): граф разошёлся с предложением, и
                // владельцу показывают, чем именно, а не плашку ошибки.
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

            {/* Кнопок нет у УСТАРЕВШЕГО: сервер погасил это предложение вместе с ответом
                (`rejectPending(reason:'stale')`), и второе нажатие получило бы `already` —
                кнопка, которая молча ничего не делает, хуже отсутствующей. */}
            {staleRows === null && (
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
 * Почему у строки тела нет кнопки «Править». Кнопка, которой нет, объясняется ЗДЕСЬ, а не
 * молчанием: владелец, правивший тело в соседнем предложении, иначе решил бы, что сломалось.
 *
 * Причин ровно две, и они разные по сути:
 *  - `NO_BODY_EDIT_HERE` — открывать нечем: сервер не довёл предложенное тело до документа
 *    (`proposedDoc` есть только при построенном диффе и при `skipped: 'rewritten'`; при
 *    `body_changed` разбор не начинался, при до-разборном `too_large` документ и есть то,
 *    чего потолок не даёт построить). Причину саму по себе рядом печатает пометка диффа;
 *  - `NO_BODY_EDIT_FOREIGN` — строка правит тело ДРУГОЙ записи. Документ есть, а «было» на
 *    этом экране нет: клиентский дифф считать не от чего. У той записи свой слой с тем же
 *    предложением — там текст и правится (её EntityRef стоит в этой же строке).
 */
const NO_BODY_EDIT_HERE = 'Текст здесь не правится';
const NO_BODY_EDIT_FOREIGN = 'Текст правится на самой записи';

/**
 * Одна строка предложения: чью запись трогаем, что именно и во что превращаем.
 *
 * Строк показываются ВСЕ, включая те, что правят соседнюю запись: принимается предложение
 * целиком, одной кнопкой, и показать половину значило бы дать согласие на непрочитанное.
 * Поэтому у каждой строки стоит её собственная запись.
 */
function ProposalRowView({
  op,
  registry,
  entityId,
  hasCurrentDoc,
  bodyOpen,
  liveDiff,
  startDoc,
  onOpenEditor,
  onBodyChange,
  edited,
  onEdit,
}: {
  op: ProposalRow;
  /**
   * Снимок реестра для подписи строки (§А9-2) — ПРОПОМ из плашки, а не своим `useRegistry()`:
   * строк в предложении столько, сколько полей оно правит, и подписка на снимок в каждой из
   * них перерисовывала бы весь список на каждое обновление кеша реестра.
   */
  registry: RegistryLookup;
  /** Запись, на которой стоит слой: у ЕЁ тела есть сторона «было» для клиентского диффа. */
  entityId: string;
  hasCurrentDoc: boolean;
  /**
   * Тело ЭТОЙ ОПЕРАЦИИ открыто редактором (Ш1.4) — свойство операции, не строки: правка тела
   * адресуется номером операции (`edits.body[].index`), тело у неё одно. Строк же у операции
   * бывает несколько с ОБЩИМ номером, и включать редактор вправе только строка тела (см.
   * `editing` ниже).
   */
  bodyOpen: boolean;
  /** Клиентский дифф последней паузы — он перекрывает серверный, пока идёт правка (Ш1.2). */
  liveDiff?: BodyDiffResult;
  /** Документ, с которого начинается правка; зовётся РОВНО ОДИН раз (см. startRef). */
  startDoc: () => BodyDoc | null;
  onOpenEditor: () => void;
  onBodyChange: (next: BodyDoc) => void;
  /** Значение из буфера правок, если владелец эту строку уже трогал. */
  edited?: unknown;
  onEdit: (raw: string) => void;
}) {
  // Тело правится тут же, если есть ЧТО открыть (документ предложенного тела) и С ЧЕМ
  // сравнивать (тело этой записи). Обе половины — не формальность: см. NO_BODY_EDIT_HERE.
  const bodyRow = op.field === 'body';
  const ownBody = op.entity === undefined || op.entity.id === entityId;
  const canEditBody = bodyRow && ownBody && hasCurrentDoc && op.proposedDoc !== undefined;

  /**
   * ГЕЙТ ПО СТРОКЕ ТЕЛА — не перестраховка, а починка. Режим правки и клиентский дифф плашка
   * держит по номеру ОПЕРАЦИИ, а строк у операции бывает несколько с общим номером: один
   * `entity_update`, правящий статус и тело, даёт две строки с `index: 0` (`updateRows`,
   * lifecycle.ts) — ровно поэтому ключ строки здесь составной, а не один номер.
   *
   * Без гейта нажатие «Править» у строки тела гасило бы `AspectField` у строки СТАТУСА
   * (`editing ? null` ниже — то есть приёмка 6 переставала бы работать), вешало под ней второй
   * `EditorShell` с `markdown = 'done'`, а после первого штриха — и с ДОКУМЕНТОМ ТЕЛА из
   * общего буфера; клиентский дифф рисовался бы под обеими строками.
   */
  const editing = bodyRow && bodyOpen;

  /**
   * Документ редактора — СНИМОК на вход в режим правки, и личность его больше не меняется.
   *
   * Меняйся она — эффект приезда `BodyEditor` гонял бы `sameDoc` двух целых документов на
   * каждую перерисовку плашки (а перерисовывает её и правка значения соседней строки, и
   * перечитка списка), а при снятом фокусе ещё и подменял бы содержимое редактора текстом
   * рутины поверх набранного владельцем. Реф с ленивой инициализацией даёт стабильность
   * по построению, без зависимостей и без useMemo, которому пришлось бы верить.
   */
  const startRef = useRef<BodyDoc | null>(null);
  if (editing && startRef.current === null) startRef.current = startDoc();

  // Различие тела едет отдельным полем и только у строки тела живого предложения (Ш1.1):
  // `units` — дифф, `skipped` — прежняя форма плюс причина словами, отсутствие поля вовсе —
  // просто прежняя форма (это «диффа нет», а не «дифф не построен»).
  // В режиме правки поверх серверного встаёт клиентский (Ш1.2): тело под руками, и серверный
  // описывал бы уже не то, что в редакторе. Тем же гейтом: `op.bodyDiff` у строки значения
  // не бывает, а `liveDiff` приехал бы и к ней.
  const diff = (bodyRow ? liveDiff : undefined) ?? op.bodyDiff;
  const units = diff !== undefined && 'units' in diff ? diff.units : undefined;
  const skipped = diff !== undefined && 'skipped' in diff ? diff.skipped : undefined;
  const editable = editableRow(op);
  // Пометка — только у ЖИВОГО предложения (`bodyDiff` есть только у него): под решённым она
  // обещала бы правку там, где решать уже нечего.
  const noEditNote =
    bodyRow && !canEditBody && op.bodyDiff !== undefined
      ? ownBody
        ? NO_BODY_EDIT_HERE
        : NO_BODY_EDIT_FOREIGN
      : undefined;

  return (
    <li className="flex flex-col gap-1 border-line/60 border-b pb-2 last:border-b-0 last:pb-0">
      <span className="flex flex-wrap items-baseline gap-x-2">
        {op.entity !== undefined && (
          <span className="font-medium">
            <EntityRef id={op.entity.id} onOpen={openEntity} />
          </span>
        )}
        <span className="text-text-secondary">{rowLabel(registry, op)}</span>
        {/* «Было» — снятое ПРЕДУСЛОВИЕ, а не значение сейчас: именно с ним предложение
            сверится на «Принять» (V1.7). У полей вне аспектов предусловия нет вовсе. */}
        {op.before !== undefined && (
          <span className="text-text-muted line-through">{beforeText(op.before)}</span>
        )}
        {/* Кнопка одноходовая: обратно в «только дифф» уходить незачем — клиентский дифф
            стоит тут же, под редактором, и показывает то же самое про набранный текст.
            Второй же смысл («закрыть» = «отменить правку»?) пришлось бы объяснять. */}
        {canEditBody && !editing && (
          <Button variant="ghost" size="sm" onClick={onOpenEditor}>
            Править
          </Button>
        )}
      </span>

      {/* Редактор БЕЗ `useBodySave` и без черновиков (С8) и без `onAccept`: слой не сохраняет
          ничего — граф двигает только «Принять». Правка начинается с ПРЕДЛОЖЕННОГО текста
          (Ш1.4), `markdown` — он же: первый кадр рисуется из него, пока едет ленивый чанк
          редактора. Провайдер записи стоит выше, у границы разворота, — query-блоки
          предложенного текста получают контекст этой записи. */}
      {editing && (
        <EditorShell
          doc={startRef.current}
          // `after` строки предложения объявлен `unknown` (у строк значений там что угодно);
          // у строки ТЕЛА это markdown, и проверка типа здесь — сужение, а не защита.
          markdown={typeof op.after === 'string' ? op.after : ''}
          onChange={onBodyChange}
        />
      )}

      {units !== undefined ? (
        // Полный дифф, со всеми единицами: это запись, а не лента, и контекстные `same` здесь
        // не шум, а то, по чему владелец узнаёт место правки (Развилка 10).
        <BodyDiffUnits units={units} />
      ) : editing ? null : editable ? (
        <dl className={FIELD_GRID}>
          <AspectField
            registry={registry}
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
      {noEditNote !== undefined && <span className="text-text-muted text-xs">{noEditNote}</span>}
    </li>
  );
}
