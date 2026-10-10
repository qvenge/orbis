import type { QueryAst } from '@orbis/shared';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { field } from '../../features/entity-detail/properties-relations/test-fixtures';
import { renderWithProviders, wireEntity } from '../../test/harness';
import { BUILTIN_REGISTRY } from '../../test/registry';
import { refQueryAst, useRefOptions } from './RefField';
import { contractTarget, implementsContract, useEntityOptions } from './useEntityOptions';

afterEach(() => vi.useRealTimers());
function Probe({
  target,
  enabled = true,
  exclude = [],
}: {
  target?: QueryAst | QueryAst[];
  enabled?: boolean;
  exclude?: string[];
}) {
  const [term, setTerm] = useState('');
  const q = useEntityOptions({ target, term, enabled, exclude });
  return (
    <>
      <input aria-label="Поиск" value={term} onChange={(e) => setTerm(e.target.value)} />
      <output data-testid="state">
        {JSON.stringify({
          titles: q.rows.map((r) => r.title),
          pending: q.isPending,
          error: q.isError,
          more: q.mayHaveMore,
        })}
      </output>
      <button type="button" onClick={q.retry}>
        Повторить
      </button>
    </>
  );
}
const state = () => JSON.parse(screen.getByTestId('state').textContent ?? '{}');
const row = (n: number) =>
  wireEntity({
    id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    title: `Запись ${n}`,
  });

test('Q AST: undefined scope, OR alternatives AND search, limit, без мутации', () => {
  const target: QueryAst[] = [
    { filter: { aspect: 'orbis/task' } },
    { filter: { aspect: 'user/project' } },
  ];
  const before = JSON.stringify(target);
  expect(refQueryAst(undefined, 'проект', 20)).toEqual({
    filter: { search: 'проект' },
    sortBy: [{ field: 'orbis/title', dir: 'asc' }],
    limit: 20,
  });
  expect(refQueryAst(undefined, '', 20)?.filter).toBeNull();
  expect(refQueryAst(target, ' задача ', 20)?.filter).toEqual({
    and: [{ or: [{ aspect: 'orbis/task' }, { aspect: 'user/project' }] }, { search: 'задача' }],
  });
  expect(JSON.stringify(target)).toBe(before);
});

function LegacyProbe({ definition }: { definition?: ReturnType<typeof field> }) {
  const q = useRefOptions(definition);
  return <output>{JSON.stringify(q)}</output>;
}
test('legacy ref без target включён; undefined/nonref выключены', async () => {
  const first = renderWithProviders(<LegacyProbe definition={field({ kind: 'ref' })} />, (path) =>
    path === 'entity.query' ? [row(1)] : {},
  );
  await waitFor(() => expect(first.calls.filter((c) => c.path === 'entity.query')).toHaveLength(1));
  expect(first.calls.find((c) => c.path === 'entity.query')?.input).toMatchObject({
    ast: { filter: null, limit: 200 },
  });
  first.unmount();
  const off = renderWithProviders(
    <>
      <LegacyProbe />
      <LegacyProbe definition={field({ kind: 'text' })} />
    </>,
  );
  await act(() => new Promise((r) => setTimeout(r, 20)));
  expect(off.calls.filter((c) => c.path === 'entity.query')).toHaveLength(0);
});

test('enabled false не запрашивает всё; budget считает raw20 до exclude', async () => {
  const off = renderWithProviders(<Probe enabled={false} />);
  fireEvent.click(screen.getByRole('button', { name: 'Повторить' }));
  await act(() => new Promise((r) => setTimeout(r, 20)));
  expect(off.calls).toHaveLength(0);
  off.unmount();
  const on = renderWithProviders(<Probe exclude={[row(1).id, row(2).id]} />, (path) =>
    path === 'entity.query' ? Array.from({ length: 20 }, (_, i) => row(i + 1)) : {},
  );
  await waitFor(() => expect(state().titles).toHaveLength(18));
  expect(state().more).toBe(true);
  expect(on.calls.find((c) => c.path === 'entity.query')?.input).toMatchObject({
    ast: { filter: null, limit: 20 },
  });
});

test('debounce 199/200ms и поздний ответ остаётся под старым ключом', async () => {
  vi.useFakeTimers();
  let release: (value: unknown) => void = () => {};
  const old = new Promise((resolve) => {
    release = resolve;
  });
  const { calls } = renderWithProviders(<Probe />, (path, input) => {
    if (path !== 'entity.query') return {};
    const filter = (input as { ast: QueryAst }).ast.filter;
    return filter && 'search' in filter
      ? [wireEntity({ id: row(2).id, title: 'Новая выдача' })]
      : old;
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(calls.filter((c) => c.path === 'entity.query')).toHaveLength(1);
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'новый' } });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(199);
  });
  expect(calls.filter((c) => c.path === 'entity.query')).toHaveLength(1);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(calls.filter((c) => c.path === 'entity.query')).toHaveLength(2);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
  expect(state().titles).toEqual(['Новая выдача']);
  await act(async () => {
    release([wireEntity({ id: row(1).id, title: 'Старая выдача' })]);
    await vi.advanceTimersByTimeAsync(1);
  });
  expect(state().titles).toEqual(['Новая выдача']);
});

test('отказ чтения отличается от empty и retry получает строки', async () => {
  let failed = true;
  renderWithProviders(<Probe />, (path) => {
    if (path === 'entity.query') {
      if (failed) throw new Error('network');
      return [];
    }
    return {};
  });
  await waitFor(() => expect(state().error).toBe(true));
  expect(state().titles).toEqual([]);
  failed = false;
  fireEvent.click(screen.getByRole('button', { name: 'Повторить' }));
  await waitFor(() => expect(state()).toMatchObject({ error: false, pending: false, titles: [] }));
});

test('contract targets используют bindingIndex; без реализации sentinel null, не all', async () => {
  const task = BUILTIN_REGISTRY.aspects.find((a) => a.id === 'orbis/task');
  if (!task) throw new Error('task fixture missing');
  const custom = {
    ...task,
    id: 'user/complete',
    key: 'user/complete',
    rank: task.rank + 1,
    module: 'finance',
  };
  const registry = { ...BUILTIN_REGISTRY, aspects: [task, custom] };
  expect(contractTarget(registry, 'orbis/completable')?.filter).toEqual({
    or: [{ aspect: 'orbis/task' }, { aspect: 'user/complete' }],
  });
  expect(implementsContract(registry, ['user/complete'], 'orbis/completable')).toBe(true);
  expect(implementsContract(registry, ['user/other'], 'orbis/completable')).toBe(false);
  const target = contractTarget({ ...registry, aspects: [] }, 'orbis/completable');
  expect(target).toBeNull();
  const { calls } = renderWithProviders(
    <Probe target={target ?? undefined} enabled={target !== null} />,
  );
  await act(() => new Promise((r) => setTimeout(r, 20)));
  expect(calls).toHaveLength(0);
});

test('новый term после read error означает pending, а не успешную пустую выдачу', async () => {
  renderWithProviders(<Probe />, (path) => {
    if (path === 'entity.query') throw new Error('network');
    return {};
  });
  await waitFor(() => expect(state().error).toBe(true));
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'повторный поиск' } });
  expect(state()).toMatchObject({ pending: true, error: false, titles: [] });
});
