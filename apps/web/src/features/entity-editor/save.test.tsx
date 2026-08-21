import { readFileSync } from 'node:fs';
import { type BodyDoc, DOC_EXTENSIONS, parseBody } from '@orbis/shared/doc';
import { act, screen } from '@testing-library/react';
import { getSchema } from '@tiptap/core';
import { Node as PMNode } from '@tiptap/pm/model';
import { useState } from 'react';
import { beforeEach, expect, test, vi } from 'vitest';
import { installCrashTrap, renderWithProviders, trpcError } from '../../test/harness';
import { trpc } from '../../trpc';
import { detailGetInput } from '../entity-detail/useEntityDetail';
import { SaveIndicator, SLOW_SAVE_MS } from './SaveIndicator';
import { UNIQUE_ID_TYPES } from './strip-ids';
import { type BodySave, type BodySaveEntity, type BodySaveState, useBodySave } from './useBodySave';

// Сохранение живёт в отложенных колбэках (таймер паузы, обработчики мутации). Ошибка,
// брошенная оттуда, до ассертов не доезжает: прогон краснеет КОДОМ ВОЗВРАТА при зелёных
// тестах. Ставится файлом, не глобально: см. harness.
installCrashTrap();

// --- стенд ----------------------------------------------------------------------------------

/** Тело в кэше detail на момент открытия — с ним хук и сравнивает приходящие документы. */
/** Владелец записи: по нему скоупятся черновики на диске (см. draft-storage). */
const OWNER = 'u1';

const BASE = parseBody('тело');
const ONE = parseBody('тело и правка');
const TWO = parseBody('тело, правка и ещё одна');
const THREE_MD = 'совсем другое тело';
const THREE = parseBody(THREE_MD);

/**
 * `updatedAt` фиксирован и НАМЕРЕННО далёк от системного времени прогона (2030 год ниже):
 * подстановка «сейчас» вместо строки из кэша — самый вероятный способ сломать §5.2, и
 * тест обязан отличать одно от другого, а не сверять «какую-то строку».
 */
const ENTITY: BodySaveEntity = {
  ownerId: OWNER,
  updatedAt: '2026-08-14T10:00:00.000Z',
  bodyDoc: BASE,
};

/** Ответ сервера на entity.update: сущность с НОВЫМ updatedAt (сервер его всегда двигает). */
const SAVED = { id: 'e1', updatedAt: '2026-08-14T11:00:00.000Z' };

type Respond = (input: unknown) => unknown;
const ok: Respond = () => SAVED;

/**
 * Сервер, который отвечает не сам, а КОГДА СКАЖУТ. Без него «второй запрос не уходит, пока
 * идёт первый» пришлось бы проверять зависшим навсегда промисом — то есть не проверять досыл
 * вовсе, а он и есть суть правки I2.
 */
function gatedServer() {
  const gates: { settle: (v: unknown) => void; fail: (e: unknown) => void }[] = [];
  const respond: Respond = () =>
    new Promise((resolve, reject) => {
      gates.push({ settle: resolve, fail: reject });
    });
  /** Ответить на i-й ушедший запрос и дать колбэкам отработать. */
  const answer = async (i: number, value: unknown, mode: 'ok' | 'fail' = 'ok') => {
    const gate = gates[i];
    if (gate === undefined) throw new Error(`запроса №${i} не было — отвечать нечему`);
    await act(async () => {
      if (mode === 'ok') gate.settle(value);
      else gate.fail(value);
      await vi.advanceTimersByTimeAsync(0);
    });
  };
  return { respond, answer, count: () => gates.length };
}

/**
 * Потолок отправок на один стенд. Дефект, замыкающий сохранение в самоподдерживающийся круг
 * (например «досылать всегда, а не по просьбе»), не краснеет — он ВЕШАЕТ прогон: замерено 147 с
 * до `Worker exited unexpectedly`, и результат уже упавших тестов теряется вместе с воркером.
 * За потолком стенд перестаёт отвечать вовсе: круг размыкается, тест падает своим ассертом или
 * штатным таймаутом, а не уносит с собой весь файл.
 */
const MAX_SENDS = 12;

function setup(opts: { entity?: BodySaveEntity; respond?: Respond } = {}) {
  const box = { respond: opts.respond ?? ok };
  const hold: { api: BodySave | null } = { api: null };

  function Probe() {
    const api = useBodySave('e1', opts.entity ?? ENTITY);
    hold.api = api;
    // Индикатор — здесь, а не в отдельном дереве: требование «отказ показывает „Не
    // сохранено“» про связку хук+индикатор, и проверять её надо целиком.
    return <SaveIndicator state={api.state} />;
  }

  // Мок СТРОГИЙ и функцией: у сохранения тела ровно один путь наружу. Молчаливая заглушка
  // `() => ({})` приняла бы и лишнее чтение, и чужую мутацию — и «ровно одна мутация» ниже
  // прошло бы при второй, но другой.
  let sends = 0;
  const { calls, container, unmount } = renderWithProviders(<Probe />, (path, input) => {
    if (path !== 'entity.update') throw new Error(`сохранение тела не ходит на ${path}`);
    sends += 1;
    if (sends > MAX_SENDS) return new Promise(() => {});
    return box.respond(input);
  });

  return {
    container,
    calls,
    /** Уход с записи (или с экрана): размонтирование обязано дослать отложенное. */
    unmount: () => act(() => unmount()),
    /** Отправленные мутации сохранения. */
    updates: () => calls.filter((c) => c.path === 'entity.update'),
    /** Всё, что ушло МИМО сохранения: «мутаций нет» обязано значить «в сеть не ходили вовсе». */
    stray: () => calls.filter((c) => c.path !== 'entity.update'),
    api: () => hold.api as BodySave,
    /** Смена поведения сервера посреди теста (отказ → успех). */
    serve: (respond: Respond) => {
      box.respond = respond;
    },
  };
}

/** Прогон таймеров внутри act: мутация оседает промисом, а состояние хука — стейтом React. */
async function tick(ms = 0): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/**
 * Пороги записаны ЧИСЛАМИ, а не взяты из самих модулей, и трогать это не надо: с импортом
 * `SAVE_DEBOUNCE_MS` тест ехал бы за реализацией и остался бы зелёным при паузе в 50 мс — то
 * есть при сохранении на каждый штрих, ровно том, против чего пауза и заведена (проверено
 * мутацией M1). Значение — договор, а не деталь.
 */
const SAVE_PAUSE = 2000;
const SLOW_THRESHOLD = 1000;

/**
 * Что индикатор говорит о ТЕРМИНАЛЬНОМ отказе. Выписано строкой, а не взято из модуля, по той
 * же причине, что и пороги: это обещание человеку, а не деталь. Совпади оно с сетевым
 * «Не сохранено» — экран сказал бы «повторим», не собираясь повторять никогда.
 */
const TERMINAL_TEXT = 'Правка отклонена — обновите страницу';

beforeEach(() => {
  // Черновик Задачи 14 переживает не только вкладку, но и ТЕСТ: все стенды файла работают с
  // записью 'e1', и неотправленная правка одного теста досылалась бы на монтировании
  // следующего — лишней мутацией, которой тот не ждёт. Судьба самого черновика проверяется
  // в draft.test.tsx; здесь он обязан быть пуст.
  localStorage.clear();
  // Системное время далеко от `updatedAt` сущности — см. ENTITY выше.
  vi.useFakeTimers().setSystemTime(new Date('2030-01-01T00:00:00.000Z'));
  return () => {
    vi.useRealTimers();
  };
});

/** Тот же документ, но с блочными id, как их проставляет UniqueID уже после монтирования. */
function withBlockIds(doc: BodyDoc): BodyDoc {
  return {
    v: doc.v,
    doc: {
      ...doc.doc,
      content: (doc.doc.content ?? []).map((node, i) => ({
        ...node,
        attrs: { ...(node.attrs ?? {}), id: `block-${i}` },
      })),
    },
  };
}

// --- пауза ----------------------------------------------------------------------------------

test('набор не шлёт мутацию сразу; после паузы — ровно одну, с последним документом', async () => {
  const s = setup();
  s.api().onDocChange(ONE);
  s.api().onDocChange(TWO);
  s.api().onDocChange(THREE);

  await tick(SAVE_PAUSE - 1);
  // Пауза щедрая намеренно: onSettled мутации инвалидирует ВЕСЬ граф, и сохранение на
  // каждый штрих било бы по кэшу каждые несколько нажатий.
  expect(s.updates()).toHaveLength(0);
  expect(s.stray()).toEqual([]);

  await tick(1);
  expect(s.updates()).toHaveLength(1);
  // Отложено, а не «первое проходит, остальные глушатся»: уезжает ПОСЛЕДНИЙ документ.
  expect((s.updates()[0]?.input as { bodyDoc: BodyDoc }).bodyDoc).toEqual(THREE);

  // И ни одного повтора потом: сохранение не крутится само по себе.
  await tick(10_000);
  expect(s.updates()).toHaveLength(1);
});

test('пауза отсчитывается от ПОСЛЕДНЕГО нажатия, а не от первого', async () => {
  // Набор вразбивку — то, как печатают на самом деле. Считай хук от первой правки, отправка
  // ушла бы посреди фразы, и дальше на каждую такую же — то есть пауза стала бы не паузой,
  // а периодом. Три onDocChange в одном тике этого не показывают: их таймеры совпадают.
  const s = setup();
  s.api().onDocChange(ONE);
  await tick(SAVE_PAUSE - 500);
  s.api().onDocChange(TWO);
  await tick(SAVE_PAUSE - 500);
  s.api().onDocChange(THREE);
  await tick(SAVE_PAUSE - 500);
  // Прошло 4500 мс — больше двух пауз, но ни одного молчания в две секунды.
  expect(s.updates()).toHaveLength(0);

  await tick(500);
  expect(s.updates()).toHaveLength(1);
  expect((s.updates()[0]?.input as { bodyDoc: BodyDoc }).bodyDoc).toEqual(THREE);
});

test('flush() шлёт немедленно — и снимает за собой таймер паузы', async () => {
  // Сервер отказывает НАМЕРЕННО: при успехе документ снимается с очереди сам, и уцелевший
  // таймер паузы было бы не отличить от снятого — вторая отправка не состоялась бы по другой
  // причине. С отказом документ остаётся на руках, и разница видна.
  const s = setup({
    respond: () => {
      throw trpcError('INTERNAL_SERVER_ERROR');
    },
  });
  s.api().onDocChange(ONE);
  expect(s.updates()).toHaveLength(0); // страж: до flush() пауза ещё идёт

  await act(async () => {
    s.api().flush();
  });
  expect(s.updates()).toHaveLength(1);
  expect((s.updates()[0]?.input as { bodyDoc: BodyDoc }).bodyDoc).toEqual(ONE);

  // Уцелей таймер — набранное уехало бы вторым разом само, без единой новой правки.
  await tick(SAVE_PAUSE);
  expect(s.updates()).toHaveLength(1);
});

