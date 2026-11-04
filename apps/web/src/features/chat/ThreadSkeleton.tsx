import { Skeleton } from '../../ui/Skeleton';

// Скелетон треда: три «пузыря» разной ширины (ChatScreen и ChatThread, этап 4).
export function ThreadSkeleton() {
  return (
    <div className="flex flex-1 flex-col gap-2 p-3">
      <Skeleton className="h-10 w-3/5 self-start rounded-card" />
      <Skeleton className="h-10 w-2/5 self-end rounded-card" />
      <Skeleton className="h-10 w-1/2 self-start rounded-card" />
    </div>
  );
}
