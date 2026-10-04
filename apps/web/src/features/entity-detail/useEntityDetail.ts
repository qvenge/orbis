import type { JournalRef } from '@orbis/shared';
import { resetSteps } from '../entity-editor/arrows-stack';
import { confirmBody, markBodyPending } from '../undo/body-provenance';
import { journalRefOf } from '../undo/journal-ref';
import { isUndoEpoch, undoEpoch } from '../undo/undo-epoch';
import { pushUndoable } from '../undo/undo-stack';

export { journalRefOf } from '../undo/journal-ref';

import { offerUndoLazy } from '../undo/undo-lazy';
import type { UndoToastRule } from '../undo/undo-toast';
export type UndoToastOption =
  | UndoToastRule
  | ((vars: UpdateInput, prior: Entity | undefined) => UndoToastRule | null);

import { type PerfActionKind, RULE_TASK_STATUS_DEFAULT } from '@orbis/shared';
import { type QueryClient, useQueryClient } from '@tanstack/react-query';
import type { JSONContent } from '@tiptap/core';
import { TRPCClientError } from '@trpc/client';
import { useRef, useState } from 'react';
import { invalidateGraph } from '../../lib/invalidate';
import { isBodyStale, isTitleStale } from '../../lib/orbis-error';
import { useNoteRegistryVersion } from '../../lib/registry/useRegistry';
import { startAction } from '../../perf/marks';
import { type RouterInputs, type RouterOutputs, trpc } from '../../trpc';
// Листовые модули: своих рантайм-зависимостей у них нет вовсе, и схему редактора они не тянут
// (стережёт save.test.tsx). Зачем они здесь — см. `settleBodyDraft` ниже.
import {
  clearDraft,
  DRAFT_REJECTING_CODE,
  markDraftRejected,
  readDraft,
} from '../entity-editor/draft-storage';
import { sameDoc } from '../entity-editor/strip-ids';
import { runPollInterval } from './run-poll';

type Entity = RouterOutputs['entity']['get']['entity'];
type UpdateInput = RouterInputs['entity']['update'];

// Принятие переживает размонтирование редактора, но не переезжает в кэш другого клиента.
const TITLE_GENERATIONS = new WeakMap<QueryClient, Record<string, number>>();

// §9.2: detail тянет body+relations+backlinks+thread (backlinks — секция «Связанное»
// §3.5.8, Task D5). Один и тот же input — ключ кэша для useQuery и точечных
// optimistic-патчей (cancel/getData/setData/invalidate).
//
// bodyDoc — источник документа для редактора (Р6: явный opt-in, без него ключа в ответе нет
// вовсе). Без него редактор пришлось бы собирать из markdown на клиенте, и блочные id (Р5) до
// него бы не доезжали вовсе. Цена — вес ответа detail примерно вдвое; она и есть причина, по
// которой документ не едет в списках.
const DETAIL_INCLUDE: NonNullable<RouterInputs['entity']['get']['include']> = [
  'body',
  'bodyDoc',
  'relations',
  'backlinks',
  'thread',
];

export function detailGetInput(id: string): RouterInputs['entity']['get'] {
  return { id, include: DETAIL_INCLUDE };
}

/**
 * Разбор `aspects` НОВОЙ формы (§А1-1): `{attach, detach}`.
 *
 * Разбор, а не приведение типом, потому что вход роутера — union: до Задачи 13c он принимает
 * и старую карту «аспект → поля», которой этот экран больше не шлёт (шлют ещё Финансы и
 * `MemoryRuleCard`, но через СВОИ мутации, не через эту обвязку). Пустые списки на месте
 * незаполненных полей делают патч тотальным: «ключа нет» и «список пуст» здесь одно и то же.
 */
function aspectPatchOf(input: UpdateInput['aspects']): { attach: string[]; detach: string[] } {
  const patch = input as { attach?: unknown; detach?: unknown } | undefined;
  const list = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  return { attach: list(patch?.attach), detach: list(patch?.detach) };
}

