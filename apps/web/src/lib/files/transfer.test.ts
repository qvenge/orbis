import { TRPCClientError } from '@trpc/client';
import { expect, test, vi } from 'vitest';
import { configureProductToken } from '../../auth/AuthProvider';
import { fetchFileResource, uploadFile } from './transport';

test('загрузка продолжает с подтвержденного смещения, читает порциями и отправляет bearer без cookies', async () => {
  configureProductToken(() => 'owner-token');
  const uploadId = crypto.randomUUID(),
    fileId = crypto.randomUUID();
  const file = new File(['0123456789'], 'Смета.pdf', { type: 'application/pdf' });
  const offsets: number[] = [];
  const status = {
    uploadId,
    fileId,
    nextOffset: 2,
    chunkBytes: 3,
    state: 'open' as const,
    expiresAt: new Date().toISOString(),
  };
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const offset = Number(String(url).split('/').at(-1));
    offsets.push(offset);
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer owner-token');
    expect(new Headers(init?.headers).has('x-orbis-client-version')).toBe(true);
    expect(init).toMatchObject({ credentials: 'omit', cache: 'no-store', method: 'PUT' });
    const chunk = init?.body as Blob;
    return Response.json({ ...status, nextOffset: offset + chunk.size });
  });
  const meta = {
    id: fileId,
    name: file.name,
    mediaType: file.type,
    byteSize: 10,
    sha256: '1'.repeat(64),
  };
  try {
    const api = { begin: vi.fn(async () => status), finish: vi.fn(async () => meta) };
    const info = await uploadFile(
      api,
      file,
      uploadId,
      { maxFileBytes: 10, maxFiles: 50, webChunkBytes: 3, mcpChunkBytes: 3 },
      new AbortController().signal,
      () => {},
    );
    expect(info).toEqual(meta);
    expect(offsets).toEqual([2, 5, 8]);
    expect(api.begin.mock.calls).toHaveLength(1);
  } finally {
    fetcher.mockRestore();
    configureProductToken(() => null);
  }
});

test('бинарное чтение требует действующий bearer', async () => {
  configureProductToken(() => null);
  const fetcher = vi.spyOn(globalThis, 'fetch');
  try {
    await expect(fetchFileResource('/api/files/x/content', {})).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  } finally {
    fetcher.mockRestore();
  }
});

test('повторяет только явно продолжающуюся сборку с прежним uploadId и прекращает ожидание при отмене или смене графа', async () => {
  const { configureProductTransport } = await import('../../trpc');
  const file = new File(['a'], 'a.txt');
  const uploadId = crypto.randomUUID(),
    fileId = crypto.randomUUID();
  const meta = {
    id: fileId,
    name: file.name,
    byteSize: 1,
    mediaType: 'text/plain',
    sha256: 'a'.repeat(64),
  };
  const status = {
    uploadId,
    fileId,
    nextOffset: 1,
    chunkBytes: 3,
    state: 'finishing' as const,
    expiresAt: new Date(Date.now() + 60000).toISOString(),
  };
  const pending = TRPCClientError.from({
    error: {
      code: -32009,
      message: 'Сборка продолжается.',
      data: {
        orbis: { code: 'CONFLICT', details: { reason: 'upload_finishing', state: 'finishing' } },
      },
    },
  });
  const limits = { maxFileBytes: 4, maxFiles: 50, webChunkBytes: 3, mcpChunkBytes: 3 };
  let controller = new AbortController(),
    current = true;
  configureProductTransport(() => ({ signal: controller.signal, isCurrent: () => current }));
  const begin = vi.fn(async () => status),
    finish = vi.fn(async (_input: { uploadId: string }) => meta);
  const run = () =>
    uploadFile({ begin, finish }, file, uploadId, limits, controller.signal, () => {});
  try {
    finish.mockRejectedValueOnce(pending);
    expect(await run()).toEqual(meta);
    expect(finish.mock.calls).toEqual([[{ uploadId }], [{ uploadId }]]);
    finish.mockClear();
    const failure = new Error('сбой Storage');
    finish.mockRejectedValueOnce(failure);
    await expect(run()).rejects.toBe(failure);
    expect(finish).toHaveBeenCalledTimes(1);
    finish.mockClear();
    finish.mockImplementationOnce(async () => {
      controller.abort();
      throw pending;
    });
    await expect(run()).rejects.toThrow();
    expect(finish).toHaveBeenCalledTimes(1);
    controller = new AbortController();
    finish.mockClear();
    finish.mockImplementationOnce(async () => {
      current = false;
      throw pending;
    });
    await expect(run()).rejects.toThrow();
    expect(finish).toHaveBeenCalledTimes(1);
    current = true;
    finish.mockClear();
    finish.mockRejectedValue(pending);
    await expect(run()).rejects.toBe(pending);
    expect(finish.mock.calls.length).toBeGreaterThan(1);
    expect(finish.mock.calls.length).toBeLessThan(100);
  } finally {
    configureProductTransport();
  }
});
