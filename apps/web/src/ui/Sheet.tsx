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
        <RD.Overlay className="fixed inset-0 bg-black/50" />
        <RD.Content
          aria-label={title}
          className={`fixed top-0 ${pos} h-full w-[min(85vw,20rem)] border-line bg-surface p-4 shadow-pop`}
        >
          <RD.Title className="sr-only">{title}</RD.Title>
          {children}
        </RD.Content>
      </RD.Portal>
    </RD.Root>
  );
}