/**
 * Оптимистичное применение entity_update-патча поверх кэша — НОВОЙ формой (§А1-1):
 * `props` ставит значения, `unset` их снимает, `aspects.attach|detach` меняет интерпретацию.
 * `updatedAt` НЕ трогаем — истинное значение принесёт refetch.
 *
 * Снятое свойство именно УДАЛЯЕТСЯ из `props`, а не превращается в `null`. Разница
 * наблюдаема: `null` — законное значение json-свойства, и строка формы, увидев его, показала
 * бы «значение есть, оно пустое» вместо «значения нет» — а сервер тем временем удалил ключ.
 * Прежний патч оставлял `null` (`aspects[a][f] = null`), и карточка назначения знала об этом
 * особым правилом («проверка на строку, а не на „не пусто“»).
 *
 * Снятие аспекта значений НЕ трогает (Р9): аспект — интерпретация, а не владелец поля.
 * Прежний патч удалял с ним всю карту полей — то есть показывал владельцу потерю фактов,
 * которой на сервере не происходило.
 */
function applyPatch(entity: Entity, input: UpdateInput): Entity {
  const next: Entity = { ...entity };
  if (input.title !== undefined) next.title = input.title;
  if (input.emoji !== undefined) next.emoji = input.emoji;
  if (input.body !== undefined) next.body = input.body;
  if (input.bodyDoc !== undefined) {
    next.bodyDoc = input.bodyDoc;
    // `body` НЕ трогаем: markdown-проекцию делает сервер, и только он. Клиентский сериализатор
    // затащил бы всю схему документа (~156 кБ gzip) в чанк detail — то есть в первый кадр,
    // ровно мимо двухфазного монтирования; а две реализации проекции ещё и разошлись бы.
    // До ответа сервера просмотр показывает прежний текст — это заметно только при отказе сети.
  }
  if (input.archived !== undefined) next.archived = input.archived;
  // Теги — полной заменой списка, как их пишет контракт (`entityUpdateInput.tags`). Строчными их
  // делает сервер (`normalizeTags`); `{{tags}}` шлёт уже строчные, так что патч совпадает с
  // перечитанным и не мигает регистром.
  if (input.tags !== undefined) next.tags = input.tags;
  if (input.props !== undefined || input.unset !== undefined) {
    const props: Record<string, unknown> = { ...entity.props };
    for (const [propertyId, value] of Object.entries(input.props ?? {})) props[propertyId] = value;
    for (const propertyId of input.unset ?? []) delete props[propertyId];
    next.props = props;
  }
  if (input.aspects !== undefined) {
    const { attach, detach } = aspectPatchOf(input.aspects);
    const kept = entity.aspects.filter((id) => !detach.includes(id));
    next.aspects = [...kept, ...attach.filter((id) => !kept.includes(id))];
  }
  return next;
}

/**
 * Судьба черновика тела на диске после оседания сохранения.
 *
 * Живёт на УРОВНЕ МУТАЦИИ, а не в поштучных колбэках `useBodySave`, и это не вкусовщина.
 * Поштучные колбэки (второй аргумент `mutate`) библиотека зовёт только при ЖИВЫХ слушателях:
 * `@tanstack/query-core` — `if (this.#mutateOptions && this.hasListeners())`
 * (mutationObserver.js). А самое важное сохранение тела как раз уходит без них: досыл из уборки
 * эффекта при уходе с записи (useBodySave) отправляется наблюдателем, которого React уже
 * отцепил. Замерено: запрос уезжает, а черновик остаётся на диске навсегда — при успехе
 * следующее открытие предложит «вернуть» текст, который и так в базе, а при терминальном отказе
 * пометки не будет вовсе, и то же открытие молча дошлёт обречённый документ, выключив записи
 * сохранение до перезагрузки (ревью раунда 1, I-1).
 *
 * Колбэки уровня мутации исполняются ВСЕГДА — на них же держится оптимистичный патч и его
 * откат. Условие `vars.bodyDoc !== undefined` точное: черновик заводит только правка тела
 * документом, и правки заголовка, чекбокса и аспектов сюда не попадают.
 *
 * `vars.id`, а не `entityId` хука: колбэк исполняется по СВОЕЙ записи, чья бы очередь ни шла.
 *
 * СВЕРКА С ДОКУМЕНТОМ обязательна, и это не перестраховка. По одной записи живут две мутации
 * разом (useBodySave бросает зависший запрос по выдержке и досылает поверх), а на диске к
 * моменту оседания лежит ПОСЛЕДНЕЕ набранное — не то, что сервер принял. Сюжет: печатает A,
 * запрос №0 зависает и брошен, дописывает B (на диске B), запрос №1 отказывает, сеть чинится —
 * и брошенный №0 оседает успехом. Безусловная чистка стёрла бы B, которого на сервере нет:
 * закрыл вкладку — и B нет нигде. Зеркало у пометки: «отвергнут» досталось бы черновику,
 * которого сервер не видел, — человеку сказали бы неправду и лишили бы его текст автодосыла
 * (ревью раунда 3, находка 7). Внутри хука та же сверка есть (`rejectedDocRef`), здесь её не
 * было.
 *
 * Сравнение ПО СМЫСЛУ (`sameDoc`), а не по строке: на диск документ уезжает через JSON, и
 * блочные id тут ни при чём — совпасть должен текст.
 *
 * `draft.doc.v !== sent.v` здесь — ЧАСТЬ ТОЖДЕСТВА документов, а не проверка совместимости со
 * схемой (§А11-2, контракт офлайн-черновиков живёт в `useBodySave`). Вопрос тут ровно один: тот
 * ли документ лежит на диске, что уехал в эту мутацию. Развилке версий этот код не противоречит,
 * и это проверяемо, а не на слово: черновик чужой версии в мутацию не уходит вовсе (он идёт в
 * предложение выбором), а перештампованный ложится на диск ТЕМ ЖЕ `save()`, который его и
 * отправляет (страховка пишется раньше отправки), — то есть обе стороны сравнения здесь всегда
 * одной версии.
 */
