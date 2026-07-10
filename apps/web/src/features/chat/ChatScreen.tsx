import { Clock } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { ScreenHeader } from '../../app/ScreenHeader';
import { useOnline, useRetryBuffer } from '../../state/retry';
import { trpc } from '../../trpc';
import { Composer } from './Composer';
import { MessageList, ThreadSkeleton } from './MessageList';
import { useChatThread } from './useChatThread';
import { useFastPath } from './useFastPath';

// Глобальный тред (§2.1): fast-path применяется только здесь (D-g — вкладка Chat).
export function ChatScreen() {
  const ensure = trpc.chat.ensureThread.useMutation();
  const started = useRef(false);

  // ensureThread один раз при монтировании (StrictMode-safe: ref гасит двойной вызов).
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    ensure.mutate({});
  }, [ensure.mutate]);

  const threadId = ensure.data?.threadId;
  return (
    <div className="flex h-full flex-col">
      <ScreenHeader title="Чат" />
      {threadId ? (
        // Контент центрирован (шапка — на всю ширину main), скролл — внутри MessageList.
        <div className="mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col">
          <ThreadView threadId={threadId} />
        </div>
      ) : (
        <div className="mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col">
          <ThreadSkeleton />
        </div>
      )}
    </div>
  );
}

function ThreadView({ threadId }: { threadId: string }) {
  const { messages, isLoading } = useChatThread(threadId);
  const { submit, reparse, retry, isSending } = useFastPath(threadId);
  const online = useOnline();
  const pending = useRetryBuffer((s) => s.size);

  return (
    <div className="flex h-full flex-col">
      {pending > 0 && (
        <div data-testid="pending-indicator" className="flex justify-center pt-2">
          <span className="flex items-center gap-1.5 rounded-full bg-surface-2 px-2.5 py-1 text-2xs text-text-secondary">
            <Clock size={11} aria-hidden />
            Ждут отправки: {pending}
          </span>
        </div>
      )}
      {isLoading ? (
        <ThreadSkeleton />
      ) : (
        <MessageList
          messages={messages}
          isTyping={isSending}
          onRetry={retry}
          onReparse={reparse}
          emptyHint="Например: «обед 340» — Orbis разберёт сам"
        />
      )}
      <Composer
        onSubmit={submit}
        placeholder={
          online ? 'Сообщение или быстрый ввод…' : 'Нет сети — доступен только быстрый ввод'
        }
      />
    </div>
  );
}
