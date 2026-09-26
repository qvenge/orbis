/**
 * Меню ⋮ — ленивым чанком (задача 14 страниц 1а): отказ загрузки чанка на жест не проглатывается.
 *
 * Чанк не приехал (сеть, старая вкладка после деплоя с новыми именами) — нажатие обязано дать
 * видимый кадр ошибки экрана (`ChunkErrorBoundary`, с перезагрузкой), а не мёртвую кнопку; и
 * отказ не запоминается: следующий жест после возврата сети грузит меню заново.
 */
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ChunkErrorBoundary } from '../../app/ChunkErrorBoundary';
import { invalidateGraph } from '../../lib/invalidate';
import { noteRegistryVersion, resetRegistryVersionForTests } from '../../lib/registry/useRegistry';
import { useNav } from '../../state/navigation';
import { installCrashTrap, renderWithProviders, wireEntity } from '../../test/harness';
import { registryReply } from '../../test/registry';
import { trpc } from '../../trpc';
import { resetDetailMenuModuleForTests } from './DetailMenuSlot';
import { DetailScreen } from './DetailScreen';

/**
 * «Сеть»: пока `down`, загрузка модуля меню отказывает, как отказал бы `import()` чанка.
 * `attempts` — сколько раз модуль реально запрашивали: запомненный промис не запрашивает.
 * `gate` — медленный чанк: загрузка модуля ждёт его, прежде чем отдать модуль (Л-1: нажатие,
 * пришедшее до приезда чанка). По умолчанию разрешён — чанк приезжает сразу.
 * `registryVersion` — версия реестра в ответе `entity.get` (смена версии посреди загрузки).
 */
const network = vi.hoisted(() => ({
  down: false,
  attempts: 0,
  gate: Promise.resolve() as Promise<void>,
  registryVersion: undefined as string | undefined,
}));

installCrashTrap();

const ENTITY_ID = '00000000-0000-4000-8000-000000000a01';

beforeEach(() => {
  localStorage.clear();
  resetDetailMenuModuleForTests();
  resetRegistryVersionForTests();
  // Мок — заново на каждый тест: реестр модулей vitest помнит УДАВШУЮСЯ загрузку, и без
  // перерегистрации второй тест получил бы меню из кеша прошлого — «сети нет» не проверялось бы.
  vi.doMock('./DetailMenu', async (importOriginal) => {
    network.attempts += 1;
    if (network.down) throw new Error('Failed to fetch dynamically imported module');
    await network.gate;
    return importOriginal();
  });
  // Простой не наступает (тест «ничего до нажатия» ставит свой).
  vi.stubGlobal('requestIdleCallback', () => 1);
  useNav.setState({
    activeTab: 'browser',
    stacks: { chat: [], browser: [{ kind: 'entity', id: ENTITY_ID }], agenda: [], budget: [] },
  });
});

afterEach(() => {
  vi.doUnmock('./DetailMenu');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  network.down = false;
  network.attempts = 0;
  network.gate = Promise.resolve();
  network.registryVersion = undefined;
});

/**
 * Граница ошибок экрана, как в роутере; смена `resetKey` — уход с экрана и возврат.
 * `refetch` — проба «граф поменялся» (мутация где-то ещё): перечитывание всех взглядов на граф,
 * в том числе `entity.get` экрана, как после любой записи.
 */
function Screen() {
  const [visit, setVisit] = useState(0);
  const utils = trpc.useUtils();
  return (
    <>
      <button type="button" data-testid="revisit" onClick={() => setVisit((v) => v + 1)}>
        снова
      </button>
      <button type="button" data-testid="refetch" onClick={() => invalidateGraph(utils)}>
        перечитать
      </button>
      <ChunkErrorBoundary resetKey={`entity-${visit}`}>
        <DetailScreen entityId={ENTITY_ID} />
      </ChunkErrorBoundary>
    </>
  );
}

const handler = (path: string) => {
  if (path === 'entity.get')
    return {
      entity: wireEntity({ id: ENTITY_ID, title: 'Задача', aspects: ['orbis/task'] }),
      relations: [],
      thread: null,
      ...(network.registryVersion !== undefined && { registryVersion: network.registryVersion }),
    };
  return registryReply(path) ?? {};
};