function settleBodyDraft(vars: UpdateInput, err?: unknown): void {
  const sent = vars.bodyDoc;
  if (sent === undefined) return;
  const draft = readDraft(vars.id);
  if (draft === null) return;
  if (draft.doc.v !== sent.v || !sameDoc(draft.doc.doc, sent.doc as JSONContent)) return;
  if (err === undefined) {
    clearDraft(vars.id);
    return;
  }
  if (err instanceof TRPCClientError && err.data?.code === DRAFT_REJECTING_CODE)
    markDraftRejected(vars.id);
}

/**
 * Общая optimistic-concurrency обвязка entity.update: optimistic-патч + откат при любой ошибке;
 * отказ замка текста (`STALE_VERSION` в `data.orbis`, спека скорости §8.1) → флаг conflict для
 * сообщения «обновите».
 *
 * `onSettled` — довесок вызывающего к УРОВНЮ МУТАЦИИ, а не поштучный колбэк `mutate`.
 * Разница ровно та, что уже описана у `settleBodyDraft` выше: поштучные колбэки (второй
 * аргумент `mutate`) библиотека зовёт только при ЖИВЫХ слушателях
 * (`@tanstack/query-core`, `mutationObserver.js`: `if (this.#mutateOptions && this.hasListeners())`),
 * а экран записи размонтируется на первом же переходе — роутер рисует только активную
 * вкладку. Правка, за которой человек сразу ушёл на соседнюю вкладку, теряла бы свой
 * побочный эффект молча; на уровне мутации он исполняется ВСЕГДА.
 *
 * Аргумент — `vars` отправки, а не замыкание вызывающего: колбэк переживает размонтирование
 * и обязан решать по тому, ЧТО УЕХАЛО, а не по тому, что было на экране в момент рендера.
 */
/**
 * Оптимистичный патч, отличный от того, что уходит на сервер, — по ОБЪЕКТУ правки (финал 1б, C2 M-1).
 * Снятие галочки шлёт `unset` статуса (значение возврата решает строка каталога), но тот же `unset`
 * патчем удалил бы статус из кеша: проекция строки без статуса отдаёт `checkbox: null`, и чекбокс
 * размонтировался бы под пальцем на два RTT (ответ + перечитывание). На время полёта экран ставит
 * значение возврата поставки; перечитывание в `onSettled` заменяет его тем, что записал сервер.
 * Карта слабая и по объекту — на провод поле не попадает, и отдельного канала в мутацию не нужно.
 */
const OPTIMISTIC = new WeakMap<UpdateInput, UpdateInput>();

