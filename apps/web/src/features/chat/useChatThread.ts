import { newId } from '@orbis/shared';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { TRPCClientError } from '@trpc/client';
import { useEffect, useSyncExternalStore } from 'react';
import { freshnessRuntimeOf } from '../../lib/freshness/provenance';
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
    getNextPageParam: (lastPage) => {
      if (lastPage.length < PAGE) return undefined;
      const oldest = lastPage[lastPage.length - 1];
      return oldest ? `${oldest.createdAt}|${oldest.id}` : undefined;
    },
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
