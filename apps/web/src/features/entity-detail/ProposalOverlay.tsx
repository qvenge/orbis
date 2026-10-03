import { lazy, Suspense, useEffect, useRef } from 'react';
import { type RouterOutputs, trpc } from '../../trpc';

const ProposalView = lazy(() =>
  import('./ProposalOverlayView').then((m) => ({ default: m.ProposalOverlayView })),
);
/** R43: запрос остаётся в первом кадре; разбор предложения нужен лишь после непустого ответа. */
export function ProposalOverlay({
  entity,
  onOverlayExpanded,
}: {
  entity: RouterOutputs['entity']['get']['entity'];
  onOverlayExpanded: (open: boolean) => void;
}) {
  const list = trpc.routine.proposalsForEntity.useQuery({ entityId: entity.id });
  const proposals = Array.isArray(list.data) ? list.data : [];
  const activated = useRef(false);
  if (proposals.length > 0) activated.current = true;
  useEffect(() => {
    if (!activated.current) onOverlayExpanded(false);
  }, [onOverlayExpanded]);
  if (!activated.current) return null;
  // После активации пустой ответ не сносит сообщение replaced и буфер свёрнутой плашки.
  return (
    <Suspense fallback={<p role="status">Загружаем предложение…</p>}>
      <ProposalView
        entity={entity}
        proposals={proposals}
        busy={list.isFetching}
        onOverlayExpanded={onOverlayExpanded}
      />
    </Suspense>
  );
}
