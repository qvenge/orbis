import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { Toaster } from './Toast';
import { useToastStore } from './toast-store';

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