test('размонтирование досылает отложенное — уход с записи не теряет набранного', async () => {
  // Экран монтирует тело с `key={entity.id}` (Задача 15), поэтому переход entity→entity — это
  // размонтирование. Без досыла терялось бы всё, что человек набрал в последние две секунды
  // перед переходом: таймер паузы снимается уборкой, а второго шанса ни у кого нет.
  const s = setup();
  s.api().onDocChange(ONE);
  // Страж: до размонтирования пауза ещё идёт и в сеть никто не ходил — иначе проверка ниже
  // была бы зелена и у хука, который шлёт на каждое нажатие.
  expect(s.updates()).toHaveLength(0);

  await s.unmount();

  expect(s.updates()).toHaveLength(1);
  expect(s.updates()[0]?.input).toEqual({
    id: 'e1',
    bodyDoc: ONE,
    expectedUpdatedAt: ENTITY.updatedAt,
  });
  // И ровно один: снятый таймер паузы не будит вторую отправку уже после ухода.
  await tick(SAVE_PAUSE * 3);
  expect(s.updates()).toHaveLength(1);
});

test('размонтирование без набранного в сеть не ходит вовсе', async () => {
  // Открыл запись, посмотрел, ушёл — и ни одной мутации. Отдельный тест, потому что «досылать
  // на размонтировании» легко написать так, что уход с ЛЮБОЙ записи пишет в базу: редактор при
  // монтировании присылает тело базы с блочными id, и сравнение по смыслу — единственное, что
  // отличает это эхо от правки.
  const s = setup();
  s.api().onDocChange(withBlockIds(BASE)); // ровно то эхо, что приходит на монтировании
  await s.unmount();
  expect(s.updates()).toEqual([]);
  expect(s.stray()).toEqual([]);
});

test('пока идёт запрос, второй не уходит — ни по паузе, ни по flush(); досылается по оседанию', async () => {
  // Параллельный второй запрос не просто ловил бы 409 от собственного предшественника: у
  // ПЕРВОГО пропали бы все поштучные колбэки разом (query-core снимает наблюдателя с прежней
  // мутации), и вместе с ними — подтверждённый updatedAt, очистка отложенного, признак полёта
  // и терминальная остановка. Поэтому отложенное ждёт оседания и уходит одним досылом.
  const server = gatedServer();
  const s = setup({ respond: server.respond });
  s.api().onDocChange(ONE);
  await tick(SAVE_PAUSE);
  expect(s.updates()).toHaveLength(1);

  // Ни пауза, ни flush() второго запроса не заводят.
  s.api().onDocChange(TWO);
  await tick(SAVE_PAUSE * 3);
  expect(s.updates()).toHaveLength(1);
  await act(async () => {
    s.api().flush();
  });
  expect(s.updates()).toHaveLength(1);

  // Первый осел — досыл уходит сам, с последним документом и с подтверждённым updatedAt.
  await server.answer(0, SAVED);
  expect(s.updates()).toHaveLength(2);
  expect(s.updates()[1]?.input).toEqual({
    id: 'e1',
    bodyDoc: TWO,
    expectedUpdatedAt: SAVED.updatedAt,
  });

  // И ровно ОДИН досыл: оседание второго само по себе третьего не заводит.
  await server.answer(1, SAVED);
  await tick(SAVE_PAUSE * 3);
  expect(s.updates()).toHaveLength(2);
});

test('отказ не заводит досыл сам по себе — круг «отказ → повтор» невозможен', async () => {
  const server = gatedServer();
  const s = setup({ respond: server.respond });
  s.api().onDocChange(ONE);
  await tick(SAVE_PAUSE);
  expect(s.updates()).toHaveLength(1);

  await server.answer(0, trpcError('INTERNAL_SERVER_ERROR'), 'fail');
  expect(screen.getByText('Не сохранено')).toBeInTheDocument();
  await tick(SAVE_PAUSE * 5);
  expect(s.updates()).toHaveLength(1);
});

// --- документ не менялся ----------------------------------------------------------------------

test('документ не изменился — мутации нет вовсе', async () => {
  const s = setup();
  // Тот же документ, но ДРУГОЙ объект: сравнение обязано быть по содержимому.
  s.api().onDocChange(parseBody('тело'));
  await tick(SAVE_PAUSE);
  expect(s.updates()).toHaveLength(0);

  // И flush() тоже не выдумывает правки.
  await act(async () => {
    s.api().flush();
  });
  expect(s.updates()).toHaveLength(0);
  expect(s.stray()).toEqual([]);

  // Положительный контроль В ТОМ ЖЕ ТЕСТЕ: молчание выше — про отсутствие правки, а не
  // про мёртвый хук.
  s.api().onDocChange(ONE);
  await tick(SAVE_PAUSE);
  expect(s.updates()).toHaveLength(1);
});

test('документ, равный по смыслу (отличаются лишь блочные id), мутацию НЕ шлёт', async () => {
  const s = setup();
  const sameByMeaning = withBlockIds(BASE);

  // Стражи вакуумности: документ ДЕЙСТВИТЕЛЬНО отличается строкой (иначе тест проверял бы
  // равенство самому себе) и отличается ровно тем атрибутом, который ставит UniqueID —
  // на типе блока, который он и ведёт.
  expect(JSON.stringify(sameByMeaning)).not.toBe(JSON.stringify(BASE));
  expect(sameByMeaning.doc.content?.[0]?.attrs?.id).toBe('block-0');
  expect(UNIQUE_ID_TYPES).toContain(sameByMeaning.doc.content?.[0]?.type);

  s.api().onDocChange(sameByMeaning);
  await tick(SAVE_PAUSE);
  // Иначе каждое открытие записи писало бы в БД: UniqueID проставляет id отдельной
  // транзакцией уже после монтирования, и по строковому равенству документ «менялся» всегда.
  expect(s.updates()).toHaveLength(0);
  expect(s.stray()).toEqual([]);

  // Положительный контроль: правка ПОВЕРХ проставленных id — настоящая правка.
  s.api().onDocChange(withBlockIds(ONE));
  await tick(SAVE_PAUSE);
  expect(s.updates()).toHaveLength(1);
});

test('документ, отличающийся лишь порядком ключей, мутацию НЕ шлёт', async () => {
  // Документы приезжают из ДВУХ источников с разным порядком полей: parseBody отдаёт текстовый
  // узел как {type,text,marks}, а editor.getJSON() после прохода через схему — {type,marks,text}
  // (замер Задачи 7 на сиде «Жизнь», см. докблок `stable` в strip-ids.ts). По голой строке это
  // «правка», и тогда открытие ЛЮБОЙ записи с жирным, курсивом или ссылкой возвращало бы
  // фантомную запись — на самом бытовом теле. Оба порядка тут выписаны руками: тесту незачем
  // поднимать редактор, чтобы проверить, что сравнение к порядку ключей нечувствительно.
  const fromParse: BodyDoc = {
    v: 1,
    doc: {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'жирный', marks: [{ type: 'bold' }] }],
        },
      ],
    },
  };
  const fromEditor: BodyDoc = {
    v: 1,
    doc: {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', marks: [{ type: 'bold' }], text: 'жирный' }],
        },
      ],
    },
  };
  // Страж вакуумности: строки РАЗНЫЕ (иначе тест сверяет документ сам с собой).
  expect(JSON.stringify(fromEditor)).not.toBe(JSON.stringify(fromParse));

  const s = setup({ entity: { ownerId: OWNER, updatedAt: ENTITY.updatedAt, bodyDoc: fromParse } });
  s.api().onDocChange(fromEditor);
  await tick(SAVE_PAUSE);
  expect(s.updates()).toHaveLength(0);
  expect(s.stray()).toEqual([]);

  // Положительный контроль: смена САМОГО текста при том же порядке ключей — правка.
  s.api().onDocChange(ONE);
  await tick(SAVE_PAUSE);
  expect(s.updates()).toHaveLength(1);
});

test('документ, отличающийся лишь УМОЛЧАНИЯМИ атрибутов, мутацию НЕ шлёт (ссылка, список, таблица)', async () => {
  /**
   * Третья причина того же отказа — и та, из-за которой открытие записи со ССЫЛКОЙ двигало
   * `updated_at` на живом проде (смоук Ш1, Н-1). Разбор markdown не пишет атрибуты, значения
   * которых подразумеваются; схема при посадке в редактор дописывает их все (`target`, `rel`,
   * `class` марке ссылки, `start`/`type` нумерованному списку, четыре штуки каждой ячейке
   * таблицы). Markdown при этом байт-в-байт тот же — сохранялся пустой ход, а платило за него
   * предложение рутины: сдвинутый `updated_at` ломает его CAS, и оно становится `stale`.
   *
   * Сторона редактора берётся ПОСАДКОЙ В НАСТОЯЩУЮ СХЕМУ, а не выписывается руками, как у
   * соседа выше: там разница в одном порядке ключей и её видно глазом, здесь же предмет — сам
   * СПИСОК дописываемых атрибутов, и выписанный руками он проверял бы мою копию против моей же
   * копии. Схему тест поднимает свободно: в чанк записи уезжает не он, а strip-ids.ts.
   */
  const md = 'см. [клинику](https://clinic.example/z)\n\n1. один\n\n| a |\n| --- |\n| 1 |';
  const fromParse = parseBody(md);
  const fromEditor: BodyDoc = {
    v: fromParse.v,
    doc: PMNode.fromJSON(getSchema(DOC_EXTENSIONS as never), fromParse.doc).toJSON(),
  };
  // Страж вакуумности: посадка обязана что-то ДОПИСАТЬ — иначе тест сверяет документ сам с
  // собой и переживёт любую поломку сравнения.
  expect(JSON.stringify(fromEditor)).not.toBe(JSON.stringify(fromParse));
  expect(JSON.stringify(fromEditor)).toContain('"rel":"noopener noreferrer nofollow"');

  const s = setup({ entity: { ownerId: OWNER, updatedAt: ENTITY.updatedAt, bodyDoc: fromParse } });
  s.api().onDocChange(fromEditor);
  await tick(SAVE_PAUSE);
  expect(s.updates()).toHaveLength(0);
  expect(s.stray()).toEqual([]);

  // Положительный контроль, и он про ОСМЫСЛЕННОЕ значение, а не про текст: `target: '_self'`
  // владелец мог поставить нарочно, и от умолчания оно отличается — такая правка обязана
  // доехать. Иначе «снимаем умолчания» тихо превратилось бы в «не сохраняем атрибуты ссылки».
  const retargeted = JSON.parse(JSON.stringify(fromEditor)) as BodyDoc;
  const link = (
    retargeted.doc.content?.[0]?.content?.[1]?.marks?.[0] as { attrs: Record<string, unknown> }
  ).attrs;
  expect(link.target).toBe('_blank');
  link.target = '_self';
  s.api().onDocChange(retargeted);
  await tick(SAVE_PAUSE);
  expect(s.updates()).toHaveLength(1);
});

