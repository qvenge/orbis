import { useFrameMenu } from '../../features/apps/frame-menu';
import { DropdownMenu } from '../../ui/DropdownMenu';
import type { ScreenMenuContentProps } from './ScreenMenu';

/**
 * Меню «⋯» экрана без своих пунктов (чат, настройки, «Не найдено», кадры загрузки и ошибки) — раздел
 * «Приложение «A»» рамки (`useFrameMenu`: «Настроить навигацию») и раздел «Хост» (спека 1б §6.4,
 * §9.3). Модуль ЛЕНИВЫЙ (`ScreenMenu` грузит его нажатием): Radix-меню и список приложений первому
 * кадру ни к чему, кнопка «⋯» эагерная.
 */
export function HostMenu({ hostItems, ...control }: ScreenMenuContentProps) {
  const frameMenu = useFrameMenu();
  return (
    <>
      <DropdownMenu
        {...control}
        sections={[...frameMenu.sections, { label: 'Хост', items: hostItems }]}
      />
      {frameMenu.element}
    </>
  );
}
