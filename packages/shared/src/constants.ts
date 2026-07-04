// §9.1: совместимость клиента (Task 14) — клиент старше минимальной версии
// получает PRECONDITION_FAILED с cause { code: 'CLIENT_OUTDATED', min }.
export const MIN_COMPATIBLE_CLIENT_VERSION = '0.1.0';
export const CLIENT_VERSION_HEADER = 'x-orbis-client-version';

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
