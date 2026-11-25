import { canonicalJson, pendingMessageId } from '@orbis/shared';
import { FILE_LIST_LIMIT, type FileFieldEdit, fileFieldEditInput } from '@orbis/shared/files';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { fileCommands } from '../db/schema';
import type { Tx } from '../db/with-identity';
import { ExecError } from '../errors';
import type { ExecuteOk, ExecuteRequest } from '../executor/types';
import { requireLiveFileGrant } from './access';
import { requireFileWrites } from './file-limits';

export type FileValue = string | string[] | null;
export function fileConflict(current: unknown): never {
  throw new ExecError('CONFLICT', 'Значение файлового поля изменилось. Перечитайте запись.', {
    current,
  });
}

export function editFileValue(
  cardinality: 'one' | 'many',
  value: unknown,
  edit: FileFieldEdit['edit'],
): FileValue {
  if (cardinality === 'one' && (edit.kind === 'set' || edit.kind === 'clear')) {
    if ((value ?? null) !== edit.expected) fileConflict(value ?? null);
    return edit.kind === 'set' ? edit.fileId : null;
  }
  if (cardinality !== 'many' || edit.kind === 'set' || edit.kind === 'clear') {
    throw new ExecError('VALIDATION', 'Команда не соответствует кратности файлового свойства.');
  }
  const current = value ?? [];
  if (!Array.isArray(current) || !current.every((x) => typeof x === 'string')) fileConflict(value);
  switch (edit.kind) {
    case 'add': {
      if (current.includes(edit.fileId)) return current;
      const index = edit.beforeId === undefined ? current.length : current.indexOf(edit.beforeId);
      if (index < 0) fileConflict(current);
      if (current.length >= FILE_LIST_LIMIT)
        throw new ExecError('VALIDATION', 'Слишком много файлов.');
      return [...current.slice(0, index), edit.fileId, ...current.slice(index)];
    }
    case 'remove':
      return current.filter((id) => id !== edit.fileId);
    case 'reorder':
      if (JSON.stringify(current) !== JSON.stringify(edit.expected)) fileConflict(current);
      if (
        edit.value.length !== current.length ||
        new Set(edit.value).size !== current.length ||
        !edit.value.every((id) => current.includes(id))
      ) {
        throw new ExecError('VALIDATION', 'Перестановка должна содержать те же файлы.');
      }
      return edit.value;
  }
}

type CommandCaller = Pick<
  ExecuteRequest,
  'identity' | 'actorGrantId' | 'source' | 'fileCapability'
>;
type Receipt = ExecuteOk | { pendingId: string };
export async function checkFileMutation(tx: Tx, caller: CommandCaller, undo = false) {
  requireFileWrites();
  if (caller.actorGrantId !== undefined)
    await requireLiveFileGrant(tx, caller.identity, caller.actorGrantId);
  if (
    !undo &&
    ['ui', 'mcp', 'fast_path', 'quick_capture'].includes(caller.source) &&
    caller.fileCapability !== true
  )
    throw new ExecError('CLIENT_OUTDATED', 'Для изменения вложений обновите клиент.', {
      reason: 'file_capability_required',
    });
  const [allowed] = await tx.execute<{ allowed: boolean }>(
    sql`SELECT public.actor_writes_current_graph() AS allowed`,
  );
  if (!allowed?.allowed) throw new ExecError('FORBIDDEN_LEVEL', 'Доступ на запись запрещён.');
}

export function fieldCommands(ops: ReadonlyArray<{ tool: string; input: unknown }>) {
  return ops.flatMap(({ tool, input }, index) => {
    if (tool !== 'file_field_edit') return [];
    const parsed = fileFieldEditInput.safeParse(input);
    if (!parsed.success)
      throw new ExecError('VALIDATION', 'Некорректная файловая команда.', {
        issues: parsed.error.issues,
      });
    return [{ index, command: parsed.data }];
  });
}

export async function readCommandReceipts(
  tx: Tx,
  caller: CommandCaller,
  commands: ReturnType<typeof fieldCommands>,
) {
  const saved = new Map<string, Receipt>();
  if (!commands.length) return saved;
  await checkFileMutation(tx, caller);
  const ids = commands.map((c) => c.command.commandId).sort();
  if (new Set(ids).size !== ids.length)
    throw new ExecError('CONFLICT', 'ID файловой команды повторяется в пачке.');
  for (const id of ids)
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${caller.identity.graph + ':file-command:' + id},0))`,
    );
  const rows = await tx
    .select()
    .from(fileCommands)
    .where(and(eq(fileCommands.graphId, caller.identity.graph), inArray(fileCommands.id, ids)));
  for (const row of rows) {
    const command = commands.find((c) => c.command.commandId === row.id)?.command;
    if (
      row.actorId !== caller.identity.actor ||
      row.grantId !== (caller.actorGrantId ?? null) ||
      canonicalJson(row.request) !== canonicalJson(command)
    )
      throw new ExecError('CONFLICT', 'ID команды уже использован.');
    saved.set(row.id, row.result as Receipt);
  }
  return saved;
}

export async function saveFileCommand(
  tx: Tx,
  caller: CommandCaller,
  command: FileFieldEdit,
  result: Receipt,
) {
  const [written] = await tx
    .insert(fileCommands)
    .values({
      graphId: caller.identity.graph,
      id: command.commandId,
      actorId: caller.identity.actor,
      grantId: caller.actorGrantId,
      request: command,
      result,
    })
    .onConflictDoUpdate({
      target: [fileCommands.graphId, fileCommands.id],
      set: { result },
      setWhere: sql`${fileCommands.request} = excluded.request AND ${fileCommands.actorId} = excluded.actor_id AND ${fileCommands.grantId} IS NOT DISTINCT FROM excluded.grant_id`,
    })
    .returning({ id: fileCommands.id });
  if (!written) throw new ExecError('CONFLICT', 'ID команды уже использован.');
}

export function pendingCommandConflict(pendingId: string): never {
  throw new ExecError('CONFLICT', 'Команда уже назначена на подтверждение.', {
    reason: 'pending_file_command',
    pendingId,
  });
}

/** A group with no graph mutation still has a durable batch/approval outcome,
 * separately from the graph journal and its Undo history. */
function batchReceiptId(graph: string, batchId: string) {
  return pendingMessageId(graph, 'unchanged-file-batch:' + batchId);
}
export const unchangedBatchKind = 'unchanged_file_batch';
export async function unchangedBatch(tx: Tx, graphId: string, batchId: string) {
  const [row] = await tx
    .select()
    .from(fileCommands)
    .where(
      and(eq(fileCommands.graphId, graphId), eq(fileCommands.id, batchReceiptId(graphId, batchId))),
    );
  if ((row?.request as { kind?: string } | undefined)?.kind !== unchangedBatchKind) return;
  return row;
}
export async function saveUnchangedBatch(
  tx: Tx,
  caller: CommandCaller,
  batchId: string,
  operations: ExecuteRequest['operations'],
  result: ExecuteOk,
) {
  const request = { kind: unchangedBatchKind, batchId, operations };
  const [written] = await tx
    .insert(fileCommands)
    .values({
      graphId: caller.identity.graph,
      id: batchReceiptId(caller.identity.graph, batchId),
      actorId: caller.identity.actor,
      grantId: caller.actorGrantId,
      request,
      result,
    })
    .onConflictDoNothing()
    .returning({ id: fileCommands.id });
  if (!written) throw new ExecError('CONFLICT', 'ID пачки уже использован.');
}
