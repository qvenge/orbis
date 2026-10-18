import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import { renderWithProviders, trpcError, wireEntity } from '../../test/harness';
import { registryReply } from '../../test/registry';
import type { RouterInputs } from '../../trpc';
import { Toaster } from '../../ui/Toast';
import { useToastStore } from '../../ui/toast-store';

type CreateCall = RouterInputs['entity']['create'];
type BatchCall = RouterInputs['entity']['updateBatch'];

import { DayPlanner } from './DayPlanner';
import { Inbox } from './Inbox';
import { PlanningCapture } from './PlanningCapture';

beforeEach(() => {
  localStorage.clear();
  useToastStore.setState({ toasts: [] });
});
const onOpen = vi.fn();
const task = wireEntity({
  id: '11840000-0000-4000-8000-000000000001',
  title: 'Отправить резюме',
  aspects: ['orbis/task'],
  props: { 'orbis/task_status': 'planned', 'orbis/planned_date': '2026-10-19' },
});

test('failed creation retains the draft and reuses identity on retry', async () => {
  const inputs: CreateCall[] = [];
  renderWithProviders(<PlanningCapture day="2026-10-19" />, (path, input) => {
    if (path === 'entity.create') {
      inputs.push(input as CreateCall);
      if (inputs.length === 1) throw trpcError('INTERNAL_SERVER_ERROR');
      return {};
    }
    return registryReply(path) ?? [];
  });
  const field = screen.getByRole('textbox', { name: 'Новая задача' });
  fireEvent.change(field, { target: { value: 'Позвонить' } });
  fireEvent.click(screen.getByRole('button', { name: 'Добавить задачу' }));
  await screen.findByRole('alert');
  expect(field).toHaveValue('Позвонить');
  fireEvent.click(screen.getByRole('button', { name: 'Добавить задачу' }));
  await waitFor(() => expect(field).toHaveValue(''));
  expect(inputs).toHaveLength(2);
  expect(inputs[1].input.id).toBe(inputs[0].input.id);
  expect(inputs[0].input.props?.['orbis/planned_date']).toBe('2026-10-19');
  expect(inputs[0].input.props?.['orbis/due_date']).toBeUndefined();
});

test('capture in flight cannot duplicate, erase a newer draft or change its original date', async () => {
  let finish!: (v: unknown) => void;
  const created: CreateCall[] = [];
  const view = renderWithProviders(<PlanningCapture day="2026-10-19" />, (path, input) => {
    if (path === 'entity.create') {
      created.push(input as CreateCall);
      return new Promise((resolve) => {
        finish = resolve;
      });
    }
    return registryReply(path) ?? [];
  });
  const field = screen.getByRole('textbox', { name: 'Новая задача' });
  fireEvent.change(field, { target: { value: 'Первая' } });
  const form = field.closest('form');
  if (!form) throw new Error('Missing capture form');
  fireEvent.submit(form);
  fireEvent.submit(form);
  await waitFor(() => expect(created).toHaveLength(1));
  fireEvent.change(field, { target: { value: 'Вторая' } });
  finish({});
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Добавить задачу' })).not.toBeDisabled(),
  );
  expect(field).toHaveValue('Вторая');
  expect(created[0].input.props?.['orbis/planned_date']).toBe('2026-10-19');
  view.unmount();
});

