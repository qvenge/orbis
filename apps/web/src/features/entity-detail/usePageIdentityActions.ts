import { PAGE_ASPECT } from '@orbis/shared';
import { useToast } from '../../ui/toast-store';
import { useUpdateBatch } from '../page/useUpdateBatch';
import { settleBody } from './body-gate';
import type { BodyGateRef } from './EntityBody';
import type { WireEntity } from './record-host';
/** Undefined is the host's loading phase; no action acquires an address until its own data arrives. */
export function usePageIdentityActions(entity: WireEntity | undefined, bodyGate: BodyGateRef) {
  const batch = useUpdateBatch();
  const { show } = useToast();
  return {
    makePage: () => {
      if (entity && settleBody(bodyGate.current, show))
        return batch(
          [{ tool: 'entity_update', input: { id: entity.id, aspects: { attach: [PAGE_ASPECT] } } }],
          'Запись стала страницей',
          { action: 'Сделать страницей' },
        );
    },
    stopPage: () => {
      if (entity && settleBody(bodyGate.current, show))
        return batch(
          [{ tool: 'entity_update', input: { id: entity.id, aspects: { detach: [PAGE_ASPECT] } } }],
          'Запись больше не страница',
          { action: 'Перестать быть страницей' },
        );
    },
  };
}
