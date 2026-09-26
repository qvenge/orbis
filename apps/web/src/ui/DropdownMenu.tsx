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
 * Выпадающее меню (Radix) в управляемой форме: «открыто» держит хозяин (`LazyMenuSlot`), кнопку
 * рисует тоже он. Меню живёт только в ленивых чанках (Radix — самый крупный кусок меню), а кнопка
 * эагерная и стоит на экране с первого кадра — поэтому триггер Radix ей отдать нельзя, и список
 * позиционируется от невидимого двойника кнопки (см. ниже).
 *
 * Меню намеренно бедное: только плоский список пунктов. Подменю, чекбоксы и радиогруппы
 * Radix умеет, но заводить их «на будущее» здесь нечем оправдать — появится нужда,
 * появится и код.
 */
export function DropdownMenu({
  items,
  open,
  onOpenChange,
  anchorRef,
}: { items: DropdownMenuItem[] } & LazyMenuControl) {
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
          {items.map((item) => (
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
          ))}
        </RDM.Content>
      </RDM.Portal>
    </RDM.Root>
  );
}
