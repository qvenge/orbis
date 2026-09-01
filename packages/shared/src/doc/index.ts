// Точка входа `@orbis/shared/doc`. В корневой баррель (src/index.ts) НЕ добавляется: он собран
// из `export *` и импортируется эагерными модулями web, а этот модуль тянет всю схему Tiptap
// (~156 kB gzip) — попав в первый кадр, он обессмыслил бы двухфазное монтирование.
export { bindQueryBlocks } from './bind-query';
export * from './convert';
export { OrbisMarkdownManager } from './manager';
export { BODY_REF_RE, EntityRef } from './nodes/entity-ref';
export { QUERY_BLOCK_CLOSE, QueryBlock } from './nodes/query-block';
export { RawBlock } from './nodes/raw';
export * from './schema';
export * from './types';
