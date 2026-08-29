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
// 00-product §8: сводка завершённого импорта (уборочная фаза, E13). Своего компонента
// нет намеренно — текст несёт content самого сообщения; тип объявлен ради парности
// контракта: union web обязан знать все kind сервера (та же причина, что у
// MemoryRuleDeclinedData). Поля дословно из apps/server/src/tools/registry.ts.
export type ImportSummaryData = {
  kind: 'import_summary';
  namespace: string;
  total: number;
  created: number;
  adopted: number;
  skipped: number;
};
// V1.6: предложение рутины. Своя карточка, а не confirmation_card, потому что вопрос другой:
// не «подтвердить действие, которое я сейчас сделаю», а «принять предложение, сделанное
// ночью» — с объяснением прозой и списком самих правок. Поля обязаны ДОСЛОВНО совпадать с
// серверным union (apps/server/src/tools/registry.ts) — типы намеренно не общие.
//
// Всё, кроме `runId`, компонент читает с сервера (`routine.proposal`), а не отсюда: статус в
// ленте — снимок момента отправки, а решают предложение со второго экрана, гасят новым
// прогоном и разводят с графом. `summary`/`explanation` остаются в контракте ради парности с
// сервером и ради ленты без сети (content сообщения), но карточка их не читает.
export type ProposalCardData = {
  kind: 'proposal_card';
  pendingId: string;
  runId: string;
  routineId: string;
  summary: string;
  explanation: string;
  /** Ш1.5: id исходного предложения, которое погасила правка владельца; нет у неправленых. */
  editedFrom?: string;
};
// D42 ОЧ.4/ОЧ.13: отложенное действие рутины — единица «Пачки решений». Своя карточка, а не
// confirmation_card, по той же причине, что у предложения выше: вопрос другой — не
// «подтвердить то, что я делаю прямо сейчас», а «решить то, что фон отложил ночью». Поля
// обязаны ДОСЛОВНО совпадать с серверным union (apps/server/src/tools/registry.ts) — типы
// намеренно не общие.
//
// Из карточки компонент читает ТЕКСТ (`summary`, `rows`): он есть в сообщении и виден без
// сети. СУДЬБА единицы приезжает только с сервера (`routine.runUnits`), потому что решают
// пачку и позже, и с другого экрана, и её же гасит следующий прогон.
export type DeferredActionCardData = {
  kind: 'deferred_action_card';
  pendingId: string;
  runId: string;
  routineId: string;
  summary: string;
  /**
   * «Было → станет» по одному полю. `field` — id СВОЙСТВА (`orbis/amount`) либо core-поле
   * записи (`title`, `tags`, `archived`): с Задачи 12 адрес у строки ОДИН, и ключа `aspect`
   * производитель не кладёт вовсе (`tools/dispatch.ts` snapshotDeferredUnit; серверный union
   * его тоже не объявляет — `tools/registry.ts`). Подпись ставит реестр (`unitRowLabel`).
   * `before` — снятое ПРЕДУСЛОВИЕ (ОЧ.13), а не значение «сейчас»: единица сверится именно с
   * ним, и показать текущее значило бы нарисовать согласие там, где будет отказ.
   */
  rows: Array<{ field: string; before?: string; after: string }>;
};
// D42 ОЧ.5: вопрос рутины владельцу — вторая разновидность единицы пачки. На вопрос ОТВЕЧАЮТ,
// а не принимают его: кнопки «Принять»/«Отклонить» вели бы владельца прямо в структурный отказ
// гейта рода (server policy/pending.ts, assertNotQuestion). Поля — ДОСЛОВНО серверные.
export type QuestionCardData = {
  kind: 'question_card';
  pendingId: string;
  runId: string;
  routineId: string;
  question: string;
  /** До четырёх готовых ответов кнопками; порядок значим — он уезжает в ответ индексом. */
  options?: string[];
};
export type Card =
  | EntityCardData
  | QueryResultData
  | ConfirmationData
  | ErrorCardData
  | ImportReviewData
  | MemoryRuleSuggestionData
  | MemoryRuleDeclinedData
  | ImportSummaryData
  | ProposalCardData
  | DeferredActionCardData
  | QuestionCardData;
