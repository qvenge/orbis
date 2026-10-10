import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { resetRegistryVersionForTests } from '../../../lib/registry/useRegistry';
import { mayLeave } from '../../../state/leave-guard';
import {
  type MockHandler,
  renderWithProviders,
  trpcError,
  wireEntity,
} from '../../../test/harness';
import { navAt } from '../../../test/nav';
import { useToastStore } from '../../../ui/toast-store';
import type { PanelHostActions } from '../PropertiesRelationsSlot';
import { PropertiesRelationsPanel } from './PropertiesRelationsPanel';
import { entity, field, registry } from './test-fixtures';

it('client parse error focuses the visible alert and preserves incomplete numeric raw without a write', async () => {
  const numeric = {
    ...registry,
    properties: registry.properties.map((def) =>
      def.id === 'user/title' ? field({ kind: 'number' }) : def,
    ),
  };
  const { calls } = renderWithProviders(panel(), (path, input) =>
    path === 'registry.effective'
      ? numeric
      : path === 'entity.get'
        ? {
            entity: { ...entity, props: { 'user/title': 1 } },
            relations: [],
            registryVersion: registry.version,
          }
        : handler(path, input),
  );
  await properties();
  fireEvent.change(screen.getByLabelText('Поле теста'), { target: { value: '1e' } });
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
  const alert = await screen.findByRole('alert');
  expect(alert).toHaveFocus();
  expect(screen.getByLabelText('Поле теста')).toHaveValue('1e');
  expect(calls.some((call) => call.path === 'entity.updateBatch')).toBe(false);
});

