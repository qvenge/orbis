import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { useEffect, useState } from 'react';
import { expect, test } from 'vitest';
import { mockEntityUpdateResult, renderWithProviders, staleBodyError } from '../../test/harness';
import { registerBodyFlush } from '../entity-editor/body-flush';
import { useBodySave } from '../entity-editor/useBodySave';
import { resetUndoSession } from '../undo/undo-epoch';
import { PinVersionDialog } from './VersionsCard';

const id = '019a0000-0000-7000-8000-000000000020';
const doc = (text: string) => ({
  v: 3 as const,
  doc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] },
});
function setup(mode: 'ok' | 'hold' | 'blocked' | 'offline' = 'ok') {
  const entity = mockEntityUpdateResult({ id, bodyDoc: doc('OLD'), bodyRevision: 3 });
  let api!: ReturnType<typeof useBodySave>;
  const releases: ((value: unknown) => void)[] = [];
  function Body() {
    const body = useBodySave(id, entity);
    api = body;
    useEffect(
      () => registerBodyFlush(id, body.flushSettled, body.revisionForRewrite, body.beginRewrite),
      [body.flushSettled, body.revisionForRewrite, body.beginRewrite],
    );
    return null;
  }
  let changeEntity!: () => void;
  function Host() {
    const [shown, setShown] = useState(id);
    changeEntity = () => setShown('019a0000-0000-7000-8000-000000000023');
    return (
      <>
        <Body />
        <PinVersionDialog entityId={shown} onClose={() => {}} />
      </>
    );
  }
  const rendered = renderWithProviders(<Host />, (path, input) => {
    if (path === 'entity.update') {
      if (mode === 'hold') return new Promise((resolve) => releases.push(resolve));
      if (mode === 'blocked') throw staleBodyError({ id });
      if (mode === 'offline') throw new Error('transport unavailable');
      return {
        ...entity,
        bodyDoc: (input as { bodyDoc: typeof entity.bodyDoc }).bodyDoc,
        bodyRevision: 4,
      };
    }
    if (path === 'version.pin')
      return {
        id: '019a0000-0000-7000-8000-000000000021',
        entityId: id,
        actionId: '019a0000-0000-7000-8000-000000000022',
        consequences: false,
      };
    return {};
  });
  return { ...rendered, api: () => api, entity, releases, changeEntity: () => changeEntity() };
}
function pin() {
  fireEvent.change(screen.getByLabelText('Подпись'), { target: { value: 'Fresh snapshot' } });
  fireEvent.click(screen.getByRole('button', { name: 'Закрепить' }));
}
test('pin settles unsent body through actual autosave before creating snapshot', async () => {
  const s = setup();
  act(() => s.api().onDocChange(doc('LAST WORDS')));
  pin();
  await waitFor(() => expect(s.calls.filter((c) => c.path === 'version.pin')).toHaveLength(1));
  expect(
    s.calls.filter((c) => ['entity.update', 'version.pin'].includes(c.path)).map((c) => c.path),
  ).toEqual(['entity.update', 'version.pin']);
  expect(s.api().hasUnsent()).toBe(false);
});
test('clean pin sends without an extra body write', async () => {
  const s = setup();
  pin();
  await waitFor(() => expect(s.calls.filter((c) => c.path === 'version.pin')).toHaveLength(1));
  expect(s.calls.filter((c) => c.path === 'entity.update')).toHaveLength(0);
});
test('pin waits for both in-flight save and newer words', async () => {
  const s = setup('hold');
  act(() => {
    s.api().onDocChange(doc('FIRST'));
    s.api().flush();
  });
  await waitFor(() => expect(s.releases).toHaveLength(1));
  act(() => s.api().onDocChange(doc('LAST WORDS')));
  pin();
  expect(s.calls.filter((c) => c.path === 'version.pin')).toHaveLength(0);
  expect(screen.getByRole('button', { name: 'Закрепить' })).toBeDisabled();
  await act(async () => s.releases[0]?.({ ...s.entity, bodyDoc: doc('FIRST'), bodyRevision: 4 }));
  await waitFor(() => expect(s.releases).toHaveLength(2));
  expect(s.calls.filter((c) => c.path === 'version.pin')).toHaveLength(0);
  await act(async () =>
    s.releases[1]?.({ ...s.entity, bodyDoc: doc('LAST WORDS'), bodyRevision: 5 }),
  );
  await waitFor(() => expect(s.calls.filter((c) => c.path === 'version.pin')).toHaveLength(1));
});
test.each([
  'blocked',
  'offline',
] as const)('pin refuses %s body with an accurate explanation', async (mode) => {
  const s = setup(mode);
  act(() => s.api().onDocChange(doc('LAST WORDS')));
  pin();
  await screen.findByRole('alert');
  expect(screen.getByRole('alert')).toHaveTextContent(
    mode === 'blocked' ? 'Текст записи не сохранён' : 'Нет связи',
  );
  expect(s.calls.filter((c) => c.path === 'version.pin')).toHaveLength(0);
  expect(s.api().hasUnsent()).toBe(true);
});
test.each([
  'owner',
  'entity',
  'unmount',
] as const)('old pin wait after %s change cannot send', async (change) => {
  const s = setup('hold');
  act(() => s.api().onDocChange(doc('LAST WORDS')));
  pin();
  await waitFor(() => expect(s.releases).toHaveLength(1));
  if (change === 'owner') act(() => resetUndoSession());
  if (change === 'entity') act(() => s.changeEntity());
  if (change === 'unmount') s.unmount();
  await act(async () =>
    s.releases[0]?.({ ...s.entity, bodyDoc: doc('LAST WORDS'), bodyRevision: 4 }),
  );
  expect(s.calls.filter((c) => c.path === 'version.pin')).toHaveLength(0);
});

test('changing record during old pin wait permits a new current pin without clearing its wait', async () => {
  const s = setup('hold');
  act(() => s.api().onDocChange(doc('LAST WORDS')));
  pin();
  await waitFor(() => expect(s.releases).toHaveLength(1));
  act(() => s.changeEntity());
  expect(screen.getByRole('button', { name: 'Закрепить' })).toBeEnabled();
  pin();
  await waitFor(() => expect(s.calls.filter((c) => c.path === 'version.pin')).toHaveLength(1));
  expect(s.calls.find((c) => c.path === 'version.pin')?.input).toMatchObject({
    entityId: '019a0000-0000-7000-8000-000000000023',
  });
  await act(async () =>
    s.releases[0]?.({ ...s.entity, bodyDoc: doc('LAST WORDS'), bodyRevision: 4 }),
  );
  expect(s.calls.filter((c) => c.path === 'version.pin')).toHaveLength(1);
});
