import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { expect, test } from 'vitest';
import { renderWithProviders } from '../../test/harness';
import { useResolvedRefs } from './useResolvedRefs';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const row = (id: string, title = id) => ({
  id,
  title,
  emoji: null,
  archived: false,
  completable: null,
});
function Probe({ ids, onMap }: { ids: string[]; onMap?: (map: unknown) => void }) {
  const [extra, setExtra] = useState<string[]>([]);
  const [, tick] = useState(0);
  const refs = useResolvedRefs([...ids, ...extra]);
  onMap?.(refs.byId);
  return (
    <>
      <output data-testid="refs">
        {JSON.stringify({
          rows: [...refs.byId.values()],
          pending: [...refs.pendingIds],
          failed: [...refs.failedIds],
        })}
      </output>
      <button type="button" onClick={refs.retry}>
        Повторить
      </button>
      <button type="button" onClick={() => tick((n) => n + 1)}>
        Render
      </button>
      <button type="button" onClick={() => setExtra([id(999)])}>
        Добавить id
      </button>
    </>
  );
}
const state = () => JSON.parse(screen.getByTestId('refs').textContent ?? '{}');

test('401 уникальный id в 3 пачках <=200, сортировка/дубли/51-е не теряется, no entity.get', async () => {
  const ids = Array.from({ length: 401 }, (_, i) => id(i + 1));
  const { calls } = renderWithProviders(
    <Probe ids={[...ids].reverse().concat(ids[0] ?? '')} />,
    (path, input) =>
      path === 'entity.resolveRefs' ? (input as { ids: string[] }).ids.map((i) => row(i)) : {},
  );
  await waitFor(() => expect(state().rows).toHaveLength(401));
  expect(calls).toHaveLength(3);
  const asked = calls.map((c) => (c.input as { ids: string[] }).ids);
  expect(asked.map((a) => a.length)).toEqual([200, 200, 1]);
  expect(asked.flat()).toEqual(ids);
  expect(state().rows.some((r: { id: string }) => r.id === id(51))).toBe(true);
  expect(calls.every((c) => c.path === 'entity.resolveRefs')).toBe(true);
});

test('pending/error не означают missing; одна ошибочная пачка не обнуляет другие', async () => {
  let release: (value: unknown) => void = () => {};
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const ids = Array.from({ length: 201 }, (_, i) => id(i + 1));
  renderWithProviders(<Probe ids={ids} />, (path, input) => {
    if (path !== 'entity.resolveRefs') return {};
    const batch = (input as { ids: string[] }).ids;
    return batch.includes(id(201)) ? pending : batch.map((i) => row(i));
  });
  await waitFor(() => expect(state().rows).toHaveLength(200));
  expect(state().pending).toEqual([id(201)]);
  await act(async () => {
    release(Promise.reject(new Error('network')));
  });
  await waitFor(() => expect(state().failed).toEqual([id(201)]));
  expect(state().rows).toHaveLength(200);
  expect(state().pending).toEqual([]);
});

test('stable byId на rerender; keychange resolves tail; failed refetch retains names; retry refreshes', async () => {
  let title = 'Старое';
  let reject = false;
  let latest: unknown;
  const { calls } = renderWithProviders(
    <Probe
      ids={[id(1)]}
      onMap={(map) => {
        latest = map;
      }}
    />,
    (path, input) => {
      if (path !== 'entity.resolveRefs') return {};
      if (reject) throw new Error('network');
      return (input as { ids: string[] }).ids.map((i) => row(i, title));
    },
  );
  await waitFor(() => expect(state().rows[0]?.title).toBe('Старое'));
  const before = latest;
  fireEvent.click(screen.getByRole('button', { name: 'Render' }));
  expect(latest).toBe(before);
  expect(calls).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'Добавить id' }));
  await waitFor(() => expect(state().rows).toHaveLength(2));
  expect(calls).toHaveLength(2);
  reject = true;
  fireEvent.click(screen.getByRole('button', { name: 'Повторить' }));
  await waitFor(() => expect(state().failed).toHaveLength(2));
  expect(state().rows.every((r: { title: string }) => r.title === 'Старое')).toBe(true);
  reject = false;
  title = 'Новое';
  fireEvent.click(screen.getByRole('button', { name: 'Повторить' }));
  await waitFor(() =>
    expect(state().rows.every((r: { title: string }) => r.title === 'Новое')).toBe(true),
  );
  expect(state().failed).toEqual([]);
});
