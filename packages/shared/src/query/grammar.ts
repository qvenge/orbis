/**
 * AST-типы грамматики query-движка (PRD 01 §6.1).
 *
 * Здесь только типы — скелет для Слайса 1: парсер грамматики живёт в `packages/shared`,
 * SQL-компилятор — в `apps/server`; оба потребляют этот AST. Запрос — строка из конструкций,
 * разделённых запятыми; все условия соединяются логическим AND, внутри значения `|` даёт OR (§6).
 */

/**
 * Относительные date-токены (§6.1). Применимы к любому полю типа date/timestamp:
 * `due_date=today`, `start_at=next_7d`.
 *
 * - `today` — значение поля сегодня;
 * - `overdue` — строго «значение поля < сегодня», без доменной логики задач;
 * - `next_7d` — диапазон [сегодня; сегодня + 7 дней], включительно с обеих сторон;
 * - `after_7d` — строго после этого диапазона (> сегодня + 7 дней).
 */
export type QueryDateToken = 'today' | 'overdue' | 'next_7d' | 'after_7d';

/**
 * Значение в позиции `<поле>=...`: строковый литерал (enum-значение, дата, строка)
 * либо относительный date-токен. Токены комбинируются через `|` как обычные значения:
 * `due_date=today|overdue` (§6.1).
 */
export type QueryFieldValue =
  | { kind: 'literal'; value: string }
  | { kind: 'date_token'; token: QueryDateToken };

/**
 * Условие фильтра поля. Ровно одна из двух форм — смешивание `|` и `&`
 * в одном значении (`status=a|b&!c`) является ошибкой парсинга (§6.4),
 * поэтому смесь непредставима в AST:
 *
 * - `anyOf` — `status=planned|in_progress`: OR по перечисленным значениям;
 * - `noneOf` — `status=!done&!cancelled`: НЕ эти значения (AND-исключение).
 */
export type QueryFieldCondition =
  | { kind: 'anyOf'; values: QueryFieldValue[] }
  | { kind: 'noneOf'; values: QueryFieldValue[] };

/**
 * Значение для сравнений `>`/`<` и диапазона `..` (§6.1):
 *
 * - `decimal` — числовой литерал; применим к JSON Schema `number`/`integer` и к полям
 *   формата decimal-string. Хранится строкой: бэкенд сравнивает через ту же точную
 *   base-10 арифметику, что денежные операции (§3.3); IEEE-754 `number` запрещён;
 * - `timestamp` — абсолютное значение ISO 8601 для core-полей типа timestamp
 *   (`created_at`, `updated_at`): `updated_at>2026-07-02T09:00:00Z` (паттерн курсора агента, §9.3).
 */
export type QueryComparableValue =
  | { kind: 'decimal'; value: string }
  | { kind: 'timestamp'; value: string };

/**
 * Ссылка на сущность в `children_of=` / `parents_of=`: явный UUID
 * либо токен `this` — сущность, в body которой живёт query-блок (§6.1).
 */
export type QueryEntityRef = { kind: 'this' } | { kind: 'id'; id: string };

/** Теги, OR внутри значения: `tags=work|personal` (§6.1). */
export interface QueryTagsFilter {
  kind: 'tags';
  values: string[];
}

/** Исключение тегов: `excludeTags=x` — исключить сущности с любым из тегов (§6.1). */
export interface QueryExcludeTagsFilter {
  kind: 'excludeTags';
  values: string[];
}

/** Наличие аспекта: `aspect=orbis/task` — аспект должен присутствовать (§6.1). */
export interface QueryAspectFilter {
  kind: 'aspect';
  aspect: string;
}

/**
 * Фильтр по полю: `<поле>=v1|v2` или `<поле>=!v1&!v2` (§6.1).
 *
 * `field` — имя после резолва парсером (§6.1, правила резолва): зарезервированные ключи
 * грамматики → core-поля (`created_at`, `updated_at`) → поля аспектов по схемам реестра.
 * `due` — документированный алиас `orbis/task.due_date`. Core-поле `title` в позиции
 * фильтра недоступно (ключ занят параметром заголовка) — отбор по заголовку через `search=`.
 */
