import { Clock } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { ScreenHeader } from '../../app/ScreenHeader';
import { useFlushBuffer, useOnline, useRetryBuffer } from '../../state/retry';
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
  const flushBuffer = useFlushBuffer();
  const [flushing, setFlushing] = useState(false);

  // Досыл руками. До этого «Ждут отправки: N» был мёртвой надписью: автослив бывает только
  // на старте приложения и по событию 'online', и вернувшаяся сеть без этих событий
  // (спящий Wi-Fi, прокси) оставляла человека с единственным средством — перезагрузкой.
  // Лишним триггером гонки это не делает: flushNow сериализован (state/retry.ts).
  async function flushPending() {
    setFlushing(true);
    try {
      await flushBuffer();
    } finally {
      setFlushing(false);
    }
  }

  return (
    <div className="flex h-full flex-col">
      {pending > 0 && (
        <div className="flex justify-center pt-2">
          <button
            type="button"
            data-testid="pending-indicator"
            onClick={() => void flushPending()}
            // Офлайн и во время слива досылать нечем — кнопка гаснет, оставаясь тем же
            // статусом на экране.
            disabled={!online || flushing}
            // Имя включает видимый текст (WCAG 2.5.3 «Label in Name») и договаривает
            // действие: сама таблетка читается как статус, а нажатие — досыл.
            aria-label={`Ждут отправки: ${pending}. Отправить сейчас`}
            className="flex cursor-pointer items-center gap-1.5 rounded-full bg-surface-2 px-2.5 py-1 text-2xs text-text-secondary transition outline-hidden hover:opacity-90 focus-visible:ring-2 focus-visible:ring-accent/60 disabled:cursor-default disabled:opacity-60 disabled:hover:opacity-60"
          >
            <Clock size={11} aria-hidden />
            Ждут отправки: {pending}
          </button>
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
          // §2.4: чип уходит тем же путём, что и Composer этого экрана (fast-path → LLM).
          onPick={submit}
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
