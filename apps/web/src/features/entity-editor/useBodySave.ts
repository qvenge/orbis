// Оба импорта — ТОЛЬКО type, и это не стиль: хук монтирует экран detail (Задача 15), а
// рантайм-импорт любого из них увёл бы схему редактора в его чанк. Стережёт save.test.tsx.
import type { BodyDoc } from '@orbis/shared/doc';
import type { JSONContent } from '@tiptap/core';
import { TRPCClientError } from '@trpc/client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { RouterInputs } from '../../trpc';
import { useEntityUpdate } from '../entity-detail/useEntityDetail';
import { sameDoc } from './strip-ids';

/** Форма документа во входе мутации: у zod-схемы она уже, чем `BodyDoc` (см. вызов mutate). */
type UpdateBodyDoc = RouterInputs['entity']['update']['bodyDoc'];

/**
 * Пауза перед сохранением — щедрая НАМЕРЕННО: onSettled мутации зовёт invalidateGraph(utils),
 * то есть инвалидацию ВСЕГО графа (useEntityDetail.ts:75), и сохранение на каждый штрих било бы
 * по кэшу каждые несколько нажатий.
 */
export const SAVE_DEBOUNCE_MS = 2000;

/**
 * Отказ, повторять который бессмысленно. VALIDATION серверного гейта (§5.2, Задача 5) приезжает
 * сюда как BAD_REQUEST: документ структурно битый или чужой версии схемы — тот же документ будет
 * отвергнут и в следующий раз, а средства спасения у сообщения для человека нет («перезагрузите
 * приложение»). Без остановки каждое нажатие клавиши уходило бы в сеть обречённым запросом.
 *
 * Прочие коды терминальными здесь НЕ считаются, хотя кандидат есть: NOT_FOUND (запись удалили
 * из другого места) тоже не вылечится повтором. Он не добавлен потому, что не проверен тестом,
 * а тихо расширять множество «больше не сохраняем» опаснее лишнего запроса.
 */
const TERMINAL_CODE = 'BAD_REQUEST';

export type BodySaveState = 'idle' | 'saving' | 'error';

/**
 * То, что хук читает у сущности из кэша detail. Форма `bodyDoc` — ВАЙРОВАЯ (`doc` объявлен
 * `Record<string, unknown>` в WireEntity), а не `BodyDoc`: так `useBodySave(id, entity)`
 * принимает сущность из useEntityDetail как есть, без приведения на стороне экрана.
 */
export type BodySaveEntity = {
  updatedAt: string;
  bodyDoc?: { v: number; doc: Record<string, unknown> } | null;
};

export interface BodySave {
  onDocChange: (doc: BodyDoc) => void;
  flush: () => void;
  state: BodySaveState;
  conflict: boolean;
  /** Черновик из прошлой сессии, разошедшийся с сервером (заполняет Задача 14). */
  pendingDraft: { doc: BodyDoc; savedAt: string } | null;
  applyPendingDraft: () => void;
  discardPendingDraft: () => void;
}

/** Заглушки Задачи 14 — модульные, чтобы не менять личность полей на каждом рендере. */
const noop = () => {};

/**
 * Автосохранение тела: правка доезжает до базы сама, по паузе в наборе.
 *
 * Три вещи, ради которых хук вообще существует отдельно от useEntityDetail.saveBody:
 *  1. пауза (иначе мутация на каждое нажатие клавиши, см. SAVE_DEBOUNCE_MS);
 *  2. отсев правок, которые правками не являются (сравнение по смыслу, см. strip-ids.ts);
 *  3. разделение отказов: 409 — «перечитайте и повторите», VALIDATION — конец.
 *
 * Клиент НЕ сериализует документ в markdown: уезжает `bodyDoc`, а `body` — проекция, и делает
 * её сервер, и только он.
 */