// --- что именно уезжает -----------------------------------------------------------------------

test('мутация уходит с bodyDoc и точным expectedUpdatedAt из кэша', async () => {
  const s = setup();
  s.api().onDocChange(ONE);
  await tick(SAVE_PAUSE);

  const input = s.updates()[0]?.input as Record<string, unknown>;
  // Полное равенство, а не выборка полей: оно же и стережёт отсутствие `body` — markdown-
  // проекцию делает сервер, и клиентский сериализатор затащил бы всю схему документа в
  // чанк detail, то есть мимо двухфазного монтирования.
  expect(input).toEqual({ id: 'e1', bodyDoc: ONE, expectedUpdatedAt: ENTITY.updatedAt });
  expect(input).not.toHaveProperty('body');
  // §5.2: expectedUpdatedAt — ТОЧНАЯ строка из кэша, а не «сейчас».
  expect(input.expectedUpdatedAt).not.toBe(new Date().toISOString());
});

test('второе сохранение подряд берёт updatedAt из ответа сервера, а не протухший из кэша', async () => {
  // Инвалидация после мутации перечитывает detail, но ответ на это чтение может и опоздать:
  // пауза 2 с, а круг «мутация + перечитывание» на плохой связи длиннее. С протухшей строкой
  // ВТОРОЕ сохранение подряд гарантированно ловило бы 409 — на ровном месте, без чужой правки.
  // Пропс здесь намеренно не обновляется: это и есть «перечитывание не доехало».
  const s = setup();
  s.api().onDocChange(ONE);
  await tick(SAVE_PAUSE);
  s.api().onDocChange(TWO);
  await tick(SAVE_PAUSE);

  expect(s.updates()).toHaveLength(2);
  expect((s.updates()[0]?.input as { expectedUpdatedAt: string }).expectedUpdatedAt).toBe(
    ENTITY.updatedAt,
  );
  expect((s.updates()[1]?.input as { expectedUpdatedAt: string }).expectedUpdatedAt).toBe(
    SAVED.updatedAt,
  );
  // Страж вакуумности: две строки ДОЛЖНЫ различаться, иначе проверка выше ни о чём.
  expect(SAVED.updatedAt).not.toBe(ENTITY.updatedAt);
});

/** Стенд с управляемыми из теста пропсами хука: и сущность, и её id меняет сам тест. */
function mountWithProps(initial: { id: string; entity: BodySaveEntity }, respond: Respond = ok) {
  const box = { respond };
  const hold: {
    api: BodySave | null;
    set: ((p: { id: string; entity: BodySaveEntity }) => void) | null;
  } = { api: null, set: null };
  function Parent() {
    const [props, setProps] = useState(initial);
    hold.set = setProps;
    const api = useBodySave(props.id, props.entity);
    hold.api = api;
    // Индикатор ОБЯЗАН быть в дереве, и это не украшение стенда: пока `Parent` возвращал null,
    // `queryByText('Не сохранено')` не мог упасть никогда — искать было негде, и половина
    // проверки «отказ прежней записи не гасит соседнюю» не проверяла ничего (ревью, И-5).
    return <SaveIndicator state={api.state} />;
  }
  let sends = 0;
  const { calls, container, unmount } = renderWithProviders(<Parent />, (path, input) => {
    if (path !== 'entity.update') throw new Error(`сохранение тела не ходит на ${path}`);
    sends += 1;
    if (sends > MAX_SENDS) return new Promise(() => {}); // потолок отправок, см. MAX_SENDS
    return box.respond(input);
  });
  return {
    container,
    api: () => hold.api as BodySave,
    updates: () => calls.filter((c) => c.path === 'entity.update'),
    /** Уход с записи (или с экрана): размонтирование обязано дослать отложенное. */
    unmount: () => act(() => unmount()),
    serve: (r: Respond) => {
      box.respond = r;
    },
    set: async (p: { id: string; entity: BodySaveEntity }) => {
      await act(async () => {
        hold.set?.(p);
      });
    },
    flush: async () => {
      await act(async () => {
        (hold.api as BodySave).flush();
      });
    },
  };
}

test('приехавшая из кэша сущность становится новой базой сравнения', async () => {
  // Перечитывание после сохранения приносит в кэш то, что легло в базу, — и это новая база
  // сравнения. Читай хук сущность из замыкания первого рендера, базой навсегда осталось бы
  // тело НА МОМЕНТ ОТКРЫТИЯ, и уже сохранённый текст уезжал бы снова и снова.
  const s = mountWithProps({ id: 'e1', entity: ENTITY }, ok);

  s.api().onDocChange(ONE);
  await tick(SAVE_PAUSE);
  expect(s.updates()).toHaveLength(1);

  await s.set({ id: 'e1', entity: { ownerId: OWNER, updatedAt: SAVED.updatedAt, bodyDoc: ONE } });
  s.api().onDocChange(ONE);
  await tick(SAVE_PAUSE);
  expect(s.updates()).toHaveLength(1); // это уже сохранено — второй раз не шлём

  // Положительный контроль: правка поверх новой базы уезжает.
  s.api().onDocChange(TWO);
  await tick(SAVE_PAUSE);
  expect(s.updates()).toHaveLength(2);
});

/**
 * Чужая правка, приехавшая с сервера: и документ другой, и метка ПОЗЖЕ всех известных клиенту
 * (позже и `ENTITY.updatedAt`, и `SAVED.updatedAt` — иначе «поздняя из двух» выбрала бы верную
 * строку по совпадению, и подмену было бы не отличить от порядка).
 */
const FOREIGN: BodySaveEntity = {
  ownerId: OWNER,
  updatedAt: '2026-08-14T20:00:00.000Z',
  bodyDoc: THREE,
};

test('досыл при уходе несёт метку, на которой правка НАБИРАЛАСЬ, а не свежую из кэша', async () => {
  // Сюжет целиком, все действия штатные: правка с телефона двинула запись; здесь человек
  // печатает, ловит 409, жмёт «Обновить» — перечитывание приносит ЧУЖОЙ документ, и редактор
  // (фокус ушёл на кнопку) сажает его вместо набранного. Хук об этой подмене не узнаёт никогда.
  // Возьми досыл метку из свежего кэша — он ушёл бы как «я видел чужую правку и кладу поверх»,
  // и сервер молча затёр бы её текстом, который человек уже видел исчезнувшим с экрана.
  //
  // §5.2 требует ТУ строку, которую клиент видел, КОГДА ДЕЛАЛ ЭТУ ПРАВКУ. Метка поэтому
  // замирает вместе с отложенным документом, а не берётся в момент отправки.
  const s = mountWithProps({ id: 'e1', entity: ENTITY }, () => {
    throw trpcError('CONFLICT');
  });
  s.api().onDocChange(ONE);
  await tick(SAVE_PAUSE);
  expect(s.updates()).toHaveLength(1);
  expect(s.api().conflict, 'премиса: 409 получен').toBe(true);

  await s.set({ id: 'e1', entity: FOREIGN });
  s.serve(ok);
  await s.unmount();

  expect(s.updates()).toHaveLength(2);
  expect(s.updates()[1]?.input).toEqual({
    id: 'e1',
    bodyDoc: ONE,
    expectedUpdatedAt: ENTITY.updatedAt,
  });
  // Страж вакуумности: метки ДОЛЖНЫ различаться, иначе проверка выше ни о чём.
  expect(FOREIGN.updatedAt).not.toBe(ENTITY.updatedAt);
});

test('правка, набранная ПОСЛЕ прихода чужого документа, уезжает с ЕГО меткой', async () => {
  // Обратная сторона: метка замирает вместе с ОТЛОЖЕННЫМ документом, а не навсегда. Человек,
  // напечатавший поверх приехавшего текста, видел именно его метку — и уходить правка обязана
  // с ней, иначе каждое сохранение после чужой правки ловило бы 409 до самой перезагрузки.
  const s = mountWithProps({ id: 'e1', entity: ENTITY });
  s.api().onDocChange(ONE);
  await tick(SAVE_PAUSE);
  expect(s.updates()).toHaveLength(1);

  await s.set({ id: 'e1', entity: FOREIGN });
  s.api().onDocChange(TWO);
  await tick(SAVE_PAUSE);

  expect(s.updates()).toHaveLength(2);
  expect((s.updates()[1]?.input as { expectedUpdatedAt: string }).expectedUpdatedAt).toBe(
    FOREIGN.updatedAt,
  );
});

/**
 * Та же запись после СВОЕЙ ЖЕ правки заголовка: тело не тронуто, метка выросла.
 *
 * Такие правки (заголовок, чекбокс, архивация, аспекты) идут через ДРУГОЙ экземпляр обвязки
 * обновления, и `confirmedRef` про них не знает ничего: он ведёт счёт только мутациям тела.
 */
const AFTER_TITLE: BodySaveEntity = {
  ownerId: OWNER,
  updatedAt: '2026-08-14T15:00:00.000Z',
  // ДРУГОЙ объект того же смысла, а не `BASE`: из кэша тело всегда приезжает новым объектом,
  // и с общей ссылкой тест остался бы зелёным даже при сравнении по `===` (ре-ревью раунда 2).
  bodyDoc: parseBody('тело'),
};

test('своя же правка заголовка не превращает сохранение тела в 409', async () => {
  // Замораживая метку, легко заморозить её и там, где защищать нечего. Сюжет целиком, все
  // действия свои: человек печатает в теле (метка замерла), не дожидаясь паузы правит заголовок
  // той же записи, сервер двигает метку, перечитывание приносит её в кэш — и пауза истекает.
  // С метки, замороженной наглухо, тело уезжало бы со старой строкой и получало 409 «Изменено в
  // другом месте» на записи, которой не касался НИКТО, кроме самого человека.
  //
  // Правило узкое: метка двигается, только если ТЕЛО не менялось. В сюжете находки 1 тело как
  // раз меняется (там приезжает чужой документ), и там метка остаётся замороженной — это
  // проверяет тест «досыл при уходе несёт метку, на которой правка НАБИРАЛАСЬ».
  const s = mountWithProps({ id: 'e1', entity: ENTITY });
  s.api().onDocChange(ONE);

  await s.set({ id: 'e1', entity: AFTER_TITLE });
  await tick(SAVE_PAUSE);

  expect(s.updates()).toHaveLength(1);
  expect(s.updates()[0]?.input).toEqual({
    id: 'e1',
    bodyDoc: ONE,
    expectedUpdatedAt: AFTER_TITLE.updatedAt,
  });
  // Стражи вакуумности: тело ДЕЙСТВИТЕЛЬНО то же, а метка ДЕЙСТВИТЕЛЬНО другая.
  expect(AFTER_TITLE.bodyDoc).toEqual(ENTITY.bodyDoc);
  expect(AFTER_TITLE.updatedAt).not.toBe(ENTITY.updatedAt);
});

