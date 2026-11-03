import { ROLE_SUBITEM } from '@orbis/shared';
import { Plus } from 'lucide-react';
import type { FormEvent } from 'react';
import { CreateIntentRows } from '../../lib/optimistic/CreateIntentRows';
import {
  type CreatePlacement,
  useCreateCapture,
  useCreateSurface,
} from '../../lib/optimistic/use-create-intent';
import { Spinner } from '../../ui/Spinner';

// §3.7 / D-g: текст → title БЕЗ интерпретации. Контекст задаёт связь: `entity` — подзадача записи
// («＋» на записи, спека 1б §6.4, РП-9), `root` — без контекста. Вариант `smart-list` снят (§9.4):
// смарт-листы стали страницами, а «＋» на странице — без контекста.
export type CaptureContext = { kind: 'root' } | { kind: 'entity'; parentId: string };

export function QuickCapture({
  context,
  surface,
  captureSlot,
  placement,
}: {
  context: CaptureContext;
  surface?: string;
  captureSlot?: string;
  placement?: CreatePlacement;
}) {
  const parentId = context.kind === 'entity' ? context.parentId.toLowerCase() : undefined;
  // Host surfaces already identify the physical form. A parent classified after a
  // request starts changes only the command of a future submission.
  const origin = useCreateSurface(surface ?? `capture:${parentId ?? 'root'}`, captureSlot);
  const formScope = useCreateSurface(surface ?? 'capture', captureSlot);
  const capture = useCreateCapture(origin, placement, formScope);
  const { text } = capture;
  const isPending = capture.rows.some((view) => view.status === 'pending');

  function submit(e: FormEvent) {
    e.preventDefault();
    const title = text.trim();
    if (!title || !capture.canSubmit(title)) return;
    capture.submit({
      input: {
        title,
        tags: [],
        ...(parentId
          ? { props: { 'orbis/task_status': 'inbox' }, aspects: ['orbis/task'] }
          : { props: { 'orbis/inbox_state': 'pending' } }),
      },
      source: 'quick_capture',
      ...(parentId && { link: { parentId, role: ROLE_SUBITEM } }),
    });
  }

  const empty = text.trim().length === 0;
  return (
    // Капсула в стиле композера чата: без border-t, кнопка внутри поля.
    <form data-testid="quick-capture-form" onSubmit={submit} className="px-4 pb-4 pt-1">
      <div className="flex items-center gap-2 rounded-2xl border border-line bg-surface py-1 pl-4 pr-1.5 shadow-control transition focus-within:border-accent/60 focus-within:ring-2 focus-within:ring-accent/15">
        <input
          aria-label="Быстрая запись"
          value={text}
          onChange={(e) => capture.edit(e.target.value)}
          placeholder="Быстрая запись — без интерпретации…"
          className="min-w-0 flex-1 bg-transparent py-1.5 text-sm text-text outline-none placeholder:text-text-muted"
        />
        <button
          type="submit"
          disabled={empty || !capture.canSubmit(text.trim())}
          aria-label="Добавить"
          className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-full bg-accent text-accent-foreground transition hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 disabled:cursor-default disabled:bg-surface-2 disabled:text-text-muted"
        >
          {isPending ? (
            <Spinner size={13} aria-label="Сохранение" />
          ) : (
            <Plus size={15} aria-hidden />
          )}
        </button>
      </div>
      <CreateIntentRows {...capture} />
    </form>
  );
}
