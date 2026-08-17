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
