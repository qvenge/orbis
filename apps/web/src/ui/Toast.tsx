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
 * Стек тостов из toast-store (авто-dismiss 4s живёт в сторе, поэтому Radix-таймер выключен
 * через duration=Infinity). type="background" → aria-live=polite, фокус не перехватывается.
 */
export function Toaster() {
  const toasts = useToastStore((s) => s.toasts);
  const dismiss = useToastStore((s) => s.dismiss);
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
          className={toneClass(t.tone)}
        >
          <RTo.Title>{t.title}</RTo.Title>
        </RTo.Root>
      ))}
      <RTo.Viewport
        aria-live="polite"
        className="fixed bottom-4 right-4 z-50 flex w-80 flex-col gap-2"
      />
    </RTo.Provider>
  );
}
