import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { resetRegistryVersionForTests } from '../../../lib/registry/useRegistry';
import { installCrashTrap, renderWithProviders } from '../../../test/harness';
import { PropertiesRelationsSlot } from '../PropertiesRelationsSlot';
import { entity, field, registry } from './test-fixtures';

installCrashTrap();
const chunk = vi.hoisted(() => ({
  pending: Promise.resolve() as Promise<void>,
  reject: (_reason: unknown) => {},
  recover: false,
  loads: 0,
}));
vi.mock('../../../lib/registry/LazyListControl', async (original) => {
  const actual = await original<typeof import('../../../lib/registry/LazyListControl')>();
  return {
    ...actual,
    loadRefManyControl: async () => {
      chunk.loads++;
      if (!chunk.recover) await chunk.pending;
      return (await import('../../../lib/registry/RefManyControl')).RefManyControl;
    },
    loadScalarListControl: async () => {
      chunk.loads++;
      if (!chunk.recover) await chunk.pending;
      return (await import('../../../lib/registry/ScalarListControl')).ScalarListControl;
    },
  };
});
beforeEach(() => {
  resetRegistryVersionForTests();
  chunk.pending = new Promise((_resolve, reject) => (chunk.reject = reject));
  chunk.recover = false;
  chunk.loads = 0;
});

it.each([
  'ref',
  'text',
] as const)('%s list leaf failure and explicit successful retry preserve mounted real Panel raw without an automatic write', async (kind) => {
  const def = {
    ...field({ kind, cardinality: 'many' }, 'user/list'),
    label: { ru: 'Список теста' },
  };
  const old = kind === 'ref' ? '00000000-0000-4000-8000-000000000099' : 'Строка, с запятой';
  const record = { ...entity, props: { ...entity.props, [def.id]: [old] } };
  const catalog = { ...registry, properties: [...registry.properties, def] };
  const { calls } = renderWithProviders(
    <PropertiesRelationsSlot
      target={{ entityId: entity.id, readOnly: false }}
      host={{ screenEntityId: entity.id, available: new Set(), run() {} }}
      onClose={() => {}}
    />,
    (path) =>
      path === 'entity.get'
        ? { entity: record, relations: [], registryVersion: catalog.version }
        : path === 'registry.effective'
          ? catalog
          : path === 'entity.updateBatch'
            ? { ok: true, actionId: '00000000-0000-4000-8000-000000000123' }
            : [],
  );
  // Cold-load the real Panel before exercising the separately controlled leaf failure.
  fireEvent.click(await screen.findByRole('tab', { name: 'Свойства' }, { timeout: 3000 }));
  fireEvent.click(screen.getByRole('button', { name: 'Редактировать свойства' }));
  fireEvent.change(screen.getByLabelText('Поле теста'), {
    target: { value: 'raw survives leaf failure' },
  });
  await screen.findByText(/^Загрузка редактора:/);
  const raw = screen.getByLabelText('Поле теста');
  await act(async () => chunk.reject(new Error('chunk network failure')));
  await screen.findByRole('button', { name: /^Повторить загрузку редактора:/ });
  expect(screen.queryByRole('button', { name: 'Повторить загрузку панели' })).toBeNull();
  expect(screen.getByLabelText('Поле теста')).toBe(raw);
  expect(raw).toHaveValue('raw survives leaf failure');
  expect(chunk.loads).toBe(1);
  expect(calls.filter((call) => call.path === 'entity.updateBatch')).toHaveLength(0);
  chunk.recover = true;
  fireEvent.click(screen.getByRole('button', { name: /^Повторить загрузку редактора:/ }));
  if (kind === 'ref') {
    const remove = await screen.findByRole('button', { name: /^Убрать: Недоступная ссылка/ });
    expect(remove.getAttribute('aria-label')).toContain(old);
    fireEvent.click(remove);
  } else {
    expect(await screen.findByLabelText('Список теста: строка 1')).toHaveValue(old);
    fireEvent.click(screen.getByRole('button', { name: /^Удалить строку 1:/ }));
  }
  expect(chunk.loads).toBe(2);
  expect(screen.getByLabelText('Поле теста')).toBe(raw);
  expect(raw).toHaveValue('raw survives leaf failure');
  expect(calls.filter((call) => call.path === 'entity.updateBatch')).toHaveLength(0);
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
  await waitFor(() =>
    expect(calls.filter((call) => call.path === 'entity.updateBatch')).toHaveLength(1),
  );
  expect(calls.find((call) => call.path === 'entity.updateBatch')?.input).toMatchObject({
    operations: [
      {
        tool: 'entity_update',
        input: {
          id: entity.id,
          props: { 'user/title': 'raw survives leaf failure', [def.id]: [] },
        },
      },
    ],
  });
});
