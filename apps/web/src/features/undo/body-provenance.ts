import { QueryCache } from '@tanstack/react-query';
import { isUndoEpoch, undoEpoch } from './undo-epoch';

/** Маркер относится к фактическому объекту кэша после structural sharing, не к wire payload. */
const pendingBodies = new WeakSet<object>();
export function markBodyPending(doc: unknown): void {
  if (doc !== null && typeof doc === 'object') pendingBodies.add(doc);
}
export function confirmBody(doc: unknown): void {
  if (doc !== null && typeof doc === 'object') pendingBodies.delete(doc);
}
export function isBodyPending(doc: unknown): boolean {
  return doc !== null && typeof doc === 'object' && pendingBodies.has(doc);
}
export function makeBodyQueryCache(): QueryCache {
  const starts = new WeakMap<object, number>();
  const cache = new QueryCache({
    onSuccess: (_raw, query) => {
      // Callback идёт после setData; старое чтение не подтверждает новый owner даже новым объектом.
      const path = query.queryKey[0];
      if (!Array.isArray(path) || path.join('.') !== 'entity.get') return;
      const data = query.state.data as { entity?: { bodyDoc?: unknown } } | undefined;
      const doc = data?.entity?.bodyDoc;
      const start = starts.get(query);
      if (start !== undefined && isUndoEpoch(start)) confirmBody(doc);
      else markBodyPending(doc);
    },
  });
  // fetchstart фиксируется один раз; retry/continue/render не меняют принадлежность ответа.
  cache.subscribe((event) => {
    if (event.type === 'updated' && event.action.type === 'fetch')
      starts.set(event.query, undoEpoch());
  });
  return cache;
}
