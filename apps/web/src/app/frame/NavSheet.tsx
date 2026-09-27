import { HOME_PROPERTY } from '@orbis/shared';
import { type AppKey, HOST_APP } from '@orbis/shared/nav';
import { useMemo } from 'react';
import { createPortal } from 'react-dom';
import { HOMED_PAGES_QUERY, useApps } from '../../features/apps/useApps';
import { useBadgeData } from '../../lib/query-blocks/useBadgeData';
import { useNav } from '../../state/navigation';
import { trpc } from '../../trpc';
import { NavBadge } from '../../ui/NavBadge';
import { type ShellSection, useAppShell } from './useAppShell';

/**
 * Лист разделов формы «список из заголовка» (спека 1б §6.2 п. 2, §9.3): заголовок шапки
 * «иконка · раздел ▾» раскрывает сверху разделы приложения — заголовок, эмодзи, бейдж, «где
 * остановились» («Upcoming · Купить хлеб»). Архивный раздел — строка-плашка «в архиве», не пустота
 * (§4.4, §6.6). Оболочка хоста по эталону — плашка над списком (§6.6).
 *
 * Бейджи — только пока лист открыт и все одной пачкой `entity.blocks` (`useBadgeData`, РП-8): на
 * холодном старте лист закрыт, и запроса за бейджами нет (С1б-16).
 *
 * Лист и подложка — порталом в `body`, а не внутри шапки: у шапки `backdrop-blur`, а
 * `backdrop-filter` делает элемент containing block для `fixed`-потомков (Filter Effects L2) —
 * подложка покрыла бы одну шапку, касание по экрану лист не закрывало бы, а капсула кнопок хоста
 * ложилась бы поверх листа (гейт 19, Fable M-5). Слои: кнопки хоста `z-30` < подложка `z-40` <
 * лист `z-50`. Лист стоит под строкой присутствия хоста (её высота — `h-14`).
 *
 * Раздел, чей «Дом» — другое приложение (или хост), — ярлык «↗ <Дом>» (§4.3, §7.2): страница
 * открывается в рамке своего дома, откуда бы ни пришла ссылка, и нажатие ведёт туда сразу, а не
 * через стопку этого приложения. «Дом» разделов — узким запросом страниц с «Домом»
 * (`HOMED_PAGES_QUERY`) и оболочкой хоста, только пока лист открыт (С1б-16).
 */
export function NavSheet({
  app,
  activeSection,
  onClose,
}: {
  app: AppKey;
  activeSection: string;
  onClose: () => void;
}) {
  const shell = useAppShell(app, { withStoppedAt: true });
  const apps = useApps();
  const host = useAppShell(HOST_APP);
  const homed = trpc.entity.query.useQuery({ query: HOMED_PAGES_QUERY });
  /**
   * Раздел → приложение его дома, если это не `app` (гейт 20, m-2, m-5):
   *  - страница с «Домом» (узкий запрос) — её дом; «Дом» = оболочка хоста читается как хост;
   *  - раздел навигации или домашняя хоста без «Дома» — хост: такие страницы не бездомные (§4.3), в
   *    чужом приложении они ярлык «↗ Orbis»;
   *  - прочее (не-страница, бездомная страница) — обычный раздел этого приложения: у записи «Дома» нет.
   */
  const foreign = useMemo(() => {
    const out = new Map<string, AppKey>();
    if (app !== HOST_APP) {
      for (const id of [...host.sections.map((s) => s.id), host.home ?? host.homeArchived?.id]) {
        if (id !== undefined && id !== null) out.set(id, HOST_APP);
      }
    }
    for (const r of homed.data ?? []) {
      const h = r.props[HOME_PROPERTY];
      const key = typeof h === 'string' && h !== '' && h !== apps.hostShell?.id ? h : HOST_APP;
      if (key !== app) out.set(r.id, key);
      else out.delete(r.id);
    }
    return out;
  }, [homed.data, apps.hostShell, app, host.sections, host.home, host.homeArchived]);
  const titleOf = (key: AppKey) =>
    key === HOST_APP ? (apps.hostShell?.title ?? 'Orbis') : (apps.byId.get(key)?.title ?? '…');
  const openSection = (id: string) => {
    onClose();
    const home = foreign.get(id);
    if (home === undefined) useNav.getState().openSection(app, id);
    else useNav.getState().openRecord(id, { app: home });
  };
  return createPortal(
    <>
      {/* Подложка: касание мимо листа закрывает его. */}
      <button
        type="button"
        aria-label="Закрыть разделы"
        data-testid="nav-sheet-backdrop"
        tabIndex={-1}
        onClick={onClose}
        className="fixed inset-0 z-40 cursor-default bg-overlay/20"
      />
      <div
        role="dialog"
        aria-label="Разделы"
        data-testid="nav-sheet"
        className="fixed inset-x-2 top-15 z-50 mx-auto max-h-[70vh] max-w-3xl overflow-y-auto rounded-card border border-line bg-surface p-1 shadow-pop"
      >
        {shell.fromEtalon && (
          <p
            role="status"
            data-testid="shell-etalon-plaque"
            className="m-1 rounded-control bg-surface-2 px-3 py-2 text-xs text-text-secondary"
          >
            Оболочка хоста повреждена — показан эталон поставки
          </p>
        )}
        <ul className="flex flex-col gap-px">
          {shell.sections.map((s) => (
            <li key={s.id}>
              {s.archived ? (
                <ArchivedRow section={s} />
              ) : (
                <SectionRow
                  section={s}
                  active={s.id === activeSection}
                  home={foreign.has(s.id) ? titleOf(foreign.get(s.id) as AppKey) : null}
                  onOpen={() => openSection(s.id)}
                />
              )}
            </li>
          ))}
        </ul>
      </div>
    </>,
    document.body,
  );
}

function SectionRow({
  section,
  active,
  home,
  onOpen,
}: {
  section: ShellSection;
  active: boolean;
  /** Заголовок чужого дома раздела — ярлык «↗ Дом»; `null` — раздел этого приложения. */
  home: string | null;
  onOpen: () => void;
}) {
  const { badge } = useBadgeData(section.id);
  return (
    <button
      type="button"
      data-testid={`nav-section-${section.id}`}
      aria-current={active ? 'page' : undefined}
      onClick={onOpen}
      className={`flex min-h-11 w-full cursor-pointer items-center gap-2 rounded-control px-3 py-2 text-left text-sm transition hover:bg-surface-2 ${
        active ? 'bg-surface-2 font-medium' : ''
      }`}
    >
      {section.emoji && <span aria-hidden>{section.emoji}</span>}
      <span className="min-w-0 flex-1 truncate">
        {section.title}
        {section.stoppedAt !== null && (
          <span className="text-text-secondary"> · {section.stoppedAt}</span>
        )}
      </span>
      {home !== null && <span className="text-xs text-text-muted">↗ {home}</span>}
      <NavBadge count={badge} label="в разделе" data-testid={`nav-badge-${section.id}`} />
    </button>
  );
}

function ArchivedRow({ section }: { section: ShellSection }) {
  return (
    <div
      data-testid={`nav-section-${section.id}`}
      data-archived=""
      className="flex min-h-11 items-center gap-2 rounded-control px-3 py-2 text-sm text-text-muted"
    >
      {section.emoji && <span aria-hidden>{section.emoji}</span>}
      <span className="min-w-0 flex-1 truncate">{section.title}</span>
      <span className="rounded-full bg-surface-2 px-2 py-0.5 text-2xs">в архиве</span>
    </div>
  );
}
