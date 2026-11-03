/* Loaded by Workbox. This worker does not intercept or cache any requests. */
self.addEventListener('message', (event) => {
  if (event.data?.type !== 'orbis-local-data-census' || !event.ports[0]) return;
  const reply = event.ports[0];
  const count = event.data.count;
  const purge = event.data.purge;
  event.waitUntil(
    (async () => {
      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const reports = await Promise.all(
        clients
          .filter((client) => !count || client.id !== event.source?.id)
          .map(
            (client) =>
              new Promise((resolve) => {
                const challenge = new MessageChannel();
                const timer = setTimeout(() => {
                  challenge.port1.close();
                  resolve(undefined);
                }, 750);
                challenge.port1.onmessage = ({ data }) => {
                  clearTimeout(timer);
                  challenge.port1.close();
                  if (data?.protocol !== 1) return resolve(undefined);
                  if (!count) return resolve(!purge || data.purged === true);
                  resolve(
                    Number.isSafeInteger(data.count) &&
                      data.count >= 0 &&
                      typeof data.version === 'string'
                      ? { count: data.count, version: data.version }
                      : undefined,
                  );
                };
                client.postMessage(
                  {
                    type: 'orbis-local-data-challenge',
                    ...(count && { count }),
                    ...(purge && { purge }),
                  },
                  [challenge.port2],
                );
              }),
          ),
      );
      if (count) {
        reply.postMessage({
          protocol: 1,
          ready: reports.every(Boolean),
          counts: reports.filter(Boolean),
        });
      } else {
        reply.postMessage({ protocol: 1, ready: reports.length > 0 && reports.every(Boolean) });
      }
    })().catch(() => reply.postMessage({ protocol: 1, ready: false })),
  );
});
