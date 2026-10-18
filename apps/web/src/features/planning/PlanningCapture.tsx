import { newId } from '@orbis/shared';
import { Plus } from 'lucide-react';
import { type FormEvent, useRef, useState } from 'react';
import { invalidateGraph } from '../../lib/invalidate';
import { trpc } from '../../trpc';
import { Button } from '../../ui/Button';
import { journalRefOf } from '../undo/journal-ref';
import { isUndoEpoch, undoEpoch } from '../undo/undo-epoch';
import { offerUndoLazy } from '../undo/undo-lazy';
import { INBOX_STATE, PLAN_ORDER, PLANNED_DATE, TASK_STATUS } from './model';

export function PlanningCapture({ day, disabled = false }: { day?: string; disabled?: boolean }) {
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const busy = useRef(false);
  const attempt = useRef<{ id: string; text: string; day?: string; rank: number } | null>(null);
  const utils = trpc.useUtils();
  const create = trpc.entity.create.useMutation({ meta: { undoStack: 'self' } });
  async function submit(e: FormEvent) {
    e.preventDefault();
    const captured = text.trim();
    if (!captured || busy.current || disabled) return;
    const epoch = undoEpoch();
    busy.current = true;
    setError('');
    if (!attempt.current || attempt.current.text !== captured || attempt.current.day !== day)
      attempt.current = { id: newId(), text: captured, day, rank: Date.now() };
    const intent = attempt.current;
    try {
      const result = await create.mutateAsync({
        input: {
          id: intent.id,
          title: captured.split('\n')[0] || captured,
          ...(day === undefined && { body: captured }),
          tags: [],
          ...(day === undefined
            ? { props: { [INBOX_STATE]: 'pending' } }
            : {
                aspects: ['orbis/task'],
                props: {
                  [TASK_STATUS]: 'planned',
                  [PLANNED_DATE]: day,
                  [PLAN_ORDER]: intent.rank,
                  [INBOX_STATE]: 'processed',
                },
              }),
        },
        source: 'quick_capture',
      });
      if (!isUndoEpoch(epoch)) return;
      invalidateGraph(utils);
      const ref = journalRefOf(result);
      if (ref)
        offerUndoLazy({
          title: day ? 'Задача добавлена' : 'Сохранено во входящие',
          actionId: ref.actionId,
          entityIds: [],
        });
      attempt.current = null;
      // A pending request must not consume a newer draft.
      setText((current) => (current.trim() === captured ? '' : current));
    } catch {
      if (isUndoEpoch(epoch))
        setError('Не удалось сохранить. Текст на месте — попробуйте ещё раз.');
    } finally {
      busy.current = false;
    }
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
            onChange={(e) => setText(e.target.value)}
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
            onChange={(e) => setText(e.target.value)}
            className={inputClass}
          />
        )}
        <Button
          type="submit"
          disabled={disabled || create.isPending || !text.trim()}
          aria-label={day ? 'Добавить задачу' : 'Сохранить во входящие'}
          className="min-h-11 min-w-11 shrink-0 px-3"
        >
          <Plus size={18} aria-hidden />
          {day === undefined && <span className="hidden sm:inline">Сохранить</span>}
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
    </form>
  );
}
