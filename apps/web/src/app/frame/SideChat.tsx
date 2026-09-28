import { HOST_APP } from '@orbis/shared/nav';
import { X } from 'lucide-react';
import { ChatPanel } from '../../features/chat/ChatPanel';
import { ReloadButton } from '../ChunkErrorBoundary';
import { type FrameApp, FrameAppContext } from './FrameApp';
import { PartBoundary } from './PartBoundary';
import { useSideChat } from './side-chat-store';
import { useChatContext } from './useChatContext';

/**
 * Ссылки бокового чата — как из содержимого хоста (решение плана 13). Боковой чат — не элемент
 * истории (§7.3): ссылка ложится в стопку текущего раздела основной области, правило открытия — из
 * хоста; `host-screen` снял бы со стопки верхний экран, а чата в стопке нет. Модульная константа —
 * одно значение контекста на приложение.
 */
const SIDE_FRAME: FrameApp = { app: HOST_APP, via: 'content' };

/**
 * Боковой чат справа на десктопе (спека 1б §6.3, §6.4): 💬 открывает и закрывает его, данные основной
 * области видны, кнопки хоста на месте. Тело — тот же `ChatPanel`, что у экрана чата телефона; в поле
 * ввода — ссылка на текущее место основной области (меняется вслед за ним).
 */
export function SideChat() {
  const context = useChatContext('side');
  return (
    <aside
      aria-label="Чат"
      id="side-chat"
      className="flex w-[380px] shrink-0 flex-col border-l border-line bg-surface"
    >
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-line/70 px-4">
        <h2 className="min-w-0 flex-1 truncate text-sm font-medium">Чат</h2>
        <button
          type="button"
          aria-label="Закрыть"
          title="Закрыть"
          onClick={() => useSideChat.getState().close()}
          className="inline-flex size-9 cursor-pointer items-center justify-center rounded-full text-text-secondary transition hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
        >
          <X size={16} aria-hidden />
        </button>
      </header>
      <div className="flex min-h-0 flex-1 flex-col">
        {/* Упавшая карточка сообщения — кадр в колонке чата, а не белый экран (гейт 25, I-1):
            повторное открытие чата пробует заново (граница новая). */}
        <PartBoundary
          fallback={
            <div role="alert" className="flex flex-col items-center gap-3 p-6 text-sm text-danger">
              <span>Не удалось показать чат</span>
              <ReloadButton />
            </div>
          }
        >
          <FrameAppContext.Provider value={SIDE_FRAME}>
            <ChatPanel context={context} />
          </FrameAppContext.Provider>
        </PartBoundary>
      </div>
    </aside>
  );
}
