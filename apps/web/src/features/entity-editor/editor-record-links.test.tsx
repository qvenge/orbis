import { parseBody } from '@orbis/shared/doc';
import { useQueryClient } from '@tanstack/react-query';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import type { Editor } from '@tiptap/react';
import { useState } from 'react';
import { beforeEach, expect, test, vi } from 'vitest';
import { Markdown } from '../../lib/markdown/Markdown';
import { createIntentsOf } from '../../lib/optimistic/use-create-intent';
import { resetNavForTests, useNav } from '../../state/navigation';
import { renderWithProviders, wireEntity } from '../../test/harness';
import { recordAddress, topAddress } from '../../test/nav';
import { BodyEditor } from './BodyEditor';

const id = '019e4466-1111-7000-8000-0123456789ab';

beforeEach(() => resetNavForTests());

test('редактор сохраняет href обычной ссылки, а клик и клавиатура используют правило записи', async () => {
  const editor = { current: null as Editor | null };
  const change = vi.fn();
  renderWithProviders(
    <BodyEditor
      doc={parseBody(`[запись](/entity/${id})`)}
      onChange={change}
      onReady={(value) => {
        editor.current = value;
      }}
    />,
  );
  const link = await screen.findByRole('link', { name: 'запись' });
  expect(link).toHaveAttribute('href', `/entity/${id}`);
  const browserOpen = vi.spyOn(window, 'open').mockReturnValue(null);
  const native: boolean[] = [];
  const swallow = (event: Event) => {
    native.push(!event.defaultPrevented);
    event.preventDefault();
  };
  document.addEventListener('click', swallow);
  try {
    // Tiptap handles pointer activation from ProseMirror's mouseup handler.
    // Exercise that hook without depending on jsdom text geometry.
    const up = new MouseEvent('mouseup', { ctrlKey: true, button: 0 });
    Object.defineProperty(up, 'target', { value: link });
    editor.current?.view.someProp('handleClick', (handle) => {
      const view = editor.current?.view;
      return view && handle(view, 1, up);
    });
    expect(browserOpen).not.toHaveBeenCalled();
    fireEvent.click(link, { ctrlKey: true });
    expect(native).toEqual([true]);
    expect(topAddress()).toMatchObject({ kind: 'home' });
    fireEvent.click(link);
    expect(native).toEqual([true, false]);
    expect(topAddress()).toEqual(recordAddress(id));

    resetNavForTests();
    link.focus();
    fireEvent.keyDown(link, { key: 'Enter' });
    expect(topAddress()).toEqual(recordAddress(id));
    expect(change).not.toHaveBeenCalled();
  } finally {
    document.removeEventListener('click', swallow);
    browserOpen.mockRestore();
  }
});

test('касание обычной ссылки начинает чтение, прокрутка его отменяет', async () => {
  const { calls, queryClient } = renderWithProviders(
    <BodyEditor doc={parseBody(`[запись](/r/${id})`)} onChange={vi.fn()} readOnly />,
    () => new Promise(() => {}),
    { freshness: true },
  );
  const link = await screen.findByRole('link', { name: 'запись' });
  fireEvent.pointerDown(link, { pointerType: 'touch', pointerId: 1, button: 0, clientX: 20 });
  await waitFor(() => expect(calls.filter((call) => call.path === 'entity.get')).toHaveLength(1));
  const query = queryClient
    .getQueryCache()
    .getAll()
    .find((item) => item.state.fetchStatus === 'fetching');
  expect(query).toBeDefined();
  fireEvent.pointerMove(link, { pointerType: 'touch', pointerId: 1, clientX: 29 });
  expect(query?.state.fetchStatus).toBe('idle');
});

test('редактируемая внешняя ссылка сохраняет окно и отключает opener', async () => {
  const href = 'https://example.test/doc';
  const editor = { current: null as Editor | null };
  renderWithProviders(
    <BodyEditor
      doc={parseBody(`[сайт](${href})`)}
      onChange={vi.fn()}
      onReady={(value) => {
        editor.current = value;
      }}
    />,
  );
  const link = await screen.findByRole('link', { name: 'сайт' });
  expect(link).toHaveAttribute('href', href);
  expect(link).toHaveAttribute('target', '_blank');
  expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'));
  const browserOpen = vi.spyOn(window, 'open').mockReturnValue(null);
  try {
    const view = editor.current?.view;
    if (!view) throw new Error('Editor view did not mount');
    const geometry = vi.spyOn(view, 'posAtCoords').mockReturnValue({ pos: 1, inside: 0 });
    link.setAttribute('target', 'orbis-help');
    try {
      fireEvent.mouseDown(link, { button: 0, clientX: 5, clientY: 5 });
      fireEvent.mouseUp(link, { button: 0, clientX: 5, clientY: 5 });
      expect(browserOpen).not.toHaveBeenCalled();
      expect(fireEvent.click(link)).toBe(false);
      expect(browserOpen).toHaveBeenCalledExactlyOnceWith(href, 'orbis-help', 'noopener');
      let native = false;
      document.addEventListener(
        'click',
        (event) => {
          native = !event.defaultPrevented;
          event.preventDefault();
        },
        { once: true },
      );
      fireEvent.mouseDown(link, { button: 0, ctrlKey: true, clientX: 5, clientY: 5 });
      fireEvent.mouseUp(link, { button: 0, ctrlKey: true, clientX: 5, clientY: 5 });
      fireEvent.click(link, { ctrlKey: true });
      expect(native).toBe(true);
      expect(browserOpen).toHaveBeenCalledTimes(1);
    } finally {
      geometry.mockRestore();
    }
    expect(topAddress()).toMatchObject({ kind: 'home' });
  } finally {
    browserOpen.mockRestore();
  }
});

