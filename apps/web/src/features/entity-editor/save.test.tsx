import { readFileSync } from 'node:fs';
import { type BodyDoc, parseBody } from '@orbis/shared/doc';
import { act, screen } from '@testing-library/react';
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
const BASE = parseBody('тело');
const ONE = parseBody('тело и правка');
const TWO = parseBody('тело, правка и ещё одна');
const THREE = parseBody('совсем другое тело');

/**
 * `updatedAt` фиксирован и НАМЕРЕННО далёк от системного времени прогона (2030 год ниже):
 * подстановка «сейчас» вместо строки из кэша — самый вероятный способ сломать §5.2, и
 * тест обязан отличать одно от другого, а не сверять «какую-то строку».
 */
const ENTITY: BodySaveEntity = { updatedAt: '2026-08-14T10:00:00.000Z', bodyDoc: BASE };

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
  const { calls, container } = renderWithProviders(<Probe />, (path, input) => {
    if (path !== 'entity.update') throw new Error(`сохранение тела не ходит на ${path}`);
    sends += 1;
    if (sends > MAX_SENDS) return new Promise(() => {});
    return box.respond(input);
  });

  return {
    container,
    calls,
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

  const s = setup({ entity: { updatedAt: ENTITY.updatedAt, bodyDoc: fromParse } });
  s.api().onDocChange(fromEditor);
  await tick(SAVE_PAUSE);
  expect(s.updates()).toHaveLength(0);
  expect(s.stray()).toEqual([]);

  // Положительный контроль: смена САМОГО текста при том же порядке ключей — правка.
  s.api().onDocChange(ONE);
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
  const { calls, container } = renderWithProviders(<Parent />, (path, input) => {
    if (path !== 'entity.update') throw new Error(`сохранение тела не ходит на ${path}`);
    sends += 1;
    if (sends > MAX_SENDS) return new Promise(() => {}); // потолок отправок, см. MAX_SENDS
    return box.respond(input);
  });
  return {
    container,
    api: () => hold.api as BodySave,
    updates: () => calls.filter((c) => c.path === 'entity.update'),
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

  await s.set({ id: 'e1', entity: { updatedAt: SAVED.updatedAt, bodyDoc: ONE } });
  s.api().onDocChange(ONE);
  await tick(SAVE_PAUSE);
  expect(s.updates()).toHaveLength(1); // это уже сохранено — второй раз не шлём

  // Положительный контроль: правка поверх новой базы уезжает.
  s.api().onDocChange(TWO);
  await tick(SAVE_PAUSE);
  expect(s.updates()).toHaveLength(2);
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
  const second: BodySaveEntity = { updatedAt: '2026-08-14T10:30:00.000Z', bodyDoc: THREE };
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
const SECOND: BodySaveEntity = { updatedAt: '2026-08-14T10:30:00.000Z', bodyDoc: THREE };

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
  // Терминальный отказ ПЕРВОЙ записи: он не зажигает «Не сохранено» на второй...
  await server.answer(0, trpcError('BAD_REQUEST'), 'fail');
  expect(screen.queryByText('Не сохранено')).toBeNull();

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
  await s.set({ id: 'e2', entity: { updatedAt: '2026-08-14T10:30:00.000Z', bodyDoc: THREE } });
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
  expect(screen.getByText('Не сохранено')).toBeInTheDocument();

  s.api().onDocChange(TWO);
  await tick(SAVE_PAUSE);
  expect(s.updates()).toHaveLength(1);

  await act(async () => {
    s.api().flush();
  });
  expect(s.updates()).toHaveLength(1);
  expect(screen.getByText('Не сохранено')).toBeInTheDocument();

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

// --- индикатор --------------------------------------------------------------------------------

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
 * Спецификаторы РАНТАЙМ-импортов модуля. `import type` отброшен: он стирается компилятором и
 * веса в чанк не приносит. Форма `import { type X } from '…'` рантайм-импортом ОСТАЁТСЯ —
 * сборщик снимает спецификатор, но сам импорт с его побочными эффектами держит.
 */
function runtimeImports(file: string): string[] {
  const src = readFileSync(new URL(file, import.meta.url), 'utf8');
  return [...src.matchAll(/^import\s+(?!type\b)[\s\S]*?from\s+'([^']+)';$/gm)].flatMap((m) =>
    m[1] === undefined ? [] : [m[1]],
  );
}

/** Что уводит схему документа (~156 кБ) в первый кадр, если притащить это рантайм-импортом. */
const EDITOR_WEIGHT = /^@tiptap\/|^@orbis\/shared\/doc$|^\.\/extensions$|^\.\/BodyEditor$/;

test('сохранение и сравнение документов не тянут схему редактора в чанк detail', () => {
  // Хук монтирует экран detail (Задача 15), а тот открывается задолго до того, как понадобится
  // редактор. Рантайм-импорт схемы отсюда схлопнул бы двухфазное монтирование молча: ни один
  // тест поведения этого не заметит, а check-lazy-chunks сверяет наличие чанков, не их состав.
  //
  // Проверка НЕтранзитивная — ровно три файла, за которые эта задача отвечает. Появись у
  // них новый общий сосед со схемой внутри, страж промолчит; охватить весь граф импортов
  // тут нечем, и обещать это было бы неправдой.
  for (const file of [
    './useBodySave.ts',
    './strip-ids.ts',
    './draft-storage.ts',
    '../entity-detail/useEntityDetail.ts',
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
});
