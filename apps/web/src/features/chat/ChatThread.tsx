import { Button } from '../../ui/Button';
import { Composer } from './Composer';
import { MessageList } from './MessageList';
import { ThreadSkeleton } from './ThreadSkeleton';
import { useChatThread, useSendMessage } from './useChatThread';
import { type EnsuredThread, EnsureFailedNotice } from './useEnsuredThread';

export function OpenedChatThread({ state, retry }: { state: EnsuredThread; retry: () => void }) {
  if (state.status === 'pending') return <ThreadSkeleton />;
  if (state.status === 'failed')
    return (
      <EnsureFailedNotice
        what="Не удалось открыть тред записи."
        message={state.message}
        onRetry={retry}
      />
    );
  return <ChatThread threadId={state.threadId} />;
}

// Общий чат-компонент (§2.2): используется глобальным тредом и тредом сущности (разный threadId).
export function ChatThread({ threadId }: { threadId: string }) {
  const { messages, fetchOlder, hasMore, hasTail, error, retry } = useChatThread(threadId);
  const { sendMessage, isSending, retryMessage } = useSendMessage(threadId);
  return (
    <div className="flex h-full flex-col">
      {hasMore && (
        <Button variant="ghost" onClick={() => fetchOlder()} className="m-2 self-center">
          Загрузить ещё
        </Button>
      )}
      {error ? (
        <EnsureFailedNotice
          what="Не удалось прочитать тред."
          message={error.message}
          onRetry={retry}
        />
      ) : !hasTail ? (
        <ThreadSkeleton />
      ) : (
        // §7.9: тред detail тоже отдаёт «Повторить» (onRetry) при сбое ai.sendMessage.
        // Тред сущности — без fast-path-подсказки: даём контекстную подпись обсуждения.
        <MessageList
          messages={messages}
          isTyping={isSending}
          onRetry={retryMessage}
          // §2.4: чип уходит тем же путём, что и Composer этого экрана (ai.sendMessage).
          onPick={sendMessage}
          emptyHint="Обсуждение этой записи"
        />
      )}
      <Composer onSubmit={sendMessage} disabled={isSending} />
    </div>
  );
}

/**
 * Лента треда только для чтения — предпросмотр шаблона на чужой записи (1а новое-5): сообщения и
 * подгрузка старых есть, поля ввода, повтора отправки, чипов-продолжений и действий карточек
 * («Отменить», «Подтвердить», ответы и решения — `CardHandlers.readOnly`) нет. Тред не заводится
 * (`chat.ensureThread` — мутация): у треда, который не открывали, строки нет, и лента честно пуста.
 */
export function ChatFeed({ threadId }: { threadId: string }) {
  const { messages, fetchOlder, hasMore, hasTail, error, retry } = useChatThread(threadId);
  return (
    <div className="flex h-full flex-col">
      {hasMore && (
        <Button variant="ghost" onClick={() => fetchOlder()} className="m-2 self-center">
          Загрузить ещё
        </Button>
      )}
      {error ? (
        <EnsureFailedNotice
          what="Не удалось прочитать тред."
          message={error.message}
          onRetry={retry}
        />
      ) : !hasTail ? (
        <ThreadSkeleton />
      ) : (
        <MessageList
          messages={messages}
          isTyping={false}
          emptyHint="Обсуждение этой записи"
          readOnly
        />
      )}
    </div>
  );
}
