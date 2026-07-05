import { newId } from '@orbis/shared';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { TRPCClientError } from '@trpc/client';
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

// Убрать сообщение по id со всех страниц (снятие устаревшего error_card при «Повторить»).
export function removeMessage(old: InfiniteData | undefined, id: string): InfiniteData | undefined {
  if (!old) return old;
  return { ...old, pages: old.pages.map((p) => p.filter((m) => m.id !== id)) };
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
    onError: (err, variables) => {
      // §3 (флаг ревью Task 9): текст НЕ теряем молча. Оптимистичное user-сообщение остаётся,
      // а рядом вставляем error_card с retryId (id упавшего сообщения) + retryText — «Повторить»
      // переотправит ту же строку тем же id (дедуп по id, без второго пузыря; renderCards).
      const code =
        err instanceof TRPCClientError && typeof err.data?.code === 'string'
          ? err.data.code
          : 'LLM_UNAVAILABLE';
      const errorMsg: ChatMessage = {
        id: newId(),
        threadId,
        role: 'assistant',
        content: '',
        metadata: {
          cards: [{ kind: 'error_card', code, message: 'Не удалось отправить сообщение.' }],
          retryId: variables.id,
          retryText: variables.content,
        },
        createdAt: new Date().toISOString(),
      } as ChatMessage;
      queryClient.setQueryData<InfiniteData>(key, (old) => upsertNewest(old, errorMsg));
    },
  });

  return {
    sendMessage: (content: string) => send.mutate({ id: newId(), threadId, content }),
    // «Повторить»: снять устаревший error_card и переслать тем же id — upsertNewest дедупнёт
    // оптимистичный пузырь (без дубля), при успехе сообщение реконсилится ответом сервера.
    retryMessage: ({
      errorMessageId,
      id,
      content,
    }: {
      errorMessageId: string;
      id: string;
      content: string;
    }) => {
      queryClient.setQueryData<InfiniteData>(key, (old) => removeMessage(old, errorMessageId));
      send.mutate({ id, threadId, content });
    },
    isSending: send.isPending,
  };
}
