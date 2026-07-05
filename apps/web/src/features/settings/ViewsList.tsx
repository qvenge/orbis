import { trpc } from '../../trpc';

export function ViewsList() {
  const settings = trpc.user.getSettings.useQuery();
  const views = settings.data?.installedViews ?? [];
  return (
    <ul className="flex flex-col gap-1 p-3 text-sm">
      {views.length === 0 && <li className="text-text-muted">Нет установленных views</li>}
      {views.map((v) => (
        <li key={v}>{v}</li>
      ))}
    </ul>
  );
}
