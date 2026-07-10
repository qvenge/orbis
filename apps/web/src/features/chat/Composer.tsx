import { ArrowUp } from 'lucide-react';
import { type FormEvent, useState } from 'react';

export function Composer({
  onSubmit,
  disabled,
  placeholder,
}: {
  onSubmit: (text: string) => void;
  disabled?: boolean;
  placeholder?: string;
}) {
  const [text, setText] = useState('');
  function submit(e: FormEvent) {
    e.preventDefault();
    const value = text.trim();
    if (!value) return;
    onSubmit(value);
    setText('');
  }
  const empty = text.trim().length === 0;
  return (
    // Плавающее поле ввода на листе (без border-t): рамка-капсула с кнопкой внутри.
    <form onSubmit={submit} className="px-4 pb-4 pt-1">
      <div className="flex items-center gap-2 rounded-2xl border border-line bg-surface py-1.5 pl-4 pr-1.5 shadow-control transition focus-within:border-accent/60 focus-within:ring-2 focus-within:ring-accent/15">
        <input
          aria-label="Сообщение"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={placeholder ?? 'Напишите сообщение…'}
          className="min-w-0 flex-1 bg-transparent py-1.5 text-sm text-text outline-none placeholder:text-text-muted"
        />
        <button
          type="submit"
          disabled={disabled || empty}
          aria-label="Отправить"
          className="flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-full bg-accent text-accent-foreground transition hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 disabled:cursor-default disabled:bg-surface-2 disabled:text-text-muted"
        >
          <ArrowUp size={16} aria-hidden />
        </button>
      </div>
    </form>
  );
}
