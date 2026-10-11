import { readFileSync } from 'node:fs';
import { type BodyDoc, DOC_EXTENSIONS, DOC_SCHEMA_VERSION, parseBody } from '@orbis/shared/doc';
import { act, screen } from '@testing-library/react';
import { getSchema } from '@tiptap/core';
import { Node as PMNode } from '@tiptap/pm/model';
import { useState } from 'react';
import { beforeEach, expect, test, vi } from 'vitest';
import {
  installCrashTrap,
  mockEntityUpdateResult,
  renderWithProviders,
  staleBodyError,
  trpcError,
  wireEntity,
} from '../../test/harness';
import { type RouterOutputs, trpc } from '../../trpc';
import { detailGetInput } from '../entity-detail/useEntityDetail';
import { runUndo, UNDO_OFFLINE } from '../undo/undo-action';
import { registerBodyFlush } from './body-flush';
import { captureDraftWriter, readDraft, setDraftScope } from './draft-storage';
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
const THREE_MD = 'совсем другое тело';
const THREE = parseBody(THREE_MD);

/**
 * Ревизия тела — замок текста (спека скорости §8.1). Число НЕ 1: «первая ревизия» совпала бы с
 * любым умолчанием и подстановкой, и тест не отличил бы ревизию из кэша от выдуманной.
 * `updatedAt` фиксирован и далёк от системного времени прогона: замок его больше не сверяет, но
 * он же — основа черновиков старой формы (К-26, draft.test.tsx).
 */
const ENTITY: BodySaveEntity = {
  bodyRevision: 3,
  updatedAt: '2026-08-14T10:00:00.000Z',
  bodyDoc: BASE,
};

/** Ответ сервера на entity.update: сущность с НОВОЙ ревизией тела (правка тела её двигает). */
const SAVED = mockEntityUpdateResult({
  id: 'e1',
  updatedAt: '2026-08-14T11:00:00.000Z',
  bodyRevision: 4,
});

type UpdateReply = RouterOutputs['entity']['update'];
type Respond = (input: unknown) => Partial<UpdateReply> | PromiseLike<Partial<UpdateReply>>;
const ok: Respond = () => SAVED;

/**
 * Сервер, который отвечает не сам, а КОГДА СКАЖУТ. Без него «второй запрос не уходит, пока
 * идёт первый» пришлось бы проверять зависшим навсегда промисом — то есть не проверять досыл
 * вовсе, а он и есть суть правки I2.
 */
