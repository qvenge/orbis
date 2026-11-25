import type { FileInfo } from '@orbis/shared/files';
import { type Editor, Extension } from '@tiptap/core';
import { Plugin, PluginKey, type Transaction } from '@tiptap/pm/state';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';
import { useLayoutEffect, useRef } from 'react';
import { idFromFileAddress, previewableFile, uploadFile } from '../../lib/files/transport';
import { captureProductRequest, trpc } from '../../trpc';
import { useToast } from '../../ui/toast-store';

const markers = new PluginKey<DecorationSet>('fileInsertion');
type MarkerAction = { add: Decoration } | { remove: string };
function removeMarker(tr: Transaction, id: string) {
  return tr.setMeta(markers, { remove: id } satisfies MarkerAction);
}
function findMarker(view: EditorView, id: string) {
  return markers.getState(view.state)?.find(undefined, undefined, (s) => s.id === id)[0];
}

export const FileInsertionMarkers = Extension.create({
  name: 'fileInsertionMarkers',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: markers,
        state: {
          init: () => DecorationSet.empty,
          apply(tr, previous) {
            let set = previous.map(tr.mapping, tr.doc);
            const action = tr.getMeta(markers) as MarkerAction | undefined;
            if (action && 'add' in action) set = set.add(tr.doc, [action.add]);
            if (action && 'remove' in action)
              set = set.remove(set.find(undefined, undefined, (s) => s.id === action.remove));
            return set;
          },
        },
        props: {
          decorations: (state) => markers.getState(state),
          handleKeyDown(view, event) {
            if (!['Backspace', 'Delete'].includes(event.key) || !view.state.selection.empty)
              return false;
            const at = view.state.selection.from;
            const marker = markers.getState(view.state)?.find(at, at)[0];
            if (!marker) return false;
            view.dispatch(removeMarker(view.state.tr, marker.spec.id));
            return true;
          },
        },
      }),
    ];
  },
});

export function useFileInsertion(
  editor: Editor,
  entityId: string | undefined,
  blocked: boolean,
  reseat: number,
) {
  const api = trpc.useUtils().client.files;
  const { show } = useToast();
  const lifetime = useRef(new AbortController());
  // biome-ignore lint/correctness/useExhaustiveDependencies: conflicts and forced document replacements invalidate pending markers.
  useLayoutEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    return () => {
      controller.abort();
      if (editor.isDestroyed) return;
      for (const mark of markers.getState(editor.state)?.find() ?? []) {
        editor.view.dispatch(removeMarker(editor.state.tr, mark.spec.id));
      }
    };
  }, [editor, entityId, blocked, reseat]);
  return (view: EditorView, data: DataTransfer | null, pos: number) => {
    const files = Array.from(data?.files ?? []);
    if (!files.length)
      for (const item of Array.from(data?.items ?? [])) {
        const file = item.kind === 'file' ? item.getAsFile() : null;
        if (file) files.push(file);
      }
    const address = idFromFileAddress(data?.getData('text/plain') ?? '');
    if (!files.length && !address) return false;
    if (!files.length && view.state.doc.resolve(pos).parent.type.spec.code) return false;
    if (!entityId || blocked || !editor.isEditable || !navigator.onLine) {
      show(
        !navigator.onLine
          ? 'Для вставки файла нужно подключение к сети'
          : 'Вставка файла сейчас недоступна',
        'danger',
      );
      return true;
    }
    if (
      view.state.doc.resolve(pos).parent.type.spec.code ||
      !view.state.doc.resolve(pos).parent.inlineContent
    ) {
      show('Поместите курсор в текст записи', 'danger');
      return true;
    }
    const group = (files.length ? files : [null]).map((file) => {
      const id = crypto.randomUUID();
      const abort = new AbortController();
      const session = captureProductRequest(
        AbortSignal.any([abort.signal, lifetime.current.signal]),
      );
      const active = session.signal!;
      const name = file?.name ?? 'файла';
      const cancel = () => {
        abort.abort();
        if (!editor.isDestroyed && findMarker(view, id))
          view.dispatch(removeMarker(view.state.tr, id));
      };
      const el = document.createElement('span');
      el.contentEditable = 'false';
      el.className = 'inline-flex items-center gap-1 rounded border border-line px-1 text-sm';
      const status = document.createElement('span');
      status.textContent = name;
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = '×';
      button.setAttribute('aria-label', `Отменить вставку ${name}`);
      button.onclick = cancel;
      el.append(status, button);
      const decoration = Decoration.widget(pos, el, { id, side: 1, stopEvent: () => true });
      view.dispatch(view.state.tr.setMeta(markers, { add: decoration } satisfies MarkerAction));
      async function run() {
        const current = () =>
          !editor.isDestroyed && !active.aborted && session.isCurrent() && !!findMarker(view, id);
        if (!current()) return;
        try {
          let info: FileInfo | undefined;
          if (file) {
            const limits = await api.limits.query(undefined, { signal: active });
            info = await uploadFile(
              {
                begin: (input) => api.begin.mutate(input, { signal: active }),
                finish: (input) => api.finish.mutate(input, { signal: active }),
              },
              file,
              id,
              limits,
              active,
              (offset) => {
                status.textContent = `${name} · ${offset}/${file.size}`;
              },
            );
          } else {
            const rows = await api.describe.query({ ids: [address!] }, { signal: active });
            info = rows.find((row) => row.id === address);
          }
          if (!current()) return;
          if (!info) throw Error('Файл недоступен');
          const at = findMarker(view, id)!.from;
          const node = view.state.schema.nodes.fileRef!.create({
            fileId: info.id,
            label: info.name,
            display: previewableFile(info.mediaType) ? 'image' : 'link',
          });
          view.dispatch(removeMarker(view.state.tr.insert(at, node), id));
        } catch (error) {
          if (!current()) return;
          status.textContent = `${name} · ${(error as Error).message}`;
          const retry = document.createElement('button');
          retry.type = 'button';
          retry.textContent = 'Повторить';
          retry.onclick = () => {
            retry.remove();
            void run();
          };
          el.append(retry);
        }
      }
      return run;
    });
    void (async () => {
      for (const run of group) await run();
    })();
    return true;
  };
}
