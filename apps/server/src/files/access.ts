import { fileIdSchema } from '@orbis/shared/files';
import { and, eq, isNull, or, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { agentGrants, fileUploads } from '../db/schema';
import { type Tx, withIdentity } from '../db/with-identity';
import { ExecError } from '../errors';
import type { Identity } from '../identity';
import type { GrantRef } from '../oauth/grants';
import type { FileStore } from './store';

export interface FileContext {
  db: Db;
  identity: Identity;
  grant?: GrantRef;
  store?: FileStore;
}

export function parseFileId(id: string): string {
  const parsed = fileIdSchema.safeParse(id);
  if (!parsed.success) throw new ExecError('VALIDATION', 'Некорректный ID файла или загрузки.');
  return parsed.data;
}

export function ownedAttempt(ctx: FileContext) {
  return and(
    eq(fileUploads.graphId, ctx.identity.graph),
    eq(fileUploads.ownerActor, ctx.identity.actor),
    ctx.grant ? eq(fileUploads.ownerGrantId, ctx.grant.id) : isNull(fileUploads.ownerGrantId),
  );
}

export async function requireLiveFileGrant(tx: Tx, identity: Identity, grantId: string) {
  // The OAuth registry is a server-only table. Restore the scoped role before touching files.
  // The row lock orders revocation and each database stage of a transfer.
  await tx.execute(sql`SET LOCAL ROLE NONE`);
  const [live] = await tx
    .select({ id: agentGrants.id })
    .from(agentGrants)
    .where(
      and(
        eq(agentGrants.id, grantId),
        eq(agentGrants.graphId, identity.graph),
        eq(agentGrants.issuedBy, identity.actor),
        eq(agentGrants.scope, 'full'),
        isNull(agentGrants.revokedAt),
        or(
          isNull(agentGrants.accessExpiresAt),
          sql`${agentGrants.accessExpiresAt} > clock_timestamp()`,
        ),
      ),
    )
    .for('share');
  await tx.execute(sql`SET LOCAL ROLE orbis_files`);
  if (!live) throw new ExecError('FORBIDDEN_LEVEL', 'Грант файлового доступа недействителен.');
}

/** Agent access is checked against the live grant in every transaction, including after Storage I/O. */
export function withFileAccess<T>(
  ctx: FileContext,
  mode: 'read' | 'write',
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return withIdentity(ctx.db, ctx.identity, async (tx) => {
    if (ctx.grant) {
      if (ctx.grant.scope !== 'full' || !fileIdSchema.safeParse(ctx.grant.id).success) {
        throw new ExecError('FORBIDDEN_LEVEL', 'Грант не разрешает работу с файлами.');
      }
      await requireLiveFileGrant(tx, ctx.identity, ctx.grant.id);
    }
    const predicate =
      mode === 'write'
        ? sql`public.actor_writes_current_graph()`
        : sql`public.actor_reads_current_graph()`;
    const [allowed] = await tx.execute<{ allowed: boolean }>(sql`SELECT ${predicate} AS allowed`);
    if (!allowed?.allowed)
      throw new ExecError('FORBIDDEN_LEVEL', 'Доступ к файлам графа запрещён.');
    return fn(tx);
  });
}
