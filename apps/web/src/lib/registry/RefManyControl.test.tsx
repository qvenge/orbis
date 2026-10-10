import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { expect, test, vi } from 'vitest';
import { field } from '../../features/entity-detail/properties-relations/test-fixtures';
import { renderWithProviders, wireEntity } from '../../test/harness';
import { PropertyControl } from './PropertyControl';
import { RefManyControl } from './RefManyControl';

const old = '00000000-0000-4000-8000-000000000001';
const next = '00000000-0000-4000-8000-000000000002';
const missing = '00000000-0000-4000-8000-000000000003';
const definition = field({ kind: 'ref', cardinality: 'many' });
const resolved = {
  id: old,
  title: 'Старое в архиве',
  emoji: null,
  archived: true,
  completable: null,
};

test.each([
  'unavailable',
  'failed',
  'same title',
])('two %s selected references have distinct addressed remove names and preserve exact removal', async (state) => {
  const onChange = vi.fn();
  renderWithProviders(
    <RefManyControl def={definition} value={[old, missing]} onChange={onChange} />,
    (path) => {
      if (path !== 'entity.resolveRefs') return [];
      if (state === 'failed') throw new Error('network');
      return state === 'unavailable' ? [] : [resolved, { ...resolved, id: missing }];
    },
  );
  await waitFor(() => expect(screen.queryByText('Загрузка…')).toBeNull());
  const remove = screen.getAllByRole('button', { name: /^Убрать:/ });
  expect(new Set(remove.map((button) => button.getAttribute('aria-label'))).size).toBe(2);
  expect(remove[0]?.getAttribute('aria-label')).toContain(old);
  expect(remove[1]?.getAttribute('aria-label')).toContain(missing);
  if (state !== 'same title') {
    expect(screen.getByText(old)).toBeVisible();
    expect(screen.getByText(missing)).toBeVisible();
  } else expect(screen.getAllByText('в архиве')).toHaveLength(2);
  fireEvent.click(remove[1] as HTMLButtonElement);
  expect(onChange).toHaveBeenCalledExactlyOnceWith([old]);
});

test('архив/недоступные/51 выбранная остаются, add полный массив без очистки/self rule', async () => {
  const onChange = vi.fn();
  const ids = [
    old,
    missing,
    ...Array.from(
      { length: 50 },
      (_, i) => `00000000-0000-4000-8000-${String(i + 10).padStart(12, '0')}`,
    ),
  ];
  renderWithProviders(
    <RefManyControl def={definition} value={ids} onChange={onChange} />,
    (path) =>
      path === 'entity.resolveRefs'
        ? [resolved]
        : path === 'entity.query'
          ? [wireEntity({ id: next, title: 'Сама запись' })]
          : {},
  );
  await screen.findByText('Старое в архиве');
  expect(screen.getByText('в архиве')).toBeInTheDocument();
  await waitFor(() => expect(screen.getAllByTestId('ref-many-row')).toHaveLength(52));
  expect(screen.getAllByText('Недоступная ссылка')).toHaveLength(51);
  expect(onChange).not.toHaveBeenCalled();
  fireEvent.click(await screen.findByRole('button', { name: 'Добавить: Сама запись' }));
  expect(onChange).toHaveBeenCalledExactlyOnceWith([...ids, next]);
  fireEvent.click(screen.getByRole('button', { name: `Убрать: Старое в архиве (${old})` }));
  expect(onChange).toHaveBeenLastCalledWith(ids.slice(1));
});

