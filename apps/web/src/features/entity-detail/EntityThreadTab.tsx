import { lazy, Suspense } from 'react';
import { ThreadSkeleton } from '../chat/ThreadSkeleton';
import { useEnsuredThread } from '../chat/useEnsuredThread';
import { useHostReadOnly, useRecordHost } from './record-host';

const OpenedChatThread = lazy(() =>
  import('../chat/ChatThread').then((module) => ({ default: module.OpenedChatThread })),
);
const ChatFeed = lazy(() =>
  import('../chat/ChatThread').then((module) => ({ default: module.ChatFeed })),
);

export function EntityThreadTab({ entityId }: { entityId: string }) {
  // The read-only template preview never opens (creates) a thread.
  return useHostReadOnly() ? <HostThreadFeed /> : <EnsuredThreadTab entityId={entityId} />;
}

function HostThreadFeed() {
  const { thread } = useRecordHost();
  if (thread === null) return <p className="p-3 text-sm text-text-muted">Нет треда</p>;
  return (
    <Suspense fallback={<ThreadSkeleton />}>
      <ChatFeed threadId={thread.threadId} />
    </Suspense>
  );
}

function EnsuredThreadTab({ entityId }: { entityId: string }) {
  const opening = useEnsuredThread(entityId);
  return (
    <Suspense fallback={<ThreadSkeleton />}>
      <OpenedChatThread {...opening} />
    </Suspense>
  );
}
