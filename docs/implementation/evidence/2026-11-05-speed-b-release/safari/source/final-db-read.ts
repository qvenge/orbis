import { readFileSync } from 'node:fs';
import { and, eq, sql } from 'drizzle-orm';
import { makeDb } from '../../../../apps/server/src/db/client';
import { entities } from '../../../../apps/server/src/db/schema';
import { withIdentity } from '../../../../apps/server/src/db/with-identity';
import { identityOfPerson, parseAccountId, parseGraphId } from '../../../../apps/server/src/identity';
const descriptor = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const url = new URL(process.env.DATABASE_URL ?? '');
if (url.hostname !== '127.0.0.1' || url.port !== '54339' || url.username !== 'orbis_app' ||
    url.pathname !== '/postgres' || url.search || url.hash || !['postgres:', 'postgresql:'].includes(url.protocol))
  throw Error('Unexpected local runtime');
if (descriptor.source !== '356a610f5ae92efe429bdb6891c5bde6f9c09e9f' ||
    !/^[0-9a-f-]{36}$/.test(descriptor.owner) || !/^[0-9a-f-]{36}$/.test(descriptor.recordId))
  throw Error('Unexpected fixture');
const { db, client } = makeDb({ max: 1 });
try {
  const result = await withIdentity(db, identityOfPerson(parseAccountId(descriptor.owner)), async (tx) => {
    const roles = await tx.execute(sql`select current_user as effective_role, session_user as session_role`);
    const rows = await tx.select({
      id: entities.id, graphId: entities.graphId, body: entities.body,
      bodyDoc: entities.bodyDoc, bodyRevision: entities.bodyRevision,
    }).from(entities).where(and(eq(entities.id, descriptor.recordId), eq(entities.graphId, parseGraphId(descriptor.owner))));
    if (rows.length !== 1) throw Error('Own fixture row not unique');
    return { source: descriptor.source, roles: [...roles], row: rows[0] };
  });
  console.log(JSON.stringify(result, null, 2));
} finally { await client.end(); }
