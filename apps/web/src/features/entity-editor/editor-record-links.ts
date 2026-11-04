import { DOMSerializer } from '@tiptap/pm/model';
import type { EditorProps, MarkViewConstructor } from '@tiptap/pm/view';
import { recordLinkGestures } from '../../lib/entity-ref/prefetch';
import {
  isPlainRecordActivation,
  recordIdOfLink,
  type useRecordLinkController,
} from '../../lib/entity-ref/record-link-controller';

function anchorAt(root: HTMLElement, target: EventTarget | null) {
  const anchor =
    target instanceof Element
      ? target.closest<HTMLAnchorElement>('a[href], a[data-pending-record]')
      : null;
  return anchor && root.contains(anchor) ? anchor : undefined;
}

function recordIdAt(anchor: HTMLAnchorElement) {
  if (anchor.dataset.pendingRecord) return anchor.dataset.pendingRecord;
  const href = anchor.getAttribute('href');
  if (href) return recordIdOfLink(href, anchor.ownerDocument);
}

type PendingLookup = Pick<
  ReturnType<typeof useRecordLinkController>,
  'availability' | 'subscribePending'
>;

/** Keep the document's Link mark and its clipboard form intact. Only the in-editor
 * DOM loses the native href while that UUID is unconfirmed. */
export function recordLinkMarkView({
  availability,
  subscribePending,
}: PendingLookup): MarkViewConstructor {
  return (mark, view, inline) => {
    const spec = mark.type.spec.toDOM?.(mark, inline);
    if (!spec) throw new Error('Expected a DOM spec for the Link mark');
    const { dom, contentDOM } = DOMSerializer.renderSpec(view.dom.ownerDocument, spec);
    if (!(dom instanceof HTMLElement)) throw new Error('Expected an HTML Link mark');
    const anchor = dom instanceof HTMLAnchorElement ? dom : undefined;
    const href = anchor?.getAttribute('href');
    const id = anchor && href && recordIdAt(anchor);
    if (!anchor || !href || !id) return { dom, contentDOM };

    const tabIndex = anchor.getAttribute('tabindex');
    let status: ReturnType<PendingLookup['availability']>;
    const sync = () => {
      const next = availability(id);
      if (next === status) return;
      status = next;
      if (status) {
        anchor.removeAttribute('href');
        anchor.setAttribute('role', 'button');
        anchor.setAttribute('tabindex', status === 'pending' ? '0' : '-1');
        if (status === 'rejected') anchor.setAttribute('aria-disabled', 'true');
        else anchor.removeAttribute('aria-disabled');
        anchor.dataset.pendingRecord = id;
      } else {
        anchor.setAttribute('href', href);
        anchor.removeAttribute('role');
        anchor.removeAttribute('aria-disabled');
        if (tabIndex === null) anchor.removeAttribute('tabindex');
        else anchor.setAttribute('tabindex', tabIndex);
        delete anchor.dataset.pendingRecord;
      }
    };
    sync();
    return {
      dom,
      contentDOM,
      destroy: subscribePending(sync),
      ignoreMutation: (mutation) =>
        mutation.type === 'attributes' &&
        mutation.target === dom &&
        ['href', 'role', 'tabindex', 'data-pending-record', 'aria-disabled'].includes(
          mutation.attributeName ?? '',
        ),
    };
  };
}

/** Tiptap opens a JS window on mouseup, before the browser's click and without noopener. */
export const suppressLinkPluginMouseUp: NonNullable<EditorProps['handleClick']> = (
  view,
  _pos,
  event,
) => anchorAt(view.dom, event.target) !== undefined;

type Controller = Pick<ReturnType<typeof useRecordLinkController>, 'open' | 'prepare'>;

export function bindEditorRecordLinks(
  root: HTMLElement,
  { open, prepare }: Controller,
  isEditable: () => boolean,
) {
  const gestures = recordLinkGestures(prepare);
  const events = new AbortController();
  const options = { signal: events.signal };

  function ownAnchor(event: Event) {
    const anchor = anchorAt(root, event.target);
    // NodeViews already render and bind their own RecordLink.
    return anchor && !anchor.hasAttribute('data-entity-chip') ? anchor : undefined;
  }

  function find(event: Event) {
    const anchor = ownAnchor(event);
    if (!anchor) return;
    const id = recordIdAt(anchor);
    if (id) return { anchor, id };
  }

  function crossedAnchor(event: PointerEvent | FocusEvent) {
    const link = find(event);
    if (link && !(event.relatedTarget instanceof Node && link.anchor.contains(event.relatedTarget)))
      return link;
  }

  root.addEventListener(
    'pointerover',
    (event) => {
      if (event.pointerType !== 'mouse') return;
      const link = crossedAnchor(event);
      if (link) gestures.enter(link.id);
    },
    options,
  );
  root.addEventListener(
    'pointerout',
    (event) => {
      if (event.pointerType === 'mouse' && crossedAnchor(event)) gestures.leave();
    },
    options,
  );
  root.addEventListener(
    'focusin',
    (event) => {
      const link = crossedAnchor(event);
      if (link) gestures.focus(link.id);
    },
    options,
  );
  root.addEventListener(
    'focusout',
    (event) => {
      if (crossedAnchor(event)) gestures.blur();
    },
    options,
  );
  root.addEventListener(
    'pointerdown',
    (event) => {
      const link = find(event);
      if (link) gestures.down(link.id, event);
    },
    options,
  );
  root.addEventListener('pointermove', gestures.move, options);
  root.addEventListener('pointercancel', gestures.cancel, options);
  root.addEventListener('pointerup', gestures.up, options);
  root.addEventListener(
    'click',
    (event) => {
      const anchor = ownAnchor(event);
      if (!anchor || !isPlainRecordActivation(event) || anchor.hasAttribute('download')) return;
      const id = recordIdAt(anchor);
      if (id) {
        event.preventDefault();
        open(id);
        gestures.releaseTouch();
      } else if (isEditable() && anchor.href) {
        // Links in an editable body used Tiptap's JS activation. Preserve the
        // requested target with opener isolation. Read-only and modifiers stay native.
        event.preventDefault();
        window.open(anchor.href, anchor.target, 'noopener');
      }
    },
    options,
  );
  root.addEventListener(
    'keydown',
    (event) => {
      if (
        (event.key !== 'Enter' && event.key !== ' ') ||
        event.isComposing ||
        event.repeat ||
        !isPlainRecordActivation({
          button: 0,
          defaultPrevented: event.defaultPrevented,
          altKey: event.altKey,
          ctrlKey: event.ctrlKey,
          metaKey: event.metaKey,
          shiftKey: event.shiftKey,
        })
      )
        return;
      const link = find(event);
      if (!link || link.anchor !== document.activeElement) return;
      if (event.key === ' ' && !link.anchor.dataset.pendingRecord) return;
      event.preventDefault();
      open(link.id);
    },
    { ...options, capture: true },
  );

  return () => {
    events.abort();
    gestures.dispose();
  };
}