/** Висящий медленный чанк меню: модуль приедет по `release()`. */
function slowChunk(): () => void {
  let release!: () => void;
  network.gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return release;
}

const entityGets = (calls: { path: string }[]) =>
  calls.filter((c) => c.path === 'entity.get').length;

test('чанк меню не приехал: нажатие — кадр ошибки экрана; после возврата сети жест грузит меню заново', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  network.down = true;
  renderWithProviders(<Screen />, handler);
  fireEvent.click(await screen.findByTestId('detail-menu'));
  expect(await screen.findByText('Не удалось открыть экран')).toBeInTheDocument();

  network.down = false;
  fireEvent.click(screen.getByTestId('revisit'));
  fireEvent.click(await screen.findByTestId('detail-menu'));
  expect(await screen.findByRole('menuitem', { name: 'Скопировать ссылку' })).toBeInTheDocument();
});

test('до нажатия чанк меню не запрашивается: рендер, наведение, фокус, простой — ни одного import', async () => {
  // Простой наступает сразу — у всех, кто его просит (редактор тела тоже).
  vi.stubGlobal('requestIdleCallback', (cb: () => void) => {
    cb();
    return 1;
  });
  renderWithProviders(<Screen />, handler);
  const button = await screen.findByTestId('detail-menu');
  fireEvent.pointerEnter(button);
  fireEvent.mouseEnter(button);
  act(() => button.focus());
  await act(async () => {
    await new Promise((r) => setTimeout(r, 50));
  });
  // Фоновый import() запрещён правилом app/chunk-reload.ts: его провал перезагрузил бы страницу.
  expect(network.attempts).toBe(0);
  expect(screen.getByTestId('detail-menu')).toBe(button);
  expect(button).toHaveAttribute('aria-expanded', 'false');
});

test('отказ форы на pointerdown молчит, click следом повторяет загрузку и открывает меню', async () => {
  // Необработанный отказ vitest ловит только ПОСЛЕ теста, под чужим именем, — ловим его здесь.
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  network.down = true;
  renderWithProviders(<Screen />, handler);
  const button = await screen.findByTestId('detail-menu');
  fireEvent.pointerDown(button);
  await act(async () => {
    await new Promise((r) => setTimeout(r, 50));
  });
  process.off('unhandledRejection', onUnhandled);
  expect(network.attempts).toBe(1);
  expect(unhandled).toEqual([]);
  expect(screen.queryByText('Не удалось открыть экран')).toBeNull();

  network.down = false;
  fireEvent.click(screen.getByTestId('detail-menu'));
  expect(await screen.findByRole('menuitem', { name: 'Скопировать ссылку' })).toBeInTheDocument();
  // Click повторил загрузку: отказ форы не запомнен.
  expect(network.attempts).toBe(2);
});

test('нажатие до приезда чанка: рефетч entity.get и смена версии реестра посреди загрузки не теряют нажатие (Л-1)', async () => {
  const release = slowChunk();
  const user = userEvent.setup();
  const { calls } = renderWithProviders(<Screen />, handler);
  // Полная последовательность жеста: pointerdown → mousedown → pointerup → mouseup → click.
  await user.click(await screen.findByTestId('detail-menu'));
  const before = entityGets(calls);
  // fireEvent, а не user: проба не должна уводить фокус с кнопки меню.
  fireEvent.click(screen.getByTestId('refetch'));
  network.registryVersion = 'v2';
  act(() => noteRegistryVersion('v2'));
  await waitFor(() => expect(entityGets(calls)).toBeGreaterThan(before));
  release();
  expect(await screen.findByRole('menu')).toBeInTheDocument();
});

test('кнопка меню — один узел от первого кадра: открытие и Escape её не подменяют, фокус возвращается ей (Л-1)', async () => {
  const user = userEvent.setup();
  renderWithProviders(<Screen />, handler);
  const button = await screen.findByTestId('detail-menu');
  fireEvent.click(button);
  // Имя меню — от кнопки слота («Меню»), а не от невидимого якоря Radix.
  await screen.findByRole('menu', { name: 'Меню' });
  expect(screen.getByTestId('detail-menu')).toBe(button);
  await user.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
  expect(screen.getByTestId('detail-menu')).toBe(button);
  expect(document.activeElement).toBe(button);
});
