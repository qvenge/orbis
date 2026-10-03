// biome-ignore-all lint/a11y/noNoninteractiveTabindex: Плашка целиком достижима Tab по §7.5, описание читается до действия.
import { useEffect, useRef } from 'react';
import { useToastStore } from './toast-store';

/** Одна оболочка уведомлений: Escape внутри плашки не перехватывает открытое меню или диалог. */
export function Toaster() {
  const { toasts, dismiss, pause, resume } = useToastStore();
  const swipes = useRef(new Map<string, { x: number; y: number }>());
  useEffect(() => {
    const ids = new Set(toasts.map((t) => t.id));
    for (const id of swipes.current.keys()) if (!ids.has(id)) swipes.current.delete(id);
  }, [toasts]);
  return (
    <ol aria-live="polite" className="fixed bottom-4 right-4 z-[60] flex w-80 flex-col gap-2">
      {toasts.map((t) => (
        <li
          key={t.id}
          tabIndex={0}
          className={`rounded-control border border-line p-3 text-sm shadow-pop ${t.tone === 'danger' ? 'bg-danger text-danger-foreground' : 'bg-surface-2 text-text'}`}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation();
              dismiss(t.id);
            }
          }}
          onMouseEnter={() => pause(t.id, 'hover')}
          onMouseLeave={() => resume(t.id, 'hover')}
          onFocus={() => pause(t.id, 'focus')}
          onBlur={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) resume(t.id, 'focus');
          }}
          onPointerDown={(e) => {
            if (e.pointerType !== 'mouse') {
              e.currentTarget.setPointerCapture?.(e.pointerId);
              swipes.current.set(t.id, { x: e.clientX, y: e.clientY });
              pause(t.id, 'touch');
            }
          }}
          onPointerUp={(e) => {
            if (e.pointerType !== 'mouse') {
              const start = swipes.current.get(t.id);
              swipes.current.delete(t.id);
              if (
                start &&
                e.clientX - start.x > 50 &&
                e.clientX - start.x > Math.abs(e.clientY - start.y)
              )
                dismiss(t.id);
              resume(t.id, 'touch');
            }
          }}
          onPointerCancel={() => {
            swipes.current.delete(t.id);
            resume(t.id, 'touch');
          }}
          onLostPointerCapture={() => {
            swipes.current.delete(t.id);
            resume(t.id, 'touch');
          }}
        >
          <p>{t.title}</p>
          {t.description !== undefined && (
            <p className="mt-1 text-xs opacity-90">{t.description}</p>
          )}
          {t.action !== undefined && (
            <button
              type="button"
              className="mt-2 text-sm font-medium underline underline-offset-2"
              onClick={() => {
                t.action?.onSelect();
                dismiss(t.id);
              }}
            >
              {t.action.label}
            </button>
          )}
        </li>
      ))}
    </ol>
  );
}
