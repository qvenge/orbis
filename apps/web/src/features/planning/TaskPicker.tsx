import { useState } from 'react';
import { trpc } from '../../trpc';
import { Button } from '../../ui/Button';
import type { RunUpdateBatch } from '../page/useUpdateBatch';
import { availableTasksQuery, PLANNED_DATE, planTaskPatch } from './model';

export function TaskPicker({
  day,
  run,
  onDone,
  busy,
}: {
  day: string;
  run: RunUpdateBatch;
  onDone: () => void;
  busy: boolean;
}) {
  const [limit, setLimit] = useState(50);
  const [search, setSearch] = useState('');
  const q = trpc.entity.query.useQuery({ ast: availableTasksQuery(limit + 1) });
  const rows = (q.data ?? [])
    .slice(0, limit)
    .filter((r) => r.title.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  return (
    <div className="space-y-3">
      <input
        aria-label="Найти задачу"
        placeholder="Найти среди задач…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        className="min-h-11 w-full rounded-lg border border-line bg-surface px-3 text-text"
      />
      {q.isError ? (
        <p role="alert">
          Не удалось загрузить задачи.{' '}
          <Button variant="ghost" onClick={() => void q.refetch()}>
            Повторить
          </Button>
        </p>
      ) : q.isPending ? (
        <p role="status">Загрузка…</p>
      ) : (
        <ul className="space-y-1">
          {rows.map((r) => (
            <li key={r.id}>
              <Button
                variant="ghost"
                className="min-h-11 w-full justify-start text-left"
                disabled={busy || r.props[PLANNED_DATE] === day}
                onClick={async () => {
                  if (
                    await run(
                      [{ tool: 'entity_update', input: planTaskPatch(r, day, Date.now()) }],
                      'Задача добавлена в план',
                    )
                  )
                    onDone();
                }}
              >
                {r.title}
                {r.props[PLANNED_DATE] === day && ' · уже в плане'}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {!q.isPending && !q.isError && rows.length === 0 && (
        <p className="text-sm text-text-muted">В загруженных задачах совпадений нет.</p>
      )}
      {(q.data?.length ?? 0) > limit && (
        <Button variant="outline" onClick={() => setLimit((n) => n + 50)}>
          Показать ещё задачи
        </Button>
      )}
    </div>
  );
}
