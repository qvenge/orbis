import { type BodyDoc, parseBody } from '@orbis/shared/doc';
import { act, screen } from '@testing-library/react';
import { useEffect, useState } from 'react';
import { beforeEach, expect, test, vi } from 'vitest';
import { installCrashTrap, renderWithProviders, trpcError } from '../../test/harness';
import { trpc } from '../../trpc';
import { detailGetInput } from '../entity-detail/useEntityDetail';
import { SaveIndicator } from './SaveIndicator';
import { type BodySave, type BodySaveEntity, useBodySave } from './useBodySave';

// Черновик живёт в отложенных колбэках ровно как и само сохранение: ошибка оттуда до ассертов
// не доезжает, прогон краснеет КОДОМ ВОЗВРАТА при зелёных тестах. Ставится файлом, см. harness.
installCrashTrap();

// --- стенд ----------------------------------------------------------------------------------

/**
 * Ключ выписан СТРОКОЙ, а не взят из draft-storage, и это намеренно: ключ — договор с диском
 * браузера, переживающий перезагрузку и обновление приложения. Импортируй тест ту же константу,
 * он остался бы зелёным при переименовании ключа — то есть при молчаливой потере всех черновиков,
 * набранных прошлой версией.
 */
const KEY = 'orbis:body-draft:e1';

const BASE = parseBody('тело');
const ONE = parseBody('тело и правка');
const TWO = parseBody('тело, правка и ещё одна');
const THREE = parseBody('совсем другое тело');

/** Сущность на момент открытия: `updatedAt` намеренно далёк от системного времени прогона. */
const ENTITY: BodySaveEntity = { updatedAt: '2026-08-14T10:00:00.000Z', bodyDoc: BASE };
/** Соседняя запись: её `updatedAt` РАНЬШЕ всего, что вернёт сервер по первой. */
const SECOND: BodySaveEntity = { updatedAt: '2026-08-14T10:30:00.000Z', bodyDoc: BASE };
/** Та же запись, но сервер её с тех пор двигали: метка ПОЗЖЕ той, на которой набран черновик. */
const MOVED: BodySaveEntity = { updatedAt: '2026-08-14T12:00:00.000Z', bodyDoc: THREE };
/** Ответ сервера на entity.update. */
const SAVED = { id: 'e1', updatedAt: '2026-08-14T11:00:00.000Z' };

type Respond = (input: unknown) => unknown;
const ok: Respond = () => SAVED;
const fail500: Respond = () => {
  throw trpcError('INTERNAL_SERVER_ERROR');
};

/** Пороги записаны ЧИСЛАМИ: значение — договор, а не деталь (см. save.test.tsx про M1). */
const SAVE_PAUSE = 2000;
/** Выдержка, после которой запрос считается зависшим и запись перестаёт быть заперта. */
const GIVE_UP = 30_000;

/** Потолок отправок на стенд: замкнувшийся круг сохранения не краснеет, а ВЕШАЕТ прогон. */
const MAX_SENDS = 12;

/** Сервер, который отвечает не сам, а когда скажут (и может не ответить вовсе). */
function gatedServer() {
  const gates: { settle: (v: unknown) => void; fail: (e: unknown) => void }[] = [];
  const respond: Respond = () =>
    new Promise((resolve, reject) => {
      gates.push({ settle: resolve, fail: reject });
    });
  const answer = async (i: number, value: unknown, mode: 'ok' | 'fail' = 'ok') => {
    const gate = gates[i];
    if (gate === undefined) throw new Error(`запроса №${i} не было — отвечать нечему`);
    await act(async () => {
      if (mode === 'ok') gate.settle(value);
      else gate.fail(value);
      await vi.advanceTimersByTimeAsync(0);
    });
  };
  return { respond, answer };
}

type Props = { id: string; entity: BodySaveEntity };

function mount(
  opts: { id?: string; entity?: BodySaveEntity; respond?: Respond; strict?: boolean } = {},
) {
  const box = { respond: opts.respond ?? ok };
  const initial: Props = { id: opts.id ?? 'e1', entity: opts.entity ?? ENTITY };
  const hold: { api: BodySave | null; set: ((p: Props) => void) | null } = { api: null, set: null };
  /** Сколько раз прогнан эффект монтирования — страж вакуумности для StrictMode. */
  const runs = { mountEffect: 0 };

  function Parent() {
    const [props, setProps] = useState(initial);
    hold.set = setProps;
    const api = useBodySave(props.id, props.entity);
    hold.api = api;
    useEffect(() => {
      runs.mountEffect += 1;
    }, []);
    // Индикатор в дереве: «зависший запрос вечно показывает „Сохраняем…“» — половина
    // претензии к долгу Задачи 13, и проверять её надо на разметке, а не на поле состояния.
    return <SaveIndicator state={api.state} />;
  }

  // Мок СТРОГИЙ и функцией: у сохранения тела ровно один путь наружу, и «мутаций нет»
  // обязано значить «в сеть не ходили вовсе».
  let sends = 0;
  const r = renderWithProviders(
    <Parent />,
    (path, input) => {
      if (path !== 'entity.update') throw new Error(`сохранение тела не ходит на ${path}`);
      sends += 1;
      if (sends > MAX_SENDS) return new Promise(() => {});
      return box.respond(input);
    },
    { strict: opts.strict },
  );

  return {
    container: r.container,
    mountEffectRuns: () => runs.mountEffect,
    api: () => hold.api as BodySave,
    updates: () => r.calls.filter((c) => c.path === 'entity.update'),
    input: (i: number) => r.calls.filter((c) => c.path === 'entity.update')[i]?.input,
    unmount: () => act(() => r.unmount()),
    serve: (respond: Respond) => {
      box.respond = respond;
    },
    set: async (p: Props) => {
      await act(async () => {
        hold.set?.(p);
      });
    },
    apply: async () => {
      await act(async () => {
        (hold.api as BodySave).applyPendingDraft();
      });
    },
    discard: async () => {
      await act(async () => {
        (hold.api as BodySave).discardPendingDraft();
      });
    },
  };
}

async function tick(ms = 0): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/**
 * Тот же документ, но с блочными id, как их проставляет UniqueID отдельной транзакцией уже
 * после монтирования редактора. Ровно это редактор и присылает первым `onDocChange`.
 */
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

/** Что лежит в хранилище — СЫРЬЁМ, мимо readDraft: тест не должен верить читателю на слово. */
const raw = (key = KEY) => localStorage.getItem(key);
const stored = (key = KEY) => JSON.parse(raw(key) as string) as Record<string, unknown>;

/**
 * Оставить в хранилище неотправленный черновик и уйти со страницы. Отказ сети — 500, НЕ
 * терминальный: у терминального своя судьба (см. соответствующий тест).
 */
