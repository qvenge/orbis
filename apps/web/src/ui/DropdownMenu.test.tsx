import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef, useState } from 'react';
import { expect, test, vi } from 'vitest';
import { recordLinkGestures } from '../lib/entity-ref/prefetch';
import { DropdownMenu, type DropdownMenuItem } from './DropdownMenu';

const href = '/r/018cd857-511b-7f25-870e-377777ceca00';

function Harness({ items }: { items: readonly DropdownMenuItem[] }) {
  const [open, setOpen] = useState(true);
  const anchorRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button id="menu-trigger" ref={anchorRef} type="button">
        Меню
      </button>
      <DropdownMenu
        items={items}
        open={open}
        onOpenChange={setOpen}
        anchorRef={anchorRef}
        triggerId="menu-trigger"
        contentId="menu-content"
      />
    </>
  );
}

test('пункт-ссылка в roving focus открывается клавиатурой один раз; обычный пункт сохраняет роль', async () => {
  const user = userEvent.setup();
  const selected = vi.fn();
  const focus = vi.fn();
  render(
    <Harness
      items={[
        { label: 'Действие', onSelect: vi.fn() },
        { label: 'Запись', onSelect: selected, link: { href, onFocus: focus } },
      ]}
    />,
  );
  const menu = await screen.findByRole('menu');
  expect(screen.getByRole('menuitem', { name: 'Действие' }).tagName).toBe('DIV');
  const link = screen.getByRole('menuitem', { name: 'Запись' });
  expect(link).toHaveAttribute('href', href);
  fireEvent.keyDown(menu, { key: 'ArrowDown' });
  await waitFor(() => expect(screen.getByRole('menuitem', { name: 'Действие' })).toHaveFocus());
  await user.keyboard('{ArrowDown}');
  await waitFor(() => expect(link).toHaveFocus());
  expect(focus).toHaveBeenCalled();
  await user.keyboard('{Enter}');
  expect(selected).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
});

test('модифицированный клик остаётся нативным, обычный выбирает пункт и закрывает меню', async () => {
  const selected = vi.fn();
  render(<Harness items={[{ label: 'Запись', onSelect: selected, link: { href } }]} />);
  const link = await screen.findByRole('menuitem');
  let native = false;
  document.addEventListener(
    'click',
    (event) => {
      native = !event.defaultPrevented;
      event.preventDefault();
    },
    { once: true },
  );
  fireEvent.click(link, { ctrlKey: true });
  expect(native).toBe(true);
  expect(selected).not.toHaveBeenCalled();
  expect(screen.getByRole('menu')).toBeInTheDocument();
  expect(fireEvent.click(link)).toBe(false);
  expect(selected).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
});

test('касание пункта начинает намерение, прокрутка отменяет; недоступный пункт не начинает его', async () => {
  const cancel = vi.fn();
  const prepare = vi.fn(() => cancel);
  const gestures = recordLinkGestures(prepare);
  const selected = vi.fn();
  const intent: NonNullable<DropdownMenuItem['link']> = {
    href,
    onPointerDown: (event) => gestures.down('record', event),
    onPointerMove: gestures.move,
    onPointerCancel: gestures.cancel,
  };
  render(
    <Harness
      items={[
        { label: 'Запись', onSelect: selected, link: intent },
        { label: 'Недоступна', onSelect: selected, disabled: true, link: intent },
      ]}
    />,
  );
  const link = await screen.findByRole('menuitem', { name: 'Запись' });
  const pointer = { pointerType: 'touch', pointerId: 7, button: 0, clientX: 0 };
  fireEvent.pointerDown(link, pointer);
  expect(prepare).toHaveBeenCalledExactlyOnceWith('record', 'touch');
  fireEvent.pointerMove(link, { ...pointer, clientX: 9 });
  expect(cancel).toHaveBeenCalledTimes(1);
  const unavailable = screen.getByRole('menuitem', { name: 'Недоступна' });
  expect(unavailable).not.toHaveAttribute('href');
  fireEvent.pointerDown(unavailable, pointer);
  fireEvent.click(unavailable);
  expect(prepare).toHaveBeenCalledTimes(1);
  expect(selected).not.toHaveBeenCalled();
});
