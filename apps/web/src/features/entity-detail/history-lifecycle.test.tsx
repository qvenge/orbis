import { parseBody } from '@orbis/shared/doc';
import { type QueryClient, useQueryClient } from '@tanstack/react-query';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import type { Editor } from '@tiptap/core';
import { closeHistory, redoDepth, undoDepth } from '@tiptap/pm/history';
import { StrictMode, useState } from 'react';
import { expect, test, vi } from 'vitest';
import { DetailScreen } from '../../features/entity-detail/DetailScreen';
import { NativeRow } from '../../features/entity-detail/NativeRow';
import { canRedoStep, canUndoStep } from '../../features/entity-editor/arrows-stack';
import { BodyEditor } from '../../features/entity-editor/BodyEditor';
import { renderWithProviders, trpcError, wireEntity } from '../../test/harness';
import { navAt } from '../../test/nav';
import { registryReply } from '../../test/registry';
import { trpc } from '../../trpc';
import { observeTitleValue } from '../entity-editor/title-history';
import { detailGetInput } from './useEntityDetail';

const doc = parseBody('тело');
const entity = { ...wireEntity({ id: 'e1', title: 'План' }), bodyDoc: doc };
const fallback = (path: string) =>
  registryReply(path) ?? (path === 'entity.resolveRefs' || path === 'entity.suggest' ? [] : {});
test('cold remount with foreign title clears retained title/body history', async () => {
  let show: (v: string | null) => void = () => {};
  const save = vi.fn();
  function Host() {
    const [title, set] = useState<string | null>('План');
    show = set;
    return title === null ? (
      <div />
    ) : (
      <>
        <NativeRow entity={{ ...entity, title }} onToggleTask={() => {}} onSaveTitle={save} />
        <BodyEditor entityId="e1" doc={doc} onChange={() => {}} />
      </>
    );
  }
  renderWithProviders(<Host />, fallback);
  const field = await screen.findByTestId('title-edit');
  const heldEditor = (
    screen.getByTestId('body-editor').querySelector('.ProseMirror') as HTMLElement & {
      editor: Editor;
    }
  ).editor;
  act(() => heldEditor.commands.insertContentAt(1, 'own'));
  expect(undoDepth(heldEditor.state)).toBe(1);
  fireEvent.change(field, { target: { value: 'План Б' } });
  fireEvent.blur(field);
  await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
  act(() => show('План Б'));
  expect(canUndoStep('e1')).toBe(true);
  act(() => show(null));
  act(() => show('Чужое имя'));
  expect(screen.getByTestId('title-edit')).toHaveValue('Чужое имя');
  expect(
    (
      screen.getByTestId('body-editor').querySelector('.ProseMirror') as HTMLElement & {
        editor: Editor;
      }
    ).editor,
  ).toBe(heldEditor);
  expect(undoDepth(heldEditor.state)).toBe(0);
  expect(redoDepth(heldEditor.state)).toBe(0);
  expect(canUndoStep('e1')).toBe(false);
  fireEvent.keyDown(screen.getByTestId('title-edit'), { key: 'z', code: 'KeyZ', ctrlKey: true });
  expect(save).toHaveBeenCalledTimes(1);
});
test('current title CAS failure while offscreen clears e1 retained steps', async () => {
  navAt('e1');
  let change: (v: string) => void = () => {};
  let reject: (e: unknown) => void = () => {};
  let writes = 0;
  let reads = 0;
  const pending = new Promise((_res, rej) => {
    reject = rej;
  });
  function Host() {
    const [id, set] = useState('e1');
    change = set;
    return <DetailScreen entityId={id} />;
  }
  renderWithProviders(<Host />, (path, input) => {
    const vars = input as { id?: string };
    if (path === 'entity.get') {
      reads++;
      return {
        entity: { ...entity, id: vars.id ?? 'e1', title: vars.id === 'e2' ? 'Сосед' : 'План' },
        relations: [],
        thread: null,
      };
    }
    if (path === 'entity.update') {
      writes++;
      return pending;
    }
    return fallback(path);
  });
  const field = await screen.findByTestId('title-edit');
  fireEvent.change(field, { target: { value: 'План Б' } });
  fireEvent.blur(field);
  await waitFor(() => expect(writes).toBe(1));
  expect(canUndoStep('e1')).toBe(true);
  act(() => change('e2'));
  await waitFor(() => expect(screen.getByTestId('title-edit')).toHaveValue('Сосед'));
  const before = reads;
  await act(async () => {
    reject(
      trpcError('CONFLICT', 'CAS отказ', {
        code: 'CONFLICT',
        details: { reason: 'precondition_failed', mismatches: [{ property: 'orbis/title' }] },
      }),
    );
    await pending.catch(() => {});
  });
  await waitFor(() => expect(reads).toBeGreaterThan(before));
  expect(canUndoStep('e1')).toBe(false);
});

