import { CheckCircle2, Circle, FileText } from 'lucide-react';
import { formatMoney, type MoneyTone } from '../../lib/format';
import type { RouterOutputs } from '../../trpc';

type Entity = RouterOutputs['entity']['query'][number];

const AMOUNT_TONE_CLASS: Record<MoneyTone, string> = {
  danger: 'text-danger',
  positive: 'text-success',
};

// Дата ('2026-07-18' или полный ISO) → '18 июл.'; битое значение возвращаем как есть.
// Date-only парсится как полночь UTC — форматируем в UTC, иначе в западных таймзонах
// срок уехал бы на день назад. Полный ISO — в локальной зоне.
export function formatDay(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  return new Intl.DateTimeFormat('ru-RU', {
    day: 'numeric',
    month: 'short',
    ...(dateOnly ? { timeZone: 'UTC' } : {}),
  }).format(d);
}

/**
 * «Живая строка сущности» — подпись дизайна Orbis: слева эмодзи (или тип-глиф),
 * справа типизированная мета из аспектов (срок задачи, сумма с тоном, дата события).
 * Не контрол: чекбокс-глиф задачи — индикатор состояния, переключение — в Detail.
 */
export function EntityRow({ entity }: { entity: Entity }) {
  const aspects = entity.aspects as Record<string, Record<string, unknown>>;
  const task = aspects['orbis/task'];
  const financial = aspects['orbis/financial'];
  const schedule = aspects['orbis/schedule'];
  const done = task?.status === 'done';

  const leading = entity.emoji ? (
    <span aria-hidden className="w-5 text-center leading-none">
      {entity.emoji}
    </span>
  ) : task ? (
    done ? (
      <CheckCircle2 size={16} className="w-5 shrink-0 text-text-muted" aria-hidden />
    ) : (
      <Circle size={16} className="w-5 shrink-0 text-text-muted/70" aria-hidden />
    )
  ) : (
    <FileText size={16} className="w-5 shrink-0 text-text-muted/70" aria-hidden />
  );

  let meta: React.ReactNode = null;
  if (financial) {
    const money = formatMoney(
      String(financial.amount ?? '0'),
      (financial.direction as 'expense' | 'income') ?? 'expense',
    );
    meta = (
      <span className={`text-xs font-medium tabular-nums ${AMOUNT_TONE_CLASS[money.tone]}`}>
        {money.text}
      </span>
    );
  } else if (task && typeof task.due_date === 'string') {
    meta = <span className="text-xs text-text-muted">{formatDay(task.due_date)}</span>;
  } else if (schedule && typeof schedule.start_at === 'string') {
    meta = <span className="text-xs text-text-muted">{formatDay(schedule.start_at)}</span>;
  }

  return (
    <>
      {leading}
      <span className={`flex-1 truncate ${done ? 'text-text-muted line-through' : ''}`}>
        {entity.title}
      </span>
      {task && typeof task.priority === 'string' && task.priority === 'high' && !done && (
        <span
          role="img"
          aria-label="высокий приоритет"
          className="size-1.5 shrink-0 rounded-full bg-danger"
        />
      )}
      {meta}
    </>
  );
}
