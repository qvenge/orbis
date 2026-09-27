import type { ExtensionId } from '@orbis/shared';
import { lazy, Suspense, useState } from 'react';
import { Button } from '../../ui/Button';
import { type AppComposition, compositionOf, orphanExtensions } from '../apps/orphans';
import {
  ARCHIVE_APP,
  DISABLE_APP,
  EDIT_COMPOSITION,
  ENABLE_APP,
  useAppAction,
} from '../apps/useAppAction';
import { type AppRecord, useApps } from '../apps/useApps';
import { extensionName, useDisabledExtensions } from './useDisabledExtensions';

/** Диалоги — после жеста, своими чанками. */
const DisableAppDialog = lazy(() =>
  import('../apps/DisableAppDialog').then((m) => ({ default: m.DisableAppDialog })),
);
const ArchiveAppDialog = lazy(() =>
  import('../apps/ArchiveAppDialog').then((m) => ({ default: m.ArchiveAppDialog })),
);
const CompositionDialog = lazy(() =>
  import('../apps/CompositionDialog').then((m) => ({ default: m.CompositionDialog })),
);
const NewAppDialog = lazy(() =>
  import('../apps/NewAppDialog').then((m) => ({ default: m.NewAppDialog })),
);

export const NEW_APP_BUTTON = 'Новое приложение';

type Open =
  | { kind: 'disable' | 'archive'; app: AppRecord; orphans: ExtensionId[] }
  | { kind: 'composition'; app: AppRecord; current: ExtensionId[] }
  | { kind: 'new' }
  | null;

/**
 * Приложения (срез 1б §8.6, §9.5): хост — всегда включён, его не выключить и не удалить (§4.2);
 * свои — с тем, что каждое приносит («Состав»), и действиями владельца «Выключить приложение» /
 * «Включить приложение» и «Удалить приложение». Архивные не показываются: удалённое приложение
 * возвращают «Отменить» или из архива записей. «Новое приложение» — одна пачка (`NewAppDialog`).
 *
 * «Состав» — по выбору владельца (§9.5): «Изменить состав» правит его одной `entity_update` и маску
 * не трогает (`CompositionDialog`).
 *
 * «Включить приложение» расширения «Состава» не включает (R-33): включение расширений — отдельный
 * жест владельца в списке расширений выше.
 */
export function AppsList() {
  const apps = useApps();
  const mask = useDisabledExtensions();
  const run = useAppAction();
  const [open, setOpen] = useState<Open>(null);
  const shell = apps.hostShell;

  const compositions: AppComposition[] = [
    ...(shell === null
      ? []
      : [
          {
            id: shell.id,
            disabled: false,
            archived: shell.archived,
            extensions: compositionOf(shell.props),
          },
        ]),
    ...apps.apps.map((a) => ({
      id: a.id,
      disabled: a.disabled,
      archived: a.archived,
      extensions: compositionOf(a.row.props),
    })),
  ];
  const orphansOf = (a: AppRecord): ExtensionId[] => {
    const self = compositions.find((c) => c.id === a.id);
    return self === undefined ? [] : orphanExtensions(self, compositions, mask);
  };
  const live = apps.apps.filter((a) => !a.archived);

  return (
    <div className="flex flex-col gap-2">
      <ul className="flex flex-col divide-y divide-line">
        {shell !== null && (
          <li data-testid="app-host" className="flex items-center gap-3 py-2">
            <span aria-hidden className="text-lg">
              {shell.emoji ?? '🪐'}
            </span>
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="text-sm font-medium">{shell.title}</span>
              <span className="text-xs text-text-secondary">Хост — всегда включён</span>
            </div>
          </li>
        )}
        {live.map((a) => {
          const own = compositionOf(a.row.props);
          return (
            <li
              key={a.id}
              data-testid={`app-${a.id}`}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2"
            >
              <span aria-hidden className="text-lg">
                {a.row.emoji ?? '▫️'}
              </span>
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="text-sm font-medium">
                  {a.title}
                  {a.disabled && <span className="text-xs text-text-muted"> · выключено</span>}
                </span>
                <span className="text-xs text-text-secondary">
                  {own.length === 0
                    ? 'Расширений в составе нет'
                    : `Состав: ${own.map(extensionName).join(', ')}`}
                </span>
              </div>
              <div className="flex gap-2">
                {a.disabled ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      void run({ kind: 'enable', appId: a.id, title: a.title, extensions: [] })
                    }
                  >
                    {ENABLE_APP}
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setOpen({ kind: 'disable', app: a, orphans: orphansOf(a) })}
                  >
                    {DISABLE_APP}
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setOpen({ kind: 'composition', app: a, current: own })}
                >
                  {EDIT_COMPOSITION}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setOpen({ kind: 'archive', app: a, orphans: orphansOf(a) })}
                >
                  {ARCHIVE_APP}
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
      <div>
        <Button size="sm" variant="outline" onClick={() => setOpen({ kind: 'new' })}>
          {NEW_APP_BUTTON}
        </Button>
      </div>
      <Suspense fallback={null}>
        {open?.kind === 'disable' && (
          <DisableAppDialog app={open.app} orphans={open.orphans} onClose={() => setOpen(null)} />
        )}
        {open?.kind === 'archive' && (
          <ArchiveAppDialog app={open.app} orphans={open.orphans} onClose={() => setOpen(null)} />
        )}
        {open?.kind === 'composition' && (
          <CompositionDialog app={open.app} current={open.current} onClose={() => setOpen(null)} />
        )}
        {open?.kind === 'new' && <NewAppDialog onClose={() => setOpen(null)} />}
      </Suspense>
    </div>
  );
}