test('внешняя ссылка в режиме чтения остаётся нативной', async () => {
  const href = 'https://example.test/doc';
  renderWithProviders(
    <BodyEditor doc={parseBody(`[сайт](${href})`)} onChange={vi.fn()} readOnly />,
  );
  const link = await screen.findByRole('link', { name: 'сайт' });
  const browserOpen = vi.spyOn(window, 'open').mockReturnValue(null);
  let native = false;
  document.addEventListener(
    'click',
    (event) => {
      native = !event.defaultPrevented;
      event.preventDefault();
    },
    { once: true },
  );
  try {
    fireEvent.click(link);
    expect(native).toBe(true);
    expect(browserOpen).not.toHaveBeenCalled();
  } finally {
    browserOpen.mockRestore();
  }
});

test.each([
  ['path', false],
  ['relative', false],
  ['scheme-relative', false],
  ['fragment', false],
  ['dot-segment', false],
  ['path', true],
] as const)('Markdown and a Link mark gate %s before ACK (reject: %s)', async (alias, reject) => {
  const change = vi.fn();
  let acknowledge: (() => void) | undefined;
  let id = '';
  let href = '';
  function PendingMark() {
    const registry = createIntentsOf(useQueryClient());
    const [attempt] = useState(() =>
      registry.begin({
        origin: 'capture',
        draftIdentity: 'mark',
        command: { source: 'quick_capture', input: { title: 'Draft', tags: [] } },
      }),
    );
    if (!attempt) throw new Error('Failed to begin create');
    id = attempt.id;
    href = {
      path: `/r/${id}`,
      relative: `r/${id}`,
      'scheme-relative': `//${window.location.host}/r/${id}`,
      fragment: `/r/${id}#label`,
      'dot-segment': `/./r/${id}`,
    }[alias];
    acknowledge = () =>
      registry.settle(
        attempt,
        reject
          ? { kind: 'rejected', message: 'Refused' }
          : {
              kind: 'ack',
              result: {
                ...wireEntity({ id, graphId: 'owner', title: 'Draft' }),
                bodyChangedAt: '2026-11-03T00:00:00.000Z',
                bodyRevision: 1,
              },
            },
      );
    return (
      <>
        <BodyEditor doc={parseBody(`[черновик](${href})`)} onChange={change} readOnly />
        <Markdown source={`[черновик Markdown](${href}) [внешняя](//outside.test/r/${id})`} />
      </>
    );
  }
  const { calls } = renderWithProviders(<PendingMark />, undefined, { freshness: true });
  // Bare relative hrefs are stripped by the shared Tiptap URI policy; Markdown keeps them.
  const names = alias === 'relative' ? ['черновик Markdown'] : ['черновик', 'черновик Markdown'];
  const pending = await screen.findByRole('button', { name: names[0] });
  expect(pending).not.toHaveAttribute('href');
  expect(screen.getByRole('button', { name: 'черновик Markdown' })).not.toHaveAttribute('href');
  expect(screen.getByRole('link', { name: 'внешняя' })).toHaveAttribute(
    'rel',
    'noopener noreferrer',
  );
  fireEvent.click(pending, { ctrlKey: true });
  fireEvent(pending, new MouseEvent('auxclick', { bubbles: true, button: 1 }));
  fireEvent.contextMenu(pending);
  expect(useNav.getState().pendingCreate).toBeNull();
  expect(topAddress()).toMatchObject({ kind: 'home' });
  fireEvent.focus(pending);
  fireEvent.pointerDown(pending, { pointerType: 'touch', pointerId: 1, button: 0 });
  fireEvent.click(pending);
  expect(useNav.getState().pendingCreate).toBe(id);
  expect(topAddress()).toMatchObject({ kind: 'home' });
  expect(calls.some(({ path }) => path === 'entity.get')).toBe(false);
  act(() => acknowledge?.());
  if (reject) {
    act(() => useNav.getState().closePendingCreate(id));
    for (const name of names) {
      const rejected = screen.getByRole('button', { name });
      expect(rejected).not.toHaveAttribute('href');
      fireEvent.focus(rejected);
      fireEvent.click(rejected);
    }
    expect(useNav.getState().pendingCreate).toBeNull();
    expect(topAddress()).toMatchObject({ kind: 'home' });
    expect(calls.some(({ path }) => path === 'entity.get')).toBe(false);
  } else {
    for (const name of names)
      expect(await screen.findByRole('link', { name })).toHaveAttribute('href', href);
  }
  expect(change).not.toHaveBeenCalled();
});
