import { useEffect, useRef } from 'react';
import { Infinity } from 'lucide-react';
import { useChatStore } from '../../stores/chat.ts';
import { useNavigationStore } from '../../stores/navigation.ts';
import { ChatMessage } from './ChatMessage.tsx';
import { ChatInput } from './ChatInput.tsx';

export function ChatPanel() {
  const { messages, isLoading, sendMessage } = useChatStore();
  const openEntity = useNavigationStore((s) => s.openEntity);
  const messagesEndRef = useRef<HTMLDivElement | undefined>(undefined);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  return (
    <div className="flex h-full flex-col bg-surface">
      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4">
        {messages.length === 0 ? (
          <div className="flex h-full items-center justify-center">
            <div className="text-center">
              <Infinity className="mx-auto h-8 w-8 text-text-muted" strokeWidth={1.5} />
              <p className="mt-3 text-sm text-text-secondary">
                Ask me to create tasks, track expenses, or organize anything.
              </p>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            {messages.map((msg) => (
              <ChatMessage
                key={msg.id}
                message={msg}
                onSuggestionSelect={sendMessage}
                onEntityClick={openEntity}
              />
            ))}
            {isLoading && (
              <div className="flex justify-start" aria-live="polite" aria-label="Loading response">
                <div className="px-3 py-2">
                  <span className="inline-flex gap-0.5 text-text-muted">
                    <span className="animate-pulse">.</span>
                    <span className="animate-pulse delay-[200ms]">.</span>
                    <span className="animate-pulse delay-[400ms]">.</span>
                  </span>
                </div>
              </div>
            )}
            <div ref={messagesEndRef as React.RefObject<HTMLDivElement>} />
          </div>
        )}
      </div>

      {/* Input */}
      <ChatInput onSend={sendMessage} disabled={isLoading} />
    </div>
  );
}
