import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { Toaster } from './Toast';
import { ACTION_DISMISS_MS, useToastStore } from './toast-store';

beforeEach(() => {
  vi.useFakeTimers();
  useToastStore.setState({ toasts: [] });
});

afterEach(() => {
  vi.useRealTimers();
});

test('show добавляет тост в стор с tone по умолчанию', () => {
  useToastStore.getState().show('Сохранено');
  const { toasts } = useToastStore.getState();
  expect(toasts).toHaveLength(1);
  expect(toasts[0]).toMatchObject({ title: 'Сохранено', tone: 'default' });
});

test('авто-dismiss: тост исчезает через 4 секунды', () => {
  useToastStore.getState().show('Скоро исчезну');
  expect(useToastStore.getState().toasts).toHaveLength(1);
  vi.advanceTimersByTime(3999);
  expect(useToastStore.getState().toasts).toHaveLength(1);
  vi.advanceTimersByTime(1);
  expect(useToastStore.getState().toasts).toHaveLength(0);
});

test('dismiss удаляет конкретный тост', () => {
  const store = useToastStore.getState();
  store.show('Первый');
  store.show('Второй', 'danger');
  const first = useToastStore.getState().toasts[0];
  if (!first) throw new Error('первый тост не создан');
  useToastStore.getState().dismiss(first.id);
  const { toasts } = useToastStore.getState();
  expect(toasts).toHaveLength(1);
  expect(toasts[0]?.title).toBe('Второй');
});

test('Toaster: тост появляется по show и не перехватывает фокус', () => {
  render(<Toaster />);
  act(() => {
    useToastStore.getState().show('Готово');
  });
  expect(screen.getByText('Готово')).toBeInTheDocument();
  expect(document.querySelector('[aria-live="polite"]')).toBeInTheDocument();
  expect(document.activeElement).toBe(document.body);
});

test('Toaster: действие тоста — кнопка; нажатие зовёт его и закрывает тост (РП-9)', () => {
  const onSelect = vi.fn();
  render(<Toaster />);
  act(() => {
    useToastStore.getState().show('Выбор запомнен', 'default', { label: 'Отменить', onSelect });
  });
  act(() => {
    screen.getByRole('button', { name: 'Отменить' }).click();
  });
  expect(onSelect).toHaveBeenCalledTimes(1);
  expect(useToastStore.getState().toasts).toHaveLength(0);
});

test('тост с действием живёт дольше и стоит, пока на нём курсор или фокус (C1-M3)', () => {
  render(<Toaster />);
  act(() => {
    useToastStore.getState().show('Вид записи теперь свой', 'default', {
      label: 'Отменить',
      onSelect: () => {},
    });
  });
  // Четырёх секунд тосту с «Отменить» мало — он ещё на месте.
  act(() => vi.advanceTimersByTime(4000));
  expect(screen.getByText('Вид записи теперь свой')).toBeInTheDocument();

  const toast = screen.getByText('Вид записи теперь свой').closest('li') as HTMLElement;
  fireEvent.mouseEnter(toast);
  act(() => vi.advanceTimersByTime(ACTION_DISMISS_MS * 3));
  expect(useToastStore.getState().toasts).toHaveLength(1);
  fireEvent.mouseLeave(toast);

  // Фокус внутри тоста — та же пауза (клавиатура тянется к «Отменить»).
  fireEvent.focus(screen.getByRole('button', { name: 'Отменить' }));
  act(() => vi.advanceTimersByTime(ACTION_DISMISS_MS * 3));
  expect(useToastStore.getState().toasts).toHaveLength(1);
  fireEvent.blur(screen.getByRole('button', { name: 'Отменить' }));

  // Отсчёт продолжился с остатка: 10 − 4 = 6 секунд.
  act(() => vi.advanceTimersByTime(ACTION_DISMISS_MS - 4000 - 1));
  expect(useToastStore.getState().toasts).toHaveLength(1);
  act(() => vi.advanceTimersByTime(1));
  expect(useToastStore.getState().toasts).toHaveLength(0);
});