test('actual PM overflow after title preserves newest body as common top', async () => {
  renderWithProviders(
    <>
      <NativeRow entity={entity} onToggleTask={() => {}} onSaveTitle={() => {}} />
      <BodyEditor entityId="e1" doc={doc} onChange={() => {}} />
    </>,
    fallback,
  );
  const field = await screen.findByTestId('title-edit');
  const ed = (
    screen.getByTestId('body-editor').querySelector('.ProseMirror') as HTMLElement & {
      editor: Editor;
    }
  ).editor;
  act(() => {
    for (let i = 0; i < 120; i++) {
      ed.view.dispatch(closeHistory(ed.state.tr));
      ed.commands.insertContentAt(1, 'x');
    }
  });
  expect(undoDepth(ed.state)).toBe(120);
  fireEvent.change(field, { target: { value: 'План Б' } });
  act(() => ed.commands.insertContentAt(1, 'FINAL'));
  expect(undoDepth(ed.state)).toBe(100);
  fireEvent.keyDown(ed.view.dom, { key: 'z', code: 'KeyZ', ctrlKey: true });
  expect(field).toHaveValue('План Б');
  expect(ed.getText()).not.toContain('FINAL');
  expect(undoDepth(ed.state)).toBe(99);
  expect(redoDepth(ed.state)).toBe(1);
  expect(canRedoStep('e1')).toBe(true);
  fireEvent.keyDown(ed.view.dom, { key: 'z', code: 'KeyZ', ctrlKey: true, shiftKey: true });
  expect(ed.getText()).toContain('FINAL');
  expect(field).toHaveValue('План Б');
});

test('actual Detail cold get after query GC does not reuse steps against foreign title', async () => {
  navAt('e1');
  let change: (v: string) => void = () => {};
  let firstTitle = 'План';
  let writes = 0;
  let qc: QueryClient | null = null;
  function Host() {
    qc = useQueryClient();
    const [id, set] = useState('e1');
    change = set;
    return <DetailScreen entityId={id} />;
  }
  renderWithProviders(
    <Host />,
    (path, input) => {
      const vars = input as { id?: string; title?: string };
      if (path === 'entity.get')
        return {
          entity: {
            ...entity,
            id: vars.id ?? 'e1',
            title: vars.id === 'e2' ? 'Сосед' : firstTitle,
          },
          relations: [],
          thread: null,
        };
      if (path === 'entity.update') {
        writes++;
        firstTitle = vars.title ?? firstTitle;
        return { ...entity, title: firstTitle, actionId: 'a', consequences: false };
      }
      return fallback(path);
    },
    { queries: { gcTime: 0 } },
  );
  const field = await screen.findByTestId('title-edit');
  fireEvent.change(field, { target: { value: 'План Б' } });
  fireEvent.blur(field);
  await waitFor(() => expect(writes).toBe(1));
  await waitFor(() => expect(field).toHaveValue('План Б'));
  expect(canUndoStep('e1')).toBe(true);
  act(() => change('e2'));
  await waitFor(() => expect(screen.getByTestId('title-edit')).toHaveValue('Сосед'));
  await waitFor(() =>
    expect(
      qc!
        .getQueryCache()
        .getAll()
        .filter((q) => JSON.stringify(q.queryKey).includes('"e1"')),
    ).toHaveLength(0),
  );
  firstTitle = 'Чужое имя';
  act(() => change('e1'));
  await waitFor(() => expect(screen.getByTestId('title-edit')).toHaveValue('Чужое имя'));
  expect(canUndoStep('e1')).toBe(false);
});
test('gate20 current offscreen title CAS refusal clears cached history before return', async () => {
  navAt('e1');
  let change!: (id: string) => void;
  let title = 'План',
    writes = 0;
  let rejectHeld!: (err: unknown) => void;
  const held = new Promise((_resolve, reject) => {
    rejectHeld = reject;
  });
  function Host() {
    const [id, set] = useState('e1');
    change = set;
    const warm = trpc.entity.get.useQuery(detailGetInput('e2'));
    return (
      <>
        <span data-testid="warm-e2">{warm.data?.entity.title}</span>
        <DetailScreen entityId={id} />
      </>
    );
  }
  renderWithProviders(<Host />, (path, input) => {
    const vars = input as { id?: string; title?: string };
    if (path === 'entity.get')
      return {
        entity: { ...entity, id: vars.id ?? 'e1', title: vars.id === 'e2' ? 'Сосед' : title },
        relations: [],
        thread: null,
      };
    if (path === 'entity.update') {
      writes++;
      return held;
    }
    return fallback(path);
  });
  const field = await screen.findByTestId('title-edit');
  await waitFor(() => expect(screen.getByTestId('warm-e2')).toHaveTextContent('Сосед'));
  fireEvent.change(field, { target: { value: 'План Б' } });
  fireEvent.blur(field);
  await waitFor(() => expect(writes).toBe(1));
  expect(canUndoStep('e1')).toBe(true);
  act(() => change('e2'));
  await waitFor(() => expect(screen.getByTestId('title-edit')).toHaveValue('Сосед'));
  title = 'Чужой план';
  await act(async () => {
    rejectHeld(
      trpcError('CONFLICT', 'Чужое имя', {
        code: 'CONFLICT',
        details: { reason: 'precondition_failed', mismatches: [{ property: 'orbis/title' }] },
      }),
    );
    await held.catch(() => {});
  });
  expect(canUndoStep('e1')).toBe(false);
  act(() => change('e1'));
  await waitFor(() => expect(screen.getByTestId('title-edit')).toHaveValue('Чужой план'));
  expect(canUndoStep('e1')).toBe(false);
});

