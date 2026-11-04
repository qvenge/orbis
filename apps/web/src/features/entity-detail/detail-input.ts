import type { RouterInputs } from '../../trpc';

// Общий ключ экрана, предзагрузки и патчей. bodyDoc сохраняет блочные ID редактора.
const DETAIL_INCLUDE: NonNullable<RouterInputs['entity']['get']['include']> = [
  'body',
  'bodyDoc',
  'relations',
  'backlinks',
  'thread',
];

export function detailGetInput(id: string): RouterInputs['entity']['get'] {
  return { id, include: DETAIL_INCLUDE };
}
