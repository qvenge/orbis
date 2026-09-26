import { EllipsisVertical } from 'lucide-react';
import type { ComponentProps } from 'react';
import { Button } from '../../ui/Button';

/**
 * Кнопка меню ⋮ экрана записи. Хозяин у неё один — эагерный слот (`DetailMenuSlot` →
 * `ui/LazyMenuSlot`): кнопка стоит на экране с первого кадра и не подменяется при приезде
 * ленивого меню (Л-1: подмена заглушки настоящим триггером теряла жест и фокус). Листовым файлом —
 * чтобы эагерный чанк экрана не тянул за кнопкой ничего лишнего.
 *
 * Пропсы (включая `ref` — React 19) уходят в `Button` как есть: слот ставит на кнопку свои
 * обработчики, `aria-haspopup`/`aria-expanded` и ref (якорь списка, адресат возврата фокуса).
 */
export function MenuTrigger(props: ComponentProps<typeof Button>) {
  return (
    <Button
      size="icon"
      variant="ghost"
      aria-label="Меню"
      title="Меню"
      data-testid="detail-menu"
      {...props}
    >
      <EllipsisVertical size={16} aria-hidden />
    </Button>
  );
}