test('max, disabled и selected exclude запрещают add, серверные read errors не мутируют value', async () => {
  const onChange = vi.fn();
  const def = field({ kind: 'ref', cardinality: 'many', max: 1 });
  const first = renderWithProviders(
    <RefManyControl def={def} value={[old]} onChange={onChange} />,
    (path) => {
      if (path === 'entity.resolveRefs') throw new Error('network');
      return [];
    },
  );
  await screen.findByText('Не удалось прочитать ссылку');
  expect(screen.getByText('Предел ссылок: 1')).toBeInTheDocument();
  expect(screen.getByRole('searchbox')).toBeDisabled();
  expect(onChange).not.toHaveBeenCalled();
  first.unmount();
  const disabled = renderWithProviders(
    <RefManyControl def={definition} value={[old]} onChange={onChange} disabled />,
    (path) => (path === 'entity.resolveRefs' ? [resolved] : []),
  );
  expect(screen.getByRole('searchbox')).toBeDisabled();
  expect(screen.getByRole('button', { name: /Убрать:/ })).toBeDisabled();
  disabled.unmount();
  renderWithProviders(
    <RefManyControl def={definition} value={[old]} onChange={onChange} />,
    (path) =>
      path === 'entity.resolveRefs'
        ? [resolved]
        : [wireEntity({ id: old, title: 'Выбранное' }), wireEntity({ id: next, title: 'Новое' })],
  );
  await screen.findByRole('button', { name: 'Добавить: Новое' });
  expect(screen.queryByRole('button', { name: 'Добавить: Выбранное' })).toBeNull();
});

test('ошибка поиска отличается от empty; raw20 показывает more даже после exclude; keyboard add сохраняет draft', async () => {
  const user = userEvent.setup();
  let failed = true;
  function Wrapper() {
    const [value, onChange] = useState<string[]>([old]);
    return (
      <>
        <RefManyControl def={definition} value={value} onChange={onChange} />
        <output data-testid="value">{JSON.stringify(value)}</output>
      </>
    );
  }
  renderWithProviders(<Wrapper />, (path) => {
    if (path === 'entity.resolveRefs') return [resolved];
    if (path === 'entity.query') {
      if (failed) throw new Error('network');
      return Array.from({ length: 20 }, (_, i) =>
        wireEntity({
          id: i === 0 ? old : `00000000-0000-4000-8000-${String(i + 2).padStart(12, '0')}`,
          title: `Найдено ${i}`,
        }),
      );
    }
    return {};
  });
  await screen.findByText('Не удалось найти записи');
  expect(screen.queryByText('Ничего не найдено')).toBeNull();
  expect(screen.getByTestId('value')).toHaveTextContent(old);
  failed = false;
  await user.click(screen.getByRole('button', { name: 'Повторить поиск' }));
  await screen.findByText('Возможно, есть ещё — уточните поиск');
  const pick = screen.getByRole('button', { name: 'Добавить: Найдено 1' });
  pick.focus();
  await user.keyboard('{Enter}');
  expect(JSON.parse(screen.getByTestId('value').textContent ?? '[]')).toEqual([old, missing]);
  // No successful-save signal changes this controlled value: it remains available for retry.
});

test('PropertyControl generic many opt-in сохраняет self, legacy без draft остаётся readonly', async () => {
  const legacy = vi.fn();
  const draft = vi.fn();
  const first = renderWithProviders(
    <PropertyControl def={definition} value={[old]} onChange={legacy} />,
  );
  expect(screen.queryByRole('searchbox')).toBeNull();
  expect(screen.getByTestId(`prop-${definition.id}`)).toHaveAttribute('data-kind', 'readonly');
  first.unmount();
  renderWithProviders(
    <PropertyControl
      def={definition}
      value={[old]}
      onChange={legacy}
      selfId={next}
      draft={{ state: { kind: 'value', value: [old] }, onChange: draft }}
    />,
    (path) =>
      path === 'entity.resolveRefs'
        ? [resolved]
        : path === 'entity.query'
          ? [wireEntity({ id: next, title: 'Самоссылка' })]
          : {},
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Добавить: Самоссылка' }));
  expect(draft).toHaveBeenCalledExactlyOnceWith({ kind: 'value', value: [old, next] });
  expect(legacy).not.toHaveBeenCalled();
});
