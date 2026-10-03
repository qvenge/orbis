import { Extension } from '@tiptap/core';
import { Plugin } from '@tiptap/pm/state';
import { redoStep, undoStep } from './arrows-stack';
import { entityOfEditor } from './editor-cache';
/** Общий стек перехватывает клавиши прежде встроенной истории; частный редактор её сохраняет. */
export const ArrowsKeys = Extension.create({
  name: 'arrowsKeys',
  priority: 1000,
  addKeyboardShortcuts() {
    const step = (redo: boolean) => () => {
      const id = entityOfEditor(this.editor);
      if (id === undefined) return false;
      if (redo) redoStep(id);
      else undoStep(id);
      return true;
    };
    return {
      'Mod-z': step(false),
      'Mod-я': step(false),
      'Shift-Mod-z': step(true),
      'Shift-Mod-я': step(true),
      'Mod-y': step(true),
    };
  },
  addProseMirrorPlugins() {
    const editor = this.editor;
    return [
      new Plugin({
        props: {
          handleDOMEvents: {
            beforeinput: (_view, event) => {
              const type = (event as InputEvent).inputType,
                id = entityOfEditor(editor);
              if (id === undefined || (type !== 'historyUndo' && type !== 'historyRedo'))
                return false;
              event.preventDefault();
              if (type === 'historyUndo') undoStep(id);
              else redoStep(id);
              return true;
            },
          },
        },
      }),
    ];
  },
});
