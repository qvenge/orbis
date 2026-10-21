import { lazy, Suspense } from 'react';
import { useHostReadOnly } from '../entity-detail/record-host';

const Day = lazy(() => import('./DayPlanner').then((m) => ({ default: m.DayPlanner })));
const Inbox = lazy(() => import('./Inbox').then((m) => ({ default: m.Inbox })));

export function PlanningBlockSlot({
  kind,
  onOpen,
}: {
  kind: 'day-planner' | 'inbox';
  onOpen: (id: string) => void;
}) {
  const readOnly = useHostReadOnly();
  if (readOnly)
    return (
      <p className="text-sm text-text-muted">
        {kind === 'inbox' ? 'Входящие' : 'План дня'} — доступно на странице
      </p>
    );
  return (
    <Suspense
      fallback={
        <p role="status" className="p-4 text-sm text-text-muted">
          Загрузка…
        </p>
      }
    >
      {kind === 'day-planner' ? <Day onOpen={onOpen} /> : <Inbox onOpen={onOpen} />}
    </Suspense>
  );
}
