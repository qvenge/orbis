import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { expect, test, vi } from 'vitest';
import {
  field,
  textManyDef,
} from '../../features/entity-detail/properties-relations/test-fixtures';
import { ScalarListControl } from './ScalarListControl';

function Harness({ initial = ['Дом, работа', 'Второе'] }: { initial?: string[] }) {
  const [items, setItems] = useState(initial);
  return (
    <>
      <ScalarListControl def={textManyDef} value={items} onChange={setItems} />
      <output data-testid="items">{JSON.stringify(items)}</output>
    </>
  );
}

test('same-label scalar lists distinguish the property key and remove only the addressed raw row', () => {
  const first = vi.fn();
  const second = vi.fn();
  const other = field({ kind: 'text', cardinality: 'many' }, 'user/second-list');
  render(
    <>
      <ScalarListControl def={textManyDef} value={['Одинаково']} onChange={first} />
      <ScalarListControl def={other} value={['Одинаково']} onChange={second} />
    </>,
  );
  const buttons = screen.getAllByRole('button', { name: /^Удалить строку 1/ });
  expect(new Set(buttons.map((button) => button.getAttribute('aria-label'))).size).toBe(2);
  expect(buttons[0]?.getAttribute('aria-label')).toContain(textManyDef.key);
  expect(buttons[1]?.getAttribute('aria-label')).toContain(other.key);
  fireEvent.click(buttons[1] as HTMLButtonElement);
  expect(second).toHaveBeenCalledExactlyOnceWith([]);
  expect(first).not.toHaveBeenCalled();
});

test('отдельные строки без split: add/remove/raw/[]', async () => {
  const user = userEvent.setup();
  render(<Harness />);
  const first = screen.getByRole('textbox', { name: 'Поле теста: строка 1' });
  expect(first).toHaveValue('Дом, работа');
  await user.type(first, ', ещё');
  expect(screen.getByTestId('items')).toHaveTextContent('["Дом, работа, ещё","Второе"]');
  await user.click(screen.getByRole('button', { name: 'Добавить строку' }));
  expect(screen.getByRole('textbox', { name: 'Поле теста: строка 3' })).toHaveValue('');
  await user.click(screen.getByRole('button', { name: /^Удалить строку 2:/ }));
  expect(screen.getByTestId('items')).toHaveTextContent('["Дом, работа, ещё",""]');
  await user.click(screen.getByRole('button', { name: /^Удалить строку 2:/ }));
  await user.click(screen.getByRole('button', { name: /^Удалить строку 1:/ }));
  expect(screen.getByTestId('items')).toHaveTextContent('[]');
});

test('keyboard доступен без submit; disabled блокирует input/add/remove', async () => {
  const user = userEvent.setup();
  const onChange = vi.fn();
  const { rerender } = render(
    <ScalarListControl
      def={field({ kind: 'number', cardinality: 'many' })}
      value={['1e']}
      onChange={onChange}
    />,
  );
  const input = screen.getByRole('textbox', { name: 'Поле теста: строка 1' });
  expect(input).toHaveValue('1e');
  expect(input).toHaveAttribute('inputmode', 'decimal');
  await user.tab();
  expect(input).toHaveFocus();
  await user.tab();
  await user.keyboard('{Enter}');
  expect(onChange).toHaveBeenLastCalledWith([]);
  rerender(<ScalarListControl def={textManyDef} value={['один']} onChange={onChange} disabled />);
  expect(screen.getByRole('textbox')).toBeDisabled();
  for (const button of screen.getAllByRole('button')) {
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('type', 'button');
  }
  onChange.mockClear();
  fireEvent.click(screen.getByRole('button', { name: 'Добавить строку' }));
  fireEvent.click(screen.getByRole('button', { name: /^Удалить строку 1:/ }));
  expect(onChange).not.toHaveBeenCalled();
});
