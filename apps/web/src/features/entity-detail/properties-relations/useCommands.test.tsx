import { useQueryClient } from '@tanstack/react-query';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { getQueryKey } from '@trpc/react-query';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { useResolvedRefs } from '../../../lib/entity-ref/useResolvedRefs';
import { useBlockData } from '../../../lib/query-blocks/batch';
import { resetRegistryVersionForTests, useRegistry } from '../../../lib/registry/useRegistry';
import { blocksReply, renderWithProviders, trpcError, wireEntity } from '../../../test/harness';
import { BUILTIN_REGISTRY, registryReply } from '../../../test/registry';
import { trpc } from '../../../trpc';
import { useToastStore } from '../../../ui/toast-store';
import { detailGetInput } from '../useEntityDetail';
import type { PanelCommand } from './types';
import { usePanelCommands } from './useCommands';

const id = '00000000-0000-4000-8000-000000000010';
const other = '00000000-0000-4000-8000-000000000020';
const actionId = '00000000-0000-4000-8000-000000000100';
const key = { source_id: other, target_id: id, role: 'mention' };
const relation = {
  id: 'rel',
  sourceId: other,
  targetId: id,
  role: 'mention',
  meta: {},
  createdAt: '2026-10-11T00:00:00Z',
};
const fixture = () => ({
  entity: wireEntity({ id, title: 'Запись', props: { 'user/title': 'Было' }, aspects: [] }),
  relations: [],
  registryVersion: BUILTIN_REGISTRY.version,
});
const mutationCount = (calls: { path: string }[]) =>
  calls.filter((c) => ['entity.updateBatch', 'relation.create', 'relation.delete'].includes(c.path))
    .length;
