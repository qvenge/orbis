import { act, render, screen, waitFor } from '@testing-library/react';
import { lazy, Suspense } from 'react';
import { expect, test, vi } from 'vitest';
import { App } from '../App';
import { useNav } from '../state/navigation';
import { type MockHandler, renderWithProviders } from '../test/harness';
import { ChunkErrorBoundary } from './ChunkErrorBoundary';
import { installChunkReload } from './chunk-reload';
import { ActiveScreen } from './router';
import { ScreenFallback } from './ScreenFallback';

test('заглушка экрана показывает скелетон, а не текст «Загрузка…»', () => {
  render(<ScreenFallback />);
  expect(screen.getAllByRole('status', { name: 'Загрузка' }).length).toBeGreaterThanOrEqual(1);
  expect(screen.queryByText(/Загрузка…/)).not.toBeInTheDocument();
});

function Boom(): never {
  throw new Error('Failed to fetch dynamically imported module');
}

test('граница ошибок ловит провал рендера и даёт кнопку обновления', () => {
  // React печатает пойманную ошибку в консоль — это ожидаемо, глушим шум.
  const err = vi.spyOn(console, 'error').mockImplementation(() => {});
  render(
    <ChunkErrorBoundary resetKey="budget/root">
      <Boom />
    </ChunkErrorBoundary>,
  );
  expect(screen.getByRole('alert')).toBeInTheDocument();
  expect(screen.getByTestId('chunk-reload')).toBeInTheDocument();
  // Шапка на кадре ошибки — по той же причине, что и у заглушки: в standalone-PWA
  // системной кнопки «назад» нет, и без неё пользователь заперт на этом кадре.
  expect(screen.getByRole('heading', { name: '…' })).toBeInTheDocument();
  err.mockRestore();
});

// Без этого сброса один провал чанка Budget запирал бы ВЕСЬ <main>: state класса переживает
// смену children, и вкладка «Чат» (грузится статически, ни в чём не виновата) показывала бы
// тот же кадр «Не удалось открыть экран» до ручной перезагрузки.
test('смена экрана снимает пойманную ошибку, тот же экран — держит', () => {
  const err = vi.spyOn(console, 'error').mockImplementation(() => {});
  const { rerender } = render(
    <ChunkErrorBoundary resetKey="budget/root">
      <Boom />
    </ChunkErrorBoundary>,
  );
  expect(screen.getByRole('alert')).toBeInTheDocument();

  // Тот же экран: перерендер здоровыми children кадр ошибки НЕ снимает.
  rerender(
    <ChunkErrorBoundary resetKey="budget/root">
      <div data-testid="ok" />
    </ChunkErrorBoundary>,
  );
  expect(screen.getByRole('alert')).toBeInTheDocument();
  expect(screen.queryByTestId('ok')).toBeNull();

  // Ушли на другой экран — граница пробует снова.
  rerender(
    <ChunkErrorBoundary resetKey="chat/root">
      <div data-testid="ok" />
    </ChunkErrorBoundary>,
  );
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.getByTestId('ok')).toBeInTheDocument();
  err.mockRestore();
});

// Честная запись того, чего resetKey НЕ умеет, — чтобы следующий читатель не решил, будто
// хождение по вкладкам чинит незагрузившийся экран. React.lazy кэширует ОТКАЗ загрузчика:
// `lazyInitializer` заходит в блок загрузки только при `_status === -1`
// (react/cjs/react.development.js:461), при отказе ставит `_status = 2` (:478-486) и дальше
// синхронно перебрасывает сохранённую ошибку (:513). Практический смысл: «сеть отвалилась →
// сеть вернулась» само не рассасывается, лечит только перезагрузка страницы.
test('после провала чанка возврат на экран НЕ перезагружает его: отказ закэширован', async () => {
  let loads = 0;
  const Broken = lazy(() => {
    loads++;
    return Promise.reject(new Error('Failed to fetch dynamically imported module'));
  });
  const err = vi.spyOn(console, 'error').mockImplementation(() => {});

  function Host({ at }: { at: 'broken' | 'other' }) {
    return (
      <ChunkErrorBoundary resetKey={at}>
        <Suspense fallback={<span data-testid="fb" />}>
          {at === 'broken' ? <Broken /> : <div data-testid="other-screen" />}
        </Suspense>
      </ChunkErrorBoundary>
    );
  }

  const { rerender } = render(<Host at="broken" />);
  await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
  expect(loads).toBe(1);

  // Ушли на другой экран — граница разблокировалась, ради этого resetKey и заведён.
  rerender(<Host at="other" />);
  expect(screen.getByTestId('other-screen')).toBeInTheDocument();

  // Вернулись: ни новой попытки загрузки, ни даже заглушки — кадр ошибки СРАЗУ.
  rerender(<Host at="broken" />);
  expect(loads).toBe(1);
  expect(screen.queryByTestId('fb')).toBeNull();
  expect(screen.getByRole('alert')).toBeInTheDocument();
  err.mockRestore();
});

