import { X } from 'lucide-react';
import { Dialog as RD } from 'radix-ui';
import type { ReactNode } from 'react';

export function Sheet({
  open,
  onOpenChange,
  side = 'left',
  title,
  children,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  side?: 'left' | 'right';
  title: string;
  children: ReactNode;
}) {
  const pos = side === 'left' ? 'left-0' : 'right-0';
  return (
    <RD.Root open={open} onOpenChange={onOpenChange}>
      <RD.Portal>
        <RD.Overlay className="fixed inset-0 bg-overlay" />
        <RD.Content
          aria-label={title}
          className={`fixed top-0 ${pos} h-full w-[min(85vw,20rem)] border-line bg-surface p-4 shadow-pop`}
        >
          <RD.Title className="sr-only">{title}</RD.Title>
          <RD.Close
            aria-label="Закрыть"
            className="absolute right-3 top-3 cursor-pointer rounded p-1 text-text-muted outline-hidden transition hover:bg-surface-2 hover:text-text focus-visible:ring-2 focus-visible:ring-accent/60"
          >
            <X size={16} />
          </RD.Close>
          {children}
        </RD.Content>
      </RD.Portal>
    </RD.Root>
  );
}
