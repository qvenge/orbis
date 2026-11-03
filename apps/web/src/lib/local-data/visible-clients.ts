export type CountChallenge = { nonce: string; ownerTag?: string };
export type CountResponse = { count: number; version: string };
export type PurgeChallenge = { reason: 'shared-on' | 'logout'; generation: string };
type WorkerReport = { ready: boolean; counts?: CountResponse[] };

/** Only a census of currently enumerable documents, not evidence for the legacy cutover. */
export function installVisibleClientResponse(
  count: (challenge: CountChallenge) => Promise<CountResponse>,
  purge: (challenge: PurgeChallenge) => boolean,
): void {
  navigator.serviceWorker?.addEventListener('message', (event) => {
    const port = event.ports[0];
    if (!port || event.data?.type !== 'orbis-local-data-challenge') return;
    const challenge = event.data.count;
    const wipe = event.data.purge;
    if (challenge)
      void count(challenge)
        .then((report) => port.postMessage({ protocol: 1, ...report }))
        .catch(() => {});
    else port.postMessage({ protocol: 1, ...(wipe && { purged: purge(wipe) }) });
  });
}

export function visibleClientsReport(
  count?: CountChallenge,
  purge?: PurgeChallenge,
): Promise<WorkerReport> {
  const worker = navigator.serviceWorker?.controller;
  if (!worker) return Promise.resolve({ ready: false });
  return new Promise((resolve) => {
    const request = new MessageChannel();
    const finish = (report: WorkerReport) => {
      clearTimeout(timer);
      request.port1.close();
      resolve(report);
    };
    const failed = { ready: false };
    const timer = setTimeout(() => finish(failed), 1700);
    request.port1.onmessage = ({ data }) => {
      if (data?.protocol !== 1) finish(failed);
      else finish({ ready: data.ready === true, ...(count && { counts: data.counts }) });
    };
    try {
      worker.postMessage(
        { type: 'orbis-local-data-census', ...(count && { count }), ...(purge && { purge }) },
        [request.port2],
      );
    } catch {
      finish(failed);
    }
  });
}
