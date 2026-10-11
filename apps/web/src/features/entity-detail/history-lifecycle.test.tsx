import { parseBody } from '@orbis/shared/doc';
import { type QueryClient, useQueryClient } from '@tanstack/react-query';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import type { Editor } from '@tiptap/core';
import { closeHistory, redoDepth, undoDepth } from '@tiptap/pm/history';
import { type ReactNode, StrictMode, useRef, useState } from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { useExtensionRecordHooks } from '../../app/extension-registry';
import { DetailScreen } from '../../features/entity-detail/DetailScreen';
import { NativeRow } from '../../features/entity-detail/NativeRow';
import { canRedoStep, canUndoStep, clearAllSteps } from '../../features/entity-editor/arrows-stack';
import { BodyEditor } from '../../features/entity-editor/BodyEditor';
import {
  mockEntityUpdateResult,
  renderWithProviders,
  trpcError,
  wireEntity,
} from '../../test/harness';
import { navAt } from '../../test/nav';
import { BUILTIN_REGISTRY, registryReply } from '../../test/registry';
import { trpc } from '../../trpc';
import * as titleHistory from '../entity-editor/title-history';
import { observeTitleValue } from '../entity-editor/title-history';
import { SUPPLY_RECORDS_QUERY } from '../page/useSupplyRecords';
import { resetUndoSession } from '../undo/undo-epoch';
import { BodyScreenProvider, type BodyScreenValue } from './EntityBody';
import { BodyBlock } from './record-blocks';
import { RecordHostProvider, recordHostValue } from './record-host';
import { hostTemplateRecord } from './structure-fixtures';
import { detailGetInput } from './useEntityDetail';

const doc = parseBody('тело');
const entity = { ...wireEntity({ id: 'e1', title: 'План' }), bodyDoc: doc };
const fallback = (path: string) =>
  registryReply(path) ?? (path === 'entity.resolveRefs' || path === 'entity.suggest' ? [] : {});
afterEach(() => vi.unstubAllGlobals());

const BODY_ONLY_ARROWS = { titleShown: false, onTitleShown: () => {} };
function ControlledBodyHost({
  row,
  readOnly = false,
  arrows,
  children,
}: {
  row: Parameters<typeof recordHostValue>[0]['entity'];
  readOnly?: boolean;
  arrows?: BodyScreenValue['arrows'];
  children: ReactNode;
}) {
  const extensionHooks = useExtensionRecordHooks();
  const bodyGate = useRef<BodyScreenValue['bodyGate']['current']>(null);
  return (
    <RecordHostProvider
      value={recordHostValue(
        { entity: row, relations: [], registryVersion: BUILTIN_REGISTRY.version, bodyAction: null },
        { extensionHooks, openTab: 'record', readOnly },
      )}
    >
      <BodyScreenProvider
        value={{
          ...(arrows === undefined ? {} : { arrows }),
          asMarkdown: false,
          onCloseMarkdown: () => {},
          screenConflict: false,
          noticeHost: null,
          onRefresh: () => {},
          bodyGate,
        }}
      >
        {children}
      </BodyScreenProvider>
    </RecordHostProvider>
  );
}
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

for (const foreign of ['План Б', 'Чужое имя'])
  test(`failed unobserved title send does not authorize foreign cold value ${foreign}`, async () => {
    navAt('e1');
    let change: (id: string) => void = () => {};
    let qc: QueryClient | null = null;
    let firstTitle = 'План',
      writes = 0;
    let reject: (e: unknown) => void = () => {};
    const held = new Promise((_resolve, rej) => {
      reject = rej;
    });
    function Host() {
      const [id, set] = useState('e1');
      change = set;
      qc = useQueryClient();
      const warm = trpc.entity.get.useQuery(detailGetInput('e2'));
      return (
        <>
          <span data-testid="warm">{warm.data?.entity.title}</span>
          <DetailScreen entityId={id} />
        </>
      );
    }
    renderWithProviders(
      <Host />,
      (path, input) => {
        const vars = input as { id?: string; title?: string; expectedTitle?: string };
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
          if (writes === 1) return held;
          expect(vars).toMatchObject({ id: 'e1', title: 'План', expectedTitle: foreign });
          firstTitle = vars.title ?? '';
          return mockEntityUpdateResult({ ...entity, title: firstTitle });
        }
        return (
          registryReply(path) ??
          (path === 'entity.resolveRefs' || path === 'entity.suggest' ? [] : {})
        );
      },
      { queries: { gcTime: 0 } },
    );
    const field = await screen.findByTestId('title-edit');
    await waitFor(() => expect(screen.getByTestId('warm')).toHaveTextContent('Сосед'));
    fireEvent.change(field, { target: { value: 'План Б' } });
    act(() => {
      fireEvent.blur(field);
      change('e2');
    });
    await waitFor(() => expect(screen.getByTestId('title-edit')).toHaveValue('Сосед'));
    await waitFor(() => expect(writes).toBe(1));
    await act(async () => {
      reject(trpcError('INTERNAL_SERVER_ERROR', 'Запрос не записал title'));
      await held.catch(() => {});
    });
    await waitFor(() =>
      expect(
        qc
          ?.getQueryCache()
          .getAll()
          .filter((q) => JSON.stringify(q.queryKey).includes('"e1"')),
      ).toHaveLength(0),
    );
    firstTitle = foreign; // Независимая чужая запись после отказа собственной мутации.
    act(() => change('e1'));
    await waitFor(() => expect(screen.getByTestId('title-edit')).toHaveValue(foreign));
    if (canUndoStep('e1')) {
      fireEvent.keyDown(screen.getByTestId('title-edit'), {
        key: 'z',
        code: 'KeyZ',
        ctrlKey: true,
      });
      await waitFor(() => expect(writes).toBe(2));
      expect(firstTitle).toBe('План');
    }
    expect(writes).toBe(1);
  });

for (const scope of ['same', 'owner', 'generation'])
  for (const newer of ['План Б', 'План В'])
    test(`late failed send preserves ${scope} newer unobserved ${newer}`, async () => {
      let show: (title: string | null) => void = () => {};
      let reject: (error: unknown) => void = () => {};
      const held = new Promise<void>((_resolve, fail) => {
        reject = fail;
      });
      const save = vi
        .fn()
        .mockImplementationOnce(() => held)
        .mockResolvedValue(undefined);
      function Host() {
        const [title, set] = useState<string | null>('План');
        show = set;
        return title === null ? null : (
          <NativeRow entity={{ ...entity, title }} onToggleTask={() => {}} onSaveTitle={save} />
        );
      }
      renderWithProviders(<Host />, fallback);
      fireEvent.change(await screen.findByTestId('title-edit'), { target: { value: 'План Б' } });
      fireEvent.blur(screen.getByTestId('title-edit'));
      await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
      act(() => show(null));
      if (scope === 'owner') act(resetUndoSession);
      if (scope === 'generation') act(clearAllSteps);
      act(() => show('План'));
      fireEvent.change(screen.getByTestId('title-edit'), { target: { value: newer } });
      fireEvent.blur(screen.getByTestId('title-edit'));
      await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
      await act(async () => {
        reject(new Error('old request did not write'));
        await held.catch(() => {});
      });
      act(() => show(newer));
      expect(canUndoStep('e1')).toBe(true);
      fireEvent.keyDown(screen.getByTestId('title-edit'), {
        key: 'z',
        code: 'KeyZ',
        ctrlKey: true,
      });
      expect(screen.getByTestId('title-edit')).toHaveValue('План');
      expect(save).toHaveBeenLastCalledWith('План', newer);
    });

for (const foreign of ['План Б', 'Чужое имя'])
  test(`failed observed optimistic title send does not authorize foreign cold value ${foreign}`, async () => {
    const observed = vi.spyOn(titleHistory, 'observeTitleValue');
    navAt('e1');
    let change: (id: string) => void = () => {};
    let qc: QueryClient | null = null;
    let firstTitle = 'План',
      writes = 0;
    let reject: (e: unknown) => void = () => {};
    const held = new Promise((_resolve, rej) => {
      reject = rej;
    });
    function Host() {
      const [id, set] = useState('e1');
      change = set;
      qc = useQueryClient();
      const warm = trpc.entity.get.useQuery(detailGetInput('e2'));
      return (
        <>
          <span data-testid="warm">{warm.data?.entity.title}</span>
          <DetailScreen entityId={id} />
        </>
      );
    }
    renderWithProviders(
      <Host />,
      (path, input) => {
        const vars = input as { id?: string; title?: string; expectedTitle?: string };
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
          if (writes === 1) return held;
          expect(vars).toMatchObject({ id: 'e1', title: 'План', expectedTitle: foreign });
          firstTitle = vars.title ?? '';
          return mockEntityUpdateResult({ ...entity, title: firstTitle });
        }
        return (
          registryReply(path) ??
          (path === 'entity.resolveRefs' || path === 'entity.suggest' ? [] : {})
        );
      },
      { queries: { gcTime: 0 } },
    );
    const field = await screen.findByTestId('title-edit');
    await waitFor(() => expect(screen.getByTestId('warm')).toHaveTextContent('Сосед'));
    fireEvent.change(field, { target: { value: 'План Б' } });
    fireEvent.blur(field);
    await waitFor(() => expect(writes).toBe(1));
    await waitFor(() =>
      expect(
        qc
          ?.getQueryCache()
          .getAll()
          .some(
            (q) =>
              (q.state.data as { entity?: { id?: string; title?: string } })?.entity?.id === 'e1' &&
              (q.state.data as { entity?: { id?: string; title?: string } })?.entity?.title ===
                'План Б',
          ),
      ).toBe(true),
    );
    await waitFor(() => expect(observed).toHaveBeenCalledWith('e1', 'План Б'));
    act(() => change('e2'));
    await waitFor(() => expect(screen.getByTestId('title-edit')).toHaveValue('Сосед'));
    await waitFor(() => expect(writes).toBe(1));
    await act(async () => {
      reject(trpcError('INTERNAL_SERVER_ERROR', 'Запрос не записал title'));
      await held.catch(() => {});
    });
    await waitFor(() =>
      expect(
        qc
          ?.getQueryCache()
          .getAll()
          .filter((q) => JSON.stringify(q.queryKey).includes('"e1"')),
      ).toHaveLength(0),
    );
    firstTitle = foreign; // Независимая чужая запись после отказа собственной мутации.
    act(() => change('e1'));
    await waitFor(() => expect(screen.getByTestId('title-edit')).toHaveValue(foreign));
    if (canUndoStep('e1')) {
      fireEvent.keyDown(screen.getByTestId('title-edit'), {
        key: 'z',
        code: 'KeyZ',
        ctrlKey: true,
      });
      await waitFor(() => expect(writes).toBe(2));
      expect(firstTitle).toBe('План');
    }
    expect(writes).toBe(1);
  });