beforeEach(() => resetRegistryVersionForTests());
afterEach(() => {
  for (const toast of useToastStore.getState().toasts) useToastStore.getState().dismiss(toast.id);
});
function Probe({ command }: { command: PanelCommand }) {
  const api = usePanelCommands();
  const [outcome, setOutcome] = useState<unknown>();
  const [reconciled, setReconciled] = useState('');
  return (
    <>
      <button
        type="button"
        onClick={() => {
          setOutcome(undefined);
          void api.run(command).then(setOutcome);
        }}
      >
        Записать
      </button>
      <button type="button" onClick={() => void api.reconcile(command).then(setReconciled)}>
        Проверить
      </button>
      <output data-testid="outcome">{JSON.stringify(outcome)}</output>
      <output data-testid="reconciled">{reconciled}</output>
    </>
  );
}
function ReadyProbe({ command }: { command: PanelCommand }) {
  const registry = useRegistry();
  return (
    <>
      <Probe command={command} />
      <output data-testid="registry-ready">{registry.data?.version}</output>
    </>
  );
}
describe('one translation for each panel command', () => {
  test.each([
    [
      {
        kind: 'attach',
        entityId: id,
        aspectId: 'orbis/task',
        patch: { props: { 'user/title': 'Моё' }, unset: ['user/other'] },
      } satisfies PanelCommand,
      'entity.updateBatch',
      {
        operations: [
          {
            tool: 'entity_update',
            input: {
              id,
              aspects: { attach: ['orbis/task'] },
              props: { 'user/title': 'Моё' },
              unset: ['user/other'],
            },
          },
        ],
      },
    ],
    [
      { kind: 'detach', entityId: id, aspectId: 'orbis/task' } satisfies PanelCommand,
      'entity.updateBatch',
      {
        operations: [{ tool: 'entity_update', input: { id, aspects: { detach: ['orbis/task'] } } }],
      },
    ],
    [
      {
        kind: 'values',
        entityId: id,
        patch: { props: { 'user/title': 'Моё' } },
      } satisfies PanelCommand,
      'entity.updateBatch',
      { operations: [{ tool: 'entity_update', input: { id, props: { 'user/title': 'Моё' } } }] },
    ],
    [{ kind: 'createRelation', entityId: id, key } satisfies PanelCommand, 'relation.create', key],
    [{ kind: 'deleteRelation', entityId: id, key } satisfies PanelCommand, 'relation.delete', key],
  ])('%j sends its single path and retains original edge endpoints', async (command, path, input) => {
    const metadata = {
      ...BUILTIN_REGISTRY,
      aspects: BUILTIN_REGISTRY.aspects.map((a) => ({ ...a, label: { ru: 'Моя задача' } })),
      roles: BUILTIN_REGISTRY.roles.map((r) => ({ ...r, label: { ru: 'Моя связь' } })),
    };
    const { calls } = renderWithProviders(<ReadyProbe command={command} />, (p) =>
      p === 'registry.effective' ? metadata : { actionId, consequences: false },
    );
    await waitFor(() =>
      expect(screen.getByTestId('registry-ready')).toHaveTextContent(metadata.version),
    );
    fireEvent.click(screen.getByText('Записать'));
    await waitFor(() => expect(screen.getByTestId('outcome')).toHaveTextContent('confirmed'));
    expect(mutationCount(calls)).toBe(1);
    expect(calls.find((c) => c.path === path)?.input).toMatchObject(input);
    const titles = {
      attach: 'Добавлен аспект „Моя задача“',
      detach: 'Снят аспект „Моя задача“',
      values: 'Сохранены свойства',
      createRelation: 'Добавлена связь „Моя связь“',
      deleteRelation: 'Снята связь „Моя связь“',
    };
    await waitFor(() =>
      expect(useToastStore.getState().toasts.at(-1)?.title).toBe(titles[command.kind]),
    );
    expect(useToastStore.getState().toasts.at(-1)?.action?.label).toBe('Отменить');
  });
  test('empty values patch returns confirmed without a write/action ID/Undo', async () => {
    const { calls } = renderWithProviders(
      <Probe command={{ kind: 'values', entityId: id, patch: { props: {}, unset: [] } }} />,
      (p) => registryReply(p) ?? {},
    );
    fireEvent.click(screen.getByText('Записать'));
    await waitFor(() =>
      expect(screen.getByTestId('outcome')).toHaveTextContent('{"kind":"confirmed"}'),
    );
    expect(mutationCount(calls)).toBe(0);
    expect(useToastStore.getState().toasts.at(-1)?.title).toBe('Нет изменений');
    expect(useToastStore.getState().toasts.at(-1)?.action).toBeUndefined();
  });
  test('synchronous in-flight guard denies a second click instead of returning the first success', async () => {
    let finish: ((value: unknown) => void) | undefined;
    const { calls } = renderWithProviders(
      <Probe command={{ kind: 'createRelation', entityId: id, key }} />,
      (p) =>
        p === 'relation.create'
          ? new Promise((resolve) => {
              finish = resolve;
            })
          : (registryReply(p) ?? {}),
    );
    fireEvent.click(screen.getByText('Записать'));
    fireEvent.click(screen.getByText('Записать'));
    await waitFor(() => expect(screen.getByTestId('outcome')).toHaveTextContent('rejected'));
    expect(mutationCount(calls)).toBe(1);
    await act(async () => finish?.({ actionId, consequences: false }));
    await waitFor(() => expect(screen.getByTestId('outcome')).toHaveTextContent('confirmed'));
  });
  test('completion after unmount still announces and refreshes the original command', async () => {
    let finish: ((value: unknown) => void) | undefined;
    const { calls, unmount } = renderWithProviders(
      <Probe command={{ kind: 'createRelation', entityId: id, key }} />,
      (p) =>
        p === 'relation.create'
          ? new Promise((resolve) => {
              finish = resolve;
            })
          : (registryReply(p) ?? {}),
    );
    fireEvent.click(screen.getByText('Записать'));
    unmount();
    await act(async () => finish?.({ actionId, consequences: false }));
    expect(calls.find((c) => c.path === 'relation.create')?.input).toEqual(key);
    expect(useToastStore.getState().toasts.at(-1)?.action?.label).toBe('Отменить');
  });
  test('known rejection returns its safe reason with no success toast or Undo', async () => {
    renderWithProviders(
      <Probe
        command={{ kind: 'values', entityId: id, patch: { props: { 'user/title': 'Моё' } } }}
      />,
      (p) => {
        if (p === 'entity.updateBatch') throw trpcError('CONFLICT', 'Состояние изменилось');
        return registryReply(p) ?? {};
      },
    );
    fireEvent.click(screen.getByText('Записать'));
    await waitFor(() =>
      expect(screen.getByTestId('outcome')).toHaveTextContent('Состояние изменилось'),
    );
    expect(useToastStore.getState().toasts).toEqual([]);
  });
});

