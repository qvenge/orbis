/** Память действий этой вкладки переживает экраны, но не смену владельца. */
export interface UndoableEntry {
  actionId: string;
  title: string;
  entityIds?: string[];
}
export const UNDO_STACK_CAP = 100;
const stack: UndoableEntry[] = [];
export function pushUndoable(e: UndoableEntry): void {
  if (stack.some((x) => x.actionId === e.actionId)) return;
  stack.push(e);
  if (stack.length > UNDO_STACK_CAP) stack.shift();
}
export function peekUndoable(): UndoableEntry | undefined {
  return stack.at(-1);
}
export function dropUndoable(actionId: string): void {
  const i = stack.findIndex((x) => x.actionId === actionId);
  if (i >= 0) stack.splice(i, 1);
}
export function clearUndoStack(): void {
  stack.length = 0;
}