for (const accepted of [false, true])
  for (const observed of [false, true])
    test(`observed old refusal preserves newer C accepted=${accepted} observed=${observed}`, async () => {
      let show: (title: string | null) => void = () => {};
      let reject: (error: unknown) => void = () => {};
      const held = new Promise<void>((_resolve, fail) => {
        reject = fail;
      });
      const save = vi
        .fn()
        .mockImplementationOnce(() => held)
        .mockImplementation(() => (accepted ? Promise.resolve() : new Promise(() => {})));
      function Host() {
        const [title, set] = useState<string | null>('План');
        show = set;
        return title === null ? null : (
          <NativeRow entity={{ ...entity, title }} onToggleTask={() => {}} onSaveTitle={save} />
        );
      }
      renderWithProviders(<Host />, fallback);
      fireEvent.change(await screen.findByTestId('title-edit'), { target: { value: 'План Б' } });
      fireEvent.blur(screen.getByTestId('title-edit'));
      await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
      act(() => show('План Б'));
      fireEvent.change(screen.getByTestId('title-edit'), { target: { value: 'План В' } });
      fireEvent.blur(screen.getByTestId('title-edit'));
      await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
      if (observed) act(() => show('План В'));
      act(() => show(null));
      await act(async () => {
        reject(new Error('отказ без записи'));
        await held.catch(() => {});
      });
      act(() => show('План В'));
      expect(canUndoStep('e1')).toBe(true);
      fireEvent.keyDown(screen.getByTestId('title-edit'), {
        key: 'z',
        code: 'KeyZ',
        ctrlKey: true,
      });
      expect(screen.getByTestId('title-edit')).toHaveValue('План');
      expect(save).toHaveBeenLastCalledWith('План', 'План В');
    });

test('observed same-value undo success survives old failure and cold return', async () => {
  let show: (title: string | null) => void = () => {};
  let reject: (error: unknown) => void = () => {};
  const held = new Promise<void>((_resolve, fail) => {
    reject = fail;
  });
  const save = vi
    .fn()
    .mockImplementationOnce(() => held)
    .mockResolvedValue(undefined);
  function Host() {
    const [title, set] = useState<string | null>('План');
    show = set;
    return title === null ? null : (
      <NativeRow entity={{ ...entity, title }} onToggleTask={() => {}} onSaveTitle={save} />
    );
  }
  renderWithProviders(<Host />, fallback);
  fireEvent.change(await screen.findByTestId('title-edit'), { target: { value: 'План Б' } });
  fireEvent.blur(screen.getByTestId('title-edit'));
  await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
  act(() => show('План Б'));
  await new Promise((done) => setTimeout(done, titleHistory.TITLE_GROUP_DELAY_MS + 1));
  fireEvent.change(screen.getByTestId('title-edit'), { target: { value: 'План В' } });
  fireEvent.keyDown(screen.getByTestId('title-edit'), { key: 'z', code: 'KeyZ', ctrlKey: true });
  await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
  expect(save).toHaveBeenLastCalledWith('План Б', 'План Б');
  act(() => show(null));
  await act(async () => {
    reject(new Error('старый запрос не записал имя'));
    await held.catch(() => {});
  });
  act(() => show('План Б'));
  expect(canUndoStep('e1')).toBe(true);
  fireEvent.keyDown(screen.getByTestId('title-edit'), { key: 'z', code: 'KeyZ', ctrlKey: true });
  expect(screen.getByTestId('title-edit')).toHaveValue('План');
});

test('successful observed send settles offscreen and retains cold own history', async () => {
  let show: (title: string | null) => void = () => {};
  let resolve: () => void = () => {};
  const held = new Promise<void>((done) => {
    resolve = done;
  });
  const save = vi
    .fn()
    .mockImplementationOnce(() => held)
    .mockResolvedValue(undefined);
  function Host() {
    const [title, set] = useState<string | null>('План');
    show = set;
    return title === null ? null : (
      <NativeRow entity={{ ...entity, title }} onToggleTask={() => {}} onSaveTitle={save} />
    );
  }
  renderWithProviders(<Host />, fallback);
  fireEvent.change(await screen.findByTestId('title-edit'), { target: { value: 'План Б' } });
  fireEvent.blur(screen.getByTestId('title-edit'));
  await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
  act(() => show('План Б'));
  act(() => show(null));
  await act(async () => {
    resolve();
    await held;
  });
  act(() => show('План Б'));
  expect(canUndoStep('e1')).toBe(true);
  fireEvent.keyDown(screen.getByTestId('title-edit'), { key: 'z', code: 'KeyZ', ctrlKey: true });
  expect(screen.getByTestId('title-edit')).toHaveValue('План');
  expect(save).toHaveBeenLastCalledWith('План', 'План Б');
});

for (const scope of ['owner', 'generation'])
  for (const outcome of ['success', 'failure'])
    test(`observed old ${outcome} cannot alter new ${scope} token`, async () => {
      let show: (title: string | null) => void = () => {};
      let resolve: () => void = () => {};
      let reject: (error: unknown) => void = () => {};
      const held = new Promise<void>((done, fail) => {
        resolve = done;
        reject = fail;
      });
      const save = vi
        .fn()
        .mockImplementationOnce(() => held)
        .mockResolvedValue(undefined);
      function Host() {
        const [title, set] = useState<string | null>('План');
        show = set;
        return title === null ? null : (
          <NativeRow entity={{ ...entity, title }} onToggleTask={() => {}} onSaveTitle={save} />
        );
      }
      renderWithProviders(<Host />, fallback);
      fireEvent.change(await screen.findByTestId('title-edit'), { target: { value: 'План Б' } });
      fireEvent.blur(screen.getByTestId('title-edit'));
      await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
      act(() => show('План Б'));
      act(() => show(null));
      act(scope === 'owner' ? resetUndoSession : clearAllSteps);
      act(() => show('План'));
      fireEvent.change(screen.getByTestId('title-edit'), { target: { value: 'План Б' } });
      fireEvent.blur(screen.getByTestId('title-edit'));
      await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
      await act(async () => {
        if (outcome === 'success') resolve();
        else reject(new Error('старый отказ'));
        await held.catch(() => {});
      });
      act(() => show('План Б'));
      expect(canUndoStep('e1')).toBe(true);
      fireEvent.keyDown(screen.getByTestId('title-edit'), {
        key: 'z',
        code: 'KeyZ',
        ctrlKey: true,
      });
      expect(screen.getByTestId('title-edit')).toHaveValue('План');
    });
test('failed observed foreign basis resets retained native body and common steps', async () => {
  let show: (title: string | null) => void = () => {};
  let reject: (error: unknown) => void = () => {};
  const held = new Promise<void>((_done, fail) => {
    reject = fail;
  });
  const save = vi.fn(() => held);
  function Host() {
    const [title, set] = useState<string | null>('План');
    show = set;
    return title === null ? null : (
      <>
        <NativeRow entity={{ ...entity, title }} onToggleTask={() => {}} onSaveTitle={save} />
        <BodyEditor entityId="e1" doc={doc} onChange={() => {}} />
      </>
    );
  }
  renderWithProviders(<Host />, fallback);
  const field = await screen.findByTestId('title-edit');
  const editor = (
    screen.getByTestId('body-editor').querySelector('.ProseMirror') as HTMLElement & {
      editor: Editor;
    }
  ).editor;
  act(() => editor.commands.insertContentAt(1, 'own'));
  fireEvent.change(field, { target: { value: 'План Б' } });
  fireEvent.blur(field);
  await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
  act(() => show('План Б'));
  expect(undoDepth(editor.state)).toBe(1);
  act(() => show(null));
  await act(async () => {
    reject(new Error('отказ без записи'));
    await held.catch(() => {});
  });
  act(() => show('План Б'));
  expect(
    (
      screen.getByTestId('body-editor').querySelector('.ProseMirror') as HTMLElement & {
        editor: Editor;
      }
    ).editor,
  ).toBe(editor);
  expect(undoDepth(editor.state)).toBe(0);
  expect(redoDepth(editor.state)).toBe(0);
  expect(canUndoStep('e1')).toBe(false);
  fireEvent.keyDown(screen.getByTestId('title-edit'), { key: 'z', code: 'KeyZ', ctrlKey: true });
  expect(save).toHaveBeenCalledTimes(1);
});

test('confirmed own basis survives a refused same-value native undo send', async () => {
  let show: (title: string | null) => void = () => {};
  const save = vi
    .fn()
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(new Error('noop не записал имя'))
    .mockResolvedValue(undefined);
  function Host() {
    const [title, set] = useState<string | null>('План');
    show = set;
    return title === null ? null : (
      <NativeRow entity={{ ...entity, title }} onToggleTask={() => {}} onSaveTitle={save} />
    );
  }
  renderWithProviders(<Host />, fallback);
  fireEvent.change(await screen.findByTestId('title-edit'), { target: { value: 'План Б' } });
  fireEvent.blur(screen.getByTestId('title-edit'));
  await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
  act(() => show('План Б'));
  await new Promise((done) => setTimeout(done, titleHistory.TITLE_GROUP_DELAY_MS + 1));
  fireEvent.change(screen.getByTestId('title-edit'), { target: { value: 'План В' } });
  await act(async () => {
    fireEvent.keyDown(screen.getByTestId('title-edit'), { key: 'z', code: 'KeyZ', ctrlKey: true });
  });
  expect(save).toHaveBeenLastCalledWith('План Б', 'План Б');
  act(() => show(null));
  act(() => show('План Б'));
  expect(canUndoStep('e1')).toBe(true);
  fireEvent.keyDown(screen.getByTestId('title-edit'), { key: 'z', code: 'KeyZ', ctrlKey: true });
  expect(screen.getByTestId('title-edit')).toHaveValue('План');
});

