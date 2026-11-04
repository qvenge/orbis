import { onlineManager, type QueryClient, useQuery, useQueryClient } from '@tanstack/react-query';
import { getQueryKey } from '@trpc/react-query';
import { freshnessRuntimeOf, inheritNetworkReadReceipt } from '../../lib/freshness/provenance';
import { useFreshnessVisible } from '../../lib/freshness/screen';
import { type RouterOutputs, trpc } from '../../trpc';
import { Button } from '../../ui/Button';
import { detailGetInput } from '../entity-detail/detail-input';
import { isUndoEpoch, undoEpoch } from '../undo/undo-epoch';
import { publishOpenedTail } from './useChatThread';

export type EnsuredThread =
  | { status: 'pending' }
  | { status: 'ready'; threadId: string }
  | { status: 'failed'; message: string };

type Binding = Pick<RouterOutputs['chat']['openThread'], 'threadId'>;
type Opening = { current: () => boolean; promise: Promise<Binding> };
const openings = new WeakMap<QueryClient, Map<string | undefined, Opening>>();
const noConnection = new Error('Нет сети или активного сеанса');
const placeKey = (entityId?: string) => ['chatOpen', entityId ?? null] as const;

function openForPlace(
  client: QueryClient,
  entityId: string | undefined,
  open: () => Promise<RouterOutputs['chat']['openThread']>,
): Promise<Binding> {
  let byPlace = openings.get(client);
  if (!byPlace) {
    byPlace = new Map();
    openings.set(client, byPlace);
  }
  const previous = byPlace.get(entityId);
  if (previous?.current()) return previous.promise;
  const epoch = undoEpoch();
  const query = client.getQueryCache().find({ queryKey: placeKey(entityId), exact: true });
  const runtime = freshnessRuntimeOf(client);
  const stillCurrent = runtime?.captureOperation();
  const current = () =>
    isUndoEpoch(epoch) &&
    (stillCurrent?.() ?? true) &&
    client.getQueryCache().find({ queryKey: placeKey(entityId), exact: true }) === query;
  const promise = open()
    .then(async (result) => {
      if (!current() || (entityId && runtime?.wasDeleted(entityId)))
        throw new Error('Место треда изменилось');
      if (typeof result?.threadId !== 'string' || !Array.isArray(result.messages))
        throw new Error('Не удалось получить тред');
      await publishOpenedTail(client, result, current);
      if (!current() || (entityId && runtime?.wasDeleted(entityId)))
        throw new Error('Место треда изменилось');
      const binding = { threadId: result.threadId };
      inheritNetworkReadReceipt(result, binding);
      return binding;
    })
    .finally(() => {
      if (byPlace.get(entityId)?.promise === promise) byPlace.delete(entityId);
    });
  byPlace.set(entityId, { current, promise });
  return promise;
}

/** The binding comes only from the server's successful open and shares the scoped response cache. */
export function useEnsuredThread(entityId?: string): {
  state: EnsuredThread;
  retry: () => void;
} {
  const client = useQueryClient();
  const utils = trpc.useUtils();
  const visible = useFreshnessVisible();
  const runtime = freshnessRuntimeOf(client);
  const isUnavailable = () => {
    if (!entityId || !runtime) return false;
    if (runtime.wasDeleted(entityId)) return true;
    const detail = client.getQueryState(
      getQueryKey(trpc.entity.get, detailGetInput(entityId), 'query'),
    );
    const error = detail?.error as { data?: { code?: string } } | undefined;
    return error?.data?.code === 'NOT_FOUND' && runtime.isCurrentReadError(error);
  };
  const q = useQuery({
    queryKey: placeKey(entityId),
    enabled: (query) => visible && !isUnavailable() && query.state.data === undefined,
    networkMode: 'offlineFirst',
    staleTime: Infinity,
    notifyOnChangeProps: ['data', 'error', 'fetchStatus'],
    retry: (_, error) => error === noConnection,
    queryFn: () => {
      if (!onlineManager.isOnline()) throw noConnection;
      return openForPlace(client, entityId, () =>
        utils.client.chat.openThread.mutate(entityId === undefined ? {} : { entityId }),
      );
    },
  });
  const unavailable = isUnavailable();
  const state: EnsuredThread = unavailable
    ? { status: 'failed', message: 'Запись не найдена.' }
    : q.data
      ? { status: 'ready', threadId: q.data.threadId }
      : q.isError
        ? { status: 'failed', message: q.error.message }
        : { status: 'pending' };
  return {
    state,
    retry: () => {
      if (!unavailable) void q.refetch({ cancelRefetch: false });
    },
  };
}

/**
 * Плашка «тред завести не вышло» с повтором. Молчать нельзя: без треда экран пуст, и вечный
 * скелетон читался бы как «грузится», хотя грузиться уже нечему. Кнопка — потому что единственным
 * способом повторить иначе остаётся уход с экрана и возврат, а на глобальном чате и его нет.
 */
export function EnsureFailedNotice({
  what,
  message,
  onRetry,
}: {
  /** Что именно не открылось, целым предложением: «Не удалось открыть тред записи.» */
  what: string;
  message: string;
  onRetry: () => void;
}) {
  return (
    <div role="alert" className="flex flex-col items-start gap-2 p-3 text-sm text-danger">
      <p>
        {what} {message}
      </p>
      <Button variant="outline" size="sm" onClick={onRetry}>
        Повторить
      </Button>
    </div>
  );
}
