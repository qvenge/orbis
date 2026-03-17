import { useState, useEffect } from 'react';
import { WifiOff, RefreshCw } from 'lucide-react';
import { useOnlineStatus } from '../../hooks/useOnlineStatus.ts';
import { onSyncStatusChange, triggerSync, type SyncStatus } from '../../lib/sync-manager.ts';

export function OfflineIndicator() {
  const online = useOnlineStatus();
  const [syncStatus, setSyncStatus] = useState<SyncStatus>('idle');
  const [pendingCount, setPendingCount] = useState(0);
  const [retryCount, setRetryCount] = useState(0);
  const [conflictCount, setConflictCount] = useState(0);

  useEffect(() => {
    return onSyncStatusChange((status, pending, state) => {
      setSyncStatus(status);
      setPendingCount(pending);
      setRetryCount(state.retryCount);
      setConflictCount(state.conflictCount);
    });
  }, []);

  const showBar = !online || syncStatus === 'syncing' || syncStatus === 'retrying' || syncStatus === 'error' || pendingCount > 0 || conflictCount > 0;
  if (!showBar) return null;

  const bgColor = !online || syncStatus === 'error'
    ? 'bg-warning/90'
    : syncStatus === 'syncing' || syncStatus === 'retrying'
      ? 'bg-primary/90'
      : 'bg-warning/90';

  return (
    <div className={`flex items-center justify-center gap-2 px-3 py-1 ${bgColor}`}>
      {!online ? (
        <>
          <WifiOff className="h-3 w-3 text-black" />
          <span className="text-xs font-medium text-black">
            You're offline{pendingCount > 0 ? ` — ${pendingCount} pending` : ' — changes will sync when reconnected'}
          </span>
        </>
      ) : syncStatus === 'syncing' ? (
        <>
          <RefreshCw className="h-3 w-3 animate-spin text-white" />
          <span className="text-xs font-medium text-white">Syncing...</span>
        </>
      ) : syncStatus === 'retrying' ? (
        <>
          <RefreshCw className="h-3 w-3 animate-spin text-white" />
          <span className="text-xs font-medium text-white">
            Retrying sync ({retryCount}/5)...
          </span>
        </>
      ) : syncStatus === 'error' ? (
        <>
          <span className="text-xs font-medium text-black">
            Sync failed
          </span>
          <button
            onClick={triggerSync}
            className="rounded bg-black/20 px-1.5 py-0.5 text-[10px] font-medium text-black transition-colors hover:bg-black/30"
          >
            Retry now
          </button>
        </>
      ) : conflictCount > 0 ? (
        <>
          <span className="text-xs font-medium text-black">
            {conflictCount} conflict{conflictCount > 1 ? 's' : ''} — server version kept
          </span>
        </>
      ) : pendingCount > 0 ? (
        <>
          <RefreshCw className="h-3 w-3 text-black" />
          <span className="text-xs font-medium text-black">{pendingCount} pending changes</span>
          <button
            onClick={triggerSync}
            className="rounded bg-black/20 px-1.5 py-0.5 text-[10px] font-medium text-black transition-colors hover:bg-black/30"
          >
            Sync now
          </button>
        </>
      ) : null}
    </div>
  );
}
