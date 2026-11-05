const expectedOrigin = arguments[0];
const done = arguments[arguments.length - 1];
if (location.origin !== expectedOrigin) return done({ error: 'Unrelated origin' });
Promise.all([
  navigator.serviceWorker?.getRegistrations().then((registrations) => registrations.map((registration) => ({
    scope: registration.scope,
    active: registration.active?.scriptURL,
    state: registration.active?.state,
    waiting: !!registration.waiting,
  }))) ?? [],
  typeof caches === 'undefined' ? [] : caches.keys(),
]).then(([workers, cacheNames]) => done({
  origin: location.origin,
  secureContext: isSecureContext,
  indexedDB: typeof indexedDB !== 'undefined',
  cacheStorage: typeof caches !== 'undefined',
  serviceWorker: 'serviceWorker' in navigator,
  controller: navigator.serviceWorker?.controller?.scriptURL ?? null,
  locks: typeof navigator.locks !== 'undefined',
  storageEstimate: typeof navigator.storage?.estimate === 'function',
  userAgent: navigator.userAgent,
  workers,
  cacheNames,
}), (error) => done({ error: String(error) }));
