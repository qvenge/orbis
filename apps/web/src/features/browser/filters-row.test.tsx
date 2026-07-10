import { fireEvent, render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { formatDay } from './EntityRow';
import { Filters } from './Filters';

// V2: кнопка «Применить» удалена — тег применяется по Enter, снятие чипа
// сразу пересобирает запрос.
test('Filters: Enter применяет тег, снятие чипа пересобирает запрос', () => {
  const onApply = vi.fn();
  render(<Filters onApply={onApply} />);
  const input = screen.getByLabelText('Добавить тег');

  fireEvent.change(input, { target: { value: 'работа' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(onApply).toHaveBeenLastCalledWith(expect.stringContaining('работа'));

  // Дубликат тега — no-op (второй чип не появляется, apply не зовётся повторно).
  const calls = onApply.mock.calls.length;
  fireEvent.change(input, { target: { value: 'работа' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(onApply.mock.calls.length).toBe(calls);
  expect(screen.getAllByText('работа')).toHaveLength(1);

  fireEvent.click(screen.getByRole('button', { name: /Удалить/i }));
  expect(onApply).toHaveBeenLastCalledWith('');
});

test('formatDay: date-only форматируется в UTC (без сдвига на день), битое — как есть', () => {
  // Независимо от локальной таймзоны теста date-only не должен уезжать назад.
  expect(formatDay('2026-07-18')).toMatch(/18/);
  expect(formatDay('не-дата')).toBe('не-дата');
});
