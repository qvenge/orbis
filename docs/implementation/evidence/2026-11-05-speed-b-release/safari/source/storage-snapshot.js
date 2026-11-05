const expectedOrigin = arguments[0];
const account = arguments[1];
const record = arguments[2];
const done = arguments[arguments.length - 1];
if (location.origin !== expectedOrigin) return done({ error: 'Unrelated origin' });
function read(name, store) {
  if (typeof indexedDB === 'undefined') return Promise.resolve({ available: false, unsupported: true });
  return new Promise((resolve) => {
    let missing = false;
    const request = indexedDB.open(name);
    request.onupgradeneeded = () => {
      missing = true;
      request.transaction.abort();
    };
    request.onerror = () => resolve({ available: false, missing, error: String(request.error) });
    request.onsuccess = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(store)) {
        db.close();
        resolve({ available: true, missingStore: true, rows: [] });
        return;
      }
      const transaction = db.transaction(store, 'readonly');
      const all = transaction.objectStore(store).getAll();
      all.onerror = () => { db.close(); resolve({ available: false, error: String(all.error) }); };
      all.onsuccess = () => {
        const rows = all.result;
        db.close();
        resolve({ available: true, rows });
      };
    };
  });
}
const prefix = 'orbis:body-draft:' + account + ':' + record;
let emergency = [];
let emergencyError;
try {
  emergency = Object.keys(localStorage).filter((key) => key.startsWith(prefix)).map((key) => {
  const draft = JSON.parse(localStorage.getItem(key) ?? 'null');
  const finished = draft?.slot && localStorage.getItem(
    'orbis:body-draft-finished:' + account + ':' + record + ':' + draft.slot) !== null;
  return { key, draft, finished: !!finished };
});
} catch (error) {
  emergencyError = String(error);
}
Promise.all([
  read('orbis-cache:' + account, 'responses'),
  read('orbis-input:' + account, 'slots'),
]).then(([responses, inputs]) => done({
  origin: location.origin,
  responses: responses.available ? {
    ...responses, rows: responses.rows.filter((row) => row.data?.entity?.id === record),
  } : responses,
  inputs: inputs.available ? {
    ...inputs, rows: inputs.rows.filter((row) => row.latest?.entityId === record ||
      row.snapshot?.token?.entityId === record || row.acknowledgedFallback?.token?.entityId === record),
  } : inputs,
  emergency,
  emergencyError,
  visibleBody: document.querySelector('[data-testid="body-editor"] [contenteditable="true"]')?.innerText ?? null,
  recovery: [...document.querySelectorAll('[data-testid="draft-banner"]')].map((node) => node.innerText),
}), (error) => done({ error: String(error) }));