it('late confirmed A command retains its original Undo and never fills forced B inputs', async () => {
  let release: (value: unknown) => void = () => {};
  const pending = new Promise((resolve) => (release = resolve));
  function Host() {
    const [current, setCurrent] = useState(id);
    return (
      <>
        <button type="button" onClick={() => setCurrent(neighbor)}>
          Force B
        </button>
        <PropertiesRelationsPanel
          key={current}
          target={{ entityId: current, readOnly: false }}
          host={{ ...host, screenEntityId: current }}
          onClose={() => {}}
        />
      </>
    );
  }
  const { calls } = renderWithProviders(<Host />, (path, input, type) => {
    if (path === 'entity.updateBatch') return pending;
    if (path === 'entity.get') {
      const current = (input as { id: string }).id;
      return {
        entity: {
          ...entity,
          id: current,
          title: current === id ? 'Запись A' : 'Запись B',
          props: { 'user/title': current === id ? 'A' : 'B' },
        },
        relations: [],
        registryVersion: registry.version,
      };
    }
    return type === 'mutation' ? { ok: true } : handler(path, input);
  });
  await properties();
  fireEvent.change(screen.getByLabelText('Поле теста'), { target: { value: 'local A' } });
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
  await waitFor(() =>
    expect(calls.filter((call) => call.path === 'entity.updateBatch')).toHaveLength(1),
  );
  fireEvent.click(screen.getByText('Force B'));
  await screen.findByText('Запись B');
  await properties();
  const actionId = '00000000-0000-4000-8000-000000000088';
  release({ ok: true, actionId });
  await waitFor(() =>
    expect(
      useToastStore.getState().toasts.some((toast) => toast.title === 'Сохранены свойства'),
    ).toBe(true),
  );
  expect(screen.getByLabelText('Поле теста')).toHaveValue('B');
  expect(calls.find((call) => call.path === 'entity.updateBatch')?.input).toMatchObject({
    operations: [{ tool: 'entity_update', input: { id, props: { 'user/title': 'local A' } } }],
  });
  useToastStore
    .getState()
    .toasts.find((toast) => toast.title === 'Сохранены свойства')
    ?.action?.onSelect();
  await waitFor(() =>
    expect(calls.find((call) => call.path === 'ai.undo')?.input).toEqual({ actionId }),
  );
  expect(screen.getByLabelText('Поле теста')).toHaveValue('B');
});
it('special page editor exposes current host refusal after forced address change', async () => {
  renderWithProviders(
    <PropertiesRelationsPanel
      target={{ entityId: entity.id, readOnly: false }}
      host={{ ...host, screenEntityId: neighbor, available: new Set(['openBody']) }}
      onClose={() => {}}
    />,
    (path, input) =>
      path === 'entity.get'
        ? {
            entity: { ...entity, aspects: ['orbis/page'] },
            relations: [],
            registryVersion: registry.version,
          }
        : handler(path, input),
  );
  expect(await screen.findByRole('button', { name: 'Открыть редактор: Страница' })).toBeDisabled();
  expect(
    screen.getAllByText('Откройте эту запись, чтобы выполнить действие').length,
  ).toBeGreaterThan(0);
});
it('tabs use one keyboard stop, linked panels and arrow/Home/End navigation while retaining raw', async () => {
  renderWithProviders(panel(), handler);
  await properties();
  fireEvent.change(screen.getByLabelText('Поле теста'), { target: { value: 'local' } });
  const propertiesTab = screen.getByRole('tab', { name: 'Свойства' });
  propertiesTab.focus();
  expect(propertiesTab).toHaveAttribute('tabindex', '0');
  expect(screen.getByRole('tab', { name: 'Аспекты' })).toHaveAttribute('tabindex', '-1');
  fireEvent.keyDown(propertiesTab, { key: 'ArrowRight' });
  const relationsTab = screen.getByRole('tab', { name: 'Связи' });
  expect(relationsTab).toHaveFocus();
  expect(relationsTab).toHaveAttribute('aria-selected', 'true');
  expect(screen.getByRole('tabpanel')).toHaveAttribute(
    'id',
    relationsTab.getAttribute('aria-controls'),
  );
  fireEvent.keyDown(relationsTab, { key: 'Home' });
  expect(screen.getByRole('tab', { name: 'Аспекты' })).toHaveFocus();
  fireEvent.keyDown(screen.getByRole('tab', { name: 'Аспекты' }), { key: 'End' });
  expect(relationsTab).toHaveFocus();
  fireEvent.keyDown(relationsTab, { key: 'ArrowLeft' });
  expect(screen.getByLabelText('Поле теста')).toHaveValue('local');
});
it('dirty confirmation traps focus and cannot save the underlying form before explicit decision', async () => {
  const { calls } = renderWithProviders(panel(), handler);
  await properties();
  fireEvent.change(screen.getByLabelText('Поле теста'), { target: { value: 'local' } });
  fireEvent.click(screen.getByRole('button', { name: 'Закрыть' }));
  const dialog = await screen.findByRole('dialog', { name: 'Несохранённые изменения' });
  expect(within(dialog).getByRole('button', { name: 'Продолжить редактирование' })).toHaveFocus();
  expect(screen.queryByRole('button', { name: 'Сохранить' })).toBeNull();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Продолжить редактирование' }));
  expect(screen.getByLabelText('Поле теста')).toHaveValue('local');
  expect(calls.some((call) => call.path === 'entity.updateBatch')).toBe(false);
});
it('explicit unknown discard permits a fresh gesture; old uncertain identity never blocks the next form', async () => {
  let writes = 0;
  renderWithProviders(panel(), (path, input, type) => {
    if (type === 'mutation') {
      writes++;
      if (writes === 1) throw trpcError('INTERNAL_SERVER_ERROR');
      return { ok: true, actionId: '00000000-0000-4000-8000-000000000077' };
    }
    return handler(path, input);
  });
  await properties();
  fireEvent.change(screen.getByLabelText('Поле теста'), { target: { value: 'local' } });
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
  await screen.findByText('Проверьте ввод и сохраните явно ещё раз.');
  fireEvent.click(screen.getByRole('button', { name: 'Отменить' }));
  fireEvent.click(screen.getByRole('button', { name: 'Редактировать свойства' }));
  fireEvent.change(screen.getByLabelText('Поле теста'), { target: { value: 'local' } });
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
  await waitFor(() => expect(writes).toBe(2));
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Сохранить' })).toBeNull());
});
it('a retained local detach confirmation never publishes footer controls while its tab is hidden', async () => {
  renderWithProviders(panel(), (path, input) =>
    path === 'entity.get'
      ? {
          entity: { ...entity, aspects: ['orbis/task'] },
          relations: [],
          registryVersion: registry.version,
        }
      : handler(path, input),
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Снять: Задача' }));
  fireEvent.click(screen.getByRole('tab', { name: 'Свойства' }));
  expect(
    within(screen.getByTestId('panel-footer')).queryByRole('button', {
      name: 'Подтвердить снятие',
    }),
  ).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Редактировать свойства' }));
  expect(await screen.findByRole('button', { name: 'Продолжить редактирование' })).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Продолжить редактирование' }));
  fireEvent.click(screen.getByRole('tab', { name: 'Аспекты' }));
  expect(
    within(screen.getByTestId('panel-footer')).getByRole('button', { name: 'Подтвердить снятие' }),
  ).toBeVisible();
});
const neighbor = '00000000-0000-4000-8000-000000000011';
const manualEdge = {
  id: '00000000-0000-4000-8000-000000000012',
  sourceId: neighbor,
  targetId: entity.id,
  role: 'subitem',
  meta: {},
  createdAt: '2026-10-11T00:00:00Z',
  updatedAt: '2026-10-11T00:00:00Z',
};
it.each([
  'values',
  'attach',
  'detach',
  'createRelation',
  'deleteRelation',
])('controlled %s holds pending/unknown without a values draft and reconciles original addressed command', async (kind) => {
  let reject: (reason: unknown) => void = () => {};
  const gate = new Promise((_resolve, rejectPromise) => (reject = rejectPromise));
  const close = vi.fn();
  let writes = 0;
  const current = { ...entity, aspects: kind === 'detach' ? ['orbis/task'] : [] };
  const relations = kind === 'deleteRelation' ? [manualEdge] : [];
  const { calls } = renderWithProviders(panel(false, close), (path, input, type) => {
    if (type === 'mutation') {
      writes++;
      return gate;
    }
    if (path === 'entity.get')
      return { entity: current, relations, registryVersion: registry.version };
    if (path === 'entity.query')
      return [wireEntity({ id: neighbor, title: 'Сосед', props: {}, aspects: [] })];
    if (path === 'entity.resolveRefs')
      return (input as { ids: string[] }).ids.map((id) => ({
        id,
        title: 'Сосед',
        emoji: null,
        archived: false,
        completable: null,
      }));
    return handler(path, input);
  });
  if (kind === 'values') {
    await properties();
    fireEvent.change(screen.getByLabelText('Поле теста'), { target: { value: 'local' } });
  } else if (kind === 'attach')
    fireEvent.click(await screen.findByRole('button', { name: 'Добавить: Задача' }));
  else if (kind === 'detach')
    fireEvent.click(await screen.findByRole('button', { name: 'Снять: Задача' }));
  else {
    fireEvent.click(await screen.findByRole('tab', { name: 'Связи' }));
    if (kind === 'deleteRelation')
      fireEvent.click(screen.getByRole('button', { name: 'Снять связь' }));
    else {
      fireEvent.click(screen.getByRole('button', { name: 'Добавить связь' }));
      fireEvent.change(screen.getByLabelText('Роль связи'), { target: { value: 'subitem' } });
      fireEvent.change(screen.getByLabelText('Сторона текущей записи'), {
        target: { value: 'target' },
      });
      fireEvent.click(await screen.findByRole('button', { name: 'Выбрать: Сосед' }));
    }
  }
  const save = screen.getByRole('button', {
    name: kind === 'detach' || kind === 'deleteRelation' ? 'Подтвердить снятие' : 'Сохранить',
  });
  fireEvent.click(save);
  await waitFor(() => expect(writes).toBe(1));
  expect(save).toBeDisabled();
  expect(mayLeave()).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Закрыть' }));
  expect(close).not.toHaveBeenCalled();
  reject(trpcError('INTERNAL_SERVER_ERROR', 'private SQL'));
  await screen.findByText('Не удалось подтвердить сохранение. Ввод сохранён.');
  await screen.findByText('Проверьте ввод и сохраните явно ещё раз.');
  expect(writes).toBe(1);
  expect(mayLeave()).toBe(false);
  expect(screen.queryByText('private SQL')).toBeNull();
  if (kind === 'createRelation' || kind === 'deleteRelation') {
    expect(
      calls.find(
        (call) => call.path === (kind === 'createRelation' ? 'relation.create' : 'relation.delete'),
      )?.input,
    ).toEqual({ source_id: neighbor, target_id: id, role: 'subitem' });
    expect(screen.getByTestId('submitted-relation')).toHaveTextContent(
      kind === 'createRelation' ? 'Исходная связь отсутствует' : 'Исходная связь присутствует',
    );
  }
});
it('discarding hidden values opens the requested local detach confirmation, not a lost old setter', async () => {
  renderWithProviders(panel(), (path, input) =>
    path === 'entity.get'
      ? {
          entity: { ...entity, aspects: ['orbis/task'] },
          relations: [],
          registryVersion: registry.version,
        }
      : handler(path, input),
  );
  await properties();
  fireEvent.change(screen.getByLabelText('Поле теста'), { target: { value: 'local' } });
  fireEvent.click(screen.getByRole('tab', { name: 'Аспекты' }));
  fireEvent.click(screen.getByRole('button', { name: 'Снять: Задача' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Отбросить изменения' }));
  expect(await screen.findByRole('button', { name: 'Подтвердить снятие' })).toBeVisible();
  expect(
    within(screen.getByTestId('panel-footer')).getByRole('button', { name: 'Подтвердить снятие' }),
  ).toBeVisible();
  expect(mayLeave()).toBe(false);
});
it('read failure is an alert with explicit retry and no write', async () => {
  let failed = true;
  const { calls } = renderWithProviders(panel(), (path, input) => {
    if (path === 'entity.get' && failed) throw trpcError('INTERNAL_SERVER_ERROR');
    return handler(path, input);
  });
  expect(await screen.findByRole('alert')).toHaveTextContent('Не удалось прочитать');
  failed = false;
  fireEvent.click(screen.getByRole('button', { name: 'Повторить чтение' }));
  expect(await screen.findByText(entity.title)).toBeVisible();
  expect(
    calls.some((call) =>
      ['entity.updateBatch', 'entity.update', 'relation.create', 'relation.delete'].includes(
        call.path,
      ),
    ),
  ).toBe(false);
});
const id = entity.id;
const host: PanelHostActions = {
  screenEntityId: id,
  available: new Set(['openBody', 'restore', 'makePage', 'stopPage', 'configureApp']),
  run: vi.fn(),
};
beforeEach(() => {
  navAt(id);
  resetRegistryVersionForTests();
  vi.stubGlobal('requestIdleCallback', () => 1);
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const toast of useToastStore.getState().toasts) useToastStore.getState().dismiss(toast.id);
});
const handler: MockHandler = (path) =>
  path === 'entity.get'
    ? { entity, relations: [], registryVersion: registry.version }
    : path === 'registry.effective'
      ? registry
      : path === 'entity.query'
        ? []
        : path === 'entity.resolveRefs'
          ? []
          : {};
const panel = (readOnly = false, onClose = vi.fn()) => (
  <PropertiesRelationsPanel target={{ entityId: id, readOnly }} host={host} onClose={onClose} />
);
async function properties() {
  fireEvent.click(await screen.findByRole('tab', { name: 'Свойства' }));
  fireEvent.click(screen.getByRole('button', { name: 'Редактировать свойства' }));
}
it('wide dialog has title/id and starts Aspects; one scroll area and persistent safe-area footer', async () => {
  renderWithProviders(panel(), handler);
  const dialog = await screen.findByRole('dialog', { name: 'Свойства и связи' });
  expect(await within(dialog).findByText(entity.title)).toBeVisible();
  expect(within(dialog).getByText(id)).toBeVisible();
  expect(screen.getByRole('tab', { name: 'Аспекты' })).toHaveAttribute('aria-selected', 'true');
  expect(screen.getByTestId('panel-scroll')).toHaveClass('min-h-0', 'flex-1', 'overflow-y-auto');
  expect(screen.getByTestId('panel-footer')).toHaveClass('shrink-0');
});
it('raw last-focused value sends one touched patch and only confirmed closes editor', async () => {
  const { calls } = renderWithProviders(panel(), (path, input, type) =>
    type === 'mutation'
      ? { ok: true, actionId: '00000000-0000-4000-8000-000000000099' }
      : handler(path, input),
  );
  await properties();
  fireEvent.change(screen.getByLabelText('Поле теста'), { target: { value: '  Новое  ' } });
  const footer = within(screen.getByTestId('panel-footer'));
  expect(footer.getAllByRole('button', { name: 'Сохранить' })).toHaveLength(1);
  fireEvent.click(footer.getByRole('button', { name: 'Сохранить' }));
  await waitFor(() => expect(calls.filter((c) => c.path === 'entity.updateBatch')).toHaveLength(1));
  expect(calls.find((c) => c.path === 'entity.updateBatch')?.input).toMatchObject({
    operations: [{ tool: 'entity_update', input: { id, props: { 'user/title': '  Новое  ' } } }],
  });
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Сохранить' })).toBeNull());
});
it('empty active editor still guards Escape and explicit discard closes without writes', async () => {
  const close = vi.fn();
  const { calls } = renderWithProviders(panel(false, close), handler);
  fireEvent.click(await screen.findByRole('button', { name: /Добавить: Задача/ }));
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
  expect(await screen.findByRole('button', { name: 'Продолжить редактирование' })).toBeVisible();
  expect(close).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Отбросить изменения' }));
  expect(close).toHaveBeenCalledOnce();
  expect(calls.some((c) => c.path === 'entity.updateBatch')).toBe(false);
});
it('tab change retains raw but visible footer never submits hidden editor; next editor asks confirmation', async () => {
  const { calls } = renderWithProviders(panel(), handler);
  await properties();
  fireEvent.change(screen.getByLabelText('Поле теста'), { target: { value: 'local' } });
  fireEvent.click(screen.getByRole('tab', { name: 'Связи' }));
  expect(
    within(screen.getByTestId('panel-footer')).queryByRole('button', { name: 'Сохранить' }),
  ).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Добавить связь' }));
  expect(await screen.findByRole('button', { name: 'Продолжить редактирование' })).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Продолжить редактирование' }));
  fireEvent.click(screen.getByRole('tab', { name: 'Свойства' }));
  expect(screen.getByLabelText('Поле теста')).toHaveValue('local');
  expect(calls.some((c) => c.path === 'entity.updateBatch' || c.path === 'relation.create')).toBe(
    false,
  );
});
it('global leave and beforeunload use same dirty guard; discard requires repeating global navigation', async () => {
  renderWithProviders(panel(), handler);
  await properties();
  expect(mayLeave()).toBe(false);
  expect(await screen.findByRole('button', { name: 'Отбросить изменения' })).toBeVisible();
  const event = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Отбросить изменения' }));
  expect(mayLeave()).toBe(true);
  expect(
    useToastStore
      .getState()
      .toasts.some((t) => t.title === 'Изменения отброшены — повторите переход'),
  ).toBe(true);
});
it('pending values prevents repeat, close, Escape, cancel, editor switch and navigation', async () => {
  let release: (v: unknown) => void = () => {};
  const gate = new Promise((r) => (release = r));
  const close = vi.fn();
  const { calls } = renderWithProviders(panel(false, close), (path, input, type) =>
    type === 'mutation' ? gate : handler(path, input),
  );
  await properties();
  fireEvent.change(screen.getByLabelText('Поле теста'), { target: { value: 'local' } });
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
  expect(screen.getByRole('button', { name: 'Сохранить' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Отменить' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Закрыть' }));
  expect(close).not.toHaveBeenCalled();
  expect(mayLeave()).toBe(false);
  expect(calls.filter((c) => c.path === 'entity.updateBatch')).toHaveLength(1);
  release({ ok: true });
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Сохранить' })).toBeNull());
});
it('public refusal keeps raw, focuses only visible error and does not mutate automatically', async () => {
  renderWithProviders(panel(), (path, input, type) => {
    if (type === 'mutation') throw trpcError('UNPROCESSABLE_CONTENT', 'Нельзя изменить user/title');
    return handler(path, input);
  });
  await properties();
  fireEvent.change(screen.getByLabelText('Поле теста'), { target: { value: 'local' } });
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent('Нельзя изменить Поле теста');
  expect(alert).toHaveFocus();
  expect(screen.getByLabelText('Поле теста')).toHaveValue('local');
});
it.each([
  'matches',
  'differs',
  'unavailable',
])('unknown %s rereads, keeps immutable raw and offers only safe explicit lifecycle', async (state) => {
  let wrote = false;
  const { calls } = renderWithProviders(panel(), (path, input, type) => {
    if (type === 'mutation') {
      wrote = true;
      throw trpcError('INTERNAL_SERVER_ERROR', 'SQL secret');
    }
    if (path === 'entity.get' && wrote) {
      if (state === 'unavailable') throw trpcError('INTERNAL_SERVER_ERROR');
      return {
        entity: { ...entity, props: { 'user/title': state === 'matches' ? 'local' : 'remote' } },
        relations: [],
        registryVersion: registry.version,
      };
    }
    return handler(path, input);
  });
  await properties();
  fireEvent.change(screen.getByLabelText('Поле теста'), { target: { value: 'local' } });
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
  await screen.findByText('Не удалось подтвердить сохранение. Ввод сохранён.');
  if (state === 'matches') {
    await screen.findByRole('button', { name: 'Принять текущее состояние' });
    expect(screen.getByRole('button', { name: 'Сохранить' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Принять текущее состояние' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Сохранить' })).toBeNull());
  } else if (state === 'differs') {
    expect(await screen.findByText('remote', { exact: true })).toBeVisible();
    expect(screen.getByLabelText('Поле теста')).toHaveValue('local');
  } else {
    await screen.findByText(
      'Не удалось прочитать текущее состояние. Повторное сохранение недоступно.',
    );
    expect(screen.getByRole('button', { name: 'Сохранить' })).toBeDisabled();
  }
  expect(screen.queryByText('SQL secret')).toBeNull();
  expect(calls.filter((c) => c.path === 'entity.updateBatch')).toHaveLength(1);
});
it('preview exposes only reading and body navigation, no mutation from any form', async () => {
  const { calls } = renderWithProviders(panel(true), handler);
  expect(await screen.findByText('Предпросмотр — только чтение')).toBeVisible();
  fireEvent.click(screen.getByRole('tab', { name: 'Свойства' }));
  expect(screen.getByRole('button', { name: 'Редактировать свойства' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Открыть текст записи' }));
  expect(host.run).toHaveBeenCalledWith('openBody', { entityId: id, readOnly: true });
  expect(
    calls.some((c) =>
      ['entity.updateBatch', 'entity.update', 'relation.create', 'relation.delete'].includes(
        c.path,
      ),
    ),
  ).toBe(false);
});
