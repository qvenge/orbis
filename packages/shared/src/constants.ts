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
] as const;
export type AspectId = (typeof BUILTIN_ASPECT_IDS)[number];
