import { Clock } from 'lucide-react';
import { useState } from 'react';
import { ScreenHeader } from '../../app/ScreenHeader';
import { useFlushBuffer, useOnline, useRetryBuffer } from '../../state/retry';
import { Composer } from './Composer';
import { MessageList, ThreadSkeleton } from './MessageList';
import { useChatThread } from './useChatThread';
import { type EnsuredThread, EnsureFailedNotice, useEnsuredThread } from './useEnsuredThread';
import { useFastPath } from './useFastPath';

// Глобальный тред (§2.1): fast-path применяется только здесь (D-g — вкладка Chat).
//
// Тред заводится через `useEnsuredThread` — тем же способом, что и тред записи на detail. Способ
// не косметический: пока ответ ensure читался из `mutation.data`, экран под `<StrictMode>`
// оставался на скелетоне НАВСЕГДА (отписка снимает наблюдателя с мутации и обратно он не
// встаёт — подробности в самом хуке). В прод-сборке двойного прогона эффектов нет, поэтому
// болезнь была только девелоперской, — но разработка велась вслепую на пустом экране.
export function ChatScreen() {
  const { state, retry } = useEnsuredThread();
  return (
    <div className="flex h-full flex-col">
      <ScreenHeader title="Чат" />
      {/* Контент центрирован (шапка — на всю ширину main), скролл — внутри MessageList. */}
      <div className="mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col">
        <ChatBody state={state} onRetry={retry} />
      </div>
    </div>
  );
}

function ChatBody({ state, onRetry }: { state: EnsuredThread; onRetry: () => void }) {
  if (state.status === 'pending') return <ThreadSkeleton />;
  if (state.status === 'failed')
    return (
      <EnsureFailedNotice
        what="Не удалось открыть чат."
        message={state.message}
        onRetry={onRetry}
      />
    );
  return <ThreadView threadId={state.threadId} />;
}

function ThreadView({ threadId }: { threadId: string }) {
  const { messages, isLoading } = useChatThread(threadId);
  const { submit, reparse, retry, isSending } = useFastPath(threadId);
  const online = useOnline();
  const pending = useRetryBuffer((s) => s.size);

  return (
    <div className="flex h-full flex-col">
      {pending > 0 && <PendingFlush pending={pending} online={online} />}
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

/**
 * Индикатор «Ждут отправки: N» вместе с досылом. Отдельный компонент — РАДИ признака
 * неудачи: он обязан умирать вместе с индикатором. Пока `failed` жил в ThreadView, он
 * переживал опустевшую очередь — неудачный досыл, потом автослив по вернувшейся сети,
 * индикатор исчез, а признак остался, — и СЛЕДУЮЩАЯ офлайн-запись поднимала индикатор
 * сразу с красной строкой, хотя человек ничего не нажимал. Условие `pending > 0` у
 * вызывающего размонтирует этот компонент и уносит состояние с собой; чистить его
 * эффектом значило бы держать руками то, что даёт структура.
 */
function PendingFlush({ pending, online }: { pending: number; online: boolean }) {
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
    setFailed(false);
    try {
      // Неудача — это «подтверждено НОЛЬ», а не «очередь не укоротилась». Размер очереди
      // до и после врал: запись, легшая в буфер ВО ВРЕМЯ слива (fast-path кладёт и тут же
      // сливает), читалась как отказ, хотя досыл сработал. Главный сценарий кнопки при
      // этом сохранён: живой линк при мёртвом API даёт ноль подтверждённых, и экран
      // отвечает не молчанием. Частично удачный слив строки НЕ поднимает — сообщением о
      // нём остаётся сам счётчик: он показывает, сколько записей всё ещё ждут.
      setFailed((await flushBuffer()) === 0);
    } catch {
      // Слив отклонился (send бросил, а не вернул исход) — это тем более неудача. Без
      // catch она уходила бы unhandled rejection'ом, а строка состояния не поднималась.
      setFailed(true);
    }
  }

  return (
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
  );
}
