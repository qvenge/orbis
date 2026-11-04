import { APP_EXTENSIONS, isValidTimeZone } from '@orbis/shared';
import { useQueryClient } from '@tanstack/react-query';
import { getQueryKey } from '@trpc/react-query';
import { APPS_QUERY } from '../../features/apps/useApps';
import { useFreshnessScreen } from '../../lib/freshness/screen';
import { useNav } from '../../state/navigation';
import { trpc } from '../../trpc';

export function FreshnessStatus() {
  const screen = useFreshnessScreen();
  if (!screen) return null;
  return <Status screen={screen} />;
}

function Status({ screen }: { screen: NonNullable<ReturnType<typeof useFreshnessScreen>> }) {
  const activeApp = useNav((s) => s.model.activeApp);
  const cache = useQueryClient();
  const settings = cache.getQueryData<{
    disabledModules?: string[];
    timezone?: string;
  }>(getQueryKey(trpc.user.getSettings, undefined, 'query'));
  const app = cache
    .getQueryData<{ rows: { id: string; props: Record<string, unknown> }[] }>(
      getQueryKey(trpc.entity.query, { query: APPS_QUERY }, 'query'),
    )
    ?.rows.find((row) => row.id === activeApp);
  const extensions = app?.props[APP_EXTENSIONS];
  const finance =
    (screen.finance || (Array.isArray(extensions) && extensions.includes('finance'))) &&
    !settings?.disabledModules?.includes('finance');

  let label: string;
  if (!screen.online) {
    if (screen.receivedAt === null) label = 'нет сети · нет сохранённой копии';
    else {
      const time = new Intl.DateTimeFormat('ru', {
        hour: '2-digit',
        minute: '2-digit',
        timeZone:
          settings?.timezone && isValidTimeZone(settings.timezone) ? settings.timezone : undefined,
      }).format(screen.receivedAt);
      const missing = screen.hasCopy ? '' : ' · часть данных недоступна';
      label = `нет сети · экран на ${time}${missing}`;
    }
  } else if (screen.updating) label = 'обновляется';
  else if (screen.old) label = 'данные старше 4 часов';
  else return null;

  const noticeable = screen.old || (!screen.online && finance);
  return (
    <span
      role="status"
      className={
        noticeable
          ? 'ml-2 rounded border border-line bg-surface-2 px-2 py-0.5 text-xs text-text'
          : 'ml-2 text-xs text-text-muted'
      }
    >
      {label}
    </span>
  );
}
