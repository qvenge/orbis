import { EllipsisVertical } from 'lucide-react';
import type { ComponentProps } from 'react';
import { Button } from '../../ui/Button';

/**
 * Кнопка меню ⋮ экрана записи — отдельным листовым файлом, потому что у неё два хозяина:
 * эагерная заглушка (`DetailMenuSlot`, до загрузки меню) и триггер самого меню (`DetailMenu`, в
 * ленивом чанке). Одна кнопка в двух местах — одно лицо и одни ориентиры (`aria-label`,
 * `data-testid`) у обеих, и подмена заглушки настоящим триггером на экране не видна.
 *
 * Пропсы (включая `ref` — React 19) уходят в `Button` как есть: Radix ставит на триггер свои
 * обработчики и ref через `asChild`.
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