test('своя же правка заголовка поверх ОТКАЗАВШЕЙ правки тела: досыл при уходе не ловит 409', async () => {
  // Окно шире паузы, и потому хуже: отказ сети оставляет отложенный документ на руках до самого
  // успеха. Человек правит заголовок, уходит с записи — и досыл уезжает со старой меткой,
  // получает 409 и не доезжает до сервера ВОВСЕ. Правка остаётся черновиком и предлагается на
  // следующем открытии, где «Отбросить» её уничтожает. До этого раунда обе последовательности
  // сохранялись молча.
  const s = mountWithProps({ id: 'e1', entity: ENTITY }, () => {
    throw trpcError('INTERNAL_SERVER_ERROR');
  });
  s.api().onDocChange(ONE);
  await tick(SAVE_PAUSE);
  expect(s.updates(), 'премиса: первая попытка отказала').toHaveLength(1);

  await s.set({ id: 'e1', entity: AFTER_TITLE });
  s.serve(ok);
  await s.unmount();

  expect(s.updates()).toHaveLength(2);
  expect(s.updates()[1]?.input).toEqual({
    id: 'e1',
    bodyDoc: ONE,
    expectedUpdatedAt: AFTER_TITLE.updatedAt,
  });
});

test('чужая правка замораживает базу НАВСЕГДА — своя правка заголовка её не размораживает', async () => {
  // Сравнение приехавшего тела с ПРЕДЫДУЩИМ снимком кэша задачи не решает: чужая правка, один
  // раз впитавшись в снимок, для проверки перестаёт существовать — и следующая же СВОЯ правка
  // метки размораживает базу. Сравнивать надо с телом на момент ЗАМОРОЗКИ.
  //
  // Сюжет целиком, и на последнем шаге — ни одного нажатия клавиши:
  //  1. печатаю в теле — база заморожена на метке T1, снимок тела запомнен;
  //  2. с телефона правят ту же запись — приезжает ЧУЖОЕ тело с меткой T2;
  //  3. правлю ЗАГОЛОВОК этой же записи — сервер двигает метку до T3, тело остаётся чужим
  //     (правки без тела гейт по версии не сверяет, они проходят всегда);
  //  4. ухожу с записи → досыл со свежей меткой → гейт пропускает → ЧУЖОЙ ТЕКСТ ЗАТЁРТ МОЛЧА.
  const s = mountWithProps({ id: 'e1', entity: ENTITY });
  s.api().onDocChange(ONE);

  await s.set({ id: 'e1', entity: FOREIGN }); // шаг 2: чужое тело, метка 20:00
  await s.set({
    id: 'e1',
    // Шаг 3: метка ушла ещё дальше, а тело — ТО ЖЕ чужое (другим объектом, как из кэша).
    entity: { ownerId: OWNER, updatedAt: '2026-08-14T21:00:00.000Z', bodyDoc: parseBody(THREE_MD) },
  });
  await s.unmount();

  expect(s.updates()).toHaveLength(1);
  expect(s.updates()[0]?.input).toEqual({
    id: 'e1',
    bodyDoc: ONE,
    expectedUpdatedAt: ENTITY.updatedAt,
  });
});

test('собственный успех двигает метку отложенного: досыл не ловит 409 от предшественника', async () => {
  // Замри метка НАВСЕГДА в момент набора — досыл, ушедший после успеха первого запроса, нёс бы
  // строку, которую этот же успех и сдвинул: гарантированный 409 на ровном месте, без единой
  // чужой правки. Правка №2 — потомок только что сохранённой правки №1, и её база — ответ
  // сервера.
  const server = gatedServer();
  const s = mountWithProps({ id: 'e1', entity: ENTITY }, server.respond);
  s.api().onDocChange(ONE);
  await tick(SAVE_PAUSE);
  expect(s.updates()).toHaveLength(1);

  // Вторая правка набрана, ПОКА первая в полёте: её метка на этот момент — ещё ENTITY.updatedAt.
  s.api().onDocChange(TWO);
  await tick(SAVE_PAUSE);
  expect(s.updates(), 'премиса: второй запрос ждёт оседания первого').toHaveLength(1);

  await server.answer(0, SAVED);
  expect(s.updates()).toHaveLength(2);
  expect(s.updates()[1]?.input).toEqual({
    id: 'e1',
    bodyDoc: TWO,
    expectedUpdatedAt: SAVED.updatedAt,
  });
});

test('смена сущности не уносит в чужую запись ни отложенное тело, ни чужой updatedAt', async () => {
  // Самая дорогая из возможных ошибок: `{ id: 'вторая запись', bodyDoc: <тело первой> }` —
  // молча и необратимо. Экран сегодня пересоздаёт секцию тела по key={entity.id}, но верность
  // хука не должна держаться на чужом ключе.
  const s = mountWithProps({ id: 'e1', entity: ENTITY });
  s.api().onDocChange(ONE);
  await tick(SAVE_PAUSE);
  expect(s.updates()).toHaveLength(1); // сервер подтвердил updatedAt=11:00 ПЕРВОЙ записи

  // Вторая правка набрана, но пауза ещё не вышла — она так и остаётся отложенной.
  s.api().onDocChange(TWO);
  await tick(SAVE_PAUSE - 500);

  // У второй записи updatedAt РАНЬШЕ подтверждённого первой — иначе «взять позднюю из двух»
  // выбрало бы верную строку по совпадению, и утечку было бы не отличить от порядка.
  const second: BodySaveEntity = {
    ownerId: OWNER,
    updatedAt: '2026-08-14T10:30:00.000Z',
    bodyDoc: THREE,
  };
  await s.set({ id: 'e2', entity: second });

  // flush() — самый острый случай: таймер при смене id снимается сам, а вот отложенный
  // документ, доживи он до сюда, уехал бы в тело ВТОРОЙ записи по первому же требованию.
  await s.flush();
  await tick(SAVE_PAUSE * 2);
  expect(s.updates()).toHaveLength(1);

  // Положительный контроль: правка ВТОРОЙ записи уезжает — с её собственными id и updatedAt.
  s.api().onDocChange(TWO);
  await tick(SAVE_PAUSE);
  expect(s.updates()).toHaveLength(2);
  expect(s.updates()[1]?.input).toEqual({
    id: 'e2',
    bodyDoc: TWO,
    expectedUpdatedAt: second.updatedAt,
  });
});

/** Вторая запись: её updatedAt РАНЬШЕ всего, что вернёт сервер по первой (см. тесты ниже). */
const SECOND: BodySaveEntity = {
  ownerId: OWNER,
  updatedAt: '2026-08-14T10:30:00.000Z',
  bodyDoc: THREE,
};

test('таймер прежней записи не уносит в неё тело новой', async () => {
  // Самая дорогая ошибка этого хука, и она НЕ про отложенный документ, а про таймер. Доживи
  // таймер первой записи до срабатывания, он разбудил бы ПРЕЖНИЙ `save` — тот замкнул на себе
  // старый `entityId`, а документ и базу читает из рефов, принадлежащих уже ВТОРОЙ записи.
  // Получилось бы `{ id: <первая>, bodyDoc: <тело второй> }`; вдобавок он первой же строкой
  // снимает таймер второй записи, и та не сохранилась бы вовсе.
  //
  // Условие опыта: печатать во ВТОРУЮ запись надо внутри ОСТАТКА паузы первой — иначе старому
  // таймеру нечего уносить, и дефект не проявляется (ровно поэтому мутант выживал два круга).
  const s = mountWithProps({ id: 'e1', entity: ENTITY });
  s.api().onDocChange(ONE);
  await tick(SAVE_PAUSE - 1000); // таймер первой записи сработает через секунду

  await s.set({ id: 'e2', entity: SECOND });
  s.api().onDocChange(TWO); // правка ВТОРОЙ записи; её пауза — своя

  // Момент, в который сработал бы таймер первой записи.
  await tick(1000);
  expect(s.updates()).toEqual([]);

  // Пауза второй записи истекает своим чередом — и уезжает ровно её правка.
  await tick(SAVE_PAUSE - 1000);
  expect(s.updates()).toHaveLength(1);
  expect(s.updates()[0]?.input).toEqual({
    id: 'e2',
    bodyDoc: TWO,
    expectedUpdatedAt: SECOND.updatedAt,
  });
});

test('ответ на запрос прежней записи не ложится в счёт соседней', async () => {
  // Запрос, ушедший ДО смены записи, обязан доехать — он про прежнюю запись. Но его ответ
  // здесь больше не касается ничего: ляг подтверждённый updatedAt ПЕРВОЙ записи в счёт
  // второй, её первое же сохранение получило бы 409 с плашкой «изменено в другом месте» —
  // на записи, которой никто не касался.
  const server = gatedServer();
  const s = mountWithProps({ id: 'e1', entity: ENTITY }, server.respond);
  s.api().onDocChange(ONE);
  await tick(SAVE_PAUSE);
  expect(s.updates()).toHaveLength(1);

  await s.set({ id: 'e2', entity: SECOND });
  // Ответ ПЕРВОЙ записи — с меткой заведомо более поздней, чем у второй: возьми её «поздняя
  // из двух», подмена была бы видна в expectedUpdatedAt ниже.
  await server.answer(0, { id: 'e1', updatedAt: '2026-08-14T23:00:00.000Z' });

  s.api().onDocChange(TWO);
  await tick(SAVE_PAUSE);
  expect(s.updates()).toHaveLength(2);
  expect(s.updates()[1]?.input).toEqual({
    id: 'e2',
    bodyDoc: TWO,
    expectedUpdatedAt: SECOND.updatedAt,
  });
});

test('соседняя запись сохраняется, пока запрос прежней ещё в полёте', async () => {
  const server = gatedServer();
  const s = mountWithProps({ id: 'e1', entity: ENTITY }, server.respond);
  s.api().onDocChange(ONE);
  await tick(SAVE_PAUSE);
  expect(s.updates()).toHaveLength(1);

  await s.set({ id: 'e2', entity: SECOND });
  // «Занято» — это про ПРЕЖНЮЮ запись, и её ответ сюда уже не придёт. Переживи признак полёта
  // смену записи, вторая ждала бы освобождения вечно и не сохранилась бы ни разу.
  s.api().onDocChange(TWO);
  await tick(SAVE_PAUSE);
  expect(s.updates()).toHaveLength(2);
  expect((s.updates()[1]?.input as { id: string }).id).toBe('e2');
});

