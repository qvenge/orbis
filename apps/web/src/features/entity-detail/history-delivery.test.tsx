import { parseBody } from '@orbis/shared/doc';
import { type QueryClient, useQueryClient } from '@tanstack/react-query';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { Editor } from '@tiptap/core';
import { closeHistory, redoDepth, undoDepth } from '@tiptap/pm/history';
import { expect, test } from 'vitest';
import { renderWithProviders, trpcError, wireEntity } from '../../test/harness';
import { navAt } from '../../test/nav';
import { registryReply } from '../../test/registry';
import { Toaster } from '../../ui/Toast';
import { canRedoStep, canUndoStep } from '../entity-editor/arrows-stack';
import { BodyEditor } from '../entity-editor/BodyEditor';
import { sameDoc } from '../entity-editor/strip-ids';
import { useUpdateBatch } from '../page/useUpdateBatch';
import { resetUndoSession } from '../undo/undo-epoch';
import { peekUndoable, pushUndoable } from '../undo/undo-stack';
import { offerUndo } from '../undo/undo-toast';
import { DetailScreen } from './DetailScreen';
import { NativeRow } from './NativeRow';
import { useRevertTextItem } from './RevertTextItem';
import { UndoArrows } from './UndoArrows';
import { VersionsCard } from './VersionsCard';