describe('unknown outcome reconciliation', () => {
  test('network failure after create requires fresh matches read and never fabricates Undo', async () => {
    let state = { ...fixture(), relations: [] as (typeof relation)[] };
    const { calls } = renderWithProviders(
      <Probe command={{ kind: 'createRelation', entityId: id, key }} />,
      (p) => {
        if (p === 'relation.create') {
          state = { ...state, relations: [relation] };
          throw new TypeError('Failed to fetch');
        }
        if (p === 'entity.get') return state;
        return registryReply(p) ?? {};
      },
      { queries: { staleTime: Infinity } },
    );
    fireEvent.click(screen.getByText('Записать'));
    await waitFor(() => expect(screen.getByTestId('outcome')).toHaveTextContent('unknown'));
    fireEvent.click(screen.getByText('Записать'));
    expect(mutationCount(calls)).toBe(1);
    fireEvent.click(screen.getByText('Проверить'));
    await waitFor(() => expect(screen.getByTestId('reconciled')).toHaveTextContent('matches'));
    expect(calls.find((c) => c.path === 'entity.get')?.input).toEqual(detailGetInput(id));
    expect(useToastStore.getState().toasts).toEqual([]);
  });
  test('differs permits a new explicit write only after successful reread', async () => {
    const { calls } = renderWithProviders(
      <Probe command={{ kind: 'createRelation', entityId: id, key }} />,
      (p) => {
        if (p === 'relation.create') throw new TypeError('offline');
        if (p === 'entity.get') return fixture();
        return registryReply(p) ?? {};
      },
    );
    fireEvent.click(screen.getByText('Записать'));
    await waitFor(() => expect(screen.getByTestId('outcome')).toHaveTextContent('unknown'));
    fireEvent.click(screen.getByText('Записать'));
    expect(mutationCount(calls)).toBe(1);
    fireEvent.click(screen.getByText('Проверить'));
    await waitFor(() => expect(screen.getByTestId('reconciled')).toHaveTextContent('differs'));
    expect(mutationCount(calls)).toBe(1);
    fireEvent.click(screen.getByText('Записать'));
    await waitFor(() => expect(mutationCount(calls)).toBe(2));
  });
  test('unavailable keeps mutation blocked and another explicit reread available', async () => {
    let reads = 0;
    const { calls } = renderWithProviders(
      <Probe command={{ kind: 'createRelation', entityId: id, key }} />,
      (p) => {
        if (p === 'relation.create') throw new TypeError('offline');
        if (p === 'entity.get') {
          reads++;
          throw new TypeError('read offline');
        }
        return registryReply(p) ?? {};
      },
    );
    fireEvent.click(screen.getByText('Записать'));
    await waitFor(() => expect(screen.getByTestId('outcome')).toHaveTextContent('unknown'));
    fireEvent.click(screen.getByText('Проверить'));
    await waitFor(() => expect(screen.getByTestId('reconciled')).toHaveTextContent('unavailable'));
    fireEvent.click(screen.getByText('Записать'));
    expect(mutationCount(calls)).toBe(1);
    fireEvent.click(screen.getByText('Проверить'));
    await waitFor(() => expect(reads).toBe(2));
  });
  test.each([
    [
      {
        kind: 'values',
        entityId: id,
        patch: { props: { 'user/title': { b: [2, 1], a: null } }, unset: ['user/absent'] },
      } satisfies PanelCommand,
      {
        ...fixture(),
        entity: wireEntity({
          id,
          title: 'Запись',
          props: { 'user/title': { a: null, b: [2, 1] }, 'user/unrelated': 'remote' },
        }),
      },
      'matches',
    ],
    [
      {
        kind: 'values',
        entityId: id,
        patch: { props: { 'user/title': null } },
      } satisfies PanelCommand,
      fixture(),
      'differs',
    ],
    [
      { kind: 'values', entityId: id, patch: { unset: ['user/title'] } } satisfies PanelCommand,
      { ...fixture(), entity: wireEntity({ id, title: 'Запись', props: { 'user/title': null } }) },
      'differs',
    ],
    [
      {
        kind: 'attach',
        entityId: id,
        aspectId: 'orbis/task',
        patch: { props: { 'user/title': 'Новое' } },
      } satisfies PanelCommand,
      {
        ...fixture(),
        entity: wireEntity({
          id,
          title: 'Запись',
          aspects: ['orbis/task'],
          props: { 'user/title': 'Новое', other: 'ignore' },
        }),
      },
      'matches',
    ],
    [
      { kind: 'attach', entityId: id, aspectId: 'orbis/task', patch: {} } satisfies PanelCommand,
      fixture(),
      'differs',
    ],
    [
      { kind: 'detach', entityId: id, aspectId: 'orbis/task' } satisfies PanelCommand,
      fixture(),
      'matches',
    ],
    [{ kind: 'deleteRelation', entityId: id, key } satisfies PanelCommand, fixture(), 'matches'],
    [
      { kind: 'deleteRelation', entityId: id, key } satisfies PanelCommand,
      { ...fixture(), relations: [relation] },
      'differs',
    ],
    [
      { kind: 'createRelation', entityId: id, key } satisfies PanelCommand,
      { ...fixture(), relations: [{ ...relation, sourceId: id, targetId: other }] },
      'differs',
    ],
  ])('compares only touched properties/aspects or the exact original triple: %j', async (command, state, expected) => {
    renderWithProviders(<Probe command={command} />, (p) =>
      p === 'entity.get' ? state : (registryReply(p) ?? {}),
    );
    fireEvent.click(screen.getByText('Проверить'));
    await waitFor(() => expect(screen.getByTestId('reconciled')).toHaveTextContent(expected));
  });
  test('a missing relations read cannot confirm deletion', async () => {
    renderWithProviders(<Probe command={{ kind: 'deleteRelation', entityId: id, key }} />, (p) =>
      p === 'entity.get' ? { entity: fixture().entity } : (registryReply(p) ?? {}),
    );
    fireEvent.click(screen.getByText('Проверить'));
    await waitFor(() => expect(screen.getByTestId('reconciled')).toHaveTextContent('unavailable'));
  });
});

