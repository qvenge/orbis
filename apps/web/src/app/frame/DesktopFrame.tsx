import { ActiveScreen } from '../router';
import { AppSidebar } from './AppSidebar';
import { HostButtons } from './HostButtons';
import { HostRail } from './HostRail';
import { SideChat } from './SideChat';
import { useSideChat } from './side-chat-store';

/**
 * Рамка десктопа (спека 1б §6.3, Р-16 «совмещение»): `[рейка хоста 56px][сайдбар 240px][основная
 * область][боковой чат 380px, если открыт]`. Шапка содержимого «‹ · заголовок · ⋯» — присутствие
 * хоста в каждом экране (`HostPresence` в десктопной форме); капсула кнопок хоста — в правом нижнем
 * углу ОСНОВНОЙ колонки (макет C «капсула на месте»): открытый боковой чат её не закрывает, а
 * `<main>` уже несёт отступ снизу под неё.
 *
 * Модуль ЛЕНИВЫЙ (точка лени — `AppShell`): рейка, сайдбар и боковой чат нужны только ширине
 * десктопа, а входной чанк входит в замыкание экрана записи (порог R-36).
 */
export function DesktopFrame() {
  const sideChat = useSideChat((s) => s.open);
  return (
    <div data-testid="desktop-frame" className="flex h-full bg-surface">
      <HostRail />
      <AppSidebar />
      <div className="relative flex min-w-0 flex-1 flex-col">
        <ActiveScreen />
        <HostButtons />
      </div>
      {sideChat && <SideChat />}
    </div>
  );
}
