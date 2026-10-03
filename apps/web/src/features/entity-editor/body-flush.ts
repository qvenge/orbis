/** Перед переписыванием тела ждём подтверждения всей очереди этого экрана. */
export type FlushResult = 'saved' | 'nothing' | 'blocked' | 'offline';
export type FinishBodyRewrite = (revision?: number) => void;
type Body = {
  flush: () => Promise<FlushResult>;
  revision?: () => number;
  begin?: () => FinishBodyRewrite;
};
const bodies = new Map<string, Body>();
export function registerBodyFlush(
  entityId: string,
  flush: Body['flush'],
  revision?: Body['revision'],
  begin?: Body['begin'],
): () => void {
  const body = { flush, revision, begin };
  bodies.set(entityId, body);
  return () => {
    if (bodies.get(entityId) === body) bodies.delete(entityId);
  };
}
export function flushBodyOf(entityId: string): Promise<FlushResult> {
  return bodies.get(entityId)?.flush() ?? Promise.resolve('nothing');
}
export function bodyRevisionOf(entityId: string): number | undefined {
  return bodies.get(entityId)?.revision?.();
}
export function mountedBodyIds(): string[] {
  return [...bodies.keys()];
}

/** Затвор принадлежит именно текущей регистрации, а не следующему экрану той же записи. */
export function beginBodyRewrite(entityId: string): FinishBodyRewrite {
  const body = bodies.get(entityId);
  const finish = body?.begin?.();
  return (revision) => {
    if (bodies.get(entityId) === body) finish?.(revision);
  };
}
