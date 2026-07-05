import { Button } from '../../ui/Button';
import { Composer } from './Composer';
import { MessageList } from './MessageList';
import { useChatThread, useSendMessage } from './useChatThread';

// Общий чат-компонент (§2.2): используется глобальным тредом и тредом сущности (разный threadId).
export function ChatThread({ threadId }: { threadId: string }) {
  const { messages, fetchOlder, hasMore, isLoading } = useChatThread(threadId);
  const { sendMessage, isSending } = useSendMessage(threadId);
  return (
    <div className="flex h-full flex-col">
      {hasMore && (
        <Button variant="ghost" onClick={() => fetchOlder()} className="m-2 self-center">
          Загрузить ещё
        </Button>
      )}
      {isLoading ? (
        <div role="status" className="flex-1 p-3 text-sm text-text-muted">
          Загрузка…
        </div>
      ) : (
        <MessageList messages={messages} isTyping={isSending} />
      )}
      <Composer onSubmit={sendMessage} disabled={isSending} />
    </div>
  );
}