/**
 * Вид действия для замера отклика (спека скорости §3.1) — по ОБЪЕКТУ правки, тем же приёмом, что `OPTIMISTIC`: чекбокс
 * и выбор статуса шлют одинаковую правку статуса, различает их только место вызова, а на провод поле не попадает.
 */
const PERF_KIND = new WeakMap<UpdateInput, PerfActionKind>();

/** Значение возврата из закрытия на время полёта — строка `default` каталога поставки (Б-2 №98). */
const REOPEN_STATUS = (RULE_TASK_STATUS_DEFAULT.params as { value: { const: string } }).value.const;

export function useEntityUpdate(
  entityId: string,
  opts: { onSettled?: (vars: UpdateInput) => void; undoToast?: UndoToastOption } = {},
) {
  const utils = trpc.useUtils();
  const queryClient = useQueryClient();
  const titleGenerations: Record<string, number> = TITLE_GENERATIONS.get(queryClient) ?? {};
  TITLE_GENERATIONS.set(queryClient, titleGenerations);
  const input = detailGetInput(entityId);
  const [conflict, setConflict] = useState(false);
  const [titleStale, setTitleStale] = useState(false);

  // Флаг — про ЭТУ запись, поэтому смена сущности под тем же хуком его гасит: иначе «Изменено
  // в другом месте» переезжало бы с записи, где конфликт был, на соседнюю, где его не было.
  const prevIdRef = useRef(entityId);
  if (prevIdRef.current !== entityId) {
    prevIdRef.current = entityId;
    setConflict(false);
    setTitleStale(false);
  }

  /**
   * Последняя мутация ПО КАЖДОЙ записи: её номер, ревизия тела и признак «сверял ли её сервер
   * по ревизии» (см. `checksVersion` — это НЕ то же, что «послана ли ревизия»).
   *
   * Живых мутаций по одной записи бывает две, и источников этому ДВА. Первый: автосохранение
   * тела бросает зависший запрос по выдержке и досылает поверх него (useBodySave,
   * SAVE_GIVE_UP_MS). Второй — сама эта обвязка: через один её экземпляр идут правки одного
   * места экрана (у `TitleBlock` — заголовок и чекбокс, одно за другим), и человек волен нажать
   * одно следом за другим. Экземпляров у записи несколько — тело (useBodySave), заголовок
   * (`TitleBlock`), архивация (экран), свойства (секции аспектов), — и очередь ниже ведётся
   * ВНУТРИ экземпляра: мутации разных экземпляров друг друга устаревшими не объявляют. Колбэки
   * здесь — уровня МУТАЦИИ и исполняются всегда, даже когда наблюдателя уже отцепили.
   *
   * Счётчик ведётся ПО ЗАПИСИ, а не один на хук: иначе мутация соседней сущности объявляла бы
   * устаревшей мутацию первой, и та лишилась бы отката — ровно того, ради чего он и написан.
   */
  const seqRef = useRef(0);
  const latestTitle = useRef<Record<string, number>>({});
  const latestRef = useRef<
    Record<string, { seq: number; expectedBodyRevision?: number; checksVersion: boolean }>
  >({});

  /**
   * Сверяет ли СЕРВЕР ревизию тела у этой правки. Не «послана ли `expectedBodyRevision`»: замок
   * текста (§8.1) стоит под условием `body !== undefined || bodyDoc !== undefined` (executor.ts),
   * и правка без тела проходит по LWW — ревизию сервер у неё просто игнорирует (ревью Задачи 14,
   * Н-3).
   */
  const checksVersion = (vars: UpdateInput) =>
    vars.body !== undefined || vars.bodyDoc !== undefined;

  // Явно принятое имя важнее старого title-only save. Тело остаётся на своей ревизии.
  const titleAccepted = (vars: UpdateInput, ctx?: { titleGeneration: number }) =>
    ctx !== undefined &&
    vars.title !== undefined &&
    !checksVersion(vars) &&
    ctx.titleGeneration !== (titleGenerations[vars.id] ?? 0);

  /**
   * Приехал ли ответ мутации, которую УЖЕ сменила следующая по той же записи.
   *
   * Спрашивают об этом ДВА колбэка, и ни одному признак не отвечает на весь вопрос целиком.
   * Откату (onError) его ДОСТАТОЧНО: снимок брошенной мутации сделан ДО патча преемника, и
   * вернуть его — значит выбросить чужую свежую правку. Кэш при этом лечит инвалидация в
   * onSettled; опора именно на неё, и в офлайне, где перечитывание не доедет, оптимистичный
   * патч отказавшей мутации на экране задержится. А решениям про плашку конфликта признака
   * мало: показу нужен ещё и `bringsSameConflict`, гашению (onSuccess) — `checksVersion` самой
   * осевшей правки. Разбор у каждого места свой, общего правила на все три случая нет.
   */
  const superseded = (id: string, ctx?: { seq: number }) =>
    ctx !== undefined &&
    latestRef.current[id] !== undefined &&
    latestRef.current[id]?.seq !== ctx.seq;

  /**
   * Принесёт ли преемник ТОТ ЖЕ конфликт — единственное основание промолчать о 409.
   *
   * Условий два, и оба необходимы. Преемник должен сам проверяться сервером по ревизии (иначе
   * он 409 не получит ни при каких обстоятельствах) И уйти с той же ревизией (иначе конфликт у
   * него будет свой). Одной совпавшей ревизии НЕ ДОСТАТОЧНО: правка без тела ревизии не несёт
   * вовсе, и у неё «та же ревизия» — это два `undefined`. Промолчи мы по одному совпадению — 409
   * правки тела не показал бы никто (ревью Задачи 14, Н-3).
   */
  const bringsSameConflict = (id: string, ctx?: { expectedBodyRevision?: number }) => {
    const latest = latestRef.current[id];
    return (
      latest?.checksVersion === true && latest.expectedBodyRevision === ctx?.expectedBodyRevision
    );
  };

  const mutation = trpc.entity.update.useMutation({
    meta: { undoStack: 'self' },
    onMutate: async (vars) => {
      const epoch = undoEpoch();
      const titleGeneration = titleGenerations[vars.id] ?? 0;
      const titleSeq =
        vars.title !== undefined && !checksVersion(vars)
          ? (latestTitle.current[vars.id] ?? 0) + 1
          : undefined;
      if (titleSeq !== undefined) latestTitle.current[vars.id] = titleSeq;
      // Отклик действия (спека скорости §3.1) — от нажатия, поэтому ДО первого `await`. Автосохранение текста — не
      // действие: сеанс печати меряется иначе, и замер каждого сохранения засорил бы отклик кнопок.
      const action =
        vars.body !== undefined || vars.bodyDoc !== undefined
          ? null
          : startAction(
              PERF_KIND.get(vars) ??
                (vars.title !== undefined
                  ? 'title'
                  : vars.props !== undefined && 'orbis/task_status' in vars.props
                    ? 'status'
                    : 'other'),
            );
      setConflict(false);
      await utils.entity.get.cancel(input);
      if (!isUndoEpoch(epoch)) return;
      const prev = utils.entity.get.getData(input);
      const shown = OPTIMISTIC.get(vars) ?? vars;
      if (!titleAccepted(vars, { titleGeneration }))
        utils.entity.get.setData(input, (old) =>
          old ? { ...old, entity: applyPatch(old.entity, shown) } : old,
        );
      const pendingBody =
        vars.autosave === true ? utils.entity.get.getData(input)?.entity.bodyDoc : undefined;
      markBodyPending(pendingBody);
      // «Видно» — кадр после оптимистичного патча: к нему React успевает нарисовать правку.
      if (action) requestAnimationFrame(() => action.visible());
      seqRef.current += 1;
      latestRef.current[vars.id] = {
        seq: seqRef.current,
        expectedBodyRevision: vars.expectedBodyRevision,
        checksVersion: checksVersion(vars),
      };
      // Ключ едет в контекст ВМЕСТЕ со снимком. Откат обязан лечь туда же, откуда снимок
      // взят, а `input` — замыкание ПОСЛЕДНЕГО рендера: смени экран сущность, пока запрос в
      // полёте, и откат положил бы данные прежней записи под ключ новой (ревью Задачи 13, I1).
      return {
        prev,
        pendingBody,
        input,
        seq: seqRef.current,
        expectedBodyRevision: vars.expectedBodyRevision,
        titleGeneration,
        titleSeq,
        epoch,
        action,
      };
    },
    onError: (err, vars, ctx) => {
      // Диск — первым делом и БЕЗ единой отсечки: он про запись, а не про то, чья очередь
      // сейчас на экране (см. settleBodyDraft).
      settleBodyDraft(vars, err);
      const old = superseded(vars.id, ctx);
      const accepted = titleAccepted(vars, ctx);
      // Снимок до преемника или принятого title уже устарел; остальные откаты — по своему ключу.
      if (ctx && !old && !accepted) utils.entity.get.setData(ctx.input, ctx.prev);
      // Отказ «по объекту» — прежде всего `MODULE_DISABLED` (срез 1б §8.3): расширение выключили в
      // другом месте, и маска в кеше экрана устарела — перечитать её, чтобы поля встали только
      // чтением и появилась плашка. На проводе это `FORBIDDEN` (`cause` по HTTP не сериализуется), и
      // прочие отказы с тем же кодом (`COMPUTED_WRITE`, `ROLE_SYSTEM_ONLY`) обходятся одним лишним
      // чтением настроек — дешевле, чем разбирать текст отказа.
      if (err instanceof TRPCClientError && err.data?.code === 'FORBIDDEN')
        void utils.user.getSettings.invalidate();
      // А флаг — только если ответ пришёл по ТЕКУЩЕЙ записи. Эти колбэки — уровня МУТАЦИИ:
      // они исполняются всегда, даже когда наблюдателя уже отцепили, и о поколении записи в
      // useBodySave ничего не знают. Без сверки 409 по прежней записи, доехавший после смены,
      // зажигал бы «Изменено в другом месте» на соседней, которой никто не касался
      // (ревью Задачи 13, И-4). `entityId` здесь — из ПОСЛЕДНЕГО рендера (react-query
      // проталкивает свежие опции в незавершённую мутацию), `vars.id` — из отправки.
      if (!accepted && isTitleStale(err)) resetSteps(vars.id);
      if (vars.id !== entityId) return;
      if (!old && ctx && isUndoEpoch(ctx.epoch) && isBodyStale(err)) resetSteps(vars.id);
      if (!accepted && isTitleStale(err)) setTitleStale(true);
      // Молчим только о конфликте, который преемник принесёт и сам (см. bringsSameConflict).
      if (old && bringsSameConflict(vars.id, ctx)) return;
      // Конфликт — отказ замка текста по структурному коду (`data.orbis`, РП-5), а не любой 409.
      if (isBodyStale(err)) setConflict(true);
    },
    onSuccess: (data, vars, ctx) => {
      confirmBody(ctx?.pendingBody);
      // Тоже первым делом: сохранённый черновик обязан уйти с диска, даже если экран этой
      // записи давно закрыт (см. settleBodyDraft).
      settleBodyDraft(vars);
      const ref = journalRefOf(data);
      if (
        ref !== null &&
        !offerByRule(opts.undoToast, ref, vars, ctx?.prev?.entity) &&
        stackable(vars)
      )
        pushUndoable({
          actionId: ref.actionId,
          title: `правка «${ctx?.prev?.entity.title ?? vars.id}»`,
          entityIds: vars.body !== undefined || vars.bodyDoc !== undefined ? [vars.id] : [],
        });
      // Поздний успех устаревшей мутации не говорит ничего о расхождении, которое держит
      // плашку сейчас. Сверки меток здесь нет, и это не забытая симметрия с onError, а разные
      // вопросы: там решается, ПОКАЗЫВАТЬ ли конфликт (промолчать можно лишь о том, который
      // принесёт и преемник), здесь — ГАСИТЬ ли уже показанный. Проверено мутацией M55.
      // Подтверждение title имеет свою очередь: успех чекбокса не отменяет принятие имени.
      if (
        ctx &&
        isUndoEpoch(ctx.epoch) &&
        ctx.titleSeq !== undefined &&
        ctx.titleSeq === latestTitle.current[vars.id] &&
        !titleAccepted(vars, ctx)
      )
        titleGenerations[vars.id] = (titleGenerations[vars.id] ?? 0) + 1;
      if (superseded(vars.id, ctx)) return;
      // И тот же корень, что у Н-3: гасит плашку только правка, версию которой сервер сверял.
      // Успех чекбокса или архивации о конфликте тела не знает ничего — а обвязка общая, и
      // без этого условия чекбокс, нажатый следом за отказавшей правкой тела, снимал бы с
      // экрана единственное сообщение о расхождении.
      if (!checksVersion(vars)) return;
      if (vars.id === entityId) setConflict(false);
    },
    // Экран записи — главный путь закрытия, переноса и архивации записи, которую показывают
    // списки («Записи») и блоки страниц (Повестка, Daily Planning), а они читают ДРУГИЕ ключи
    // кэша — `entity.query` и данные блоков `entity.blocks`. Их staleTime (30 с глобально в
    // trpc.ts) при refetchOnWindowFocus:false сам не истечёт вовремя: без явной инвалидации
    // закрытая задача висела бы в «Просрочено» Повестки до полуминуты после «Готово».
    // Тот же путь уже у QuickCapture — здесь его недоставало.
    // Р17: инвалидация detail — БЕЗ аргумента. Правка аспекта двигает прогресс чужой
    // открытой цели, а переименование — строку этой сущности у соседей: в их подзадачах
    // и backlinks и в строках query_result чата (EntityRef читает ключ {id} без include,
    // backlinks приезжают внутри ответа соседа — точечный ключ detail не задевал ни то,
    // ни другое).
    onSettled: (_data, err, vars, ctx) => {
      // «Подтверждено» — ответ сервера без ошибки; отказ подтверждением не считается.
      if (!err) ctx?.action?.confirmed();
      invalidateGraph(utils);
      // Довесок вызывающего — здесь же, на уровне мутации (см. докблок хука): у секций записи это
      // гашение денежных агрегатов бюджета, которые `invalidateGraph` не покрывает по построению.
      opts.onSettled?.(vars);
    },
  });

  return {
    mutation,
    conflict,
    dismissConflict: () => setConflict(false),
    titleStale,
    dismissTitleStale: () => {
      // TitleBlock вызывает это лишь после успешного актуального «Обновить».
      titleGenerations[entityId] = (titleGenerations[entityId] ?? 0) + 1;
      setTitleStale(false);
    },
  };
}

