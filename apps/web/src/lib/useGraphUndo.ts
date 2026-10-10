import { useCallback } from 'react';
import { trpc } from '../trpc';
import { useToast } from '../ui/toast-store';
import { runGraphCommand } from './graph-command';
import { invalidateGraphCommand } from './invalidate';

/** The toast owns its vanilla Undo callback, so closing its originating form is harmless. */
export function useGraphUndo(): (
  actionId: string,
  doneTitle: string,
  legacyFailureTitle?: string,
) => void {
  const utils = trpc.useUtils();
  const { show } = useToast();
  return useCallback(
    (actionId, doneTitle, legacyFailureTitle) => {
      if (!actionId) {
        show(doneTitle);
        return;
      }
      let inFlight = false;
      let attempted = false;
      show(doneTitle, 'default', {
        label: 'Отменить',
        onSelect: () => {
          if (inFlight || attempted) return;
          inFlight = true;
          attempted = true;
          void runGraphCommand(() => utils.client.ai.undo.mutate({ actionId }))
            .then((outcome) => {
              invalidateGraphCommand(utils);
              if (outcome.kind === 'rejected')
                show(legacyFailureTitle ?? outcome.message, 'danger');
              else if (outcome.kind === 'unknown') show('Не удалось подтвердить отмену', 'danger');
            })
            .finally(() => {
              inFlight = false;
            });
        },
      });
    },
    [utils, show],
  );
}
