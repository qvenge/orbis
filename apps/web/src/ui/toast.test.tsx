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

test('плашка с действием — одна ячейка, извещения копятся', () => {
  const s = useToastStore.getState();
  s.show('Первое', 'default', { label: 'Отменить', onSelect() {} });
  s.show('Сохранено');
  s.show('Второе', 'default', { label: 'Отменить', onSelect() {} });
  expect(useToastStore.getState().toasts.map((t) => t.title)).toEqual(['Сохранено', 'Второе']);
});
test('скрытая вкладка и фокус держат независимые паузы с остатком', () => {
  render(<Toaster />);
  act(() => {
    useToastStore.getState().show('Закрыто', 'default', { label: 'Отменить', onSelect() {} });
  });
  const toast = screen.getByText('Закрыто').closest('li') as HTMLElement;
  act(() => vi.advanceTimersByTime(3000));
  fireEvent.focus(toast);
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
  act(() => document.dispatchEvent(new Event('visibilitychange')));
  fireEvent.blur(toast);
  act(() => vi.advanceTimersByTime(30000));
  expect(useToastStore.getState().toasts).toHaveLength(1);
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
  act(() => document.dispatchEvent(new Event('visibilitychange')));
  act(() => vi.advanceTimersByTime(6999));
  expect(useToastStore.getState().toasts).toHaveLength(1);
  act(() => vi.advanceTimersByTime(1));
  expect(useToastStore.getState().toasts).toHaveLength(0);
  Reflect.deleteProperty(document, 'visibilityState');
});
test('описание и Tab доступны, старые компоненты удалены', async () => {
  render(<Toaster />);
  act(() => {
    useToastStore
      .getState()
      .show('Версия', 'default', { label: 'Отменить', onSelect() {} }, 'Страховка');
  });
  expect(screen.getByText('Версия').closest('li')?.tabIndex).toBe(0);
  expect(screen.getByText('Страховка')).toBeInTheDocument();
  expect(Object.keys(await import('./Toast'))).toEqual(['Toaster']);
});

test('несколько причин паузы не снимают друг друга', () => {
  const s = useToastStore.getState();
  const id = s.show('Второе', 'default', { label: 'Отменить', onSelect() {} });
  s.pause(id, 'touch');
  s.pause(id, 'hover');
  s.resume(id, 'touch');
  vi.advanceTimersByTime(30000);
  expect(useToastStore.getState().toasts).toHaveLength(1);
  s.resume(id, 'hover');
  vi.advanceTimersByTime(10000);
  expect(useToastStore.getState().toasts).toHaveLength(0);
});

test('палец ставит таймер на паузу; смахивание вправо закрывает, вертикальный жест сохраняет плашку', () => {
  render(<Toaster />);
  const pointer = (kind: string, x: number, y: number) => {
    const event = new Event(kind, { bubbles: true });
    for (const [key, value] of Object.entries({
      pointerType: 'touch',
      pointerId: 1,
      clientX: x,
      clientY: y,
    }))
      Object.defineProperty(event, key, { value });
    return event;
  };
  act(() =>
    useToastStore.getState().show('Первое', 'default', { label: 'Отменить', onSelect() {} }),
  );
  const first = screen.getByText('Первое').closest('li')!;
  fireEvent(first, pointer('pointerdown', 0, 0));
  act(() => vi.advanceTimersByTime(20_000));
  expect(first).toBeInTheDocument();
  fireEvent(first, pointer('pointerup', 80, 0));
  expect(screen.queryByText('Первое')).toBeNull();
  act(() => useToastStore.getState().show('Второе'));
  const second = screen.getByText('Второе').closest('li')!;
  fireEvent(second, pointer('pointerdown', 0, 0));
  fireEvent(second, pointer('pointerup', 80, 80));
  expect(second).toBeInTheDocument();
});