export function useEntityDetail(entityId: string) {
  const get = trpc.entity.get.useQuery(detailGetInput(entityId), {
    // Идущий прогон опрашивается сам (run-poll.ts): экран прогона после «Прогнать сейчас»
    // иначе застывал бы на «идёт · 0 шагов» до перезагрузки. Для остальных записей — false.
    refetchInterval: (query) => runPollInterval(query.state.data?.entity.props),
  });
  /**
   * Версия реестра из ответа (§А10-1): по ней инвалидируется клиентский снимок подписей и
   * каталога полей (`useRegistry`). Экран записи — главный её носитель: `entity.get`
   * уходит отсюда после КАЖДОЙ правки графа (`invalidateGraph`), то есть ровно тогда, когда
   * снимок мог устареть, и подписи карточек аспектов обновляются без перезагрузки.
   */
  useNoteRegistryVersion(get.data?.registryVersion);
  const entity = get.data?.entity;
  return { get, entity, ...useRecordEdits(entityId, entity) };
}

/**
 * Правки шапки записи — чекбокс, заголовок, архив — на одной обвязке `useEntityUpdate`.
 *
 * Отдельно от запроса записи, потому что примитив `{{title}}` (§7.3) правит запись сам: данные
 * он берёт из хоста записи, а не пропами от экрана, и второй `entity.get` ради правки ему не
 * нужен. Оптимистичный патч ложится под тот же ключ `detailGetInput(id)` — экран и хост видят его
 * одинаково.
 */
