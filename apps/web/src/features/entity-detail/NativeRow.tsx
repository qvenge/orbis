import { BUILTIN_ASPECT_META } from '@orbis/shared';
import { formatMoney, type MoneyTone } from '../../lib/format';
import type { RouterOutputs } from '../../trpc';
import { Badge } from '../../ui/Badge';
import { Checkbox } from '../../ui/Checkbox';
import { useCategoryTitle } from '../budget/categories';

type Entity = RouterOutputs['entity']['query'][number];

// §3.6 rich-money: тон из formatMoney — expense→danger, income→success.
const AMOUNT_TONE_CLASS: Record<MoneyTone, string> = {
  danger: 'text-danger',
  positive: 'text-success',
};

// NativeRow живёт на странице Detail — title здесь является заголовком страницы.
const TITLE_CLASS = 'text-xl font-semibold tracking-tight';

// Отдельный компонент, а не ветка внутри NativeRow (D6c п.2): хук названия категории
// обязан быть безусловным, а запрос категорий не должен уходить с каждой нефинансовой
// строки (прецедент CategoryField в AspectCards).
function FinancialRow({ title, financial }: { title: string; financial: Record<string, unknown> }) {
  const money = formatMoney(
    String(financial.amount ?? '0'),
    (financial.direction as 'expense' | 'income') ?? 'expense',
  );
  const categoryRef = typeof financial.category_ref === 'string' ? financial.category_ref : '';
  // Бейдж — НАЗВАНИЕ категории (D6c п.2): сырой uuid остаётся лишь запасным вариантом,
  // когда категория не найдена. Раньше это был единственный текст, и для транзакции
  // без конверта (строки остатка нет) пользователь видел только uuid.
  // Пока список категорий грузится, значение неизвестно — бейджа нет вовсе (D6d п.1):
  // иначе на холодном кэше uuid мелькал и подменялся названием, бейдж дёргался по ширине.
  const { title: categoryTitle, isPending: categoryPending } = useCategoryTitle(categoryRef);

  return (
    <div className="flex items-center gap-2" data-testid="native-financial">
      <span className={`flex-1 ${TITLE_CLASS}`}>{title}</span>
      <span
        data-testid="native-amount"
        className={`text-lg font-medium tabular-nums ${AMOUNT_TONE_CLASS[money.tone]}`}
      >
        {money.text}
      </span>
      {categoryRef !== '' && !categoryPending && <Badge>{categoryTitle}</Badge>}
    </div>
  );
}

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
        <span className={`flex-1 ${TITLE_CLASS} ${done ? 'text-text-muted line-through' : ''}`}>
          {entity.title}
        </span>
        {typeof task.status === 'string' && task.status !== 'done' && <Badge>{task.status}</Badge>}
      </div>
    );
  }

  const financial = aspects['orbis/financial'];
  if (financial) return <FinancialRow title={entity.title} financial={financial} />;

  const schedule = aspects['orbis/schedule'];
  if (schedule) {
    return (
      <div className="flex items-center gap-2" data-testid="native-schedule">
        <span className={`flex-1 ${TITLE_CLASS}`}>{entity.title}</span>
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
      <span className={`flex-1 ${TITLE_CLASS}`}>{entity.title}</span>
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
