import { render, screen } from '@testing-library/react';
import { App } from './App';

test('рендерит оболочку Orbis', () => {
  render(<App />);
  expect(screen.getByText('Orbis')).toBeInTheDocument();
});