async function leaveDraft(doc: BodyDoc = ONE): Promise<void> {
  const s = mount({ respond: fail500 });
  s.api().onDocChange(doc);
  await tick(SAVE_PAUSE);
  expect(s.updates(), 'премиса: отправка была').toHaveLength(1);
  expect(raw(), 'премиса: черновик лёг в хранилище').not.toBeNull();
  s.unmount();
}

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers().setSystemTime(new Date('2030-01-01T00:00:00.000Z'));
  return () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  };
});

// --- запись и стирание ------------------------------------------------------------------------

test('неотправленная правка попадает в хранилище', async () => {
  const s = mount({ respond: fail500 });
  s.api().onDocChange(ONE);
  // Страж: пока идёт пауза, правка ещё собирается — черновика нет и быть не должно.
  expect(raw()).toBeNull();

  await tick(SAVE_PAUSE);
  expect(s.updates()).toHaveLength(1);
  expect(stored()).toEqual({
    doc: ONE,
    baseUpdatedAt: ENTITY.updatedAt,
    savedAt: '2030-01-01T00:00:02.000Z',
    rejected: false,
  });
});

test('успешное сохранение стирает черновик', async () => {
  const server = gatedServer();
  const s = mount({ respond: server.respond });
  s.api().onDocChange(ONE);
  await tick(SAVE_PAUSE);
  // Премиса: до ответа сервера черновик ЛЕЖИТ — иначе проверка ниже прошла бы вхолостую.
  expect(raw()).not.toBeNull();

  await server.answer(0, SAVED);
  expect(raw()).toBeNull();
  expect(s.updates()).toHaveLength(1);
});

test('черновик пишется с той же меткой, что уехала в expectedUpdatedAt', async () => {
  // Иначе черновик второго сохранения подряд лёг бы с ПРОТУХШЕЙ базой, и при возврате хук
  // предложил бы выбор («сервер изменился») там, где изменил его сам же — то есть спрашивал
  // бы человека о собственной записи.
  const s = mount();
  s.api().onDocChange(ONE);
  await tick(SAVE_PAUSE); // успех: подтверждённый updatedAt — SAVED.updatedAt
  expect(raw()).toBeNull();

  s.serve(fail500);
  s.api().onDocChange(TWO);
  await tick(SAVE_PAUSE);
  expect(stored().baseUpdatedAt).toBe(SAVED.updatedAt);
  expect((s.input(1) as { expectedUpdatedAt: string }).expectedUpdatedAt).toBe(SAVED.updatedAt);
  // Страж вакуумности: две метки ДОЛЖНЫ различаться, иначе проверка выше ни о чём.
  expect(SAVED.updatedAt).not.toBe(ENTITY.updatedAt);
});

test('правку вернули к сохранённому — черновик снимается', async () => {
  // Сохранять нечего, и держать на диске «неотправленное», равное содержимому базы, значит
  // при следующем открытии либо гонять пустую мутацию, либо спрашивать человека ни о чём.
  const s = mount({ respond: fail500 });
  s.api().onDocChange(ONE);
  await tick(SAVE_PAUSE);
  expect(raw()).not.toBeNull(); // премиса

  s.api().onDocChange(parseBody('тело')); // тот же текст, что в базе
  await tick(SAVE_PAUSE);
  expect(raw()).toBeNull();
  expect(s.updates()).toHaveLength(1); // и в сеть за этим не ходили
});

test('успех по прежней записи стирает ЕЁ черновик, а не черновик соседней', async () => {
  // Стирание идёт по id из замыкания запроса и ДО отсечки по поколению. Уйди человек на
  // соседнюю запись, пока шёл запрос, черновик первой остался бы на диске уже сохранённым —
  // и следующее её открытие предложило бы «вернуть» текст, который и так в базе.
  const server = gatedServer();
  const s = mount({ respond: server.respond });
  s.api().onDocChange(ONE);
  await tick(SAVE_PAUSE);
  expect(raw()).not.toBeNull(); // премиса

  // У соседней записи свой черновик — он обязан уцелеть. Метка у него РАЗОШЛАСЬ с записью:
  // так он остаётся предложением и не тратится на автодосыл, то есть чист для проверки ниже.
  localStorage.setItem(
    'orbis:body-draft:e2',
    JSON.stringify({ doc: ONE, baseUpdatedAt: '2026-08-14T09:00:00.000Z', savedAt: 'x' }),
  );
  await s.set({ id: 'e2', entity: { updatedAt: '2026-08-14T10:30:00.000Z', bodyDoc: THREE } });
  await server.answer(0, SAVED);

  expect(raw()).toBeNull();
  expect(raw('orbis:body-draft:e2')).not.toBeNull();
});

// --- возврат ------------------------------------------------------------------------------------

test('черновик читается после перемонтирования', async () => {
  await leaveDraft();

  const s = mount({ entity: MOVED });
  await tick();
  expect(s.api().pendingDraft).toEqual({
    doc: ONE,
    savedAt: '2030-01-01T00:00:02.000Z',
    rejected: false,
  });
});

test('при неизменившемся updatedAt черновик уходит сам', async () => {
  await leaveDraft();

  // Сервер с тех пор не менялся — спрашивать не о чем.
  const s = mount({ entity: ENTITY });
  await tick();
  expect(s.updates()).toHaveLength(1);
  expect(s.input(0)).toEqual({ id: 'e1', bodyDoc: ONE, expectedUpdatedAt: ENTITY.updatedAt });
  // И человека при этом ни о чём не спросили.
  expect(s.api().pendingDraft).toBeNull();
  // Успех досыла черновик снимает: второй раз он не уедет.
  expect(raw()).toBeNull();
});

test('черновик, уже совпавший с телом записи, не уезжает вторично', async () => {
  // Досыл ушёл, ответ не доехал, вкладку закрыли: на диске остался черновик, который сервер
  // уже принял. Открытие записи не должно возвращать фантомную правку — сравнение по смыслу
  // ловит это раньше сети.
  await leaveDraft();

  const s = mount({ entity: { updatedAt: ENTITY.updatedAt, bodyDoc: ONE } });
  await tick(SAVE_PAUSE * 2);
  expect(s.updates()).toEqual([]);
  expect(raw()).toBeNull(); // и с диска снят: держать его больше незачем
});

test('при изменившемся updatedAt автодосыла НЕТ — предлагается выбор', async () => {
  await leaveDraft();

  const s = mount({ entity: MOVED });
  await tick(SAVE_PAUSE * 3);
  // Правило нарочно грубое и честное: сравнили метку, спросили человека. Сюда потом встанет
  // слияние, не переделывая ничего вокруг.
  expect(s.updates()).toEqual([]);
  expect(s.api().pendingDraft?.doc).toEqual(ONE);
  // Страж вакуумности: метки ДОЛЖНЫ различаться, иначе тест проверяет ветку автодосыла.
  expect(MOVED.updatedAt).not.toBe(ENTITY.updatedAt);

  // Положительный контроль: молчание выше — про выбор, а не про мёртвый хук.
  s.api().onDocChange(TWO);
  await tick(SAVE_PAUSE);
  expect(s.updates()).toHaveLength(1);
});

