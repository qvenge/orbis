import { DropdownMenu } from '../../ui/DropdownMenu';
import type { ScreenMenuContentProps } from './ScreenMenu';

/**
 * Меню «⋯» экрана без своих пунктов (чат, настройки, «Не найдено», кадры загрузки и ошибки) — один
 * раздел «Хост» (спека 1б §6.4). Модуль ЛЕНИВЫЙ (`ScreenMenu` грузит его нажатием): Radix-меню
 * первому кадру ни к чему, кнопка «⋯» эагерная.
 */
export function HostMenu({ hostItems, ...control }: ScreenMenuContentProps) {
  return <DropdownMenu {...control} sections={[{ label: 'Хост', items: hostItems }]} />;
}
