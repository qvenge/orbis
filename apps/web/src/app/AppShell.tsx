import { ActiveScreen, TabBar } from './router';
import { SidebarNav } from './SidebarNav';

// Двухрежимный каркас: sidebar на десктопе (внутри hidden md:flex),
// tab-bar на мобиле (внутри md:hidden). jsdom не применяет media queries —
// в тестах присутствуют обе поверхности, поэтому testid у них разные.
export function AppShell() {
  return (
    <div className="flex h-full">
      <SidebarNav />
      <div className="flex min-w-0 flex-1 flex-col">
        <ActiveScreen />
        <TabBar />
      </div>
    </div>
  );
}
