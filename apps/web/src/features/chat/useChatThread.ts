import { newId } from '@orbis/shared';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { type RouterOutputs, trpc } from '../../trpc';

export type ChatMessage = RouterOutputs['chat']['listMessages'][number];
const PAGE = 50;

export function chatThreadKey(threadId: string) {
  return ['chatThread', threadId] as const;
}

type InfiniteData = { pages: ChatMessage[][]; pageParams: (string | undefined)[] };

// Новейшая страница — pages[0] (DESC). Свежее/оптимистичное сообщение — в начало pages[0], дедуп по id.
export function upsertNewest(old: InfiniteData | undefined, msg: ChatMessage): InfiniteData {
  if (!old) return { pages: [[msg]], pageParams: [undefined] };
  const [first = [], ...rest] = old.pages;
  const without = first.filter((m) => m.id !== msg.id);
  return { ...old, pages: [[msg, ...without], ...rest] };
}

export function useChatThread(threadId: string) {
  const utils = trpc.useUtils();
  const q = useInfiniteQuery({
    queryKey: chatThreadKey(threadId),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      utils.chat.listMessages.fetch({ threadId, before: pageParam, limit: PAGE }),
    getNextPageParam: (lastPage) =>
      lastPage.length < PAGE ? undefined : lastPage[lastPage.length - 1]?.createdAt,
  });
  const messages = (q.data?.pages ?? []).flat();
  return {
    messages,
    fetchOlder: () => q.fetchNextPage(),
    hasMore: q.hasNextPage,
    isLoading: q.isLoading,
  };
}

export function useSendMessage(threadId: string) {
  const queryClient = useQueryClient();
  const utils = trpc.useUtils();
  const key = chatThreadKey(threadId);

  const send = trpc.ai.sendMessage.useMutation({
    onMutate: async ({ id, content }) => {
      await queryClient.cancelQueries({ queryKey: key });
      const optimistic: ChatMessage = {
        id,
        threadId,
        role: 'user',
        content,
        metadata: {},
        createdAt: new Date().toISOString(),
      } as ChatMessage;
      queryClient.setQueryData<InfiniteData>(key, (old) => upsertNewest(old, optimistic));
    },
    onSuccess: (res) => {
      if (res.replayed) {
        // D-f: не аппендим локально — рефетчим тред
        void queryClient.invalidateQueries({ queryKey: key });
        return;
      }
      queryClient.setQueryData<InfiniteData>(key, (old) =>
        upsertNewest(old, res.assistantMessage as ChatMessage),
      );
      void utils.entity.query.invalidate();
    },
    onError: () => {
      void queryClient.invalidateQueries({ queryKey: key });
    },
  });

  return {
    sendMessage: (content: string) => send.mutate({ id: newId(), threadId, content }),
    isSending: send.isPending,
  };
}
