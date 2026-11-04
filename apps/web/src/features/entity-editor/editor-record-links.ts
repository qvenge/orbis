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
      ? target.closest<HTMLAnchorElement>('a[href], a[data-record-action]')
      : null;
  return anchor && root.contains(anchor) ? anchor : undefined;
}

function recordIdAt(anchor: HTMLAnchorElement) {
  if (anchor.dataset.recordAction) return anchor.dataset.recordAction;
  const href = anchor.getAttribute('href');
  if (href) return recordIdOfLink(href, anchor.ownerDocument);
}

type PendingLookup = Pick<
  ReturnType<typeof useRecordLinkController>,
  'availability' | 'subscribePending'
>;

const linkAttributes = ['href', 'target', 'rel', 'download', 'role', 'tabindex', 'aria-disabled'];

/** Keep native URL policy in the view, independently of the document and selection. */
export function recordLinkMarkView({ availability, subscribePending }: PendingLookup) {
  const mounted = new Set<() => void>();
  let nativeLinks = true;
  const create: MarkViewConstructor = (mark, view, inline) => {
    const spec = mark.type.spec.toDOM?.(mark, inline);
    if (!spec) throw new Error('Expected a DOM spec for the Link mark');
    const { dom, contentDOM } = DOMSerializer.renderSpec(view.dom.ownerDocument, spec);
    if (!(dom instanceof HTMLElement)) throw new Error('Expected an HTML Link mark');
    const anchor = dom instanceof HTMLAnchorElement ? dom : undefined;
    const id = anchor && recordIdAt(anchor);
    if (!anchor || !id) return { dom, contentDOM };

    const original = linkAttributes.map((name) => [name, anchor.getAttribute(name)] as const);
    let status: 'native' | 'shared' | 'pending' | 'rejected' = 'native';
    const sync = () => {
      const next = availability(id) ?? (nativeLinks ? 'native' : 'shared');
      if (next === status) return;
      status = next;
      if (next === 'native') {
        for (const [name, value] of original) {
          if (value === null) anchor.removeAttribute(name);
          else anchor.setAttribute(name, value);
        }
        delete anchor.dataset.recordAction;
        return;
      }
      for (const name of ['href', 'target', 'rel', 'download']) anchor.removeAttribute(name);
      anchor.setAttribute('role', next === 'shared' ? 'link' : 'button');
      anchor.setAttribute('tabindex', next === 'rejected' ? '-1' : '0');
      if (next === 'rejected') anchor.setAttribute('aria-disabled', 'true');
      else anchor.removeAttribute('aria-disabled');
      anchor.dataset.recordAction = id;
    };
    sync();
    mounted.add(sync);
    const unsubscribe = subscribePending(sync);
    return {
      dom,
      contentDOM,
      destroy() {
        mounted.delete(sync);
        unsubscribe();
      },
      ignoreMutation: (mutation) =>
        mutation.type === 'attributes' &&
        mutation.target === dom &&
        (mutation.attributeName === 'data-record-action' ||
          linkAttributes.includes(mutation.attributeName ?? '')),
    };
  };
  return {
    create,
    setNativeLinks(next: boolean) {
      if (nativeLinks === next) return;
      nativeLinks = next;
      // Reconcile mounted marks without rebuilding the editor or losing its selection.
      for (const sync of mounted) sync();
    },
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
      if (event.key === ' ' && link.anchor.getAttribute('role') !== 'button') return;
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
