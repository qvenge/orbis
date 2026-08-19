import type { JSONContent } from '@tiptap/core';
import { TRPCClientError } from '@trpc/client';
import { useRef, useState } from 'react';
import { invalidateGraph } from '../../lib/invalidate';
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

// Оптимистичное применение entity_update-патча поверх кэша (§9.2 shallow-merge аспектов;
// null-ключ = снятие аспекта). updatedAt НЕ трогаем — истинное значение принесёт refetch.
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
  if (input.aspects) {
    const aspects: Record<string, Record<string, unknown>> = { ...entity.aspects };
    for (const [key, value] of Object.entries(input.aspects)) {
      if (value === null) delete aspects[key];
      else aspects[key] = { ...(aspects[key] ?? {}), ...value };
    }
    next.aspects = aspects;
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

// Общая optimistic-concurrency обвязка entity.update (§5.2): optimistic-патч + откат при
// любой ошибке; CONFLICT (409, из STALE_VERSION) → флаг conflict для сообщения «обновите».
export function useEntityUpdate(entityId: string) {
  const utils = trpc.useUtils();
  const input = detailGetInput(entityId);
  const [conflict, setConflict] = useState(false);

  // Флаг — про ЭТУ запись, поэтому смена сущности под тем же хуком его гасит: иначе «Изменено
  // в другом месте» переезжало бы с записи, где конфликт был, на соседнюю, где его не было.
  const prevIdRef = useRef(entityId);
  if (prevIdRef.current !== entityId) {
    prevIdRef.current = entityId;
    setConflict(false);
  }

  /**
   * Последняя мутация ПО КАЖДОЙ записи: её номер, метка версии и признак «сверял ли её сервер
   * по версии» (см. `checksVersion` — это НЕ то же, что «послана ли метка»).
   *
   * Живых мутаций по одной записи бывает две, и источников этому ДВА. Первый: автосохранение
   * тела бросает зависший запрос по выдержке и досылает поверх него (useBodySave,
   * SAVE_GIVE_UP_MS). Второй — сама эта обвязка: через один наблюдатель идут правка тела,
   * заголовок, чекбокс и архивация, и человек волен нажать одно следом за другим. Колбэки
   * здесь — уровня МУТАЦИИ и исполняются всегда, даже когда наблюдателя уже отцепили.
   *
   * Счётчик ведётся ПО ЗАПИСИ, а не один на хук: иначе мутация соседней сущности объявляла бы
   * устаревшей мутацию первой, и та лишилась бы отката — ровно того, ради чего он и написан.
   */
  const seqRef = useRef(0);
  const latestRef = useRef<
    Record<string, { seq: number; expectedUpdatedAt?: string; checksVersion: boolean }>
  >({});

  /**
   * Сверяет ли СЕРВЕР версию у этой правки. Не «послан ли `expectedUpdatedAt`»: гейт §5.2 стоит
   * под условием `body !== undefined || bodyDoc !== undefined` (executor.ts), и правка без тела
   * проходит по LWW — метку сервер у неё просто игнорирует. Значит `saveTitle` шлёт
   * `expectedUpdatedAt`, но 409 не получит НИКОГДА, а `toggleTask`/`setArchived` не шлют его
   * вовсе (ревью Задачи 14, Н-3).
   */
  const checksVersion = (vars: UpdateInput) =>
    vars.body !== undefined || vars.bodyDoc !== undefined;

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
   * Условий два, и оба необходимы. Преемник должен сам проверяться сервером по версии (иначе
   * он 409 не получит ни при каких обстоятельствах) И уйти с той же меткой (иначе конфликт у
   * него будет свой). Одной совпавшей метки НЕ ДОСТАТОЧНО, и это не теория: правка тела и
   * следом переименование уходят с одной и той же меткой — кэшный `updatedAt` за время полёта
   * не двигается, `applyPatch` его не трогает, а перечитывание идёт только в `onSettled`.
   * Промолчи мы по одной метке — 409 правки тела не показал бы никто (ревью Задачи 14, Н-3).
   */
  const bringsSameConflict = (id: string, ctx?: { expectedUpdatedAt?: string }) => {
    const latest = latestRef.current[id];
    return latest?.checksVersion === true && latest.expectedUpdatedAt === ctx?.expectedUpdatedAt;
  };

  const mutation = trpc.entity.update.useMutation({
    onMutate: async (vars) => {
      setConflict(false);
      await utils.entity.get.cancel(input);
      const prev = utils.entity.get.getData(input);
      utils.entity.get.setData(input, (old) =>
        old ? { ...old, entity: applyPatch(old.entity, vars) } : old,
      );
      seqRef.current += 1;
      latestRef.current[vars.id] = {
        seq: seqRef.current,
        expectedUpdatedAt: vars.expectedUpdatedAt,
        checksVersion: checksVersion(vars),
      };
      // Ключ едет в контекст ВМЕСТЕ со снимком. Откат обязан лечь туда же, откуда снимок
      // взят, а `input` — замыкание ПОСЛЕДНЕГО рендера: смени экран сущность, пока запрос в
      // полёте, и откат положил бы данные прежней записи под ключ новой (ревью Задачи 13, I1).
      return { prev, input, seq: seqRef.current, expectedUpdatedAt: vars.expectedUpdatedAt };
    },
    onError: (err, vars, ctx) => {
      // Диск — первым делом и БЕЗ единой отсечки: он про запись, а не про то, чья очередь
      // сейчас на экране (см. settleBodyDraft).
      settleBodyDraft(vars, err);
      const old = superseded(vars.id, ctx);
      // Брошенная мутация не откатывает ничего: поверх её снимка уже лёг патч преемника.
      // Откат — иначе ВСЕГДА и по ключу из контекста: он про свою запись, чья бы очередь ни шла.
      if (ctx && !old) utils.entity.get.setData(ctx.input, ctx.prev);
      // А флаг — только если ответ пришёл по ТЕКУЩЕЙ записи. Эти колбэки — уровня МУТАЦИИ:
      // они исполняются всегда, даже когда наблюдателя уже отцепили, и о поколении записи в
      // useBodySave ничего не знают. Без сверки 409 по прежней записи, доехавший после смены,
      // зажигал бы «Изменено в другом месте» на соседней, которой никто не касался
      // (ревью Задачи 13, И-4). `entityId` здесь — из ПОСЛЕДНЕГО рендера (react-query
      // проталкивает свежие опции в незавершённую мутацию), `vars.id` — из отправки.
      if (vars.id !== entityId) return;
      // Молчим только о конфликте, который преемник принесёт и сам (см. bringsSameConflict).
      if (old && bringsSameConflict(vars.id, ctx)) return;
      if (err instanceof TRPCClientError && err.data?.code === 'CONFLICT') setConflict(true);
    },
    onSuccess: (_data, vars, ctx) => {
      // Тоже первым делом: сохранённый черновик обязан уйти с диска, даже если экран этой
      // записи давно закрыт (см. settleBodyDraft).
      settleBodyDraft(vars);
      // Поздний успех устаревшей мутации не говорит ничего о расхождении, которое держит
      // плашку сейчас. Сверки меток здесь нет, и это не забытая симметрия с onError, а разные
      // вопросы: там решается, ПОКАЗЫВАТЬ ли конфликт (промолчать можно лишь о том, который
      // принесёт и преемник), здесь — ГАСИТЬ ли уже показанный. Проверено мутацией M55.
      if (superseded(vars.id, ctx)) return;
      // И тот же корень, что у Н-3: гасит плашку только правка, версию которой сервер сверял.
      // Успех чекбокса или архивации о конфликте тела не знает ничего — а обвязка общая, и
      // без этого условия чекбокс, нажатый следом за отказавшей правкой тела, снимал бы с
      // экрана единственное сообщение о расхождении.
      if (!checksVersion(vars)) return;
      if (vars.id === entityId) setConflict(false);
    },
    // Detail — единственный путь закрытия/переноса/архивации сущности из списков (Agenda,
    // Browser, Budget), а списки читают ДРУГОЙ ключ кэша — entity.query. Он держит
    // собственный staleTime (60 с у Agenda по K16, 30 с глобально в trpc.ts) и при
    // refetchOnWindowFocus:false сам не протухнет: без явной инвалидации закрытая задача
    // висела бы в «Просроченном» до минуты после «Готово» (02-core-os §4.2, приёмка §8.2).
    // Тот же путь уже у QuickCapture/QuickAddBar/ImportFlow — здесь его недоставало.
    // Р17: инвалидация detail — БЕЗ аргумента. Правка аспекта двигает прогресс чужой
    // открытой цели, а переименование — строку этой сущности у соседей: в их подзадачах
    // и backlinks и в строках query_result чата (EntityRef читает ключ {id} без include,
    // backlinks приезжают внутри ответа соседа — точечный ключ detail не задевал ни то,
    // ни другое).
    onSettled: () => invalidateGraph(utils),
  });

  return { mutation, conflict, dismissConflict: () => setConflict(false) };
}

export function useEntityDetail(entityId: string) {
  const get = trpc.entity.get.useQuery(detailGetInput(entityId), {
    // Идущий прогон опрашивается сам (run-poll.ts): экран прогона после «Прогнать сейчас»
    // иначе застывал бы на «идёт · 0 шагов» до перезагрузки. Для остальных записей — false.
    refetchInterval: (query) => runPollInterval(query.state.data?.entity.aspects),
  });
  const { mutation, conflict, dismissConflict } = useEntityUpdate(entityId);
  const entity = get.data?.entity;

  // Чекбокс task (§3.6): status=done + completed_at (optimistic + откат при ошибке).
  function toggleTask(done: boolean) {
    mutation.mutate({
      id: entityId,
      aspects: {
        'orbis/task': {
          status: done ? 'done' : 'inbox',
          completed_at: done ? new Date().toISOString() : null,
          /**
           * `waiting_for: null` — конвенция ADE-среза 1, и обе стороны чекбокса её требуют
           * одинаково: и `done`, и возврат в `inbox` уводят задачу ИЗ waiting, а патч
           * аспектов мержится по полям (normalize.ts) — без явного null вопрос исполнителя
           * пережил бы снятие галочки и висел бы на закрытой задаче, читаясь как открытый.
           * Сервер делает ровно это на ВСЕХ своих выходах из waiting
           * (routers/agent-run.ts:129-131, agent-loop/sweep.ts:111); правка из UI не должна
           * быть исключением. Для задачи, которая в waiting не была, поле и так пусто —
           * лишний null ничего не меняет.
           */
          waiting_for: null,
        },
      },
    });
  }

  // Правки ТЕЛА здесь нет и быть не должно: тело уехало на автосохранение по паузе
  // (`useBodySave`) ещё в Задаче 13, и оно шлёт `bodyDoc`, а не markdown-строку. Прежний
  // `saveBody(body: string)` пережил тот переезд мёртвым: его не звал ни один экран, зато на
  // нём держались два теста — то есть зелёными они были на пути, которого в проде нет
  // (ревью раунда 3). Сюжеты переписаны на достижимый путь, метод удалён.

  // Правка заголовка (DF п.3) — тот же контракт §5.2, что у body: у memory-правила
  // title и есть вся его машиночитаемая часть (K19.4), и правка «формулировки»,
  // обещанная экраном «Память AI», — это именно правка title.
  function saveTitle(title: string) {
    if (!entity) return;
    mutation.mutate({ id: entityId, title, expectedUpdatedAt: entity.updatedAt });
  }

  function setArchived(archived: boolean) {
    mutation.mutate({ id: entityId, archived });
  }

  return {
    get,
    entity,
    update: mutation,
    toggleTask,
    saveTitle,
    setArchived,
    conflict,
    dismissConflict,
  };
}