function gatedServer() {
  const gates: { settle: (v: Partial<UpdateReply>) => void; fail: (e: unknown) => void }[] = [];
  const respond: Respond = () =>
    new Promise<Partial<UpdateReply>>((resolve, reject) => {
      gates.push({ settle: resolve, fail: reject });
    });
  /** Ответить на i-й ушедший запрос и дать колбэкам отработать. */
  const answer = async (
    ...args:
      | [i: number, value: Partial<UpdateReply>, mode?: 'ok']
      | [i: number, value: unknown, mode: 'fail']
  ) => {
    const [i, value, mode] = args;
    const gate = gates[i];
    if (gate === undefined) throw new Error(`запроса №${i} не было — отвечать нечему`);
    await act(async () => {
      if (mode === 'fail') gate.fail(value);
      else gate.settle(value);
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
  const hold: { api: BodySave | null; refresh?: () => void } = { api: null };

  function Probe() {
    const [, setRender] = useState(0);
    hold.refresh = () => setRender((value) => value + 1);
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
    return mockEntityUpdateResult(box.respond(input));
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
    rerender: () => act(() => hold.refresh?.()),
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
  setDraftScope('');
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
    expectedBodyRevision: ENTITY.bodyRevision,
    autosave: true,
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
  // мутации), и вместе с ними — подтверждённая ревизия, очистка отложенного, признак полёта
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

  // Первый осел — досыл уходит сам, с последним документом и с подтверждённой ревизией.
  await server.answer(0, SAVED);
  expect(s.updates()).toHaveLength(2);
  expect(s.updates()[1]?.input).toEqual({
    id: 'e1',
    bodyDoc: TWO,
    expectedBodyRevision: SAVED.bodyRevision,
    autosave: true,
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
    v: DOC_SCHEMA_VERSION,
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
    v: DOC_SCHEMA_VERSION,
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

  const s = setup({ entity: { ...ENTITY, bodyDoc: fromParse } });
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

  const s = setup({ entity: { ...ENTITY, bodyDoc: fromParse } });
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

test('мутация уходит с {id, bodyDoc, expectedBodyRevision: <ревизия кэша>, autosave: true}', async () => {
  const s = setup();
  s.api().onDocChange(ONE);
  await tick(SAVE_PAUSE);

  const input = s.updates()[0]?.input as Record<string, unknown>;
  // Полное равенство, а не выборка полей: оно же и стережёт отсутствие `body` — markdown-
  // проекцию делает сервер, и клиентский сериализатор затащил бы всю схему документа в
  // чанк detail, то есть мимо двухфазного монтирования, — и отсутствие прежнего поля замка
  // (`expectedUpdatedAt`): контракт сменился без переходного слоя (§8.2). `autosave` — признак автосохранения
  // редактора: без него сервер писал бы запись журнала на каждое сохранение, а не одну на сеанс набора (§8.5).
  expect(input).toEqual({
    id: 'e1',
    bodyDoc: ONE,
    expectedBodyRevision: ENTITY.bodyRevision,
    autosave: true,
  });
  expect(input).not.toHaveProperty('body');
});

test('второе сохранение подряд берёт ревизию из ответа сервера, а не протухшую из кэша', async () => {
  // Инвалидация после мутации перечитывает detail, но ответ на это чтение может и опоздать:
  // пауза 2 с, а круг «мутация + перечитывание» на плохой связи длиннее. С протухшей ревизией
  // ВТОРОЕ сохранение подряд гарантированно ловило бы 409 — на ровном месте, без чужой правки.
  // Пропс здесь намеренно не обновляется: это и есть «перечитывание не доехало».
  const s = setup();
  s.api().onDocChange(ONE);
  await tick(SAVE_PAUSE);
  s.api().onDocChange(TWO);
  await tick(SAVE_PAUSE);

  expect(s.updates()).toHaveLength(2);
  const revision = (i: number) =>
    (s.updates()[i]?.input as { expectedBodyRevision: number }).expectedBodyRevision;
  expect(revision(0)).toBe(ENTITY.bodyRevision);
  expect(revision(1)).toBe(SAVED.bodyRevision);
  // Страж вакуумности: две ревизии ДОЛЖНЫ различаться, иначе проверка выше ни о чём.
  expect(SAVED.bodyRevision).not.toBe(ENTITY.bodyRevision);
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
    return mockEntityUpdateResult(box.respond(input));
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

  await s.set({
    id: 'e1',
    entity: { bodyRevision: SAVED.bodyRevision, updatedAt: SAVED.updatedAt, bodyDoc: ONE },
  });
  s.api().onDocChange(ONE);
  await tick(SAVE_PAUSE);
  expect(s.updates()).toHaveLength(1); // это уже сохранено — второй раз не шлём

  // Положительный контроль: правка поверх новой базы уезжает.
  s.api().onDocChange(TWO);
  await tick(SAVE_PAUSE);
  expect(s.updates()).toHaveLength(2);
});

/**
 * Чужая правка, приехавшая с сервера: и документ другой, и ревизия БОЛЬШЕ всех известных клиенту
 * (больше и `ENTITY.bodyRevision`, и `SAVED.bodyRevision` — иначе «большая из двух» выбрала бы
 * верную ревизию по совпадению, и подмену было бы не отличить от порядка).
 */
const FOREIGN: BodySaveEntity = {
  bodyRevision: 7,
  updatedAt: '2026-08-14T20:00:00.000Z',
  bodyDoc: THREE,
};

test('досыл при уходе несёт ревизию, на которой правка НАБИРАЛАСЬ, а не свежую из кэша', async () => {
  // Сюжет целиком, все действия штатные: правка с телефона двинула текст записи; здесь человек
  // печатает, ловит 409, жмёт «Обновить» — перечитывание приносит ЧУЖОЙ документ, и редактор
  // (фокус ушёл на кнопку) сажает его вместо набранного. Хук об этой подмене не узнаёт никогда.
  // Возьми досыл ревизию из свежего кэша — он ушёл бы как «я видел чужую правку и кладу поверх»,
  // и сервер молча затёр бы её текстом, который человек уже видел исчезнувшим с экрана.
  //
  // Замок текста (§8.1) требует ТУ ревизию, которую клиент видел, КОГДА ДЕЛАЛ ЭТУ ПРАВКУ: правка
  // набирается поверх ревизии на НАЧАЛО набора, а не берёт её в момент отправки.
  const s = mountWithProps({ id: 'e1', entity: ENTITY }, () => {
    throw staleBodyError();
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
    expectedBodyRevision: ENTITY.bodyRevision,
    autosave: true,
  });
  // Страж вакуумности: ревизии ДОЛЖНЫ различаться, иначе проверка выше ни о чём.
  expect(FOREIGN.bodyRevision).not.toBe(ENTITY.bodyRevision);
});

test('правка, набранная ПОСЛЕ того, как редактор ПОКАЗАЛ чужой документ, уезжает с ЕГО ревизией', async () => {
  // Обратная сторона: основа — ревизия ПОКАЗАННОГО текста. Человек, напечатавший поверх текста, который редактор
  // посадил (`onShown`), видел именно его — и уходить правка обязана с его ревизией, иначе каждое сохранение после
  // чужой правки ловило бы 409 до самой перезагрузки.
  const s = mountWithProps({ id: 'e1', entity: ENTITY });
  s.api().onDocChange(ONE);
  await tick(SAVE_PAUSE);
  expect(s.updates()).toHaveLength(1);

  await s.set({ id: 'e1', entity: FOREIGN });
  act(() => s.api().onShown(FOREIGN.bodyRevision));
  s.api().onDocChange(TWO);
  await tick(SAVE_PAUSE);

  expect(s.updates()).toHaveLength(2);
  expect((s.updates()[1]?.input as { expectedBodyRevision: number }).expectedBodyRevision).toBe(
    FOREIGN.bodyRevision,
  );
});

test('чужой документ в кэше, которого редактор НЕ показал, основу не двигает: правка уходит с ревизией своего сохранения (R-17)', async () => {
  // Человек печатает в фокусе — редактор приехавший чужой текст не сажает, а перечитывание после своего сохранения
  // (из чата, опросом прогона) уже положило в кэш ревизию агента. Возьми основу из кэша — следующая буква ушла бы с
  // ревизией агента и затёрла бы его текст молча. Основа — ревизия показанного текста или своего сохранения, и
  // сервер отвечает `STALE_VERSION`.
  const s = mountWithProps({ id: 'e1', entity: ENTITY });
  s.api().onDocChange(ONE);
  await tick(SAVE_PAUSE);
  expect(s.updates()).toHaveLength(1); // своё сохранение: ревизия 4

  await s.set({ id: 'e1', entity: FOREIGN }); // в кэше — текст и ревизия агента, редактор их не показал
  s.api().onDocChange(TWO);
  await tick(SAVE_PAUSE);

  expect(s.updates()).toHaveLength(2);
  expect(s.updates()[1]?.input).toEqual({
    id: 'e1',
    bodyDoc: TWO,
    expectedBodyRevision: SAVED.bodyRevision,
    autosave: true,
  });
  // Страж вакуумности: ревизия в кэше ДЕЙСТВИТЕЛЬНО другая
  expect(FOREIGN.bodyRevision).not.toBe(SAVED.bodyRevision);
});

test('ревизия тела неизвестна (0): сохранение не уходит, черновик на диске не помечен отвергнутым (M-2 гейта)', async () => {
  // Отказ разбора (`expectedBodyRevision` — целое ≥ 1) хук принял бы за приговор документу: пометил бы черновик
  // «сервер отверг» и выключил бы сохранение до перезагрузки. Отказа по существу нет — отправки нет вовсе.
  const s = setup({ entity: { ...ENTITY, bodyRevision: 0 } });
  s.api().onDocChange(ONE);
  await tick(SAVE_PAUSE);
  expect(s.updates()).toEqual([]);
  expect(screen.getByText('Не сохранено')).toBeInTheDocument();
  expect(readDraft('e1')).toMatchObject({ doc: ONE, baseRevision: 0, rejected: false });
});

/**
 * Та же запись после СВОЕЙ ЖЕ правки заголовка: тело не тронуто — ревизия тела та же, а штамп
 * записи вырос.
 *
 * Такие правки (заголовок, чекбокс, архивация, аспекты) идут через ДРУГОЙ экземпляр обвязки
 * обновления, и `confirmedRef` про них не знает ничего: он ведёт счёт только мутациям тела.
 */
const AFTER_TITLE: BodySaveEntity = {
  bodyRevision: 3,
  updatedAt: '2026-08-14T15:00:00.000Z',
  // ДРУГОЙ объект того же смысла, а не `BASE`: из кэша тело всегда приезжает новым объектом,
  // и с общей ссылкой тест остался бы зелёным даже при сравнении по `===` (ре-ревью раунда 2).
  bodyDoc: parseBody('тело'),
};

test('своя же правка заголовка или свойства не превращает сохранение тела в 409 — без машинерии', async () => {
  // Сюжет целиком, все действия свои: человек печатает в теле, не дожидаясь паузы правит
  // заголовок той же записи, сервер двигает штамп записи, перечитывание приносит его в кэш — и
  // пауза истекает. Замок текста — ревизия тела (§8.1), а её правка заголовка или свойства не
  // двигает: тело уходит с ревизией, которую сервер и держит, и 409 не бывает. Прежде это
  // требовало «разморозки» метки по сверке тел — её больше нет, и сохранение уходит с ТОЙ ЖЕ
  // ревизией, что взята на начало набора.
  const s = mountWithProps({ id: 'e1', entity: ENTITY });
  s.api().onDocChange(ONE);

  await s.set({ id: 'e1', entity: AFTER_TITLE });
  await tick(SAVE_PAUSE);

  expect(s.updates()).toHaveLength(1);
  expect(s.updates()[0]?.input).toEqual({
    id: 'e1',
    bodyDoc: ONE,
    expectedBodyRevision: ENTITY.bodyRevision,
    autosave: true,
  });
  // Стражи вакуумности: тело и ревизия ДЕЙСТВИТЕЛЬНО те же, а штамп записи ДЕЙСТВИТЕЛЬНО другой.
  expect(AFTER_TITLE.bodyDoc).toEqual(ENTITY.bodyDoc);
  expect(AFTER_TITLE.bodyRevision).toBe(ENTITY.bodyRevision);
  expect(AFTER_TITLE.updatedAt).not.toBe(ENTITY.updatedAt);
});

test('своя же правка заголовка поверх ОТКАЗАВШЕЙ правки тела: досыл при уходе не ловит 409', async () => {
  // Окно шире паузы, и потому хуже: отказ сети оставляет отложенный документ на руках до самого
  // успеха. Человек правит заголовок, уходит с записи — и досыл уезжает с ревизией, которую
  // правка заголовка не двигала, то есть с верной: 409 здесь неоткуда взяться.
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
    expectedBodyRevision: ENTITY.bodyRevision,
    autosave: true,
  });
});

test('чужая правка текста держит ревизию набора — своя правка заголовка поверх её не сдвигает', async () => {
  // Сюжет целиком, и на последнем шаге — ни одного нажатия клавиши:
  //  1. печатаю в теле — правка набирается поверх ревизии R1;
  //  2. с телефона правят текст той же записи — приезжает ЧУЖОЕ тело с ревизией R2;
  //  3. правлю ЗАГОЛОВОК этой же записи — штамп записи уходит дальше, ревизия тела — та же R2;
  //  4. ухожу с записи → досыл обязан уйти с R1 и получить 409, а не затереть чужой текст молча.
  const s = mountWithProps({ id: 'e1', entity: ENTITY });
  s.api().onDocChange(ONE);

  await s.set({ id: 'e1', entity: FOREIGN }); // шаг 2: чужое тело, ревизия 7
  await s.set({
    id: 'e1',
    // Шаг 3: штамп ушёл ещё дальше, а тело и ревизия — ТЕ ЖЕ чужие (другим объектом, как из кэша).
    entity: {
      bodyRevision: FOREIGN.bodyRevision,
      updatedAt: '2026-08-14T21:00:00.000Z',
      bodyDoc: parseBody(THREE_MD),
    },
  });
  await s.unmount();

  expect(s.updates()).toHaveLength(1);
  expect(s.updates()[0]?.input).toEqual({
    id: 'e1',
    bodyDoc: ONE,
    expectedBodyRevision: ENTITY.bodyRevision,
    autosave: true,
  });
});

test('собственный успех двигает ревизию отложенного: досыл не ловит 409 от предшественника', async () => {
  // Замри ревизия НАВСЕГДА в момент набора — досыл, ушедший после успеха первого запроса, нёс бы
  // ревизию, которую этот же успех и сдвинул: гарантированный 409 на ровном месте, без единой
  // чужой правки. Правка №2 — потомок только что сохранённой правки №1, и её база — ответ
  // сервера.
  const server = gatedServer();
  const s = mountWithProps({ id: 'e1', entity: ENTITY }, server.respond);
  s.api().onDocChange(ONE);
  await tick(SAVE_PAUSE);
  expect(s.updates()).toHaveLength(1);

  // Вторая правка набрана, ПОКА первая в полёте: её ревизия на этот момент — ещё ENTITY.bodyRevision.
  s.api().onDocChange(TWO);
  await tick(SAVE_PAUSE);
  expect(s.updates(), 'премиса: второй запрос ждёт оседания первого').toHaveLength(1);

  await server.answer(0, SAVED);
  expect(s.updates()).toHaveLength(2);
  expect(s.updates()[1]?.input).toEqual({
    id: 'e1',
    bodyDoc: TWO,
    expectedBodyRevision: SAVED.bodyRevision,
    autosave: true,
  });
});

test('смена сущности не уносит в чужую запись ни отложенное тело, ни чужую ревизию', async () => {
  // Самая дорогая из возможных ошибок: `{ id: 'вторая запись', bodyDoc: <тело первой> }` —
  // молча и необратимо. Экран сегодня пересоздаёт секцию тела по key={entity.id}, но верность
  // хука не должна держаться на чужом ключе.
  const s = mountWithProps({ id: 'e1', entity: ENTITY });
  s.api().onDocChange(ONE);
  await tick(SAVE_PAUSE);
  expect(s.updates()).toHaveLength(1); // сервер подтвердил ревизию 4 ПЕРВОЙ записи

  // Вторая правка набрана, но пауза ещё не вышла — она так и остаётся отложенной.
  s.api().onDocChange(TWO);
  await tick(SAVE_PAUSE - 500);

  // У второй записи ревизия МЕНЬШЕ подтверждённой первой — иначе «взять большую из двух»
  // выбрало бы верную ревизию по совпадению, и утечку было бы не отличить от порядка.
  const second: BodySaveEntity = {
    bodyRevision: 2,
    updatedAt: '2026-08-14T10:30:00.000Z',
    bodyDoc: THREE,
  };
  await s.set({ id: 'e2', entity: second });

  // flush() — самый острый случай: таймер при смене id снимается сам, а вот отложенный
  // документ, доживи он до сюда, уехал бы в тело ВТОРОЙ записи по первому же требованию.
  await s.flush();
  await tick(SAVE_PAUSE * 2);
  expect(s.updates()).toHaveLength(1);

  // Положительный контроль: правка ВТОРОЙ записи уезжает — с её собственными id и ревизией.
  s.api().onDocChange(TWO);
  await tick(SAVE_PAUSE);
  expect(s.updates()).toHaveLength(2);
  expect(s.updates()[1]?.input).toEqual({
    id: 'e2',
    bodyDoc: TWO,
    expectedBodyRevision: second.bodyRevision,
    autosave: true,
  });
});

/** Вторая запись: её ревизия МЕНЬШЕ всего, что вернёт сервер по первой (см. тесты ниже). */
const SECOND: BodySaveEntity = {
  bodyRevision: 2,
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
    expectedBodyRevision: SECOND.bodyRevision,
    autosave: true,
  });
});

test('ответ на запрос прежней записи не ложится в счёт соседней', async () => {
  // Запрос, ушедший ДО смены записи, обязан доехать — он про прежнюю запись. Но его ответ
  // здесь больше не касается ничего: ляг подтверждённая ревизия ПЕРВОЙ записи в счёт
  // второй, её первое же сохранение получило бы 409 с плашкой «изменено в другом месте» —
  // на записи, которой никто не касался.
  const server = gatedServer();
  const s = mountWithProps({ id: 'e1', entity: ENTITY }, server.respond);
  s.api().onDocChange(ONE);
  await tick(SAVE_PAUSE);
  expect(s.updates()).toHaveLength(1);

  await s.set({ id: 'e2', entity: SECOND });
  // Ответ ПЕРВОЙ записи — с ревизией заведомо большей, чем у второй: возьми её «большая из
  // двух», подмена была бы видна в expectedBodyRevision ниже.
  await server.answer(0, { id: 'e1', updatedAt: '2026-08-14T23:00:00.000Z', bodyRevision: 9 });

  s.api().onDocChange(TWO);
  await tick(SAVE_PAUSE);
  expect(s.updates()).toHaveLength(2);
  expect(s.updates()[1]?.input).toEqual({
    id: 'e2',
    bodyDoc: TWO,
    expectedBodyRevision: SECOND.bodyRevision,
    autosave: true,
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
  await server.answer(0, staleBodyError(), 'fail');
  expect(s.api().conflict).toBe(false);
  expect(s.container).toBeEmptyDOMElement(); // и «Не сохранено» не зажглось (И-5)

  // Положительный контроль: 409 по СВОЕЙ записи флаг поднимает — сверка по id не выключила
  // проверку вовсе.
  s.api().onDocChange(TWO);
  await tick(SAVE_PAUSE);
  expect(s.updates()).toHaveLength(2);
  await server.answer(1, staleBodyError(), 'fail');
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
  await server.answer(1, staleBodyError(), 'fail');
  expect(s.api().conflict).toBe(true);

  // А теперь доезжает успех по ПЕРВОЙ записи. Он не про этот конфликт и гасить его не вправе:
  // иначе плашка исчезла бы с экрана сама, а расхождение осталось бы.
  await server.answer(0, SAVED);
  expect(s.api().conflict).toBe(true);
});

test('conflict гаснет при смене записи, а не переезжает на соседнюю', async () => {
  const s = mountWithProps({ id: 'e1', entity: ENTITY }, () => {
    throw staleBodyError();
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
    entity: { bodyRevision: 2, updatedAt: '2026-08-14T10:30:00.000Z', bodyDoc: THREE },
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
  const hold: { api: BodySave | null; refresh?: () => void } = { api: null };
  function SaveProbe() {
    hold.api = useBodySave('e1', ENTITY);
    return null;
  }

  const server = {
    ...wireEntity({
      id: 'e1',
      title: 'Запись',
      body: 'тело',
      bodyDoc: BASE,
      createdAt: '2026-08-14T09:00:00.000Z',
      updatedAt: ENTITY.updatedAt,
    }),
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
      throw staleBodyError();
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

test('409 без структурного отказа замка текста (data.orbis) плашку тела не поднимает', async () => {
  // Конфликт тела узнаётся по коду отказа исполнителя в `data.orbis` (РП-5), а не по транспортному
  // CONFLICT: 409 бывает и у других отказов (занятый id, будущий замок заголовка), и «Изменено в
  // другом месте — обновите» над телом было бы про чужое. Положительная сторона — тест выше.
  const s = setup({
    respond: () => {
      throw trpcError('CONFLICT');
    },
  });
  s.api().onDocChange(ONE);
  await tick(SAVE_PAUSE);
  expect(s.updates()).toHaveLength(1);
  expect(s.api().conflict).toBe(false);
  expect(s.api().blocked()).toBe(false);
  expect(screen.getByText('Не сохранено')).toBeInTheDocument();
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
 *  - `import('…')` — ленивая загрузка, ровно то, что страж защищает. `EntityBody.tsx` грузит
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
 * (`./BodyEditor` из EditorShell, `../entity-editor/MarkdownToggle` из EntityBody), и якорь на
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
  // Проверка НЕтранзитивная — ровно перечисленные файлы, за которые эта задача отвечает. Появись у
  // них новый общий сосед со схемой внутри, страж промолчит; охватить весь граф импортов
  // тут нечем, и обещать это было бы неправдой. Транзитивную половину закрывает третья
  // проверка в scripts/check-lazy-chunks.ts (состав чанка `DetailScreen` по dist) — но она
  // требует СБОРКИ, а этот список работает на каждом прогоне тестов.
  //
  // `SaveIndicator.tsx` и `body-box.ts` в списке НЕ для полноты: оба достижимы эагерно
  // (индикатор рисует EntityBody, коробку — EditorShell), и значимый импорт схемы в любом из
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
    // Обвязка записи, нарезанная на примитивы (задача 12): тело, тред, секции аспектов, свои
    // карточки, теги и хост — все эагерны из DetailScreen. `EntityBody.tsx` держит ленивый
    // тумблер markdown и `/doc/diff`: одна правка импорта там — и схема едет в первый кадр.
    '../entity-detail/EntityBody.tsx',
    '../entity-detail/EntityThreadTab.tsx',
    '../entity-detail/AspectSection.tsx',
    '../entity-detail/AspectCards.tsx',
    '../entity-detail/own-cards.tsx',
    '../entity-detail/TagsBlock.tsx',
    '../entity-detail/record-host.tsx',
    '../entity-detail/record-blocks.tsx',
    // Единый механизм данных блоков (задача 11): блок первого кадра — эагерный, и с ним весь
    // его путь данных и формы показа. Каждый — кандидат притащить баррель одной строкой.
    '../../lib/query-blocks/QueryBlock.tsx',
    '../../lib/query-blocks/batch.tsx',
    '../../lib/query-blocks/body-kind.tsx',
    '../../lib/query-blocks/parse.ts',
    '../page/blocks/DataBlock.tsx',
    '../page/blocks/CompactForm.tsx',
    '../page/blocks/ListForm.tsx',
    '../page/blocks/TableForm.tsx',
    '../page/blocks/TileForm.tsx',
    '../page/blocks/MoreRows.tsx',
    '../page/blocks/BlockPlaque.tsx',
    '../page/blocks/types.ts',
    // Рендерер показа и страница своим телом (задача 13): экран записи показывает ими каждую
    // запись-страницу, то есть они эагерны так же, как вкладки. Рендерер тянет препроход и
    // матрицу мест — только листовыми сабпатами; одна строка с баррелем здесь — схема в кадре.
    '../page/Renderer.tsx',
    // Плашки и обход рисуемых узлов рендерера — общие с «Изменить вид» (финальное ревью, C1-I1).
    '../page/render-plan.ts',
    '../page/Columns.tsx',
    '../page/TabsContainer.tsx',
    '../page/PageView.tsx',
    // Экран записи через шаблон (задача 14): КАЖДАЯ запись открывается выбором шаблона, текстом
    // шаблона хоста и его плашками — они эагерны так же, как рендерер. Шаблон хоста разбирается
    // при загрузке модуля: баррель здесь стоил бы схемы в первом кадре каждого открытия.
    '../page/host-template.ts',
    '../page/usePageTemplates.ts',
    '../page/RecordView.tsx',
    '../page/TemplatePlaques.tsx',
    // Пачка правок с тостом «Отменить» — плашка спора зовёт её эагерно (финальное ревью, C1-I4).
    '../page/useUpdateBatch.ts',
    '../page/BaseRecordView.tsx',
    // Точка лени меню «⋯» записи (рычаг веса задачи 14 1а); само меню (`DetailMenu.tsx`) ленивое
    // и сторожится наличием своего чанка (check-lazy-chunks). Кнопка «⋯» — в рамке (ниже).
    '../entity-detail/DetailMenuSlot.tsx',
    // Механика ленивого меню (Л-1, РП-13) — эагерна; Radix — только в ленивом чанке (страж —
    // `MENU_WEIGHT` ниже).
    '../../ui/LazyMenuSlot.tsx',
    // Настройка и предпросмотр (задача 16): подписи и коробки рамок и заглушек рисует и первый
    // кадр тела (эагерный), и NodeView; настройка — тот же `EntityBody`, предпросмотр шаблона —
    // обычный показ открытого шаблона. Все эагерны; NodeView (`nodes/LayoutFrame`,
    // `nodes/RecordBlockStub`) — в чанке редактора, через `extensions.ts`.
    './layout-parts.tsx',
    '../page/ConfigureView.tsx',
    '../page/TemplateBanner.tsx',
    '../page/TemplatePreview.tsx',
    // Хвосты 1а (срез 1б, задача 2): правило неотправленной правки тела — общее у настройки
    // (эагерной) и меню; страж ухода зовёт стор навигации первого кадра.
    '../entity-detail/body-gate.ts',
    './body-flush.ts',
    '../undo/undo-lazy.ts',
    '../undo/undo-stack.ts',
    '../undo/undo-epoch.ts',
    '../undo/body-provenance.ts',
    '../undo/mutation-epoch.ts',
    '../undo/is-editable-target.ts',
    '../undo/useUndoHotkey.ts',
    '../undo/undo-binding.ts',
    '../undo/journal-ref.ts',
    '../../state/leave-guard.ts',
    // Шаблон хоста — запись поставки и свои карточки (срез 1б, задача 17): записи поставки читает
    // каждое открытие записи, `{{cards: own}}` стоит в шаблоне хоста, карточки расширений приходят
    // через реестр — все эагерны. Карточки тянут общий помощник процента (прежде — из Бюджета).
    '../entity-detail/OwnCards.tsx',
    '../page/useSupplyRecords.ts',
    '../../app/extension-registry.tsx',
    '../../extensions/goals/GoalCard.tsx',
    '../../extensions/finance/FinancialCard.tsx',
    '../../lib/percent.ts',
    // Точка лени блока «Записи» (срез 1б, задача 18): рендерер зовёт её эагерно; сам блок
    // (`RecordsBlock.tsx`) — ленивый, сторожится своим чанком и порогами gzip (check-lazy-chunks).
    '../browser/RecordsBlockSlot.tsx',
    // Параметр страницы (срез 1в, задача 5): провайдер значений и точка лени переключателя рисуются
    // рендерером и первым кадром эагерно; сам переключатель (`ParamSwitch.tsx`) — ленивый, сторожится
    // своим чанком (check-lazy-chunks).
    '../page/params.tsx',
    '../page/blocks/ParamSwitchSlot.tsx',
    // Лента по дням (срез 1в, задача 7): точка лени — эагерна (её рисует блок данных); сама лента
    // с подписями дней и колонкой времени (`DayGroups.tsx`) — ленивая, сторожится своим чанком.
    '../page/blocks/DayGroupsSlot.tsx',
    // Точка лени плашки обновления поставки (срез 1б, задача 22): её рисуют запись и страница
    // эагерно; плашка, сравнение (разбор тела — баррель `@orbis/shared/doc`) и печати поставки —
    // ленивые, сторожатся своими чанками (check-lazy-chunks: `SupplyPlaque`, ребро `↛ print`).
    '../supply/SupplyPlaqueSlot.tsx',
    // Рамка хоста (срез 1б, задача 19): присутствие хоста рисует шапка каждого экрана, в том
    // числе записи, — оболочка приложения, меню «⋯», ссылки по рамке и стор навигации достижимы из
    // экрана записи эагерно. `HostMenu.tsx` — ленивый (содержимое «⋯» экранов без своих пунктов);
    // лист разделов `NavSheet.tsx` с бейджами — ленивый с задачи 20 (раскрывается жестом), в списке
    // остаётся: его чанк грузит каждое раскрытие «▾».
    '../../app/ScreenHeader.tsx',
    '../../app/frame/HostPresence.tsx',
    '../../app/frame/NavSheet.tsx',
    // Задача 25: строки разделов — общий код листа и сайдбара десктопа (грузятся с листом); шапка
    // выбирает форму по рамке (`frame-kind`) — оба достижимы из шапки экрана записи.
    '../../app/frame/SectionList.tsx',
    '../../app/frame/frame-kind.ts',
    '../../app/frame/useAppShell.ts',
    '../../app/frame/ScreenMenu.tsx',
    '../../app/frame/FrameApp.tsx',
    '../../app/useOpenRecord.ts',
    '../../lib/query-blocks/useBadgeData.ts',
    '../../state/navigation.ts',
    // Приложения в web (срез 1б, задача 20): правило открытия решает рамку и место на каждом
    // открытии записи (`useApps`, `useOpening`) — эагерно; плашки с вопросом спора мест, блок
    // «Приложения», плитки «домашней как центр», листы разделов и «Все приложения» — ленивые, их
    // точки лени (`OpenPlaques.tsx`, `slots.tsx`) эагерны и лёгкие (чанки — check-lazy-chunks).
    '../apps/useApps.ts',
    '../apps/useOpening.ts',
    '../apps/OpenPlaques.tsx',
    '../apps/slots.tsx',
    // Выключенное расширение (срез 1б, задача 23): маску (листовой `extension-mask.ts`) читают секции
    // аспектов, строка записи и реакции расширений реестра на каждом открытии — эагерно; общие
    // помощники ядра переехали из каталогов расширений в `lib/`. Сама плашка с «Включить»
    // (`ExtensionOffPlaque.tsx`) — ленивая, сторожится своим чанком (check-lazy-chunks).
    '../settings/extension-mask.ts',
    '../../lib/invalidate.ts',
    '../../lib/dates.ts',
    // Вкладка настроек, которую открывает «⋯ → Настройки» (`ScreenMenu`, задача 22): стор и переход
    // — эагерно из меню экрана записи (финал 1б, C2 M-4).
    '../settings/settings-tab.ts',
    './editor-cache.ts',
    './arrows-stack.ts',
    './title-history.ts',
    '../entity-detail/UndoArrowsSlot.tsx',
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
  // Второй листовой сабпат — `/types` (Задача 20): в нём живут `DOC_SCHEMA_VERSION`,
  // `KNOWN_NODE_TYPES` и обход состава нод, и хук сохранения зовёт их ЗНАЧЕНИЯМИ.
  expect(EDITOR_WEIGHT.test('@orbis/shared/doc/types')).toBe(false);
});

test('хук сохранения берёт версию схемы из ЛИСТОВОГО сабпата, а не из барреля', () => {
  // Страж вакуумности к списку выше: пустой список тяжёлых импортов у `useBodySave.ts` был бы
  // зелен и в мире, где контракт офлайн-черновиков просто не написан. Здесь проверяется, что
  // рантайм-импорт ЕСТЬ и что он ведёт в листовой модуль: перепиши кто-нибудь его на голый
  // `@orbis/shared/doc` — тест выше покраснеет, а этот скажет, чего именно не хватает.
  const imports = runtimeImports('./useBodySave.ts');
  expect(imports).toContain('@orbis/shared/doc/types');
  expect(imports).not.toContain('@orbis/shared/doc');
});

/**
 * Что уводит Radix-меню (menu, popper, floating-ui — ≈16 кБ gzip) в первый кадр экрана записи, если
 * эагерный файл механики меню притащит это рантайм-импортом: сам `radix-ui`, примитив
 * `ui/DropdownMenu` или ленивое меню записи `entity-detail/DetailMenu` значением.
 *
 * Отдельный предикат, а не строка в `EDITOR_WEIGHT`, и отдельный короткий список файлов: `radix-ui`
 * эагерен уже на базе и законно (`ui/Tabs` через `TabsContainer`, `ui/Toast`), так что «ни один
 * эагерный файл не тянет `radix-ui`» ложно. Стережётся именно меню. Ни `check-lazy-chunks`, ни вес
 * файла `DetailScreen-*.js` эту утечку не видят: Rollup кладёт Radix в общие чанки, которые экран
 * импортирует статически (замер мутации (г) задачи 1 среза 1б: файл +33 Б, замыкание +16 кБ).
 *
 * `(^|\/)DetailMenu$` не задевает `./DetailMenuSlot`: якорь `$`. `HostMenu` — ленивое содержимое «⋯»
 * рамки на экранах без своих пунктов (срез 1б §6.4).
 */
const MENU_WEIGHT = /^radix-ui$|(^|\/)DropdownMenu$|(^|\/)(DetailMenu|HostMenu)$/;

test('эагерные файлы механики меню не тянут Radix-меню в первый кадр (Л-1, РП-13)', () => {
  for (const file of [
    '../../ui/LazyMenuSlot.tsx',
    '../entity-detail/DetailMenuSlot.tsx',
    // Кнопка «⋯» рамки (срез 1б §6.4) — эагерна на каждом экране; меню — только в ленивых чанках.
    '../../app/frame/ScreenMenu.tsx',
    '../../app/frame/HostPresence.tsx',
  ]) {
    expect(
      runtimeImports(file).filter((s) => MENU_WEIGHT.test(s)),
      file,
    ).toEqual([]);
  }
  // Положительные контроли: на самих ленивых файлах предикат обязан сработать — иначе пустые списки
  // выше значили бы лишь сломанный разбор или предикат.
  expect(runtimeImports('../../ui/DropdownMenu.tsx')).toContain('radix-ui');
  expect(runtimeImports('../../ui/DropdownMenu.tsx').filter((s) => MENU_WEIGHT.test(s))).toEqual([
    'radix-ui',
  ]);
  expect(
    runtimeImports('../entity-detail/DetailMenu.tsx').filter((s) => MENU_WEIGHT.test(s)),
  ).toEqual(['../../ui/DropdownMenu']);
  // Спеллинги: из экрана (`./DetailMenu`) и из механики (`./DropdownMenu`); сосед-слот — не тяжёлый.
  expect(MENU_WEIGHT.test('./DetailMenu')).toBe(true);
  expect(MENU_WEIGHT.test('./DropdownMenu')).toBe(true);
  expect(MENU_WEIGHT.test('./DetailMenuSlot')).toBe(false);
  expect(MENU_WEIGHT.test('./HostMenu')).toBe(true);
  expect(MENU_WEIGHT.test('../../ui/LazyMenuSlot')).toBe(false);
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

test('flushSettled: пустой набор — nothing, запросов нет', async () => {
  const s = setup();
  await expect(s.api().flushSettled()).resolves.toBe('nothing');
  expect(s.updates()).toEqual([]);
});
test('flushSettled ждёт полёт и всю очередь до второго подтверждения', async () => {
  const srv = gatedServer();
  const s = setup({ respond: srv.respond });
  act(() => s.api().onDocChange(ONE));
  act(() => s.api().flush());
  act(() => s.api().onDocChange(TWO));
  let settled: string | null = null;
  void s
    .api()
    .flushSettled()
    .then((r) => {
      settled = r;
    });
  await tick();
  expect([s.updates().length, settled]).toEqual([1, null]);
  await srv.answer(0, SAVED);
  expect([s.updates().length, settled]).toEqual([2, null]);
  await srv.answer(1, { ...SAVED, bodyRevision: 5 });
  expect(settled).toBe('saved');
  expect(s.api().revisionForRewrite()).toBe(5);
});
test('flushSettled: размонтирование освобождает ждущего', async () => {
  const srv = gatedServer();
  const s = setup({ respond: srv.respond });
  act(() => s.api().onDocChange(ONE));
  const waiting = s.api().flushSettled();
  await tick();
  s.unmount();
  await expect(waiting).resolves.toBe('nothing');
});

test('rewrite читает показанную ревизию, скрытая чужая в cache не разрешает перезапись', async () => {
  let change: ((v: BodySaveEntity) => void) | undefined;
  let api: BodySave | undefined;
  function Probe() {
    const [base, set] = useState(ENTITY);
    change = set;
    api = useBodySave('e1', base);
    return null;
  }
  const updates: unknown[] = [];
  renderWithProviders(<Probe />, (path, input) => {
    if (path === 'entity.update') {
      updates.push(input);
      throw staleBodyError();
    }
    return {};
  });
  act(() => change?.({ ...ENTITY, bodyRevision: 9, bodyDoc: THREE }));
  expect(api?.revisionForRewrite()).toBe(3);
  act(() => api?.onDocChange(ONE));
  await expect(api?.flushSettled()).resolves.toBe('blocked');
  expect(updates[0]).toMatchObject({ expectedBodyRevision: 3 });
});
test('Refresh сохраняет последние слова до таймера; Keep mine не принимает невидимую чужую ревизию', async () => {
  let change: ((v: BodySaveEntity) => void) | undefined;
  let api: BodySave | undefined;
  function Probe() {
    const [base, set] = useState(ENTITY);
    change = set;
    api = useBodySave('e1', base);
    return null;
  }
  const updates: unknown[] = [];
  renderWithProviders(<Probe />, (path, input) => {
    if (path === 'entity.update') {
      updates.push(input);
      throw staleBodyError();
    }
    return {};
  });
  act(() => api?.onDocChange(ONE));
  act(() => api?.flush());
  await tick();
  act(() => api?.onDocChange(TWO));
  act(() => api?.offerConflictDraft());
  expect(api?.pendingDraft?.doc).toEqual(TWO);
  act(() => {
    api?.onShown(4);
    change?.({ ...ENTITY, bodyRevision: 9, bodyDoc: THREE });
  });
  act(() => api?.applyPendingDraft());
  await tick();
  expect(updates[1]).toMatchObject({ expectedBodyRevision: 4, bodyDoc: TWO });
});

for (const [label, error, outcome] of [
  ['CAS', staleBodyError(), 'blocked'],
  ['terminal', trpcError('BAD_REQUEST'), 'blocked'],
  ['transport', new Error('нет ответа'), 'offline'],
] as const)
  test(`flushSettled ${label} не выдаёт отказ за saved`, async () => {
    const srv = gatedServer();
    const s = setup({ respond: srv.respond });
    act(() => s.api().onDocChange(ONE));
    const waiting = s.api().flushSettled();
    await tick();
    await srv.answer(0, error, 'fail');
    await expect(waiting).resolves.toBe(outcome);
  });
test('flushSettled без ответа освобождает ожидание через 30с без повторов', async () => {
  const srv = gatedServer();
  const s = setup({ respond: srv.respond });
  act(() => s.api().onDocChange(ONE));
  const waiting = s.api().flushSettled();
  await tick(30_000);
  await expect(waiting).resolves.toBe('offline');
  expect(s.updates()).toHaveLength(1);
});

test('rewrite удерживает записи старого документа, late набор сохранён предложением; failure unlock и old token не трогает новый', async () => {
  const s = setup();
  let old: ((revision?: number) => void) | undefined;
  act(() => {
    old = s.api().beginRewrite();
  });
  expect(s.api().rewritePending).toBe(true);
  act(() => s.api().onDocChange(TWO));
  await tick(SAVE_PAUSE);
  expect(s.updates()).toHaveLength(0);
  expect(s.api().pendingDraft?.doc).toEqual(TWO);
  let next: ((revision?: number) => void) | undefined;
  act(() => {
    next = s.api().beginRewrite();
    old?.();
  });
  expect(s.api().rewritePending).toBe(true);
  act(() => next?.());
  expect(s.api().rewritePending).toBe(false);
});

for (const failure of ['timeout', 'transport'] as const)
  test(`flush ${failure}: новый queued набор досылается один раз, отказ ожидания не отправляет undo`, async () => {
    const srv = gatedServer();
    const s = setup({ respond: srv.respond });
    const remove = registerBodyFlush('e1', () => s.api().flushSettled());
    try {
      act(() => s.api().onDocChange(ONE));
      act(() => s.api().flush());
      act(() => s.api().onDocChange(TWO));
      const undo = runUndo('action', { entityIds: ['e1'] });
      await tick();
      expect(s.updates()).toHaveLength(1);
      if (failure === 'timeout') await tick(30_000);
      else await srv.answer(0, new Error('нет ответа'), 'fail');
      await expect(undo).resolves.toEqual({ kind: 'failed', message: UNDO_OFFLINE });
      expect(s.updates()).toHaveLength(2);
      expect((s.updates()[1]?.input as { bodyDoc: BodyDoc }).bodyDoc).toEqual(TWO);
      expect(s.stray()).toEqual([]);
      await tick(60_000);
      expect(s.updates()).toHaveLength(2);
      expect(s.stray()).toEqual([]);
    } finally {
      remove();
    }
  });

import { resetUndoSession } from '../undo/undo-epoch';

test('Task18: per-call callback старой сессии не повышает ревизию живого редактора', async () => {
  const server = gatedServer();
  const s = setup({ respond: server.respond });
  s.api().onDocChange(ONE);
  await tick(SAVE_PAUSE);
  expect(s.updates()).toHaveLength(1);
  setDraftScope('t18-new-owner');
  resetUndoSession();
  await server.answer(0, SAVED);
  expect(s.api().revisionForRewrite()).toBe(3);
});

test('Task18: смена epoch тем же редактором освобождает old waiter и не освобождает новый flight', async () => {
  const server = gatedServer();
  const s = setup({ respond: server.respond });
  s.api().onDocChange(ONE);
  await tick(SAVE_PAUSE);
  let settled: unknown;
  void s
    .api()
    .flushSettled()
    .then((value) => {
      settled = value;
    });
  setDraftScope('t18-new-owner');
  resetUndoSession();
  s.rerender();
  await tick();
  expect(settled).toBe('nothing');
  s.api().onDocChange(TWO);
  await tick(SAVE_PAUSE);
  expect(s.updates()).toHaveLength(2);
  await server.answer(0, SAVED);
  expect(s.api().state).toBe('saving');
  expect(s.api().revisionForRewrite()).toBe(3);
  await server.answer(1, SAVED);
  await tick();
  expect(s.api().state).toBe('idle');
  expect(s.api().revisionForRewrite()).toBe(4);
});

test('Task18: старый render flush до уведомления epoch не пишет и не отправляет чужой draft', async () => {
  const s = setup();
  s.api().onDocChange(ONE);
  const old = s.api();
  setDraftScope('t18-new-owner');
  act(() => {
    resetUndoSession();
    old.flush();
  });
  await tick();
  expect(s.updates()).toHaveLength(0);
  expect(readDraft('e1')).toBeNull();
  s.api().onDocChange(TWO);
  await tick(SAVE_PAUSE);
  expect(s.updates()).toHaveLength(1);
  expect((s.updates()[0]?.input as { bodyDoc: BodyDoc }).bodyDoc).toEqual(TWO);
});

test('Task18: epoch после flight сохраняет последние pending слова, old closure не пишет новый draft', async () => {
  const server = gatedServer();
  const s = setup({ respond: server.respond });
  s.api().onDocChange(ONE);
  await tick(SAVE_PAUSE);
  s.api().onDocChange(TWO);
  const old = s.api();
  const ownerKey =
    Object.keys(localStorage).find((k) => k.startsWith('orbis:body-draft:') && k.endsWith(':e1')) ??
    '';
  expect(ownerKey).not.toBe('');
  setDraftScope('t18-new-owner');
  resetUndoSession();
  await tick();
  expect(localStorage.getItem(ownerKey)).toContain('тело, правка и ещё одна');
  expect(readDraft('e1')).toBeNull();
  s.api().onDocChange(THREE);
  old.flush();
  expect(localStorage.getItem(ownerKey)).not.toContain('совсем другое тело');
  expect(readDraft('e1')).toBeNull();
  await tick(SAVE_PAUSE);
  expect(s.updates()).toHaveLength(2);
  await server.answer(0, SAVED);
  expect(s.api().state).toBe('saving');
  await server.answer(1, SAVED);
  expect(s.api().state).toBe('idle');
});

for (const dismiss of [false, true])
  test(`Task18: epoch preserves offered foreign disk slot ${dismiss}`, async () => {
    const foreign = { ...THREE, v: 999 };
    captureDraftWriter('e1')(foreign, 3, new Date().toISOString());
    const stored = localStorage.getItem('orbis:body-draft::e1');
    const s = setup();
    await tick();
    expect(s.api().pendingDraft?.foreignSchema).toBe(true);
    if (dismiss) s.api().dismissPendingDraft();
    s.api().onDocChange(TWO);
    setDraftScope('t18-new-owner');
    resetUndoSession();
    await tick();
    expect(localStorage.getItem('orbis:body-draft::e1')).toBe(stored);
    expect(readDraft('e1')).toBeNull();
    expect(s.updates()).toHaveLength(0);
  });

test('Task18: epoch сохраняет собственный exact rejected draft без снятия приговора', async () => {
  const server = gatedServer();
  const s = setup({ respond: server.respond });
  s.api().onDocChange(ONE);
  await tick(SAVE_PAUSE);
  await server.answer(0, trpcError('BAD_REQUEST'), 'fail');
  setDraftScope('t18-new-owner');
  resetUndoSession();
  await tick();
  const draft = JSON.parse(localStorage.getItem('orbis:body-draft::e1') ?? 'null');
  expect(draft).toMatchObject({ doc: ONE, rejected: true, baseRevision: 3 });
  expect(readDraft('e1')).toBeNull();
  expect(s.updates()).toHaveLength(1);
});

test('R65: eager RefField берёт единую строку класса без runtime controller функций', () => {
  expect(
    runtimeImports('../../lib/entity-ref/RefField.tsx').filter((s) =>
      /registry\/controls$/.test(s),
    ),
  ).toEqual([]);
});

test('R63: создание подзадачи отделено от eager списка и его чтений', () => {
  expect(
    runtimeImports('../entity-detail/Subtasks.tsx').filter((s) => /trpc|SubtaskAdd/.test(s)),
  ).toEqual([]);
  expect(
    runtimeImports('../entity-detail/record-blocks.tsx').filter((s) => /SubtaskAdd/.test(s)),
  ).toEqual([]);
  expect(runtimeImports('../entity-detail/SubtaskAdd.tsx')).toContain('../../trpc');
});
test('R61: eager фасад формы не экспортирует runtime view или policy', () => {
  expect(
    runtimeImports('../entity-detail/AspectSection.tsx').filter((s) =>
      /PropertyControl|AspectSectionView|property-edit-rule/.test(s),
    ),
  ).toEqual([]);
  expect(readModule('../entity-detail/AspectSection.tsx')).not.toMatch(
    /export\s*\{[^}]*propertyEditRule/,
  );
  expect(runtimeImports('../entity-detail/AspectSectionView.tsx')).toContain(
    '../../lib/registry/PropertyControl',
  );
});