for (const bodyTop of [false, true])
  for (const foreign of ['План Б', 'Чужое имя'])
    test(`mounted checkbox refusal resets title and netzero body ${foreign} bodyTop=${bodyTop}`, async () => {
      const task = { ...entity, aspects: ['orbis/task'], props: { 'orbis/task_status': 'inbox' } };
      const observed = vi.spyOn(titleHistory, 'observeTitleValue');
      navAt('e1');
      let qc: QueryClient | null = null;
      let serverTitle = 'План',
        writes = 0,
        checkboxes = 0,
        reads = 0;
      let reject: (e: unknown) => void = () => {};
      const held = new Promise((_resolve, rej) => {
        reject = rej;
      });
      const checkboxHeld = new Promise(() => {});
      function Host() {
        qc = useQueryClient();
        return <DetailScreen entityId="e1" />;
      }
      renderWithProviders(<Host />, (path, input) => {
        const vars = input as { id?: string; title?: string; expectedTitle?: string };
        if (path === 'entity.get') {
          reads++;
          return { entity: { ...task, title: serverTitle }, relations: [], thread: null };
        }
        if (path === 'entity.update') {
          if (vars.title === undefined) {
            checkboxes++;
            return checkboxHeld;
          }
          writes++;
          if (writes === 1) return held;
          expect(vars).toMatchObject({ id: 'e1', title: 'План', expectedTitle: foreign });
          serverTitle = vars.title;
          return mockEntityUpdateResult({ ...task, title: serverTitle });
        }
        return (
          registryReply(path) ??
          (path === 'entity.resolveRefs' || path === 'entity.suggest' ? [] : {})
        );
      });
      await screen.findByTestId('body-editor', undefined, { timeout: 10000 });
      const field = await screen.findByTestId('title-edit');
      fireEvent.change(field, { target: { value: 'План Б' } });
      fireEvent.blur(field);
      await waitFor(() => expect(writes).toBe(1));
      await waitFor(() =>
        expect(
          qc
            ?.getQueryCache()
            .getAll()
            .some(
              (q) =>
                (q.state.data as { entity?: { title: string } } | undefined)?.entity?.title ===
                'План Б',
            ),
        ).toBe(true),
      );
      await waitFor(() => expect(observed).toHaveBeenCalledWith('e1', 'План Б'));
      await screen.findByTestId('body-editor', undefined, { timeout: 10000 });
      const editor = (
        screen.getByTestId('body-editor').querySelector('.ProseMirror') as HTMLElement & {
          editor: Editor;
        }
      ).editor;

      if (bodyTop) act(() => editor.chain().focus().insertContentAt(1, 'own').run());
      if (bodyTop) act(() => editor.commands.deleteRange({ from: 1, to: 4 }));
      if (bodyTop) expect(undoDepth(editor.state)).toBe(1);
      fireEvent.click(screen.getByRole('checkbox', { name: /готово/i }));
      if (bodyTop) act(() => editor.commands.focus());
      await waitFor(() => expect(checkboxes).toBe(1));
      const before = reads,
        observedBefore = observed.mock.calls.filter((c) => c[1] === 'План Б').length;
      // Независимый писатель меняет сервер; первый запрос title ничего не записал.
      serverTitle = foreign;
      await act(async () => {
        reject(trpcError('INTERNAL_SERVER_ERROR', 'Запрос не записал title'));
        await held.catch(() => {});
      });
      await waitFor(() => expect(reads).toBeGreaterThan(before));
      await waitFor(() =>
        expect(
          qc
            ?.getQueryCache()
            .getAll()
            .some(
              (q) =>
                (q.state.data as { entity?: { title: string } } | undefined)?.entity?.title ===
                foreign,
            ),
        ).toBe(true),
      );
      if (foreign !== 'План Б') await waitFor(() => expect(canUndoStep('e1')).toBe(false));
      expect(observedBefore).toBeGreaterThan(0);
      if (bodyTop) {
        expect(canUndoStep('e1')).toBe(false);
        expect(undoDepth(editor.state)).toBe(0);
        expect(redoDepth(editor.state)).toBe(0);
      }
      if (canUndoStep('e1')) {
        fireEvent.keyDown(screen.getByTestId('title-edit'), {
          key: 'z',
          code: 'KeyZ',
          ctrlKey: true,
        });
        await waitFor(() => expect(writes).toBe(2));
      }
      expect(writes).toBe(1);
    });

for (const accepted of [false, true])
  for (const observed of [false, true])
    test(`mounted observed old refusal preserves newer C accepted=${accepted} observed=${observed}`, async () => {
      let show: (title: string | null) => void = () => {};
      let reject: (error: unknown) => void = () => {};
      const held = new Promise<void>((_resolve, fail) => {
        reject = fail;
      });
      const save = vi
        .fn()
        .mockImplementationOnce(() => held)
        .mockImplementation(() => (accepted ? Promise.resolve() : new Promise(() => {})));
      function Host() {
        const [title, set] = useState<string | null>('План');
        show = set;
        return title === null ? null : (
          <NativeRow entity={{ ...entity, title }} onToggleTask={() => {}} onSaveTitle={save} />
        );
      }
      renderWithProviders(<Host />, fallback);
      fireEvent.change(await screen.findByTestId('title-edit'), { target: { value: 'План Б' } });
      fireEvent.blur(screen.getByTestId('title-edit'));
      await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
      act(() => show('План Б'));
      fireEvent.change(screen.getByTestId('title-edit'), { target: { value: 'План В' } });
      fireEvent.blur(screen.getByTestId('title-edit'));
      await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
      if (observed) act(() => show('План В'));
      await act(async () => {
        reject(new Error('отказ без записи'));
        await held.catch(() => {});
      });
      expect(canUndoStep('e1')).toBe(true);
      act(() => show('План В'));
      expect(canUndoStep('e1')).toBe(true);
      fireEvent.keyDown(screen.getByTestId('title-edit'), {
        key: 'z',
        code: 'KeyZ',
        ctrlKey: true,
      });
      expect(screen.getByTestId('title-edit')).toHaveValue('План');
      expect(save).toHaveBeenLastCalledWith('План', 'План В');
    });

test('mounted latest double refusal clears failed basis before fresh input', async () => {
  let show: (title: string | null) => void = () => {};
  let reject: (error: unknown) => void = () => {};
  const held = new Promise<void>((_resolve, fail) => {
    reject = fail;
  });
  let rejectNew: (error: unknown) => void = () => {};
  const newer = new Promise<void>((_done, fail) => {
    rejectNew = fail;
  });
  const save = vi
    .fn()
    .mockImplementationOnce(() => held)
    .mockImplementation(() => newer);
  function Host() {
    const [title, set] = useState<string | null>('План');
    show = set;
    return title === null ? null : (
      <NativeRow entity={{ ...entity, title }} onToggleTask={() => {}} onSaveTitle={save} />
    );
  }
  renderWithProviders(<Host />, fallback);
  fireEvent.change(await screen.findByTestId('title-edit'), { target: { value: 'План Б' } });
  fireEvent.blur(screen.getByTestId('title-edit'));
  await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
  act(() => show('План Б'));
  fireEvent.change(screen.getByTestId('title-edit'), { target: { value: 'План В' } });
  fireEvent.blur(screen.getByTestId('title-edit'));
  await waitFor(() => expect(save).toHaveBeenCalledTimes(2));

  await act(async () => {
    reject(new Error('отказ без записи'));
    await held.catch(() => {});
  });
  expect(canUndoStep('e1')).toBe(true);
  await act(async () => {
    rejectNew(new Error('новый запрос тоже ничего не записал'));
    await newer.catch(() => {});
  });
  expect(canUndoStep('e1')).toBe(false);
  fireEvent.change(screen.getByTestId('title-edit'), { target: { value: 'Новое' } });
  expect(canUndoStep('e1')).toBe(true);
});

