import { TRPCClientError } from '@trpc/client';
import { useRef, useState } from 'react';
import { invalidateGraph } from '../../lib/invalidate';
import { type RouterInputs, type RouterOutputs, trpc } from '../../trpc';

type Entity = RouterOutputs['entity']['get']['entity'];
type UpdateInput = RouterInputs['entity']['update'];

// §9.2: detail тянет body+relations+backlinks+thread (backlinks — секция «Связанное»
// §3.5.7, Task D5). Один и тот же input — ключ кэша для useQuery и точечных
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
   * Последняя мутация ПО КАЖДОЙ записи — её номер и метка версии, с которой она ушла.
   *
   * Живых мутаций по одной записи бывает две, и источников этому ДВА. Первый: автосохранение
   * тела бросает зависший запрос по выдержке и досылает поверх него (useBodySave,
   * SAVE_GIVE_UP_MS). Второй — сама эта обвязка: через один наблюдатель идут и правки с меткой
   * (title/body), и правки без метки (чекбокс задачи, архивация), и человек волен нажать одно
   * следом за другим. Колбэки здесь — уровня МУТАЦИИ и исполняются всегда, даже когда
   * наблюдателя уже отцепили.
   *
   * Счётчик ведётся ПО ЗАПИСИ, а не один на хук: иначе мутация соседней сущности объявляла бы
   * устаревшей мутацию первой, и та лишилась бы отката — ровно того, ради чего он и написан.
   */
  const seqRef = useRef(0);
  const latestRef = useRef<Record<string, { seq: number; expectedUpdatedAt?: string }>>({});

  /**
   * Приехал ли ответ мутации, которую УЖЕ сменила следующая по той же записи.
   *
   * Спрашивают об этом ДВА колбэка, и ответ им нужен разный. Откату этого признака ДОСТАТОЧНО:
   * снимок брошенной мутации сделан ДО патча преемника, и вернуть его — значит выбросить чужую
   * свежую правку. Кэш при этом лечит инвалидация в onSettled; опора именно на неё, и в
   * офлайне, где перечитывание не доедет, оптимистичный патч отказавшей мутации на экране
   * задержится. Гашению конфликта (onSuccess) признака тоже достаточно, а вот показу — нет,
   * там нужна ещё и сверка меток (см. ниже).
   */
  const superseded = (id: string, ctx?: { seq: number }) =>
    ctx !== undefined &&
    latestRef.current[id] !== undefined &&
    latestRef.current[id]?.seq !== ctx.seq;

  /**
   * А молчать о 409 можно только тогда, когда преемник ушёл с ТОЙ ЖЕ меткой версии: тогда он
   * заведомо принесёт тот же самый конфликт, и второй плашки не нужно. Сюжет, на котором это
   * важно: человек переименовал запись и тут же отметил задачу готовой. Архивация и чекбокс
   * уходят БЕЗ метки и 409 получить не могут в принципе — промолчи мы здесь, человек не узнал
   * бы о расхождении вовсе (ревью Задачи 14, Н-2).
   */
  const sameExpectation = (id: string, ctx?: { expectedUpdatedAt?: string }) => {
    const latest = latestRef.current[id];
    return (
      latest?.expectedUpdatedAt !== undefined && latest.expectedUpdatedAt === ctx?.expectedUpdatedAt
    );
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
      };
      // Ключ едет в контекст ВМЕСТЕ со снимком. Откат обязан лечь туда же, откуда снимок
      // взят, а `input` — замыкание ПОСЛЕДНЕГО рендера: смени экран сущность, пока запрос в
      // полёте, и откат положил бы данные прежней записи под ключ новой (ревью Задачи 13, I1).
      return { prev, input, seq: seqRef.current, expectedUpdatedAt: vars.expectedUpdatedAt };
    },
    onError: (err, vars, ctx) => {
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
      // Молчим только о конфликте, который преемник принесёт и сам (см. sameExpectation).
      if (old && sameExpectation(vars.id, ctx)) return;
      if (err instanceof TRPCClientError && err.data?.code === 'CONFLICT') setConflict(true);
    },
    onSuccess: (_data, vars, ctx) => {
      // Здесь сверка ТОЛЬКО на «сменила ли эту мутацию следующая», без сравнения меток — и
      // это не забытая симметрия с onError, а разные вопросы. Там решается, показывать ли
      // конфликт, и промолчать можно лишь о том, который принесёт и преемник, то есть при
      // совпавших метках. Здесь решается, ГАСИТЬ ли уже показанный, а поздний успех устаревшей
      // мутации не говорит ничего о расхождении, которое держит плашку сейчас, — с какой бы
      // меткой ни ушёл преемник. Проверено мутацией (M55): добавь сюда сверку меток — и успех
      // брошенной правки гасил бы чужой живой конфликт.
      if (superseded(vars.id, ctx)) return;
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
  const get = trpc.entity.get.useQuery(detailGetInput(entityId));
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
        },
      },
    });
  }

  // §5.2: expectedUpdatedAt = ТОЧНАЯ строка updatedAt, которую клиент видел в кэше.
  function saveBody(body: string) {
    if (!entity) return;
    mutation.mutate({ id: entityId, body, expectedUpdatedAt: entity.updatedAt });
  }

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
    saveBody,
    saveTitle,
    setArchived,
    conflict,
    dismissConflict,
  };
}
