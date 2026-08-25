// §9.1: совместимость клиента (Task 14) — клиент старше минимальной версии
// получает PRECONDITION_FAILED с cause { code: 'CLIENT_OUTDATED', min }.
export const MIN_COMPATIBLE_CLIENT_VERSION = '0.1.0';
export const CLIENT_VERSION_HEADER = 'x-orbis-client-version';

// §7.7/§9.2 (carried-решение плана 1b): максимум вызовов провайдера в одном
// tool-цикле ai.sendMessage. Превышение — не ошибка: принудительный финальный
// ответ с пометкой «[цикл остановлен: достигнут лимит шагов]» (Task 9).
export const MAX_AGENT_STEPS = 8;

export const RELATION_TYPES = ['parent', 'blocks', 'related_to', 'derived_from'] as const;
export type RelationType = (typeof RELATION_TYPES)[number];

/**
 * Системные роли рёбер v1 (§А4-3 реформы свойств): роль — единственная истина ребра, и она
 * заменяет `RELATION_TYPES` (расщепление `parent` на пять разных отношений — inv §1 п.8).
 * Порядок — нормативный `rank` реестра. Колонку `relation_type` и константу выше снимает
 * Задача 7a; до неё обе формы живут рядом, и это единственный интервал их сосуществования.
 *
 * `alternative-of` и `supersedes` — роли карты работ: встроенные записи сида уже в v1, без
 * потребителя-кода (дешевле заложить при пересеве, чем досевать потом).
 *
 * Список живёт здесь, рядом с `BUILTIN_ASPECT_IDS`, а не в `registry/builtin-roles.ts`:
 * у имени должен быть ровно один дом, иначе `export *` из двух файлов пакета делает его
 * неоднозначным. Определения ролей ссылаются на этот список и пиннятся тестом.
 */
export const RELATION_ROLE_IDS = [
  'subitem',
  'ticket',
  'run',
  'envelope-binding',
  'category-parent',
  'dependency',
  'mention',
  'instance-of',
  'ref',
  'alternative-of',
  'supersedes',
] as const;
export type RelationRoleId = (typeof RELATION_ROLE_IDS)[number];

/**
 * Семейство иерархии (§А4-3): `children_of`/`descendants_of` без `via=` компилятор
 * разворачивает в `role IN (…)` по этому списку. `envelope-binding` в него НЕ входит —
 * конверт не родитель транзакции, он её счётчик (Ч10-С1).
 */
export const HIERARCHICAL_ROLE_IDS = [
  'subitem',
  'ticket',
  'run',
  'category-parent',
] as const satisfies readonly RelationRoleId[];

export const BUILTIN_ASPECT_IDS = [
  'orbis/schedule',
  'orbis/task',
  'orbis/financial',
  'orbis/note',
  'orbis/budget',
  'orbis/category',
  'orbis/memory',
  'orbis/goal',
  'orbis/project',
  'orbis/repo',
  'orbis/assignment',
  'orbis/agent-run',
  'orbis/routine',
] as const;
export type AspectId = (typeof BUILTIN_ASPECT_IDS)[number];

/** Служебные аспекты (02-core-os §3.9): не в основных выдачах, без attach_*-тула — их
 *  создаёт и правит только сервер. Одна константа на компилятор запросов и реестр тулов. */
export const SERVICE_ASPECT_IDS = ['orbis/agent-run'] as const satisfies readonly AspectId[];

/** Область гранта агента (С2): full — весь граф владельца (сегодняшнее поведение и DEFAULT
 *  колонки `agent_grants.scope`), worker — сужение до выданного тикета. Гейт по скоупу ставит
 *  Задача 7; список заведён здесь, чтобы он был один на сервер и web. */
export const GRANT_SCOPES = ['full', 'worker'] as const;
export type GrantScope = (typeof GRANT_SCOPES)[number];
