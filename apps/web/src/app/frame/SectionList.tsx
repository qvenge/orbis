import { HOME_PROPERTY } from '@orbis/shared';
import { type AppKey, buildAddress, currentEntry, HOST_APP, navReduce } from '@orbis/shared/nav';
import { useMemo } from 'react';
import { HOMED_PAGES_QUERY, useApps } from '../../features/apps/useApps';
import { RecordLink } from '../../lib/entity-ref/RecordLink';
import { useBadgeData } from '../../lib/query-blocks/useBadgeData';
import { sectionRoot, useNav } from '../../state/navigation';
import { trpc } from '../../trpc';
import { NavBadge } from '../../ui/NavBadge';
import { type ShellSection, useAppShell } from './useAppShell';

/**
 * Строки разделов приложения (спека 1б §6.2 п. 2, §6.3, §9.3) — общий код листа разделов телефона
 * (`NavSheet`) и сайдбара десктопа (`AppSidebar`): одна навигация, две формы показа. Строка —
 * заголовок, эмодзи, бейдж, «где остановились» («Повестка · Купить хлеб»); архивный раздел —
 * строка-плашка «в архиве», не пустота (§4.4, §6.6); оболочка хоста по эталону — плашка над списком
 * (§6.6).
 *
 * Бейджи — в строке, `useBadgeData` (РП-8, гейт 19 M-3): все строки одного кадра уходят одной
 * пачкой `entity.blocks`, и только там, где строки нарисованы (лист открыт или десктоп).
 *
 * Раздел, чей «Дом» — другое приложение (или хост), — ярлык «↗ <Дом>» (§4.3, §7.2): страница
 * открывается в рамке своего дома, откуда бы ни пришла ссылка, и нажатие ведёт туда сразу, а не
 * через стопку этого приложения. «Дом» разделов — узким запросом страниц с «Домом»
 * (`HOMED_PAGES_QUERY`) и оболочкой хоста, а не запросом всех страниц (гейт 20, m-5).
 *
 * `onPicked` — хозяину строк (лист закрывается выбором раньше перехода).
 */
export function SectionList({
  app,
  activeSection,
  onPicked,
}: {
  app: AppKey;
  activeSection: string;
  onPicked?: () => void;
}) {
  const model = useNav((s) => s.model);
  const mode = useNav((s) => s.mode);
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
    for (const r of homed.data?.rows ?? []) {
      const h = r.props[HOME_PROPERTY];
      const key = typeof h === 'string' && h !== '' && h !== apps.hostShell?.id ? h : HOST_APP;
      if (key !== app) out.set(r.id, key);
      else out.delete(r.id);
    }
    return out;
  }, [homed.data, apps.hostShell, app, host.sections, host.home, host.homeArchived]);
  const titleOf = (key: AppKey) =>
    key === HOST_APP ? (apps.hostShell?.title ?? 'Orbis') : (apps.byId.get(key)?.title ?? '…');
  const targetOf = (id: string) => {
    const home = foreign.get(id);
    // У ярлыка чужого дома и у формы home-hub переход идёт в обычную стопку.
    const linkApp = home ?? (shell.navForm === 'home-hub' ? app : undefined);
    if (linkApp !== undefined) return { id, app: linkApp };
    // Для раздела ссылка и предзагрузка ведут туда же, куда реальное действие:
    // на корень активного раздела или на последнее место другого раздела.
    const action = { type: 'section' as const, app, section: id, root: sectionRoot(app, id) };
    const address = currentEntry(navReduce(model, action, mode).model).address;
    return address.kind === 'record' ? { id: address.id, href: buildAddress(address) } : undefined;
  };
  const selectSection = (id: string) => useNav.getState().openSection(app, id);
  return (
    <>
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
                target={targetOf(s.id)}
                onPicked={onPicked}
                selectSection={() => selectSection(s.id)}
              />
            )}
          </li>
        ))}
      </ul>
    </>
  );
}

function SectionRow({
  section,
  active,
  home,
  target,
  onPicked,
  selectSection,
}: {
  section: ShellSection;
  active: boolean;
  /** Заголовок чужого дома раздела — ярлык «↗ Дом»; `null` — раздел этого приложения. */
  home: string | null;
  target?: { id: string; app?: AppKey; href?: string };
  onPicked?: () => void;
  selectSection: () => void;
}) {
  const { badge } = useBadgeData(section.id);
  const attributes = {
    'data-testid': `nav-section-${section.id}`,
    'aria-current': active ? ('page' as const) : undefined,
    className: `flex min-h-11 w-full cursor-pointer items-center gap-2 rounded-control px-3 py-2 text-left text-sm transition hover:bg-surface-2 ${
      active ? 'bg-surface-2 font-medium' : ''
    }`,
  };
  const label = (
    <>
      {section.emoji && <span aria-hidden>{section.emoji}</span>}
      <span className="min-w-0 flex-1 truncate">
        {section.title}
        {section.stoppedAt !== null && (
          <span className="text-text-secondary"> · {section.stoppedAt}</span>
        )}
      </span>
      {home !== null && <span className="text-xs text-text-muted">↗ {home}</span>}
      <NavBadge count={badge} label="в разделе" data-testid={`nav-badge-${section.id}`} />
    </>
  );
  if (target)
    return (
      <RecordLink
        {...attributes}
        {...target}
        onOpen={(_id, proceed) => {
          onPicked?.();
          proceed(target.app === undefined ? selectSection : undefined);
        }}
      >
        {label}
      </RecordLink>
    );
  return (
    <button
      type="button"
      {...attributes}
      onClick={() => {
        onPicked?.();
        selectSection();
      }}
    >
      {label}
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
