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
// 01-arch §7.8: эскалация повторных исправлений категории в правило памяти.
// Производитель — apps/server/src/ai/escalation.ts; поля обязаны ДОСЛОВНО совпадать с
// серверным union (apps/server/src/tools/registry.ts) — типы намеренно не общие.
// ruleText — готовый заголовок будущей memory-сущности (formatRuleTitle);
// pattern — ключ подавления по сходству на сервере, клиент его НЕ нормализует.
export type MemoryRuleSuggestionData = {
  kind: 'memory_rule_suggestion';
  ruleText: string;
  pattern: string;
  fromCategoryId: string;
  toCategoryId: string;
  categoryTitle: string;
};
// Отказ «Не надо» — новое системное сообщение (K4: журнал append-only). Своего
// компонента у карточки нет намеренно: текст отказа несёт content самого сообщения,
// а мёртвая ветка рендера уже стоила фикс-раунда фазе C (см. ImportReviewData).
// Тип объявлен ради парности контракта: union web должен знать все kind сервера.
export type MemoryRuleDeclinedData = {
  kind: 'memory_rule_declined';
  pattern: string;
  fromCategoryId: string;
  toCategoryId: string;
};
export type Card =
  | EntityCardData
  | QueryResultData
  | ConfirmationData
  | ErrorCardData
  | ImportReviewData
  | MemoryRuleSuggestionData
  | MemoryRuleDeclinedData;
