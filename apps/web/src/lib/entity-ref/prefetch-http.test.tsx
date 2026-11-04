import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { getQueryKey } from '@trpc/react-query';
import { expect, test, vi } from 'vitest';
import { detailGetInput } from '../../features/entity-detail/detail-input';
import { resetNavForTests } from '../../state/navigation';
import { makeTestFreshness } from '../../test/freshness';
import { makeQueryClient, makeTrpcClient, trpc } from '../../trpc';
import { RecordLink } from './RecordLink';

const first = '018cd857-511b-7f25-870e-377777ceca00';
const second = '018cd857-511b-7f25-870e-377777ceca01';
vi.mock('../../app/detail-screen-loader', () => ({
  loadDetailScreen: async () => null,
  warmDetailScreen: () => {},
}));

test('speculative HTTP cancellation leaves an ordinary batch alive and foreground adopts the new read', async () => {
  resetNavForTests();
  const requests: {
    url: string;
    signal?: AbortSignal | null;
    headers: Headers;
    reply: (r: Response) => void;
  }[] = [];
  vi.stubGlobal(
    'fetch',
    (url: string, options?: RequestInit) =>
      new Promise((resolve, reject) => {
        requests.push({
          url,
          signal: options?.signal,
          headers: new Headers(options?.headers),
          reply: resolve,
        });
        options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), {
          once: true,
        });
      }),
  );
  const queryClient = makeQueryClient();
  const { runtime } = makeTestFreshness(queryClient);
  const rpc = makeTrpcClient(() => 'mock-token');
  const ordinary = rpc.registry.effective.query().catch(() => {});
  const ui = render(
    <trpc.Provider client={rpc} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <RecordLink id={first}>First</RecordLink>
        <RecordLink id={second}>Second</RecordLink>
      </QueryClientProvider>
    </trpc.Provider>,
  );
  try {
    const a = screen.getByRole('link', { name: 'First' });
    const b = screen.getByRole('link', { name: 'Second' });
    fireEvent.focus(a);
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    const firstRequest = requests.find(({ url }) => url.includes(first));
    const unrelated = requests.find(({ url }) => url.includes('registry.effective'));
    expect(firstRequest?.url).not.toContain('registry.effective');
    expect(firstRequest?.headers.get('authorization')).toBe('Bearer mock-token');

    fireEvent.blur(a);
    fireEvent.focus(b);
    expect(firstRequest?.signal?.aborted).toBe(true);
    expect(unrelated?.signal?.aborted).toBe(false);
    await vi.waitFor(() => expect(requests).toHaveLength(3));
    const secondRequest = requests.find(({ url }) => url.includes(second));
    fireEvent.click(b);
    fireEvent.blur(b);
    expect(secondRequest?.signal?.aborted).toBe(false);
    secondRequest?.reply(
      new Response(
        JSON.stringify({ result: { data: { entity: { id: second }, relations: [] } } }),
        {
          headers: { 'content-type': 'application/json', 'x-orbis-read-watermark': '1' },
        },
      ),
    );
    const key = getQueryKey(trpc.entity.get, detailGetInput(second), 'query');
    const query = queryClient.getQueryCache().find({ queryKey: key });
    await vi.waitFor(() => expect(query?.state.status).toBe('success'));
    expect(runtime.publicationOf(query?.queryHash ?? '')).toMatchObject({
      source: 'network',
      receipt: { epoch: runtime.scope.epoch, watermark: '1' },
      raw: { entity: { id: second } },
    });
  } finally {
    ui.unmount();
    for (const request of requests)
      request.reply(new Response(JSON.stringify([{ result: { data: {} } }])));
    await ordinary;
    queryClient.clear();
    vi.unstubAllGlobals();
  }
});