function FreshnessProbe() {
  const api = usePanelCommands();
  const current = trpc.entity.get.useQuery(detailGetInput(id));
  const another = trpc.entity.get.useQuery({ id: other });
  const query = trpc.entity.query.useQuery({ query: 'tags=command' });
  const count = trpc.entity.count.useQuery({ query: 'tags=command' });
  const block = useBlockData('tags=command');
  const refs = useResolvedRefs([id, other]);
  const budget = trpc.budget.alertCount.useQuery({});
  const edges = trpc.relation.listFor.useQuery({ entityId: id });
  return (
    <>
      <Probe command={{ kind: 'createRelation', entityId: id, key }} />
      <button
        type="button"
        onClick={() => void api.run({ kind: 'createRelation', entityId: id, key })}
      >
        Создать
      </button>
      <output data-testid="freshness">
        {JSON.stringify({
          current: current.data?.entity.title,
          other: another.data?.entity.title,
          query: query.data?.[0]?.title,
          count: count.data,
          block: block.data?.ok && block.data.kind === 'rows' ? block.data.rows[0]?.title : null,
          ref: refs.byId.get(id)?.title,
          budget: budget.data,
          edges: edges.data?.length,
        })}
      </output>
    </>
  );
}
test('create and Undo refresh all live graph views including shared refs and budget', async () => {
  let generation = 0;
  const { calls } = renderWithProviders(
    <FreshnessProbe />,
    (p, input) => {
      if (p === 'relation.create') {
        generation = 1;
        return { actionId, consequences: false };
      }
      if (p === 'ai.undo') {
        generation = 0;
        return {
          actionId: 'undo-receipt',
          undone: { id: actionId, title: 'Связь' },
          pinnedVersions: [],
          bodyRevisions: [],
        };
      }
      const title = `Снимок ${generation}`;
      if (p === 'entity.get')
        return { ...fixture(), entity: wireEntity({ id: (input as { id: string }).id, title }) };
      if (p === 'entity.query') return [wireEntity({ id, title })];
      if (p === 'entity.count' || p === 'budget.alertCount') return generation;
      if (p === 'entity.resolveRefs')
        return [{ id, title, emoji: null, archived: false, completable: false }];
      if (p === 'relation.listFor') return generation ? [relation] : [];
      return (
        registryReply(p) ??
        blocksReply({ 'tags=command': [wireEntity({ id, title })] })(p, input) ??
        {}
      );
    },
    { queries: { staleTime: Infinity } },
  );
  const expected = (g: number) => ({
    current: `Снимок ${g}`,
    other: `Снимок ${g}`,
    query: `Снимок ${g}`,
    count: g,
    block: `Снимок ${g}`,
    ref: `Снимок ${g}`,
    budget: g,
    edges: g,
  });
  await waitFor(() =>
    expect(JSON.parse(screen.getByTestId('freshness').textContent ?? '{}')).toMatchObject(
      expected(0),
    ),
  );
  fireEvent.click(screen.getByText('Создать'));
  await waitFor(() =>
    expect(JSON.parse(screen.getByTestId('freshness').textContent ?? '{}')).toMatchObject(
      expected(1),
    ),
  );
  await waitFor(() =>
    expect(useToastStore.getState().toasts.at(-1)?.action?.label).toBe('Отменить'),
  );
  act(() => useToastStore.getState().toasts.at(-1)?.action?.onSelect());
  await waitFor(() =>
    expect(JSON.parse(screen.getByTestId('freshness').textContent ?? '{}')).toMatchObject(
      expected(0),
    ),
  );
  expect(mutationCount(calls)).toBe(1);
  expect(calls.filter((c) => c.path === 'ai.undo')).toHaveLength(1);
});

