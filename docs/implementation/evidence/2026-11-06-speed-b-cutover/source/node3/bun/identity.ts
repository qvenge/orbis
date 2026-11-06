import assert from 'node:assert/strict';
import type postgres from 'postgres';

export const sha = (data: string | ArrayBuffer) =>
  new Bun.CryptoHasher('sha256').update(data).digest('hex');

export type Lane = 'N' | 'P';
export type Handoff = {
  lane: Lane;
  container: { id: string; image: string };
  db: { port: number; name: 'postgres'; admin: 'supabase_admin'; runtime: 'orbis_app'; systemId: string };
  manifests: { old: string; current: string };
};

export async function loadHandoff(path: string, digest: string, lane: Lane): Promise<Handoff> {
  assert(path.startsWith('/private/tmp/orbis-cutover-'));
  assert(/^[a-f0-9]{64}$/.test(digest), 'Expected root-pinned handoff SHA-256');
  const bytes = await Bun.file(path).arrayBuffer();
  assert.equal(sha(bytes), digest, 'Root-pinned handoff does not match');
  const value = JSON.parse(new TextDecoder().decode(bytes)) as Handoff;
  assert.equal(value.lane, lane);
  assert(/^[a-f0-9]{64}$/.test(value.container.id));
  assert(/^sha256:[a-f0-9]{64}$/.test(value.container.image));
  assert.equal(lane, 'P');
  assert.equal(value.db.port, 54348);
  assert.equal(value.db.name, 'postgres');
  assert.equal(value.db.admin, 'supabase_admin');
  assert.equal(value.db.runtime, 'orbis_app');
  assert(/^[0-9]+$/.test(value.db.systemId));
  for (const h of [value.manifests.old, value.manifests.current]) assert(/^[a-f0-9]{64}$/.test(h));
  return value;
}

export function checkDsn(raw: string, handoff: Handoff, role: 'admin' | 'runtime'): void {
  try {
    const u = new URL(raw);
    assert(u.protocol === 'postgres:' || u.protocol === 'postgresql:');
    assert(u.hostname === '127.0.0.1' && u.port === String(handoff.db.port));
    assert(u.pathname === '/' + handoff.db.name);
    assert(decodeURIComponent(u.username) === handoff.db[role]);
    assert(decodeURIComponent(u.password).length > 0);
    // Reject even empty query/fragment delimiters and ambiguous multi-host syntax.
    assert(!raw.includes('?') && !raw.includes('#'));
  } catch {
    throw new Error('Invalid ' + role + ' DSN for the pinned cutover lane');
  }
}

export async function checkContainer(handoff: Handoff): Promise<void> {
  const name = 'orbis-speed-b-cutover-p-node3';
  const docker = Bun.spawn(['docker', 'inspect', '--type=container', name], { stdout: 'pipe', stderr: 'ignore' });
  const output = await new Response(docker.stdout).text();
  assert.equal(await docker.exited, 0, 'Cutover container inspection failed');
  const rows = JSON.parse(output);
  assert.equal(rows.length, 1);
  const c = rows[0];
  assert(c.Id === handoff.container.id && c.Image === handoff.container.image, 'Pinned container/image mismatch');
  assert.equal(c.Name, '/' + name);
  assert.equal(c.State?.Running, true);
  assert.equal(c.Config?.Labels?.['orbis.cutover.lane'], 'p-node3');
  const published = c.NetworkSettings?.Ports;
  assert.deepEqual(Object.entries(published ?? {}).filter(([, entries]) => entries !== null),
    [['5432/tcp', [{ HostIp: '127.0.0.1', HostPort: String(handoff.db.port) }]]]);
}

export async function checkActualDb(sql: postgres.Sql, handoff: Handoff, role: 'admin' | 'runtime') {
  try {
    const [identity] = await sql`
      select current_database() as db, current_user as effective, session_user as login,
        inet_server_port() as port, r.rolsuper as superuser, r.rolbypassrls as bypass,
        r.rolinherit as inherit, r.rolcreatedb as createdb, r.rolcreaterole as createrole,
        r.rolreplication as replication, r.rolcanlogin as canlogin,
        pg_has_role(current_user, 'authenticated', 'MEMBER') as app_member,
        exists (
          select 1 from pg_roles privileged
          where privileged.rolname in ('postgres', 'supabase_admin', 'service_role', 'orbis_change_feed_owner')
            and pg_has_role(r.oid, privileged.oid, 'MEMBER')
        ) as privileged_member
      from pg_roles r where r.rolname = current_user
    `;
    assert(identity && identity.db === handoff.db.name && identity.effective === handoff.db[role] &&
      identity.login === handoff.db[role] && identity.port === 5432 && identity.canlogin === true);
    if (role === 'admin') {
      assert.equal(identity.superuser, true);
      const [control] = await sql`select system_identifier::text as id from pg_control_system()`;
      assert.equal(control?.id, handoff.db.systemId);
    } else {
      for (const key of ['superuser', 'bypass', 'inherit', 'createdb', 'createrole', 'replication'])
        assert.equal(identity[key], false);
      assert.equal(identity.app_member, true);
      assert.equal(identity.privileged_member, false);
    }
  } catch {
    throw new Error('Actual PostgreSQL ' + role + ' identity did not match the pinned cutover lane');
  }
}