for (const bodyTop of [false, true])
  for (const foreign of ['План Б', 'Чужое имя'])
    test(`early remount before old refusal clears foreign basis ${foreign} bodyTop=${bodyTop}`, async () => {
      const task = { ...entity, aspects: ['orbis/task'], props: { 'orbis/task_status': 'inbox' } };
      const observed = vi.spyOn(titleHistory, 'observeTitleValue');
      navAt('e1');
      let change: (id: string) => void = () => {};
      let qc: QueryClient | null = null;
      let serverTitle = 'План',
        writes = 0,
        reads = 0,
        checkboxes = 0,
        bodyWrites = 0;
      let reject: (error: unknown) => void = () => {};
      const held = new Promise((_done, fail) => {
        reject = fail;
      });
      function Host() {
        const [id, set] = useState('e1');
        change = set;
        qc = useQueryClient();
        const warm = trpc.entity.get.useQuery(detailGetInput('e2'));
        return (
          <>
            <span data-testid="warm">{warm.data?.entity.title}</span>
            <DetailScreen entityId={id} />
          </>
        );
      }
      renderWithProviders(
        <Host />,
        (path, input) => {
          const vars = input as {
            id?: string;
            title?: string;
            expectedTitle?: string;
            bodyDoc?: unknown;
          };
          if (path === 'entity.get') {
            reads++;
            return {
              entity: {
                ...task,
                id: vars.id ?? 'e1',
                title: vars.id === 'e2' ? 'Сосед' : serverTitle,
              },
              relations: [],
              thread: null,
            };
          }
          if (path === 'entity.update') {
            if (vars.bodyDoc !== undefined) {
              bodyWrites++;
              return mockEntityUpdateResult({ ...task, title: serverTitle });
            }
            if (vars.title === undefined) {
              checkboxes++;
              return new Promise(() => {});
            }
            writes++;
            if (writes === 1) return held;
            expect(vars).toMatchObject({ id: 'e1', title: 'План', expectedTitle: foreign });
            serverTitle = vars.title;
            return mockEntityUpdateResult({ ...task, title: serverTitle });
          }
          return fallback(path);
        },
        { queries: { gcTime: 0 } },
      );
      const oldField = await screen.findByTestId('title-edit');
      await waitFor(() => expect(screen.getByTestId('warm')).toHaveTextContent('Сосед'));
      fireEvent.change(oldField, { target: { value: 'План Б' } });
      fireEvent.blur(oldField);
      await waitFor(() => expect(writes).toBe(1));
      await waitFor(() =>
        expect(
          qc
            ?.getQueryCache()
            .getAll()
            .some((q) => {
              const data = q.state.data as { entity?: { id: string; title: string } } | undefined;
              return data?.entity?.id === 'e1' && data.entity.title === 'План Б';
            }),
        ).toBe(true),
      );
      await waitFor(() => expect(observed).toHaveBeenCalledWith('e1', 'План Б'));
      await screen.findByTestId('body-editor', undefined, { timeout: 10000 });
      const editor = (
        screen.getByTestId('body-editor').querySelector('.ProseMirror') as HTMLElement & {
          editor: Editor;
        }
      ).editor;
      const unchangedBody = editor.getJSON();
      if (bodyTop) {
        act(() => editor.chain().focus().insertContentAt(1, 'own').run());
        act(() => editor.commands.deleteRange({ from: 1, to: 4 }));
        expect(undoDepth(editor.state)).toBe(1);
        expect(editor.getJSON()).toEqual(unchangedBody);
      }
      act(() => change('e2'));
      await waitFor(() => expect(screen.getByTestId('title-edit')).toHaveValue('Сосед'));
      await waitFor(() =>
        expect(
          qc
            ?.getQueryCache()
            .getAll()
            .filter((q) => JSON.stringify(q.queryKey).includes('"e1"')),
        ).toHaveLength(0),
      );
      serverTitle = foreign; // Независимая запись, пока собственный title-запрос ещё не завершён.
      act(() => change('e1'));
      await waitFor(() => expect(screen.getByTestId('title-edit')).toHaveValue(foreign));
      const newField = screen.getByTestId('title-edit');
      expect(newField).not.toBe(oldField);
      expect(oldField).not.toBeInTheDocument();
      await screen.findByTestId('body-editor', undefined, { timeout: 10000 });
      expect(
        (
          screen.getByTestId('body-editor').querySelector('.ProseMirror') as HTMLElement & {
            editor: Editor;
          }
        ).editor,
      ).toBe(editor);
      if (foreign === 'План Б') {
        expect(canUndoStep('e1')).toBe(true);
        if (bodyTop) expect(undoDepth(editor.state)).toBe(1);
      }
      fireEvent.click(await screen.findByRole('checkbox', { name: /готово/i }));
      await waitFor(() => expect(checkboxes).toBe(1));
      const before = reads;
      await act(async () => {
        reject(trpcError('INTERNAL_SERVER_ERROR', 'Запрос не записал title'));
        await held.catch(() => {});
      });
      await waitFor(() => expect(reads).toBeGreaterThan(before));
      await waitFor(() =>
        expect(
          qc
            ?.getQueryCache()
            .getAll()
            .some((q) => {
              const data = q.state.data as { entity?: { id: string; title: string } } | undefined;
              return data?.entity?.id === 'e1' && data.entity.title === foreign;
            }),
        ).toBe(true),
      );
      if (bodyTop) {
        expect(canUndoStep('e1')).toBe(false);
        expect(undoDepth(editor.state)).toBe(0);
        expect(redoDepth(editor.state)).toBe(0);
        expect(screen.getByRole('button', { name: 'Шаг назад' })).toBeDisabled();
        fireEvent.click(screen.getByRole('button', { name: 'Шаг назад' }));
        fireEvent.keyDown(editor.view.dom, { key: 'z', code: 'KeyZ', ctrlKey: true });
        expect(editor.getJSON()).toEqual(unchangedBody);
        await new Promise((done) => setTimeout(done, 2100));
        expect(bodyWrites).toBe(0);
      } else if (canUndoStep('e1')) {
        fireEvent.keyDown(newField, { key: 'z', code: 'KeyZ', ctrlKey: true });
        await waitFor(() => expect(writes).toBe(2));
        expect(serverTitle).toBe('План');
      }
      expect(writes).toBe(1);
      expect(canUndoStep('e1')).toBe(false);
    });

for (const observedC of [false, true])
  test(`coalesced earlier C does not block fresh B refusal observedC=${observedC}`, async () => {
    const task = { ...entity, aspects: ['orbis/task'], props: { 'orbis/task_status': 'inbox' } };
    const observed = vi.spyOn(titleHistory, 'observeTitleValue');
    observed.mockClear();
    navAt('e1');
    let change: (id: string) => void = () => {};
    let qc: QueryClient | null = null;
    let serverTitle = 'План',
      writes = 0,
      reads = 0,
      checkboxes = 0;
    let reject: (error: unknown) => void = () => {};
    const firstHeld = new Promise(() => {});
    const cHeld = new Promise(() => {});
    const latestHeld = new Promise((_done, fail) => {
      reject = fail;
    });
    function Host() {
      const [id, set] = useState('e1');
      change = set;
      qc = useQueryClient();
      const warm = trpc.entity.get.useQuery(detailGetInput('e2'));
      return (
        <>
          <span data-testid="warm">{warm.data?.entity.title}</span>
          <DetailScreen entityId={id} />
        </>
      );
    }
    const cachedTitle = () =>
      (
        qc
          ?.getQueryCache()
          .getAll()
          .find(
            (q) => (q.state.data as { entity?: { id: string } } | undefined)?.entity?.id === 'e1',
          )?.state.data as { entity: { title: string } } | undefined
      )?.entity.title;
    renderWithProviders(
      <Host />,
      (path, input) => {
        const vars = input as { id?: string; title?: string; expectedTitle?: string };
        if (path === 'entity.get') {
          reads++;
          return {
            entity: {
              ...task,
              id: vars.id ?? 'e1',
              title: vars.id === 'e2' ? 'Сосед' : serverTitle,
            },
            relations: [],
            thread: null,
          };
        }
        if (path === 'entity.update') {
          if (vars.title === undefined) {
            checkboxes++;
            return new Promise(() => {});
          }
          writes++;
          if (writes === 1) return firstHeld;
          if (writes === 2) {
            expect(vars.title).toBe('План В');
            return cHeld;
          }
          if (writes === 3) {
            expect(vars.title).toBe('План Б');
            return latestHeld;
          }
          expect(vars).toMatchObject({ id: 'e1', title: 'План', expectedTitle: 'План Б' });
          serverTitle = vars.title;
          return mockEntityUpdateResult({ ...task, title: serverTitle });
        }
        return fallback(path);
      },
      { queries: { gcTime: 0 } },
    );
    const old = await screen.findByTestId('title-edit');
    await waitFor(() => expect(screen.getByTestId('warm')).toHaveTextContent('Сосед'));
    fireEvent.change(old, { target: { value: 'План Б' } });
    fireEvent.blur(old);
    await waitFor(() => expect(writes).toBe(1));
    await waitFor(() => expect(cachedTitle()).toBe('План Б'));
    await waitFor(() => expect(observed).toHaveBeenCalledWith('e1', 'План Б'));
    act(() => change('e2'));
    await waitFor(() => expect(screen.getByTestId('title-edit')).toHaveValue('Сосед'));
    await waitFor(() =>
      expect(
        qc
          ?.getQueryCache()
          .getAll()
          .filter((q) => JSON.stringify(q.queryKey).includes('"e1"')),
      ).toHaveLength(0),
    );
    serverTitle = 'План Б'; // Независимый писатель; первый собственный запрос не завершён.
    act(() => change('e1'));
    await waitFor(() => expect(screen.getByTestId('title-edit')).toHaveValue('План Б'));
    const current = screen.getByTestId('title-edit');
    expect(current).not.toBe(old);
    expect(old).not.toBeInTheDocument();
    await act(async () => {
      await new Promise((done) => setTimeout(done, titleHistory.TITLE_GROUP_DELAY_MS + 1));
    });
    act(() => {
      fireEvent.change(current, { target: { value: 'План В' } });
      fireEvent.blur(current);
      if (!observedC) fireEvent.keyDown(current, { key: 'z', code: 'KeyZ', ctrlKey: true });
    });
    if (observedC) {
      await waitFor(() => expect(cachedTitle()).toBe('План В'));
      await waitFor(() => expect(observed).toHaveBeenCalledWith('e1', 'План В'));
      fireEvent.keyDown(current, { key: 'z', code: 'KeyZ', ctrlKey: true });
    }
    await waitFor(() => expect(writes).toBe(3));
    await waitFor(() => expect(cachedTitle()).toBe('План Б'));
    expect(
      observed.mock.calls.filter((call) => call[0] === 'e1' && call[1] === 'План В'),
    ).toHaveLength(observedC ? 1 : 0);
    expect(canUndoStep('e1')).toBe(true);
    fireEvent.click(await screen.findByRole('checkbox', { name: /готово/i }));
    await waitFor(() => expect(checkboxes).toBe(1));
    const before = reads;
    await act(async () => {
      reject(trpcError('INTERNAL_SERVER_ERROR', 'Последний B ничего не записал'));
      await latestHeld.catch(() => {});
    });
    await waitFor(() => expect(reads).toBeGreaterThan(before));
    await waitFor(() => expect(cachedTitle()).toBe('План Б'));
    if (canUndoStep('e1')) {
      await act(async () => {
        fireEvent.keyDown(current, { key: 'z', code: 'KeyZ', ctrlKey: true });
      });
      await waitFor(() => expect(writes).toBe(4));
      expect(serverTitle).toBe('План');
    }
    expect(writes).toBe(3);
  });

for (const accepted of [false, true])
  for (const observed of [false, true])
    test(`remounted observer preserves newer C accepted=${accepted} observed=${observed}`, async () => {
      let show: (title: string | null) => void = () => {};
      let reject: (error: unknown) => void = () => {};
      const held = new Promise<void>((_done, fail) => {
        reject = fail;
      });
      const save = vi
        .fn()
        .mockImplementationOnce(() => held)
        .mockImplementation(() => (accepted ? Promise.resolve() : new Promise(() => {})));
      function Host() {
        const [title, set] = useState<string | null>('План');
        show = set;
        return title === null ? null : (
          <NativeRow entity={{ ...entity, title }} onToggleTask={() => {}} onSaveTitle={save} />
        );
      }
      renderWithProviders(<Host />, fallback);
      const old = await screen.findByTestId('title-edit');
      fireEvent.change(old, { target: { value: 'План Б' } });
      fireEvent.blur(old);
      await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
      act(() => show('План Б'));
      act(() => show(null));
      act(() => show('План Б'));
      const current = screen.getByTestId('title-edit');
      expect(current).not.toBe(old);
      expect(old).not.toBeInTheDocument();
      fireEvent.change(current, { target: { value: 'План В' } });
      fireEvent.blur(current);
      await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
      if (observed) act(() => show('План В'));
      await act(async () => {
        reject(new Error('старый запрос не записал имя'));
        await held.catch(() => {});
      });
      expect(canUndoStep('e1')).toBe(true);
      act(() => show('План В'));
      expect(canUndoStep('e1')).toBe(true);
      fireEvent.keyDown(current, { key: 'z', code: 'KeyZ', ctrlKey: true });
      expect(current).toHaveValue('План');
      expect(save).toHaveBeenLastCalledWith('План', 'План В');
    });