function ClosedCacheProbe() {
  const utils = trpc.useUtils();
  const qc = useQueryClient();
  const api = usePanelCommands();
  const [primed, setPrimed] = useState(false);
  const [stale, setStale] = useState<unknown>();
  const get = { id: other };
  const refs = { ids: [other] };
  return (
    <>
      <button
        type="button"
        onClick={() =>
          void Promise.all([
            utils.entity.get.fetch(get),
            utils.entity.resolveRefs.fetch(refs),
          ]).then(() => setPrimed(true))
        }
      >
        Прогреть закрытые
      </button>
      <button
        type="button"
        onClick={() => void api.run({ kind: 'createRelation', entityId: id, key })}
      >
        Создать
      </button>
      <button
        type="button"
        onClick={() =>
          setStale({
            get: qc.getQueryState(getQueryKey(trpc.entity.get, get, 'query'))?.isInvalidated,
            refs: qc.getQueryState(getQueryKey(trpc.entity.resolveRefs, refs, 'query'))
              ?.isInvalidated,
          })
        }
      >
        Проверить кеш
      </button>
      <output data-testid="primed">{String(primed)}</output>
      <output data-testid="closed">{JSON.stringify(stale)}</output>
    </>
  );
}
test('inactive get and batched ref keys become stale without a new network read after create or Undo', async () => {
  const { calls } = renderWithProviders(
    <ClosedCacheProbe />,
    (p) =>
      p === 'entity.get'
        ? fixture()
        : p === 'entity.resolveRefs'
          ? []
          : (registryReply(p) ?? { actionId, consequences: false }),
    { queries: { staleTime: Infinity } },
  );
  fireEvent.click(screen.getByText('Прогреть закрытые'));
  await waitFor(() => expect(screen.getByTestId('primed')).toHaveTextContent('true'));
  fireEvent.click(screen.getByText('Создать'));
  await waitFor(() => expect(useToastStore.getState().toasts.at(-1)?.action).toBeDefined());
  fireEvent.click(screen.getByText('Проверить кеш'));
  expect(screen.getByTestId('closed')).toHaveTextContent('{"get":true,"refs":true}');
  act(() => useToastStore.getState().toasts.at(-1)?.action?.onSelect());
  await waitFor(() => expect(calls.some((c) => c.path === 'ai.undo')).toBe(true));
  expect(calls.filter((c) => c.path === 'entity.get')).toHaveLength(1);
  expect(calls.filter((c) => c.path === 'entity.resolveRefs')).toHaveLength(1);
});
function WithRead({ command }: { command: PanelCommand }) {
  trpc.entity.get.useQuery(detailGetInput(id));
  return <Probe command={command} />;
}
test('reconcile invalidates and fetches even a fresh Infinity cache entry', async () => {
  let current = fixture();
  const command: PanelCommand = {
    kind: 'values',
    entityId: id,
    patch: { props: { 'user/title': 'Новое' } },
  };
  const { calls } = renderWithProviders(
    <WithRead command={command} />,
    (p) => (p === 'entity.get' ? current : (registryReply(p) ?? {})),
    { queries: { staleTime: Infinity } },
  );
  await waitFor(() => expect(calls.filter((c) => c.path === 'entity.get')).toHaveLength(1));
  current = {
    ...current,
    entity: wireEntity({ id, title: 'Запись', props: { 'user/title': 'Новое' } }),
  };
  fireEvent.click(screen.getByText('Проверить'));
  await waitFor(() => expect(screen.getByTestId('reconciled')).toHaveTextContent('matches'));
  expect(calls.filter((c) => c.path === 'entity.get')).toHaveLength(2);
});
function SwitchingProbe({ commands }: { commands: PanelCommand[] }) {
  const [index, setIndex] = useState(0);
  const command = commands[index];
  if (!command) throw new Error('Missing command fixture');
  return (
    <>
      <button type="button" onClick={() => setIndex(0)}>
        Команда 1
      </button>
      <button type="button" onClick={() => setIndex(1)}>
        Команда 2
      </button>
      <Probe command={command} />
    </>
  );
}
test('an unresolved command does not block a different new editor gesture', async () => {
  const first: PanelCommand = { kind: 'createRelation', entityId: id, key };
  const second: PanelCommand = {
    kind: 'values',
    entityId: other,
    patch: { props: { 'user/title': 'Новое' } },
  };
  const { calls } = renderWithProviders(<SwitchingProbe commands={[first, second]} />, (p) => {
    if (p === 'relation.create') throw new TypeError('offline');
    return registryReply(p) ?? { actionId, consequences: false };
  });
  fireEvent.click(screen.getByText('Записать'));
  await waitFor(() => expect(screen.getByTestId('outcome')).toHaveTextContent('unknown'));
  fireEvent.click(screen.getByText('Команда 2'));
  fireEvent.click(screen.getByText('Записать'));
  await waitFor(() => expect(screen.getByTestId('outcome')).toHaveTextContent('confirmed'));
  expect(calls.find((c) => c.path === 'entity.updateBatch')?.input).toMatchObject({
    operations: [{ input: { id: other } }],
  });
});
test('unknown guard uses the submitted snapshot even if caller mutates the original command object', async () => {
  const command: PanelCommand = {
    kind: 'values',
    entityId: id,
    patch: { props: { 'user/title': 'Снимок' } },
  };
  let finish: ((reason: unknown) => void) | undefined;
  const { calls } = renderWithProviders(
    <SwitchingProbe
      commands={[
        command,
        { kind: 'values', entityId: id, patch: { props: { 'user/title': 'Снимок' } } },
      ]}
    />,
    (p) =>
      p === 'entity.updateBatch'
        ? new Promise((_resolve, reject) => {
            finish = reject;
          })
        : (registryReply(p) ?? {}),
  );
  fireEvent.click(screen.getByText('Записать'));
  command.patch.props = { 'user/title': 'Поздняя правка' };
  await act(async () => finish?.(new TypeError('offline')));
  await waitFor(() => expect(screen.getByTestId('outcome')).toHaveTextContent('unknown'));
  expect(calls.find((c) => c.path === 'entity.updateBatch')?.input).toMatchObject({
    operations: [{ input: { props: { 'user/title': 'Снимок' } } }],
  });
  fireEvent.click(screen.getByText('Команда 2'));
  fireEvent.click(screen.getByText('Записать'));
  expect(mutationCount(calls)).toBe(1);
});
test('reread of a different command cannot unlock an unresolved snapshot', async () => {
  const command: PanelCommand = { kind: 'createRelation', entityId: id, key };
  const { calls } = renderWithProviders(
    <SwitchingProbe
      commands={[command, { kind: 'detach', entityId: id, aspectId: 'orbis/task' }]}
    />,
    (p) => {
      if (p === 'relation.create') throw new TypeError('offline');
      return p === 'entity.get' ? fixture() : (registryReply(p) ?? {});
    },
  );
  fireEvent.click(screen.getByText('Записать'));
  await waitFor(() => expect(screen.getByTestId('outcome')).toHaveTextContent('unknown'));
  fireEvent.click(screen.getByText('Команда 2'));
  fireEvent.click(screen.getByText('Проверить'));
  await waitFor(() => expect(screen.getByTestId('reconciled')).toHaveTextContent('matches'));
  fireEvent.click(screen.getByText('Команда 1'));
  fireEvent.click(screen.getByText('Записать'));
  expect(mutationCount(calls)).toBe(1);
});

