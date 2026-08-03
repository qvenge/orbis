import { DropdownMenu as RDM } from 'radix-ui';
import type { ReactNode } from 'react';

/**
 * Пункт меню. `label` — не только подпись, но и доступное имя пункта: меню читают
 * скринридером и ищут в тестах по `getByRole('menuitem', { name })`, поэтому иконка
 * рядом с ним всегда `aria-hidden` и имени не портит.
 */
export type DropdownMenuItem = {
  label: string;
  icon?: ReactNode;
  onSelect: () => void;
};

/**
 * Выпадающее меню (Radix). Триггер приходит целиком снаружи через `asChild` — так
 * примитив не решает за экран, как выглядит кнопка и какие у неё `aria-label`/testid,
 * и остаётся ровно тем, чем он есть: структурой «кнопка → всплывающий список действий».
 *
 * Меню намеренно бедное: только плоский список пунктов. Подменю, чекбоксы и радиогруппы
 * Radix умеет, но заводить их «на будущее» здесь нечем оправдать — появится нужда,
 * появится и код.
 */
export function DropdownMenu({
  trigger,
  items,
}: {
  trigger: ReactNode;
  items: DropdownMenuItem[];
}) {
  return (
    <RDM.Root>
      <RDM.Trigger asChild>{trigger}</RDM.Trigger>
      <RDM.Portal>
        <RDM.Content
          align="end"
          sideOffset={6}
          className="z-50 min-w-48 rounded-card border border-line bg-surface p-1 shadow-pop"
        >
          {items.map((item) => (
            <RDM.Item
              key={item.label}
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
