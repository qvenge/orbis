import type { FileInfo } from '@orbis/shared/files';
import { useCallback, useEffect, useRef, useState } from 'react';
import { captureProductRequest, trpc } from '../../trpc';
import {
  downloadFile,
  FileUnavailableError,
  fetchFileResource,
  fileAddress,
  previewableFile,
} from './transport';

export function FileContent({
  id: storedId,
  label,
  image = false,
}: {
  id: string;
  label?: string;
  image?: boolean;
}) {
  const id = storedId.toLowerCase();
  const query = trpc.files.describe.useQuery({ ids: [id] });
  const code = query.error?.data?.code;
  const unavailable = code === 'UNAUTHORIZED' || code === 'FORBIDDEN' || code === 'NOT_FOUND';
  const utils = trpc.useUtils();
  const forget = useCallback(() => utils.files.describe.setData({ ids: [id] }, []), [utils, id]);
  const cached = query.data?.find((file) => file.id === id);
  const info = unavailable ? undefined : cached;
  // A failed refetch retains the previous answer. Drop it on a confirmed refusal
  // so a later network failure or remount cannot show the revoked metadata again.
  useEffect(() => {
    if (unavailable && cached) forget();
  }, [unavailable, cached, forget]);
  const [preview, setPreview] = useState<{ id: string; url: string }>();
  const [failure, setFailure] = useState('');
  const [downloading, setDownloading] = useState(false);
  const lifetime = useRef(new AbortController());
  const readable = !!info;
  // biome-ignore lint/correctness/useExhaustiveDependencies: changing file or losing read access cancels its download.
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    setFailure('');
    setDownloading(false);
    return () => controller.abort();
  }, [id, readable]);
  useEffect(() => {
    if (!image || !info || !previewableFile(info.mediaType)) return;
    const stop = new AbortController();
    const scope = captureProductRequest(stop.signal);
    let url: string | undefined;
    function release() {
      if (url) URL.revokeObjectURL(url);
      url = undefined;
      setPreview(undefined);
    }
    scope.signal?.addEventListener('abort', release, { once: true });
    async function load(meta: FileInfo) {
      const response = await fetchFileResource(`/api/files/${meta.id}/content?mode=preview`, {
        signal: stop.signal,
      });
      if (response.headers.get('content-type')?.split(';')[0] !== meta.mediaType)
        throw Error('Неверный тип изображения');
      const blob = await response.blob();
      if (blob.size !== meta.byteSize) throw Error('Изображение загружено не полностью');
      if (stop.signal.aborted || !scope.isCurrent()) return;
      url = URL.createObjectURL(blob);
      setPreview({ id: meta.id, url });
    }
    void load(info).catch((e: Error) => {
      if (!stop.signal.aborted && scope.isCurrent()) {
        if (e instanceof FileUnavailableError) forget();
        setFailure(e.message);
      }
    });
    return () => {
      stop.abort();
      release();
    };
  }, [info, image, forget]);
  const name = label || info?.name || 'Файл';
  return (
    <span
      className="inline-flex max-w-full flex-col items-start gap-1 align-middle"
      contentEditable={false}
    >
      {info && preview?.id === id && (
        <img src={preview.url} alt={name} className="max-h-96 max-w-full object-contain" />
      )}
      <button
        type="button"
        title={info?.name}
        aria-label={`Скачать ${name}`}
        disabled={!info || downloading}
        className="max-w-full break-all text-left text-accent underline"
        onClick={async () => {
          if (!info) return;
          setDownloading(true);
          setFailure('');
          const signal = lifetime.current.signal;
          const scope = captureProductRequest(signal);
          try {
            await downloadFile(info, signal);
          } catch (e) {
            if (!signal.aborted && scope.isCurrent()) {
              if (e instanceof FileUnavailableError) forget();
              setFailure((e as Error).message);
            }
          } finally {
            if (!signal.aborted && scope.isCurrent()) setDownloading(false);
          }
        }}
      >
        {name}
      </button>
      <button
        type="button"
        className="text-xs text-text-secondary"
        disabled={!info}
        onClick={() => {
          const address = fileAddress(id);
          if (!navigator.clipboard) {
            setFailure(address);
            return;
          }
          void navigator.clipboard.writeText(address).catch(() => setFailure(address));
        }}
      >
        Скопировать ссылку на файл
      </button>
      {(failure || query.isError || (query.data && !info)) && (
        <span role="alert">{failure || 'Файл недоступен'}</span>
      )}
    </span>
  );
}
