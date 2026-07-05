import { render, screen } from '@testing-library/react';
import { expect, test } from 'vitest';
import { App } from './App';

test('рендерит 4 таба, Agenda/Budget задизейблены', () => {
  render(<App />);
  expect(screen.getByTestId('tab-chat')).toBeEnabled();
  expect(screen.getByTestId('tab-browser')).toBeEnabled();
  expect(screen.getByTestId('tab-agenda')).toBeDisabled();
  expect(screen.getByTestId('tab-budget')).toBeDisabled();
});