const doc = parseBody('тело');
const entity = {
  ...wireEntity({ id: 'e1', title: 'План' }),
  bodyDoc: doc,
  bodyRevision: 1,
  body: 'тело',
};
const result = {
  actionId: 'u1',
  undone: { id: 'a1', title: 'Правка' },
  pinnedVersions: [],
  bodyRevisions: [] as Array<{ entityId: string; bodyRevision: number }>,
};
function Pair() {
  return (
    <>
      <NativeRow entity={entity} onToggleTask={() => {}} onSaveTitle={() => {}} />
      <BodyEditor entityId="e1" doc={doc} onChange={() => {}} />
      <UndoArrows entityId="e1" variant="inline" />
      <Toaster />
    </>
  );
}
async function populate(): Promise<Editor> {
  const title = await screen.findByTestId('title-edit');
  const ed = (
    screen.getByTestId('body-editor').querySelector('.ProseMirror') as HTMLElement & {
      editor: Editor;
    }
  ).editor;
  act(() => ed.commands.insertContentAt(1, 'own'));
  fireEvent.change(title, { target: { value: 'План Б' } });
  expect(undoDepth(ed.state)).toBe(1);
  expect(canUndoStep('e1')).toBe(true);
  expect(screen.getByRole('button', { name: 'Шаг назад' })).toBeEnabled();
  return ed;
}
async function resetAssert(ed: Editor) {
  await waitFor(() => expect(canUndoStep('e1')).toBe(false));
  expect(canRedoStep('e1')).toBe(false);
  expect(undoDepth(ed.state)).toBe(0);
  expect(redoDepth(ed.state)).toBe(0);
  expect(screen.getByRole('button', { name: 'Шаг назад' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Шаг вперёд' })).toBeDisabled();
}
const fallback = (path: string) => registryReply(path) ?? {};
test('version.restore same body explicitly resets populated common and native histories', async () => {
  renderWithProviders(
    <>
      <Pair />
      <VersionsCard entity={entity} active />
    </>,
    (path) => {
      if (path === 'version.list')
        return [
          {
            id: 'v1',
            entityId: 'e1',
            label: 'версия',
            hasDoc: true,
            actorKind: 'owner',
            createdAt: '2026-08-17T09:00:00Z',
          },
        ];
      if (path === 'version.restore')
        return { ...entity, actionId: 'restore1', consequences: false };
      return fallback(path);
    },
  );
  const ed = await populate();
  fireEvent.click(await screen.findByRole('button', { name: 'Восстановить' }));
  const dialog = await screen.findByRole('dialog');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Восстановить' }));
  await resetAssert(ed);
  expect(ed.getText()).toBe('ownтело'); // no foreign-doc reconciliation in this harness
});
test('page body batch same document explicitly resets native and common history', async () => {
  function Gesture() {
    const run = useUpdateBatch();
    return (
      <button
        type="button"
        onClick={() =>
          void run([{ tool: 'entity_update', input: { id: 'e1', body: 'тело' } }], 'Страница')
        }
      >
        body batch
      </button>
    );
  }
  const { calls } = renderWithProviders(
    <>
      <Pair />
      <Gesture />
    </>,
    (path) =>
      path === 'entity.updateBatch' ? { actionId: 'b1', consequences: false } : fallback(path),
  );
  const ed = await populate();
  fireEvent.click(screen.getByRole('button', { name: 'body batch' }));
  await resetAssert(ed);
  expect(calls.filter((c) => c.path === 'entity.updateBatch')).toHaveLength(1);
  expect(ed.getText()).toBe('ownтело');
});
test('revert19 successful same-body undo explicitly resets populated native and common histories', async () => {
  function Revert() {
    const item = useRevertTextItem('e1', {
      actionId: 'a1',
      textSession: true,
      mine: true,
      actorKind: 'owner',
      startedAt: '2026-08-17T09:00:00Z',
      endedAt: null,
    });
    return (
      <button type="button" onClick={() => item?.onSelect?.()}>
        revert text
      </button>
    );
  }
  const { calls } = renderWithProviders(
    <>
      <Pair />
      <Revert />
    </>,
    (path) => (path === 'ai.undo' ? result : fallback(path)),
  );
  const ed = await populate();
  fireEvent.click(screen.getByRole('button', { name: 'revert text' }));
  await resetAssert(ed);
  expect(calls.filter((c) => c.path === 'ai.undo')).toHaveLength(1);
  expect(ed.getText()).toBe('ownтело');
});

test('native body undo/redo autosaves returned doc with current CAS and one text session, separate from action18', async () => {
  navAt('e1');
  let saved = entity;
  const { calls } = renderWithProviders(<DetailScreen entityId="e1" />, (path, input) => {
    if (path === 'entity.get') return { entity: saved, relations: [], thread: null };
    if (path === 'entity.update') {
      const vars = input as { bodyDoc?: typeof doc };
      saved = {
        ...saved,
        bodyDoc: vars.bodyDoc ?? saved.bodyDoc,
        bodyRevision: saved.bodyRevision + 1,
      };
      return { ...saved, actionId: 'session1', consequences: false };
    }
    return fallback(path);
  });
  fireEvent.click(await screen.findByTestId('editor-preview'));
  await screen.findByTestId('body-editor', {}, { timeout: 5000 });
  const ed = (
    screen.getByTestId('body-editor').querySelector('.ProseMirror') as HTMLElement & {
      editor: Editor;
    }
  ).editor;
  pushUndoable({ actionId: 'external18', title: 'Внешняя правка' });
  const original = ed.getJSON();
  act(() => ed.commands.insertContentAt(1, 'NEW'));
  const changed = ed.getJSON();
  await waitFor(() => expect(calls.filter((c) => c.path === 'entity.update')).toHaveLength(1), {
    timeout: 5000,
  });
  await waitFor(() => expect(saved.bodyRevision).toBe(entity.bodyRevision + 1));
  fireEvent.keyDown(ed.view.dom, { key: 'z', code: 'KeyZ', ctrlKey: true });
  expect(ed.getJSON()).toEqual(original);
  await waitFor(() => expect(calls.filter((c) => c.path === 'entity.update')).toHaveLength(2), {
    timeout: 5000,
  });
  fireEvent.keyDown(ed.view.dom, { key: 'z', code: 'KeyZ', ctrlKey: true, shiftKey: true });
  expect(ed.getJSON()).toEqual(changed);
  await waitFor(() => expect(calls.filter((c) => c.path === 'entity.update')).toHaveLength(3), {
    timeout: 5000,
  });
  const writes = calls.filter((c) => c.path === 'entity.update').map((c) => c.input);
  expect(writes).toEqual(
    [changed, original, changed].map((bodyDoc, i) => ({
      id: 'e1',
      bodyDoc: { v: doc.v, doc: bodyDoc },
      autosave: true,
      expectedBodyRevision: entity.bodyRevision + i,
    })),
  );
  expect(peekUndoable()?.actionId).toBe('external18');
}, 15000);
for (const landing of ['foreign', 'journal', 'journal-same'] as const)
  test(`${landing} actual refetched body landing resets populated title and native histories`, async () => {
    navAt('e1');
    const oldDoc = {
      ...doc,
      doc: {
        ...doc.doc,
        content: doc.doc.content?.map((n) => ({ ...n, attrs: { ...n.attrs, id: 'old-block' } })),
      },
    };
    const newDoc = {
      ...doc,
      doc: {
        ...doc.doc,
        content: doc.doc.content?.map((n) => ({ ...n, attrs: { ...n.attrs, id: 'new-block' } })),
      },
    };
    // Known a1 wrote raw block IDs at revision 2 (bodyActionId=a1); no later autosave.
    // Its inverse stores prior BODY STRING, so undo rebuilds parseBody at revision 3.
    // executor2850/2889/2943 and undo252 preserve this actual canonical-same premise.
    let saved =
      landing === 'journal-same' ? { ...entity, bodyDoc: newDoc, bodyRevision: 2 } : entity;
    if (landing === 'journal-same') {
      expect(newDoc).not.toEqual(oldDoc);
      expect(sameDoc(newDoc.doc, oldDoc.doc)).toBe(true);
    }
    let qc: QueryClient | undefined;
    function Host() {
      qc = useQueryClient();
      return (
        <>
          <DetailScreen entityId="e1" />
          <Toaster />
        </>
      );
    }
    const { calls } = renderWithProviders(<Host />, (path, input) => {
      if (path === 'entity.get') return { entity: saved, relations: [], thread: null };
      if (path === 'entity.update') {
        const vars = input as { bodyDoc?: typeof doc; title?: string };
        if (vars.bodyDoc)
          saved = { ...saved, bodyDoc: vars.bodyDoc, bodyRevision: saved.bodyRevision + 1 };
        if (vars.title) saved = { ...saved, title: vars.title };
        return { ...saved, actionId: 'session1', consequences: false };
      }
      if (path === 'ai.undo') {
        saved = {
          ...saved,
          bodyDoc: doc,
          bodyRevision: saved.bodyRevision + 1,
        };
        return { ...result, bodyRevisions: [{ entityId: 'e1', bodyRevision: saved.bodyRevision }] };
      }
      return fallback(path);
    });
    fireEvent.click(await screen.findByTestId('editor-preview'));
    await screen.findByTestId('body-editor', {}, { timeout: 5000 });
    const ed = (
      screen.getByTestId('body-editor').querySelector('.ProseMirror') as HTMLElement & {
        editor: Editor;
      }
    ).editor;
    act(() => {
      ed.commands.insertContentAt(1, 'NEW');
      if (landing === 'journal-same') {
        ed.view.dispatch(closeHistory(ed.state.tr));
        ed.commands.deleteRange({ from: 1, to: 4 });
      }
    });
    if (landing !== 'journal-same')
      await waitFor(() => expect(saved.bodyRevision).toBe(entity.bodyRevision + 1), {
        timeout: 5000,
      });
    act(() => screen.getByTestId('title-edit').focus());
    fireEvent.change(screen.getByTestId('title-edit'), { target: { value: 'План Б' } });
    expect(canUndoStep('e1')).toBe(true);
    expect(undoDepth(ed.state)).toBe(landing === 'journal-same' ? 2 : 1);
    if (landing === 'foreign') {
      saved = { ...saved, bodyDoc: parseBody('чужое тело'), bodyRevision: saved.bodyRevision + 1 };
      await act(async () => {
        await qc!.invalidateQueries({
          predicate: (q) =>
            JSON.stringify(q.queryKey).includes('entity') &&
            JSON.stringify(q.queryKey).includes('get'),
        });
      });
    } else {
      act(() => offerUndo({ title: 'Правка', actionId: 'a1', entityIds: ['e1'] }));
      fireEvent.click(await screen.findByRole('button', { name: 'Отменить' }));
    }
    await waitFor(() => expect(ed.getText()).toBe(landing === 'foreign' ? 'чужое тело' : 'тело'));
    if (landing === 'journal-same') {
      expect(calls.filter((c) => c.path === 'entity.update')).toHaveLength(0);
      expect(calls.filter((c) => c.path === 'ai.undo')).toHaveLength(1);
    }
    await resetAssert(ed);
  }, 15000);

function RevertAction() {
  const item = useRevertTextItem('e1', {
    actionId: 'a1',
    textSession: true,
    mine: true,
    actorKind: 'owner',
    startedAt: '2026-08-17T09:00:00Z',
    endedAt: null,
  });
  return (
    <button type="button" onClick={() => item?.onSelect?.()}>
      revert action
    </button>
  );
}
test('declined revert does not reset current populated histories', async () => {
  const { calls } = renderWithProviders(
    <>
      <Pair />
      <RevertAction />
    </>,
    (path) => {
      if (path === 'ai.undo')
        throw trpcError('CONFLICT', 'отказ', {
          code: 'UNDO_TEXT_CHANGED',
          details: {
            action: { id: 'a1', title: 'Правка' },
            entries: [],
            continuation: { kind: 'none' },
          },
        });
      return fallback(path);
    },
  );
  const ed = await populate();
  fireEvent.click(screen.getByRole('button', { name: 'revert action' }));
  await screen.findByText(/Текст изменён после этой правки/);
  expect(calls.filter((c) => c.path === 'ai.undo')).toHaveLength(1);
  expect(canUndoStep('e1')).toBe(true);
  expect(undoDepth(ed.state)).toBe(1);
});
test('old owner held revert success cannot reset new owner same-id history', async () => {
  let release: (v: typeof result) => void = () => {};
  const held = new Promise<typeof result>((resolve) => {
    release = resolve;
  });
  const { calls } = renderWithProviders(
    <>
      <Pair />
      <RevertAction />
    </>,
    (path) => (path === 'ai.undo' ? held : fallback(path)),
  );
  await populate();
  fireEvent.click(screen.getByRole('button', { name: 'revert action' }));
  await waitFor(() => expect(calls.filter((c) => c.path === 'ai.undo')).toHaveLength(1));
  act(() => resetUndoSession());
  const ed = await populate();
  await act(async () => {
    release({ ...result, bodyRevisions: [{ entityId: 'e1', bodyRevision: 2 }] } as typeof result);
    await held;
  });
  expect(canUndoStep('e1')).toBe(true);
  expect(undoDepth(ed.state)).toBe(1);
});

test('bodyless journal undo preserves populated text histories', async () => {
  renderWithProviders(<Pair />, (path) => (path === 'ai.undo' ? result : fallback(path)));
  const ed = await populate();
  act(() => offerUndo({ title: 'Только поле', actionId: 'a1', entityIds: ['e1'] }));
  fireEvent.click(await screen.findByRole('button', { name: 'Отменить' }));
  await screen.findByText('Отменено: Правка');
  expect(canUndoStep('e1')).toBe(true);
  expect(undoDepth(ed.state)).toBe(1);
});
test('known e1 journal reset preserves unaffected actual e2 editor history', async () => {
  renderWithProviders(
    <>
      <Pair />
      <NativeRow entity={{ ...entity, id: 'e2' }} onToggleTask={() => {}} onSaveTitle={() => {}} />
      <BodyEditor entityId="e2" doc={doc} onChange={() => {}} />
    </>,
    (path) =>
      path === 'ai.undo'
        ? { ...result, bodyRevisions: [{ entityId: 'e1', bodyRevision: 2 }] }
        : fallback(path),
  );
  const fields = await screen.findAllByTestId('title-edit');
  const editors = screen
    .getAllByTestId('body-editor')
    .map((node) => (node.querySelector('.ProseMirror') as HTMLElement & { editor: Editor }).editor);
  act(() => {
    for (const ed of editors) ed.commands.insertContentAt(1, 'own');
  });
  for (const field of fields) fireEvent.change(field, { target: { value: 'План Б' } });
  act(() => offerUndo({ title: 'Текст', actionId: 'a1', entityIds: ['e1', 'e2'] }));
  fireEvent.click(await screen.findByRole('button', { name: 'Отменить' }));
  await screen.findByText('Отменено: Правка');
  expect(canUndoStep('e1')).toBe(false);
  expect(undoDepth(editors[0]!.state)).toBe(0);
  expect(canUndoStep('e2')).toBe(true);
  expect(undoDepth(editors[1]!.state)).toBe(1);
});

for (const already of [false, true])
  test(`journal ${already ? 'already' : 'failed'} reply preserves populated history`, async () => {
    renderWithProviders(<Pair />, (path) => {
      if (path === 'ai.undo')
        throw already
          ? trpcError('BAD_REQUEST', 'уже отменено', {
              code: 'VALIDATION',
              details: { reason: 'already_undone' },
            })
          : new Error('отказ отмены');
      return fallback(path);
    });
    const ed = await populate();
    act(() => offerUndo({ title: 'Правка', actionId: 'a1', entityIds: ['e1'] }));
    fireEvent.click(await screen.findByRole('button', { name: 'Отменить' }));
    await screen.findByText(already ? 'Уже отменено' : 'Не удалось отменить изменения');
    expect(canUndoStep('e1')).toBe(true);
    expect(undoDepth(ed.state)).toBe(1);
  });