test('raw multiline capture preserves text and creates no task classification', async () => {
  const created: CreateCall[] = [];
  renderWithProviders(<PlanningCapture />, (path, input) => {
    if (path === 'entity.create') {
      created.push(input as CreateCall);
      return {};
    }
    return registryReply(path) ?? [];
  });
  fireEvent.change(screen.getByRole('textbox', { name: 'Новая запись во входящих' }), {
    target: { value: 'Идея\nhttps://example.com\nПодумать позже' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить во входящие' }));
  await waitFor(() => expect(created).toHaveLength(1));
  expect(created[0].input).toMatchObject({
    title: 'Идея',
    body: 'Идея\nhttps://example.com\nПодумать позже',
    props: { 'orbis/inbox_state': 'pending' },
  });
  expect(created[0].input.aspects).toBeUndefined();
});

test('day selection queries the selected day; completion patches the existing task only', async () => {
  const writes: BatchCall[] = [];
  const reads: unknown[] = [];
  renderWithProviders(<DayPlanner onOpen={onOpen} />, (path, input) => {
    if (path === 'user.getSettings') return { timezone: 'Asia/Almaty' };
    if (path === 'entity.query') {
      reads.push(input);
      return [task];
    }
    if (path === 'entity.updateBatch') {
      writes.push(input as BatchCall);
      return {};
    }
    return registryReply(path) ?? [];
  });
  fireEvent.change(await screen.findByLabelText('Выбрать дату'), {
    target: { value: '2026-10-19' },
  });
  await waitFor(() => expect(JSON.stringify(reads.at(-1))).toContain('2026-10-19'));
  fireEvent.click(await screen.findByRole('checkbox', { name: 'Выполнить: Отправить резюме' }));
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0].operations).toEqual([
    { tool: 'entity_update', input: { id: task.id, props: { 'orbis/task_status': 'done' } } },
  ]);
});

test('inbox triage preserves body, relationships and identity', async () => {
  const raw = wireEntity({
    id: task.id,
    title: 'Ссылка и мысль',
    body: 'Мой полный текст',
    tags: ['personal'],
  });
  const writes: BatchCall[] = [];
  renderWithProviders(<Inbox onOpen={onOpen} />, (path, input) => {
    if (path === 'entity.query') return [raw];
    if (path === 'entity.updateBatch') {
      writes.push(input as BatchCall);
      return {};
    }
    return registryReply(path) ?? [];
  });
  const row = await screen.findByRole('article', { name: raw.title });
  fireEvent.click(within(row).getByRole('button', { name: 'В знания' }));
  await waitFor(() => expect(writes).toHaveLength(1));
  const operation = writes[0].operations[0];
  if (operation.tool !== 'entity_update') throw new Error('Expected update');
  const patch = operation.input;
  expect(patch).toMatchObject({
    id: raw.id,
    aspects: { attach: ['orbis/note'] },
    tags: ['personal', 'gtd-reference'],
    props: { 'orbis/inbox_state': 'processed' },
  });
  expect(patch.body).toBeUndefined();
  expect(patch).not.toHaveProperty('relations');
});

test('reordering skips completed tasks and saves one undoable batch', async () => {
  const finished = wireEntity({
    ...task,
    id: '11840000-0000-4000-8000-000000000002',
    title: 'Готово',
    props: { ...task.props, 'orbis/task_status': 'done', 'orbis/plan_order': 1 },
  });
  const second = wireEntity({
    ...task,
    id: '11840000-0000-4000-8000-000000000003',
    title: 'Вторая задача',
    props: { ...task.props, 'orbis/plan_order': 2 },
  });
  const first = wireEntity({ ...task, props: { ...task.props, 'orbis/plan_order': 0 } });
  const actionId = '11840000-0000-4000-8000-000000000004';
  const writes: BatchCall[] = [];
  const undos: unknown[] = [];
  renderWithProviders(
    <>
      <DayPlanner onOpen={onOpen} />
      <Toaster />
    </>,
    (path, input) => {
      if (path === 'user.getSettings') return { timezone: 'Asia/Almaty' };
      if (path === 'entity.query') return [first, finished, second];
      if (path === 'entity.updateBatch') {
        writes.push(input as BatchCall);
        return { actionId, consequences: false, results: [] };
      }
      if (path === 'ai.undo') {
        undos.push(input);
        return {
          actionId,
          undone: { id: actionId, title: 'Порядок' },
          pinnedVersions: [],
          bodyRevisions: [],
        };
      }
      return registryReply(path) ?? [];
    },
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Действия: Вторая задача' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Выше' }));
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(
    writes[0].operations.map((op) => (op.tool === 'entity_update' ? op.input.id : null)),
  ).toEqual([second.id, first.id]);
  fireEvent.click(await screen.findByRole('button', { name: 'Отменить' }));
  await waitFor(() => expect(undos).toEqual([{ actionId }]));
});
