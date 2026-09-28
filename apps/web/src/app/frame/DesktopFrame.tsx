import { useNav } from '../../state/navigation';
import { ReloadButton } from '../ChunkErrorBoundary';
import { ActiveScreen } from '../router';
import { AppSidebar } from './AppSidebar';
import { DesktopFrameContext } from './frame-kind';
import { HostButtons } from './HostButtons';
import { HostRail, HostRailFallback } from './HostRail';
import { PartBoundary } from './PartBoundary';
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
 * Части вне `<main>` (рейка, сайдбар, тело бокового чата) — под своими границами ошибок
 * (`PartBoundary`, гейт 25 I-1): упавшая часть — кадр на её месте, остальное живёт.
 *
 * Модуль ЛЕНИВЫЙ (точка лени — `AppShell`): рейка, сайдбар и боковой чат нужны только ширине
 * десктопа, а входной чанк входит в замыкание экрана записи (порог R-36).
 */
export function DesktopFrame() {
  const sideChat = useSideChat((s) => s.open);
  const wide = useIsWideDesktop();
  const activeApp = useNav((s) => s.model.activeApp);
  return (
    <DesktopFrameContext.Provider value={true}>
      <div data-testid="desktop-frame" className="flex h-full bg-surface">
        <PartBoundary fallback={<HostRailFallback />}>
          <HostRail />
        </PartBoundary>
        {(wide || !sideChat) && (
          <PartBoundary resetKey={activeApp} fallback={<SidebarFallback />}>
            <AppSidebar />
          </PartBoundary>
        )}
        <div className="relative flex min-w-80 flex-1 flex-col">
          <ActiveScreen />
          <HostButtons />
        </div>
        {sideChat && <SideChat />}
      </div>
    </DesktopFrameContext.Provider>
  );
}

/** Кадр упавшего сайдбара: место колонки и «Обновить»; смена приложения пробует заново. */
function SidebarFallback() {
  return (
    <div
      role="alert"
      className="flex w-60 shrink-0 flex-col items-center gap-3 border-r border-line bg-surface p-6 text-sm text-danger"
    >
      <span>Не удалось показать разделы</span>
      <ReloadButton />
    </div>
  );
}
