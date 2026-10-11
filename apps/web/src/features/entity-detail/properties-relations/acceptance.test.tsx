import type { AspectDefinition } from '@orbis/shared';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { resetRegistryVersionForTests } from '../../../lib/registry/useRegistry';
import { installCrashTrap, renderWithProviders, wireEntity } from '../../../test/harness';
import { BUILTIN_REGISTRY } from '../../../test/registry';
import { Toaster } from '../../../ui/Toast';
import { useToastStore } from '../../../ui/toast-store';
import { DetailScreen } from '../DetailScreen';
import { entity, field } from './test-fixtures';
import type { Relation, ValuesPatch } from './types';

installCrashTrap();
beforeEach(resetRegistryVersionForTests);
afterEach(() => {
  act(() => {
    for (const toast of useToastStore.getState().toasts) useToastStore.getState().dismiss(toast.id);
  });
});

const shared = { ...field({ kind: 'text' }, 'user/shared'), label: { ru: 'Общее поле' } };
const extra = { ...field({ kind: 'text' }, 'user/extra'), label: { ru: 'Второе поле' } };
const free = { ...field({ kind: 'text' }, 'user/free'), label: { ru: 'Свободное поле' } };
const base = BUILTIN_REGISTRY.aspects.find((a) => a.id === 'orbis/task');
if (!base) throw new Error('canonical task definition missing');
const carrier: AspectDefinition = {
  ...base,
  id: 'user/carrier',
  key: 'user/carrier',
  label: { ru: 'Первый носитель' },
  properties: [{ propertyId: shared.id, required: false, rank: 0 }],
  rules: [],
};
const custom: AspectDefinition = {
  ...carrier,
  id: 'user/custom',
  key: 'user/custom',
  label: { ru: 'Пользовательский аспект' },
  properties: [
    { propertyId: shared.id, required: true, rank: 0 },
    { propertyId: extra.id, required: false, rank: 1 },
  ],
};
const catalog = {
  ...BUILTIN_REGISTRY,
  properties: [...BUILTIN_REGISTRY.properties, shared, extra, free],
  aspects: [...BUILTIN_REGISTRY.aspects, carrier, custom],
};
const otherId = '00000000-0000-4000-8000-000000000099';
type Patch = ValuesPatch & { id: string; aspects?: { attach?: string[]; detach?: string[] } };
type Batch = { operations: { tool: string; input: Patch }[] };

