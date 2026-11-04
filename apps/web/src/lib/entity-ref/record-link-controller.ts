import { type AppKey, buildAddress, HOST_APP, parseAddress } from '@orbis/shared/nav';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useContext } from 'react';
import { FrameAppContext } from '../../app/frame/FrameApp';
import { appRefOf, useNav } from '../../state/navigation';
import { trpc } from '../../trpc';
import { createIntentsOf, localCreateTarget } from '../optimistic/create-intent-scope';
import { claimRecordPrefetch, prefetchRecord, type RecordIntent } from './prefetch';

type RecordAvailability = { pending?: boolean };
type RecordOpenOptions = RecordAvailability & {
  app?: AppKey;
  from?: 'host-screen' | 'content';
  navigate?: () => void;
};
const noop = () => {};

export function useRecordLinkController(app?: AppKey) {
  const frame = useContext(FrameAppContext);
  const linkApp = useNav(
    ({ model }) =>
      app ?? (frame?.via.startsWith('host-') ? HOST_APP : (frame?.app ?? model.activeApp)),
  );
  const client = useQueryClient();
  const { client: rpc } = trpc.useUtils();
  const registry = createIntentsOf(client);
  const availability = useCallback(
    (id: string, hint?: boolean) => {
      const local = localCreateTarget(registry, id);
      if (local) return local.status === 'rejected' ? 'rejected' : 'pending';
      return hint && !registry.lookup(id) ? 'pending' : undefined;
    },
    [registry],
  );
  const open = useCallback(
    (id: string, options?: RecordOpenOptions) => {
      if (!registry.isCurrent()) return;
      const nav = useNav.getState();
      const destination = {
        app: options?.app ?? linkApp,
        from: options?.from ?? (frame?.via === 'host-screen' ? 'host-screen' : 'content'),
      } as const;
      const status = availability(id, options?.pending);
      if (status === 'rejected') return;
      if (status === 'pending') {
        nav.openPendingCreate(id, destination);
        return;
      }
      if (options?.navigate) options.navigate();
      else nav.openRecord(id, destination);
      claimRecordPrefetch(client, id);
    },
    [client, frame?.via, availability, linkApp, registry],
  );

  const prepare = useCallback(
    (id: string, cause: RecordIntent, options?: RecordAvailability) =>
      !registry.isCurrent() || availability(id, options?.pending)
        ? noop
        : prefetchRecord(
            client,
            (input, signal) =>
              rpc.entity.get.query(input, { signal, context: { recordPrefetch: true } }),
            id,
            cause,
          ),
    [availability, client, registry, rpc],
  );
  const href = useCallback(
    (id: string, app?: AppKey) =>
      buildAddress({ kind: 'record', app: appRefOf(app ?? linkApp), id }),
    [linkApp],
  );
  return { open, prepare, href, availability, subscribePending: registry.subscribe };
}

export function isPlainRecordActivation(event: {
  button: number;
  defaultPrevented: boolean;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}): boolean {
  return (
    !event.defaultPrevented &&
    event.button === 0 &&
    !event.altKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.shiftKey
  );
}

/** Use the browser's destination and the same path/query as direct app entry. */
export function recordIdOfLink(href: string, ownerDocument: Document): string | undefined {
  try {
    const url = new URL(href, ownerDocument.baseURI);
    if (url.origin !== ownerDocument.location?.origin) return;
    const address = parseAddress(url.pathname + url.search);
    return address?.kind === 'record' ? address.id : undefined;
  } catch {
    return undefined;
  }
}
