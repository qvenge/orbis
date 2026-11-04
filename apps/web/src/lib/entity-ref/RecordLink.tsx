import type { AppKey } from '@orbis/shared/nav';
import { type HTMLAttributes, type MouseEvent, useEffect, useMemo } from 'react';
import { isUndoEpoch, undoEpoch } from '../../features/undo/undo-epoch';
import { useLocalCreateTarget } from '../optimistic/create-intent-scope';
import { recordLinkGestures } from './prefetch';
import { isPlainRecordActivation, useRecordLinkController } from './record-link-controller';

type Props = Omit<
  HTMLAttributes<HTMLElement>,
  | 'onClick'
  | 'onFocus'
  | 'onBlur'
  | 'onPointerEnter'
  | 'onPointerLeave'
  | 'onPointerDown'
  | 'onPointerMove'
  | 'onPointerCancel'
  | 'onPointerUp'
> & {
  id: string;
  app?: AppKey;
  href?: string;
  target?: string;
  rel?: string;
  download?: string | boolean;
  /** The record exists only in the local creation overlay until the server ACK. */
  pending?: boolean;
  disabled?: boolean;
  /** Keep the prose-link styling for links embedded in Markdown text. */
  prose?: boolean;
  onOpen?: (id: string, proceed: (navigate?: () => void) => void) => void;
};

export function RecordLink({
  id,
  app,
  href,
  target,
  rel,
  download,
  pending,
  disabled,
  prose,
  onOpen,
  onKeyDown,
  children,
  ...attributes
}: Props) {
  const controller = useRecordLinkController(app);
  const { nativeLinks, prepare } = controller;
  const local = useLocalCreateTarget(id);
  const unavailable = pending || Boolean(local);
  const blocked = disabled || local?.status === 'rejected';
  const gestures = useMemo(
    () =>
      recordLinkGestures((recordId, cause) =>
        prepare(recordId, cause, { pending: blocked || unavailable }),
      ),
    [blocked, unavailable, prepare],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: release the old anchor's intents if its target changes.
  useEffect(() => gestures.dispose, [gestures, id]);

  function activate(event: MouseEvent<HTMLElement>) {
    if (
      !isPlainRecordActivation(event) ||
      (nativeLinks &&
        !unavailable &&
        ((target && target !== '_self') || (download !== undefined && download !== false)))
    )
      return;
    event.preventDefault();
    const epoch = undoEpoch();
    let proceeded = false;
    const proceed = (navigate?: () => void) => {
      if (proceeded || !isUndoEpoch(epoch)) return;
      proceeded = true;
      controller.open(id, { pending, navigate });
    };
    if (onOpen) onOpen(id, proceed);
    else proceed();
    gestures.releaseTouch();
  }

  if (blocked)
    return (
      <button {...attributes} type="button" onKeyDown={onKeyDown} disabled>
        {children}
      </button>
    );
  if (unavailable)
    return (
      <button {...attributes} type="button" onKeyDown={onKeyDown} onClick={activate}>
        {children}
      </button>
    );

  return (
    <a
      {...attributes}
      data-record-link-control={prose ? undefined : ''}
      href={nativeLinks ? (href ?? controller.href(id)) : undefined}
      target={nativeLinks ? target : undefined}
      rel={nativeLinks ? rel : undefined}
      download={nativeLinks ? download : undefined}
      role={nativeLinks ? attributes.role : (attributes.role ?? 'link')}
      tabIndex={nativeLinks ? attributes.tabIndex : (attributes.tabIndex ?? 0)}
      onClick={activate}
      onKeyDown={(event) => {
        onKeyDown?.(event);
        if (
          nativeLinks ||
          event.key !== 'Enter' ||
          event.repeat ||
          event.nativeEvent.isComposing ||
          event.defaultPrevented ||
          event.altKey ||
          event.ctrlKey ||
          event.metaKey ||
          event.shiftKey
        )
          return;
        event.preventDefault();
        event.currentTarget.click();
      }}
      onPointerEnter={(event) => {
        if (event.pointerType === 'mouse') gestures.enter(id);
      }}
      onPointerLeave={(event) => {
        if (event.pointerType === 'mouse') gestures.leave();
      }}
      onFocus={() => gestures.focus(id)}
      onBlur={gestures.blur}
      onPointerDown={(event) => gestures.down(id, event)}
      onPointerMove={gestures.move}
      onPointerCancel={gestures.cancel}
      onPointerUp={gestures.up}
    >
      {children}
    </a>
  );
}
