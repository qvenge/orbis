import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import { installCrashTrap, renderWithProviders } from '../../test/harness';
import { navAt } from '../../test/nav';
import { canRedoStep } from '../entity-editor/arrows-stack';
import { SUPPLY_RECORDS_QUERY } from '../page/useSupplyRecords';
import { DetailScreen } from './DetailScreen';
import { hostTemplateRecord, STRUCTURE_FIXTURES, structureHandler } from './structure-fixtures';

installCrashTrap();
afterEach(() => vi.unstubAllGlobals());
const fixture = STRUCTURE_FIXTURES.find((f) => f.name === 'ticket');
if (!fixture) throw new Error('нет ticket fixture');
const f = fixture;
for (const bodyOnly of [false, true])
  test(`реальный экран: одна desktop пара стрелок ${bodyOnly ? 'у body без title' : 'у title'}`, async () => {
    navAt(f.entity.id);
    const base = structureHandler(f);
    renderWithProviders(<DetailScreen entityId={f.entity.id} />, (path, input) => {
      if (
        bodyOnly &&
        path === 'entity.query' &&
        (input as { query?: string }).query === SUPPLY_RECORDS_QUERY
      )
        return [hostTemplateRecord('{{body}}')];
      return base(path, input);
    });
    // Cold leaf может компилироваться одновременно с другими workers; это не latency pin.
    await screen.findByRole('button', { name: 'Шаг назад' }, { timeout: 5000 });
    await waitFor(() =>
      expect(screen.getAllByRole('button', { name: 'Шаг назад' })).toHaveLength(1),
    );
    expect(screen.getAllByRole('button', { name: 'Шаг вперёд' })).toHaveLength(1);
    expect(screen.queryByTestId('title-edit') !== null).toBe(!bodyOnly);
    expect(screen.queryByTestId('keyboard-bar')).toBeNull();
  });

test('coarse actual screen: touch pointer order сохраняет фокус title и выполняет undo; blur/viewport обновляют панель', async () => {
  const viewport = Object.assign(new EventTarget(), { height: 450, offsetTop: 30 });
  vi.stubGlobal('visualViewport', viewport);
  vi.stubGlobal('innerHeight', 800);
  vi.stubGlobal('matchMedia', (query: string) =>
    Object.assign(new EventTarget(), {
      matches: query === '(pointer: coarse)',
      media: query,
      addListener: () => {},
      removeListener: () => {},
    }),
  );
  navAt(f.entity.id);
  renderWithProviders(
    <>
      <DetailScreen entityId={f.entity.id} />
      <input data-testid="outside" />
    </>,
    structureHandler(f),
  );
  const field = await screen.findByTestId('title-edit');
  expect(screen.queryByTestId('keyboard-bar')).toBeNull();
  act(() => field.focus());
  await screen.findByTestId('keyboard-bar');
  fireEvent.change(field, { target: { value: `${f.entity.title} новое` } });
  const back = screen.getByRole('button', { name: 'Шаг назад' });
  expect(back).toBeEnabled();
  await userEvent.pointer([
    { keys: '[TouchA>]', target: back },
    { keys: '[/TouchA]', target: back },
  ]);
  expect(field).toHaveFocus();
  expect(field).toHaveValue(f.entity.title);
  expect(canRedoStep(f.entity.id)).toBe(true);
  viewport.height = 500;
  act(() => viewport.dispatchEvent(new Event('resize')));
  expect(screen.getByTestId('keyboard-bar')).toHaveStyle({ bottom: '270px' });
  act(() => screen.getByTestId('outside').focus());
  expect(screen.queryByTestId('keyboard-bar')).toBeNull();
});
