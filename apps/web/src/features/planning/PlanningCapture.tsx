import { Plus } from 'lucide-react';
import type { FormEvent } from 'react';
import { CreateIntentRows } from '../../lib/optimistic/CreateIntentRows';
import {
  type CreatePlacement,
  useCreateCapture,
  useCreateSurface,
} from '../../lib/optimistic/use-create-intent';
import { Button } from '../../ui/Button';
import { INBOX_STATE, PLAN_ORDER, PLANNED_DATE, TASK_STATUS } from './model';

export function PlanningCapture({
  day,
  disabled = false,
  placement,
  captureSlot,
}: {
  day?: string;
  disabled?: boolean;
  placement?: CreatePlacement;
  captureSlot?: string;
}) {
  const origin = useCreateSurface(day === undefined ? 'inbox' : `planning:${day}`, captureSlot);
  const formScope = useCreateSurface(day === undefined ? 'inbox' : 'day-planner', captureSlot);
  const capture = useCreateCapture(origin, placement, formScope);
  const { text } = capture;
  function submit(e: FormEvent) {
    e.preventDefault();
    const value = text.trim();
    if (!value || disabled || capture.busyAtOrigin) return;
    capture.submit({
      input: {
        title: value.split('\n')[0] || value,
        tags: [],
        ...(day === undefined
          ? { body: value, props: { [INBOX_STATE]: 'pending' } }
          : {
              aspects: ['orbis/task'],
              props: {
                [TASK_STATUS]: 'planned',
                [PLANNED_DATE]: day,
                [PLAN_ORDER]: Date.now(),
                [INBOX_STATE]: 'processed',
              },
            }),
      },
      source: 'quick_capture',
    });
  }
  const inputClass =
    'min-w-0 flex-1 resize-none bg-transparent px-1 py-3 text-sm text-text outline-none placeholder:text-text-muted';
  return (
    <form onSubmit={submit} className="space-y-2">
      <div className="flex items-start gap-2 rounded-xl border border-line bg-surface p-2 focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/15">
        {day === undefined ? (
          <textarea
            aria-label="Новая запись во входящих"
            placeholder="Мысль, ссылка, задача — как есть…"
            rows={3}
            value={text}
            onChange={(e) => capture.edit(e.target.value)}
            className={inputClass}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !e.nativeEvent.isComposing) {
                e.preventDefault();
                e.currentTarget.form?.requestSubmit();
              }
            }}
          />
        ) : (
          <input
            aria-label="Новая задача"
            placeholder="Что хочешь сделать в этот день?"
            value={text}
            onChange={(e) => capture.edit(e.target.value)}
            className={inputClass}
          />
        )}
        <Button
          type="submit"
          disabled={disabled || capture.busyAtOrigin || !text.trim()}
          aria-label={day ? 'Добавить задачу' : 'Сохранить во входящие'}
          className="min-h-11 min-w-11 shrink-0 px-3"
        >
          <Plus size={18} aria-hidden />
          {day === undefined && <span className="hidden sm:inline">Сохранить</span>}
        </Button>
      </div>
      <CreateIntentRows {...capture} />
    </form>
  );
}
