import { fireEvent, render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { Badge } from './Badge';
import { Checkbox } from './Checkbox';
import { Chip } from './Chip';
import { Input } from './Input';
import { Skeleton } from './Skeleton';
import { Tabs } from './Tabs';

test('Input прокидывает value/aria и type=text по умолчанию', () => {
  render(<Input aria-label="поле" value="x" onChange={() => {}} />);
  const el = screen.getByLabelText('поле') as HTMLInputElement;
  expect(el.value).toBe('x');
  expect(el.type).toBe('text');
});

test('Badge рендерит контент и tone', () => {
  render(<Badge tone="danger">99+</Badge>);
  const b = screen.getByText('99+');
  expect(b).toBeInTheDocument();
  expect(b.className).toContain('bg-danger');
});

test('Chip удаляется по кнопке', () => {
  const onRemove = vi.fn();
  render(<Chip onRemove={onRemove}>tag</Chip>);
  fireEvent.click(screen.getByRole('button', { name: /удалить/i }));
  expect(onRemove).toHaveBeenCalled();
});

test('Checkbox переключается и вызывает onCheckedChange', () => {
  const onCheckedChange = vi.fn();
  render(<Checkbox aria-label="готово" checked={false} onCheckedChange={onCheckedChange} />);
  fireEvent.click(screen.getByRole('checkbox', { name: 'готово' }));
  expect(onCheckedChange).toHaveBeenCalledWith(true);
});

test('Skeleton имеет role=status', () => {
  render(<Skeleton />);
  expect(screen.getByRole('status')).toBeInTheDocument();
});

test('Tabs переключает панель по клику', () => {
  render(
    <Tabs
      defaultValue="a"
      tabs={[
        { value: 'a', label: 'A', content: <div>panel-a</div> },
        { value: 'b', label: 'B', content: <div>panel-b</div> },
      ]}
    />,
  );
  expect(screen.getByText('panel-a')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('tab', { name: 'B' }));
  expect(screen.getByText('panel-b')).toBeInTheDocument();
});
