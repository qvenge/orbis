const expectedOrigin = arguments[0];
const owner = arguments[1];
const record = arguments[2];
const done = arguments[arguments.length - 1];
if (location.origin !== expectedOrigin) return done({ error: 'Unrelated origin' });
(async () => {
  const session = JSON.parse(localStorage.getItem('sb-localhost-auth-token') ?? 'null');
  const token = session?.access_token;
  if (session?.user?.id !== owner || typeof token !== 'string')
    throw Error('Exact synthetic credential unavailable');
  const encoded = token.split('.')[1]?.replace(/-/g, '+').replace(/_/g, '/');
  const claims = encoded ? JSON.parse(atob(encoded)) : null;
  if (claims?.sub !== owner || claims.exp - Date.now() / 1000 < 120)
    throw Error('Exact synthetic credential window ended');
  const url = new URL('/trpc/entity.get', expectedOrigin);
  url.searchParams.set('input', JSON.stringify({ id: record, include: ['body', 'bodyDoc'] }));
  const response = await fetch(url, {
    cache: 'no-store',
    headers: { Authorization: 'Bearer ' + token, 'x-orbis-client-version': '0.7.0' },
  });
  if (response.status !== 200) return done({ error: 'Own entity.get failed', status: response.status });
  const raw = await response.json();
  const data = raw?.result?.data?.json ?? raw?.result?.data;
  const entity = data?.entity;
  if (entity?.id !== record || !Number.isInteger(entity.bodyRevision) ||
      !entity.bodyDoc || typeof entity.bodyDoc !== 'object')
    throw Error('Own entity.get did not return the full expected document');
  done({ origin: location.origin, source: 'own-origin entity.get body and bodyDoc', status: response.status,
    recordId: entity.id, body: entity.body, bodyDoc: entity.bodyDoc, bodyRevision: entity.bodyRevision });
})().catch(() => done({ error: 'Own full-document read could not complete' }));