test('selection and addToHistory false do not put body above title', async () => {
  renderWithProviders(
    <>
      <NativeRow entity={entity} onToggleTask={() => {}} onSaveTitle={() => {}} />
      <BodyEditor entityId="e1" doc={doc} onChange={() => {}} />
    </>,
    fallback,
  );
  const field = await screen.findByTestId('title-edit');
  const ed = (
    screen.getByTestId('body-editor').querySelector('.ProseMirror') as HTMLElement & {
      editor: Editor;
    }
  ).editor;
  act(() => ed.commands.insertContentAt(1, 'own'));
  fireEvent.change(field, { target: { value: 'План Б' } });
  act(() => {
    ed.view.dispatch(ed.state.tr.setMeta('addToHistory', false).insertText('foreign', 1));
    ed.commands.setTextSelection(2);
  });
  expect(undoDepth(ed.state)).toBe(1);
  fireEvent.keyDown(ed.view.dom, { key: 'z', code: 'KeyZ', ctrlKey: true });
  expect(field).toHaveValue('План');
  expect(ed.getText()).toContain('foreignown');
  expect(undoDepth(ed.state)).toBe(1);
});

for (const accepted of [false, true])
  test(`own ${accepted ? 'accepted' : 'pending'} cold return retains history in StrictMode`, async () => {
    let show: (v: string | null) => void = () => {};
    const save = vi.fn(() => (accepted ? Promise.resolve() : new Promise(() => {})));
    function Host() {
      const [title, set] = useState<string | null>('План');
      show = set;
      return title === null ? null : (
        <NativeRow entity={{ ...entity, title }} onToggleTask={() => {}} onSaveTitle={save} />
      );
    }
    renderWithProviders(
      <StrictMode>
        <Host />
      </StrictMode>,
      fallback,
    );
    const field = await screen.findByTestId('title-edit');
    fireEvent.change(field, { target: { value: 'План Б' } });
    fireEvent.blur(field);
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    act(() => show(null));
    act(() => show('План Б'));
    expect(canUndoStep('e1')).toBe(true);
    fireEvent.keyDown(screen.getByTestId('title-edit'), { key: 'z', code: 'KeyZ', ctrlKey: true });
    expect(screen.getByTestId('title-edit')).toHaveValue('План');
    expect(save).toHaveBeenLastCalledWith('План', 'План Б');
  });
test('readOnly span cannot undo; returning editable checks retained foreign basis', async () => {
  let show: (v: { title: string; editable: boolean }) => void = () => {};
  const save = vi.fn();
  function Host() {
    const [state, set] = useState({ title: 'План', editable: true });
    show = set;
    return (
      <NativeRow
        entity={{ ...entity, title: state.title }}
        onToggleTask={() => {}}
        onSaveTitle={state.editable ? save : undefined}
      />
    );
  }
  renderWithProviders(<Host />, fallback);
  fireEvent.change(await screen.findByTestId('title-edit'), { target: { value: 'План Б' } });
  expect(canUndoStep('e1')).toBe(true);
  act(() => show({ title: 'Чужое', editable: false }));
  expect(screen.queryByTestId('title-edit')).toBeNull();
  act(() => show({ title: 'Чужое', editable: true }));
  expect(canUndoStep('e1')).toBe(false);
  fireEvent.keyDown(screen.getByTestId('title-edit'), { key: 'z', code: 'KeyZ', ctrlKey: true });
  expect(save).not.toHaveBeenCalled();
});

test('actual title-only LRU eviction forgets retained observer basis', async () => {
  let show: (id: string) => void = () => {};
  function Host() {
    const [id, set] = useState('e1');
    show = set;
    return (
      <NativeRow
        entity={{ ...entity, id, title: id }}
        onToggleTask={() => {}}
        onSaveTitle={() => {}}
      />
    );
  }
  renderWithProviders(<Host />, fallback);
  await screen.findByTestId('title-edit');
  for (const id of ['e2', 'e3', 'e4', 'e5', 'e6']) act(() => show(id));
  expect(observeTitleValue('e1', 'cold unseen')).toBe(false);
  expect(observeTitleValue('e6', 'foreign current')).toBe(true);
});
