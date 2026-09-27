import { HostButtons } from './frame/HostButtons';
import { ActiveScreen } from './router';

/**
 * Каркас (спека 1б §6.2): содержимое экрана и кнопки хоста внизу справа — на месте прежнего нижнего
 * ряда вкладок (РП-19). Нижней навигации нет ни в одной форме (§6.1 правило зон): навигация — сверху,
 * в присутствии хоста. Десктоп в срезе 1б пока показывает ту же форму (рейка, сайдбар и боковой чат —
 * задача 25).
 */
export function AppShell() {
  return (
    <div className="flex h-full flex-col bg-surface">
      <ActiveScreen />
      <HostButtons />
    </div>
  );
}
