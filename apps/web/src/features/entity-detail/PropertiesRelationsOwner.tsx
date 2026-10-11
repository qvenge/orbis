import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useToast } from '../../ui/toast-store';
import { isUndoEpoch, subscribeUndoEpoch, undoEpoch } from '../undo/undo-epoch';
import {
  type PanelHostActions,
  type PanelTarget,
  PropertiesRelationsSlot,
  runLazyPanelHost,
} from './PropertiesRelationsSlot';
import type { LatestPanelHost } from './properties-relations/panel-host';

type Registration = {
  readLatest: () => LatestPanelHost;
  host: Omit<PanelHostActions, 'run' | 'pending'>;
};
const unavailable: LatestPanelHost = {
  entity: undefined,
  available: new Set(),
  restricted: true,
  setMode() {},
  setHostView() {},
  restore() {},
  makePage() {},
  stopPage() {},
  onClose() {},
};
function useOwner() {
  const [target, setTarget] = useState<PanelTarget | null>(null);
  const [registration, setRegistration] = useState<Registration | null>(null);
  const current = useRef<Registration | null>(null);
  const flight = useRef<{ epoch: number } | null>(null);
  const [, setPending] = useState(false);
  const { show } = useToast();
  useLayoutEffect(
    () =>
      subscribeUndoEpoch(() => {
        flight.current = null;
        setPending(false);
        setTarget(null);
      }),
    [],
  );
  const register = useCallback((next: Registration) => {
    current.current = next;
    setRegistration(next);
    return () => {
      // A remount can register its replacement before the previous cleanup runs.
      if (current.current !== next) return;
      current.current = null;
      setRegistration(null);
    };
  }, []);
  const close = useCallback(() => {
    if (!flight.current) setTarget(null);
  }, []);
  const open = useCallback((next: PanelTarget) => {
    if (!flight.current) setTarget({ ...next });
  }, []);
  const run = useCallback<PanelHostActions['run']>(
    (action, addressed, execute) => {
      if (flight.current) return;
      const ticket = { epoch: undoEpoch() };
      flight.current = ticket;
      setPending(true);
      const frozen = { ...addressed };
      void runLazyPanelHost(
        action,
        frozen,
        () => {
          const latest = current.current?.readLatest() ?? unavailable;
          // Only the completed host navigation may close during its own synchronous lock.
          return { ...latest, onClose: () => setTarget(null) };
        },
        undefined,
        execute,
      )
        .catch(() => {
          if (isUndoEpoch(ticket.epoch))
            show('Не удалось открыть действие — повторите попытку', 'danger');
        })
        .finally(() => {
          if (flight.current !== ticket) return;
          flight.current = null;
          setPending(false);
        });
    },
    [show],
  );
  const api = useMemo(() => ({ open, close, register }), [open, close, register]);
  const host: PanelHostActions = {
    ...(registration?.host ?? { screenEntityId: '', available: unavailable.available }),
    run,
    get pending() {
      return flight.current !== null;
    },
  };
  return { api, slot: <PropertiesRelationsSlot target={target} host={host} onClose={close} /> };
}
const OwnerContext = createContext<ReturnType<typeof useOwner>['api'] | null>(null);
/** The panel survives changes of responsive frame; its address and command epoch stay local. */
export function PropertiesRelationsOwner({ children }: { children: ReactNode }) {
  const owner = useOwner();
  return (
    <OwnerContext.Provider value={owner.api}>
      {children}
      {owner.slot}
    </OwnerContext.Provider>
  );
}
export function usePropertiesRelationsOwner(registration: Registration) {
  const parent = useContext(OwnerContext);
  const local = useOwner();
  const api = parent ?? local.api;
  useLayoutEffect(() => api.register(registration), [api, registration]);
  return { ...api, slot: parent ? null : local.slot };
}
