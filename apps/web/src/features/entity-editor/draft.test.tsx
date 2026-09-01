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

/** Владелец записи: черновики скоупятся по нему (см. KEY). */
const OWNER = 'u1';

/**
 * Ключ выписан СТРОКОЙ, а не взят из draft-storage, и это намеренно: ключ — договор с диском
 * браузера, переживающий перезагрузку и обновление приложения. Импортируй тест ту же константу,
 * он остался бы зелёным при переименовании ключа — то есть при молчаливой потере всех черновиков,
 * набранных прошлой версией.
 */
const KEY = `orbis:body-draft:${OWNER}:e1`;

const BASE = parseBody('тело');
const ONE = parseBody('тело и правка');
const TWO = parseBody('тело, правка и ещё одна');
const THREE = parseBody('совсем другое тело');

/** Сущность на момент открытия: `updatedAt` намеренно далёк от системного времени прогона. */
const ENTITY: BodySaveEntity = {
  ownerId: OWNER,
  updatedAt: '2026-08-14T10:00:00.000Z',
  bodyDoc: BASE,
};
/** Соседняя запись: её `updatedAt` РАНЬШЕ всего, что вернёт сервер по первой. */
const SECOND: BodySaveEntity = {
  ownerId: OWNER,
  updatedAt: '2026-08-14T10:30:00.000Z',
  bodyDoc: BASE,
};
/** Та же запись, но сервер её с тех пор двигали: метка ПОЗЖЕ той, на которой набран черновик. */
const MOVED: BodySaveEntity = {
  ownerId: OWNER,
  updatedAt: '2026-08-14T12:00:00.000Z',
  bodyDoc: THREE,
};
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
    /**
     * Размонтирование ВСЕГДА через `await`. `act()` возвращает thenable, и брошенный без
     * ожидания вызов оставляет работу React недоделанной к моменту следующего ассерта: сегодня
     * это никого не красит, но заготовка для ложной зелени готовая — и ловится она только
     * глазами (ревью раунда 3).
     */
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
    dismiss: async () => {
      await act(async () => {
        (hold.api as BodySave).dismissPendingDraft();
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
  await s.unmount();
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
    `orbis:body-draft:${OWNER}:e2`,
    JSON.stringify({ doc: ONE, baseUpdatedAt: '2026-08-14T09:00:00.000Z', savedAt: 'x' }),
  );
  await s.set({
    id: 'e2',
    entity: { ownerId: OWNER, updatedAt: '2026-08-14T10:30:00.000Z', bodyDoc: THREE },
  });
  await server.answer(0, SAVED);

  expect(raw()).toBeNull();
  expect(raw(`orbis:body-draft:${OWNER}:e2`)).not.toBeNull();
});