// Собственно смысл всей затеи: экран Budget приезжает отдельным чанком, до его приезда
// в <main> стоит ScreenFallback, а второй заход на ту же вкладку заглушку уже НЕ показывает
// (React.lazy держит разрешённый модуль) — иначе разбиение стоило бы мигания на каждом
// переключении вкладок.
const budgetHandler: MockHandler = (path) => {
  if (path === 'budget.overview')
    return {
      period: { start: '2026-07-01', end: '2026-07-31' },
      balance: { income: '0.00', expense: '0.00', balance: '0.00' },
      envelopes: [],
      comingUp: [],
      planned: [],
      unbudgeted: [],
      alertCount: 0,
    };
  if (path === 'budget.postDue') return { posted: 0 };
  if (path === 'budget.rolloverPreview') return { month: '2026-07', rows: [], needsSetup: false };
  return {};
};

test('вкладка Budget: сперва ScreenFallback, потом сам экран; повторный заход — без заглушки', async () => {
  useNav.setState({
    activeTab: 'budget',
    stacks: { chat: [], browser: [], agenda: [], budget: [] },
  });
  renderWithProviders(<ActiveScreen />, budgetHandler);

  // Первый синхронный кадр — заглушка: чанк экрана ещё в пути.
  expect(screen.getByRole('heading', { name: '…' })).toBeInTheDocument();
  expect(screen.getAllByRole('status', { name: 'Загрузка' }).length).toBeGreaterThanOrEqual(3);

  await waitFor(() => expect(screen.getByText(/^Бюджет · /)).toBeInTheDocument());
  expect(screen.queryByRole('heading', { name: '…' })).toBeNull();

  // Ушли и вернулись: модуль уже разрешён, заголовок настоящего экрана есть СИНХРОННО.
  act(() => useNav.getState().switchTab('chat'));
  await waitFor(() => expect(screen.queryByText(/^Бюджет · /)).toBeNull());
  act(() => useNav.getState().switchTab('budget'));
  expect(screen.queryByRole('heading', { name: '…' })).toBeNull();
  expect(screen.getByText(/^Бюджет · /)).toBeInTheDocument();
});

// Второй разрез: экран сущности. Доказательство лени здесь не в заглушке (её титул «…»
// совпадает с собственным кадром загрузки DetailScreen, DetailScreen.tsx:79), а в том, что
// на первом синхронном кадре экран не успел сделать НИ ОДНОГО запроса: модуля ещё нет.
const detailEntity = {
  id: 'e1',
  ownerId: 'u',
  title: 'Задача',
  emoji: null,
  body: 'тело',
  bodyRefs: [],
  tags: [],
  meta: {},
  aspects: { 'orbis/task': { status: 'inbox' } },
  createdAt: '2026-07-05T00:00:00.000Z',
  updatedAt: '2026-07-05T10:00:00.000Z',
  archived: false,
};
const detailHandler: MockHandler = (path) => {
  if (path === 'entity.get')
    return { entity: detailEntity, relations: [], thread: { threadId: 'th1', messages: [] } };
  if (path === 'aspect.list') return [];
  return {};
};

