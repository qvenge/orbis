import { ArrowUp, X } from 'lucide-react';
import { type FormEvent, useState } from 'react';

/** Запись, про которую пишут: чип «Про: <заголовок>» над полем (спека 1б §6.4, РП-27). */
export interface ComposerContext {
  entityId: string;
  title: string;
}

/**
 * Поле ввода чата. С контекстом (`context`) над полем стоит снимаемый чип «Про: <заголовок>»: агент
 * получит ссылку на запись обычной ссылкой — отправку собирает хозяин поля по `contextId` в
 * `onSubmit`. Снятие держится, пока контекст тот же (ключ — `entityId`): между сообщениями чип не
 * возвращается, а новый контекст (другая запись в основной области) возвращает его.
 */
export function Composer({
  onSubmit,
  disabled,
  placeholder,
  context = null,
}: {
  onSubmit: (text: string, contextId: string | null) => void;
  disabled?: boolean;
  placeholder?: string;
  context?: ComposerContext | null;
}) {
  const [text, setText] = useState('');
  // Id записи, чей чип снят. Сравнение с текущим контекстом — прямо при рисовании: новый контекст
  // возвращает чип без эффекта (эффект показал бы кадр со снятым чипом у новой записи).
  const [removed, setRemoved] = useState<string | null>(null);
  if (removed !== null && removed !== context?.entityId) setRemoved(null);
  const chip = context !== null && removed !== context.entityId ? context : null;
  function submit(e: FormEvent) {
    e.preventDefault();
    const value = text.trim();
    if (!value) return;
    onSubmit(value, chip?.entityId ?? null);
    setText('');
  }
  const empty = text.trim().length === 0;
  return (
    // Плавающее поле ввода на листе (без border-t): рамка-капсула с кнопкой внутри.
    <form onSubmit={submit} className="px-4 pb-4 pt-1">
      {chip !== null && (
        <div className="mb-1.5 flex">
          <span
            data-testid="composer-context"
            className="inline-flex max-w-full items-center gap-1 rounded-full bg-surface-2 py-0.5 pr-0.5 pl-2.5 text-xs text-text-secondary"
          >
            <span className="min-w-0 truncate">Про: {chip.title}</span>
            <button
              type="button"
              aria-label="Убрать ссылку"
              onClick={() => setRemoved(chip.entityId)}
              className="inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-full transition hover:bg-line/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
            >
              <X size={12} aria-hidden />
            </button>
          </span>
        </div>
      )}
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
