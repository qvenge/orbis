import { lazy, Suspense } from 'react';
import { useIsCoarsePointer } from '../../app/frame/useViewport';

const UndoArrows = lazy(() => import('./UndoArrows').then((m) => ({ default: m.UndoArrows })));
/** Первый кадр несёт только склейку, кнопки и панель приезжают вместе лениво. */
export function UndoArrowsSlot({ entityId }: { entityId: string }) {
  const coarse = useIsCoarsePointer();
  return (
    <Suspense fallback={null}>
      <UndoArrows entityId={entityId} variant={coarse ? 'keyboard' : 'inline'} />
    </Suspense>
  );
}
