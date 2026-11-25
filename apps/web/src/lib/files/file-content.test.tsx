import { screen, waitFor } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { configureProductToken } from '../../auth/AuthProvider';
import { renderWithProviders } from '../../test/harness';
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
