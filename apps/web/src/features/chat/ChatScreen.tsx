import { lazy, Suspense } from 'react';
import { useChatContext } from '../../app/frame/useChatContext';
import { ScreenHeader } from '../../app/ScreenHeader';
import type { ComposerContext } from './Composer';
import { ThreadSkeleton } from './ThreadSkeleton';
import { useEnsuredThread } from './useEnsuredThread';

const ChatPanel = lazy(() => import('./ChatPanel').then((m) => ({ default: m.ChatPanel })));

// The hook commits outside Suspense, so the POST starts while the panel chunk is loading.
export function GlobalChat({ context }: { context: ComposerContext | null }) {
  const opening = useEnsuredThread();
  return (
    <Suspense fallback={<ThreadSkeleton />}>
      <ChatPanel context={context} {...opening} />
    </Suspense>
  );
}

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
        <GlobalChat context={context} />
      </div>
    </div>
  );
}
