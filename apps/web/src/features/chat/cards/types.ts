import type { BlockSum } from '@orbis/shared';

/**
 * Сводка действия журнала в треде (`metadata.journal`, спека скорости §11.3) — тип провода общий с сервером
 * (`@orbis/shared`, производитель — `journal/thread-page.ts`): её поля — контракт, а не копия, в отличие от карточек
 * ниже (их union намеренно свой — см. комментарии у них).
 */
export type { JournalCardMeta } from '@orbis/shared';

/**
 * Карточка записи (02 §2.3). Оба адреса — НОВОЙ правды (§А1-1), и это не косметика:
 * `aspects` — просто список навешенного (полей у него больше нет, Р9), а ключи `keyFields`
 * это id СВОЙСТВ (`orbis/amount`), а не имена полей старой схемы. Собирает их
 * `keyFieldsByAspect`/`entityCard` (`tools/dispatch.ts`) по `view_config.keyFields` реестра
 * и `props` записи; подпись каждому ставит реестр (§А9-2), а не словарь в коде. Прежние
 * ключи (`category_ref`, `occurred_on`) не совпадали ни с одним ключом ответа — и строка
 * остатка конверта не рисовалась НИКОГДА.
 */
export type EntityCardData = {
  kind: 'entity_card';
  entityId: string;
  title: string;
  aspects: string[];
  keyFields: Record<string, unknown>;
  undoActionId?: string;
  /**
   * Действие карточки уже отменено — признак выдачи треда (спека скорости §11.2, рулинг R-14), не хранится: сервер
   * ставит его на чтении карточкам в ответах ассистента, у которых своей строки журнала нет. Ключа нет — не отменено.
   */
  undone?: boolean;
};
export type QueryResultData = {
  kind: 'query_result';
  title?: string;
  count: number;
  entityIds: string[];
  /**
   * `sums` — суммы по валютам (спека 1в §3.6), только у карточек после 1в: журнал чата только
   * дополняется, и прежняя карточка без `sums` рисуется своим `value`.
   */
  aggregate?: { op: 'sum' | 'count'; value: string; sums?: BlockSum[] };
};
/**
 * Плашка подтверждения. Ключ `diff` — id СВОЙСТВА либо имя поля записи (`title`, `tags`,
 * `aspects`): производитель (`entityUpdatePreviewDiff`, `policy/confirmation.ts`) раскрывает
 * `props`/`unset` ПОШТУЧНО (§А7-4), потому что одна строка «props: {объект} → {объект}» не
 * называла бы, что именно подтверждают. Подпись ставит реестр (§А9-2).
 */
export type ConfirmationData = {
  kind: 'confirmation_card';
  mode: 'preview' | 'explicit';
  pendingId?: string;
  summary: string;
  diff?: Record<string, { before: unknown; after: unknown }>;
  /** Отказанная карточка закрыта: выдача треда добавляет признак на чтении, хранимое сообщение неизменно. */
  closed?: true;
};
export type ErrorCardData = { kind: 'error_card'; code: string; message: string };
// 03-budget §3.4: карточка импорта в ленте. Производителя на сервере с 1в нет — инструмент агента,
// начинавший импорт из чата, снят до среза Бюджета (спека 1в §7.4); тип остаётся, чтобы уже
// записанные сообщения ленты рисовались, а не падали. Полей нет: карточка несла только kind —
// файл выбирался на экране импорта, имени выписки сервер в этот момент не знал
export type ImportReviewData = { kind: 'import_review' };
// 01-arch §7.8: эскалация повторных исправлений категории в правило памяти.
// Производитель — apps/server/src/ai/escalation.ts; поля обязаны ДОСЛОВНО совпадать с
// серверным union (apps/server/src/tools/registry.ts) — типы намеренно не общие.
// ruleText — ГЕНЕРИРУЕМАЯ ПОДПИСЬ будущей memory-сущности (`formatRuleLabel`, сервер): она
// уезжает в `title` записи и обратно никем не разбирается — машиночитаемая часть правила
// лежит в свойствах (В7). pattern — и ключ подавления по сходству на сервере, и значение
// `orbis/rule_pattern` создаваемого правила; клиент его НЕ нормализует.
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