for (const accepted of [false, true])
  test(`remounted same-value fresh intent survives older failure accepted=${accepted}`, async () => {
    let show: (title: string | null) => void = () => {};
    let reject: (error: unknown) => void = () => {};
    const held = new Promise<void>((_done, fail) => {
      reject = fail;
    });
    const save = vi
      .fn()
      .mockImplementationOnce(() => held)
      .mockImplementation(() => (accepted ? Promise.resolve() : new Promise(() => {})));
    function Host() {
      const [title, set] = useState<string | null>('План');
      show = set;
      return title === null ? null : (
        <NativeRow entity={{ ...entity, title }} onToggleTask={() => {}} onSaveTitle={save} />
      );
    }
    renderWithProviders(<Host />, fallback);
    const old = await screen.findByTestId('title-edit');
    fireEvent.change(old, { target: { value: 'План Б' } });
    fireEvent.blur(old);
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    act(() => show('План Б'));
    act(() => show(null));
    act(() => show('План Б'));
    const current = screen.getByTestId('title-edit');
    expect(current).not.toBe(old);
    await act(async () => {
      await new Promise((done) => setTimeout(done, titleHistory.TITLE_GROUP_DELAY_MS + 1));
    });
    fireEvent.change(current, { target: { value: 'План В' } });
    fireEvent.keyDown(current, { key: 'z', code: 'KeyZ', ctrlKey: true });
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    expect(save).toHaveBeenLastCalledWith('План Б', 'План Б');
    await act(async () => {
      reject(new Error('прежний запрос не записал имя'));
      await held.catch(() => {});
    });
    expect(canUndoStep('e1')).toBe(true);
    fireEvent.keyDown(current, { key: 'z', code: 'KeyZ', ctrlKey: true });
    expect(current).toHaveValue('План');
    expect(save).toHaveBeenLastCalledWith('План', 'План Б');
  });

