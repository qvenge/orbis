/** Эти поля не принимают текста: у них нет родной текстовой отмены. */
const NON_TEXT_INPUTS: ReadonlySet<string> = new Set([
  'button',
  'checkbox',
  'color',
  'file',
  'hidden',
  'image',
  'radio',
  'range',
  'reset',
  'submit',
]);
export function isEditableTarget(t: EventTarget | null): boolean {
  if (!(t instanceof Element)) return false;
  if (t instanceof HTMLInputElement) return !NON_TEXT_INPUTS.has(t.type);
  if (t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement) return true;
  if (t instanceof HTMLElement && t.isContentEditable) return true;
  return (
    t.closest('[contenteditable=""], [contenteditable="true"], .ProseMirror, [role="textbox"]') !==
    null
  );
}