export function useBodySave(entityId: string, entity: BodySaveEntity): BodySave {
  const { mutation, conflict } = useEntityUpdate(entityId);
  const mutate = mutation.mutate;

  // Отказ ДЕРЖИТСЯ до успеха и переживает следующую попытку: иначе повтор гасил бы «Не
  // сохранено» на время запроса и зажигал заново — мигание вместо ответа на вопрос
  // «сохранено ли». Гасит его только успех.
  const [failed, setFailed] = useState(false);
  const [saving, setSaving] = useState(false);

  // Сущность читается ЧЕРЕЗ ref: сохранение случается в отложенном колбэке, и замыкание того
  // рендера, где нажали клавишу, несло бы уже протухшие updatedAt и документ.
  const entityRef = useRef(entity);
  useEffect(() => {
    entityRef.current = entity;
  });

  const pendingRef = useRef<BodyDoc | null>(null);
  const timerRef = useRef<number | null>(null);
  const inFlightRef = useRef(false);
  const stoppedRef = useRef(false);
  /** «Как только текущий запрос осядет — отправить отложенное». Ставится вместо второй попытки. */
  const chainedRef = useRef(false);
  /**
   * updatedAt, который сервер подтвердил ПОСЛЕДНИМ сохранением. Кэш узнаёт новое значение
   * только с перечитывания (его заводит invalidateGraph в onSettled), а оно может и опоздать:
   * пауза 2 с, а круг «мутация + перечитывание» на плохой связи длиннее. Со строкой из кэша
   * второе сохранение подряд ловило бы 409 без всякой чужой правки.
   */
  const confirmedRef = useRef<string | null>(null);
  /**
   * Поколение записи. Растёт при смене `entityId` и отсекает колбэки запросов, ушедших ДО
   * смены: сам запрос при этом не отменяется (он про прежнюю запись и обязан доехать), но его
   * ответ больше не касается ничего здесь. Без отсечки подтверждённый updatedAt ПЕРВОЙ записи
   * лёг бы в счёт второй (и её первое же сохранение получило бы 409 на ровном месте), её
   * BAD_REQUEST молча выключил бы сохранение второй до перезагрузки, а её отказ зажёг бы
   * «Не сохранено» на записи, которой никто не касался (ревью Задачи 13, I1).
   */
  const genRef = useRef(0);

  // useCallback без зависимостей, а не голая функция: иначе она пересоздаётся каждым рендером
  // и попадает в списки зависимостей ниже — вместе со всем, что от них зависит.
  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  // Смена сущности под ТЕМ ЖЕ хуком обнуляет всё накопленное: отложенный документ, подтверждённый
  // updatedAt и терминальную остановку — они про ПРЕЖНЮЮ запись. Без этого отложенное тело одной
  // заметки уехало бы в тело соседней (`{ id: 'вторая', bodyDoc: <тело первой> }`) — молча и
  // необратимо. Сегодняшний экран пересоздаёт секцию тела по `key={entity.id}` и до такого не
  // доводит, но верность хука не должна держаться на чужом ключе: Задача 15 вправе смонтировать
  // его иначе. Уже набранное при этом теряется — успеть его сохранить может только экран, и
  // средство у него есть: flush() перед сменой записи.
  //
  // Сброс идёт ПРЯМО В РЕНДЕРЕ (приём React «adjusting state when props change»), а не эффектом,
  // и это не вкусовщина: эффект отработал бы уже ПОСЛЕ рендера с новым id, и чужой flush() из
  // эффекта родителя, попав в эту щель, уехал бы старым телом под новым id — ровно та ошибка,
  // против которой сброс и написан.
  const prevIdRef = useRef(entityId);
  if (prevIdRef.current !== entityId) {
    prevIdRef.current = entityId;
    // Поколение — первым делом: с этой строки колбэки уже ушедшего запроса сюда не достучатся.
    genRef.current += 1;
    // Снятие таймера. Беда, от которой оно защищает, РЕАЛЬНА и воспроизведена: доживший таймер
    // прежней записи будит ПРЕЖНИЙ `save` (тот замкнул на себе старый `entityId`), а рефы
    // читает уже новой записи — и уезжает `{ id: <первая>, bodyDoc: <тело второй> }`, а вторая
    // не сохраняется вовсе, потому что старый `save` первой же строкой снял и её таймер.
    // Сценарий: правка в первой, смена записи внутри паузы, правка во второй (тест «таймер
    // прежней записи не уносит в неё тело новой»).
    //
    // Но снятий на этом пути ДВА, и они взаимозаменяемы: `onDocChange` тоже снимает таймер
    // перед тем, как завести новый, а `timerRef` держит ровно один заведённый. Замерено тремя
    // прогонами того теста: убрать это снятие — зелено, убрать снятие в `onDocChange` — зелено,
    // убрать ОБА — тест краснеет отправкой `id: 'e1'` с телом второй записи. Поэтому мутант,
    // снимающий одну эту строку, и выживает: он перекрыт вторым снятием, а не безвреден.
    clearTimer();
    pendingRef.current = null;
    confirmedRef.current = null;
    stoppedRef.current = false;
    chainedRef.current = false;
    // «В полёте» — про ПРЕЖНЮЮ запись, и её ответ сюда уже не придёт (см. поколение). Не сними
    // мы флаг, новая запись ждала бы освобождения вечно и не сохранилась бы ни разу.
    inFlightRef.current = false;
    setFailed(false);
    setSaving(false);
  }

  // Тип объявлен явно: без него `save`, зовущий себя из собственного колбэка, попадает в
  // циклический вывод типа (TS7022).
  const save = useCallback<() => void>(() => {
    clearTimer();
    const doc = pendingRef.current;
    if (doc === null) return;
    if (stoppedRef.current) return;
    /**
     * Пока прошлое сохранение в полёте, второй запрос НЕ уходит — ни по паузе, ни по flush().
     * Дело не только в том, что он ушёл бы с тем же expectedUpdatedAt и получил бы 409 от
     * собственного же предшественника. Хуже: @tanstack/query-core в `MutationObserver.mutate`
     * снимает наблюдателя с прежней мутации (`#currentMutation?.removeObserver(this)`), а
     * поштучные колбэки живут в `#mutateOptions` и зовутся только через уведомление
     * ПОДПИСАННОГО наблюдателя. То есть у первого запроса пропадают ВСЕ колбэки разом:
     * `confirmedRef` не обновится даже при успехе, `pendingRef` не очистится, `inFlightRef`
     * соврёт «свободно» раньше времени (осядь второй первым — третий уедет параллельно), а
     * терминальный BAD_REQUEST именно этого запроса никого не остановит. Теряется не попытка,
     * а вся бухгалтерия полёта (ревью Задачи 13, I2).
     *
     * Поэтому отложенное ДОСЫЛАЕТСЯ по оседанию первого — из onSettled ниже. Для flush() это
     * значит «уйдёт первым же освободившимся кругом», а не «уйдёт прямо сейчас»; цена честная,
     * потому что «прямо сейчас» и раньше оборачивалось гарантированным 409, то есть отказом.
     */
    if (inFlightRef.current) {
      chainedRef.current = true;
      return;
    }

    const base = entityRef.current;
    // Правка ли это вообще. Сравнение по СМЫСЛУ: UniqueID кладёт attrs.id во все блоки, и по
    // строковому равенству документ «менялся» бы всегда (см. strip-ids.ts).
    if (
      base.bodyDoc != null &&
      base.bodyDoc.v === doc.v &&
      sameDoc(doc.doc, base.bodyDoc.doc as JSONContent)
    ) {
      pendingRef.current = null;
      // И отказ гаснет: на экране ровно то, что в базе. Иначе «Не сохранено» висело бы вечно
      // у человека, который после отказа просто вернул текст к прежнему, — сохранять нечего,
      // а успешной мутации, которая одна и гасила плашку, уже неоткуда взяться.
      setFailed(false);
      return;
    }

    // §5.2: expectedUpdatedAt — ТОЧНАЯ строка, которую клиент видел, а не «сейчас». Из двух
    // известных берём позднюю: обе приходят от сервера в одном формате ISO-UTC (toISOString),
    // где лексикографический порядок совпадает с хронологическим, а сам updated_at строго
    // растёт (monotonicUpdatedAt).
    const confirmed = confirmedRef.current;
    const expectedUpdatedAt =
      confirmed !== null && confirmed > base.updatedAt ? confirmed : base.updatedAt;

    // Поколение снимается ДО отправки: колбэки ниже сверяются с ним и молчат, если запись
    // под хуком успела смениться.
    const gen = genRef.current;
    const stale = () => gen !== genRef.current;

    inFlightRef.current = true;
    chainedRef.current = false;
    setSaving(true);
    mutate(
      // Приведение, а не проверка формы: `JSONContent` описывает ЛЮБОЙ узел ProseMirror, а
      // вход мутации сужен до узла `doc` с массивом блоков — на уровне типов эти две правды
      // не сводятся. Проверять форму здесь незачем: ровно это и спрашивает серверный гейт
      // (Задача 5), а его отказ терминален и виден.
      { id: entityId, bodyDoc: doc as UpdateBodyDoc, expectedUpdatedAt },
      {
        onSuccess: (saved) => {
          if (stale()) return;
          confirmedRef.current = saved.updatedAt;
          // Снимается с очереди только ЭТОТ документ. Приехавшую за время запроса правку
          // отправит её СОБСТВЕННЫЙ таймер паузы, а если тот успел сработать, пока шёл
          // запрос, — досыл из onSettled. Второй путь заметнее, первый — чаще.
          if (pendingRef.current === doc) pendingRef.current = null;
          setFailed(false);
        },
        onError: (err) => {
          if (stale()) return;
          setFailed(true);
          // Документ не выбрасывается: `pendingRef` остаётся, потому что при 409 человек
          // продолжает набирать ровно этот текст, и подмена его серверным вырвала бы правку
          // из-под рук.
          if (err instanceof TRPCClientError && err.data?.code === TERMINAL_CODE) {
            stoppedRef.current = true;
          }
        },
        onSettled: () => {
          // Отсечка ЗДЕСЬ тестом не покрыта и покрыта быть не может (проверено мутацией — без
          // неё все тесты зелёные): к моменту, когда оседает запрос прежней записи, сброс уже
          // выставил признак полёта в false, а флаг досыла — тоже; снимать нечего. Оставлена
          // ради симметрии с двумя колбэками выше, где отсечка нагружена по-настоящему: стоит
          // хоть одному из сбрасываемых значений перестать сбрасываться — она станет нужна.
          if (stale()) return;
          inFlightRef.current = false;
          setSaving(false);
          // Досыл отложенного — ОДИН, и только если его просили, пока шёл запрос. Сам по себе
          // отказ повтора не заводит: тот ушёл бы с тем же протухшим expectedUpdatedAt и
          // получил бы тот же 409 — и так по кругу. Флаг снимается перед вызовом, поэтому
          // круг «отказ → досыл → отказ → досыл» невозможен: второй досыл никто не просил.
          if (chainedRef.current) {
            chainedRef.current = false;
            save();
          }
        },
      },
    );
  }, [entityId, mutate, clearTimer]);

  const onDocChange = useCallback(
    (doc: BodyDoc) => {
      pendingRef.current = doc;
      clearTimer();
      timerRef.current = window.setTimeout(save, SAVE_DEBOUNCE_MS);
    },
    [save, clearTimer],
  );

  const flush = save;

  // Таймер снимается при размонтировании, но сохранение отсюда НЕ досылается: чей это жест —
  // уход с экрана, потеря фокуса, закрытие вкладки — знает экран, он и зовёт flush().
  useEffect(() => clearTimer, [clearTimer]);

  return {
    onDocChange,
    flush,
    state: failed ? 'error' : saving ? 'saving' : 'idle',
    conflict,
    pendingDraft: null,
    applyPendingDraft: noop,
    discardPendingDraft: noop,
  };
}