export interface QueryFieldFilter {
  kind: 'field';
  field: string;
  condition: QueryFieldCondition;
}

/**
 * Числовое сравнение / сравнение timestamp: `amount>1000`,
 * `updated_at>2026-07-02T09:00:00Z` (§6.1).
 */
export interface QueryComparisonFilter {
  kind: 'comparison';
  field: string;
  op: '>' | '<';
  value: QueryComparableValue;
}

/** Диапазон, между значениями включительно: `amount=500..2000` (§6.1). */
export interface QueryRangeFilter {
  kind: 'range';
  field: string;
  min: QueryComparableValue;
  max: QueryComparableValue;
}

/**
 * Дети сущности: `children_of=<uuid|this>` — сущности, у которых X — родитель
 * (по relation `parent`); так конверт показывает свои транзакции, проект — задачи (§6.1).
 */
export interface QueryChildrenOfFilter {
  kind: 'children_of';
  of: QueryEntityRef;
}

/** Родители сущности: `parents_of=<uuid|this>` (по relation `parent`) (§6.1). */
export interface QueryParentsOfFilter {
  kind: 'parents_of';
  of: QueryEntityRef;
}

/**
 * `excludeBlocked=true` — исключить сущности с входящей `blocks`-relation
 * от сущности со статусом НЕ в `done|cancelled` (§6.1).
 */
export interface QueryExcludeBlockedFilter {
  kind: 'excludeBlocked';
}

/**
 * Архивные: `archived=true|any` (§6.1). Узел отсутствует в `filters` —
 * только неархивные; `true` — только архивные; `any` — все.
 */
export interface QueryArchivedFilter {
  kind: 'archived';
  value: 'true' | 'any';
}

/** Условие отбора — одна конструкция запроса (§6.1); в запросе соединяются AND. */
export type QueryFilter =
  | QueryTagsFilter
  | QueryExcludeTagsFilter
  | QueryAspectFilter
  | QueryFieldFilter
  | QueryComparisonFilter
  | QueryRangeFilter
  | QueryChildrenOfFilter
  | QueryParentsOfFilter
  | QueryExcludeBlockedFilter
  | QueryArchivedFilter;

/** Направление сортировки в `sortBy` (§6.1). */
export type QuerySortDirection = 'asc' | 'desc';

/**
 * Одно поле multi-field-сортировки: `sortBy=priority:desc|due_date:asc` (§6.1).
 * Enum-поля сортируются по порядку объявления значений в схеме аспекта, не по алфавиту;
 * NULL — всегда в конце. Core-поля доступны наравне с полями аспектов (`sortBy=updated_at:desc`).
 */
export interface QuerySortField {
  field: string;
  direction: QuerySortDirection;
}

/** Режим отображения: `display=compact|list|table` — подсказка рендереру query-блока (§6.1). */
export type QueryDisplayMode = 'compact' | 'list' | 'table';

/**
 * Корень AST разобранного запроса §6.1 — вход SQL-компилятора (apps/server, Слайс 1).
 * `display` и `title` — параметры представления, на отбор не влияют.
 */
export interface QueryAst {
  /** Условия отбора; соединяются логическим AND (§6). */
  filters: QueryFilter[];
  /** `sortBy=...` — упорядоченный список полей с направлением (§6.1). */
  sortBy?: QuerySortField[];
  /** `search=...` — полнотекстовый поиск по `title` + `body` (§6.1). */
  search?: string;
  /** `limit=...` — максимум результатов (§6.1). */
  limit?: number;
  /** `display=...` — подсказка рендереру query-блока (§6.1). */
  display?: QueryDisplayMode;
  /** `title=...` — заголовок над результатами query-блока (§6.1). */
  title?: string;
}
