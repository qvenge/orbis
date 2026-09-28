import { ActiveScreen } from '../router';
import { AppSidebar } from './AppSidebar';
import { DesktopFrameContext } from './frame-kind';
import { HostButtons } from './HostButtons';
import { HostRail } from './HostRail';
import { SideChat } from './SideChat';
import { useSideChat } from './side-chat-store';
import { useIsWideDesktop } from './useWideDesktop';

/**
 * Рамка десктопа (спека 1б §6.3, Р-16 «совмещение»): `[рейка хоста 56px][сайдбар 240px][основная
 * область][боковой чат 380px, если открыт]`. Шапка содержимого «‹ · заголовок · ⋯» — присутствие
 * хоста в каждом экране (`HostPresence` в десктопной форме — по `DesktopFrameContext`); капсула
 * кнопок хоста — в правом нижнем углу ОСНОВНОЙ колонки (макет C «капсула на месте»): открытый
 * боковой чат её не закрывает, а `<main>` уже несёт отступ снизу под неё.
 *
 * Узкий десктоп (768–1099 px, гейт 25 m-4): рядом всем четырём колонкам места нет — на 768 px
 * основной области досталось бы ≈ 90 px, и капсула легла бы на сайдбар. Открытый боковой чат там
 * занимает место сайдбара: «данные видны» (§6.3) важнее навигации приложения, которая вернётся с
 * закрытием чата, а рейка хоста остаётся. Основной колонке — не уже 20rem.
 *
 * Модуль ЛЕНИВЫЙ (точка лени — `AppShell`): рейка, сайдбар и боковой чат нужны только ширине
 * десктопа, а входной чанк входит в замыкание экрана записи (порог R-36).
 */
export function DesktopFrame() {
  const sideChat = useSideChat((s) => s.open);
  const wide = useIsWideDesktop();
  return (
    <DesktopFrameContext.Provider value={true}>
      <div data-testid="desktop-frame" className="flex h-full bg-surface">
        <HostRail />
        {(wide || !sideChat) && <AppSidebar />}
        <div className="relative flex min-w-80 flex-1 flex-col">
          <ActiveScreen />
          <HostButtons />
        </div>
        {sideChat && <SideChat />}
      </div>
    </DesktopFrameContext.Provider>
  );
}
