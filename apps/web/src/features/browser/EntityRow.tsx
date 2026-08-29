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
 *
 * `showMeta={false}` подавляет правую мету — для списков, где дату строки задаёт сам
 * список («Просроченное» в Agenda подписывает строку релевантной датой, §4.2). Дефолт
 * `true`: Browser (EntityList) прежний, поведение по умолчанию не менялось.
 */
export function EntityRow({ entity, showMeta = true }: { entity: Entity; showMeta?: boolean }) {
  // Род строки — по СПИСКУ аспектов, значения — плоско в `props` по id свойства (§А1-1).
  // Прежде и то, и другое читалось из одной карты, и «аспект навешен» было неотличимо от
  // «в аспекте что-то заполнено»: задача без единого свойства оставалась без глифа.
  const props = entity.props;
  const aspects = new Set(entity.aspects);
  const task = aspects.has('orbis/task');
  const done = props['orbis/task_status'] === 'done';

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

  const due = props['orbis/due_date'];
  const startAt = props['orbis/start_at'];
  let meta: React.ReactNode = null;
  if (aspects.has('orbis/financial')) {
    const money = formatMoney(
      String(props['orbis/amount'] ?? '0'),
      (props['orbis/direction'] as 'expense' | 'income') ?? 'expense',
    );
    meta = (
      <span className={`text-xs font-medium tabular-nums ${AMOUNT_TONE_CLASS[money.tone]}`}>
        {money.text}
      </span>
    );
  } else if (task && typeof due === 'string') {
    meta = <span className="text-xs text-text-muted">{formatDay(due)}</span>;
  } else if (aspects.has('orbis/schedule') && typeof startAt === 'string') {
    meta = <span className="text-xs text-text-muted">{formatDay(startAt)}</span>;
  }

  return (
    <>
      {leading}
      <span className={`flex-1 truncate ${done ? 'text-text-muted line-through' : ''}`}>
        {entity.title}
      </span>
      {task && props['orbis/priority'] === 'high' && !done && (
        <span
          role="img"
          aria-label="высокий приоритет"
          className="size-1.5 shrink-0 rounded-full bg-danger"
        />
      )}
      {showMeta && meta}
    </>
  );
}
