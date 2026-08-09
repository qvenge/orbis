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
  // Признак слива — из store: он один на приложение, и автослив (useRetryFlush) обязан
  // гасить эту кнопку так же, как её собственное нажатие.
  const flushing = useRetryBuffer((s) => s.flushing);
  const flushBuffer = useFlushBuffer();
  const [failed, setFailed] = useState(false);

  // Досыл руками. До этого «Ждут отправки: N» был мёртвой надписью: автослив бывает только
  // на старте приложения и по событию 'online', и вернувшаяся сеть без этих событий
  // (спящий Wi-Fi, прокси) оставляла человека с единственным средством — перезагрузкой.
  // Лишним триггером гонки это не делает: flushNow сериализован (state/retry.ts).
  async function flushPending() {
    const before = useRetryBuffer.getState().size;
    setFailed(false);
    await flushBuffer();
    // Главный сценарий кнопки — живой линк при мёртвом API: navigator.onLine тут говорит
    // «сеть есть», нажатие ничего не меняет, и без этой строки экран отвечал бы молчанием.
    setFailed(useRetryBuffer.getState().size >= before);
  }

  return (
    <div className="flex h-full flex-col">
      {pending > 0 && (
        <div className="flex flex-col items-center gap-1 pt-2">
          <button
            type="button"
            data-testid="pending-indicator"
            onClick={() => void flushPending()}
            // Офлайн и во время слива досылать нечем.
            disabled={!online || flushing}
            // Имя включает видимый текст (WCAG 2.5.3 «Label in Name») и договаривает
            // действие: сама таблетка читается как статус, а нажатие — досыл.
            aria-label={`Ждут отправки: ${pending}. Отправить сейчас`}
            // Что это кнопка, а не надпись, показывает рамка: hover и cursor на тач-экране
            // не существуют, а `active:` даёт отклик на палец. Неактивность обозначена
            // ПОТЕРЕЙ рамки, а не прозрачностью: приглушать нечего — цифра в этой таблетке
            // и есть вся её информация, и в офлайне она нужна не меньше.
            className="flex cursor-pointer items-center gap-1.5 rounded-full border border-line bg-surface-2 px-2.5 py-1 text-2xs text-text-secondary transition outline-hidden hover:bg-line/40 focus-visible:ring-2 focus-visible:ring-accent/60 active:bg-line/60 disabled:pointer-events-none disabled:cursor-default disabled:border-transparent"
          >
            <Clock size={11} aria-hidden />
            Ждут отправки: {pending}
          </button>
          {failed && (
            <span role="status" data-testid="pending-flush-failed" className="text-2xs text-danger">
              Отправить не вышло — сервер не ответил
            </span>
          )}
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
