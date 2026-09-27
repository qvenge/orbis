import {
  EXTENSION_MANIFESTS,
  type ExtensionId,
  effectiveLabel,
  OWNER_LOCALE,
  SWITCHABLE_EXTENSION_IDS,
} from '@orbis/shared';
import { useState } from 'react';
import { trpc } from '../../trpc';
import {
  extensionName,
  useDisabledExtensions,
  useSetExtensionEnabled,
} from './useDisabledExtensions';

/**
 * Расширения (срез 1б §8.6): по строке на каждое переключаемое — иконка, имя, что оно приносит и
 * переключатель. Выключаются все (П0). Переключатель — действие владельца `module_set` с журналом и
 * «Отменить»; пока настройки не приехали, «включено» или «выключено» — неизвестно, и переключатель
 * неактивен: жест вслепую переключил бы в сторону, которой владелец не видел.
 */
export function ExtensionsList() {
  const settings = trpc.user.getSettings.useQuery();
  const disabled = useDisabledExtensions();
  const setEnabled = useSetExtensionEnabled();
  const [pending, setPending] = useState<ExtensionId | null>(null);
  const known = settings.data !== undefined;
  return (
    <ul className="flex flex-col divide-y divide-line">
      {SWITCHABLE_EXTENSION_IDS.map((ext) => {
        const m = EXTENSION_MANIFESTS[ext];
        const on = !disabled.includes(ext);
        const name = extensionName(ext);
        return (
          <li key={ext} data-testid={`extension-${ext}`} className="flex items-start gap-3 py-2">
            <span aria-hidden className="text-lg leading-6">
              {m.icon}
            </span>
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="text-sm font-medium">{name}</span>
              <span className="text-xs text-text-secondary">
                {effectiveLabel(m.description, OWNER_LOCALE)}
              </span>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={known && on}
              aria-label={`Расширение «${name}»`}
              disabled={!known || pending !== null}
              onClick={() => {
                setPending(ext);
                void setEnabled(ext, !on).finally(() => setPending(null));
              }}
              className="relative mt-0.5 inline-flex h-6 w-10 shrink-0 cursor-pointer items-center rounded-full bg-line transition aria-checked:bg-accent disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
            >
              <span
                aria-hidden
                className={`inline-block size-5 rounded-full bg-surface shadow-control transition ${
                  known && on ? 'translate-x-[18px]' : 'translate-x-0.5'
                }`}
              />
            </button>
          </li>
        );
      })}
    </ul>
  );
}
