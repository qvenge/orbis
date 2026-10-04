import { lazy, Suspense } from 'react';
import { useChatContext } from '../../app/frame/useChatContext';
import { ScreenHeader } from '../../app/ScreenHeader';
import { ThreadSkeleton } from './MessageList';

const ChatPanel = lazy(() => import('./ChatPanel').then((m) => ({ default: m.ChatPanel })));

/**
 * Экран хоста «Чат» (`/chat`, спека 1б §6.4): шапка и тело чата (`ChatPanel`). Телефон открывает его
 * 💬 поверх текущего раздела (§7.3); в поле ввода — ссылка на место под ним (запись, страница,
 * домашняя), её можно убрать.
 */
export function ChatScreen() {
  const context = useChatContext('screen');
  return (
    <div className="flex h-full flex-col">
      <ScreenHeader title="Чат" />
      {/* Контент центрирован (шапка — на всю ширину main), скролл — внутри MessageList. */}
      <div className="mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col">
        <Suspense fallback={<ThreadSkeleton />}>
          <ChatPanel context={context} />
        </Suspense>
      </div>
    </div>
  );
}
