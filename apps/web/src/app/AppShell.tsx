import { ActiveScreen, TabBar } from './router';
import { SidebarNav } from './SidebarNav';

// Двухрежимный каркас: sidebar на десктопе (внутри hidden md:flex),
// tab-bar на мобиле (внутри md:hidden). jsdom не применяет media queries —
// в тестах присутствуют обе поверхности, поэтому testid у них разные.
export function AppShell() {
  return (
    <div className="flex h-full">
      <SidebarNav />
      {/* Контентная колонка — «белый лист» (bg-surface) на фоне «бумажного» sidebar (bg-bg):
          зоны читаются без разделительных линий, как в Notion. */}
      <div className="flex min-w-0 flex-1 flex-col bg-surface">
        <ActiveScreen />
        <TabBar />
      </div>
    </div>
  );
}
