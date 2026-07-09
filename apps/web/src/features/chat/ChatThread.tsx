import { Button } from '../../ui/Button';
import { Composer } from './Composer';
import { MessageList, ThreadSkeleton } from './MessageList';
import { useChatThread, useSendMessage } from './useChatThread';

// Общий чат-компонент (§2.2): используется глобальным тредом и тредом сущности (разный threadId).
export function ChatThread({ threadId }: { threadId: string }) {
  const { messages, fetchOlder, hasMore, isLoading } = useChatThread(threadId);
  const { sendMessage, isSending, retryMessage } = useSendMessage(threadId);
  return (
    <div className="flex h-full flex-col">
      {hasMore && (
        <Button variant="ghost" onClick={() => fetchOlder()} className="m-2 self-center">
          Загрузить ещё
        </Button>
      )}
      {isLoading ? (
        <ThreadSkeleton />
      ) : (
        // §7.9: тред detail тоже отдаёт «Повторить» (onRetry) при сбое ai.sendMessage.
        // Тред сущности — без fast-path-подсказки: даём контекстную подпись обсуждения.
        <MessageList
          messages={messages}
          isTyping={isSending}
          onRetry={retryMessage}
          emptyHint="Обсуждение этой записи"
        />
      )}
      <Composer onSubmit={sendMessage} disabled={isSending} />
    </div>
  );
}
