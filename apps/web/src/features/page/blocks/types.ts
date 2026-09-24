import type { BlockResult } from '@orbis/shared';

/** Строка блока данных — wire-форма сущности из ответа `entity.blocks` (та же, что у `entity.query`). */
export type BlockRow = Extract<BlockResult, { kind: 'rows' }>['rows'][number];