test('отказ по прежней записи не гасит и не останавливает соседнюю', async () => {
  // Второго сохранения здесь НЕТ намеренно, и это условие опыта: начни оно, query-core снял бы
  // наблюдателя с первой мутации, и её колбэки не выполнились бы вовсе — отсечка по поколению
  // осталась бы непроверенной, а тест зелёным (проверено мутацией). Колбэки прежней записи
  // доживают до исполнения ровно тогда, когда после смены записи никто ещё не сохранял.
  const server = gatedServer();
  const s = mountWithProps({ id: 'e1', entity: ENTITY }, server.respond);
  s.api().onDocChange(ONE);
  await tick(SAVE_PAUSE);
  expect(s.updates()).toHaveLength(1);

  await s.set({ id: 'e2', entity: SECOND });
  // Терминальный отказ ПЕРВОЙ записи: он не зажигает на второй ни строчки. Проверка по пустоте
  // контейнера, а не по конкретному тексту: у отказов их теперь два (сетевой и терминальный), и
  // сверка с одним оставила бы второй непроверенным.
  await server.answer(0, trpcError('BAD_REQUEST'), 'fail');
  expect(s.container).toBeEmptyDOMElement();

  // ...и не выключает ей сохранение до перезагрузки. Документ — ЛЮБОЙ, кроме тела второй
  // записи (им её база и является): иначе отправки не было бы по совсем другой причине.
  s.api().onDocChange(ONE);
  await tick(SAVE_PAUSE);
  expect(s.updates()).toHaveLength(2);
  expect((s.updates()[1]?.input as { id: string }).id).toBe('e2');
});

test('409 по прежней записи не поднимает conflict на соседней', async () => {
  // Тот самый третий исход, ради которого заводилось поколение, — и единственный, до которого
  // поколение не дотягивается: `conflict` живёт в общей обвязке, а её колбэки — уровня МУТАЦИИ.
  // Они исполняются всегда, даже когда наблюдателя отцепили, и о поколении ничего не знают.
  const server = gatedServer();
  const s = mountWithProps({ id: 'e1', entity: ENTITY }, server.respond);
  s.api().onDocChange(ONE);
  await tick(SAVE_PAUSE);
  expect(s.updates()).toHaveLength(1);

  await s.set({ id: 'e2', entity: SECOND });
  await server.answer(0, trpcError('CONFLICT'), 'fail');
  expect(s.api().conflict).toBe(false);
  expect(s.container).toBeEmptyDOMElement(); // и «Не сохранено» не зажглось (И-5)

  // Положительный контроль: 409 по СВОЕЙ записи флаг поднимает — сверка по id не выключила
  // проверку вовсе.
  s.api().onDocChange(TWO);
  await tick(SAVE_PAUSE);
  expect(s.updates()).toHaveLength(2);
  await server.answer(1, trpcError('CONFLICT'), 'fail');
  expect(s.api().conflict).toBe(true);
});

test('успех по прежней записи не гасит conflict соседней', async () => {
  // Обратная сторона той же сверки. Запрос ПЕРВОЙ записи держим неотвеченным до самого конца:
  // ответить на него раньше нельзя — промис оседает один раз, и второй ответ был бы пустым
  // действием, от которого тест зеленел бы при любой реализации (проверено мутацией).
  const server = gatedServer();
  const s = mountWithProps({ id: 'e1', entity: ENTITY }, server.respond);
  s.api().onDocChange(ONE);
  await tick(SAVE_PAUSE);
  expect(s.updates()).toHaveLength(1); // запрос первой записи в полёте

  await s.set({ id: 'e2', entity: SECOND });
  s.api().onDocChange(TWO);
  await tick(SAVE_PAUSE);
  expect(s.updates()).toHaveLength(2);

  // Своя, ВТОРАЯ запись поймала 409 — плашка «Изменено в другом месте» заслужена.
  await server.answer(1, trpcError('CONFLICT'), 'fail');
  expect(s.api().conflict).toBe(true);

  // А теперь доезжает успех по ПЕРВОЙ записи. Он не про этот конфликт и гасить его не вправе:
  // иначе плашка исчезла бы с экрана сама, а расхождение осталось бы.
  await server.answer(0, SAVED);
  expect(s.api().conflict).toBe(true);
});

test('conflict гаснет при смене записи, а не переезжает на соседнюю', async () => {
  const s = mountWithProps({ id: 'e1', entity: ENTITY }, () => {
    throw trpcError('CONFLICT');
  });
  s.api().onDocChange(ONE);
  await tick(SAVE_PAUSE);
  expect(s.api().conflict).toBe(true); // премиса: на первой записи конфликт есть

  await s.set({ id: 'e2', entity: SECOND });
  expect(s.api().conflict).toBe(false);
});

test('откат отказавшей мутации ложится в кэш ПРЕЖНЕЙ записи, а не соседней', async () => {
  // Откат живёт в общей обвязке (useEntityUpdate) и берёт ключ из замыкания последнего
  // рендера. Смени экран сущность, пока запрос в полёте, — и данные первой записи легли бы
  // под ключ второй: на экране оказалась бы ЧУЖАЯ заметка.
  //
  // В кэше нужны ОБЕ записи, и это не декорация: снимок берётся у первой, и будь её кэш пуст,
  // откат под любым ключом оказался бы записью `undefined`, которую setQueryData пропускает, —
  // подмена ключа была бы неотличима от верного поведения (проверено мутацией).
  const server = gatedServer();
  type CachedEntity = { entity: { title: string; bodyDoc: unknown } } | undefined;
  const read: { get: (id: string) => CachedEntity } = { get: () => undefined };
  const title = (id: string) => read.get(id)?.entity.title;
  const hold: {
    api: BodySave | null;
    set: ((p: { id: string; entity: BodySaveEntity }) => void) | null;
  } = { api: null, set: null };
  function Tree() {
    const utils = trpc.useUtils();
    trpc.entity.get.useQuery(detailGetInput('e1'));
    trpc.entity.get.useQuery(detailGetInput('e2'));
    read.get = (id: string) => utils.entity.get.getData(detailGetInput(id)) as CachedEntity;
    const [props, setProps] = useState({ id: 'e1', entity: ENTITY });
    hold.set = setProps;
    hold.api = useBodySave(props.id, props.entity);
    return null;
  }
  const entities: Record<string, unknown> = {
    e1: { id: 'e1', title: 'ПЕРВАЯ запись', body: 'тело', bodyDoc: BASE },
    e2: { id: 'e2', title: 'ВТОРАЯ запись', body: 'её тело', bodyDoc: THREE },
  };
  // Первые два чтения (начальная загрузка обеих записей) отвечают, дальнейшие ЗАВИСАЮТ.
  // Иначе увидеть промах ключа нечем: onSettled зовёт invalidateGraph, перечитывание
  // приносит из мока верные данные и залечивает подмену ДО ассерта — мутация выживала ровно
  // поэтому. В проде лечение то же самое, но оно стоит круга сети, и на экране успевает
  // мелькнуть чужая заметка; не доедь перечитывание (офлайн) — она бы и осталась.
  let reads = 0;
  renderWithProviders(<Tree />, (path, input) => {
    if (path === 'entity.get') {
      reads += 1;
      if (reads > 2) return new Promise(() => {});
      return { entity: entities[(input as { id: string }).id] };
    }
    if (path === 'entity.update') return server.respond(null);
    throw new Error(`сохранение тела не ходит на ${path}`);
  });
  await tick();
  expect(title('e1')).toBe('ПЕРВАЯ запись'); // премиса: снимку есть что откатывать
  expect(title('e2')).toBe('ВТОРАЯ запись');

  hold.api?.onDocChange(ONE);
  await tick(SAVE_PAUSE);
  await act(async () => {
    hold.set?.({ id: 'e2', entity: SECOND });
  });
  // Сохранение СОСЕДНЕЙ записи, пока запрос первой ещё в полёте. Оно здесь не для красоты:
  // «последняя ли это мутация» обвязка считает ПО ЗАПИСИ, а не одним счётчиком на хук
  // (ревью Задачи 14, И-1). Веди она общий счёт — мутация второй записи объявила бы мутацию
  // первой устаревшей, и та лишилась бы отката: оптимистичный документ отказавшего запроса
  // остался бы висеть в кэше первой записи.
  hold.api?.onDocChange(TWO);
  await tick(SAVE_PAUSE);
  await server.answer(0, trpcError('INTERNAL_SERVER_ERROR'), 'fail');

  // Кэш второй записи цел: откат ушёл туда, откуда снимок и был взят.
  expect(title('e2')).toBe('ВТОРАЯ запись');
  // И первая откачена по-настоящему: оптимистичный документ снят, а не остался висеть.
  expect(read.get('e1')?.entity.bodyDoc).toEqual(BASE);
});

test('терминальная остановка не переносится на соседнюю запись', async () => {
  // Битый документ — свойство ЭТОЙ записи. Переживи остановка смену сущности, соседняя запись
  // молча перестала бы сохраняться вовсе, и починить это можно было бы только перезагрузкой.
  const s = mountWithProps({ id: 'e1', entity: ENTITY }, () => {
    throw trpcError('BAD_REQUEST', 'документ не соответствует схеме — правка отклонена');
  });
  s.api().onDocChange(ONE);
  await tick(SAVE_PAUSE);
  expect(s.updates()).toHaveLength(1);
  s.api().onDocChange(TWO);
  await tick(SAVE_PAUSE);
  expect(s.updates()).toHaveLength(1); // премиса: на первой записи сохранение остановлено

  s.serve(ok);
  await s.set({
    id: 'e2',
    entity: { ownerId: OWNER, updatedAt: '2026-08-14T10:30:00.000Z', bodyDoc: THREE },
  });
  s.api().onDocChange(TWO);
  await tick(SAVE_PAUSE);
  expect(s.updates()).toHaveLength(2);
  expect((s.updates()[1]?.input as { id: string }).id).toBe('e2');
});

test('оптимистичный патч кладёт документ в кэш и НЕ трогает markdown', async () => {
  // Страж премисы: чтение detail просит документ явным include (Р6 — без него ключа `bodyDoc`
  // в ответе нет вовсе), иначе редактору его брать неоткуда, а этому тесту — нечего сверять.
  expect(detailGetInput('e1').include).toContain('bodyDoc');

  // Читаем КЭШ, а не отрисованное: патч кладут именно туда, и под поддельными таймерами
  // уведомление наблюдателя запроса до рендера доезжает не всегда — проверка через разметку
  // краснела бы от этого, а не от патча.
  type Cached = { entity: { body: string | null; bodyDoc?: unknown } } | undefined;
  const read: { get: () => Cached } = { get: () => undefined };
  function CacheProbe() {
    // Запрос нужен по-настоящему: setData поверх ПУСТОГО кэша не пишет ничего (обновлятель
    // получает undefined и его же возвращает), и тест «патч применился» прошёл бы вхолостую.
    trpc.entity.get.useQuery(detailGetInput('e1'));
    const utils = trpc.useUtils();
    read.get = () => utils.entity.get.getData(detailGetInput('e1')) as Cached;
    return null;
  }
  const hold: { api: BodySave | null } = { api: null };
  function SaveProbe() {
    hold.api = useBodySave('e1', ENTITY);
    return null;
  }

  const server = {
    id: 'e1',
    ownerId: 'u',
    title: 'Запись',
    emoji: null,
    body: 'тело',
    bodyDoc: BASE,
    bodyRefs: [],
    tags: [],
    meta: {},
    aspects: {},
    createdAt: '2026-08-14T09:00:00.000Z',
    updatedAt: ENTITY.updatedAt,
    archived: false,
  };
  renderWithProviders(
    <>
      <CacheProbe />
      <SaveProbe />
    </>,
    (path) => {
      if (path === 'entity.get') return { entity: server, relations: [], backlinks: [] };
      // Ответа на сохранение не будет НИКОГДА: нас интересует ровно то, что клиент показывает
      // до него. Дай мы ответ — инвалидация перечитала бы detail, и в кэше оказался бы уже
      // серверный документ, а проверка «что положил патч» стала бы проверкой мока.
      if (path === 'entity.update') return new Promise(() => {});
      throw new Error(`сохранение тела не ходит на ${path}`);
    },
  );
  await tick();
  expect(read.get()?.entity.bodyDoc).toEqual(BASE); // премиса: до правки в кэше документ сервера

  (hold.api as BodySave).onDocChange(ONE);
  await tick(SAVE_PAUSE);

  expect(read.get()?.entity.bodyDoc).toEqual(ONE);
  // ГЛАВНОЕ: `body` остался прежним. Markdown-проекцию делает сервер, и только он — клиентский
  // сериализатор затащил бы всю схему документа в чанк detail, а две реализации проекции ещё
  // и разошлись бы. До ответа сервера просмотр показывает прежний текст, и это осознанно.
  expect(read.get()?.entity.body).toBe('тело');
});