// Five commands and toast Undo use the full canonical catalog in one public UI chain.
// Its integration deadline is separate from unchanged product/performance budgets.
it('public menu executes all five panel commands against mutable patch-only transport, with original-triple toast Undo', async () => {
  let current = wireEntity({
    ...entity,
    aspects: [carrier.id],
    props: { [shared.id]: 'Исходное', [free.id]: 'Очистить меня' },
  });
  let edges: Relation[] = [];
  const snapshots = new Map<string, { record: typeof current; edges: Relation[] }>();
  let sequence = 0;
  const receipt = () => {
    const actionId = `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`;
    snapshots.set(actionId, structuredClone({ record: current, edges }));
    return actionId;
  };
  // This transport applies only the exact submitted patch. Rules, defaults, access and
  // transactional rollback belong to the real server integration suite, not this fixture.
  const { calls } = renderWithProviders(
    <>
      <DetailScreen entityId={entity.id} />
      <Toaster />
    </>,
    (path, input) => {
      if (path === 'registry.effective') return catalog;
      if (path === 'entity.get')
        return structuredClone({
          entity: current,
          relations: edges,
          registryVersion: catalog.version,
          thread: null,
        });
      if (path === 'entity.resolveRefs')
        return (input as { ids: string[] }).ids.map((id) => ({
          id,
          title: id === entity.id ? current.title : 'Существующий источник',
          emoji: null,
          archived: false,
          completable: null,
        }));
      if (path === 'entity.query')
        return [
          wireEntity({ id: otherId, title: 'Существующий источник', props: {}, aspects: [] }),
        ];
      if (path === 'entity.updateBatch') {
        const actionId = receipt();
        const operations = (input as { operations: { tool: string; input: Patch }[] }).operations;
        for (const operation of operations) {
          const patch = operation.input;
          expect(operation.tool).toBe('entity_update');
          expect(patch.id).toBe(entity.id);
          current = {
            ...current,
            props: { ...current.props, ...patch.props },
            aspects: [...new Set([...current.aspects, ...(patch.aspects?.attach ?? [])])].filter(
              (id) => !patch.aspects?.detach?.includes(id),
            ),
          };
          for (const id of patch.unset ?? []) delete current.props[id];
        }
        return { ok: true, actionId };
      }
      if (path === 'relation.create' || path === 'relation.delete') {
        const actionId = receipt();
        const key = input as { role: string; source_id: string; target_id: string };
        if (path === 'relation.create')
          edges.push({
            id: actionId,
            role: key.role,
            sourceId: key.source_id,
            targetId: key.target_id,
            meta: {},
            createdAt: entity.createdAt,
            updatedAt: entity.updatedAt,
          });
        else
          edges = edges.filter(
            (edge) =>
              !(
                edge.role === key.role &&
                edge.sourceId === key.source_id &&
                edge.targetId === key.target_id
              ),
          );
        return { ok: true, actionId };
      }
      if (path === 'ai.undo') {
        const snapshot = snapshots.get((input as { actionId: string }).actionId);
        if (!snapshot) throw new Error('unknown action receipt');
        current = structuredClone(snapshot.record);
        edges = structuredClone(snapshot.edges);
        return { ok: true };
      }
      return {};
    },
  );
  fireEvent.click(await screen.findByTestId('screen-menu'));
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Свойства и связи' }));
  const panel = await screen.findByRole('dialog', { name: 'Свойства и связи' });
  fireEvent.click(await within(panel).findByText('Добавить: Пользовательский аспект'));
  fireEvent.change(within(panel).getByLabelText('Общее поле'), { target: { value: 'Первое' } });
  fireEvent.change(within(panel).getByLabelText('Второе поле'), { target: { value: 'Второе' } });
  fireEvent.click(within(panel).getByText('Сохранить'));
  await waitFor(() => expect(current.aspects).toContain(custom.id));
  const batches = () => calls.filter((call) => call.path === 'entity.updateBatch');
  expect(batches()).toHaveLength(1);
  expect((batches()[0]?.input as Batch).operations).toEqual([
    {
      tool: 'entity_update',
      input: {
        id: entity.id,
        aspects: { attach: [custom.id] },
        props: { [shared.id]: 'Первое', [extra.id]: 'Второе' },
      },
    },
  ]);
  expect((batches()[0]?.input as { operations: unknown[] }).operations).toHaveLength(1);
  fireEvent.click(within(panel).getByRole('tab', { name: 'Свойства' }));
  fireEvent.click(await within(panel).findByText('Редактировать свойства'));
  expect(within(panel).getAllByLabelText('Общее поле')).toHaveLength(1);
  fireEvent.change(within(panel).getByLabelText('Общее поле'), { target: { value: 'Обновлено' } });
  fireEvent.change(within(panel).getByLabelText('Второе поле'), {
    target: { value: 'Последний фокус' },
  });
  fireEvent.click(within(panel).getByText('Снять значение: Свободное поле'));
  fireEvent.click(within(panel).getByText('Сохранить'));
  await waitFor(() =>
    expect(current.props).toEqual({ [shared.id]: 'Обновлено', [extra.id]: 'Последний фокус' }),
  );
  expect(batches()).toHaveLength(2);
  expect((batches()[1]?.input as Batch).operations).toEqual([
    {
      tool: 'entity_update',
      input: {
        id: entity.id,
        props: { [shared.id]: 'Обновлено', [extra.id]: 'Последний фокус' },
        unset: [free.id],
      },
    },
  ]);
  fireEvent.click(within(panel).getByRole('tab', { name: 'Связи' }));
  fireEvent.click(await within(panel).findByText('Добавить связь'));
  fireEvent.change(within(panel).getByLabelText('Роль связи'), { target: { value: 'mention' } });
  fireEvent.change(within(panel).getByLabelText('Сторона текущей записи'), {
    target: { value: 'target' },
  });
  fireEvent.click(await within(panel).findByText('Выбрать: Существующий источник'));
  fireEvent.click(within(panel).getByText('Сохранить'));
  await waitFor(() => expect(edges).toHaveLength(1));
  const triple = { role: 'mention', source_id: otherId, target_id: entity.id };
  expect(calls.filter((call) => call.path === 'relation.create').map((call) => call.input)).toEqual(
    [triple],
  );
  fireEvent.click(await within(panel).findByText('Снять связь'));
  fireEvent.click(within(panel).getByText('Подтвердить снятие'));
  await waitFor(() => expect(edges).toHaveLength(0));
  expect(calls.filter((call) => call.path === 'relation.delete').map((call) => call.input)).toEqual(
    [triple],
  );
  const undoButtons = await screen.findAllByRole('button', { name: 'Отменить' });
  const undoButton = undoButtons.at(-1);
  if (!undoButton) throw new Error('Undo toast missing');
  fireEvent.click(undoButton);
  await waitFor(() => expect(edges).toHaveLength(1));
  expect(calls.filter((call) => call.path === 'ai.undo').map((call) => call.input)).toEqual([
    { actionId: '00000000-0000-4000-8000-000000000004' },
  ]);
  await within(panel).findByText('Снять связь');
  fireEvent.click(within(panel).getByRole('tab', { name: 'Аспекты' }));
  fireEvent.click(await within(panel).findByText('Снять: Пользовательский аспект'));
  fireEvent.click(within(panel).getByText('Подтвердить снятие'));
  await waitFor(() => expect(current.aspects).not.toContain(custom.id));
  expect(batches()).toHaveLength(3);
  expect((batches()[2]?.input as Batch).operations).toEqual([
    { tool: 'entity_update', input: { id: entity.id, aspects: { detach: [custom.id] } } },
  ]);
  expect(current.props[shared.id]).toBe('Обновлено');
  expect(current.id).toBe(entity.id);
  expect(current.body).toBe(entity.body);
  expect(catalog.properties).toContain(free);
  for (const batch of batches())
    for (const operation of (batch.input as { operations: { input: unknown }[] }).operations)
      expect(operation.input).not.toHaveProperty('body');
  expect(calls.some((call) => call.path.startsWith('ai.') && call.path !== 'ai.undo')).toBe(false);
}, 10_000);
