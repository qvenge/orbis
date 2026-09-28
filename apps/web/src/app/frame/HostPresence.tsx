import { HOME_SECTION } from '@orbis/shared/nav';
import { ChevronDown, ChevronLeft, House } from 'lucide-react';
import { lazy, Suspense, useContext, useState } from 'react';
import { useNav, useShowBack } from '../../state/navigation';
import { DesktopFrameContext } from './frame-kind';
import { HOST_CONTROL, ScreenMenu } from './ScreenMenu';
import { sectionTitleOf, useAppShell } from './useAppShell';

/**
 * Лист разделов — после жеста, не первому кадру (РП-25): он нужен, когда владелец раскрыл «▾», а с
 * ним едут бейджи разделов и ярлыки «↗ Дом» (запрос страниц с «Домом»). Пока чанк едет — ничего:
 * «▾» уже отметил `aria-expanded`, лист встанет следующим кадром.
 */
const NavSheet = lazy(() => import('./NavSheet').then((m) => ({ default: m.NavSheet })));

/**
 * Присутствие хоста (спека 1б §6.1, §6.2 п. 1, §6.6): верхняя строка «‹ · иконка · раздел ▾ · ⌂ ⋯».
 * В рамке десктопа (§6.3, `DesktopFrameContext`) — шапка содержимого «‹ · заголовок · ⋯»: ⌂ живёт
 * в тёмной рейке хоста, «раздел ▾» — в сайдбаре навигации (`DesktopFrame`), и второй раз их здесь
 * нет. Роль каждого элемента хоста — атрибут `data-host` (`host-elements.ts`): тест двух ширин
 * сверяет один набор по ролям (С1б-7).
 * Рисует хост одинаково на ЛЮБОМ экране — её ставит `ScreenHeader`, который рисует каждый экран,
 * включая «Не найдено», кадр загрузки и кадр ошибки чанка (РП-19, Д-15), — и приложение не может её
 * спрятать или перекрыть: иначе оно «заперло» бы человека.
 *
 * Рамка — по активному приложению модели (R-22). «‹» — только когда есть куда (`useShowBack`), ⌂ —
 * «Домой» хоста одним переходом (R-23), «⋯» — одно меню экрана (§6.4). Навигация приложения — в форме
 * его оболочки: «список из заголовка» раскрывает лист разделов; у «домашней как центр» постоянной
 * навигации нет — заголовок без ▾ (разделы — плитки на домашней).
 */
export function HostPresence() {
  const model = useNav((s) => s.model);
  const app = model.activeApp;
  const section = Object.hasOwn(model.apps, app)
    ? (model.apps[app]?.activeSection ?? HOME_SECTION)
    : HOME_SECTION;
  const shell = useAppShell(app);
  const showBack = useShowBack();
  const [sheet, setSheet] = useState(false);
  // Форма — по рамке, а не по ширине: рамка телефона на ширине десктопа (чанк рамки десктопа едет
  // или отказал) рисует телефонную строку с ⌂ и «раздел ▾» (§6.6).
  const desktop = useContext(DesktopFrameContext);
  const withList = shell.navForm === 'header-list';
  const back = showBack && (
    <button
      type="button"
      aria-label="Назад"
      data-testid="host-back"
      data-host="back"
      onClick={() => useNav.getState().back()}
      className={HOST_CONTROL}
    >
      <ChevronLeft size={20} aria-hidden />
    </button>
  );

  if (desktop) {
    return (
      <div data-testid="host-presence" className="relative flex h-14 items-center gap-2 px-2">
        {back}
        <span className="min-w-0 truncate px-2 text-sm font-medium">
          {sectionTitleOf(shell, section)}
        </span>
        <span className="flex-1" />
        <ScreenMenu />
      </div>
    );
  }

  return (
    <div data-testid="host-presence" className="relative flex h-14 items-center gap-2 px-2">
      {back}
      <button
        type="button"
        data-testid="nav-switch"
        aria-haspopup={withList ? 'dialog' : undefined}
        aria-expanded={withList ? sheet : undefined}
        disabled={!withList}
        onClick={() => setSheet((v) => !v)}
        className="flex min-h-11 min-w-0 cursor-pointer items-center gap-1.5 rounded-full px-2 text-sm font-medium transition hover:bg-surface-2 disabled:cursor-default disabled:hover:bg-transparent"
      >
        {shell.emoji && <span aria-hidden>{shell.emoji}</span>}
        <span className="sr-only">{shell.title}</span>
        <span aria-hidden className="text-text-muted">
          ·
        </span>
        <span className="min-w-0 truncate">{sectionTitleOf(shell, section)}</span>
        {withList && <ChevronDown size={14} aria-hidden className="shrink-0 text-text-muted" />}
      </button>
      <span className="flex-1" />
      <button
        type="button"
        aria-label="Домой"
        data-testid="host-home"
        data-host="home"
        onClick={() => useNav.getState().goHome()}
        className={HOST_CONTROL}
      >
        <House size={18} aria-hidden />
      </button>
      <ScreenMenu />
      {sheet && withList && (
        <Suspense fallback={null}>
          <NavSheet app={app} activeSection={section} onClose={() => setSheet(false)} />
        </Suspense>
      )}
    </div>
  );
}