// --- отказы -----------------------------------------------------------------------------------

test('отказ показывает «Не сохранено» и держит до успеха', async () => {
  const server = gatedServer();
  const s = setup({ respond: server.respond });
  s.api().onDocChange(ONE);
  await tick(SAVE_PAUSE);
  await server.answer(0, trpcError('INTERNAL_SERVER_ERROR'), 'fail');

  expect(s.updates()).toHaveLength(1);
  expect(screen.getByText('Не сохранено')).toBeInTheDocument();

  // Само не проходит и сеть не долбит: без новой правки повторов нет.
  await tick(30_000);
  expect(s.updates()).toHaveLength(1);
  expect(screen.getByText('Не сохранено')).toBeInTheDocument();

  // Новая правка — новая попытка (отказ сети НЕ терминален, в отличие от VALIDATION ниже).
  // Ответа на неё ПОКА НЕТ: «держит до успеха» значит именно до успеха, а не до следующей
  // попытки — иначе плашка гасла бы на время каждого повтора и зажигалась снова, то есть
  // мигала бы вместо ответа на вопрос «сохранено ли».
  s.api().onDocChange(TWO);
  await tick(SAVE_PAUSE);
  expect(s.updates()).toHaveLength(2);
  expect(screen.getByText('Не сохранено')).toBeInTheDocument();
  await tick(SLOW_SAVE_MS * 2); // и «Сохраняем…» её не перебивает даже за порогом выдержки
  expect(screen.getByText('Не сохранено')).toBeInTheDocument();

  // Второй отказ подряд плашку тоже не гасит.
  await server.answer(1, trpcError('INTERNAL_SERVER_ERROR'), 'fail');
  expect(screen.getByText('Не сохранено')).toBeInTheDocument();

  // Успех — и только он — гасит плашку.
  s.api().onDocChange(THREE);
  await tick(SAVE_PAUSE);
  expect(s.updates()).toHaveLength(3);
  await server.answer(2, SAVED);
  expect(s.container).toBeEmptyDOMElement();
});

test('«Не сохранено» гаснет, когда правку вернули к сохранённому', async () => {
  // После отказа человек может просто отменить набранное. Сохранять тогда нечего — сравнение
  // выходит по равенству документов, — и успешной мутации, которая одна и гасила плашку,
  // уже неоткуда взяться: без этой ветки «Не сохранено» висело бы вечно над текстом, который
  // ровно совпадает с базой.
  const server = gatedServer();
  const s = setup({ respond: server.respond });
  s.api().onDocChange(ONE);
  await tick(SAVE_PAUSE);
  await server.answer(0, trpcError('INTERNAL_SERVER_ERROR'), 'fail');
  expect(screen.getByText('Не сохранено')).toBeInTheDocument();

  s.api().onDocChange(parseBody('тело')); // тот же текст, что в базе
  await tick(SAVE_PAUSE);
  expect(s.updates()).toHaveLength(1); // в сеть не ходили: сохранять нечего
  expect(s.container).toBeEmptyDOMElement();
});

test('409 поднимает conflict и НЕ подменяет документ', async () => {
  const s = setup({
    respond: () => {
      throw trpcError('CONFLICT');
    },
  });
  s.api().onDocChange(ONE);
  await tick(SAVE_PAUSE);

  expect(s.updates()).toHaveLength(1);
  expect(s.api().conflict).toBe(true);
  expect(screen.getByText('Не сохранено')).toBeInTheDocument();
  // Автоповтора нет: круг «409 → повтор → 409» ушёл бы в сеть бесконечно.
  await tick(30_000);
  expect(s.updates()).toHaveLength(1);

  // ГЛАВНОЕ: правка, которую человек набирает прямо сейчас, никуда не делась — следующая
  // отправка несёт ЕГО документ, а не тот, что лежал до правки, и не серверный.
  await act(async () => {
    s.api().flush();
  });
  expect(s.updates()).toHaveLength(2);
  expect((s.updates()[1]?.input as { bodyDoc: BodyDoc }).bodyDoc).toEqual(ONE);
  expect((s.updates()[1]?.input as { bodyDoc: BodyDoc }).bodyDoc).not.toEqual(BASE);

  // Положительный контроль: конфликт снимается успехом, а не живёт до перезагрузки.
  s.serve(ok);
  s.api().onDocChange(TWO);
  await tick(SAVE_PAUSE);
  expect(s.updates()).toHaveLength(3);
  expect(s.api().conflict).toBe(false);
  expect(s.container).toBeEmptyDOMElement();
});

test('VALIDATION терминален: после него ни одна правка не уходит в сеть', async () => {
  // Серверный гейт отвечает VALIDATION (→ BAD_REQUEST) на структурно битый документ и на
  // документ чужой версии схемы. Повторять такую мутацию бессмысленно: тот же документ
  // отвергнут будет снова, а средства спасения у сообщения для человека нет. Без остановки
  // каждое нажатие клавиши уходило бы в сеть обречённым запросом.
  const s = setup({
    respond: () => {
      throw trpcError('BAD_REQUEST', 'документ не соответствует схеме — правка отклонена');
    },
  });
  s.api().onDocChange(ONE);
  await tick(SAVE_PAUSE);
  expect(s.updates()).toHaveLength(1);
  // И говорит индикатор именно про ЭТОТ отказ: «Не сохранено» здесь было бы полуправдой —
  // у сетевого отказа следующее нажатие клавиши заводит новую попытку, у терминального
  // повтора не будет НИКОГДА (см. отдельный тест ниже).
  expect(screen.getByText(TERMINAL_TEXT)).toBeInTheDocument();

  s.api().onDocChange(TWO);
  await tick(SAVE_PAUSE);
  expect(s.updates()).toHaveLength(1);

  await act(async () => {
    s.api().flush();
  });
  expect(s.updates()).toHaveLength(1);
  expect(screen.getByText(TERMINAL_TEXT)).toBeInTheDocument();

  // Положительный контроль: молчание выше — от терминальности, а не от развалившегося
  // стенда. СВЕЖИЙ хук на том же (по-прежнему отказывающем) сервере отправку делает.
  const other = setup({
    respond: () => {
      throw trpcError('BAD_REQUEST');
    },
  });
  other.api().onDocChange(ONE);
  await tick(SAVE_PAUSE);
  expect(other.updates()).toHaveLength(1);
});

test('возврат к сохранённому после терминального отказа СНОВА включает сохранение', async () => {
  // Естественная реакция на «правка отклонена» — Ctrl+Z до исходного текста. Ветка «правку
  // вернули к сохранённому» гасит индикатор, и если она не снимает саму остановку, человеку
  // сказана неправда дважды: экран молчит (значит «сохранено»), а запись при этом молча не
  // сохраняется до перезагрузки — ни одного запроса за всю сессию.
  const s = setup({
    respond: () => {
      throw trpcError('BAD_REQUEST', 'документ не соответствует схеме — правка отклонена');
    },
  });
  s.api().onDocChange(ONE);
  await tick(SAVE_PAUSE);
  expect(s.updates()).toHaveLength(1);
  expect(screen.getByText(TERMINAL_TEXT), 'премиса: остановка сработала').toBeInTheDocument();

  s.api().onDocChange(parseBody('тело')); // тот же текст, что в базе
  await tick(SAVE_PAUSE);
  expect(s.updates(), 'возврат к базе в сеть не ходит').toHaveLength(1);
  expect(s.container).toBeEmptyDOMElement();

  // ГЛАВНОЕ: следующая правка снова уезжает. Сервер к этому моменту исправен — чужая версия
  // схемы лечится обновлением приложения, а сама остановка была про ОТВЕРГНУТЫЙ документ.
  s.serve(ok);
  s.api().onDocChange(TWO);
  await tick(SAVE_PAUSE);
  expect(s.updates()).toHaveLength(2);
  expect((s.updates()[1]?.input as { bodyDoc: BodyDoc }).bodyDoc).toEqual(TWO);
});

// --- индикатор --------------------------------------------------------------------------------

test('индикатор отличает терминальный отказ от сетевого', async () => {
  // Для сетевого «Не сохранено» — правда: следующее нажатие клавиши заводит новую попытку.
  // Для терминального это обещание, которого никто не собирается выполнять: повтора не будет
  // никогда, и человеку надо сказать, ЧТО делать (обновить страницу), а не ждать у моря погоды.
  const s = setup({
    respond: () => {
      throw trpcError('INTERNAL_SERVER_ERROR');
    },
  });
  s.api().onDocChange(ONE);
  await tick(SAVE_PAUSE);
  expect(screen.getByText('Не сохранено')).toBeInTheDocument();
  expect(screen.queryByText(TERMINAL_TEXT)).toBeNull();

  // Тот же хук, следующая правка — но отказ уже терминальный: строка обязана смениться.
  s.serve(() => {
    throw trpcError('BAD_REQUEST', 'документ не соответствует схеме — правка отклонена');
  });
  s.api().onDocChange(TWO);
  await tick(SAVE_PAUSE);
  expect(s.updates()).toHaveLength(2);
  expect(screen.getByText(TERMINAL_TEXT)).toBeInTheDocument();
  expect(screen.queryByText('Не сохранено')).toBeNull();
});

test('успех не празднуем: в покое индикатора нет вовсе', () => {
  const { container } = renderWithProviders(<SaveIndicator state="idle" />, (path) => {
    throw new Error(`индикатор ничего не спрашивает, а спросил ${path}`);
  });
  // Постоянный статус в углу — ровно та панель инструментов над каждой заметкой, от которой
  // экран отказывается сознательно; молчание и означает «всё сохранено».
  expect(container).toBeEmptyDOMElement();
});

