import { useRef, useState } from 'react';
import { useRegistry } from '../../lib/registry/useRegistry';
import { trpc } from '../../trpc';
import { Button } from '../../ui/Button';
import { type UpdateBatchOperation, useUpdateBatch } from '../page/useUpdateBatch';
import {
  classifyInbox,
  INBOX_STATE,
  inboxQuery,
  PLAN_ORDER,
  PLANNED_DATE,
  type PlanningRecord,
  TASK_STATUS,
} from './model';
import { PlanningCapture } from './PlanningCapture';

export function Inbox({ onOpen }: { onOpen: (id: string) => void }) {
  const [tab, setTab] = useState<'pending' | 'later'>('pending');
  const [limit, setLimit] = useState(50);
  const [busy, setBusy] = useState(false);
  const locked = useRef(false);
  const registry = useRegistry();
  const run = useUpdateBatch();
  const q = trpc.entity.query.useQuery(
    {
      ast: inboxQuery(registry.data?.aspects.map((a) => a.id) ?? [], tab, limit + 1),
      fields: 'full',
    },
    { enabled: !!registry.data },
  );
  const rows = (q.data ?? []).slice(0, limit).filter((r) => classifyInbox(r) === tab);
  async function triage(
    r: PlanningRecord,
    choice: 'task' | 'note' | 'later' | 'pending' | 'archive',
  ) {
    if (locked.current) return;
    const input: Extract<UpdateBatchOperation, { tool: 'entity_update' }>['input'] = { id: r.id };
    if (choice === 'archive') input.archived = true;
    else if (choice === 'task') {
      input.aspects = { attach: ['orbis/task'] };
      input.props = {
        [INBOX_STATE]: 'processed',
        ...(!r.props[TASK_STATUS] || r.props[TASK_STATUS] === 'inbox'
          ? { [TASK_STATUS]: 'planned' }
          : {}),
      };
    } else if (choice === 'note') {
      input.aspects = {
        attach: ['orbis/note'],
        ...(r.aspects.includes('orbis/task') && { detach: ['orbis/task'] }),
      };
      input.props = { [INBOX_STATE]: 'processed' };
      input.tags = [...new Set([...r.tags, 'gtd-reference'])];
      input.unset = [PLANNED_DATE, PLAN_ORDER];
    } else {
      input.props = { [INBOX_STATE]: choice };
      if (choice === 'later') input.unset = [PLANNED_DATE, PLAN_ORDER];
    }
    locked.current = true;
    setBusy(true);
    try {
      await run(
        [{ tool: 'entity_update', input }],
        {
          task: 'Сохранено как задача',
          note: 'Сохранено в знания',
          later: 'Отложено на потом',
          pending: 'Возвращено во входящие',
          archive: 'Запись в архиве',
        }[choice],
      );
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }
  return (
    <section aria-label="Входящие" className="mx-auto w-full max-w-3xl space-y-5 py-2">
      <PlanningCapture />
      <div className="flex gap-1 border-b border-line pb-2">
        <Button
          variant={tab === 'pending' ? 'primary' : 'ghost'}
          aria-pressed={tab === 'pending'}
          className="min-h-11"
          onClick={() => {
            setTab('pending');
            setLimit(50);
          }}
        >
          Разобрать
        </Button>
        <Button
          variant={tab === 'later' ? 'primary' : 'ghost'}
          aria-pressed={tab === 'later'}
          className="min-h-11"
          onClick={() => {
            setTab('later');
            setLimit(50);
          }}
        >
          Позже
        </Button>
      </div>
      {registry.failed || q.isError ? (
        <p role="alert">
          Не удалось загрузить входящие.{' '}
          <Button
            variant="ghost"
            onClick={() => {
              registry.retry();
              void q.refetch();
            }}
          >
            Повторить
          </Button>
        </p>
      ) : !registry.data || q.isPending ? (
        <p role="status" className="text-sm text-text-muted">
          Загрузка входящих…
        </p>
      ) : (
        <>
          {rows.length === 0 && (
            <div className="rounded-xl border border-dashed border-line px-5 py-10 text-center">
              <p className="text-text">
                {tab === 'pending' ? 'Всё разобрано' : 'Пока ничего не отложено'}
              </p>
              <p className="mt-1 text-sm text-text-muted">
                {tab === 'pending'
                  ? 'Новую мысль можно просто записать выше.'
                  : 'Здесь останутся идеи, к которым захочется вернуться.'}
              </p>
            </div>
          )}
          <div className="space-y-3">
            {rows.map((r) => (
              <article
                key={r.id}
                aria-label={r.title}
                className="rounded-xl border border-line bg-surface p-4"
              >
                <button
                  type="button"
                  onClick={() => onOpen(r.id)}
                  className="w-full cursor-pointer text-left font-medium text-text break-words focus-visible:outline-accent"
                >
                  {r.title}
                </button>
                {r.body && r.body !== r.title && (
                  <p className="mt-2 line-clamp-4 whitespace-pre-wrap text-sm text-text-muted break-words">
                    {r.body.startsWith(`${r.title}\n`) ? r.body.slice(r.title.length + 1) : r.body}
                  </p>
                )}
                <div className="mt-3 flex flex-wrap gap-1">
                  {tab === 'later' ? (
                    <Button
                      variant="outline"
                      className="min-h-11"
                      disabled={busy}
                      onClick={() => void triage(r, 'pending')}
                    >
                      Вернуть во входящие
                    </Button>
                  ) : (
                    <>
                      <Button
                        variant="outline"
                        className="min-h-11"
                        disabled={busy}
                        onClick={() => void triage(r, 'task')}
                      >
                        В задачи
                      </Button>
                      <Button
                        variant="ghost"
                        className="min-h-11"
                        disabled={busy}
                        onClick={() => void triage(r, 'note')}
                      >
                        В знания
                      </Button>
                      <Button
                        variant="ghost"
                        className="min-h-11"
                        disabled={busy}
                        onClick={() => void triage(r, 'later')}
                      >
                        Позже
                      </Button>
                    </>
                  )}
                  <Button
                    variant="ghost"
                    className="min-h-11"
                    disabled={busy}
                    onClick={() => void triage(r, 'archive')}
                  >
                    В архив
                  </Button>
                </div>
              </article>
            ))}
          </div>
          {(q.data?.length ?? 0) > limit && (
            <Button variant="outline" onClick={() => setLimit((n) => n + 50)}>
              Показать ещё
            </Button>
          )}
        </>
      )}
    </section>
  );
}