test('двойной прогон эффекта (StrictMode) не досылает черновик дважды', async () => {
  // Приложение живёт под StrictMode (main.tsx), а он прогоняет эффект монтирования ДВАЖДЫ.
  // Без памяти о том, что черновик этой записи уже разобран, второй проход отправил бы его
  // повторно: две мутации на одно возвращение, две записи в журнале, два круга инвалидации.
  await leaveDraft();

  const s = mount({ entity: ENTITY, strict: true });
  await tick();
  // Страж вакуумности: эффекты здесь ДЕЙСТВИТЕЛЬНО прогоняются дважды, иначе тест ни о чём.
  // (Замерено: двойной прогон включается, только когда StrictMode — самый верхний элемент
  // render; переданный внутри дерева, он не делает ничего. См. renderWithProviders.)
  expect(s.mountEffectRuns()).toBe(2);
  expect(s.updates()).toHaveLength(1);

  // И ГЛАВНОЕ: досыл уехал через ЖИВОГО наблюдателя — его ответ дошёл. Отправь его первый,
  // сносимый проход, колбэки не позвались бы вовсе: запись осталась бы «в полёте» навсегда,
  // индикатор — на «Сохраняем…», а черновик так и лежал бы на диске уже сохранённым.
  expect(s.container).toBeEmptyDOMElement();
  expect(raw()).toBeNull();

  // Положительный контроль: обычное сохранение поверх этого работает.
  s.api().onDocChange(TWO);
  await tick(SAVE_PAUSE);
  expect(s.updates()).toHaveLength(2);
});

test('двойной прогон эффекта не досылает дважды и при ОТКАЗЕ', async () => {
  // Отказ — отдельный случай, и без него дефект не виден: при успехе документ снимается с
  // очереди своим же onSuccess, и лишний досыл находит её пустой. При отказе документ остаётся
  // на руках, и лишняя отправка уходит по-настоящему — то есть заводится «отказ → повтор»,
  // которого у сохранения нет нигде больше.
  await leaveDraft();

  const s = mount({ entity: ENTITY, strict: true, respond: fail500 });
  await tick();
  expect(s.mountEffectRuns()).toBe(2); // страж вакуумности
  expect(s.updates()).toHaveLength(1);
  expect(screen.getByText('Не сохранено')).toBeInTheDocument();
  // Черновик уцелел: отправить не вышло, терять текст не за что.
  expect(stored().doc).toEqual(ONE);

  // И повтора не заводится дальше сам по себе.
  await tick(SAVE_PAUSE * 3);
  expect(s.updates()).toHaveLength(1);
});

test('ушли с экрана раньше, чем досыл успел уехать, — он не уезжает вовсе', async () => {
  // Открыли запись и тут же ушли. Досыл, переживший уход, отправился бы от имени хука,
  // которого уже никто не держит: наблюдателя мутации снесли вместе с экраном, и ОТВЕТА на
  // такой запрос клиент не услышит никогда — черновик так и останется на диске уже
  // сохранённым, а следующее открытие предложит вернуть текст, который и так в базе.
  await leaveDraft();

  const s = mount({ entity: ENTITY, strict: true });
  s.unmount(); // до первого же тика: таймер досыла заведён, но ещё не сработал
  await tick(SAVE_PAUSE * 2);
  expect(s.updates()).toEqual([]);
  expect(raw(), 'черновик цел — его никто не отправлял').not.toBeNull();

  // Положительный контроль: тот же черновик уезжает, если с экрана не уходить.
  const stay = mount({ entity: ENTITY });
  await tick();
  expect(stay.updates()).toHaveLength(1);
});

test('запись без поля rejected читается как не отвергнутая', async () => {
  // Так выглядят черновики, сложенные версией приложения до появления пометки. Считать их
  // отвергнутыми значит спрашивать человека там, где спрашивать не о чем, — а по факту
  // придерживать текст, который спокойно доехал бы сам.
  localStorage.setItem(
    KEY,
    JSON.stringify({ doc: ONE, baseUpdatedAt: ENTITY.updatedAt, savedAt: 'x' }),
  );

  const s = mount({ entity: ENTITY });
  await tick();
  expect(s.updates()).toHaveLength(1);
  expect(s.input(0)).toEqual({ id: 'e1', bodyDoc: ONE, expectedUpdatedAt: ENTITY.updatedAt });
});

test('черновик чужой сущности не подставляется', async () => {
  await leaveDraft();

  // У соседней записи метка ТА ЖЕ, что у первой: спутай хранилище записи, черновик уехал бы
  // автодосылом — молча и в чужое тело.
  const other = mount({ id: 'e2', entity: { updatedAt: ENTITY.updatedAt, bodyDoc: THREE } });
  await tick(SAVE_PAUSE * 2);
  expect(other.updates()).toEqual([]);
  expect(other.api().pendingDraft).toBeNull();
  other.unmount();

  // Положительный контроль: черновик НИКУДА не делся и своей записью подхватывается.
  const own = mount({ entity: ENTITY });
  await tick();
  expect(own.updates()).toHaveLength(1);
});

test('смена записи гасит предложенный черновик, а не переносит его на соседнюю', async () => {
  await leaveDraft();

  const s = mount({ entity: MOVED });
  await tick();
  expect(s.api().pendingDraft?.doc).toEqual(ONE); // премиса: на первой записи выбор предложен

  await s.set({ id: 'e2', entity: { updatedAt: '2026-08-14T10:30:00.000Z', bodyDoc: THREE } });
  await tick();
  expect(s.api().pendingDraft).toBeNull();
  expect(s.updates()).toEqual([]);

  // Положительный контроль: возврат к первой записи снова предлагает её черновик — молчание
  // выше про соседнюю запись, а не про потерянный черновик.
  await s.set({ id: 'e1', entity: MOVED });
  await tick();
  expect(s.api().pendingDraft?.doc).toEqual(ONE);
});

// --- выбор человека -----------------------------------------------------------------------------

test('applyPendingDraft шлёт черновик с ТЕКУЩИМ updatedAt', async () => {
  await leaveDraft();

  const s = mount({ entity: MOVED });
  await tick();
  expect(s.updates()).toEqual([]); // премиса: сам не ушёл

  await s.apply();
  await tick();
  expect(s.updates()).toHaveLength(1);
  // ТЕКУЩИЙ updatedAt, а не тот, на котором черновик набирался: правка сознательно кладётся
  // поверх чужой. Уйди она со старой меткой, сервер ответил бы 409 — то есть кнопка «оставить
  // моё» не делала бы ничего.
  expect(s.input(0)).toEqual({ id: 'e1', bodyDoc: ONE, expectedUpdatedAt: MOVED.updatedAt });
  expect(s.api().pendingDraft).toBeNull(); // выбор сделан — предлагать больше нечего
});

