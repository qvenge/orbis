import { type FieldCatalog, type ParseResult, parseQuery } from '@orbis/shared';

export { buildCatalogFromAspects } from './catalog';

// Снимаем обёртку {{query:...}}; на вход parseQuery идёт содержимое (§2: обёртку парсер НЕ снимает).
export function parseBlock(blockText: string, catalog: FieldCatalog): ParseResult {
  const m = blockText.match(/\{\{query:([\s\S]*?)\}\}/);
  const inner = (m ? (m[1] ?? '') : blockText).trim();
  return parseQuery(inner, catalog);
}
