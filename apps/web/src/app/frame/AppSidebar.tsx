import { HOME_SECTION } from '@orbis/shared/nav';
import { useNav } from '../../state/navigation';
import { SectionList } from './SectionList';
import { useAppShell } from './useAppShell';

/**
 * Сайдбар навигации текущего приложения на десктопе (спека 1б §6.3): имя и иконка приложения, под
 * ними — его разделы (`SectionList`, общий с листом разделов телефона). Любая форма навигации на
 * десктопе — сайдбар: у «домашней как центр» разделы здесь те же, что плитки на её домашней.
 *
 * Светлый: это навигация приложения, а не хоста (§6.2 п. 5 — тёмное рисует только хост). Рамка — по
 * активному приложению модели (R-22).
 */
export function AppSidebar() {
  const model = useNav((s) => s.model);
  const app = model.activeApp;
  const section = Object.hasOwn(model.apps, app)
    ? (model.apps[app]?.activeSection ?? HOME_SECTION)
    : HOME_SECTION;
  const shell = useAppShell(app);
  return (
    <nav
      aria-label="Разделы"
      data-testid="app-sidebar"
      className="flex w-60 shrink-0 flex-col overflow-y-auto border-r border-line bg-surface p-2"
    >
      <div className="flex h-12 shrink-0 items-center gap-2 px-3 text-sm font-semibold">
        {shell.emoji && <span aria-hidden>{shell.emoji}</span>}
        <span className="min-w-0 truncate">{shell.title}</span>
      </div>
      <SectionList app={app} activeSection={section} />
    </nav>
  );
}
