import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { expect, test } from 'vitest';
import {
  installCrashTrap,
  mockEntityUpdateResult,
  renderWithProviders,
  trpcError,
} from '../../test/harness';
import { registryReply } from '../../test/registry';
import { Toaster } from '../../ui/Toast';
import { resetUndoSession } from '../undo/undo-epoch';
import { peekUndoable } from '../undo/undo-stack';
import { Subtasks } from './Subtasks';

installCrashTrap();

test('cold add leaf: eager heading, usable первый input, IME/pending и atomic create+link', async () => {
  let release!: (v: unknown) => void;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const { calls } = renderWithProviders(<Subtasks parentId="e1" relations={[]} />, (path) =>
    path === 'entity.create' ? pending : (registryReply(path) ?? {}),
  );
  expect(screen.getByText('Подзадачи (0)')).toBeInTheDocument();
  const field = await screen.findByLabelText('Новая подзадача');
  fireEvent.change(field, { target: { value: '  Первая  ' } });
  fireEvent.keyDown(field, { key: 'Enter', isComposing: true });
  expect(calls.filter((c) => c.path === 'entity.create')).toHaveLength(0);
  fireEvent.keyDown(field, { key: 'Enter' });
  await waitFor(() => expect(calls.filter((c) => c.path === 'entity.create')).toHaveLength(1));
  expect(screen.getByRole('button', { name: 'Добавить' })).toBeDisabled();
  fireEvent.keyDown(field, { key: 'Enter' });
  expect(calls.filter((c) => c.path === 'entity.create')).toHaveLength(1);
  const create = calls.find((c) => c.path === 'entity.create')?.input as { input: { id: string } };
  expect(create).toMatchObject({
    input: {
      title: 'Первая',
      tags: [],
      props: { 'orbis/task_status': 'inbox' },
      aspects: ['orbis/task'],
    },
    source: 'quick_capture',
    link: { parentId: 'e1', role: 'subitem' },
  });
  expect(calls.filter((c) => c.path === 'relation.create')).toHaveLength(0);
  await act(async () => {
    release(mockEntityUpdateResult({ id: create.input.id, title: 'Первая' }));
    await pending;
  });
  await waitFor(() => expect(field).toHaveValue(''));
  expect(peekUndoable()?.actionId).toBe(`action-${create.input.id}`);
});

test('lazy add: отказ держит draft/id, новые current parent props дают новый retry id', async () => {
  let change!: () => void;
  function Host() {
    const [parent, set] = useState('e1');
    change = () => set('e2');
    return (
      <>
        <Subtasks parentId={parent} relations={[]} />
        <Toaster />
      </>
    );
  }
  const { calls } = renderWithProviders(<Host />, (path) => {
    if (path === 'entity.create') throw trpcError('NOT_FOUND');
    return registryReply(path) ?? {};
  });
  const field = await screen.findByLabelText('Новая подзадача');
  fireEvent.change(field, { target: { value: '  Повтор  ' } });
  fireEvent.keyDown(field, { key: 'Enter' });
  await screen.findByText('Не удалось сохранить');
  expect(field).toHaveValue('  Повтор  ');
  fireEvent.keyDown(field, { key: 'Enter' });
  await waitFor(() => expect(calls.filter((c) => c.path === 'entity.create')).toHaveLength(2));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Добавить' })).toBeEnabled());
  act(() => change());
  fireEvent.keyDown(field, { key: 'Enter' });
  await waitFor(() => expect(calls.filter((c) => c.path === 'entity.create')).toHaveLength(3));
  const creates = calls
    .filter((c) => c.path === 'entity.create')
    .map((c) => c.input as { input: { id: string }; link: { parentId: string } });
  expect(creates[1]).toEqual(creates[0]);
  expect(creates[2]?.input.id).not.toBe(creates[0]?.input.id);
  expect(creates[2]?.link.parentId).toBe('e2');
  expect(field).toHaveValue('  Повтор  ');
});

for (const changeOwner of [false, true])
  test(`lazy add unmount: ${changeOwner ? 'old epoch не предлагает Undo' : 'owned onSuccess сохраняет Undo после unmount'}`, async () => {
    let release!: (v: unknown) => void;
    const pending = new Promise((resolve) => {
      release = resolve;
    });
    const r = renderWithProviders(<Subtasks parentId="e1" relations={[]} />, (path) =>
      path === 'entity.create' ? pending : (registryReply(path) ?? {}),
    );
    const field = await screen.findByLabelText('Новая подзадача');
    fireEvent.change(field, { target: { value: 'Создать' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    await waitFor(() => expect(r.calls.some((c) => c.path === 'entity.create')).toBe(true));
    r.unmount();
    if (changeOwner) resetUndoSession();
    await act(async () => {
      release(mockEntityUpdateResult({ id: 'new-task', title: 'Создать' }));
      await pending;
    });
    if (changeOwner) expect(peekUndoable()).toBeUndefined();
    else await waitFor(() => expect(peekUndoable()?.actionId).toBe('action-new-task'));
  });

for (const changeParent of [false, true])
  test(`held oldadd SUCCESS не очищает новый draft ${changeParent ? 'нового parent' : 'того же parent'}`, async () => {
    let change!: () => void, release!: (v: unknown) => void;
    const pending = new Promise((resolve) => {
      release = resolve;
    });
    function Host() {
      const [parent, set] = useState('e1');
      change = () => set('e2');
      return <Subtasks parentId={parent} relations={[]} />;
    }
    const r = renderWithProviders(<Host />, (path) =>
      path === 'entity.create' ? pending : (registryReply(path) ?? {}),
    );
    const field = await screen.findByLabelText('Новая подзадача');
    fireEvent.change(field, { target: { value: 'Старый запрос' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    await waitFor(() => expect(r.calls.some((c) => c.path === 'entity.create')).toBe(true));
    if (changeParent) act(() => change());
    fireEvent.change(field, { target: { value: 'Новый черновик' } });
    await act(async () => {
      release(mockEntityUpdateResult({ id: 'old-task', title: 'Старый запрос' }));
      await pending;
    });
    await waitFor(() => expect(screen.queryByLabelText('Сохранение')).toBeNull());
    expect(field).toHaveValue('Новый черновик');
    expect(peekUndoable()?.actionId).toBe('action-old-task');
  });
