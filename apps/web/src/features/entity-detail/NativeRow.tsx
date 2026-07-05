import { BUILTIN_ASPECT_META } from '@orbis/shared';
import { formatMoney } from '../../lib/format';
import type { RouterOutputs } from '../../trpc';
import { Badge } from '../../ui/Badge';
import { Checkbox } from '../../ui/Checkbox';

type Entity = RouterOutputs['entity']['query'][number];

function keyFieldsFor(aspectId: string): string[] {
  return BUILTIN_ASPECT_META.find((m) => m.id === aspectId)?.viewConfig.keyFields ?? [];
}

// §3.6 нативный рендер строки сущности: ветки task / financial / schedule / generic.
export function NativeRow({
  entity,
  onToggleTask,
}: {
  entity: Entity;
  onToggleTask: (done: boolean) => void;
}) {
  const aspects = entity.aspects as Record<string, Record<string, unknown>>;

  const task = aspects['orbis/task'];
  if (task) {
    const done = task.status === 'done';
    return (
      <div className="flex items-center gap-2" data-testid="native-task">
        <Checkbox aria-label="Готово" checked={done} onCheckedChange={onToggleTask} />
        <span className={done ? 'flex-1 line-through text-text-muted' : 'flex-1'}>
          {entity.title}
        </span>
        {typeof task.status === 'string' && task.status !== 'done' && <Badge>{task.status}</Badge>}
      </div>
    );
  }

  const financial = aspects['orbis/financial'];
  if (financial) {
    const money = formatMoney(
      String(financial.amount ?? '0'),
      (financial.direction as 'expense' | 'income') ?? 'expense',
    );
    return (
      <div className="flex items-center gap-2" data-testid="native-financial">
        <span className="flex-1">{entity.title}</span>
        <span
          data-testid="native-amount"
          className={money.tone === 'danger' ? 'text-danger' : 'text-accent'}
        >
          {money.text}
        </span>
        {typeof financial.category_ref === 'string' && <Badge>{financial.category_ref}</Badge>}
      </div>
    );
  }

  const schedule = aspects['orbis/schedule'];
  if (schedule) {
    return (
      <div className="flex items-center gap-2" data-testid="native-schedule">
        <span className="flex-1">{entity.title}</span>
        {schedule.all_day ? (
          <Badge>весь день</Badge>
        ) : (
          <span className="text-xs text-text-secondary">{String(schedule.start_at ?? '')}</span>
        )}
      </div>
    );
  }

  // generic: первые 2–3 keyFields установленного аспекта из реестра.
  const firstAspect = Object.keys(aspects)[0];
  const fields = firstAspect ? keyFieldsFor(firstAspect).slice(0, 3) : [];
  const firstFields = firstAspect ? aspects[firstAspect] : undefined;
  return (
    <div className="flex items-center gap-2" data-testid="native-generic">
      <span className="flex-1">{entity.title}</span>
      <dl className="flex gap-2 text-xs text-text-secondary">
        {fields.map((k) => (
          <div key={k} className="flex gap-1">
            <dt>{k}:</dt>
            <dd>{String(firstFields?.[k] ?? '—')}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
