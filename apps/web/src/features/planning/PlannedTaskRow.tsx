import { MoreHorizontal } from 'lucide-react';
import { useId, useState } from 'react';
import { Button } from '../../ui/Button';
import { Checkbox } from '../../ui/Checkbox';
import { Dialog } from '../../ui/Dialog';
import type { RunUpdateBatch } from '../page/useUpdateBatch';
import { PLAN_ORDER, PLANNED_DATE, type PlanningRecord, TASK_STATUS } from './model';

export function PlannedTaskRow({
  record,
  onOpen,
  run,
  busy,
  onReorder,
  first,
  last,
}: {
  record: PlanningRecord;
  onOpen: (id: string) => void;
  run: RunUpdateBatch;
  busy: boolean;
  onReorder: (id: string, offset: number) => void;
  first: boolean;
  last: boolean;
}) {
  const checkboxId = useId();
  const [menu, setMenu] = useState(false);
  const [date, setDate] = useState(String(record.props[PLANNED_DATE] ?? ''));
  const done = record.props[TASK_STATUS] === 'done';
  const cancelled = record.props[TASK_STATUS] === 'cancelled';
  return (
    <li className="flex min-h-14 items-center gap-2 rounded-lg px-1 hover:bg-surface-2">
      <label
        htmlFor={checkboxId}
        className="flex min-h-11 min-w-11 cursor-pointer items-center justify-center"
      >
        <Checkbox
          id={checkboxId}
          aria-label={`${done ? 'Вернуть в работу' : 'Выполнить'}: ${record.title}`}
          checked={done}
          disabled={busy || cancelled}
          onCheckedChange={() =>
            void run(
              [
                {
                  tool: 'entity_update',
                  input: { id: record.id, props: { [TASK_STATUS]: done ? 'planned' : 'done' } },
                },
              ],
              done ? 'Задача возвращена' : 'Задача выполнена',
            )
          }
        />
      </label>
      <button
        type="button"
        onClick={() => onOpen(record.id)}
        className={`min-w-0 flex-1 cursor-pointer py-3 text-left text-sm break-words focus-visible:outline-accent ${done || cancelled ? 'text-text-muted line-through' : 'text-text'}`}
      >
        {record.title}
      </button>
      {record.props[TASK_STATUS] === 'waiting' && (
        <span className="text-xs text-text-muted">Ожидание</span>
      )}
      {record.props[TASK_STATUS] === 'in_progress' && (
        <span className="text-xs text-text-muted">В работе</span>
      )}
      <Button
        variant="ghost"
        className="min-h-11 min-w-11 px-2"
        aria-label={`Действия: ${record.title}`}
        onClick={() => setMenu(true)}
      >
        <MoreHorizontal size={18} aria-hidden />
      </Button>
      <Dialog open={menu} onOpenChange={setMenu} title={record.title}>
        <div className="space-y-4">
          <div className="flex gap-2">
            <Button
              variant="outline"
              disabled={busy || first}
              onClick={() => {
                onReorder(record.id, -1);
                setMenu(false);
              }}
            >
              Выше
            </Button>
            <Button
              variant="outline"
              disabled={busy || last}
              onClick={() => {
                onReorder(record.id, 1);
                setMenu(false);
              }}
            >
              Ниже
            </Button>
          </div>
          <label className="flex flex-wrap items-center gap-3 text-sm">
            Перенести на
            <input
              type="date"
              aria-label="Новый день"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="min-h-11 rounded-lg border border-line bg-surface p-2 text-text"
            />
          </label>
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={busy || !date}
              onClick={async () => {
                if (
                  await run(
                    [
                      {
                        tool: 'entity_update',
                        input: {
                          id: record.id,
                          props: { [PLANNED_DATE]: date, [PLAN_ORDER]: Date.now() },
                        },
                      },
                    ],
                    'Задача перенесена',
                  )
                )
                  setMenu(false);
              }}
            >
              Перенести
            </Button>
            <Button
              variant="ghost"
              disabled={busy}
              onClick={async () => {
                if (
                  await run(
                    [
                      {
                        tool: 'entity_update',
                        input: { id: record.id, unset: [PLANNED_DATE, PLAN_ORDER] },
                      },
                    ],
                    'Задача убрана из плана дня',
                  )
                )
                  setMenu(false);
              }}
            >
              Убрать из этого дня
            </Button>
          </div>
        </div>
      </Dialog>
    </li>
  );
}
