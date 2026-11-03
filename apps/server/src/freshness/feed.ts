import type { Change, ChangeCursor, ChangePage } from '@orbis/shared';
import { TRPCError } from '@trpc/server';
import { sql } from 'drizzle-orm';
import type { Tx } from '../db/with-identity';

const PAGE_LIMIT = 1000;

type FeedRow = {
  tx_id: string;
  kind: Change['kind'];
  row_key: string;
  entity_ids: string[];
  thread_id: string | null;
  operation: Change['operation'];
  scope: Change['scope'];
  at: string;
  graph_wide: boolean;
};

type SnapshotRow = {
  watermark: string;
  target_xid: string;
  floor: string | null;
  readable: boolean;
} & (FeedRow | { tx_id: null });

export async function readChanges(
  tx: Tx,
  { from }: ChangeCursor,
): Promise<{ page: ChangePage; targetXid: string }> {
  // Один снимок также связывает удаление строк при чистке с новым floor.
  const rows = await tx.execute<SnapshotRow>(sql`
    WITH snapshot AS MATERIALIZED (
      SELECT pg_current_snapshot() AS value
    ),
    boundary AS MATERIALIZED (
      SELECT pg_snapshot_xmin(value) AS watermark,
             (pg_snapshot_xmax(value)::text::numeric - 1)::text AS target_xid,
             (SELECT floor FROM public.change_feed_floor WHERE id = 1) AS floor,
             public.actor_reads_current_graph() AS readable
      FROM snapshot
    )
    SELECT b.watermark::text AS watermark, b.target_xid, b.floor::text AS floor, b.readable,
           f.tx_id::text AS tx_id, f.kind, f.row_key, f.entity_ids, f.thread_id,
           f.operation, f.scope, f.at, f.graph_wide
    FROM boundary b
    LEFT JOIN LATERAL (
      SELECT id, tx_id, kind, row_key, entity_ids, thread_id, operation, scope, at, graph_wide
      FROM public.change_feed
      WHERE graph_id = (SELECT public.current_graph_id())
        AND b.readable AND ${from}::xid8 >= b.floor
        AND tx_id >= ${from}::xid8 AND tx_id < b.watermark
      ORDER BY tx_id, id
      LIMIT ${PAGE_LIMIT + 1}
    ) f ON true
    ORDER BY f.tx_id, f.id
  `);
  const snapshot = rows[0];
  if (!snapshot) throw new Error('сверка не вернула снимок');
  if (!snapshot.readable) throw new TRPCError({ code: 'FORBIDDEN' });
  const { floor, watermark, target_xid: targetXid } = snapshot;
  if (floor === null) throw new Error('отсутствует порог ленты изменений');

  const boundary = { floor, watermark };
  if (BigInt(from) < BigInt(floor)) {
    const phase = BigInt(watermark) < BigInt(floor) ? 'provisional' : 'complete';
    return {
      page: {
        ...boundary,
        reset: { reason: 'floor', phase, token: `floor:${floor}:${phase}` },
        transactions: [],
      },
      targetXid,
    };
  }

  const reason =
    BigInt(from) > BigInt(watermark)
      ? 'future-cursor'
      : rows.length > PAGE_LIMIT
        ? 'overflow'
        : null;
  if (reason !== null) {
    return {
      page: {
        ...boundary,
        reset: { reason, phase: 'complete', token: `${reason}:${from}:${floor}:${watermark}` },
        transactions: [],
      },
      targetXid,
    };
  }

  const transactions: { txId: string; changes: Change[] }[] = [];
  let current: (typeof transactions)[number] | undefined;
  for (const row of rows) {
    if (row.tx_id === null) continue;
    if (current?.txId !== row.tx_id) {
      current = { txId: row.tx_id, changes: [] };
      transactions.push(current);
    }
    current.changes.push({
      kind: row.kind,
      rowKey: row.row_key,
      entityIds: row.entity_ids,
      threadId: row.thread_id,
      operation: row.operation,
      scope: row.scope,
      at: new Date(row.at).toISOString(),
      graphWide: row.graph_wide,
    });
  }
  return { page: { ...boundary, reset: null, transactions }, targetXid };
}
