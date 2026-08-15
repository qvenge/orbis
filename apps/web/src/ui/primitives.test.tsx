import { fireEvent, render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { Badge } from './Badge';
import { Button } from './Button';
import { Checkbox } from './Checkbox';
import { Chip } from './Chip';
import { Dialog } from './Dialog';
import { EmptyState } from './EmptyState';
import { Input } from './Input';
import { Sheet } from './Sheet';
import { Skeleton } from './Skeleton';
import { Spinner } from './Spinner';
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

test('Checkbox: индикатор — SVG-иконка, не текстовый глиф ✓', () => {
  const { container } = render(
    <Checkbox aria-label="сделано" checked={true} onCheckedChange={() => {}} />,
  );
  expect(container.querySelector('svg')).toBeInTheDocument();
  expect(screen.queryByText('✓')).not.toBeInTheDocument();
});

test('Chip: кнопка удаления — SVG-иконка, не глиф ×', () => {
  const { container } = render(<Chip onRemove={() => {}}>tag</Chip>);
  const btn = screen.getByRole('button', { name: /удалить/i });
  expect(btn.querySelector('svg')).toBeInTheDocument();
  expect(container.textContent).not.toContain('×');
});

test('Dialog: есть кнопка «Закрыть» с иконкой, overlay без bg-black', () => {
  const onOpenChange = vi.fn();
  render(
    <Dialog open onOpenChange={onOpenChange} title="Заголовок">
      <div>тело</div>
    </Dialog>,
  );
  const close = screen.getByRole('button', { name: 'Закрыть' });
  expect(close.querySelector('svg')).toBeInTheDocument();
  fireEvent.click(close);
  expect(onOpenChange).toHaveBeenCalledWith(false);
  expect(document.querySelector('.bg-black\\/50')).not.toBeInTheDocument();
});

test('Sheet: есть кнопка «Закрыть», overlay без bg-black', () => {
  const onOpenChange = vi.fn();
  render(
    <Sheet open onOpenChange={onOpenChange} title="Меню">
      <div>тело</div>
    </Sheet>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Закрыть' }));
  expect(onOpenChange).toHaveBeenCalledWith(false);
  expect(document.querySelector('.bg-black\\/50')).not.toBeInTheDocument();
});

test('EmptyState рендерит title, hint и action', () => {
  render(
    <EmptyState
      title="Пока пусто"
      hint="Создайте первую запись"
      action={<Button>Создать</Button>}
    />,
  );
  expect(screen.getByText('Пока пусто')).toBeInTheDocument();
  expect(screen.getByText('Создайте первую запись')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Создать' })).toBeInTheDocument();
});

test('Spinner: role=status и aria-label по умолчанию «Загрузка»', () => {
  render(<Spinner />);
  const s = screen.getByRole('status', { name: 'Загрузка' });
  expect(s).toBeInTheDocument();
  expect(s.querySelector('svg.animate-spin')).toBeInTheDocument();
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

test('по умолчанию неактивная вкладка НЕ смонтирована', () => {
  // Поведение по умолчанию — договор, а не деталь: экран настроек держит шесть вкладок, и
  // безусловный forceMount смонтировал бы их все разом, разослав их запросы при каждом входе
  // в настройки (ревью Б8).
  render(
    <Tabs
      defaultValue="a"
      tabs={[
        { value: 'a', label: 'A', content: <div>panel-a</div> },
        { value: 'b', label: 'B', content: <div>panel-b</div> },
      ]}
    />,
  );
  expect(screen.queryByText('panel-b')).toBeNull();
});

test('keepMounted держит СВОЮ вкладку живой, не трогая соседей', () => {
  // Флаг — у каждой вкладки, а не у компонента. На detail живой обязана остаться ровно одна
  // («Сущность» с редактором, где лежит несохранённый текст и история отмены), а «Тред» —
  // нет: ChatThread на монтировании заводит chat.listMessages, и общий флаг платил бы лишним
  // запросом за вкладку, которую не открывали.
  render(
    <Tabs
      defaultValue="a"
      tabs={[
        { value: 'a', label: 'A', content: <div>panel-a</div>, keepMounted: true },
        { value: 'b', label: 'B', content: <div>panel-b</div>, keepMounted: true },
        { value: 'c', label: 'C', content: <div>panel-c</div> },
      ]}
    />,
  );
  // Живая, но неактивная вкладка в дереве есть…
  expect(screen.getByText('panel-b')).toBeInTheDocument();
  // …а вкладка без флага — нет.
  expect(screen.queryByText('panel-c')).toBeNull();

  // Спрятана она КЛАССОМ: с forceMount Radix проставляет `hidden={!present}`, а `present` при
  // нём всегда true — то есть атрибут `hidden` неактивную вкладку не прячет, и без класса она
  // осталась бы на экране поверх активной. Разметку проверяем именно так: применить CSS в
  // jsdom нечем, и «не видно» здесь непроверяемо в принципе.
  const inactive = screen.getByRole('tabpanel', { name: 'B' });
  expect(inactive).toHaveAttribute('data-state', 'inactive');
  expect(inactive).not.toHaveAttribute('hidden');
  expect(inactive.className).toContain('data-[state=inactive]:hidden');

  // Переключение работает и не роняет соседнюю живую панель.
  fireEvent.click(screen.getByRole('tab', { name: 'B' }));
  expect(screen.getByRole('tabpanel', { name: 'B' })).toHaveAttribute('data-state', 'active');
  expect(screen.getByText('panel-a')).toBeInTheDocument();
});
