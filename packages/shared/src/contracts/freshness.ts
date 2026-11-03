import { z } from 'zod';

export const READ_WATERMARK_HEADER = 'X-Orbis-Read-Watermark';

const MAX_XID = '18446744073709551615';

/** xid8 передаётся канонической десятичной строкой, в том числе в Last-Event-ID. */
export const changeXidInput = z
  .string()
  .regex(/^(?:0|[1-9][0-9]{0,19})$/)
  .refine((xid) => xid.length < MAX_XID.length || xid <= MAX_XID);

export const changeCursorInput = z.object({ from: changeXidInput }).strict();
export type ChangeCursor = z.infer<typeof changeCursorInput>;

export type Change = {
  kind:
    | 'entity'
    | 'relation'
    | 'version'
    | 'message'
    | 'thread'
    | 'journal'
    | 'settings'
    | 'registry';
  rowKey: string;
  entityIds: string[];
  threadId: string | null;
  operation: 'insert' | 'update' | 'delete';
  scope: 'body' | 'other';
  at: string;
  graphWide: boolean;
};

type ChangeReset = {
  reason: 'floor' | 'overflow' | 'future-cursor';
  token: string;
  phase: 'provisional' | 'complete';
};

export type ChangePage = { watermark: string; floor: string } & (
  | { reset: null; transactions: { txId: string; changes: Change[] }[] }
  | { reset: ChangeReset; transactions: [] }
);

export type ReadDependencies = {
  entityIds: string[];
  graph: boolean;
  bodyOrStamp: boolean;
  threadIds: string[];
  settings: boolean;
  registry: boolean;
  expiresAt: string | null;
};
