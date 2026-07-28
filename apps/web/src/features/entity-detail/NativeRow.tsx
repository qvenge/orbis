import { BUILTIN_ASPECT_META, parseRuleTitle } from '@orbis/shared';
import { useState } from 'react';
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

/**
 * Заголовок строки: статичный текст без onSaveTitle (списки транзакций CategoryScreen) и
 * inline-редактор с ним (Detail, DF п.3). Правка title обязана существовать: 02-core-os
 * §2.7 — «правка памяти = правка обычной сущности (title, поля аспекта, body)», а вся
 * машиночитаемая часть memory-правила лежит именно в title (K19.4). Отдельного экрана не
 * заводим — тот же inline-паттерн, что у body и полей аспектов.
 */
function Title({
  value,
  onSave,
  className = '',
  warn,
}: {
  value: string;
  onSave?: (title: string) => void;
  className?: string;
  /** Предупреждение под строкой ввода по ТЕКУЩЕМУ черновику; null — всё в порядке. */
  warn?: (draft: string) => string | null;
}) {
  if (onSave === undefined) {
    return <span className={`flex-1 ${TITLE_CLASS} ${className}`}>{value}</span>;
  }
  return <TitleEditor value={value} onSave={onSave} className={className} warn={warn} />;
}

function TitleEditor({
  value,
  onSave,
  className,
  warn,
}: {
  value: string;
  onSave: (title: string) => void;
  className: string;
  warn?: (draft: string) => string | null;
}) {
  const [draft, setDraft] = useState(value);
  const [serverValue, setServerValue] = useState(value);

  // Тот же приём, что у BodyEditor (DetailScreen) и AspectField (D6c п.3): внешнее
  // значение подхватываем, но ТОЛЬКО если черновик не трогали — иначе текст, который
  // владелец печатает прямо сейчас, затирался бы рефетчем после чужой мутации.
  if (value !== serverValue) {
    setServerValue(value);
    if (draft === serverValue) setDraft(value);
  }

  const input = (
    <input
      aria-label="Заголовок"
      data-testid="title-edit"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      // Пустой заголовок сущности не бывает (entityUpdateInput: title.min(1)) — вместо
      // заведомо отказного запроса возвращаем серверное значение.
      onBlur={() => {
        if (draft.trim() === '') setDraft(value);
        else if (draft !== value) onSave(draft);
      }}
      className={`min-w-0 flex-1 rounded-md bg-transparent px-1 ${TITLE_CLASS} outline-none transition hover:bg-surface-2/60 focus-visible:bg-surface-2/70 focus-visible:ring-2 focus-visible:ring-accent/30 ${className}`}
    />
  );
  // Без warn вёрстка прежняя — строка остаётся одной flex-ячейкой (её делят сумма, бейдж
  // и чекбокс соседних веток). Колонку заводим только там, где предупреждение возможно.
  if (warn === undefined) return input;
  const warning = warn(draft);
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
      {input}
      {warning !== null && (
        <p data-testid="title-warning" className="px-1 text-xs text-[var(--color-warning)]">
          {warning}
        </p>
      )}
    </div>
  );
}

// Отдельный компонент, а не ветка внутри NativeRow (D6c п.2): хук названия категории
// обязан быть безусловным, а запрос категорий не должен уходить с каждой нефинансовой
// строки (прецедент CategoryField в AspectCards).
function FinancialRow({
  title,
  financial,
  onSaveTitle,
}: {
  title: string;
  financial: Record<string, unknown>;
  onSaveTitle?: (title: string) => void;
}) {
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
      <Title value={title} onSave={onSaveTitle} />
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

/** Формат правила «паттерн → категория» (shared/memory/rule.ts) — тот же разбор, что в резолве. */
function ruleFormatWarning(draft: string): string | null {
  return parseRuleTitle(draft) === null
    ? 'Формат правила не распознан — нужно «паттерн → категория». Такое правило не применяется'
    : null;
}

function keyFieldsFor(aspectId: string): string[] {
  return BUILTIN_ASPECT_META.find((m) => m.id === aspectId)?.viewConfig.keyFields ?? [];
}

// §3.6 нативный рендер строки сущности: ветки task / financial / schedule / generic.
// onSaveTitle — опционален: с ним заголовок становится inline-редактором (Detail),
// без него остаётся текстом (строки транзакций CategoryScreen).
export function NativeRow({
  entity,
  onToggleTask,
  onSaveTitle,
}: {
  entity: Entity;
  onToggleTask: (done: boolean) => void;
  onSaveTitle?: (title: string) => void;
}) {
  const aspects = entity.aspects as Record<string, Record<string, unknown>>;

  const task = aspects['orbis/task'];
  if (task) {
    const done = task.status === 'done';
    return (
      <div className="flex items-center gap-2" data-testid="native-task">
        <Checkbox aria-label="Готово" checked={done} onCheckedChange={onToggleTask} />
        <Title
          value={entity.title}
          onSave={onSaveTitle}
          className={done ? 'text-text-muted line-through' : ''}
        />
        {typeof task.status === 'string' && task.status !== 'done' && <Badge>{task.status}</Badge>}
      </div>
    );
  }

  const financial = aspects['orbis/financial'];
  if (financial) {
    return <FinancialRow title={entity.title} financial={financial} onSaveTitle={onSaveTitle} />;
  }

  // Память AI: у ПРАВИЛА весь машиночитаемый смысл лежит в заголовке (K19.4), а inline-правка
  // ломает его одним символом — стрелку U+2192 с клавиатуры не набрать. Признака «формат не
  // распознан» не было нигде: запись оставалась в списке «Память AI» и выглядела живой, хотя
  // ни fast-path, ни резолв импорта её уже не применяли. Предупреждение считается по ЧЕРНОВИКУ,
  // то есть видно до сохранения; у факта формата нет — предупреждать не о чем.
  const memory = aspects['orbis/memory'];
  if (memory) {
    const isRule = memory.kind === 'rule';
    return (
      <div className="flex items-start gap-2" data-testid="native-memory">
        <Title
          value={entity.title}
          onSave={onSaveTitle}
          warn={isRule ? ruleFormatWarning : undefined}
        />
        {typeof memory.kind === 'string' && <Badge>{memory.kind}</Badge>}
      </div>
    );
  }

  const schedule = aspects['orbis/schedule'];
  if (schedule) {
    return (
      <div className="flex items-center gap-2" data-testid="native-schedule">
        <Title value={entity.title} onSave={onSaveTitle} />
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
      <Title value={entity.title} onSave={onSaveTitle} />
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