test('«Сохраняем…» показывается только если запрос идёт дольше секунды', async () => {
  // Состояние меняет РОДИТЕЛЬ, а не rerender(): renderWithProviders рисует переданное дерево
  // внутри провайдеров, и rerender(<SaveIndicator …/>) подменил бы корень целиком — React
  // размонтировал бы индикатор и смонтировал заново, обнулив его выдержку. Тест «выдержка
  // отмеряется каждому сохранению» тогда проходил бы у ЛЮБОЙ реализации (проверено мутацией).
  const hold: { set: ((s: BodySaveState) => void) | null } = { set: null };
  function Parent() {
    const [state, setState] = useState<BodySaveState>('saving');
    hold.set = setState;
    return <SaveIndicator state={state} />;
  }
  const setState = async (s: BodySaveState) => {
    await act(async () => {
      hold.set?.(s);
    });
  };

  const { container } = renderWithProviders(<Parent />, (path) => {
    throw new Error(`индикатор ничего не спрашивает, а спросил ${path}`);
  });
  await tick(SLOW_THRESHOLD - 1);
  expect(container).toBeEmptyDOMElement();

  await tick(1);
  expect(screen.getByText('Сохраняем…')).toBeInTheDocument();

  // Быстрое сохранение не мигает: вернулись в покой — надпись ушла и больше не всплывает.
  await setState('idle');
  expect(container).toBeEmptyDOMElement();
  await tick(5000);
  expect(container).toBeEmptyDOMElement();

  // Выдержка отмеряется КАЖДОМУ сохранению заново. Останься она взведённой с прошлого раза —
  // второе сохранение показывало бы «Сохраняем…» мгновенно, то есть на каждой второй паузе
  // в наборе всплывала бы надпись, которой этот порог и не должен пускать на экран.
  await setState('saving');
  expect(container).toBeEmptyDOMElement();
  await tick(SLOW_THRESHOLD - 1);
  expect(container).toBeEmptyDOMElement();
  await tick(1);
  expect(screen.getByText('Сохраняем…')).toBeInTheDocument();
});

test('отказ показывается сразу, без секундной выдержки', async () => {
  const { container } = renderWithProviders(<SaveIndicator state="error" />, (path) => {
    throw new Error(`индикатор ничего не спрашивает, а спросил ${path}`);
  });
  expect(screen.getByText('Не сохранено')).toBeInTheDocument();
  // Роль — status, а не alert: строка живёт в углу и меняется вместе с состоянием, а не
  // прерывает чтение.
  expect(screen.getByRole('status')).toHaveTextContent('Не сохранено');
  await tick(5000);
  expect(container).not.toBeEmptyDOMElement();
});

// --- страж чанка detail -------------------------------------------------------------------------

/**
 * Токен исходника: строковый литерал ЛИБО комментарий. Порядок ветвей — половина смысла:
 * литералы разбираются ПЕРВЫМИ, поэтому `//` внутри `'https://…'` комментарием не считается.
 */
const STRING_OR_COMMENT =
  /'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`|\/\/[^\n]*|\/\*[\s\S]*?\*\//g;

/**
 * Комментарии — пробелами той же длины, переводы строк на месте.
 *
 * Не вырезать: `^` в разборе импортов якорит начало СТРОКИ, и схлопывание многострочного
 * комментария сдвинуло бы к нему соседний оператор. Гасить, а не резать, дешевле, чем потом
 * гадать, почему импорт «пропал» после невинной правки комментария.
 *
 * Голый `replace(/\/\/[^\n]*$/gm, '')` тут не годится, и это ЗАМЕРЕНО, а не предположено:
 * на строке `import { A } from 'https://example.com/x';` он режет путь по `//` и оставляет
 * `import { A } from 'https:` — импорт становится невидим. Разбор через STRING_OR_COMMENT
 * такой строки не трогает.
 */
function blankComments(src: string): string {
  return src.replace(STRING_OR_COMMENT, (m) => (m[0] === '/' ? m.replace(/[^\n]/g, ' ') : m));
}

/**
 * Спецификаторы РАНТАЙМ-импортов исходника. `import type` отброшен: он стирается компилятором и
 * веса в чанк не приносит. Форма `import { type X } from '…'` рантайм-импортом ОСТАЁТСЯ —
 * сборщик снимает спецификатор, но сам импорт с его побочными эффектами держит. Импорт ради
 * побочного эффекта (`import '…'`, без `from`) — тоже рантайм-импорт и тоже вес.
 *
 * Правило одно: после ключевого слова `import` спецификатор — ПЕРВЫЙ строковый литерал.
 * Больше строк в операторе импорта и не бывает, поэтому искать `from` не нужно вовсе, а
 * `[^'"]` не даёт совпадению перескочить в соседний оператор — его спецификатор был бы уже
 * ВТОРЫМ литералом. Отсюда сразу три свойства, которых не было у прежних редакций: хвостовой
 * комментарий безразличен, точка с запятой не нужна, многострочный список спецификаторов
 * разбирается целиком.
 *
 * История долга (замерено прогонами, а не выведено):
 *  - редакция с якорем `';` в конце строки не видела `import … from '…'; // комментарий`
 *    и ПОГЛОЩАЛА следующий импорт, дотягиваясь ленивым `[\s\S]*?` до его `from '…';`;
 *  - редакция с границей по `;` (`[^;]*?`) закрыла тот случай, но завела свой: точка с
 *    запятой ВНУТРИ хвостового комментария многострочного импорта обрывала совпадение, и
 *    тяжёлый импорт снова становился невидим — то есть страж стал слепее прежнего. Она же
 *    поглощала соседа у оператора без завершающей `;` (`import '…'` + следующая строка):
 *    «невозможно по построению» это не было, держалось лишь на том, что точку с запятой
 *    ставит форматтер.
 *
 * Лукахед `(?!\s*[.(])` отсекает всё, что начинается со слова `import`, но оператором импорта
 * НЕ является. Таких форм две, и обе дают ЛОЖНЫЙ ПЛЮС — то есть красного стража там, где
 * ничего не нарушено:
 *  - `import('…')` — ленивая загрузка, ровно то, что страж защищает. `DetailScreen.tsx` грузит
 *    так `MarkdownToggle`, и без лукахеда от красноты его спасал бы только отступ в две
 *    колонки, то есть перенос строки форматтером;
 *  - `import.meta…` С КОЛОНКИ 1: после `import` стоит точка, `\b` выполняется, `^import\b`
 *    совпадает — а класс «не кавычка» идёт через переводы строк, и за спецификатор бралась бы
 *    ПЕРВАЯ строка-литерал файла. Замерено: `import.meta.env.DEV;` + `const p = './BodyEditor';`
 *    давало `['./BodyEditor']` — тяжёлым признавалась строка, к импортам не относящаяся вовсе.
 *
 * Обе формы отсекались бы и отступом, но держаться на отступе нельзя: он свойство форматтера,
 * а не разбора. Ложный плюс закрыт именно поэтому, хотя ни одна из двух форм сегодня не
 * встречается с колонки 1 ни в одном из семи охраняемых файлов. Страж, кричащий на исправном
 * коде, кончается снятием стража — а это дороже, чем дыра, о которой знают.
 *
 * Известные границы разбора (обе ЗАМЕРЕНЫ, обе оставлены сознательно):
 *  - `export { X } from './y'` не виден вовсе — ни этой редакции, ни прежним. Реэкспорт
 *    тяжёлого модуля из эагерного файла прошёл бы мимо стража МОЛЧА. Долг старше задачи;
 *    закрывать его — расширять предикат на `export`, а заодно решать, что делать с
 *    `export type`, поэтому отдельным решением, а не походя;
 *  - строка-имя модуля берётся в одинарных, двойных кавычках или бэктиках, но апостроф
 *    внутри самого пути (в JS он потребовал бы экранирования) разбор не поддерживает.
 */