for (const removeTitle of [false, true])
  test(`actual host template refresh before observed B refusal removesTitle=${removeTitle}`, async () => {
    const entity = {
      ...wireEntity({ id: 'e1', title: 'План' }),
      bodyDoc: doc,
      aspects: ['orbis/task'],
      props: { 'orbis/task_status': 'inbox' },
    };
    navAt('e1');
    const observed = vi.spyOn(titleHistory, 'observeTitleValue');
    observed.mockClear();
    let qc: QueryClient | null = null;
    let refetch: () => Promise<unknown> = async () => {};
    let template = '{{title}}\n\n{{body}}',
      serverTitle = 'План',
      serverBody = entity.bodyDoc;
    let titleWrites = 0,
      bodyWrites = 0,
      checkboxes = 0,
      reads = 0,
      supplyReads = 0;
    let rejected: (err: unknown) => void = () => {};
    const held = new Promise((_resolve, reject) => {
      rejected = reject;
    });
    function Host() {
      qc = useQueryClient();
      const utils = trpc.useUtils();
      refetch = () =>
        utils.entity.query.invalidate({ query: SUPPLY_RECORDS_QUERY, fields: 'full' });
      return <DetailScreen entityId="e1" />;
    }
    const cachedTitle = () =>
      (
        qc
          ?.getQueryCache()
          .getAll()
          .find(
            (q) => (q.state.data as { entity?: { id: string } } | undefined)?.entity?.id === 'e1',
          )?.state.data as { entity: { title: string } } | undefined
      )?.entity.title;
    renderWithProviders(<Host />, (path, input) => {
      const vars = input as {
        query?: string;
        id?: string;
        title?: string;
        bodyDoc?: typeof serverBody;
      };
      if (path === 'entity.query' && vars.query === SUPPLY_RECORDS_QUERY) {
        supplyReads++;
        return [hostTemplateRecord(template)];
      }
      if (path === 'entity.get') {
        reads++;
        return {
          entity: { ...entity, title: serverTitle, bodyDoc: serverBody },
          relations: [],
          thread: null,
        };
      }
      if (path === 'entity.update') {
        if (vars.bodyDoc !== undefined) {
          bodyWrites++;
          serverBody = vars.bodyDoc;
          return mockEntityUpdateResult({ ...entity, title: serverTitle, bodyDoc: serverBody });
        }
        if (vars.title !== undefined) {
          titleWrites++;
          return held;
        }
        checkboxes++;
        return new Promise(() => {});
      }
      return (
        registryReply(path) ??
        (path === 'entity.resolveRefs' || path === 'entity.suggest' ? [] : {})
      );
    });
    const field = await screen.findByTestId('title-edit');
    fireEvent.change(field, { target: { value: 'План Б' } });
    fireEvent.blur(field);
    await waitFor(() => expect(titleWrites).toBe(1));
    await waitFor(() => expect(cachedTitle()).toBe('План Б'));
    await waitFor(() => expect(observed).toHaveBeenCalledWith('e1', 'План Б'));
    await screen.findByTestId('body-editor', undefined, { timeout: 10000 });
    const editor = (
      screen.getByTestId('body-editor').querySelector('.ProseMirror') as HTMLElement & {
        editor: Editor;
      }
    ).editor;
    const unchanged = editor.getJSON();
    act(() => editor.commands.insertContentAt(1, 'own'));
    act(() => {
      editor.view.dispatch(closeHistory(editor.state.tr));
      editor.commands.deleteRange({ from: 1, to: 4 });
    });
    expect(undoDepth(editor.state)).toBe(2);
    expect(editor.getJSON()).toEqual(unchanged);
    expect(canUndoStep('e1')).toBe(true);
    fireEvent.click(await screen.findByRole('checkbox', { name: /готово/i }));
    await waitFor(() => expect(checkboxes).toBe(1));
    const beforeSupply = supplyReads;
    if (removeTitle) template = '{{body}}';
    await act(async () => {
      await refetch();
    });
    await waitFor(() => expect(supplyReads).toBeGreaterThan(beforeSupply));
    await waitFor(() => expect(screen.queryByTestId('title-edit') === null).toBe(removeTitle));
    if (removeTitle) expect(field).not.toBeInTheDocument();
    await screen.findByTestId('body-editor', undefined, { timeout: 10000 });
    expect(
      (
        screen.getByTestId('body-editor').querySelector('.ProseMirror') as HTMLElement & {
          editor: Editor;
        }
      ).editor,
    ).toBe(editor);
    expect(screen.getAllByRole('button', { name: 'Шаг назад' })).toHaveLength(1);
    expect(undoDepth(editor.state)).toBe(2);
    expect(bodyWrites).toBe(0);
    serverTitle = 'План Б'; // Independent foreign write while original own B is still pending.
    const beforeReads = reads;
    await act(async () => {
      rejected(trpcError('INTERNAL_SERVER_ERROR', 'B did not write'));
      await held.catch(() => {});
    });
    await waitFor(() => expect(reads).toBeGreaterThan(beforeReads));
    await waitFor(() => expect(cachedTitle()).toBe('План Б'));
    expect(screen.getByRole('heading', { name: 'План Б' })).toBeInTheDocument();
    if (canUndoStep('e1')) {
      fireEvent.click(screen.getByRole('button', { name: 'Шаг назад' }));
      expect(editor.getText()).toBe('ownтело');
      expect(redoDepth(editor.state)).toBe(1);
    }
    expect(bodyWrites).toBe(0);
    expect(titleWrites).toBe(1);
    expect(canUndoStep('e1')).toBe(false);
    expect(undoDepth(editor.state)).toBe(0);
    expect(redoDepth(editor.state)).toBe(0);
    expect(screen.getByRole('button', { name: 'Шаг назад' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Шаг назад' }));
    fireEvent.keyDown(editor.view.dom, { key: 'z', code: 'KeyZ', ctrlKey: true });
    expect(editor.getJSON()).toEqual(unchanged);
  });

test('classified failed title basis resets cached offscreen body before its return', async () => {
  const observed = vi.spyOn(titleHistory, 'observeTitleValue');
  observed.mockClear();
  let show: (v: boolean) => void = () => {};
  let titleValue: (v: string) => void = () => {};
  let reject: (error: unknown) => void = () => {};
  const held = new Promise((_done, fail) => {
    reject = fail;
  });
  const changed = vi.fn();
  function Host() {
    const [visible, setVisible] = useState(true);
    const [title, setTitle] = useState('План');
    show = setVisible;
    titleValue = setTitle;
    return visible ? (
      <>
        <NativeRow
          entity={{ ...entity, title }}
          onToggleTask={() => {}}
          onSaveTitle={(v) => {
            titleValue(v);
            return held;
          }}
        />
        <BodyEditor entityId="e1" doc={doc} onChange={changed} />
      </>
    ) : null;
  }
  renderWithProviders(<Host />, fallback);
  const field = await screen.findByTestId('title-edit');
  fireEvent.change(field, { target: { value: 'План Б' } });
  fireEvent.blur(field);
  await waitFor(() => expect(observed).toHaveBeenCalledWith('e1', 'План Б'));
  const editor = (
    screen.getByTestId('body-editor').querySelector('.ProseMirror') as HTMLElement & {
      editor: Editor;
    }
  ).editor;
  const unchanged = editor.getJSON();
  act(() => editor.commands.insertContentAt(1, 'own'));
  act(() => {
    editor.view.dispatch(closeHistory(editor.state.tr));
    editor.commands.deleteRange({ from: 1, to: 4 });
  });
  expect(undoDepth(editor.state)).toBe(2);
  expect(editor.getJSON()).toEqual(unchanged);
  act(() => show(false));
  expect(screen.queryByTestId('title-edit')).toBeNull();
  expect(screen.queryByTestId('body-editor')).toBeNull();
  await act(async () => {
    reject(new Error('отказ без записи'));
    await held.catch(() => {});
  });
  expect(canUndoStep('e1')).toBe(false);
  expect(undoDepth(editor.state)).toBe(0);
  expect(redoDepth(editor.state)).toBe(0);
  expect(editor.getJSON()).toEqual(unchanged);
  expect(changed).toHaveBeenCalledTimes(2);
  act(() => show(true));
  await screen.findByTestId('body-editor');
  expect(
    (
      screen.getByTestId('body-editor').querySelector('.ProseMirror') as HTMLElement & {
        editor: Editor;
      }
    ).editor,
  ).toBe(editor);
  fireEvent.keyDown(editor.view.dom, { key: 'z', code: 'KeyZ', ctrlKey: true });
  expect(editor.getJSON()).toEqual(unchanged);
  expect(changed).toHaveBeenCalledTimes(2);
});

test('duplicate older refusals after invalid-basis reset preserve newly created BODY history', async () => {
  const observed = vi.spyOn(titleHistory, 'observeTitleValue');
  observed.mockClear();
  let titleValue: (v: string) => void = () => {};
  const reject: ((error: unknown) => void)[] = [];
  const held = [0, 1, 2].map(
    () =>
      new Promise((_done, fail) => {
        reject.push(fail);
      }),
  );
  let sends = 0;
  function Host() {
    const [title, setTitle] = useState('План');
    titleValue = setTitle;
    return (
      <>
        <NativeRow
          entity={{ ...entity, title }}
          onToggleTask={() => {}}
          onSaveTitle={(v) => {
            titleValue(v);
            return held[sends++];
          }}
        />
        <BodyEditor entityId="e1" doc={doc} onChange={() => {}} />
      </>
    );
  }
  renderWithProviders(<Host />, fallback);
  const field = await screen.findByTestId('title-edit');
  fireEvent.change(field, { target: { value: 'План Б' } });
  fireEvent.blur(field);
  await waitFor(() => expect(observed).toHaveBeenLastCalledWith('e1', 'План Б'));
  fireEvent.keyDown(field, { key: 'z', code: 'KeyZ', ctrlKey: true });
  await waitFor(() => expect(observed).toHaveBeenLastCalledWith('e1', 'План'));
  fireEvent.keyDown(field, { key: 'z', code: 'KeyZ', ctrlKey: true, shiftKey: true });
  await waitFor(() => expect(observed).toHaveBeenLastCalledWith('e1', 'План Б'));
  expect(sends).toBe(3);
  const editor = (
    screen.getByTestId('body-editor').querySelector('.ProseMirror') as HTMLElement & {
      editor: Editor;
    }
  ).editor;
  act(() => editor.chain().focus().insertContentAt(1, 'own').run());
  await act(async () => {
    reject[2]?.(new Error('последний отказ'));
    await held[2]?.catch(() => {});
  });
  expect(canUndoStep('e1')).toBe(false);
  expect(undoDepth(editor.state)).toBe(0);
  const resetDoc = editor.getJSON();
  act(() => editor.commands.insertContentAt(1, 'new'));
  expect(undoDepth(editor.state)).toBe(1);
  expect(canUndoStep('e1')).toBe(true);
  await act(async () => {
    reject[0]?.(new Error('старый отказ'));
    reject[1]?.(new Error('старый отказ второго намерения'));
    await Promise.all(held.slice(0, 2).map((p) => p.catch(() => {})));
  });
  expect(undoDepth(editor.state)).toBe(1);
  expect(canUndoStep('e1')).toBe(true);
  fireEvent.keyDown(editor.view.dom, { key: 'z', code: 'KeyZ', ctrlKey: true });
  expect(editor.getJSON()).toEqual(resetDoc);
  expect(redoDepth(editor.state)).toBe(1);
  expect(sends).toBe(3);
});

for (const returned of ['План Б', 'План'])
  for (const removeTitle of [false, true])
    if (returned === 'План Б' || removeTitle)
      test(`actual cold BODY return after never-observed B refusal removesTitle=${removeTitle} returned=${returned}`, async () => {
        navAt('e1');
        const observed = vi.spyOn(titleHistory, 'observeTitleValue');
        observed.mockClear();
        let qc: QueryClient | null = null;
        let change: (id: string) => void = () => {};
        let refetch: () => Promise<unknown> = async () => {};
        let template = '{{title}}\n\n{{body}}',
          serverTitle = 'План',
          serverBody = entity.bodyDoc;
        let titleWrites = 0,
          bodyWrites = 0,
          reads = 0,
          supplyReads = 0;
        let rejected: (err: unknown) => void = () => {};
        const held = new Promise((_resolve, reject) => {
          rejected = reject;
        });
        function Host() {
          const [id, set] = useState('e1');
          change = set;
          qc = useQueryClient();
          const utils = trpc.useUtils();
          refetch = () =>
            utils.entity.query.invalidate({ query: SUPPLY_RECORDS_QUERY, fields: 'full' });
          const warm = trpc.entity.get.useQuery(detailGetInput('e2'));
          return (
            <>
              <span data-testid="warm">{warm.data?.entity.title}</span>
              <DetailScreen entityId={id} />
            </>
          );
        }
        const e1Query = () =>
          qc
            ?.getQueryCache()
            .getAll()
            .filter((q) => JSON.stringify(q.queryKey).includes('"e1"')) ?? [];
        const cachedTitle = () =>
          (
            qc
              ?.getQueryCache()
              .getAll()
              .find(
                (q) =>
                  (q.state.data as { entity?: { id: string } } | undefined)?.entity?.id === 'e1',
              )?.state.data as { entity: { title: string } } | undefined
          )?.entity.title;
        renderWithProviders(
          <Host />,
          (path, input) => {
            const vars = input as {
              query?: string;
              id?: string;
              title?: string;
              bodyDoc?: typeof serverBody;
            };
            if (path === 'entity.query' && vars.query === SUPPLY_RECORDS_QUERY) {
              supplyReads++;
              return [hostTemplateRecord(template)];
            }
            if (path === 'entity.get') {
              if (vars.id === 'e1') reads++;
              return {
                entity: {
                  ...entity,
                  id: vars.id ?? 'e1',
                  title: vars.id === 'e2' ? 'Сосед' : serverTitle,
                  bodyDoc: serverBody,
                },
                relations: [],
                thread: null,
              };
            }
            if (path === 'entity.update') {
              if (vars.bodyDoc !== undefined) {
                bodyWrites++;
                serverBody = vars.bodyDoc;
                return mockEntityUpdateResult({
                  ...entity,
                  title: serverTitle,
                  bodyDoc: serverBody,
                });
              }
              if (vars.title !== undefined) {
                titleWrites++;
                return held;
              }
            }
            return (
              registryReply(path) ??
              (path === 'entity.resolveRefs' || path === 'entity.suggest' ? [] : {})
            );
          },
          { queries: { gcTime: 0 } },
        );
        const field = await screen.findByTestId('title-edit');
        await waitFor(() => expect(screen.getByTestId('warm')).toHaveTextContent('Сосед'));
        await screen.findByTestId('body-editor', undefined, { timeout: 10000 });
        const editor = (
          screen.getByTestId('body-editor').querySelector('.ProseMirror') as HTMLElement & {
            editor: Editor;
          }
        ).editor;
        const unchanged = editor.getJSON();
        fireEvent.change(field, { target: { value: 'План Б' } });
        act(() => editor.commands.insertContentAt(1, 'own'));
        act(() => {
          editor.view.dispatch(closeHistory(editor.state.tr));
          editor.commands.deleteRange({ from: 1, to: 4 });
        });
        expect(undoDepth(editor.state)).toBe(2);
        expect(editor.getJSON()).toEqual(unchanged);
        act(() => {
          fireEvent.blur(field);
          change('e2');
        });
        await waitFor(() => expect(screen.getByTestId('title-edit')).toHaveValue('Сосед'));
        await waitFor(() => expect(titleWrites).toBe(1));
        expect(field).not.toBeInTheDocument();
        expect(
          observed.mock.calls.filter(([id, value]) => id === 'e1' && value === 'План Б'),
        ).toHaveLength(0);
        await act(async () => {
          rejected(trpcError('INTERNAL_SERVER_ERROR', 'Never-observed B did not write'));
          await held.catch(() => {});
        });
        await waitFor(() => expect(e1Query()).toHaveLength(0));
        expect(undoDepth(editor.state)).toBe(2);
        expect(canUndoStep('e1')).toBe(true);
        expect(bodyWrites).toBe(0);
        const beforeSupply = supplyReads;
        if (removeTitle) template = '{{body}}';
        await act(async () => {
          await refetch();
        });
        await waitFor(() => expect(supplyReads).toBeGreaterThan(beforeSupply));
        await waitFor(() => expect(screen.queryByTestId('title-edit') === null).toBe(removeTitle));
        serverTitle = returned; // Independent foreign B or the unchanged original Plan after no own write.
        const beforeReads = reads;
        act(() => change('e1'));
        await waitFor(() => expect(reads).toBeGreaterThan(beforeReads));
        await waitFor(() => expect(cachedTitle()).toBe(returned));
        expect(await screen.findByRole('heading', { name: returned })).toBeInTheDocument();
        await screen.findByTestId('body-editor', undefined, { timeout: 10000 });
        expect(
          (
            screen.getByTestId('body-editor').querySelector('.ProseMirror') as HTMLElement & {
              editor: Editor;
            }
          ).editor,
        ).toBe(editor);
        await waitFor(() => expect(screen.queryByTestId('title-edit') === null).toBe(removeTitle));
        expect(screen.getAllByRole('button', { name: 'Шаг назад' })).toHaveLength(1);
        if (canUndoStep('e1')) {
          expect(undoDepth(editor.state)).toBe(2);
          fireEvent.click(screen.getByRole('button', { name: 'Шаг назад' }));
          expect(editor.getText()).toBe('ownтело');
          expect(redoDepth(editor.state)).toBe(1);
        }
        expect(bodyWrites).toBe(0);
        expect(titleWrites).toBe(1);
        if (returned === 'План') {
          expect(canUndoStep('e1')).toBe(true);
          expect(undoDepth(editor.state)).toBe(1);
          expect(redoDepth(editor.state)).toBe(1);
          expect(editor.getText()).toBe('ownтело');
          fireEvent.keyDown(editor.view.dom, { key: 'z', code: 'KeyZ', ctrlKey: true });
          expect(editor.getJSON()).toEqual(unchanged);
          expect(titleWrites).toBe(1);
          expect(bodyWrites).toBe(0);
          return;
        }
        expect(canUndoStep('e1')).toBe(false);
        expect(undoDepth(editor.state)).toBe(0);
        expect(redoDepth(editor.state)).toBe(0);
        expect(screen.getByRole('button', { name: 'Шаг назад' })).toBeDisabled();
        fireEvent.click(screen.getByRole('button', { name: 'Шаг назад' }));
        fireEvent.keyDown(editor.view.dom, { key: 'z', code: 'KeyZ', ctrlKey: true });
        expect(editor.getJSON()).toEqual(unchanged);
      });

for (const outcome of ['foreign', 'pending', 'accepted'] as const)
  for (const order of ['body', 'title-body', 'body-title'] as const)
    if (outcome !== 'foreign' || order === 'body')
      test(`actual cold BODY current basis after observed B refusal and unobserved C outcome=${outcome} order=${order}`, async () => {
        navAt('e1');
        const observed = vi.spyOn(titleHistory, 'observeTitleValue');
        observed.mockClear();
        const acknowledged = vi.spyOn(titleHistory, 'acceptTitleSend');
        acknowledged.mockClear();
        let qc: QueryClient | null = null;
        let change: (id: string) => void = () => {};
        let refetch: () => Promise<unknown> = async () => {};
        let template = '{{title}}\n\n{{body}}',
          serverTitle = 'План';
        let titleWrites = 0,
          bodyWrites = 0,
          reads = 0,
          supplyReads = 0,
          ownCWrite = 0;
        const titleInputs: { id?: string; title?: string; expectedTitle?: string }[] = [];
        const heldC = new Promise(() => {});
        const settledC = vi.fn();
        void heldC.then(settledC, settledC);
        let rejected: (error: unknown) => void = () => {};
        const held = new Promise((_resolve, reject) => {
          rejected = reject;
        });
        function Host() {
          const [id, set] = useState('e1');
          change = set;
          qc = useQueryClient();
          const utils = trpc.useUtils();
          refetch = () =>
            utils.entity.query.invalidate({ query: SUPPLY_RECORDS_QUERY, fields: 'full' });
          const warm = trpc.entity.get.useQuery(detailGetInput('e2'));
          return (
            <>
              <span data-testid="warm">{warm.data?.entity.title}</span>
              <DetailScreen entityId={id} />
            </>
          );
        }
        const e1Queries = () =>
          qc
            ?.getQueryCache()
            .getAll()
            .filter((q) => JSON.stringify(q.queryKey).includes('"e1"')) ?? [];
        const cachedTitle = () =>
          (
            qc
              ?.getQueryCache()
              .getAll()
              .find(
                (q) =>
                  (q.state.data as { entity?: { id: string } } | undefined)?.entity?.id === 'e1',
              )?.state.data as { entity: { title: string } } | undefined
          )?.entity.title;
        renderWithProviders(
          <Host />,
          (path, input) => {
            const vars = input as {
              query?: string;
              id?: string;
              title?: string;
              expectedTitle?: string;
              bodyDoc?: typeof doc;
            };
            if (path === 'entity.query' && vars.query === SUPPLY_RECORDS_QUERY) {
              supplyReads++;
              return [hostTemplateRecord(template)];
            }
            if (path === 'entity.get') {
              if (vars.id === 'e1') reads++;
              return {
                entity: {
                  ...entity,
                  id: vars.id ?? 'e1',
                  title: vars.id === 'e2' ? 'Сосед' : serverTitle,
                },
                relations: [],
                thread: null,
              };
            }
            if (path === 'entity.update') {
              if (vars.bodyDoc !== undefined) {
                bodyWrites++;
                return mockEntityUpdateResult({ ...entity, title: serverTitle });
              }
              if (vars.title !== undefined) {
                titleWrites++;
                titleInputs.push(vars);
                if (titleWrites === 1) return held;
                if (outcome !== 'foreign' && vars.expectedTitle === serverTitle) {
                  serverTitle = vars.title;
                  ownCWrite++;
                  return outcome === 'accepted'
                    ? mockEntityUpdateResult({ ...entity, title: serverTitle })
                    : heldC;
                }
                return heldC;
              }
            }
            return fallback(path);
          },
          { queries: { gcTime: 0 } },
        );
        const field = await screen.findByTestId('title-edit');
        await waitFor(() => expect(screen.getByTestId('warm')).toHaveTextContent('Сосед'));
        fireEvent.change(field, { target: { value: 'План Б' } });
        fireEvent.blur(field);
        await waitFor(() => expect(titleWrites).toBe(1));
        await waitFor(() => expect(cachedTitle()).toBe('План Б'));
        await waitFor(() => expect(observed).toHaveBeenCalledWith('e1', 'План Б'));
        await screen.findByTestId('body-editor', undefined, { timeout: 10000 });
        const editor = (
          screen.getByTestId('body-editor').querySelector('.ProseMirror') as HTMLElement & {
            editor: Editor;
          }
        ).editor;
        const unchanged = editor.getJSON();
        fireEvent.change(field, { target: { value: 'План В' } });
        act(() => editor.commands.insertContentAt(1, 'own'));
        act(() => {
          editor.view.dispatch(closeHistory(editor.state.tr));
          editor.commands.deleteRange({ from: 1, to: 4 });
        });
        expect(undoDepth(editor.state)).toBe(2);
        expect(editor.getJSON()).toEqual(unchanged);
        act(() => {
          fireEvent.blur(field);
          change('e2');
        });
        await waitFor(() => expect(screen.getByTestId('title-edit')).toHaveValue('Сосед'));
        await waitFor(() => expect(titleWrites).toBe(2));
        expect(titleInputs).toMatchObject([
          { id: 'e1', title: 'План Б', expectedTitle: 'План' },
          { id: 'e1', title: 'План В', expectedTitle: 'План' },
        ]);
        expect(ownCWrite).toBe(outcome === 'foreign' ? 0 : 1);
        if (outcome === 'accepted')
          await waitFor(() =>
            expect(acknowledged).toHaveBeenCalledWith(
              'e1',
              expect.objectContaining({ value: 'План В', state: 'accepted' }),
            ),
          );
        else expect(acknowledged).not.toHaveBeenCalled();
        expect(field).not.toBeInTheDocument();
        expect(
          observed.mock.calls.filter(([id, value]) => id === 'e1' && value === 'План В'),
        ).toHaveLength(0);
        await act(async () => {
          rejected(
            trpcError(
              'INTERNAL_SERVER_ERROR',
              'Observed B did not write; newer C is still pending',
            ),
          );
          await held.catch(() => {});
        });
        await waitFor(() => expect(e1Queries()).toHaveLength(0));
        expect(undoDepth(editor.state)).toBe(2);
        expect(canUndoStep('e1')).toBe(true);
        const beforeSupply = supplyReads;
        template =
          order === 'body'
            ? '{{body}}'
            : order === 'title-body'
              ? '{{title}}\n\n{{body}}'
              : '{{body}}\n\n{{title}}';
        await act(async () => {
          await refetch();
        });
        await waitFor(() => expect(supplyReads).toBeGreaterThan(beforeSupply));
        await waitFor(() =>
          expect(screen.queryByTestId('title-edit') === null).toBe(order === 'body'),
        );
        if (outcome === 'foreign') serverTitle = 'План Б'; // Independent B differs from both captured CAS bases Plan.
        const beforeReads = reads;
        act(() => change('e1'));
        await waitFor(() => expect(reads).toBeGreaterThan(beforeReads));
        const returned = outcome === 'foreign' ? 'План Б' : 'План В';
        await waitFor(() => expect(cachedTitle()).toBe(returned));
        expect(await screen.findByRole('heading', { name: returned })).toBeInTheDocument();
        await screen.findByTestId('body-editor', undefined, { timeout: 10000 });
        expect(
          (
            screen.getByTestId('body-editor').querySelector('.ProseMirror') as HTMLElement & {
              editor: Editor;
            }
          ).editor,
        ).toBe(editor);
        expect(screen.queryByTestId('title-edit') === null).toBe(order === 'body');
        if (order !== 'body') {
          expect(screen.getByTestId('title-edit')).toHaveValue(returned);
          const copies = observed.mock.calls.flatMap(([id, value], index) =>
            id === 'e1' && value === returned ? [observed.mock.results[index]?.value] : [],
          );
          expect(copies.length).toBeGreaterThanOrEqual(2);
          expect(copies.every((foreign) => foreign === false)).toBe(true);
        }
        expect(screen.getAllByRole('button', { name: 'Шаг назад' })).toHaveLength(1);
        if (outcome === 'foreign') {
          expect(canUndoStep('e1')).toBe(false);
          expect(undoDepth(editor.state)).toBe(0);
          expect(redoDepth(editor.state)).toBe(0);
          expect(screen.getByRole('button', { name: 'Шаг назад' })).toBeDisabled();
          fireEvent.click(screen.getByRole('button', { name: 'Шаг назад' }));
          fireEvent.keyDown(editor.view.dom, { key: 'z', code: 'KeyZ', ctrlKey: true });
          expect(editor.getJSON()).toEqual(unchanged);
        } else {
          expect(canUndoStep('e1')).toBe(true);
          expect(undoDepth(editor.state)).toBe(2);
          fireEvent.click(screen.getByRole('button', { name: 'Шаг назад' }));
          expect(editor.getText()).toBe('ownтело');
          expect(undoDepth(editor.state)).toBe(1);
          expect(redoDepth(editor.state)).toBe(1);
        }
        expect(titleWrites).toBe(2);
        expect(settledC).not.toHaveBeenCalled();
        expect(bodyWrites).toBe(0);
      });

test('first actual BODY-only visit observes baseline before native acquisition and resets fresh foreign title', async () => {
  let idle: (() => void) | undefined;
  vi.stubGlobal('requestIdleCallback', (callback: () => void) => {
    idle = callback;
    return 1;
  });
  vi.stubGlobal('cancelIdleCallback', () => {});
  navAt('e1');
  const observed = vi.spyOn(titleHistory, 'observeTitleValue');
  observed.mockClear();
  let refetch: () => Promise<unknown> = async () => {};
  let title = 'План',
    reads = 0,
    writes = 0;
  function Host() {
    const utils = trpc.useUtils();
    refetch = () => utils.entity.get.invalidate(detailGetInput('e1'));
    return <DetailScreen entityId="e1" />;
  }
  renderWithProviders(<Host />, (path, input) => {
    if (path === 'entity.query' && (input as { query?: string }).query === SUPPLY_RECORDS_QUERY)
      return [hostTemplateRecord('{{body}}')];
    if (path === 'entity.get') {
      reads++;
      return { entity: { ...entity, title }, relations: [], thread: null };
    }
    if (path === 'entity.update') {
      writes++;
      return mockEntityUpdateResult({ ...entity, title });
    }
    return fallback(path);
  });
  await screen.findByRole('heading', { name: 'План' });
  await waitFor(() => expect(observed).toHaveBeenCalledWith('e1', 'План'));
  expect(screen.queryByTestId('title-edit')).toBeNull();
  expect(screen.queryByTestId('body-editor')).toBeNull();
  await waitFor(() => expect(idle).toBeTypeOf('function'));
  act(() => idle?.());
  await screen.findByTestId('body-editor', undefined, { timeout: 10000 });
  const editor = (
    screen.getByTestId('body-editor').querySelector('.ProseMirror') as HTMLElement & {
      editor: Editor;
    }
  ).editor;
  const unchanged = editor.getJSON();
  act(() => editor.commands.insertContentAt(1, 'own'));
  act(() => {
    editor.view.dispatch(closeHistory(editor.state.tr));
    editor.commands.deleteRange({ from: 1, to: 4 });
  });
  expect(editor.getJSON()).toEqual(unchanged);
  expect(undoDepth(editor.state)).toBe(2);
  expect(canUndoStep('e1')).toBe(true);
  const before = reads;
  title = 'Чужое имя';
  await act(async () => {
    await refetch();
  });
  await waitFor(() => expect(reads).toBeGreaterThan(before));
  await screen.findByRole('heading', { name: title });
  expect(screen.queryByTestId('title-edit')).toBeNull();
  expect(
    (
      screen.getByTestId('body-editor').querySelector('.ProseMirror') as HTMLElement & {
        editor: Editor;
      }
    ).editor,
  ).toBe(editor);
  if (canUndoStep('e1')) {
    fireEvent.click(screen.getByRole('button', { name: 'Шаг назад' }));
    expect(editor.getText()).toBe('ownтело');
  }
  expect(canUndoStep('e1')).toBe(false);
  expect(undoDepth(editor.state)).toBe(0);
  expect(redoDepth(editor.state)).toBe(0);
  expect(screen.getByRole('button', { name: 'Шаг назад' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Шаг назад' }));
  fireEvent.keyDown(editor.view.dom, { key: 'z', code: 'KeyZ', ctrlKey: true });
  expect(editor.getJSON()).toEqual(unchanged);
  expect(writes).toBe(0);
});

for (const missingDoc of [false, true])
  test(`actual BODY-only rapid reader eviction forgets baseline before lazy acquisition docnull=${missingDoc}`, async () => {
    vi.stubGlobal('requestIdleCallback', () => 1);
    vi.stubGlobal('cancelIdleCallback', () => {});
    navAt('e1');
    const observed = vi.spyOn(titleHistory, 'observeTitleValue');
    observed.mockClear();
    let change: (id: string) => void = () => {};
    let first = 'Первое';
    function Host() {
      const [id, set] = useState('e1');
      change = set;
      return <DetailScreen entityId={id} />;
    }
    renderWithProviders(
      <Host />,
      (path, input) => {
        const vars = input as { id?: string; query?: string };
        if (path === 'entity.query' && vars.query === SUPPLY_RECORDS_QUERY)
          return [hostTemplateRecord('{{body}}')];
        if (path === 'entity.get')
          return {
            entity: {
              ...entity,
              id: vars.id ?? 'e1',
              title: vars.id === 'e1' ? first : `Запись ${vars.id}`,
              bodyDoc: missingDoc ? null : doc,
            },
            relations: [],
            thread: null,
          };
        return fallback(path);
      },
      { queries: { gcTime: 0 } },
    );
    await screen.findByRole('heading', { name: first });
    await waitFor(() => expect(observed).toHaveBeenCalledWith('e1', first));
    for (let i = 2; i <= 6; i++) {
      act(() => change(`e${i}`));
      await screen.findByRole('heading', { name: `Запись e${i}` });
      await waitFor(() => expect(observed).toHaveBeenCalledWith(`e${i}`, `Запись e${i}`));
      expect(screen.queryByTestId('title-edit')).toBeNull();
      expect(screen.queryByTestId('body-editor')).toBeNull();
    }
    first = 'Свежая первая';
    act(() => change('e1'));
    await screen.findByRole('heading', { name: first });
    await waitFor(() => expect(observed).toHaveBeenCalledWith('e1', first));
    const call = observed.mock.calls.findIndex(([id, value]) => id === 'e1' && value === first);
    // Вытесненная запись начинает новую основу, а не удерживает невидимый хвост в helper Map.
    expect(observed.mock.results[call]?.value).toBe(false);
    expect(screen.queryByTestId('body-editor')).toBeNull();
  });

for (const scope of ['readOnly', 'noArrows'])
  test(`controlled BODY-only ${scope} does not consume foreign basis before becoming eligible`, async () => {
    let set: (state: { title: string; blocked: boolean }) => void = () => {};
    function Host() {
      const [state, update] = useState({ title: 'План', blocked: false });
      set = update;
      return (
        <ControlledBodyHost
          row={{ ...entity, title: state.title }}
          readOnly={scope === 'readOnly' && state.blocked}
          arrows={scope === 'noArrows' && state.blocked ? undefined : BODY_ONLY_ARROWS}
        >
          <BodyBlock />
        </ControlledBodyHost>
      );
    }
    renderWithProviders(<Host />, fallback);
    await screen.findByTestId('body-editor', undefined, { timeout: 10000 });
    const editor = (
      screen.getByTestId('body-editor').querySelector('.ProseMirror') as HTMLElement & {
        editor: Editor;
      }
    ).editor;
    const unchanged = editor.getJSON();
    act(() => editor.commands.insertContentAt(1, 'own'));
    act(() => {
      editor.view.dispatch(closeHistory(editor.state.tr));
      editor.commands.deleteRange({ from: 1, to: 4 });
    });
    expect(undoDepth(editor.state)).toBe(2);
    act(() => set({ title: 'Чужое имя', blocked: true }));
    expect(undoDepth(editor.state)).toBe(2);
    expect(canUndoStep('e1')).toBe(true);
    expect(editor.getJSON()).toEqual(unchanged);
    act(() => set({ title: 'Чужое имя', blocked: false }));
    await screen.findByTestId('body-editor', undefined, { timeout: 10000 });
    expect(undoDepth(editor.state)).toBe(0);
    expect(redoDepth(editor.state)).toBe(0);
    expect(canUndoStep('e1')).toBe(false);
    fireEvent.keyDown(editor.view.dom, { key: 'z', code: 'KeyZ', ctrlKey: true });
    expect(editor.getJSON()).toEqual(unchanged);
  });

for (const scope of ['epoch', 'generation'])
  test(`controlled stale BODY-only ${scope} cannot seed the new owner's first basis`, async () => {
    let set: (state: { title: string; editor: boolean; fresh: boolean }) => void = () => {};
    function Host() {
      const [state, update] = useState({ title: 'План', editor: false, fresh: false });
      set = update;
      return (
        <ControlledBodyHost
          row={{ ...entity, title: state.title, bodyDoc: null }}
          arrows={BODY_ONLY_ARROWS}
        >
          <BodyBlock key={state.fresh ? 'fresh' : 'old'} />
          {state.editor && <BodyEditor entityId="e1" doc={doc} onChange={() => {}} />}
        </ControlledBodyHost>
      );
    }
    renderWithProviders(<Host />, fallback);
    expect(screen.queryByTestId('body-editor')).toBeNull();
    act(() => (scope === 'epoch' ? resetUndoSession() : clearAllSteps()));
    act(() => set({ title: 'План', editor: true, fresh: false }));
    const editor = (
      (await screen.findByTestId('body-editor')).querySelector('.ProseMirror') as HTMLElement & {
        editor: Editor;
      }
    ).editor;
    const unchanged = editor.getJSON();
    act(() => editor.commands.insertContentAt(1, 'own'));
    act(() => {
      editor.view.dispatch(closeHistory(editor.state.tr));
      editor.commands.deleteRange({ from: 1, to: 4 });
    });
    expect(undoDepth(editor.state)).toBe(2);
    act(() => set({ title: 'Old owner title', editor: true, fresh: false }));
    expect(undoDepth(editor.state)).toBe(2);
    act(() => set({ title: 'План', editor: true, fresh: true }));
    expect(undoDepth(editor.state)).toBe(2);
    expect(canUndoStep('e1')).toBe(true);
    fireEvent.keyDown(editor.view.dom, { key: 'z', code: 'KeyZ', ctrlKey: true });
    expect(editor.getText()).toBe('ownтело');
    expect(redoDepth(editor.state)).toBe(1);
    expect(editor.getJSON()).not.toEqual(unchanged);
  });

test('controlled duplicate BODY pins preserve the remaining field then evict after final cleanup without title retouch', async () => {
  const observed = vi.spyOn(titleHistory, 'observeTitleValue');
  observed.mockClear();
  let set: (state: { count: number; title: string; other: number }) => void = () => {};
  function Host() {
    const [state, update] = useState({ count: 2, title: 'План', other: 2 });
    set = update;
    return (
      <>
        <ControlledBodyHost
          row={{ ...entity, title: state.title, bodyDoc: null }}
          arrows={BODY_ONLY_ARROWS}
        >
          {state.count === 2 && <BodyBlock key="first" />}
          {state.count > 0 && <BodyBlock key="second" />}
        </ControlledBodyHost>
        <ControlledBodyHost
          row={{ ...entity, id: `e${state.other}`, title: `Запись ${state.other}`, bodyDoc: null }}
          arrows={BODY_ONLY_ARROWS}
        >
          <BodyBlock />
        </ControlledBodyHost>
      </>
    );
  }
  renderWithProviders(<Host />, fallback);
  act(() => set({ count: 1, title: 'План', other: 2 }));
  for (let i = 3; i <= 6; i++) act(() => set({ count: 1, title: 'План', other: i }));
  act(() => set({ count: 1, title: 'Живое имя', other: 6 }));
  const live = observed.mock.calls.findIndex(([id, value]) => id === 'e1' && value === 'Живое имя');
  expect(observed.mock.results[live]?.value).toBe(true);
  act(() => set({ count: 0, title: 'Живое имя', other: 6 }));
  act(() => set({ count: 0, title: 'Живое имя', other: 7 }));
  act(() => set({ count: 1, title: 'Новая основа', other: 7 }));
  const fresh = observed.mock.calls.findIndex(
    ([id, value]) => id === 'e1' && value === 'Новая основа',
  );
  expect(observed.mock.results[fresh]?.value).toBe(false);
  expect(screen.queryByTestId('body-editor')).toBeNull();
});