test('экран сущности: первый кадр — заглушка без единого запроса, потом сам экран', async () => {
  useNav.setState({
    activeTab: 'browser',
    stacks: { chat: [], browser: [{ kind: 'entity', id: 'e1' }], agenda: [], budget: [] },
  });
  const { calls } = renderWithProviders(<ActiveScreen />, detailHandler);

  expect(calls).toHaveLength(0);
  expect(screen.getByRole('heading', { name: '…' })).toBeInTheDocument();

  await waitFor(() => expect(screen.getByRole('heading', { name: 'Задача' })).toBeInTheDocument());
  expect(calls.some((c) => c.path === 'entity.get')).toBe(true);
});

/**
 * Дать асинхронному решению обработчика досчитать ДО КОНЦА. Одна макрозадача сливает все
 * накопленные микрозадачи, а вся цепочка решения (проба → флаг → reload → finally) из них и
 * состоит. Синхронизироваться на «проба вызвана» нельзя: это НАЧАЛО решения, а не конец, и
 * событие, посланное в этот момент, попадает на ещё взведённый `deciding` и будет проглочено.
 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Провал чанка + ответ на вопрос «жив ли сервер». Ждём осевшего решения обработчика. */
async function preloadErrorWith(serverUp: boolean, reload: () => void) {
  const uninstall = installChunkReload(reload, () => Promise.resolve(serverUp));
  window.dispatchEvent(new Event('vite:preloadError', { cancelable: true }));
  await settle();
  return uninstall;
}

test('vite:preloadError перезагружает страницу ровно один раз за сессию вкладки', async () => {
  sessionStorage.clear();
  const reload = vi.fn();
  const uninstall = installChunkReload(reload, () => Promise.resolve(true));

  const first = new Event('vite:preloadError', { cancelable: true });
  window.dispatchEvent(first);
  await settle();
  expect(reload).toHaveBeenCalledTimes(1);
  // Событие НЕ отменяем намеренно: решение асинхронно, а vite читает defaultPrevented
  // синхронно. Отменив, мы получили бы `import()` → undefined и мусорную ошибку от React
  // вместо настоящей «Failed to fetch dynamically imported module».
  expect(first.defaultPrevented).toBe(false);

  // Второй провал в той же сессии вкладки перезагрузку уже не запускает.
  window.dispatchEvent(new Event('vite:preloadError', { cancelable: true }));
  await settle();
  expect(reload).toHaveBeenCalledTimes(1);

  uninstall();
  window.dispatchEvent(new Event('vite:preloadError', { cancelable: true }));
  await settle();
  expect(reload).toHaveBeenCalledTimes(1);
  sessionStorage.clear();
});

// Дефект, найденный живым смоуком: при остановленном сервере перезагрузка забирала
// приложение целиком (вкладка уходила на страницу ошибки браузера), а единственная попытка
// сгорала впустую. Событие приходит на ЛЮБОЙ отказ import(), не только на «чанк исчез».
test('сервер не отвечает → перезагрузки нет и попытка НЕ потрачена', async () => {
  sessionStorage.clear();
  const reload = vi.fn();
  const uninstall = await preloadErrorWith(false, reload);
  expect(reload).not.toHaveBeenCalled();
  expect(sessionStorage.getItem('orbis:chunk-reloaded')).toBeNull();
  uninstall();

  // Попытка цела: следующий провал — уже при живом сервере — лечится перезагрузкой.
  const reload2 = vi.fn();
  const uninstall2 = await preloadErrorWith(true, reload2);
  expect(reload2).toHaveBeenCalledTimes(1);
  uninstall2();
  sessionStorage.clear();
});

