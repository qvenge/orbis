/**
 * Механика ленивого меню (Л-1, РП-13): стабильная кнопка с первого кадра + содержимое меню из
 * ленивого чанка. Тесты НЕ знают экрана записи намеренно: та же механика понесёт одно меню «⋯»
 * рамки (задача 19 среза 1б), и тесты должны пережить переезд.
 *
 * Загрузчик — двойник: висящий промис с `release` (медленный чанк) и счётчик вызовов (сколько раз
 * чанк реально запросили бы).
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { ChunkErrorBoundary } from '../app/ChunkErrorBoundary';
import { DropdownMenu, type DropdownMenuItem } from './DropdownMenu';
import { type LazyMenuControl, LazyMenuSlot, type LazyMenuTriggerProps } from './LazyMenuSlot';

afterEach(() => {
  vi.restoreAllMocks();
});

type ProbeProps = { items: DropdownMenuItem[] };

/** Содержимое «ленивого чанка»: настоящее Radix-меню в управляемой форме. */
function ProbeMenu(props: ProbeProps & LazyMenuControl) {
  return <DropdownMenu {...props} />;
}

/** Двойник загрузчика: `release` отдаёт модуль, `down` — чанк не приезжает. */
function loaderDouble() {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const state = { calls: 0, down: false };
  const load = () => {
    state.calls += 1;
    if (state.down) return Promise.reject(new Error('Failed to fetch dynamically imported module'));
    return gate.then(() => ProbeMenu);
  };
  return { load, release, state };
}

const items = (...labels: string[]): DropdownMenuItem[] =>
  labels.map((label) => ({ label, onSelect: vi.fn() }));

const probeTrigger = (t: LazyMenuTriggerProps) => (
  <button type="button" data-testid="probe-trigger" aria-label="Действия" {...t}>
    ⋯
  </button>
);

function Probe({
  load,
  menuItems,
}: {
  load: () => Promise<typeof ProbeMenu>;
  menuItems: DropdownMenuItem[];
}) {
  return <LazyMenuSlot load={load} menuProps={{ items: menuItems }} renderTrigger={probeTrigger} />;
}

test('(1) до нажатия загрузчик не зван; кнопка — триггер меню с первого кадра', async () => {
  const { load, state } = loaderDouble();
  render(<Probe load={load} menuItems={items('Первый', 'Второй')} />);
  const button = screen.getByTestId('probe-trigger');
  fireEvent.pointerEnter(button);
  fireEvent.mouseEnter(button);
  act(() => button.focus());
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
  expect(state.calls).toBe(0);
  expect(button).toHaveAttribute('aria-haspopup', 'menu');
  expect(button).toHaveAttribute('aria-expanded', 'false');
});

test('(2) нажатие до приезда чанка: кнопка сразу «раскрыта», после приезда — меню, кнопка тот же узел', async () => {
  const { load, release } = loaderDouble();
  const user = userEvent.setup();
  render(<Probe load={load} menuItems={items('Первый', 'Второй')} />);
  const button = screen.getByTestId('probe-trigger');
  await user.click(button);
  expect(button).toHaveAttribute('aria-expanded', 'true');
  await act(async () => release());
  expect(await screen.findByRole('menu')).toBeInTheDocument();
  expect(screen.getByTestId('probe-trigger')).toBe(button);
});

test('(3) Enter на кнопке до приезда чанка: после приезда меню открыто', async () => {
  const { load, release } = loaderDouble();
  const user = userEvent.setup();
  render(<Probe load={load} menuItems={items('Первый', 'Второй')} />);
  const button = screen.getByTestId('probe-trigger');
  act(() => button.focus());
  await user.keyboard('{Enter}');
  await act(async () => release());
  expect(await screen.findByRole('menu')).toBeInTheDocument();
  expect(button).toHaveAttribute('aria-expanded', 'true');
});

