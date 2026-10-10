import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { expect, it, vi } from 'vitest';
import { renderWithProviders, wireEntity } from '../../test/harness';
import { LazyDetailContent } from './LazyDetailContent';
import { VersionsCardSlot } from './VersionsCardSlot';

it('versions activate only once, retain confirmation while inactive and reset it for another entity key', async () => {
  function Host() {
    const [active, setActive] = useState(false);
    const [id, setId] = useState('A');
    return (
      <>
        <button type="button" onClick={() => setActive((value) => !value)}>
          active
        </button>
        <button type="button" onClick={() => setId('B')}>
          address B
        </button>
        <VersionsCardSlot key={id} entity={wireEntity({ id, title: id })} active={active} />
      </>
    );
  }
  const { calls } = renderWithProviders(<Host />, (path, input) =>
    path === 'version.list'
      ? [
          {
            id: 'v1',
            entityId: (input as { entityId: string }).entityId,
            label: 'Snapshot',
            hasDoc: true,
            actorKind: 'owner',
            createdAt: '2026-10-11T00:00:00Z',
          },
        ]
      : {},
  );
  expect(calls.some((call) => call.path === 'version.list')).toBe(false);
  expect(screen.queryByTestId('versions-card')).toBeNull();
  fireEvent.click(screen.getByText('active'));
  fireEvent.click(await screen.findByRole('button', { name: 'Восстановить' }));
  expect(await screen.findByRole('dialog', { name: 'Восстановить это тело?' })).toBeVisible();
  fireEvent.click(screen.getByText('active'));
  expect(screen.getByRole('dialog', { name: 'Восстановить это тело?' })).toBeVisible();
  expect(calls.filter((call) => call.path === 'version.list')).toHaveLength(1);
  fireEvent.click(screen.getByText('address B'));
  expect(screen.queryByRole('dialog', { name: 'Восстановить это тело?' })).toBeNull();
  expect(calls.filter((call) => call.path === 'version.list')).toHaveLength(1);
  fireEvent.click(screen.getByText('active'));
  await waitFor(() => expect(calls.filter((call) => call.path === 'version.list')).toHaveLength(2));
  expect(calls.filter((call) => call.path === 'version.list').map((call) => call.input)).toEqual([
    { entityId: 'A' },
    { entityId: 'B' },
  ]);
});
function Content({ id, readOnly }: { id: string; readOnly: boolean }) {
  const [value, setValue] = useState('');
  return (
    <label>
      {id}
      <input disabled={readOnly} value={value} onChange={(event) => setValue(event.target.value)} />
    </label>
  );
}
it('failed load retries explicitly; latest props and id key reset local input without callback-reset', async () => {
  let release: (value: typeof Content) => void = () => {};
  const pending = new Promise<typeof Content>((resolve) => (release = resolve));
  const load = vi.fn().mockRejectedValueOnce(new Error('chunk')).mockReturnValueOnce(pending);
  const props = { load, loading: 'Loading', error: 'Failed', retry: 'Retry' };
  const view = render(
    <LazyDetailContent {...props} componentProps={{ id: 'A', readOnly: false }} contentKey="A" />,
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
  expect(load).toHaveBeenCalledTimes(2);
  view.rerender(
    <LazyDetailContent {...props} componentProps={{ id: 'B', readOnly: true }} contentKey="B" />,
  );
  release(Content);
  expect(await screen.findByLabelText('B')).toBeDisabled();
  expect(screen.queryByLabelText('A')).toBeNull();
  view.rerender(
    <LazyDetailContent {...props} componentProps={{ id: 'B', readOnly: false }} contentKey="B" />,
  );
  fireEvent.change(screen.getByLabelText('B'), { target: { value: 'draft' } });
  view.rerender(
    <LazyDetailContent {...props} componentProps={{ id: 'B', readOnly: false }} contentKey="B" />,
  );
  expect(screen.getByLabelText('B')).toHaveValue('draft');
  view.rerender(
    <LazyDetailContent {...props} componentProps={{ id: 'C', readOnly: false }} contentKey="C" />,
  );
  expect(screen.getByLabelText('C')).toHaveValue('');
  expect(load).toHaveBeenCalledTimes(2);
});
it('unmounted pending content never mounts after late resolution', async () => {
  let release: (value: typeof Content) => void = () => {};
  const gate = new Promise<typeof Content>((resolve) => (release = resolve));
  const loaded = vi.fn();
  const view = render(
    <LazyDetailContent
      load={() => gate}
      loading="Loading"
      error="Failed"
      retry="Retry"
      contentKey="A"
      componentProps={{ id: 'A', readOnly: false }}
    />,
  );
  view.unmount();
  release((props) => {
    loaded();
    return <Content {...props} />;
  });
  await waitFor(() => expect(loaded).not.toHaveBeenCalled());
});