test('discardPendingDraft стирает черновик и в сеть не ходит', async () => {
  await leaveDraft();

  const s = mount({ entity: MOVED });
  await tick();
  expect(raw(), 'премиса: черновик на диске').not.toBeNull();

  await s.discard();
  expect(raw()).toBeNull();
  expect(s.api().pendingDraft).toBeNull();
  await tick(SAVE_PAUSE * 3);
  expect(s.updates()).toEqual([]);

  // Положительный контроль: перемонтирование больше ничего не предлагает — стёрли по-настоящему.
  s.unmount();
  const again = mount({ entity: MOVED });
  await tick();
  expect(again.api().pendingDraft).toBeNull();
});

// --- терминальный отказ ---------------------------------------------------------------------------

test('терминальный отказ метит черновик: он не досылается сам, но и не пропадает молча', async () => {
  // VALIDATION серверного гейта (структурно битый документ или чужая версия схемы) приезжает
  // как BAD_REQUEST. Досылать такой черновик бессмысленно — тот же документ отвергнут снова, —
  // но и стереть его значит молча выбросить набранный человеком текст.
  const s = mount({
    respond: () => {
      throw trpcError('BAD_REQUEST', 'документ не соответствует схеме — правка отклонена');
    },
  });
  s.api().onDocChange(ONE);
  await tick(SAVE_PAUSE);
  expect(s.updates()).toHaveLength(1);
  expect(stored()).toMatchObject({ doc: ONE, rejected: true });
  s.unmount();

  // Метка сервера НЕ менялась — то есть это ровно та ветка, где черновик ушёл бы автодосылом.
  const back = mount({ entity: ENTITY });
  await tick(SAVE_PAUSE * 3);
  expect(back.updates()).toEqual([]);
  expect(back.api().pendingDraft).toEqual({
    doc: ONE,
    savedAt: '2030-01-01T00:00:02.000Z',
    rejected: true,
  });
  back.unmount();

  // Положительный контроль: снимаем ровно пометку — и та же запись при той же метке уезжает
  // автодосылом. Значит молчание выше от пометки, а не от чего-то ещё.
  localStorage.setItem(KEY, JSON.stringify({ ...stored(), rejected: false }));
  const control = mount({ entity: ENTITY });
  await tick();
  expect(control.updates()).toHaveLength(1);
});

// --- досыл при уходе: судьба черновика (ревью раунда 1, I-1) --------------------------------
//
// Досыл из уборки эффекта уходит через наблюдателя, которого React уже отцепил, а поштучные
// колбэки `mutate` библиотека зовёт только при живых слушателях
// (@tanstack/query-core, mutationObserver.js:77 — `if (this.#mutateOptions && this.hasListeners())`).
// Значит вся бухгалтерия диска обязана жить на УРОВНЕ МУТАЦИИ — там же, где оптимистичный
// патч и его откат: он исполняется всегда.

test('успешный досыл при уходе снимает черновик с диска', async () => {
  // Иначе черновик переживает собственное сохранение: следующее открытие записи увидит его на
  // диске, сверит метки и — если запись с тех пор двигали — предложит «вернуть» текст, который
  // и так в базе.
  const s = mount();
  s.api().onDocChange(ONE);
  // Страж: до ухода отправки не было вовсе — иначе проверка ниже говорила бы не о досыле.
  expect(s.updates()).toEqual([]);

  await s.unmount();
  expect(s.updates(), 'премиса: досыл ушёл').toHaveLength(1);
  await tick();

  expect(raw()).toBeNull();
});

test('терминальный отказ на досыле при уходе метит черновик', async () => {
  // Худшая половина той же щели: без пометки следующее открытие записи молча дошлёт обречённый
  // документ и выключит ей сохранение до перезагрузки — ровно то, против чего пометка заведена.
  const s = mount({
    respond: () => {
      throw trpcError('BAD_REQUEST', 'документ не соответствует схеме — правка отклонена');
    },
  });
  s.api().onDocChange(ONE);
  expect(s.updates()).toEqual([]);

  await s.unmount();
  expect(s.updates(), 'премиса: досыл ушёл').toHaveLength(1);
  await tick();

  expect(stored()).toMatchObject({ doc: ONE, rejected: true });

  // Положительный контроль: пометка настоящая — следующее открытие записи черновик НЕ досылает
  // и предлагает выбор. Без него «rejected: true» на диске было бы просто строкой.
  const back = mount({ entity: ENTITY });
  await tick(SAVE_PAUSE * 3);
  expect(back.updates()).toEqual([]);
  expect(back.api().pendingDraft).toMatchObject({ doc: ONE, rejected: true });
});

test('уход с записи не воскрешает отвергнутый черновик', async () => {
  // Щель, вскрывшаяся при подключении экрана (Задача 15). Размонтирование теперь ДОСЫЛАЕТ
  // отложенное, а `save` первым делом кладёт черновик на диск — и `saveDraft` пишет
  // `rejected: false` всегда, потому что он про «набрано и не отправлено», а не про приговор
  // сервера. Без сверки по документу уход с записи стирал бы пометку, и следующее открытие
  // дослало бы обречённый документ молча, заодно выключив записи сохранение до перезагрузки.
  //
  // Тот же путь и у `flush()` экрана — это не про размонтирование как таковое.
  const s = mount({
    respond: () => {
      throw trpcError('BAD_REQUEST', 'документ не соответствует схеме');
    },
  });
  s.api().onDocChange(ONE);
  await tick(SAVE_PAUSE);
  expect(stored(), 'премиса: приговор записан').toMatchObject({ doc: ONE, rejected: true });

  await s.unmount();
  expect(stored()).toMatchObject({ doc: ONE, rejected: true });

  // Положительный контроль В ТОМ ЖЕ ТЕСТЕ: пометка держится за ДОКУМЕНТ, а не за факт отказа.
  // Набранное ПОСЛЕ приговора сервер не видел — объявлять отвергнутым его нельзя, иначе человеку
  // сказали бы неправду, а его текст лишился бы автодосыла ни за что.
  // Сервер отвечает 500 (не терминально): успех стёр бы черновик с диска, и смотреть было бы
  // не на что.
  const again = mount({ entity: ENTITY, respond: fail500 });
  again.api().onDocChange(TWO);
  await tick(SAVE_PAUSE);
  expect(stored()).toMatchObject({ doc: TWO, rejected: false });
});

