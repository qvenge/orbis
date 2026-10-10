import { Component, lazy, type ReactNode, Suspense, useState } from 'react';
import type { BodyGateRef } from './EntityBody';
import type { LatestPanelHost } from './properties-relations/panel-host';
import type { WireEntity } from './record-host';

const hostFlights = new WeakSet<() => LatestPanelHost>();
const executingHosts = new WeakSet<LatestPanelHost>();
export async function runLazyPanelHost(
  action: PanelHostAction,
  target: PanelTarget,
  readLatest: () => LatestPanelHost,
  loader = () => import('./properties-relations/panel-host'),
  execute?: (dispatch: () => Promise<void>) => Promise<void>,
) {
  if (hostFlights.has(readLatest)) return;
  hostFlights.add(readLatest);
  const frozen = { ...target };
  let executing: LatestPanelHost | undefined;
  try {
    const module = await loader();
    const latest = readLatest();
    if (executingHosts.has(latest)) return;
    executing = latest;
    executingHosts.add(latest);
    const dispatch = () => module.dispatchPanelHost(action, frozen, readLatest);
    await (execute ? execute(dispatch) : dispatch());
  } finally {
    if (executing) executingHosts.delete(executing);
    hostFlights.delete(readLatest);
  }
}
export type PanelTarget = { entityId: string; readOnly: boolean };
export type PanelHostAction = 'openBody' | 'restore' | 'makePage' | 'stopPage' | 'configureApp';
export type PanelHostActions = {
  screenEntityId: string;
  available: ReadonlySet<PanelHostAction>;
  pending?: boolean;
  run: (
    action: PanelHostAction,
    target: PanelTarget,
    execute?: (dispatch: () => Promise<void>) => Promise<void>,
  ) => void;
  /** Lazy bridge binds current host handlers, with an address checked again by dispatch. */
  pageContext?: {
    entity: WireEntity | undefined;
    bodyGate: BodyGateRef;
    publish: (actions: {
      id: string | undefined;
      makePage: () => unknown;
      stopPage: () => unknown;
    }) => void;
  };
};
let modulePromise: Promise<
  typeof import('./properties-relations/PropertiesRelationsPanel')
> | null = null;
const load = () =>
  (modulePromise ??= import('./properties-relations/PropertiesRelationsPanel').catch(
    (error: unknown) => {
      modulePromise = null;
      throw error;
    },
  ));
export function resetPropertiesPanelModuleForTests() {
  modulePromise = null;
}
class LoadBoundary extends Component<
  { children: ReactNode; retry: () => void },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <div role="alert">
        Панель не загрузилась{' '}
        <button type="button" onClick={this.props.retry}>
          Повторить загрузку панели
        </button>
      </div>
    ) : (
      this.props.children
    );
  }
}
export function PropertiesRelationsSlot({
  target,
  host,
  onClose,
}: {
  target: PanelTarget | null;
  host: PanelHostActions;
  onClose: () => void;
}) {
  const [attempt, setAttempt] = useState(() => ({
    n: 0,
    Panel: lazy(() => load().then((m) => ({ default: m.PropertiesRelationsPanel }))),
  }));
  if (target === null) return null;
  const { Panel } = attempt;
  return (
    <LoadBoundary
      key={attempt.n}
      retry={() =>
        setAttempt((prev) => ({
          n: prev.n + 1,
          Panel: lazy(() => load().then((m) => ({ default: m.PropertiesRelationsPanel }))),
        }))
      }
    >
      <Suspense fallback={<p role="status">Загрузка панели…</p>}>
        <Panel key={target.entityId} target={target} host={host} onClose={onClose} />
      </Suspense>
    </LoadBoundary>
  );
}
