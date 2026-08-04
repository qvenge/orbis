import { X } from 'lucide-react';
import { Dialog as RD } from 'radix-ui';
import { type ReactNode, useRef } from 'react';

/**
 * Опора последней открывавшейся модалки. Нужна на ЭСТАФЕТЕ: «Редактировать как текст»
 * закрывает форму и открывает строковый редактор, и к первому рендеру второй модалки фокус
 * стоит внутри первой — через миг её не будет в документе. Опорой такой элемент быть не
 * может, а настоящий открыватель (кнопка «Настроить») у обеих модалок один и тот же.
 *
 * Модуль, а не состояние компонента: модалки в эстафете — не родитель и ребёнок, а соседи
 * во времени, общего места для памяти у них нет. Устареть значение не может: при закрытии
 * опора проверяется на присутствие в документе.
 */
let handoffOpener: HTMLElement | null = null;

/** Кому вернуть фокус: то, что было в фокусе, а на эстафете модалок — опора предыдущей. */
function captureOpener(): HTMLElement | null {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || active === document.body) return handoffOpener;
  return active.closest('[role="dialog"]') === null ? active : handoffOpener;
}

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
  /**
   * Куда вернуть фокус при закрытии. Radix в модальном режиме гасит собственное
   * восстановление FocusScope (его onCloseAutoFocus безусловно делает preventDefault) и
   * фокусирует ТРИГГЕР — а триггера у этого примитива нет: модалку монтируют условно, и
   * RD.Trigger здесь не рендерится. Фокус уходил на <body>: после «Сохранить», «Отмена»,
   * Esc, крестика и клика по подложке до соседней кнопки надо было таббать с начала
   * страницы (на detail сидированного Daily Planning виджетов три).
   *
   * Опора снимается на первом рендере ОТКРЫТОЙ модалки — до того, как Radix увёл фокус
   * внутрь (его фокус-ловушка работает эффектом, то есть уже после этой строки). Открытие
   * этим не задето: onOpenAutoFocus остаётся целиком за вызывающим.
   */
  const opener = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);
  if (open && !wasOpen.current) {
    opener.current = captureOpener();
    handoffOpener = opener.current;
  }
  wasOpen.current = open;

  return (
    <RD.Root open={open} onOpenChange={onOpenChange}>
      <RD.Portal>
        <RD.Overlay className="fixed inset-0 z-50 bg-overlay" />
        <RD.Content
          onOpenAutoFocus={onOpenAutoFocus}
          onCloseAutoFocus={(e) => {
            // Опоры нет или её уже нет в документе (модалку открыли из того, что успело
            // перерисоваться) — не мешаем Radix: хуже, чем его <body>, не будет, а фокус
            // на оторванном узле просто пропал бы вместе с ним.
            const el = opener.current;
            if (el === null || !el.isConnected) return;
            e.preventDefault();
            el.focus();
          }}
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