test('после терминального отказа applyPendingDraft всё же пробует отправить', async () => {
  // Остановка терминальна для НАБОРА (каждое нажатие иначе уходило бы в сеть обречённым
  // запросом), но не для явного жеста человека: чужая версия схемы лечится обновлением
  // приложения, и единственная кнопка, которой он может распорядиться своим текстом, не
  // должна молча не делать ничего.
  await leaveDraft();
  const s = mount({
    entity: MOVED,
    respond: () => {
      throw trpcError('BAD_REQUEST', 'документ не соответствует схеме — правка отклонена');
    },
  });
  await tick();
  expect(s.api().pendingDraft?.doc).toEqual(ONE);

  // Набор в этой сессии уже нарвался на терминальный отказ.
  s.api().onDocChange(TWO);
  await tick(SAVE_PAUSE);
  expect(s.updates()).toHaveLength(1);
  s.api().onDocChange(THREE);
  await tick(SAVE_PAUSE);
  expect(s.updates(), 'премиса: набор остановлен').toHaveLength(1);

  await s.apply();
  await tick();
  expect(s.updates()).toHaveLength(2);
  expect((s.input(1) as { bodyDoc: BodyDoc }).bodyDoc).toEqual(ONE);
});

// --- хранилище подводит -----------------------------------------------------------------------

test('битая запись в хранилище игнорируется, а не роняет экран', async () => {
  // Первые пять отсекаются на внешней форме записи, ПОСЛЕДНИЕ ТРИ — только на форме самого
  // документа (И-4): без них строки про `v` и внутренний узел не исполняются ни разу, и мутант,
  // снимающий именно их, выжил бы. А отсекать их обязательно: `doc` отсюда уезжает прямо в
  // мутацию, и структурно битый документ серверный гейт отвергает ТЕРМИНАЛЬНО — то есть одна
  // испорченная запись выключила бы записи сохранение до перезагрузки.
  for (const broken of [
    '{не json',
    '"строка"',
    'null',
    '{"doc":5,"baseUpdatedAt":"a"}',
    '{}',
    '{"doc":{"v":"1","doc":{"type":"doc"}},"baseUpdatedAt":"a","savedAt":"b"}',
    '{"doc":{"v":1,"doc":null},"baseUpdatedAt":"a","savedAt":"b"}',
    '{"doc":{"v":1},"baseUpdatedAt":"a","savedAt":"b"}',
    // А эти две — с ЦЕЛЫМ документом и битой оболочкой: без них проверка меток не исполняется
    // ни разу. Черновик без `baseUpdatedAt` сравнивать не с чем, и он ушёл бы в предложение —
    // то есть человека спросили бы про текст неизвестно какой давности.
    '{"doc":{"v":1,"doc":{"type":"doc"}},"savedAt":"b"}',
    '{"doc":{"v":1,"doc":{"type":"doc"}},"baseUpdatedAt":123,"savedAt":"b"}',
  ]) {
    localStorage.setItem(KEY, broken);
    const s = mount({ entity: ENTITY });
    await tick(SAVE_PAUSE * 2);
    // Ни автодосыла мусора (его серверный гейт отверг бы терминально — и сохранение записи
    // выключилось бы до перезагрузки), ни предложения вернуть непонятно что.
    expect(s.updates(), broken).toEqual([]);
    expect(s.api().pendingDraft, broken).toBeNull();
    s.unmount();
  }

  // Положительный контроль: правильно сложенная запись тем же читателем подхватывается —
  // молчание выше от битости, а не от того, что читатель всегда возвращает null.
  localStorage.setItem(
    KEY,
    JSON.stringify({ doc: ONE, baseUpdatedAt: ENTITY.updatedAt, savedAt: 'x', rejected: false }),
  );
  const good = mount({ entity: ENTITY });
  await tick();
  expect(good.updates()).toHaveLength(1);
});

test('отключённое хранилище не роняет набор текста', async () => {
  // Черновик — страховка, а не главный путь: приватный режим и переполненная квота не повод
  // терять правку, которая прямо сейчас уезжает на сервер.
  const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('QuotaExceededError');
  });
  const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new Error('SecurityError');
  });

  const s = mount({ entity: ENTITY });
  await tick();
  expect(s.api().pendingDraft).toBeNull();
  s.api().onDocChange(ONE);
  await tick(SAVE_PAUSE);
  expect(s.updates()).toHaveLength(1);
  expect(s.input(0)).toEqual({ id: 'e1', bodyDoc: ONE, expectedUpdatedAt: ENTITY.updatedAt });

  // Успех тоже не спотыкается о стирание.
  await tick();
  expect(s.container).toBeEmptyDOMElement();
  s.unmount();

  // Положительный контроль: с исправным хранилищем тот же путь черновик ПИШЕТ — то есть
  // молчание выше от заглушки, а не от того, что запись убрали вовсе.
  set.mockRestore();
  get.mockRestore();
  const alive = mount({ respond: fail500 });
  alive.api().onDocChange(ONE);
  await tick(SAVE_PAUSE);
  expect(raw()).not.toBeNull();
});

// --- зависший запрос (долг Задачи 13) -------------------------------------------------------------

test('зависший запрос не запирает запись навсегда, и индикатор перестаёт врать', async () => {
  // Досыл вместо параллельной мутации убрал единственный аварийный выход: пока запрос не осел,
  // сохранение заперто, а «Сохраняем…» висит вечно. Ответа не будет НИКОГДА — ровно случай
  // оборванного соединения, где промис fetch не оседает ни успехом, ни отказом.
  const server = gatedServer();
  const s = mount({ respond: server.respond });
  s.api().onDocChange(ONE);
  await tick(SAVE_PAUSE);
  expect(s.updates()).toHaveLength(1);

  await tick(GIVE_UP - 1);
  expect(screen.getByText('Сохраняем…')).toBeInTheDocument();
  expect(s.updates()).toHaveLength(1);

  await tick(1);
  // Сам по себе повтор не заводится: отправлять нечего, никто ничего не набирал.
  expect(s.updates()).toHaveLength(1);
  // Но индикатор больше не обещает того, чего не знает: подтверждения сохранения нет.
  expect(screen.getByText('Не сохранено')).toBeInTheDocument();
  // И черновик на диске цел — текст не потерян.
  expect(stored().doc).toEqual(ONE);

  // ГЛАВНОЕ: запись снова сохраняется. До выдержки этой отправки не было бы (см. тест ниже).
  s.api().onDocChange(TWO);
  await tick(SAVE_PAUSE);
  expect(s.updates()).toHaveLength(2);
  expect(s.input(1)).toEqual({ id: 'e1', bodyDoc: TWO, expectedUpdatedAt: ENTITY.updatedAt });
});

