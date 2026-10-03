import { act, fireEvent, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { renderWithProviders } from '../../test/harness';
import { bindStepOwner, pushStep } from '../entity-editor/arrows-stack';
import { UndoArrows } from './UndoArrows';

afterEach(() => vi.unstubAllGlobals());
test('кнопки общего стека не уводят фокус и отражают undo/redo', () => {
  const title = { undo: () => true, redo: () => true, reset: () => {} };
  bindStepOwner('e1', 'title', title);
  renderWithProviders(
    <>
      <input data-testid="title-edit" data-step-record="e1" />
      <UndoArrows entityId="e1" variant="inline" />
    </>,
  );
  const back = screen.getByRole('button', { name: 'Шаг назад' }),
    forward = screen.getByRole('button', { name: 'Шаг вперёд' });
  expect(back).toBeDisabled();
  act(() => pushStep('e1', 'title'));
  const input = screen.getByTestId('title-edit');
  input.focus();
  fireEvent.mouseDown(back);
  fireEvent.click(back);
  expect(input).toHaveFocus();
  expect(back).toBeDisabled();
  expect(forward).toBeEnabled();
});
test('панель только при фокусе поля и над visualViewport; resize и blur обновляют её', () => {
  const viewport = Object.assign(new EventTarget(), { height: 400, offsetTop: 50 });
  vi.stubGlobal('visualViewport', viewport);
  vi.stubGlobal('innerHeight', 800);
  renderWithProviders(
    <>
      <input data-testid="title-edit" data-step-record="e1" />
      <input data-testid="outside" />
      <UndoArrows entityId="e1" variant="keyboard" />
    </>,
  );
  expect(screen.queryByTestId('keyboard-bar')).toBeNull();
  act(() => screen.getByTestId('title-edit').focus());
  expect(screen.getByTestId('keyboard-bar')).toHaveStyle({ bottom: '350px' });
  viewport.height = 500;
  act(() => viewport.dispatchEvent(new Event('resize')));
  expect(screen.getByTestId('keyboard-bar')).toHaveStyle({ bottom: '250px' });
  act(() => screen.getByTestId('outside').focus());
  expect(screen.queryByTestId('keyboard-bar')).toBeNull();
});