test('(4) новые пункты, пришедшие между нажатием и приездом чанка, — в открытом меню', async () => {
  const { load, release } = loaderDouble();
  const user = userEvent.setup();
  const { rerender } = render(<Probe load={load} menuItems={items('Первый', 'Второй')} />);
  await user.click(screen.getByTestId('probe-trigger'));
  rerender(<Probe load={load} menuItems={items('Третий')} />);
  await act(async () => release());
  expect(await screen.findByRole('menuitem', { name: 'Третий' })).toBeInTheDocument();
  expect(screen.queryByRole('menuitem', { name: 'Первый' })).toBeNull();
});

test('(5) Escape закрывает меню и возвращает фокус той же кнопке; повторное нажатие — без второй загрузки', async () => {
  const { load, release, state } = loaderDouble();
  const user = userEvent.setup();
  release();
  render(<Probe load={load} menuItems={items('Первый', 'Второй')} />);
  const button = screen.getByTestId('probe-trigger');
  await user.click(button);
  await screen.findByRole('menu');
  await user.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
  expect(screen.getByTestId('probe-trigger')).toBe(button);
  expect(document.activeElement).toBe(button);
  expect(button).toHaveAttribute('aria-expanded', 'false');

  await user.click(button);
  expect(await screen.findByRole('menu')).toBeInTheDocument();
  expect(state.calls).toBe(1);
});

test('(6) выбор пункта зовёт его onSelect и закрывает меню', async () => {
  const { load, release } = loaderDouble();
  const user = userEvent.setup();
  release();
  const menuItems = items('Первый', 'Второй');
  render(<Probe load={load} menuItems={menuItems} />);
  const button = screen.getByTestId('probe-trigger');
  await user.click(button);
  await user.click(await screen.findByRole('menuitem', { name: 'Первый' }));
  expect(menuItems[0]?.onSelect).toHaveBeenCalledTimes(1);
  expect(menuItems[1]?.onSelect).not.toHaveBeenCalled();
  await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
  expect(button).toHaveAttribute('aria-expanded', 'false');
});

test('(8) список назван кнопкой слота, кнопка ссылается на открытый список (aria-controls)', async () => {
  const { load, release } = loaderDouble();
  const user = userEvent.setup();
  release();
  render(<Probe load={load} menuItems={items('Первый')} />);
  const button = screen.getByTestId('probe-trigger');
  expect(button).not.toHaveAttribute('aria-controls');
  await user.click(button);
  // Имя — от кнопки слота, а не от невидимого двойника-якоря Radix.
  const menu = await screen.findByRole('menu', { name: 'Действия' });
  expect(menu.id).not.toBe('');
  expect(button).toHaveAttribute('aria-controls', menu.id);
  await user.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
  expect(button).not.toHaveAttribute('aria-controls');
});

test('(7) отказ загрузки на нажатие — к границе ошибок; после смены resetKey жест грузит снова', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const { load, release, state } = loaderDouble();
  state.down = true;
  release();
  const user = userEvent.setup();
  function Screen() {
    const [visit, setVisit] = useState(0);
    return (
      <>
        <button type="button" data-testid="revisit" onClick={() => setVisit((v) => v + 1)}>
          снова
        </button>
        <ChunkErrorBoundary resetKey={`probe-${visit}`}>
          <Probe load={load} menuItems={items('Первый')} />
        </ChunkErrorBoundary>
      </>
    );
  }
  render(<Screen />);
  await user.click(screen.getByTestId('probe-trigger'));
  expect(await screen.findByText('Не удалось открыть экран')).toBeInTheDocument();
  const failedCalls = state.calls;

  state.down = false;
  await user.click(screen.getByTestId('revisit'));
  await user.click(await screen.findByTestId('probe-trigger'));
  expect(await screen.findByRole('menuitem', { name: 'Первый' })).toBeInTheDocument();
  expect(state.calls).toBe(failedCalls + 1);
});