test('оседание запроса прежней записи не освобождает полёт соседней', async () => {
  // Ответ прежней записи, доехавший после смены, не должен объявлять полёт СОСЕДНЕЙ
  // законченным: следующая правка ушла бы параллельно, а параллельная мутация сносит
  // поштучные колбэки первой (I2) — теряется вся бухгалтерия полёта.
  //
  // Держит это НЕ отсечка по поколению в onSettled (её снятие тест не краснит — проверено
  // мутацией M24), а сам query-core: вторая мутация на том же наблюдателе отцепляет его от
  // первой, и поштучные колбэки первой не зовутся ВООБЩЕ. Молчание ниже — прямое тому
  // свидетельство: сработай onSettled запроса №0, признак полёта обнулился бы и третий
  // запрос уехал бы параллельно.
  const server = gatedServer();
  const s = mount({ respond: server.respond });
  s.api().onDocChange(ONE);
  await tick(SAVE_PAUSE); // запрос №0 — первой записи, в полёте

  await s.set({ id: 'e2', entity: SECOND });
  s.api().onDocChange(TWO);
  await tick(SAVE_PAUSE); // запрос №1 — второй записи, тоже в полёте
  expect(s.updates()).toHaveLength(2);

  await server.answer(0, SAVED); // осел запрос ПЕРВОЙ записи

  s.api().onDocChange(THREE);
  await tick(SAVE_PAUSE);
  expect(s.updates(), 'полёт второй записи не закончен — третий запрос не уходит').toHaveLength(2);

  // Положительный контроль: по оседанию СВОЕГО запроса отложенное уезжает.
  await server.answer(1, SAVED);
  expect(s.updates()).toHaveLength(3);
  expect((s.input(2) as { bodyDoc: BodyDoc }).bodyDoc).toEqual(THREE);
});

test('осевший запрос снимает свою выдержку: «Не сохранено» не всплывает через полминуты', async () => {
  // Выдержка — про ЗАВИСШИЙ запрос. Переживи она оседание своего, через полминуты после
  // обычного успешного сохранения на экране сама собой зажглась бы плашка «Не сохранено» —
  // над текстом, который давно в базе. Причём именно через полминуты после, то есть посреди
  // спокойной работы и без единого повода.
  const s = mount();
  s.api().onDocChange(ONE);
  await tick(SAVE_PAUSE);
  expect(s.updates()).toHaveLength(1);
  await tick();
  expect(s.container, 'премиса: успех прошёл молча').toBeEmptyDOMElement();

  await tick(GIVE_UP * 2);
  expect(s.container).toBeEmptyDOMElement();
  expect(s.updates()).toHaveLength(1);

  // То же для ОТКАЗА: там плашка заслужена сразу, но лишнего досыла быть не должно.
  s.serve(fail500);
  s.api().onDocChange(TWO);
  await tick(SAVE_PAUSE);
  expect(s.updates()).toHaveLength(2);
  await tick(GIVE_UP * 2);
  expect(s.updates()).toHaveLength(2);
});

test('выдержка прежней записи не зажигает «Не сохранено» на соседней', async () => {
  const server = gatedServer();
  const s = mount({ respond: server.respond });
  s.api().onDocChange(ONE);
  await tick(SAVE_PAUSE); // запрос первой записи завис и не осядет никогда

  await s.set({ id: 'e2', entity: SECOND });
  // Момент, в который выдержка ПЕРВОЙ записи истекла бы. Соседней это не касается: её никто
  // не трогал, и «Не сохранено» на ней было бы ложью.
  await tick(GIVE_UP * 2);
  expect(s.container).toBeEmptyDOMElement();

  // И сохранение соседней не сломано (её полёт не «занят» чужим запросом).
  s.api().onDocChange(TWO);
  await tick(SAVE_PAUSE);
  expect(s.updates()).toHaveLength(2);
  expect((s.input(1) as { id: string }).id).toBe('e2');
});

test('терминальный отказ прежней записи метит ЕЁ черновик', async () => {
  // Зеркало стирания по успеху: пометка тоже про запись из замыкания запроса. Не пометь мы её,
  // отвергнутый документ уехал бы автодосылом при следующем открытии — обречённым запросом,
  // который заодно молча выключает записи сохранение до перезагрузки.
  const server = gatedServer();
  const s = mount({ respond: server.respond });
  s.api().onDocChange(ONE);
  await tick(SAVE_PAUSE);
  expect(raw(), 'премиса: черновик на диске').not.toBeNull();

  await s.set({ id: 'e2', entity: SECOND });
  await server.answer(0, trpcError('BAD_REQUEST', 'документ не соответствует схеме'), 'fail');
  expect(stored().rejected).toBe(true);
  s.unmount();

  const back = mount({ entity: ENTITY });
  await tick(SAVE_PAUSE * 2);
  expect(back.updates()).toEqual([]);
  expect(back.api().pendingDraft?.rejected).toBe(true);
});

test('размонтирование снимает выдержку: с закрытого экрана запросы не уходят', async () => {
  const server = gatedServer();
  const s = mount({ respond: server.respond });
  s.api().onDocChange(ONE);
  await tick(SAVE_PAUSE); // запрос завис
  s.api().onDocChange(TWO);
  await tick(SAVE_PAUSE); // досыл попрошен и ждёт освобождения
  expect(s.updates()).toHaveLength(1);

  s.unmount();
  // Экрана больше нет: доживи выдержка до срабатывания, она отправила бы отложенное тело от
  // имени хука, которого уже никто не держит, — и человек увидел бы правку записи, с которой
  // ушёл минуту назад.
  await tick(GIVE_UP * 2);
  expect(s.updates()).toHaveLength(1);
});

// --- раунд правок 1 -----------------------------------------------------------------------------

test('эхо редактора на монтировании не отменяет досыл и не стирает черновик (И-6)', async () => {
  // Редактор при монтировании ГАРАНТИРОВАННО присылает тело базы с проставленными блочными id
  // (UniqueID, отдельная транзакция). Дели досыл с ним отложенный слот и таймер паузы — эхо
  // сняло бы таймер досыла, затёрло бы слот, а через паузу ветка «правку вернули к сохранённому»
  // стёрла бы черновик с диска: неотправленный текст исчезает молча и навсегда, а кто успеет
  // первым — решает планировщик.
  await leaveDraft();

  const s = mount({ entity: ENTITY });
  // ДО первого же тика: досыл заведён, но ещё не сработал. Это РЕДКИЙ порядок, а не острый:
  // обычно эхо приходит позже досыла (редактор приезжает отдельным чанком), и тот сюжет
  // проверяют тесты Н-1 ниже. Здесь закрыт обратный край.
  s.api().onDocChange(withBlockIds(BASE));
  await tick(SAVE_PAUSE * 2);

  expect(s.updates()).toHaveLength(1);
  expect(s.input(0)).toEqual({ id: 'e1', bodyDoc: ONE, expectedUpdatedAt: ENTITY.updatedAt });
  expect(raw(), 'успех досыла снял черновик — но снял его успех, а не эхо').toBeNull();
});

