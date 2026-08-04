import { X } from 'lucide-react';
import { Dialog as RD } from 'radix-ui';
import type { ReactNode } from 'react';

export function Dialog({
  open,
  onOpenChange,
  title,
  onOpenAutoFocus,
  children,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  title: string;
  /**
   * Куда встаёт фокус при открытии. Без него Radix берёт первый таб-стоп содержимого — а
   * это крестик «Закрыть», и модалка с одним полем открывалась бы «на выход». Вызывающий
   * гасит событие (preventDefault) и фокусирует своё; сигнатура — как у RD.Content.
   */
  onOpenAutoFocus?: (e: Event) => void;
  children: ReactNode;
}) {
  return (
    <RD.Root open={open} onOpenChange={onOpenChange}>
      <RD.Portal>
        <RD.Overlay className="fixed inset-0 z-50 bg-overlay" />
        <RD.Content
          onOpenAutoFocus={onOpenAutoFocus}
          // Radix проставляет content'у aria-describedby на свой Description, а его здесь
          // нет — ссылка вела бы в никуда, и скринридер объявлял бы описание, которого не
          // существует. Явный undefined снимает и ссылку, и предупреждение Radix.
          aria-describedby={undefined}
          className="fixed left-1/2 top-1/2 z-50 flex max-h-[85dvh] w-[min(92vw,28rem)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-card border border-line bg-surface p-4 shadow-pop"
        >
          <RD.Title className="pr-8 text-lg font-semibold">{title}</RD.Title>
          <RD.Close
            aria-label="Закрыть"
            className="absolute right-3 top-3 cursor-pointer rounded p-1 text-text-muted outline-hidden transition hover:bg-surface-2 hover:text-text focus-visible:ring-2 focus-visible:ring-accent/60"
          >
            <X size={16} />
          </RD.Close>
          {/* Скроллится СОДЕРЖИМОЕ, а не вся модалка: форма-редактор блока длиннее экрана,
              и уедь заголовок с крестиком вместе с ней — закрывать её было бы нечем, кроме
              Esc. min-h-0 обязателен: без него flex-ребёнок не сжимается ниже контента и
              overflow-y никогда не срабатывает. */}
          <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
        </RD.Content>
      </RD.Portal>
    </RD.Root>
  );
}
