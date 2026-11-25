import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { configureProductToken } from '../../auth/AuthProvider';
import { renderWithProviders, trpcError } from '../../test/harness';
import { configureProductTransport } from '../../trpc';
import { FileContent } from './FileContent';

test('превью использует проверенный тип, bearer без cookies и освобождает object URL', async () => {
  configureProductToken(() => 'fixture-owner');
  const info = {
    id: crypto.randomUUID(),
    name: 'План',
    mediaType: 'image/png',
    byteSize: 3,
    sha256: 'a'.repeat(64),
  };
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_, init) => {
    expect(init?.credentials).toBe('omit');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer fixture-owner');
    return new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': info.mediaType } });
  });
  const create = vi.fn(() => 'blob:verified-preview');
  const release = vi.fn();
  const NativeURL = URL;
  vi.stubGlobal(
    'URL',
    class extends NativeURL {
      static override createObjectURL = create;
      static override revokeObjectURL = release;
    },
  );
  try {
    const view = renderWithProviders(<FileContent id={info.id.toUpperCase()} image />, () => [
      info,
    ]);
    expect(await screen.findByRole('img', { name: info.name }, { timeout: 5000 })).toHaveAttribute(
      'src',
      'blob:verified-preview',
    );
    view.unmount();
    expect(release).toHaveBeenCalledWith('blob:verified-preview');
    expect(create).toHaveBeenCalledTimes(1);
  } finally {
    vi.unstubAllGlobals();
    fetcher.mockRestore();
    configureProductToken(() => null);
  }
});
test.each([
  'UNAUTHORIZED',
  'FORBIDDEN',
  'download',
  'identity',
])('сохраняет превью при сбое сети и освобождает при недоступности: %s', async (reason) => {
  const info = {
    id: crypto.randomUUID(),
    name: 'Частный файл',
    mediaType: 'image/png',
    byteSize: 1,
    sha256: 'b'.repeat(64),
  };
  const lifetime = new AbortController();
  configureProductToken(() => 'fixture-owner');
  configureProductTransport(() => ({
    signal: lifetime.signal,
    isCurrent: () => !lifetime.signal.aborted,
  }));
  const fetcher = vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async (url) =>
      String(url).includes('mode=download')
        ? new Response('{}', { status: 403 })
        : new Response(new Uint8Array([1]), { headers: { 'Content-Type': info.mediaType } }),
    );
  const release = vi.fn();
  const NativeURL = URL;
  vi.stubGlobal(
    'URL',
    class extends NativeURL {
      static override createObjectURL = () => 'blob:cached-preview';
      static override revokeObjectURL = release;
    },
  );
  let error: Error | undefined;
  try {
    const view = renderWithProviders(
      <FileContent id={info.id} image />,
      () => {
        if (error) throw error;
        return [info];
      },
      { queries: { retry: false } },
    );
    await screen.findByRole('img', { name: info.name });
    error = new Error('network offline');
    await act(async () => {
      await view.queryClient.refetchQueries();
    });
    expect(screen.getByRole('img', { name: info.name })).toBeInTheDocument();
    expect(release).not.toHaveBeenCalled();
    if (reason === 'identity') {
      // The session boundary clears its query client and aborts the outgoing graph lease.
      act(() => {
        lifetime.abort();
        view.queryClient.clear();
      });
    } else if (reason === 'download') {
      fireEvent.click(screen.getByRole('button', { name: `Скачать ${info.name}` }));
    } else {
      error = trpcError(reason);
      await act(async () => {
        await view.queryClient.refetchQueries();
      });
    }
    await waitFor(() => expect(release).toHaveBeenCalledWith('blob:cached-preview'));
    expect(screen.queryByRole('img')).toBeNull();
    if (reason !== 'identity') {
      error = new Error('offline after refusal');
      await act(async () => {
        await view.queryClient.refetchQueries();
      });
      expect(screen.getByRole('button', { name: 'Скачать Файл' })).toBeDisabled();
      expect(screen.queryByText(info.name)).toBeNull();
    }
  } finally {
    configureProductTransport();
    configureProductToken(() => null);
    vi.unstubAllGlobals();
    fetcher.mockRestore();
  }
});
test('SVG выводится только для скачивания даже при запросе показа изображения', async () => {
  const info = {
    id: crypto.randomUUID(),
    name: 'SVG',
    mediaType: 'image/svg+xml',
    byteSize: 0,
    sha256: 'a'.repeat(64),
  };
  const fetcher = vi.spyOn(globalThis, 'fetch');
  try {
    renderWithProviders(<FileContent id={info.id} image />, () => [info]);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Скачать SVG' })).toBeEnabled(), {
      timeout: 5000,
    });
    expect(screen.queryByRole('img')).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  } finally {
    fetcher.mockRestore();
  }
});
