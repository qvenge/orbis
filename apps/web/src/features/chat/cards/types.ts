export type EntityCardData = {
  kind: 'entity_card';
  entityId: string;
  title: string;
  aspects: string[];
  keyFields: Record<string, unknown>;
  undoActionId?: string;
};
export type QueryResultData = {
  kind: 'query_result';
  title?: string;
  count: number;
  entityIds: string[];
  aggregate?: { op: 'sum' | 'count'; value: string };
};
export type ConfirmationData = {
  kind: 'confirmation_card';
  mode: 'preview' | 'explicit';
  pendingId?: string;
  summary: string;
  diff?: Record<string, { before: unknown; after: unknown }>;
};
export type ErrorCardData = { kind: 'error_card'; code: string; message: string };
export type Card = EntityCardData | QueryResultData | ConfirmationData | ErrorCardData;
