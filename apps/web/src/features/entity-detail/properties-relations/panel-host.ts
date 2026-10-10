import { currentEntry } from '@orbis/shared/nav';
import { mayLeave } from '../../../state/leave-guard';
import { useNav } from '../../../state/navigation';
import type { PanelHostAction, PanelTarget } from '../PropertiesRelationsSlot';
import type { WireEntity } from '../record-host';
export type LatestPanelHost = {
  entity: WireEntity | undefined;
  available: ReadonlySet<PanelHostAction>;
  restricted: boolean;
  setMode: () => void;
  setHostView: () => void;
  restore: () => void;
  makePage: () => void;
  stopPage: () => void;
  onClose: () => void;
};
/** Loaded on the gesture. The getter is read after import, never a pre-import snapshot. */
export function dispatchPanelHost(
  action: PanelHostAction,
  target: PanelTarget,
  readLatest: () => LatestPanelHost,
) {
  const host = readLatest();
  if (!host.entity) return;
  if (action === 'openBody') {
    if (!mayLeave()) return;
    if (target.entityId === host.entity.id) {
      host.setMode();
      host.setHostView();
      host.onClose();
      return;
    }
    useNav.getState().openRecord(target.entityId);
    const here = currentEntry(useNav.getState().model).address;
    if (here.kind !== 'record' || here.id !== target.entityId) return;
    useNav.getState().setView({ via: 'host' });
    host.onClose();
    return;
  }
  if (
    target.entityId !== host.entity.id ||
    target.readOnly ||
    host.restricted ||
    !host.available.has(action)
  )
    return;
  if (action === 'restore') {
    if (host.entity.archived) host.restore();
  } else if (action === 'makePage') host.makePage();
  else if (action === 'stopPage') host.stopPage();
  else host.setHostView();
}
