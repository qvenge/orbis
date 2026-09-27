import { DropdownMenu as RDM } from 'radix-ui';
import type { ReactNode } from 'react';
import type { LazyMenuControl } from './LazyMenuSlot';

/**
 * Пункт меню. `label` — не только подпись, но и доступное имя пункта: меню читают
 * скринридером и ищут в тестах по `getByRole('menuitem', { name })`, поэтому иконка
 * рядом с ним всегда `aria-hidden` и имени не портит.
 */
export type DropdownMenuItem = {
  /**
   * Ключ React, когда подпись не уникальна: пункты, собранные из данных (по пункту на шаблон
   * владельца), могут совпасть подписью. Без него ключ — подпись.
   */
  key?: string;
  label: string;
  icon?: ReactNode;
  onSelect: () => void;
};

/**
 * Раздел меню с подписью — одно меню «⋯» рамки держит два: «Этот экран» и «Хост» (спека 1б §6.4).
 * Раздел читается группой с именем (`role="group"`), подпись видна над пунктами.
 */
export interface DropdownMenuSection {
  label: string;
  /**
   * Признак под подписью раздела — состояние, а не действие («Как в поставке» / «Изменено вами»,
   * спека 1б §9.1 п. 5). Не пункт меню: нажимать его нечего, а в списке пунктов он читался бы
   * командой.
   */
  note?: string;
  items: readonly DropdownMenuItem[];
}

/**
 * Выпадающее меню (Radix) в управляемой форме: «открыто» держит хозяин (`LazyMenuSlot`), кнопку
 * рисует тоже он. Меню живёт только в ленивых чанках (Radix — самый крупный кусок меню), а кнопка
 * эагерная и стоит на экране с первого кадра — поэтому триггер Radix ей отдать нельзя, и список
 * позиционируется от невидимого двойника кнопки (см. ниже).
 *
 * Меню намеренно бедное: плоский список пунктов или разделы с подписью. Подменю, чекбоксы и радиогруппы
 * Radix умеет, но заводить их «на будущее» здесь нечем оправдать — появится нужда,
 * появится и код.
 */
export function DropdownMenu({
  items,
  sections,
  open,
  onOpenChange,
  anchorRef,
  triggerId,
  contentId,
}: (
  | { items: readonly DropdownMenuItem[]; sections?: undefined }
  | { sections: readonly DropdownMenuSection[]; items?: undefined }
) &
  LazyMenuControl) {
  return (
    <RDM.Root open={open} onOpenChange={onOpenChange}>
      <RDM.Trigger asChild>
        {/* Radix позиционирует список от своего Trigger. Кнопку слота отдать ему нельзя: она
            эагерная, а Radix — в ленивом чанке. Двойник накрывает обёртку слота (absolute
            inset-0) — прямоугольник тот же, жесты идут в кнопку. */}
        <span
          aria-hidden
          tabIndex={-1}
          data-testid="menu-anchor"
          className="pointer-events-none absolute inset-0"
        />
      </RDM.Trigger>
      <RDM.Portal>
        <RDM.Content
          // Пропсы Content идут у Radix ПОСЛЕ его собственных `id`/`aria-labelledby` и перекрывают
          // их: список назван кнопкой слота, а не безымянным двойником (`LazyMenuControl`).
          id={contentId}
          aria-labelledby={triggerId}
          align="end"
          sideOffset={6}
          // Фокус при закрытии — стабильной кнопке слота, а не двойнику: двойник невидим и
          // вне порядка табуляции, фокус на нём потерялся бы для клавиатуры.
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            anchorRef.current?.focus();
          }}
          className="z-50 min-w-48 rounded-card border border-line bg-surface p-1 shadow-pop"
        >
          {sections === undefined
            ? items.map(menuItem)
            : sections
                // Пустой раздел не рисуется: подпись без пунктов обещала бы действия, которых нет.
                .filter((sec) => sec.items.length > 0)
                .map((sec, i) => (
                  <RDM.Group key={sec.label} aria-label={sec.label}>
                    {i > 0 && <RDM.Separator className="my-1 h-px bg-line" />}
                    <RDM.Label className="px-2 pb-0.5 pt-1 text-2xs uppercase tracking-wide text-text-muted">
                      {sec.label}
                    </RDM.Label>
                    {sec.note !== undefined && (
                      <p data-testid="menu-note" className="px-2 pb-1 text-xs text-text-secondary">
                        {sec.note}
                      </p>
                    )}
                    {sec.items.map(menuItem)}
                  </RDM.Group>
                ))}
        </RDM.Content>
      </RDM.Portal>
    </RDM.Root>
  );
}

function menuItem(item: DropdownMenuItem) {
  return (
    <RDM.Item
      key={item.key ?? item.label}
      onSelect={item.onSelect}
      // data-highlighted Radix ставит и на наведение мышью, и на переход
      // стрелками — подсветка одна на оба способа.
      className="flex cursor-pointer select-none items-center gap-2 rounded-control px-2 py-1.5 text-sm text-text outline-hidden transition data-[highlighted]:bg-surface-2 data-[highlighted]:text-text"
    >
      {item.icon}
      {item.label}
    </RDM.Item>
  );
}