// Настоящая проба (без инъекции) на чужом 200. Captive portal отеля/аэропорта перехватывает
// запрос и отдаёт страницу входа с кодом 200 — при navigator.onLine === true. Приняв её за
// «сервер жив», мы бы увезли вкладку на страницу портала, то есть воспроизвели ровно тот
// отказ, против которого писан весь механизм.
test('captive portal: 200 с HTML — это не наш сервер, перезагрузки нет', async () => {
  sessionStorage.clear();
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response('<html><body>Войдите в сеть отеля</body></html>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    }),
  );
  const reload = vi.fn();
  const uninstall = installChunkReload(reload); // проба НАСТОЯЩАЯ

  // Событие повторяем внутри waitFor, пока его не примут: пока решение по первому не осело,
  // `deciding` взведён и повторы — no-op. Второе обращение к /health и ЕСТЬ признак того, что
  // первое решение досчитано. Ждать тут фиксированное число тиков нельзя: настоящая проба
  // читает тело (`res.json()`), а это не только микрозадачи.
  window.dispatchEvent(new Event('vite:preloadError', { cancelable: true }));
  await vi.waitFor(() => {
    window.dispatchEvent(new Event('vite:preloadError', { cancelable: true }));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  // Портальную страницу за наш сервер не приняли: ни перезагрузки, ни потраченной попытки.
  expect(reload).not.toHaveBeenCalled();
  expect(sessionStorage.getItem('orbis:chunk-reloaded')).toBeNull();
  uninstall();
  fetchMock.mockRestore();
  sessionStorage.clear();
});

test('настоящая проба принимает наш /health ({status:"ok"}) и перезагружает', async () => {
  sessionStorage.clear();
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify({ status: 'ok' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  );
  const reload = vi.fn();
  const uninstall = installChunkReload(reload);

  window.dispatchEvent(new Event('vite:preloadError', { cancelable: true }));
  await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
  expect(fetchMock.mock.calls[0]?.[0]).toBe('/health');
  uninstall();
  fetchMock.mockRestore();
  sessionStorage.clear();
});

// Отказ САМОЙ пробы не должен запирать механизм: без try/finally флаг `deciding` оставался бы
// взведённым, и автоперезаход выключался бы до конца жизни вкладки молча.
test('проба отклонилась → механизм не заперт, следующий провал обрабатывается', async () => {
  sessionStorage.clear();
  const reload = vi.fn();
  let attempt = 0;
  const uninstall = installChunkReload(reload, () => {
    attempt += 1;
    return attempt === 1 ? Promise.reject(new Error('проба сломалась')) : Promise.resolve(true);
  });

  window.dispatchEvent(new Event('vite:preloadError', { cancelable: true }));
  await settle();
  expect(attempt).toBe(1);
  expect(reload).not.toHaveBeenCalled();

  await vi.waitFor(() => {
    window.dispatchEvent(new Event('vite:preloadError', { cancelable: true }));
    expect(reload).toHaveBeenCalledTimes(1);
  });
  uninstall();
  sessionStorage.clear();
});

// Заблокированное хранилище (сторонний контекст, «блокировать все cookies»): getItem бросает
// SecurityError прямо из слушателя. Без гарантии «ровно один раз» перезагружаться нельзя —
// это цикл, — поэтому правильное поведение здесь именно бездействие, а не перезаход.
test('sessionStorage недоступен → слушатель не падает и не перезагружает', async () => {
  const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new DOMException('blocked', 'SecurityError');
  });
  // Одного «reload не вызван» мало: при броске из слушателя он тоже не вызывается, и тест
  // проходил бы на сломанном коде. Ловим сам факт броска — jsdom репортит исключение
  // слушателя как событие 'error' на window.
  const thrown: unknown[] = [];
  const onError = (e: ErrorEvent) => {
    thrown.push(e.error);
    e.preventDefault();
  };
  window.addEventListener('error', onError);

  const reload = vi.fn();
  const uninstall = await preloadErrorWith(true, reload);
  expect(thrown).toEqual([]);
  expect(reload).not.toHaveBeenCalled();

  window.removeEventListener('error', onError);
  uninstall();
  get.mockRestore();
});

// App.tsx:49 — единственная боевая точка установки. Без этого теста строку можно удалить,
// сьют останется зелёным, а прод потеряет автоперезаход целиком. Проверяем не мок модуля,
// а наблюдаемый факт: слушатель на window появился и снялся при размонтировании.
test('App ставит слушатель vite:preloadError и снимает его при размонтировании', () => {
  const add = vi.spyOn(window, 'addEventListener');
  const remove = vi.spyOn(window, 'removeEventListener');
  const { unmount } = renderWithProviders(<App />, () => ({}));
  expect(add.mock.calls.some(([type]) => type === 'vite:preloadError')).toBe(true);

  unmount();
  expect(remove.mock.calls.some(([type]) => type === 'vite:preloadError')).toBe(true);
  add.mockRestore();
  remove.mockRestore();
});