test('a second unknown gesture cannot erase the first unresolved command guard', async () => {
  const first: PanelCommand = { kind: 'createRelation', entityId: id, key };
  const second: PanelCommand = {
    kind: 'values',
    entityId: other,
    patch: { props: { 'user/title': 'Новое' } },
  };
  const { calls } = renderWithProviders(<SwitchingProbe commands={[first, second]} />, (p) => {
    if (p === 'relation.create' || p === 'entity.updateBatch') throw new TypeError('offline');
    return registryReply(p) ?? {};
  });
  fireEvent.click(screen.getByText('Записать'));
  await waitFor(() => expect(screen.getByTestId('outcome')).toHaveTextContent('unknown'));
  fireEvent.click(screen.getByText('Команда 2'));
  fireEvent.click(screen.getByText('Записать'));
  await waitFor(() => expect(mutationCount(calls)).toBe(2));
  await waitFor(() => expect(screen.getByTestId('outcome')).toHaveTextContent('unknown'));
  fireEvent.click(screen.getByText('Команда 1'));
  fireEvent.click(screen.getByText('Записать'));
  await act(async () => {});
  expect(mutationCount(calls)).toBe(2);
});

test('reconcile starts a new read instead of joining a pre-command in-flight read', async () => {
  let reads = 0;
  let finishOld: ((value: unknown) => void) | undefined;
  const command: PanelCommand = {
    kind: 'values',
    entityId: id,
    patch: { props: { 'user/title': 'Новое' } },
  };
  const current = {
    ...fixture(),
    entity: wireEntity({ id, title: 'Запись', props: { 'user/title': 'Новое' } }),
  };
  const { calls } = renderWithProviders(
    <WithRead command={command} />,
    (p) => {
      if (p === 'entity.get') {
        reads++;
        return reads === 1
          ? new Promise((resolve) => {
              finishOld = resolve;
            })
          : current;
      }
      if (p === 'entity.updateBatch') throw new TypeError('lost response');
      return registryReply(p) ?? {};
    },
    { queries: { staleTime: Infinity } },
  );
  await waitFor(() => expect(calls.filter((c) => c.path === 'entity.get')).toHaveLength(1));
  fireEvent.click(screen.getByText('Записать'));
  await waitFor(() => expect(screen.getByTestId('outcome')).toHaveTextContent('unknown'));
  fireEvent.click(screen.getByText('Проверить'));
  try {
    await waitFor(() => expect(calls.filter((c) => c.path === 'entity.get')).toHaveLength(2));
    await waitFor(() => expect(screen.getByTestId('reconciled')).toHaveTextContent('matches'));
  } finally {
    await act(async () => finishOld?.(fixture()));
  }
});
