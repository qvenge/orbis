import { type ReactNode, useCallback, useEffect, useState } from 'react';
/** Фокус ограничен полями этой записи: панель не появляется над частным редактором предложения. */
export function KeyboardBar({ children, entityId }: { children: ReactNode; entityId: string }) {
  const inText = useCallback(
    (el: EventTarget | null) =>
      el instanceof Element &&
      el.closest(`[data-step-record="${CSS.escape(entityId)}"]`) !== null &&
      el.closest('[data-testid="title-edit"],.ProseMirror') !== null,
    [entityId],
  );
  const [focused, setFocused] = useState(() => inText(document.activeElement)),
    [bottom, setBottom] = useState(0);
  useEffect(() => {
    const onIn = (e: FocusEvent) => setFocused(inText(e.target)),
      onOut = (e: FocusEvent) => setFocused(inText(e.relatedTarget));
    document.addEventListener('focusin', onIn);
    document.addEventListener('focusout', onOut);
    return () => {
      document.removeEventListener('focusin', onIn);
      document.removeEventListener('focusout', onOut);
    };
  }, [inText]);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => setBottom(Math.max(0, window.innerHeight - vv.height - vv.offsetTop));
    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
    };
  }, []);
  if (!focused) return null;
  return (
    <div
      role="toolbar"
      aria-label="Шаги заголовка и текста"
      data-testid="keyboard-bar"
      style={{ bottom }}
      className="fixed inset-x-0 z-40 flex justify-end gap-1 border-t border-line bg-surface px-4 py-1"
    >
      {children}
    </div>
  );
}
