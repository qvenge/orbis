import { newId } from '@orbis/shared';
import { hashKey, type QueryClient, useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { TRPCClientError } from '@trpc/client';
import { getQueryKey } from '@trpc/react-query';
import { useEffect, useSyncExternalStore } from 'react';
import {
  freshnessRuntimeOf,
  inheritNetworkReadReceipt,
  networkReadReceiptOf,
} from '../../lib/freshness/provenance';
import { useFreshnessVisible } from '../../lib/freshness/screen';
import { networkOnlyResponse } from '../../lib/local-data/query-responses';
import { type RouterOutputs, trpc } from '../../trpc';
import { isUndoEpoch, undoEpoch } from '../undo/undo-epoch';
import { localMessagesOf, projectLocalMessages } from './local-messages';

export type ChatMessage = RouterOutputs['chat']['listMessages'][number];
const PAGE = 50;

export function chatThreadKey(threadId: string) {
  return ['chatThread', threadId] as const;
}

/** Publish a confirmed open page through the ordinary QueryCache read callbacks for both keys. */
export async function publishOpenedTail(
  client: QueryClient,
  opened: RouterOutputs['chat']['openThread'],
  current: () => boolean,
) {
  const { threadId, messages } = opened;
  const runtime = freshnessRuntimeOf(client);
  const receipt = networkReadReceiptOf(opened);
  if (receipt) runtime?.noteOpenedThread(receipt, threadId, opened.openTxId);
  inheritNetworkReadReceipt(opened, messages);
  const canFill = (queryKey: readonly unknown[]) => {
    if (!current()) return false;
    const query = client.getQueryCache().get(hashKey(queryKey));
    if (!query) return true;
    const prior = runtime?.publicationOf(query.queryHash);
    return (
      prior?.source !== 'network' ||
      (receipt?.startedSequence ?? 0) >= prior.receipt.startedSequence
    );
  };
  const listKey = getQueryKey(trpc.chat.listMessages, { threadId, limit: PAGE }, 'query');
  const threadKey = chatThreadKey(threadId);
  const options = {
    queryFn: () => {
      if (!current()) throw new Error('Сессия изменилась');
      return messages;
    },
    staleTime: 0,
    retry: false,
    networkMode: 'always',
    meta: networkOnlyResponse,
  } as const;
  await Promise.all([
    canFill(listKey) && client.fetchQuery({ ...options, queryKey: listKey }),
    canFill(threadKey) &&
      client.fetchInfiniteQuery({
        ...options,
        queryKey: threadKey,
        initialPageParam: undefined as string | undefined,
        pages: 1,
        getNextPageParam: nextThreadCursor,
      }),
  ]);
}

function nextThreadCursor(lastPage: ChatMessage[]) {
  if (lastPage.length < PAGE) return undefined;
  const oldest = lastPage[lastPage.length - 1];
  return oldest ? `${oldest.createdAt}|${oldest.id}` : undefined;
}

/** A no-op command can confirm that the visible thread missed an earlier write. */
export function useChatThreadCatchup(threadId: string | undefined) {
  const client = useQueryClient();
  const visible = useFreshnessVisible();
  return () => {
    if (threadId === undefined || !visible) return;
    const key = chatThreadKey(threadId);
    const runtime = freshnessRuntimeOf(client);
    if (runtime) runtime.requestRead(key);
    else void client.refetchQueries({ queryKey: key, exact: true, type: 'active' });
  };
}

export function useChatThread(threadId: string) {
  const utils = trpc.useUtils();
  const client = useQueryClient();
  const local = localMessagesOf(client);
  const layers = useSyncExternalStore(local.subscribe, () => local.snapshot(threadId));
  const key = chatThreadKey(threadId);
  const q = useInfiniteQuery({
    queryKey: key,
    enabled: useFreshnessVisible(),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      utils.chat.listMessages.fetch(
        { threadId, before: pageParam, limit: PAGE },
        { staleTime: 0, meta: networkOnlyResponse },
      ),
    // The compound cursor also orders messages created in the same millisecond.
    getNextPageParam: nextThreadCursor,
  });
  useEffect(() => {
    const pages = q.data?.pages;
    if (pages && layers.length) local.observeServer(threadId, pages.flat());
  }, [q.data, layers, local, threadId]);
  return {
    messages: projectLocalMessages((q.data?.pages ?? []).flat(), layers),
    fetchOlder: () => q.fetchNextPage(),
    hasMore: q.hasNextPage,
    isLoading: q.isLoading,
    hasTail: q.data?.pages[0] !== undefined,
    error: q.data === undefined && q.isError ? q.error : undefined,
    retry: () => void q.refetch({ cancelRefetch: false }),
  };
}

export function useSendMessage(threadId: string) {
  const client = useQueryClient();
  const local = localMessagesOf(client);
  const send = trpc.ai.sendMessage.useMutation({
    onMutate: ({ id, content, threadId }) => ({
      epoch: undoEpoch(),
      token: local.begin(threadId, {
        id,
        threadId,
        role: 'user',
        content,
        metadata: {},
        createdAt: new Date().toISOString(),
      } as ChatMessage),
    }),
    onSuccess: (res, _vars, ctx) => {
      if (!ctx || !isUndoEpoch(ctx.epoch) || 'status' in res) return;
      local.confirm(ctx.token, res.assistantMessage as ChatMessage);
    },
    onError: (err, { id, content, threadId }, ctx) => {
      if (!ctx || !isUndoEpoch(ctx.epoch)) return;
      const code =
        err instanceof TRPCClientError && typeof err.data?.code === 'string'
          ? err.data.code
          : 'LLM_UNAVAILABLE';
      local.fail(ctx.token, {
        id: newId(),
        threadId,
        role: 'assistant',
        content: '',
        metadata: {
          cards: [{ kind: 'error_card', code, message: 'Не удалось отправить сообщение.' }],
          retryId: id,
          retryText: content,
        },
        createdAt: new Date().toISOString(),
      } as ChatMessage);
    },
  });

  return {
    sendMessage: (content: string) => send.mutate({ id: newId(), threadId, content }),
    retryMessage: ({ id, content }: { errorMessageId: string; id: string; content: string }) =>
      send.mutate({ id, threadId, content }),
    isSending: send.isPending,
  };
}