test('эхо редактора ПОСЛЕ отказавшего досыла не стирает чужой черновик (Н-1)', async () => {
  // Порядок «эхо ПОСЛЕ досыла» — не экзотика, а НОРМА этого дизайна: досыл заведён нулевым
  // таймером прямо в эффекте, а редактор приезжает отдельным чанком (ради этого весь
  // `import type` и двухфазное монтирование), поэтому его первый onDocChange почти всегда
  // позже. Сюжет целиком: человек офлайн, набрал, отправка не прошла, закрыл вкладку; открыл
  // снова, всё ещё офлайн — досыл отказал, а через паузу эхо стирает набранное.
  await leaveDraft();

  const s = mount({ entity: ENTITY, respond: fail500 });
  await tick();
  expect(s.updates(), 'премиса: досыл ушёл').toHaveLength(1);
  expect(stored().doc, 'премиса: отказ черновик не тронул').toEqual(ONE);
  expect(screen.getByText('Не сохранено')).toBeInTheDocument();

  s.api().onDocChange(withBlockIds(BASE));
  await tick(SAVE_PAUSE);

  expect(s.updates(), 'эхо — не правка, второй раз в сеть не ходим').toHaveLength(1);
  expect(stored().doc, 'черновик прошлой сессии на месте').toEqual(ONE);
  // И индикатор не говорит, что всё хорошо: неотправленное никуда не делось.
  expect(screen.getByText('Не сохранено')).toBeInTheDocument();
});

test('эхо редактора не стирает ПРИМЕНЁННЫЙ черновик (Н-1)', async () => {
  // «Оставить моё» — тоже не набор: документ пришёл с диска, человек его выбрал, а не написал.
  // Считай мы его набранным, эхо редактора (а оно показывает ещё СТАРОЕ тело — сажать
  // применённый текст в редактор будет Задача 15) стёрло бы с диска только что применённый
  // абзац, не сумев его отправить.
  await leaveDraft();

  const s = mount({ entity: MOVED, respond: fail500 });
  await tick();
  expect(s.api().pendingDraft?.doc).toEqual(ONE);

  await s.apply();
  await tick();
  expect(s.updates(), 'премиса: попытка была').toHaveLength(1);
  expect(stored().doc, 'премиса: отказ черновик не тронул').toEqual(ONE);

  s.api().onDocChange(withBlockIds(MOVED.bodyDoc as BodyDoc));
  await tick(SAVE_PAUSE);
  expect(stored().doc).toEqual(ONE);
});

test('эхо редактора не стирает ПРЕДЛОЖЕННЫЙ черновик (И-6)', async () => {
  // Тот же сюжет при разошедшихся метках: досыла нет, черновик ждёт ответа человека — и эхо
  // редактора не вправе снять его с диска, иначе «оставить моё» станет нечего оставлять.
  await leaveDraft();

  const s = mount({ entity: MOVED });
  await tick();
  expect(s.api().pendingDraft?.doc).toEqual(ONE); // премиса: предложение стоит

  s.api().onDocChange(withBlockIds(MOVED.bodyDoc as BodyDoc));
  await tick(SAVE_PAUSE * 2);
  expect(s.updates()).toEqual([]); // эхо — не правка, в сеть не ходим
  expect(JSON.parse(raw() as string).doc).toEqual(ONE);
  expect(s.api().pendingDraft?.doc).toEqual(ONE);
});

test('досыл черновика не переезжает на соседнюю запись', async () => {
  // Ушли с записи внутри того же тика, в котором открыли её: досыл заведён, но ещё не
  // сработал. Доживи он — ушёл бы под id ПЕРВОЙ записи, но с меткой ВТОРОЙ (рефы к этому
  // моменту уже её), то есть с гарантированным 409, и заодно переписал бы черновик первой
  // чужой меткой — а на следующем открытии тот предложился бы как «разошедшийся».
  await leaveDraft();

  const s = mount({ entity: ENTITY });
  await s.set({ id: 'e2', entity: SECOND });
  await tick(SAVE_PAUSE * 2);
  expect(s.updates()).toEqual([]);
  expect(JSON.parse(raw() as string).baseUpdatedAt).toBe(ENTITY.updatedAt);

  // Положительный контроль: черновик никуда не делся и своей записью подхватывается.
  await s.set({ id: 'e1', entity: ENTITY });
  await tick();
  expect(s.updates()).toHaveLength(1);
  expect(s.input(0)).toEqual({ id: 'e1', bodyDoc: ONE, expectedUpdatedAt: ENTITY.updatedAt });
});

test('черновик, уже лежащий в теле записи, не предлагается и при разошедшихся метках (И-3)', async () => {
  // Самый частый сюжет восстановления: успех ДОШЁЛ до сервера, ответ потерялся, вкладку
  // закрыли. Метка на сервере двинулась, тело — ровно черновик. Ветка предложения обязана
  // сверять текст так же, как это делает ветка досыла, иначе человека спросят про текст,
  // который уже в базе.
  await leaveDraft();

  const s = mount({ entity: { updatedAt: MOVED.updatedAt, bodyDoc: ONE } });
  await tick(SAVE_PAUSE * 2);
  expect(s.api().pendingDraft).toBeNull();
  expect(s.updates()).toEqual([]);
  expect(raw(), 'и с диска снят: держать его больше незачем').toBeNull();

  // Страж вакуумности: метки ДЕЙСТВИТЕЛЬНО разошлись — это ветка предложения, а не досыла.
  expect(MOVED.updatedAt).not.toBe(ENTITY.updatedAt);

  // Положительный контроль: черновик, ОТЛИЧНЫЙ от тела, при тех же метках предлагается.
  s.unmount();
  await leaveDraft(TWO);
  const other = mount({ entity: { updatedAt: MOVED.updatedAt, bodyDoc: ONE } });
  await tick();
  expect(other.api().pendingDraft?.doc).toEqual(TWO);
});

test('после терминального отказа набранное продолжает попадать в хранилище (И-5)', async () => {
  // Состояние «не сохранено и не сохранится» — ровно то, ради чего черновик и заведён.
  // Выключать в нём страховку значит терять всё, что человек напишет после отказа.
  const s = mount({
    respond: () => {
      throw trpcError('BAD_REQUEST', 'документ не соответствует схеме — правка отклонена');
    },
  });
  s.api().onDocChange(ONE);
  await tick(SAVE_PAUSE);
  expect(s.updates()).toHaveLength(1);
  expect(stored()).toMatchObject({ doc: ONE, rejected: true }); // премиса: остановка сработала

  s.api().onDocChange(TWO);
  await tick(SAVE_PAUSE);
  expect(s.updates(), 'в сеть по-прежнему не ходим: отказ терминален').toHaveLength(1);
  expect(stored().doc, 'но набранное — на диске').toEqual(TWO);

  // И эта запись уже не помечена: её никто не отвергал, её вообще не отправляли.
  expect(stored().rejected).toBe(false);
});

