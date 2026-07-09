import { useEffect, useRef } from 'react';
import { ScreenHeader } from '../../app/ScreenHeader';
import { useOnline, useRetryBuffer } from '../../state/retry';
import { trpc } from '../../trpc';
import { Composer } from './Composer';
import { MessageList } from './MessageList';
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
        <div role="status" className="p-4 text-sm text-text-muted">
          Открываем тред…
        </div>
      )}
    </div>
  );
}

function ThreadView({ threadId }: { threadId: string }) {
  const { messages, isLoading } = useChatThread(threadId);
  const { submit, reparse, retry } = useFastPath(threadId);
  const online = useOnline();
  const pending = useRetryBuffer((s) => s.size);

  return (
    <div className="flex h-full flex-col">
      {pending > 0 && (
        <div data-testid="pending-indicator" className="px-3 py-1 text-xs text-text-secondary">
          Ждут отправки: {pending}
        </div>
      )}
      {isLoading ? (
        <div role="status" className="flex-1 p-3 text-sm text-text-muted">
          Загрузка…
        </div>
      ) : (
        <MessageList messages={messages} isTyping={false} onRetry={retry} onReparse={reparse} />
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