function parseRuntimeImports(src: string): string[] {
  const code = blankComments(src);
  return [
    ...code.matchAll(/^import\b(?!\s+type\b)(?!\s*[.(])[^'"`]*?(['"`])([^'"`]*)\1/gm),
  ].flatMap((m) => (m[2] === undefined ? [] : [m[2]]));
}

/**
 * Исходник соседнего модуля — ТОЛЬКО через параметр, никогда не литералом на месте.
 *
 * Vite разбирает `new URL('./строка-литерал', import.meta.url)` статически и подменяет его
 * адресом ассета: `http://localhost:3000/src/…`, на котором readFileSync падает «The URL must
 * be of scheme file». С переменной такого разбора нет, и адрес остаётся `file://`. Замерено
 * прогоном, а не выведено, — и записано здесь потому, что следующий, кто впишет литерал прямо
 * в тест, получит падение, никак не связанное с тем, что он проверяет.
 */
function readModule(file: string): string {
  return readFileSync(new URL(file, import.meta.url), 'utf8');
}

function runtimeImports(file: string): string[] {
  return parseRuntimeImports(readModule(file));
}

/**
 * Что уводит схему документа (154.5 кБ gzip) в первый кадр, если притащить это рантайм-импортом.
 *
 * Пути записаны с `(^|\/)`, а не с `^\.\/`: один и тот же тяжёлый модуль соседи пишут по-разному
 * (`./BodyEditor` из EditorShell, `../entity-editor/MarkdownToggle` из DetailScreen), и якорь на
 * «точка-слэш» пропустил бы ровно тот файл, ради которого страж и расширен.
 *
 * Якорь `$` у `@orbis/shared/doc` — ТОЖЕ договор, а не описка. Сабпат `@orbis/shared/doc/diff`
 * (Ш1.1) ЛИСТОВОЙ: он объявлен только с `import type` и стоит +0.85 кБ gzip против +156 кБ у
 * барреля — замерено разведкой на четырёх сборках. Снятие `$` «для полноты» покрасило бы слой
 * предложения на исправном коде, а страж, кричащий на исправном, кончается снятием стража.
 */
const EDITOR_WEIGHT =
  /^@tiptap\/|^@orbis\/shared\/doc$|(^|\/)extensions$|(^|\/)(BodyEditor|MarkdownToggle)$/;

test('модули первого кадра не тянут схему редактора в чанк detail', () => {
  // Все перечисленные модули достижимы ЭАГЕРНО из чанка detail, а тот открывается задолго до
  // того, как понадобится редактор. Рантайм-импорт схемы из любого из них схлопнул бы
  // двухфазное монтирование молча: ни один тест поведения этого не заметит, а
  // check-lazy-chunks сверяет НАЛИЧИЕ чанков, а не их состав — при статическом импорте
  // конверсии в DetailScreen чанк тумблера останется на месте, а схема тихо переедет в чанк
  // detail (ревью раунда 1, Minor 1).
  //
  // Проверка НЕтранзитивная — ровно девять файлов, за которые эта задача отвечает. Появись у
  // них новый общий сосед со схемой внутри, страж промолчит; охватить весь граф импортов
  // тут нечем, и обещать это было бы неправдой. Транзитивную половину закрывает третья
  // проверка в scripts/check-lazy-chunks.ts (состав чанка `DetailScreen` по dist) — но она
  // требует СБОРКИ, а этот список работает на каждом прогоне тестов.
  //
  // `SaveIndicator.tsx` и `body-box.ts` в списке НЕ для полноты: оба достижимы эагерно
  // (индикатор рисует DetailScreen, коробку — EditorShell), и значимый импорт схемы в любом из
  // них утащил бы её в первый кадр МОЛЧА — check-lazy-chunks сверяет наличие чанков, а не их
  // состав, то есть промолчали бы оба стража разом (ревью раунда 3).
  //
  // `ProposalOverlay.tsx` (Ш1.3) — девятый: слой предложения эагерно импортирует DetailScreen,
  // а сам зовёт `EditorShell` и `@orbis/shared/doc/diff`. Один символ разницы («/diff» → голый
  // баррель) стоит там +156 кБ gzip в чанке записи, и оба прежних стража этого не видят.
  for (const file of [
    './useBodySave.ts',
    './strip-ids.ts',
    './draft-storage.ts',
    './SaveIndicator.tsx',
    './body-box.ts',
    './EditorShell.tsx',
    '../entity-detail/useEntityDetail.ts',
    '../entity-detail/DetailScreen.tsx',
    '../entity-detail/ProposalOverlay.tsx',
  ]) {
    expect(
      runtimeImports(file).filter((s) => EDITOR_WEIGHT.test(s)),
      file,
    ).toEqual([]);
  }

  // Положительный контроль: тот же предикат на РЕДАКТОРЕ обязан сработать — иначе пустые
  // списки выше означали бы лишь сломанный разбор импортов.
  const heavy = runtimeImports('./BodyEditor.tsx').filter((s) => EDITOR_WEIGHT.test(s));
  expect(heavy).toContain('@orbis/shared/doc');
  expect(heavy).toContain('./extensions');

  // Второй положительный контроль — на САМИ спеллинги, ради которых предикат и переписан:
  // «через каталог» и «через точку». Ошибись якорь — списки эагерных файлов выше остались бы
  // пустыми при живом статическом импорте тумблера, то есть страж молчал бы ровно там, где
  // его расширяли.
  expect(EDITOR_WEIGHT.test('../entity-editor/MarkdownToggle')).toBe(true);
  expect(EDITOR_WEIGHT.test('../entity-editor/BodyEditor')).toBe(true);
  expect(EDITOR_WEIGHT.test('./MarkdownToggle')).toBe(true);
  // …и на невинного соседа предикат НЕ срабатывает: иначе он краснел бы на чём угодно.
  expect(EDITOR_WEIGHT.test('./body-box')).toBe(false);
  expect(EDITOR_WEIGHT.test('../entity-editor/SaveIndicator')).toBe(false);
  // Третий контроль — на ЯКОРЬ `$` (см. EDITOR_WEIGHT): листовой сабпат диффа тяжёлым не
  // считается, а сам баррель — считается. Без этой пары «починка» регэкспа до
  // `^@orbis\/shared\/doc` прошла бы незамеченной и покрасила бы слой предложения.
  expect(EDITOR_WEIGHT.test('@orbis/shared/doc/diff')).toBe(false);
  expect(EDITOR_WEIGHT.test('@orbis/shared/doc')).toBe(true);
});

test('страж видит тяжёлый импорт, даже когда на строке есть хвостовой комментарий', () => {
  // Проба вместо рассуждения: берём НАСТОЯЩИЙ EditorShell.tsx и снимаем в нём одно слово
  // `type` — ровно ту описку, против которой страж и поставлен. Первая строка файла написана
  // с хвостовым комментарием, и прежний разбор (якорь `';` в конце строки) на ней слеп: он не
  // просто пропускал тяжёлый импорт, а склеивал его со следующим оператором. Страж чанков
  // такую описку тоже не ловит — файл чанка BodyEditor остаётся на месте, переезжает только
  // схема, — так что этот тест здесь единственный.
  const src = readModule('./EditorShell.tsx');
  const broken = src.replace(/^import type /m, 'import ');
  // Страж вакуумности: описка ДЕЙСТВИТЕЛЬНО внесена. Перепиши кто-нибудь первую строку
  // EditorShell на другую форму — тест обязан упасть здесь, а не притвориться зелёным.
  expect(broken).not.toBe(src);
  expect(/^import \{ BodyDoc \} from '@orbis\/shared\/doc'; \/\//m.test(broken)).toBe(true);

  expect(parseRuntimeImports(broken).filter((s) => EDITOR_WEIGHT.test(s))).toEqual([
    '@orbis/shared/doc',
  ]);
  // Сосед по строке не съеден: прежний разбор возвращал ровно тот же список, что и на целом
  // файле, — сравнение «до/после описки» было единственным способом это заметить.
  expect(parseRuntimeImports(broken)).toEqual(['@orbis/shared/doc', ...parseRuntimeImports(src)]);
});

test('разбор импортов различает формы записи, а не только благополучную', () => {
  // Каждая строка — отдельный повод: `import type` веса не несёт, `{ type X }` несёт,
  // импорт ради побочного эффекта несёт тоже, а многострочный список спецификаторов не
  // должен обрывать разбор на первой же строке.
  const src = [
    "import type { A } from './only-type';",
    "import type { B } from './only-type-tail'; // хвост",
    "import { C } from './value-tail'; // хвост",
    "import { type D } from './type-specifier';",
    "import './side-effect';",
    "import * as ns from './namespace';",
    'import {',
    '  e,',
    '  f,',
    "} from './multiline';",
  ].join('\n');
  expect(parseRuntimeImports(src)).toEqual([
    './value-tail',
    './type-specifier',
    './side-effect',
    './namespace',
    './multiline',
  ]);
});

test('разбор импортов не обманывается ни `;` в комментарии, ни отсутствием `;`', () => {
  // Обе строки ниже — НАЙДЕННЫЕ отказы, а не выдуманные краевые случаи (ревью раунда 1).
  //
  // Первая: редакция с границей по `;` обрывалась на точке с запятой ВНУТРИ хвостового
  // комментария многострочного импорта и не видела тяжёлый модуль вовсе — то есть страж
  // становился слепее той редакции, которую чинили.
  const semicolonInComment = [
    'import {',
    '  BodyDoc, // была точка с запятой; вот она',
    "} from '@orbis/shared/doc';",
  ].join('\n');
  expect(parseRuntimeImports(semicolonInComment)).toEqual(['@orbis/shared/doc']);

  // Вторая: без завершающей `;` та же редакция ПОГЛОЩАЛА оператор соседом — ровно тот отказ,
  // ради которого задача и делалась. «Невозможно по построению» это не было: держалось лишь
  // на том, что точку с запятой ставит форматтер, а форматтер — свойство инструмента.
  const noSemicolon = ["import '@orbis/shared/doc'", "import { x } from 'react';"].join('\n');
  expect(parseRuntimeImports(noSemicolon)).toEqual(['@orbis/shared/doc', 'react']);
});

test('разбор импортов не режет путь по `//` и видит двойные кавычки', () => {
  // `//` внутри спецификатора — не комментарий. Наивное снятие комментариев
  // (`replace(/\/\/[^\n]*$/gm, '')`) оставляет от строки `import { A } from 'https:` и
  // теряет импорт целиком: замерено прогоном, поэтому комментарии гасятся разбором, который
  // сперва распознаёт строковые литералы.
  expect(parseRuntimeImports("import { A } from 'https://example.com/x';")).toEqual([
    'https://example.com/x',
  ]);
  // Апостроф внутри комментария не должен приниматься за начало пути.
  expect(parseRuntimeImports("import {\n  a, // don't\n} from './x';")).toEqual(['./x']);
  // Двойные кавычки биом в этом дереве не оставляет, но слепота к ним была бы дырой в страже,
  // а не деталью оформления: закрыта заодно.
  expect(parseRuntimeImports('import { A } from "@orbis/shared/doc";')).toEqual([
    '@orbis/shared/doc',
  ]);
});

test('ленивый `import(…)` рантайм-импортом НЕ считается, а реэкспорт — известная дыра', () => {
  // Ложный плюс страшнее пропуска только на первый взгляд: страж, краснеющий на КОРРЕКТНОЙ
  // лени, чинят снятием стража. `lazy(() => import('…'))` — ровно то, что здесь защищают, и
  // от красноты его спасал бы только отступ в две колонки, то есть перенос строки форматтером.
  expect(parseRuntimeImports("import('@orbis/shared/doc');")).toEqual([]);
  expect(parseRuntimeImports("const X = lazy(() =>\n  import('./Y'),\n);")).toEqual([]);
  // …и настоящий статический импорт того же модуля рядом ВИДЕН — иначе пустота выше означала
  // бы просто сломанный разбор.
  expect(parseRuntimeImports("import('./lazy');\nimport { A } from '@orbis/shared/doc';")).toEqual([
    '@orbis/shared/doc',
  ]);

  // ЗАПИСАННАЯ ГРАНИЦА, а не забытый случай: реэкспорт разбор не видит. Тест закрепляет её
  // явно — чтобы «страж молчит» на таком файле читалось как известное, а не как исправное.
  expect(parseRuntimeImports("export { QUERY_BLOCK_CLOSE } from '@orbis/shared/doc';")).toEqual([]);
});

test('`import.meta` с колонки 1 оператором импорта НЕ считается', () => {
  // `import.meta` начинается со слова `import`, и `\b` после него выполняется (дальше точка),
  // поэтому строка с колонки 1 проходит якорь `^import\b`. Оператором импорта она при этом не
  // является, и без лукахеда `(?!\s*[.(])` разбор брал за спецификатор ПЕРВУЮ строку-литерал
  // файла: страж краснел на исправном коде, где импорта нет вовсе.
  //
  // Так и было до раунда правок 4 — ложный плюс достался от всех прежних редакций разбора.
  // Держался он только на отступе (`^` не совпадал), а отступ — свойство форматтера, не
  // разбора. Оставлять страж, который врёт КРАСНЫМ, дороже описанной дыры: молчаливую ищут,
  // крик на ровном месте гасят — и гасят самым простым способом, то есть снимая стража.
  const withMeta =
    "import.meta.env.DEV;\nconst s = 'hello';\nimport { A } from '@orbis/shared/doc';";
  expect(parseRuntimeImports(withMeta)).toEqual(['@orbis/shared/doc']);

  // Самая дорогая форма прежнего отказа: тяжёлым признавалась строка, к импортам не
  // относящаяся вовсе (давало `['./BodyEditor']`).
  expect(parseRuntimeImports("import.meta.env.DEV;\nconst p = './BodyEditor';")).toEqual([]);

  // Отступ по-прежнему уводит строку из-под `^` — но теперь это уже не единственная защита.
  expect(parseRuntimeImports("  import.meta.url;\nimport { A } from './a';")).toEqual(['./a']);
});