test('«отбросить» стирает ПОКАЗАННЫЙ черновик, а не свежий неотправленный (И-2)', async () => {
  // Человек не ответил на баннер, а продолжил печатать — и его текст лёг на диск поверх
  // предложенного. «Отбросить» относится к тому, что показано; стереть им свежий
  // неотправленный абзац значит потерять текст молча и по кнопке, которая обещала другое.
  await leaveDraft();

  const s = mount({ entity: MOVED, respond: fail500 });
  await tick();
  expect(s.api().pendingDraft?.doc).toEqual(ONE); // премиса: предложение стоит

  s.api().onDocChange(TWO);
  await tick(SAVE_PAUSE);
  expect(stored().doc, 'премиса: на диске уже СВЕЖИЙ текст').toEqual(TWO);

  await s.discard();
  expect(s.api().pendingDraft).toBeNull();
  expect(stored().doc).toEqual(TWO);

  // Положительный контроль: «отбросить» ПОКАЗАННЫЙ черновик с диска стирает.
  s.unmount();
  await leaveDraft();
  const plain = mount({ entity: MOVED });
  await tick();
  await plain.discard();
  expect(raw()).toBeNull();
});

test('правка, набранная поверх зависшего запроса, уходит по истечении выдержки', async () => {
  const server = gatedServer();
  const s = mount({ respond: server.respond });
  s.api().onDocChange(ONE);
  await tick(SAVE_PAUSE);
  expect(s.updates()).toHaveLength(1);

  // Пока запрос в полёте, второй не уходит — ни по паузе, ни по flush(). Это и есть запор.
  s.api().onDocChange(TWO);
  await tick(SAVE_PAUSE);
  await act(async () => {
    s.api().flush();
  });
  expect(s.updates()).toHaveLength(1);

  await tick(GIVE_UP - SAVE_PAUSE - 1);
  expect(s.updates(), 'до выдержки ждём: запрос может быть просто медленным').toHaveLength(1);

  await tick(1);
  expect(s.updates()).toHaveLength(2);
  expect((s.input(1) as { bodyDoc: BodyDoc }).bodyDoc).toEqual(TWO);
  // И ровно один досыл: круг «выдержка → досыл → выдержка → досыл» невозможен.
  await tick(GIVE_UP * 2);
  expect(s.updates()).toHaveLength(2);
});

test('брошенный по выдержке запрос, осевший позже, не зажигает конфликт на сохранённой записи (И-1)', async () => {
  // Выдержка впервые допускает ДВЕ живые мутации по одной записи. Поштучные колбэки первой к
  // этому моменту отцеплены, но колбэки уровня МУТАЦИИ исполняются всегда — и опоздавший 409
  // брошенного запроса зажёг бы «Изменено в другом месте» на записи, которая только что
  // успешно сохранилась.
  const server = gatedServer();
  const s = mount({ respond: server.respond });
  s.api().onDocChange(ONE);
  await tick(SAVE_PAUSE); // запрос №0 завис

  s.api().onDocChange(TWO);
  await tick(SAVE_PAUSE); // досыл попрошен
  await tick(GIVE_UP);
  expect(s.updates(), 'премиса: досыл ушёл вторым запросом').toHaveLength(2);

  await server.answer(1, SAVED); // досыл сохранился по-настоящему
  expect(s.api().conflict).toBe(false);

  // А теперь оседает БРОШЕННЫЙ запрос — с 409 от собственного же преемника.
  await server.answer(0, trpcError('CONFLICT'), 'fail');
  expect(s.api().conflict).toBe(false);

  // Положительный контроль: 409 по ЖИВОМУ запросу флаг поднимает — сверка не выключила
  // проверку вовсе.
  s.api().onDocChange(THREE);
  await tick(SAVE_PAUSE);
  expect(s.updates()).toHaveLength(3);
  await server.answer(2, trpcError('CONFLICT'), 'fail');
  expect(s.api().conflict).toBe(true);
});

test('брошенный по выдержке запрос, отказав, не откатывает патч своего преемника (И-1)', async () => {
  // Вторая половина той же беды: откат живёт в общей обвязке и берёт снимок, сделанный ДО
  // брошенного запроса. Верни он его — из кэша исчез бы оптимистичный документ досыла, и
  // повторно смонтированный редактор поднялся бы со СТАРЫМ телом, а следующая правка уехала
  // бы поверх более нового.
  const server = gatedServer();
  type Cached = { entity: { bodyDoc?: unknown } } | undefined;
  const read: { get: () => Cached } = { get: () => undefined };
  const hold: { api: BodySave | null } = { api: null };
  function Tree() {
    trpc.entity.get.useQuery(detailGetInput('e1'));
    const utils = trpc.useUtils();
    read.get = () => utils.entity.get.getData(detailGetInput('e1')) as Cached;
    hold.api = useBodySave('e1', ENTITY);
    return null;
  }
  // Первое чтение отвечает, дальнейшие ЗАВИСАЮТ: иначе перечитывание после инвалидации
  // принесло бы верные данные из мока и залечило бы промах ДО ассерта (в проде лечение то же
  // самое, но оно стоит круга сети, а в офлайне не случится вовсе).
  let reads = 0;
  renderWithProviders(<Tree />, (path) => {
    if (path === 'entity.get') {
      reads += 1;
      if (reads > 1) return new Promise(() => {});
      return { entity: { id: 'e1', body: 'тело', bodyDoc: BASE, updatedAt: ENTITY.updatedAt } };
    }
    if (path === 'entity.update') return server.respond(null);
    throw new Error(`сохранение тела не ходит на ${path}`);
  });
  await tick();
  expect(read.get()?.entity.bodyDoc, 'премиса: в кэше документ сервера').toEqual(BASE);

  (hold.api as BodySave).onDocChange(ONE);
  await tick(SAVE_PAUSE); // запрос №0 завис
  (hold.api as BodySave).onDocChange(TWO);
  await tick(SAVE_PAUSE);
  await tick(GIVE_UP); // выдержка истекла, досыл ушёл запросом №1
  expect(read.get()?.entity.bodyDoc, 'премиса: в кэше документ досыла').toEqual(TWO);

  await server.answer(0, trpcError('INTERNAL_SERVER_ERROR'), 'fail');
  expect(read.get()?.entity.bodyDoc).toEqual(TWO);
});

test('поздний УСПЕХ брошенного запроса не гасит конфликт его преемника (И-1)', async () => {
  // Обратная сторона той же сверки: брошенный запрос мог и доехать успехом. Погаси он флаг,
  // плашка «Изменено в другом месте» исчезла бы с экрана сама, а расхождение осталось бы.
  const server = gatedServer();
  const s = mount({ respond: server.respond });
  s.api().onDocChange(ONE);
  await tick(SAVE_PAUSE); // запрос №0 завис

  s.api().onDocChange(TWO);
  await tick(SAVE_PAUSE);
  await tick(GIVE_UP);
  expect(s.updates()).toHaveLength(2);

  // Досыл поймал 409 — плашка заслужена.
  await server.answer(1, trpcError('CONFLICT'), 'fail');
  expect(s.api().conflict).toBe(true);

  // А брошенный запрос доехал успехом. Он про прошлое и гасить этот конфликт не вправе.
  await server.answer(0, SAVED);
  expect(s.api().conflict).toBe(true);
});
