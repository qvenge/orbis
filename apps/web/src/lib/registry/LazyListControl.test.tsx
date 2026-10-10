import { act, fireEvent, render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { field } from '../../features/entity-detail/properties-relations/test-fixtures';
import { LazyListControl, type ListControlProps } from './LazyListControl';
import { ScalarListControl } from './ScalarListControl';

const definition = field({ kind: 'text', cardinality: 'many' });
test('delayed successful load uses the latest controlled value/callback/disabled state', async () => {
  let ready: (component: typeof ScalarListControl) => void = () => {};
  const load = vi.fn(() => new Promise<typeof ScalarListControl>((resolve) => (ready = resolve)));
  const old = vi.fn();
  const current = vi.fn();
  const props: ListControlProps = { def: definition, value: ['old'], onChange: old };
  const { rerender } = render(<LazyListControl load={load} {...props} />);
  expect(screen.getByRole('status')).toHaveTextContent('Поле теста');
  rerender(
    <LazyListControl load={load} {...props} value={['latest']} onChange={current} disabled />,
  );
  await act(async () => ready(ScalarListControl));
  expect(screen.getByRole('textbox')).toHaveValue('latest');
  expect(screen.getByRole('textbox')).toBeDisabled();
  for (const button of screen.getAllByRole('button')) expect(button).toBeDisabled();
  rerender(<LazyListControl load={load} {...props} value={['latest']} onChange={current} />);
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'new raw' } });
  expect(current).toHaveBeenCalledExactlyOnceWith(['new raw']);
  expect(old).not.toHaveBeenCalled();
  expect(load).toHaveBeenCalledTimes(1);
});

test('failure exposes one explicit retry; rejection is not reused and unmounted resolution is ignored', async () => {
  let ready: (component: typeof ScalarListControl) => void = () => {};
  const load = vi
    .fn()
    .mockRejectedValueOnce(new Error('network'))
    .mockImplementationOnce(
      () => new Promise<typeof ScalarListControl>((resolve) => (ready = resolve)),
    );
  const onChange = vi.fn();
  const { unmount } = render(
    <LazyListControl load={load} def={definition} value={['raw']} onChange={onChange} />,
  );
  const retry = await screen.findByRole('button', { name: /^Повторить загрузку редактора:/ });
  expect(load).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('alert')).toHaveTextContent(definition.key);
  fireEvent.click(retry);
  expect(load).toHaveBeenCalledTimes(2);
  expect(screen.getByRole('status')).toBeVisible();
  unmount();
  await act(async () => ready(ScalarListControl));
  expect(screen.queryByRole('textbox')).toBeNull();
  expect(onChange).not.toHaveBeenCalled();
});