export function useRecordEdits(entityId: string, entity: Entity | undefined) {
  const utils = trpc.useUtils();
  const { mutation, conflict, dismissConflict, titleStale, dismissTitleStale } = useEntityUpdate(
    entityId,
    { undoToast: recordEditRule },
  );

  /**
   * Чекбокс task (§3.6): шлёт ТОЛЬКО смену статуса (optimistic + откат при ошибке).
   *
   * Всё остальное — правила каталога на сервере, а не копии на экране (Б-2 №70, №71, №98):
   * штамп `orbis/completed_at` при входе в `done` и его снятие при уходе — правило
   * `task_completed_at` (момент записи, а не часы клиента); снятие вопроса `orbis/waiting_for`
   * при уходе из ожидания — правило `waiting_for`; значение возврата из закрытия — строка
   * `default` каталога `task_status_default`. Поэтому снятие галочки — `unset` статуса, а не
   * литерал `inbox`: какой вариант получит открытая задача, решают данные реестра, и владелец,
   * сменивший умолчание, не упрётся в экран. Копия правила здесь расходилась бы с сервером.
   */
  function toggleTask(done: boolean) {
    if (done) {
      const vars: UpdateInput = { id: entityId, props: { 'orbis/task_status': 'done' } };
      PERF_KIND.set(vars, 'checkbox');
      mutation.mutate(vars);
      return;
    }
    const vars: UpdateInput = { id: entityId, unset: ['orbis/task_status'] };
    // Чекбокс не пропадает на время полёта (C2 M-1): в кеше — значение возврата, на проводе — `unset`.
    OPTIMISTIC.set(vars, { id: entityId, props: { 'orbis/task_status': REOPEN_STATUS } });
    PERF_KIND.set(vars, 'checkbox');
    mutation.mutate(vars);
  }

  // Правки ТЕЛА здесь нет и быть не должно: тело уехало на автосохранение по паузе
  // (`useBodySave`) ещё в Задаче 13, и оно шлёт `bodyDoc`, а не markdown-строку. Прежний
  // `saveBody(body: string)` пережил тот переезд мёртвым: его не звал ни один экран, зато на
  // нём держались два теста — то есть зелёными они были на пути, которого в проде нет
  // (ревью раунда 3). Сюжеты переписаны на достижимый путь, метод удалён.

  // Замок — видимое значение на начало ввода; результат нужен TitleEditor и будущим стрелкам (§7.5).
  function saveTitle(title: string, expectedTitle: string) {
    if (!entity) return;
    return mutation.mutateAsync({ id: entityId, title, expectedTitle });
  }

  function refreshTitle() {
    return utils.entity.get.fetch(detailGetInput(entityId));
  }

  function setArchived(archived: boolean) {
    mutation.mutate({ id: entityId, archived });
  }

  return {
    update: mutation,
    toggleTask,
    saveTitle,
    titleStale,
    refreshTitle,
    dismissTitleStale,
    setArchived,
    conflict,
    dismissConflict,
  };
}

