import { newId } from '@orbis/shared';
import { Plus } from 'lucide-react';
import { type FormEvent, useRef, useState } from 'react';
import { runGraphCommand } from '../../lib/graph-command';
import { invalidateGraph } from '../../lib/invalidate';
import { trpc } from '../../trpc';
import { Button } from '../../ui/Button';
import { isUndoEpoch, undoEpoch } from '../undo/undo-epoch';
import { offerUndoLazy } from '../undo/undo-lazy';
import { INBOX_STATE, PLAN_ORDER, PLANNED_DATE, TASK_STATUS } from './model';

export function PlanningCapture({ day, disabled = false }: { day?: string; disabled?: boolean }) {
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [unconfirmed, setUnconfirmed] = useState(false);
  const busy = useRef(false);
  const draftRevision = useRef(0);
  const currentDay = useRef(day);
  currentDay.current = day;
  const attempt = useRef<{
    id: string;
    text: string;
    day?: string;
    rank: number;
    revision: number;
  } | null>(null);
  const utils = trpc.useUtils();
  const create = trpc.entity.create.useMutation({ meta: { undoStack: 'self' } });
  function changeText(value: string) {
    draftRevision.current += 1;
    setText(value);
  }
  async function save(retry = false) {
    if (busy.current || disabled || (!retry && (unconfirmed || !text.trim()))) return;
    const intent = retry
      ? attempt.current
      : {
          id: newId(),
          text: text.trim(),
          day,
          rank: Date.now(),
          revision: draftRevision.current,
        };
    if (!intent) return;
    attempt.current = intent;
    const epoch = undoEpoch();
    busy.current = true;
    setError('');
    try {
      const result = await runGraphCommand(() =>
        create.mutateAsync({
          input: {
            id: intent.id,
            title: intent.text.split('\n')[0] || intent.text,
            ...(intent.day === undefined && { body: intent.text }),
            tags: [],
            ...(intent.day === undefined
              ? { props: { [INBOX_STATE]: 'pending' } }
              : {
                  aspects: ['orbis/task'],
                  props: {
                    [TASK_STATUS]: 'planned',
                    [PLANNED_DATE]: intent.day,
                    [PLAN_ORDER]: intent.rank,
                    [INBOX_STATE]: 'processed',
                  },
                }),
          },
          source: 'quick_capture',
        }),
      );
      if (!isUndoEpoch(epoch)) return;
      invalidateGraph(utils);
      if (result.kind !== 'confirmed') {
        setUnconfirmed(result.kind === 'unknown');
        if (result.kind === 'rejected') attempt.current = null;
        setError(
          result.kind === 'unknown'
            ? `Не удалось подтвердить сохранение «${intent.text.split('\n')[0]}»${intent.day ? ` на ${intent.day}` : ' во входящие'}. Повторите сохранение этой записи; новый черновик останется.`
            : result.message,
        );
        return;
      }
      if (result.actionId)
        offerUndoLazy({
          title: intent.day ? 'Задача добавлена' : 'Сохранено во входящие',
          actionId: result.actionId,
          entityIds: [],
        });
      attempt.current = null;
      setUnconfirmed(false);
      // Confirming an older intent must never consume a newer draft or another day's input.
      if (draftRevision.current === intent.revision && currentDay.current === intent.day)
        setText('');
    } finally {
      busy.current = false;
    }
  }
  function submit(e: FormEvent) {
    e.preventDefault();
    void save();
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
            onChange={(e) => changeText(e.target.value)}
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
            onChange={(e) => changeText(e.target.value)}
            className={inputClass}
          />
        )}
        <Button
          type="submit"
          disabled={disabled || create.isPending || unconfirmed || !text.trim()}
          aria-label={day ? 'Добавить задачу' : 'Сохранить во входящие'}
          className="min-h-11 min-w-11 shrink-0 px-3"
        >
          <Plus size={18} aria-hidden />
          {day === undefined && <span className="hidden sm:inline">Сохранить</span>}
        </Button>
      </div>
      {error && (
        <div role="alert" className="space-y-2 text-sm text-danger">
          <p>{error}</p>
          {unconfirmed && (
            <Button
              type="button"
              variant="outline"
              disabled={disabled || create.isPending}
              onClick={() => void save(true)}
            >
              Повторить сохранение
            </Button>
          )}
        </div>
      )}
    </form>
  );
}
