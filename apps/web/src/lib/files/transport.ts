import {
  type FileInfo,
  type FileLimits,
  fileInfoSchema,
  type UploadBeginInput,
  type UploadStatus,
  uploadStatusSchema,
} from '@orbis/shared/files';
import { getCurrentToken } from '../../auth/AuthProvider';
import { API_BASE, captureProductRequest, trpcHeaders } from '../../trpc';
import { orbisErrorOf } from '../orbis-error';

export async function fetchFileResource(path: string, init: RequestInit): Promise<Response> {
  if (!path.startsWith('/api/')) throw new Error('Неверный адрес файла');
  const scope = captureProductRequest(init.signal);
  if (!scope.isCurrent() || !getCurrentToken())
    throw new Error('Для доступа к файлу войдите в Orbis');
  const headers = new Headers(init.headers);
  for (const [name, value] of Object.entries(trpcHeaders(getCurrentToken)))
    headers.set(name, value);
  const response = await fetch(API_BASE + path, {
    ...init,
    headers,
    credentials: 'omit',
    cache: 'no-store',
    redirect: 'error',
    signal: scope.signal,
  });
  if (!scope.isCurrent()) {
    void response.body?.cancel();
    throw new Error('Сессия изменилась');
  }
  if (!response.ok) {
    const detail = await response.json().catch(() => null);
    throw new Error(
      typeof detail?.error === 'string'
        ? detail.error
        : `Не удалось получить файл (${response.status})`,
    );
  }
  return response;
}

type TransferApi = {
  begin(input: UploadBeginInput): Promise<UploadStatus>;
  finish(input: { uploadId: string }): Promise<FileInfo>;
};
export async function uploadFile(
  api: TransferApi,
  file: File,
  uploadId: string,
  limits: FileLimits,
  signal: AbortSignal,
  progress: (offset: number) => void,
): Promise<FileInfo> {
  if (file.size > limits.maxFileBytes)
    throw new Error(`Файл превышает предел ${limits.maxFileBytes} байт`);
  const scope = captureProductRequest(signal);
  signal.throwIfAborted();
  if (!navigator.onLine) throw new Error('Для загрузки файла нужно подключение к сети');
  const session = await api.begin({
    uploadId,
    name: file.name,
    byteSize: file.size,
    ...(file.type && { mediaType: file.type }),
  });
  if (session.state === 'expired' || session.state === 'failed')
    throw new Error('Срок загрузки истёк. Выберите файл снова');
  if (
    session.uploadId !== uploadId ||
    session.nextOffset > file.size ||
    session.chunkBytes < 1 ||
    session.chunkBytes > limits.webChunkBytes
  )
    throw new Error('Неверные параметры загрузки');
  let offset = session.nextOffset;
  progress(offset);
  while (offset < file.size && session.state === 'open') {
    signal.throwIfAborted();
    const end = Math.min(file.size, offset + session.chunkBytes);
    const response = await fetchFileResource(`/api/file-uploads/${uploadId}/parts/${offset}`, {
      method: 'PUT',
      body: file.slice(offset, end),
      signal,
    });
    const next = uploadStatusSchema.parse(await response.json());
    if (
      next.uploadId !== uploadId ||
      next.fileId !== session.fileId ||
      next.nextOffset < end ||
      next.nextOffset > file.size
    )
      throw new Error('Не подтверждено смещение загруженной части');
    offset = next.nextOffset;
    progress(offset);
  }
  function requireSession() {
    signal.throwIfAborted();
    scope.signal?.throwIfAborted();
    if (!scope.isCurrent()) throw new Error('Сессия изменилась');
  }
  // Each pending response follows a bounded server wait. Keep the same
  // operation ID across waits and allow manual resumption after half an hour.
  const deadline = Math.min(Date.parse(session.expiresAt), Date.now() + 30 * 60_000);
  for (let attempt = 1; ; attempt++) {
    requireSession();
    try {
      const info = fileInfoSchema.parse(await api.finish({ uploadId }));
      if (info.id !== session.fileId || info.byteSize !== file.size)
        throw new Error('Не подтверждён загруженный оригинал');
      requireSession();
      return info;
    } catch (error) {
      requireSession();
      const detail = orbisErrorOf(error);
      if (
        detail?.code !== 'CONFLICT' ||
        detail.details?.reason !== 'upload_finishing' ||
        detail.details.state !== 'finishing' ||
        attempt >= 45 ||
        Date.now() >= deadline
      )
        throw error;
    }
  }
}

export const previewableFile = (mediaType: string) =>
  ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(mediaType);
export const fileAddress = (id: string) => `orbis-file:${id}`;
export function idFromFileAddress(text: string): string | null {
  const m = /^orbis-file:([\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12})$/i.exec(text.trim());
  return m?.[1]?.toLowerCase() ?? null;
}
export async function downloadFile(info: FileInfo, signal: AbortSignal) {
  const scope = captureProductRequest(signal);
  const response = await fetchFileResource(`/api/files/${info.id}/content?mode=download`, {
    signal: scope.signal,
  });
  const blob = await response.blob();
  signal.throwIfAborted();
  if (!scope.isCurrent()) throw new Error('Сессия изменилась');
  if (blob.size !== info.byteSize) throw new Error('Оригинал скачан не полностью');
  const url = URL.createObjectURL(blob);
  try {
    const link = document.createElement('a');
    link.href = url;
    link.download = info.name;
    link.click();
  } finally {
    URL.revokeObjectURL(url);
  }
}
