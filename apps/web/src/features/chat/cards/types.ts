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
// 03-budget §3.4: импорт из чата — карточка ведёт на экран импорта (файл выбирается
// локально и через ленту не проходит). Производитель на сервере — задача C4c.
// Полей нет: производитель (tools/dispatch.ts importCsvStart) шлёт только kind —
// файл выбирается уже на экране импорта, имени выписки сервер в этот момент не знает
export type ImportReviewData = { kind: 'import_review' };
export type Card =
  | EntityCardData
  | QueryResultData
  | ConfirmationData
  | ErrorCardData
  | ImportReviewData;
