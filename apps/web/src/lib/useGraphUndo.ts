import { useCallback } from 'react';
import { offerUndoLazy } from '../features/undo/undo-lazy';
import { useToast } from '../ui/toast-store';

/** Current shared Undo owns body settlement, continuation and the global stack. */
export function useGraphUndo(): (
  actionId: string,
  doneTitle: string,
  legacyFailureTitle?: string,
  entityIds?: string[],
) => void {
  const { show } = useToast();
  return useCallback(
    (actionId, doneTitle, legacyFailureTitle, entityIds) => {
      if (!actionId) {
        show(doneTitle);
        return;
      }
      offerUndoLazy({
        actionId,
        title: doneTitle,
        ...(legacyFailureTitle !== undefined && { failed: legacyFailureTitle }),
        ...(entityIds !== undefined && { entityIds }),
      });
    },
    [show],
  );
}
