/** Перед переписыванием тела ждём подтверждения очередей всех редакторов этой записи. */
export type FlushResult = 'saved' | 'nothing' | 'blocked' | 'offline';
export type FinishBodyRewrite = (revision?: number) => void;
type Body = {
  flush: () => Promise<FlushResult>;
  revision?: () => number;
  begin?: () => FinishBodyRewrite;
  checkpoint?: () => number | undefined;
};
const bodies = new Map<string, Set<Body>>();

export function registerBodyFlush(
  entityId: string,
  flush: Body['flush'],
  revision?: Body['revision'],
  begin?: Body['begin'],
  checkpoint?: Body['checkpoint'],
): () => void {
  const body = { flush, revision, begin, checkpoint };
  let registered = bodies.get(entityId);
  if (!registered) {
    registered = new Set();
    bodies.set(entityId, registered);
  }
  registered.add(body);
  return () => {
    if (!registered.delete(body)) return;
    if (registered.size === 0) bodies.delete(entityId);
  };
}

export async function flushBodyOf(entityId: string): Promise<FlushResult> {
  const registered = bodies.get(entityId);
  if (!registered) return 'nothing';
  const editors = [...registered];
  const settledEditors: Array<{ body: Body; version?: number }> = [];
  let result: FlushResult = 'nothing';
  // Sequential flushes keep distinct editors from sending the same CAS revision together.
  for (const body of editors) {
    if (!registered.has(body)) return 'blocked';
    const settled = await body.flush();
    if (settled === 'blocked' || settled === 'offline') return settled;
    const version = body.checkpoint?.();
    if (body.checkpoint && version === undefined) return 'blocked';
    settledEditors.push({ body, version });
    if (settled === 'saved') result = settled;
  }
  if (
    bodies.get(entityId) !== registered ||
    registered.size !== editors.length ||
    settledEditors.some(
      ({ body, version }) => !registered.has(body) || body.checkpoint?.() !== version,
    )
  )
    return 'blocked';
  return result;
}

export function bodyRevisionOf(entityId: string): number | undefined {
  let revision: number | undefined;
  for (const body of bodies.get(entityId) ?? []) {
    const known = body.revision?.();
    if (known !== undefined && (revision === undefined || known > revision)) revision = known;
  }
  return revision;
}

export function mountedBodyIds(): string[] {
  return [...bodies.keys()];
}

/** Затвор принадлежит именно текущим регистрациям, а не следующему экрану той же записи. */
export function beginBodyRewrite(entityId: string): FinishBodyRewrite {
  const registered = bodies.get(entityId);
  const finishes = [...(registered ?? [])].map((body) => ({ body, finish: body.begin?.() }));
  return (revision) => {
    for (const { body, finish } of finishes) {
      if (registered?.has(body)) finish?.(revision);
    }
  };
}
