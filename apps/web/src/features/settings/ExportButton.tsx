import { useEffect, useRef, useState } from 'react';
import { fetchFileResource } from '../../lib/files/transport';
import { captureProductRequest, trpc } from '../../trpc';
import { Button } from '../../ui/Button';

export function ExportButton() {
  const utils = trpc.useUtils();
  const request = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => () => request.current?.abort(), []);

  async function download(format: 'zip' | 'json') {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    const scope = captureProductRequest(controller.signal);
    setBusy(true);
    setError('');
    try {
      const blob =
        format === 'zip'
          ? await (
              await fetchFileResource('/api/exports/graph-package', {
                method: 'POST',
                signal: controller.signal,
              })
            ).blob()
          : new Blob(
              [
                JSON.stringify(
                  await utils.user.exportData.fetch(undefined, { staleTime: 0 }),
                  null,
                  2,
                ),
              ],
              { type: 'application/json' },
            );
      if (!scope.isCurrent() || controller.signal.aborted) return;
      const url = URL.createObjectURL(blob);
      try {
        const link = document.createElement('a');
        link.href = url;
        link.download = `orbis-export-${new Date().toISOString().slice(0, 10)}.${format}`;
        link.click();
      } finally {
        URL.revokeObjectURL(url);
      }
    } catch (err) {
      if (scope.isCurrent() && !controller.signal.aborted)
        setError(err instanceof Error ? err.message : 'Не удалось подготовить экспорт.');
    } finally {
      request.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2" aria-busy={busy}>
      <Button variant="primary" disabled={busy} onClick={() => download('zip')}>
        Скачать полный пакет ZIP
      </Button>
      <Button disabled={busy} onClick={() => download('json')}>
        Скачать JSON v3
      </Button>
      {busy && <span role="status">Подготовка экспорта…</span>}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
