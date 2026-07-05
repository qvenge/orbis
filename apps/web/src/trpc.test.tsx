import { screen, waitFor } from '@testing-library/react';
import { expect, test } from 'vitest';
import { renderWithProviders } from './test/harness';
import { trpc, trpcHeaders } from './trpc';

function PingProbe() {
  const q = trpc.ping.useQuery();
  return <div data-testid="ping">{q.data ? 'ok' : 'loading'}</div>;
}

test('trpc.ping.useQuery резолвит против мок-линка', async () => {
  renderWithProviders(<PingProbe />, (path) => {
    if (path === 'ping') return { ok: true };
    throw new Error(`unexpected path ${path}`);
  });
  expect(screen.getByTestId('ping')).toHaveTextContent('loading');
  await waitFor(() => expect(screen.getByTestId('ping')).toHaveTextContent('ok'));
});

test('trpcHeaders всегда несёт версию, а Bearer только при наличии токена', () => {
  expect(trpcHeaders(() => null)).toEqual({ 'x-orbis-client-version': '0.1.0' });
  expect(trpcHeaders(() => 'abc')).toEqual({
    authorization: 'Bearer abc',
    'x-orbis-client-version': '0.1.0',
  });
});