/**
 * Плашка по правилу (§7.5 п. 1). Последствия называет сервер (`consequences`, §8.2) — клиент их не угадывает. Правки с
 * правилом тела не пишут (заголовок, свойства, архив), поэтому досыла перед их отменой нет (`entityIds: []`).
 */
function offerByRule(
  option: UndoToastOption | undefined,
  ref: JournalRef,
  vars: UpdateInput,
  prior: Entity | undefined,
): boolean {
  if (option === undefined) return false;
  const rule = typeof option === 'function' ? option(vars, prior) : option;
  if (rule === null || (rule.kind === 'if-consequences' && !ref.consequences)) return false;
  offerUndoLazy({
    title: rule.kind === 'free-value' ? `${rule.title} ${rule.prior} → ${rule.next}` : rule.title,
    actionId: ref.actionId,
    entityIds: [],
  });
  return true;
}
/** Правило шапки записи: галочка — по последствиям, архив — всегда, заголовок — без плашки (у него стрелки, п. 4). */
export function recordEditRule(vars: UpdateInput, prior: Entity | undefined): UndoToastRule | null {
  const title = prior?.title ?? '';
  if (vars.archived !== undefined)
    return {
      kind: 'always',
      title: vars.archived ? `В архиве: «${title}»` : `Из архива: «${title}»`,
    };
  if (vars.props?.['orbis/task_status'] === 'done')
    return { kind: 'if-consequences', title: `Задача закрыта: «${title}»` };
  if (vars.unset?.includes('orbis/task_status'))
    return { kind: 'if-consequences', title: `Задача открыта: «${title}»` };
  return null;
}

/** У текста и заголовка собственные стрелки: одна правка не получает две отмены. */
function stackable(vars: UpdateInput): boolean {
  return vars.autosave !== true && vars.title === undefined;
}
