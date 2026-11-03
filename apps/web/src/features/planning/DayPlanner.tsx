import { getQueryKey } from '@trpc/react-query';
import { useRef, useState } from 'react';
import { useFreshnessVisible } from '../../lib/freshness/screen';
import {
  useCreateAwareOpen,
  useCreatePlacement,
  useCreateSurface,
} from '../../lib/optimistic/use-create-intent';
import { trpc } from '../../trpc';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { useToast } from '../../ui/toast-store';
import { type RunUpdateBatch, useUpdateBatch } from '../page/useUpdateBatch';
import { dayQuery, isClosed, PLAN_ORDER, sortPlannedTasks } from './model';
import { PlannedTaskRow } from './PlannedTaskRow';
import { PlanningCapture } from './PlanningCapture';
import { TaskPicker } from './TaskPicker';
import { usePlanningDay } from './usePlanningDay';

export function DayPlanner({
  onOpen,
  captureSlot,
}: {
  onOpen: (id: string) => void;
  captureSlot?: string;
}) {
  const { day, selection, select, ready, failed, retry } = usePlanningDay();
  const [limit, setLimit] = useState(50);
  const [picker, setPicker] = useState(false);
  const [busy, setBusy] = useState(false);
  const locked = useRef(false);
  const update = useUpdateBatch();
  const { show } = useToast();
  const run: RunUpdateBatch = async (...args) => {
    if (locked.current) return false;
    locked.current = true;
    setBusy(true);
    try {
      return await update(...args);
    } finally {
      locked.current = false;
      setBusy(false);
    }
  };
  const shown = useFreshnessVisible();
  const input = { ast: dayQuery(day, limit + 1) };
  const q = trpc.entity.query.useQuery(input, { enabled: ready && shown });
  const rows = sortPlannedTasks((q.data?.rows ?? []).slice(0, limit));
  const placement = {
    key: getQueryKey(trpc.entity.query, input, 'query'),
    ids: rows.map((row) => row.id),
  };
  const origin = useCreateSurface(`planning:${day}`, captureSlot);
  const { hiddenCanonical } = useCreatePlacement(origin, ready ? placement : undefined);
  const shownRows = rows.filter((row) => !hiddenCanonical.has(row.id));
  const open = shownRows.filter((r) => !isClosed(r));
  const closed = shownRows.filter(isClosed);
  const openRecord = useCreateAwareOpen(onOpen);
  const more = (q.data?.rows.length ?? 0) > limit;
  async function reorder(id: string, offset: number) {
    const selected = rows.find((r) => r.id === id);
    if (!selected) return;
    const items = rows.filter((r) => isClosed(r) === isClosed(selected));
    const index = items.findIndex((r) => r.id === id);
    const adjacent = index + offset;
    if (index < 0 || adjacent < 0 || adjacent >= items.length) return;
    if (more) {
      show('Загрузите оставшиеся задачи перед изменением порядка');
      return;
    }
    if (items.length > 100) {
      show('В одном действии можно упорядочить до 100 задач');
      return;
    }
    const reordered = [...items];
    const current = reordered[index];
    const neighbour = reordered[adjacent];
    if (!current || !neighbour) return;
    reordered[index] = neighbour;
    reordered[adjacent] = current;
    await run(
      reordered.map((r, rank) => ({
        tool: 'entity_update',
        input: { id: r.id, props: { [PLAN_ORDER]: rank } },
      })),
      'Порядок задач изменён',
    );
  }
  function changeDay(value: string) {
    if (value) {
      select(value);
      setLimit(50);
    }
  }
  const renderRows = (items: typeof rows) => (
    <ul className="divide-y divide-line/50">
      {items.map((r) => (
        <PlannedTaskRow
          key={r.id}
          record={r}
          onOpen={openRecord}
          run={run}
          busy={busy}
          onReorder={(id, offset) => void reorder(id, offset)}
          first={items[0]?.id === r.id}
          last={items.at(-1)?.id === r.id}
        />
      ))}
    </ul>
  );
  return (
    <section aria-label="План дня" className="mx-auto w-full max-w-3xl space-y-5 py-2">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex gap-1 rounded-xl bg-surface-2 p-1">
          <Button
            variant={selection === 'today' ? 'primary' : 'ghost'}
            aria-pressed={selection === 'today'}
            className="min-h-11"
            onClick={() => changeDay('today')}
          >
            Сегодня
          </Button>
          <Button
            variant={selection === 'tomorrow' ? 'primary' : 'ghost'}
            aria-pressed={selection === 'tomorrow'}
            className="min-h-11"
            onClick={() => changeDay('tomorrow')}
          >
            Завтра
          </Button>
        </div>
        <input
          type="date"
          aria-label="Выбрать дату"
          value={day}
          onChange={(e) => changeDay(e.target.value)}
          className="min-h-11 max-w-full rounded-lg border border-line bg-surface px-3 text-sm text-text"
        />
      </div>
      {failed ? (
        <p role="alert">
          Не удалось загрузить настройки дня.{' '}
          <Button variant="ghost" onClick={() => void retry()}>
            Повторить
          </Button>
        </p>
      ) : (
        <>
          <PlanningCapture
            captureSlot={captureSlot}
            day={day}
            disabled={!ready}
            placement={placement}
          />
          {!ready || q.isPending ? (
            <p role="status" className="text-sm text-text-muted">
              Загрузка плана…
            </p>
          ) : q.isError ? (
            <p role="alert">
              Не удалось загрузить план.{' '}
              <Button variant="ghost" onClick={() => void q.refetch()}>
                Повторить
              </Button>
            </p>
          ) : (
            <>
              {open.length > 0 ? (
                renderRows(open)
              ) : (
                <div className="rounded-xl border border-dashed border-line px-5 py-10 text-center">
                  <p className="text-text">
                    {closed.length > 0
                      ? 'Все задачи на этот день завершены'
                      : 'День ещё не заполнен'}
                  </p>
                  <p className="mt-1 text-sm text-text-muted">
                    Добавь задачу выше или выбери из существующих.
                  </p>
                </div>
              )}
              {closed.length > 0 && (
                <details className="rounded-lg bg-surface-2 px-3 py-2">
                  <summary className="cursor-pointer py-2 text-sm text-text-muted">
                    Завершённые · {closed.length}
                  </summary>
                  {renderRows(closed)}
                </details>
              )}
              {more && (
                <Button variant="outline" onClick={() => setLimit((n) => n + 50)}>
                  Показать ещё
                </Button>
              )}
            </>
          )}
          <Button
            variant="ghost"
            className="min-h-11"
            disabled={!ready}
            onClick={() => setPicker(true)}
          >
            + Из существующих задач
          </Button>
        </>
      )}
      <Dialog open={picker} onOpenChange={setPicker} title="Добавить в план дня">
        {picker && <TaskPicker day={day} busy={busy} run={run} onDone={() => setPicker(false)} />}
      </Dialog>
    </section>
  );
}
