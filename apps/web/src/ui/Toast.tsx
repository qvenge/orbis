import { Toast as RTo } from 'radix-ui';
import type { ReactNode } from 'react';
import { useToastStore } from './toast-store';

const toneClass = (tone: 'default' | 'danger') =>
  `rounded-control border border-line p-3 text-sm shadow-pop ${
    tone === 'danger' ? 'bg-danger text-danger-foreground' : 'bg-surface-2 text-text'
  }`;

export function ToastProvider({ children }: { children: ReactNode }) {
  return (
    <RTo.Provider swipeDirection="right">
      {children}
      <RTo.Viewport className="fixed bottom-4 right-4 z-50 flex w-80 flex-col gap-2" />
    </RTo.Provider>
  );
}

export function Toast({
  open,
  onOpenChange,
  title,
  tone = 'default',
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  title: string;
  tone?: 'default' | 'danger';
}) {
  return (
    <RTo.Root open={open} onOpenChange={onOpenChange} className={toneClass(tone)}>
      <RTo.Title>{title}</RTo.Title>
    </RTo.Root>
  );
}

/**
 * Стек тостов из toast-store (авто-dismiss живёт в сторе, поэтому Radix-таймер выключен
 * через duration=Infinity). type="background" → aria-live=polite, фокус не перехватывается.
 * Наведение и фокус внутри тоста ставят отсчёт стора на паузу: пока человек тянется к «Отменить»,
 * тост не уезжает из-под руки.
 */
export function Toaster() {
  const toasts = useToastStore((s) => s.toasts);
  const dismiss = useToastStore((s) => s.dismiss);
  const pause = useToastStore((s) => s.pause);
  const resume = useToastStore((s) => s.resume);
  return (
    <RTo.Provider swipeDirection="right" duration={Number.POSITIVE_INFINITY}>
      {toasts.map((t) => (
        <RTo.Root
          key={t.id}
          type="background"
          open
          onOpenChange={(o) => {
            if (!o) dismiss(t.id);
          }}
          onMouseEnter={() => pause(t.id)}
          onMouseLeave={() => resume(t.id)}
          onFocus={() => pause(t.id)}
          onBlur={() => resume(t.id)}
          className={toneClass(t.tone)}
        >
          <RTo.Title>{t.title}</RTo.Title>
          {t.action !== undefined && (
            <RTo.Action
              altText={t.action.label}
              className="mt-2 text-sm font-medium underline underline-offset-2"
              onClick={() => {
                t.action?.onSelect();
                dismiss(t.id);
              }}
            >
              {t.action.label}
            </RTo.Action>
          )}
        </RTo.Root>
      ))}
      <RTo.Viewport
        aria-live="polite"
        className="fixed bottom-4 right-4 z-[60] flex w-80 flex-col gap-2"
      />
    </RTo.Provider>
  );
}