test('закрытие вкладки кладёт набранное на диск: pagehide зовёт досыл', async () => {
  // Черновик пишется не на каждое нажатие, а при отправке — значит набранное в последние две
  // секунды прикрыто ТОЛЬКО досылом. React уборки при закрытии вкладки не прогоняет, и без
  // своего слушателя этот текст исчезал бы без следа: ни на сервере, ни на диске.
  //
  // `pagehide`, а не `beforeunload`: последний на мобильных не срабатывает вовсе — а именно там
  // вкладку и «закрывают» чаще всего, переключившись на другое приложение.
  const s = mount({ respond: fail500 });
  s.api().onDocChange(ONE);
  // Страж: пауза ещё идёт, черновика нет — иначе проверка ниже была бы зелена и без слушателя.
  expect(raw()).toBeNull();

  await act(async () => {
    window.dispatchEvent(new Event('pagehide'));
  });

  // Ценна здесь даже не мутация, а СИНХРОННАЯ запись на диск: она случается раньше отправки и
  // переживает закрытие вкладки, чем бы там ни кончился запрос.
  expect(stored().doc).toEqual(ONE);
  expect(s.updates()).toHaveLength(1);

  // И слушатель снимается вместе с экраном. Уход с записи сам по себе досылает отложенное
  // (отказ оставил его на руках) — это ВТОРАЯ отправка, законная; а вот `pagehide` после ухода
  // не вправе сделать ничего: слушатель, переживший экран, работал бы от имени хука, которого
  // уже никто не держит.
  //
  // Спрашиваем ДИСК, а не сеть, и это не вкусовщина — замерено мутацией (снять снятие
  // слушателя: по сети всё зелено). Досыл при уходе оставляет признак полёта поднятым навсегда
  // (его onSettled не зовётся — наблюдателя отцепили), и переживший слушатель просто не дошёл
  // бы до отправки. А вот запись черновика стоит РАНЬШЕ учёта полёта — и она бы состоялась.
  await s.unmount();
  expect(s.updates(), 'премиса: досыл при уходе состоялся').toHaveLength(2);
  localStorage.clear();
  await act(async () => {
    window.dispatchEvent(new Event('pagehide'));
  });
  expect(raw(), 'слушатель снят вместе с экраном').toBeNull();
  expect(s.updates()).toHaveLength(2);
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
    // Версия схемы у черновика та же, что у приложения, — предложение обычное, с отправкой.
    // Признак пинится ЗДЕСЬ, а не только в новых тестах: подними он на штатном черновике, и
    // человек получил бы баннер «отправить нельзя» над правкой, с которой всё в порядке.
    foreignSchema: false,
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

  const s = mount({ entity: { ownerId: OWNER, updatedAt: ENTITY.updatedAt, bodyDoc: ONE } });
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
  await s.unmount(); // до первого же тика: таймер досыла заведён, но ещё не сработал
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
  const other = mount({
    id: 'e2',
    entity: { ownerId: OWNER, updatedAt: ENTITY.updatedAt, bodyDoc: THREE },
  });
  await tick(SAVE_PAUSE * 2);
  expect(other.updates()).toEqual([]);
  expect(other.api().pendingDraft).toBeNull();
  await other.unmount();

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

  await s.set({
    id: 'e2',
    entity: { ownerId: OWNER, updatedAt: '2026-08-14T10:30:00.000Z', bodyDoc: THREE },
  });
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

test('набор поверх ПРЕДЛОЖЕННОГО черновика не затирает его на диске', async () => {
  // Слот на диске один, и запись в него безусловна — а показанный человеку черновик к этому
  // моменту живёт только в памяти вкладки. Человек, не ответив на баннер, дописывает абзац:
  // через паузу отправка затирает предложенный текст, человек уходит, так и не ответив, — и
  // текст потерян навсегда и молча, хотя экран только что обещал выбор.
  //
  // Цена решения честная и записана здесь: пока баннер стоит, свежий набор страховкой НЕ
  // прикрыт. Он при этом уезжает на сервер как обычно (проверено ниже), то есть теряется лишь
  // при крахе вкладки в двухсекундном окне — против гарантированной потери текста, о котором
  // человека спросили и ответа не дождались.
  await leaveDraft();

  const s = mount({ entity: MOVED, respond: fail500 });
  await tick();
  expect(s.api().pendingDraft?.doc, 'премиса: предложение стоит').toEqual(ONE);

  s.api().onDocChange(TWO);
  await tick(SAVE_PAUSE);
  expect(s.updates(), 'набранное всё равно уезжает на сервер').toHaveLength(1);
  expect(stored().doc, 'а на диске — по-прежнему предложенный черновик').toEqual(ONE);
  expect(s.api().pendingDraft?.doc).toEqual(ONE);

  // Положительный контроль: человек ОТВЕТИЛ — и страховка снова пишет набранное. Тот же самый
  // документ, что молчал выше: значит молчание было от стоящего предложения, а не от чего-то
  // ещё. (THREE тут не годится — это тело самой записи MOVED, и сравнение по смыслу отсекло бы
  // отправку раньше диска.)
  await s.discard();
  s.api().onDocChange(TWO);
  await tick(SAVE_PAUSE);
  expect(stored().doc).toEqual(TWO);
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
  await s.unmount();
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
  await s.unmount();

  // Метка сервера НЕ менялась — то есть это ровно та ветка, где черновик ушёл бы автодосылом.
  const back = mount({ entity: ENTITY });
  await tick(SAVE_PAUSE * 3);
  expect(back.updates()).toEqual([]);
  expect(back.api().pendingDraft).toEqual({
    doc: ONE,
    savedAt: '2030-01-01T00:00:02.000Z',
    rejected: true,
    // Приговор сервера и чужая версия схемы — РАЗНЫЕ поводы для предложения: первый оставляет
    // человеку «оставить моё», второй его отбирает. Смешай их — и отвергнутая правка потеряла
    // бы единственную кнопку, которой её можно дожать после обновления приложения.
    foreignSchema: false,
  });
  await back.unmount();

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

  // Положительный контроль В ТОМ ЖЕ ТЕСТЕ: пометка НАСТОЯЩАЯ, а не просто строка на диске —
  // следующее открытие записи черновик не досылает и предлагает выбор. Метка сервера при этом
  // не менялась, то есть это ровно та ветка, где непомеченный черновик ушёл бы автодосылом.
  //
  // Свойство «пометка держится за ДОКУМЕНТ, а не за факт отказа» проверяет теперь И-5
  // («после терминального отказа набранное продолжает попадать в хранилище»): там набор идёт в
  // ТОЙ ЖЕ сессии, где приговор и случился. Здесь его больше не проверить — на свежем хуке
  // отвергнутый черновик становится ПРЕДЛОЖЕНИЕМ, а пока предложение стоит, набор диск не
  // трогает вовсе (находка 6).
  const again = mount({ entity: ENTITY, respond: fail500 });
  await tick(SAVE_PAUSE * 3);
  expect(again.updates()).toEqual([]);
  expect(again.api().pendingDraft).toMatchObject({ doc: ONE, rejected: true });
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
    await s.unmount();
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

/**
 * Срок жизни черновика выписан ЧИСЛОМ по той же причине, что и пороги времени: это договор с
 * диском браузера. Возьми тест константу из модуля — он остался бы зелёным и при сроке в час,
 * то есть при молчаливой пропаже черновиков, набранных вчера.
 */
const TTL_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Черновик такой давности на диске, как будто его писали `days` дней назад. */
function agedDraft(days: number, doc: BodyDoc = ONE): string {
  return JSON.stringify({
    doc,
    baseUpdatedAt: ENTITY.updatedAt,
    savedAt: new Date(Date.now() - days * DAY_MS).toISOString(),
    rejected: false,
  });
}

test('черновик соседнего аккаунта не подставляется и не досылается', async () => {
  // Браузер бывает общим. Не скоупь мы ключ по владельцу — следующий залогинившийся аккаунт
  // увидел бы чужую неотправленную заметку в баннере, а при совпавших метках дослал бы её на
  // сервер от своего имени. Тот же приём и по той же причине, что у retry-буфера.
  await leaveDraft();

  const other = mount({ entity: { ...ENTITY, ownerId: 'u2' } });
  await tick(SAVE_PAUSE * 2);
  expect(other.updates()).toEqual([]);
  expect(other.api().pendingDraft).toBeNull();
  expect(raw(), 'черновик первого владельца цел — он просто не виден второму').not.toBeNull();
  await other.unmount();

  // Положительный контроль: своему владельцу тот же черновик виден и уезжает автодосылом.
  const own = mount({ entity: ENTITY });
  await tick();
  expect(own.updates()).toHaveLength(1);
});

test('черновик старше срока жизни не предлагается и уходит с диска', async () => {
  // Неотправленная правка — страховка на дни, а не архив навсегда. Без срока жизни текст
  // заметки лежит в общем браузере вечно, переживая и выход из аккаунта.
  localStorage.setItem(KEY, agedDraft(TTL_DAYS + 1));

  const s = mount({ entity: MOVED });
  await tick(SAVE_PAUSE * 2);
  expect(s.updates()).toEqual([]);
  expect(s.api().pendingDraft).toBeNull();
  expect(raw(), 'и с диска снят: держать его больше незачем').toBeNull();
  await s.unmount();

  // Положительный контроль: черновик МОЛОЖЕ срока — предлагается как ни в чём не бывало.
  localStorage.setItem(KEY, agedDraft(TTL_DAYS - 1));
  const fresh = mount({ entity: MOVED });
  await tick();
  expect(fresh.api().pendingDraft?.doc).toEqual(ONE);
});

test('уборка сносит просроченных соседей и ключи прежнего вида, чужих не трогает', async () => {
  // Срок жизни, применяемый только к читаемому ключу, не истёк бы НИКОГДА у черновика записи,
  // которую больше не откроют. Ключи прежнего вида (без владельца) читать теперь некому —
  // без уборки они пролежали бы вечно.
  const stale = `orbis:body-draft:${OWNER}:e9`;
  const legacy = 'orbis:body-draft:e9';
  const alien = 'orbis:retry-buffer:v1';
  localStorage.setItem(stale, agedDraft(TTL_DAYS + 5));
  localStorage.setItem(legacy, agedDraft(0));
  localStorage.setItem(alien, '[]');
  // Свежий сосед того же владельца — страж вакуумности: уборка сносит просроченное, а не всё.
  const alive = `orbis:body-draft:${OWNER}:e8`;
  localStorage.setItem(alive, agedDraft(1));

  const s = mount({ entity: ENTITY });
  await tick();

  expect(localStorage.getItem(stale), 'просроченный сосед').toBeNull();
  expect(localStorage.getItem(legacy), 'ключ прежнего вида').toBeNull();
  expect(localStorage.getItem(alive), 'живой сосед').not.toBeNull();
  expect(localStorage.getItem(alien), 'чужое хранилище').toBe('[]');
  expect(s.updates(), 'уборка сама по себе в сеть не ходит').toEqual([]);
});

test('переполненное хранилище: уборка и вторая попытка вместо молчаливой потери', async () => {
  // Место чаще всего занято просроченными черновиками соседних записей — и тогда сдаваться на
  // первой же неудаче значит терять страховку ровно там, где она нужна.
  const stale = `orbis:body-draft:${OWNER}:e9`;
  localStorage.setItem(stale, agedDraft(TTL_DAYS + 5));

  const real = Storage.prototype.setItem;
  let refuseOnce = true;
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (
    this: Storage,
    k: string,
    v: string,
  ) {
    if (refuseOnce && k === KEY) {
      refuseOnce = false;
      throw new Error('QuotaExceededError');
    }
    real.call(this, k, v);
  });

  const s = mount({ respond: fail500 });
  s.api().onDocChange(ONE);
  await tick(SAVE_PAUSE);

  expect(stored().doc, 'вторая попытка удалась').toEqual(ONE);
  expect(localStorage.getItem(stale), 'место освободила уборка').toBeNull();
  expect(s.updates(), 'сама правка при этом уехала').toHaveLength(1);
  // Страж вакуумности: отказ ДЕЙСТВИТЕЛЬНО случился, а не был проглочен подделкой.
  expect(refuseOnce).toBe(false);
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
  await s.unmount();

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
  await s.unmount();

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

  await s.unmount();
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

  const s = mount({ entity: { ownerId: OWNER, updatedAt: MOVED.updatedAt, bodyDoc: ONE } });
  await tick(SAVE_PAUSE * 2);
  expect(s.api().pendingDraft).toBeNull();
  expect(s.updates()).toEqual([]);
  expect(raw(), 'и с диска снят: держать его больше незачем').toBeNull();

  // Страж вакуумности: метки ДЕЙСТВИТЕЛЬНО разошлись — это ветка предложения, а не досыла.
  expect(MOVED.updatedAt).not.toBe(ENTITY.updatedAt);

  // Положительный контроль: черновик, ОТЛИЧНЫЙ от тела, при тех же метках предлагается.
  await s.unmount();
  await leaveDraft(TWO);
  const other = mount({ entity: { ownerId: OWNER, updatedAt: MOVED.updatedAt, bodyDoc: ONE } });
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

test('«отбросить» стирает ПОКАЗАННЫЙ черновик, а не чужой свежий (И-2)', async () => {
  // «Отбросить» относится к тому, что ПОКАЗАНО. Стереть им чужой неотправленный текст значит
  // потерять его молча и по кнопке, которая обещала другое.
  //
  // Сюжет с тех пор сменился, и это стоит прочесть. Раньше диск расходился с предложением сам
  // собой: человек не отвечал на баннер, продолжал печатать — и автосохранение затирало
  // предложенный черновик. Эту дорогу закрыли у КОРНЯ (находка 6, тест «набор поверх
  // ПРЕДЛОЖЕННОГО черновика не затирает его на диске»): пока предложение стоит, набор диск не
  // трогает вовсе. Остался другой, тоже настоящий источник расхождения — ВТОРАЯ ВКЛАДКА на той
  // же записи: у неё свой хук, свой слот в памяти и тот же ключ на диске. Его и подделываем
  // записью напрямую, потому что второй вкладки в этом стенде нет.
  await leaveDraft();

  const s = mount({ entity: MOVED, respond: fail500 });
  await tick();
  expect(s.api().pendingDraft?.doc).toEqual(ONE); // премиса: предложение стоит

  localStorage.setItem(
    KEY,
    JSON.stringify({
      doc: TWO,
      baseUpdatedAt: MOVED.updatedAt,
      savedAt: '2030-01-01T00:05:00.000Z',
      rejected: false,
    }),
  );
  expect(stored().doc, 'премиса: на диске уже ЧУЖОЙ свежий текст').toEqual(TWO);

  await s.discard();
  expect(s.api().pendingDraft).toBeNull();
  expect(stored().doc).toEqual(TWO);

  // Положительный контроль: «отбросить» ПОКАЗАННЫЙ черновик с диска стирает.
  await s.unmount();
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

/**
 * Ниже — про то, что судьба диска обязана сверяться с ДОКУМЕНТОМ, который сервер принял.
 * Внутри хука эта сверка есть (`rejectedDocRef`), а на уровне мутации её не было: чистка и
 * пометка звались по факту оседания, чей бы документ ни осел.
 *
 * Стенд у обоих один: запрос №0 бросают по выдержке, поверх него ложится запрос №1 с ДРУГИМ
 * документом, и лишь потом оседает брошенный. Порядок не выдуман — ровно так выглядит
 * «соединение оборвалось и починилось».
 */
async function abandonedThenNewer(server: ReturnType<typeof gatedServer>) {
  const s = mount({ respond: server.respond });
  s.api().onDocChange(ONE);
  await tick(SAVE_PAUSE); // запрос №0 ушёл и завис
  await tick(GIVE_UP); // брошен по выдержке; на диске — ONE
  expect(stored().doc, 'премиса: на диске документ запроса №0').toEqual(ONE);

  s.api().onDocChange(TWO);
  await tick(SAVE_PAUSE);
  expect(s.updates(), 'премиса: запрос №1 ушёл').toHaveLength(2);
  await server.answer(1, trpcError('INTERNAL_SERVER_ERROR'), 'fail');
  expect(stored().doc, 'премиса: на диске уже документ запроса №1').toEqual(TWO);
  return s;
}

test('успех брошенного запроса не стирает черновик, которого сервер не видел', async () => {
  // Сервер принял ONE, а на диске лежит TWO — набранное ПОСЛЕ. Сотри мы черновик по факту
  // успеха, TWO исчез бы отовсюду: на сервере его нет, на диске больше нет, а вкладку человек
  // закрывает следующим движением.
  const server = gatedServer();
  const s = await abandonedThenNewer(server);

  await server.answer(0, SAVED);

  expect(stored().doc).toEqual(TWO);

  // Положительный контроль: чистка НЕ выключена вовсе — успех по ТОМУ ЖЕ документу диск
  // снимает. Иначе черновик переживал бы собственное сохранение.
  s.serve(ok);
  s.api().onDocChange(THREE);
  await tick(SAVE_PAUSE);
  await tick();
  expect(raw()).toBeNull();
});

test('терминальный отказ брошенного запроса не метит черновик, которого сервер не видел', async () => {
  // Зеркало: пометка «отвергнут» досталась бы документу, которого сервер не видел. Следующее
  // открытие записи сказало бы человеку неправду («сервер не принял») и лишило бы его текст
  // автодосыла ни за что.
  const server = gatedServer();
  const s = await abandonedThenNewer(server);

  await server.answer(0, trpcError('BAD_REQUEST', 'документ не соответствует схеме'), 'fail');

  expect(stored()).toMatchObject({ doc: TWO, rejected: false });
  await s.unmount();

  // И на следующем открытии он уезжает автодосылом, как всякий непомеченный.
  const back = mount({ entity: { ownerId: OWNER, updatedAt: ENTITY.updatedAt, bodyDoc: BASE } });
  await tick();
  expect(back.updates()).toHaveLength(1);
  expect((back.input(0) as { bodyDoc: BodyDoc }).bodyDoc).toEqual(TWO);
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

// --- чужая версия схемы документа: контракт офлайн-черновиков (§А11-2) -----------------------
//
// Версию подделывает САМ ЧЕРНОВИК (`v: 0` — прошлое, `v: 999` — откат релиза) при живой
// константе, а не `vi.mock` модуля: мок поднимается на весь файл, и остальные пятьдесят тестов,
// где `parseBody` даёт документы текущей версии, покраснели бы разом. Заодно эти фикстуры
// переживут поднятие версии: `0` останется прошлым, а `999` — будущим.

/** Черновик ПРОШЛОЙ версии схемы; состав нод — штатный, всё известно. */
const OLD: BodyDoc = { v: 0, doc: ONE.doc };
/** Черновик версии ИЗ БУДУЩЕГО: приложение откатили, а текст набирали новой версией. */
const FUTURE: BodyDoc = { v: 999, doc: ONE.doc };
/** Прошлая версия с нодой, которой в схеме нет: перештамповка потеряла бы её содержимое. */
const OLD_UNKNOWN: BodyDoc = {
  v: 0,
  doc: {
    type: 'doc',
    content: [{ type: 'unknownNode', content: [{ type: 'text', text: 'важное' }] }],
  },
};

/** Черновик на диск РУКАМИ: версию схемы стенд подделывает документом (см. выше). */
function seed(doc: BodyDoc, baseUpdatedAt = ENTITY.updatedAt, rejected = false): void {
  localStorage.setItem(
    KEY,
    JSON.stringify({ doc, baseUpdatedAt, savedAt: '2030-01-01T00:00:02.000Z', rejected }),
  );
}

test('черновик прошлой версии с известными нодами перештампован и уходит штатным досылом', async () => {
  seed(OLD);

  const s = mount({ entity: ENTITY });
  await tick();

  // Состав нод известен — терять при перештамповке нечего, и спрашивать не о чем.
  expect(s.api().pendingDraft).toBeNull();
  expect(s.updates()).toHaveLength(1);
  // Уехала ТЕКУЩАЯ версия: серверный гейт версии (executor) отверг бы `v: 0` терминально, то
  // есть молчаливый досыл стоил бы записи сохранения до перезагрузки.
  expect((s.input(0) as { bodyDoc: BodyDoc }).bodyDoc).toEqual(ONE);
});

test('перештамповка идёт ДО сверки с телом: текст, уже лежащий в базе, не предлагают заново', async () => {
  // Самый частый сюжет восстановления: успех дошёл до сервера, ответ потерялся, вкладку
  // закрыли. Метка на сервере ДВИНУЛАСЬ, то есть без сверки сработала бы ветка предложения.
  // Сама сверка сравнивает и версии (`base.bodyDoc.v === draft.doc.v`) — стой развилка версии
  // ПОСЛЕ неё, она не срабатывала бы никогда, и человека спрашивали бы про текст из базы.
  seed(OLD, 'СТАРАЯ-МЕТКА');

  const s = mount({ entity: { ownerId: OWNER, updatedAt: MOVED.updatedAt, bodyDoc: ONE } });
  await tick(SAVE_PAUSE * 2);

  expect(s.api().pendingDraft).toBeNull();
  expect(s.updates()).toEqual([]);
  expect(raw(), 'черновик уже в теле записи — на диске ему делать нечего').toBeNull();
});

test('черновик прошлой версии с НЕИЗВЕСТНОЙ нодой не досылается — предложение выбором', async () => {
  // Метка НЕ разошлась, то есть это ровно та ветка, где черновик ушёл бы молчаливым досылом.
  seed(OLD_UNKNOWN);

  const s = mount({ entity: ENTITY });
  await tick(SAVE_PAUSE * 2);

  expect(s.updates(), 'перештамповка потеряла бы содержимое незнакомой ноды').toEqual([]);
  expect(s.api().pendingDraft).toEqual({
    doc: OLD_UNKNOWN,
    savedAt: '2030-01-01T00:00:02.000Z',
    rejected: false,
    foreignSchema: true,
  });
  // Главное требование спеки: текст не теряется ни в одной ветке.
  expect(stored().doc).toEqual(OLD_UNKNOWN);
});

test('черновик версии ИЗ БУДУЩЕГО вниз не штампуется — предложение выбором', async () => {
  // Состав нод здесь ИЗВЕСТЕН целиком (тот же документ, что у штатного черновика), и только
  // это делает тест про версию, а не про ноды: имена нод могут совпасть, а контент-модель и
  // атрибуты — нет, и штамповка вниз обещала бы совместимость, которой никто не проверял.
  seed(FUTURE);

  const s = mount({ entity: ENTITY });
  await tick(SAVE_PAUSE * 2);

  expect(s.updates()).toEqual([]);
  expect(s.api().pendingDraft).toEqual({
    doc: FUTURE,
    savedAt: '2030-01-01T00:00:02.000Z',
    rejected: false,
    foreignSchema: true,
  });
  expect(stored().doc).toEqual(FUTURE);
});

test('«открыть серверное тело» снимает предложение, а черновик с диска НЕ стирает', async () => {
  seed(FUTURE);
  const s = mount({ entity: ENTITY });
  await tick();
  expect(s.api().pendingDraft, 'премиса: предложение стоит').not.toBeNull();

  await s.dismiss();

  expect(s.api().pendingDraft).toBeNull();
  // Решение отложено, а не принято: единственная кнопка, которая стирает черновик с диска, —
  // «отбросить», и она в этом баннере не показана вовсе.
  expect(stored().doc).toEqual(FUTURE);
  expect(s.updates()).toEqual([]);
});
