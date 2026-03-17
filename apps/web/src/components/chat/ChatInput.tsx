import { useState, useRef, useCallback } from 'react';
import { SendHorizontal, Mic, MicOff } from 'lucide-react';
import { useVoiceInput } from '../../hooks/useVoiceInput.ts';

interface ChatInputProps {
  onSend: (text: string) => void;
  disabled?: boolean;
}

export function ChatInput({ onSend, disabled }: ChatInputProps) {
  const [text, setText] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement | undefined>(undefined);

  const handleTranscript = useCallback((transcript: string) => {
    setText((prev) => (prev ? prev + ' ' + transcript : transcript));
  }, []);

  const { isListening, isSupported, startListening, stopListening } = useVoiceInput(handleTranscript);

  const handleSend = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setText('');
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  }, [text, disabled, onSend]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleInput = () => {
    const el = textareaRef.current;
    if (el) {
      el.style.height = 'auto';
      el.style.height = Math.min(el.scrollHeight, 120) + 'px';
    }
  };

  return (
    <div className="flex h-14 shrink-0 items-center gap-2 border-t border-border px-4">
      <textarea
        ref={textareaRef as React.RefObject<HTMLTextAreaElement>}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={handleKeyDown}
        onInput={handleInput}
        placeholder="Ask Orbis anything..."
        disabled={disabled}
        rows={1}
        className="flex-1 resize-none bg-transparent py-2 text-sm text-text placeholder:text-text-muted focus:outline-none disabled:opacity-50"
      />
      {isSupported && (
        <button
          onClick={isListening ? stopListening : startListening}
          disabled={disabled}
          className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-colors duration-150 disabled:opacity-30 ${
            isListening
              ? 'animate-pulse bg-danger text-white'
              : 'text-text-muted hover:bg-surface-hover hover:text-text'
          }`}
        >
          {isListening ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
        </button>
      )}
      <button
        onClick={handleSend}
        disabled={disabled || !text.trim()}
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary text-white transition-colors duration-150 hover:bg-primary-dark disabled:opacity-30"
      >
        <SendHorizontal className="h-4 w-4" />
      </button>
    </div>
  );
}
