import { act, render, screen, waitFor } from '@testing-library/react';
import { lazy, Suspense } from 'react';
import { expect, test, vi } from 'vitest';
import { useNav } from '../state/navigation';
import { type MockHandler, renderWithProviders } from '../test/harness';
import { ChunkErrorBoundary } from './ChunkErrorBoundary';
import { installChunkReload } from './chunk-reload';
import { prefetchScreens } from './prefetch';
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

test('фоновая догрузка планируется одной задачей и снимается отменой', () => {
  const tasks: (() => Promise<PromiseSettledResult<unknown>[]>)[] = [];
  let cancelled = 0;
  const cancel = prefetchScreens({ budget: false }, (task) => {
    tasks.push(task);
    return () => {
      cancelled++;
    };
  });
  expect(tasks).toHaveLength(1);
  cancel();
  expect(cancelled).toBe(1);
});

// Гейт вкладки Budget (installedViews) — не украшение: пользователю без установленного view
// экран недостижим, и его чанк был бы чистой тратой трафика.
test('Budget догружается только при видимой вкладке; экран сущности — всегда', async () => {
  const run = async (budget: boolean) => {
    let task: (() => Promise<PromiseSettledResult<unknown>[]>) | undefined;
    prefetchScreens({ budget }, (t) => {
      task = t;
      return () => {};
    });
    const settled = await (task as () => Promise<PromiseSettledResult<unknown>[]>)();
    // Догрузка обязана отработать без отказов: модули существуют и импортируются.
    expect(settled.every((r) => r.status === 'fulfilled')).toBe(true);
    return settled.map((r) => (r.status === 'fulfilled' ? r.value : {}) as Record<string, unknown>);
  };

  const withoutBudget = await run(false);
  expect(withoutBudget).toHaveLength(1);
  expect(typeof withoutBudget[0]?.DetailScreen).toBe('function');

  const withBudget = await run(true);
  expect(withBudget).toHaveLength(2);
  expect(withBudget.some((m) => typeof m.DetailScreen === 'function')).toBe(true);
  expect(withBudget.some((m) => typeof m.BudgetScreen === 'function')).toBe(true);
});

// Перезаход — ответ на жест. vite шлёт vite:preloadError на любой провалившийся динамический
// import, и без флага «в полёте фоновая догрузка» провал того, чего пользователь не просил,
// забирал бы у него страницу — и тратил бы единственный на сессию автоперезаход впустую.
test('провал фоновой догрузки НЕ перезагружает страницу, пользовательский — перезагружает', async () => {
  sessionStorage.clear();
  const reload = vi.fn();
  const uninstall = installChunkReload(reload);

  let task: (() => Promise<PromiseSettledResult<unknown>[]>) | undefined;
  prefetchScreens({ budget: false }, (t) => {
    task = t;
    return () => {};
  });
  const inFlight = (task as () => Promise<PromiseSettledResult<unknown>[]>)();

  window.dispatchEvent(new Event('vite:preloadError', { cancelable: true }));
  expect(reload).not.toHaveBeenCalled();
  await inFlight;

  // Та же ошибка вне фоновой догрузки — уже пользовательская, перезаход положен.
  window.dispatchEvent(new Event('vite:preloadError', { cancelable: true }));
  expect(reload).toHaveBeenCalledTimes(1);

  uninstall();
  sessionStorage.clear();
});

test('vite:preloadError перезагружает страницу ровно один раз за сессию вкладки', () => {
  sessionStorage.clear();
  const reload = vi.fn();
  const uninstall = installChunkReload(reload);

  const first = new Event('vite:preloadError', { cancelable: true });
  window.dispatchEvent(first);
  expect(reload).toHaveBeenCalledTimes(1);
  // vite перебрасывает ошибку дальше, только если событие не отменили
  // (`if (!e.defaultPrevented) throw err`) — проверяем сам факт отмены.
  expect(first.defaultPrevented).toBe(true);

  // Второй провал в той же сессии вкладки перезагрузку уже не запускает — и событие
  // остаётся неотменённым, чтобы ошибка дошла до React и до ChunkErrorBoundary.
  const second = new Event('vite:preloadError', { cancelable: true });
  window.dispatchEvent(second);
  expect(reload).toHaveBeenCalledTimes(1);
  expect(second.defaultPrevented).toBe(false);

  uninstall();
  window.dispatchEvent(new Event('vite:preloadError', { cancelable: true }));
  expect(reload).toHaveBeenCalledTimes(1);
  sessionStorage.clear();
});
