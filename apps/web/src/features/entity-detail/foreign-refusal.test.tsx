import { parseBody } from '@orbis/shared/doc';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { Editor } from '@tiptap/core';
import { redoDepth, undoDepth } from '@tiptap/pm/history';
import { useState } from 'react';
import { beforeEach, expect, test } from 'vitest';
import { DetailScreen } from '../../features/entity-detail/DetailScreen';
import { canRedoStep, canUndoStep } from '../../features/entity-editor/arrows-stack';
import { readDraft } from '../../features/entity-editor/draft-storage';
import {
  installCrashTrap,
  renderWithProviders,
  staleBodyError,
  wireEntity,
} from '../../test/harness';
import { navAt } from '../../test/nav';
import { registryReply } from '../../test/registry';
import { BodyEditor } from '../entity-editor/BodyEditor';
import { resetUndoSession } from '../undo/undo-epoch';
import { useEntityUpdate } from './useEntityDetail';

installCrashTrap();
beforeEach(() => localStorage.clear());
async function refusedScenario() {
  navAt('019a0000-0000-7000-8000-000000000050');
  const base = {
    ...wireEntity({
      id: '019a0000-0000-7000-8000-000000000050',
      title: 'unchanged body-only control',
    }),
    body: 'original body',
    bodyDoc: parseBody('original body'),
    bodyRevision: 1,
  };
  const server = { ...base };
  let gets = 0;
  const sends: Array<{ expectedBodyRevision?: number; bodyDoc?: unknown }> = [];
  const rendered = renderWithProviders(
    <DetailScreen entityId="019a0000-0000-7000-8000-000000000050" />,
    (path, input) => {
      if (path === 'entity.get') {
        gets++;
        return { entity: { ...server }, relations: [], thread: null };
      }
      if (path === 'entity.update') {
        const sent = input as { expectedBodyRevision?: number; bodyDoc?: unknown };
        sends.push(sent);
        if (sent.bodyDoc === undefined) throw new Error('unexpected non-body mutation');
        if (sent.expectedBodyRevision !== server.bodyRevision)
          throw staleBodyError({
            expected: sent.expectedBodyRevision,
            current: server.bodyRevision,
          });
        throw new Error('fixture expected the foreign revision to precede save');
      }
      return registryReply(path) ?? {};
    },
  );
  fireEvent.click(await screen.findByTestId('editor-preview'));
  const host = await screen.findByTestId('body-editor');
  const editor = (host.querySelector('.ProseMirror') as HTMLElement & { editor: Editor }).editor;
  act(() => {
    editor.view.dom.focus();
    editor.commands.insertContent(' local input');
  });
  await waitFor(() => expect(editor.isFocused).toBe(true));
  expect(undoDepth(editor.state)).toBe(1);
  expect(canUndoStep('019a0000-0000-7000-8000-000000000050')).toBe(true);
  server.body = 'foreign body';
  server.bodyDoc = parseBody(server.body);
  server.bodyRevision = 2;
  const alert = await screen.findByText(
    'Изменено в другом месте — обновите.',
    {},
    { timeout: 6000 },
  );
  await waitFor(() => expect(gets).toBeGreaterThan(1));
  expect(sends).toHaveLength(1);
  expect(sends[0]?.expectedBodyRevision).toBe(1);
  expect(server.title).toBe(base.title);
  expect(editor.isFocused).toBe(true);
  expect(editor.getText()).toContain('local input');
  expect(JSON.stringify(readDraft('019a0000-0000-7000-8000-000000000050')?.doc)).toContain(
    'local input',
  );
  return { editor, rendered, alert, server };
}
test('current body-only foreign refusal resets common and native history while retaining own draft', async () => {
  const { editor } = await refusedScenario();
  expect(canUndoStep('019a0000-0000-7000-8000-000000000050')).toBe(false);
  expect(undoDepth(editor.state)).toBe(0);
  act(() => {
    const event = new InputEvent('beforeinput', {
      inputType: 'historyUndo',
      bubbles: true,
      cancelable: true,
    });
    editor.view.dom.dispatchEvent(event);
  });
  expect(editor.getText()).toContain('local input');
});
test('contrast: explicit refresh accepts foreign body and resets both histories while keeping own draft', async () => {
  const { editor, alert } = await refusedScenario();
  fireEvent.click(
    within(alert.closest('[role="alert"]') as HTMLElement).getByRole('button', {
      name: 'Обновить',
    }),
  );
  await waitFor(() => expect(editor.getText()).toBe('foreign body'));
  expect(canUndoStep('019a0000-0000-7000-8000-000000000050')).toBe(false);
  expect(canRedoStep('019a0000-0000-7000-8000-000000000050')).toBe(false);
  expect(undoDepth(editor.state)).toBe(0);
  expect(redoDepth(editor.state)).toBe(0);
  expect(JSON.stringify(readDraft('019a0000-0000-7000-8000-000000000050')?.doc)).toContain(
    'local input',
  );
});

test.each([
  'owner',
  'record',
  'successor',
] as const)('old refusal after %s cannot reset populated current native history', async (mode) => {
  const first = '019a0000-0000-7000-8000-000000000051',
    second = '019a0000-0000-7000-8000-000000000052';
  let change!: () => void;
  let mutation!: ReturnType<typeof useEntityUpdate>['mutation'];
  const rejects: Array<(e: unknown) => void> = [],
    resolves: Array<(v: unknown) => void> = [];
  function Host() {
    const [id, setId] = useState(first);
    change = () => setId(second);
    mutation = useEntityUpdate(id).mutation;
    return <BodyEditor entityId={id} doc={parseBody('shown own body')} onChange={() => {}} />;
  }
  renderWithProviders(<Host />, (path) =>
    path === 'entity.update'
      ? new Promise((resolve, reject) => {
          resolves.push(resolve);
          rejects.push(reject);
        })
      : (registryReply(path) ?? {}),
  );
  await screen.findByTestId('body-editor');
  act(() => mutation.mutate({ id: first, body: 'old sent body', expectedBodyRevision: 1 }));
  await waitFor(() => expect(rejects).toHaveLength(1));
  if (mode === 'owner') act(() => resetUndoSession());
  if (mode === 'record') act(() => change());
  if (mode === 'successor') {
    act(() => mutation.mutate({ id: first, body: 'newer sent body', expectedBodyRevision: 2 }));
    await waitFor(() => expect(rejects).toHaveLength(2));
  }
  await act(async () => {});
  const id = mode === 'record' ? second : first;
  const editor = (
    screen.getByTestId('body-editor').querySelector('.ProseMirror') as HTMLElement & {
      editor: Editor;
    }
  ).editor;
  act(() => {
    editor.view.dom.focus();
    editor.commands.insertContent(' newer typing');
  });
  await waitFor(() => expect(editor.isFocused).toBe(true));
  expect(undoDepth(editor.state)).toBeGreaterThan(0);
  expect(canUndoStep(id)).toBe(true);
  await act(async () => rejects[0]?.(staleBodyError({ expected: 1, current: 3 })));
  expect(undoDepth(editor.state)).toBeGreaterThan(0);
  expect(canUndoStep(id)).toBe(true);
  expect(editor.getText()).toContain('newer typing');
  if (mode === 'successor')
    await act(async () =>
      resolves[1]?.({
        ...wireEntity({ id: first, title: 'unchanged' }),
        bodyDoc: parseBody('newer sent body'),
        bodyRevision: 2,
      }),
    );
});
