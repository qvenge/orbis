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
  const { calls, container } = renderWithProviders(<Probe />, (path, input) => {
    if (path !== 'entity.update') throw new Error(`сохранение тела не ходит на ${path}`);
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

test('flush() во время идущего запроса всё равно шлёт, а автосохранение — ждёт', async () => {
  // Первый запрос не оседает никогда (полуоткрытый сокет). Развилка здесь настоящая:
  //  • flush() зовут ровно тогда, когда терять набранное нельзя (уход с экрана, потеря
  //    фокуса) — отложить значит выбросить, потому что таймер снимут при размонтировании;
  //  • автосохранению спешить некуда, а второй запрос ушёл бы с тем же expectedUpdatedAt и
  //    получил бы 409 от собственного же предшественника.
  const s = setup({ respond: () => new Promise(() => {}) });
  s.api().onDocChange(ONE);
  await act(async () => {
    s.api().flush();
  });
  expect(s.updates()).toHaveLength(1);

  s.api().onDocChange(TWO);
  await act(async () => {
    s.api().flush();
  });
  expect(s.updates()).toHaveLength(2);
  expect((s.updates()[1]?.input as { bodyDoc: BodyDoc }).bodyDoc).toEqual(TWO);

  // А по паузе — не шлёт, пока запрос в полёте.
  s.api().onDocChange(THREE);
  await tick(SAVE_PAUSE * 3);
  expect(s.updates()).toHaveLength(2);
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
    hold.api = useBodySave(props.id, props.entity);
    return null;
  }
  const { calls } = renderWithProviders(<Parent />, (path, input) => {
    if (path !== 'entity.update') throw new Error(`сохранение тела не ходит на ${path}`);
    return box.respond(input);
  });
  return {
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
  const s = setup({
    respond: () => {
      throw trpcError('INTERNAL_SERVER_ERROR');
    },
  });
  s.api().onDocChange(ONE);
  await tick(SAVE_PAUSE);

  expect(s.updates()).toHaveLength(1);
  expect(screen.getByText('Не сохранено')).toBeInTheDocument();

  // Само не проходит и сеть не долбит: без новой правки повторов нет.
  await tick(30_000);
  expect(s.updates()).toHaveLength(1);
  expect(screen.getByText('Не сохранено')).toBeInTheDocument();

  // Новая правка — новая попытка (отказ сети НЕ терминален, в отличие от VALIDATION ниже).
  // Запрос при этом ЗАВИСАЕТ: «держит до успеха» значит именно до успеха, а не до следующей
  // попытки — иначе плашка гасла бы на время каждого повтора и зажигалась снова, то есть
  // мигала бы вместо ответа на вопрос «сохранено ли».
  s.serve(() => new Promise(() => {}));
  s.api().onDocChange(TWO);
  await tick(SAVE_PAUSE);
  expect(s.updates()).toHaveLength(2);
  expect(screen.getByText('Не сохранено')).toBeInTheDocument();
  await tick(SLOW_SAVE_MS * 2); // и «Сохраняем…» её не перебивает даже за порогом выдержки
  expect(screen.getByText('Не сохранено')).toBeInTheDocument();

  // Успех — и только он — гасит плашку. Через flush(), а не по паузе: прошлый запрос так и
  // висит в полёте, и автосохранение его дожидалось бы (см. тест про flush во время запроса).
  s.serve(ok);
  s.api().onDocChange(THREE);
  await act(async () => {
    s.api().flush();
  });
  expect(s.updates()).toHaveLength(3);
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
