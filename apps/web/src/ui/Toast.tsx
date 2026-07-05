import { Toast as RTo } from 'radix-ui';
import type { ReactNode } from 'react';

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
    <RTo.Root
      open={open}
      onOpenChange={onOpenChange}
      className={`rounded-control border border-line p-3 text-sm shadow-pop ${tone === 'danger' ? 'bg-danger text-danger-foreground' : 'bg-surface-2 text-text'}`}
    >
      <RTo.Title>{title}</RTo.Title>
    </RTo.Root>
  );
}
