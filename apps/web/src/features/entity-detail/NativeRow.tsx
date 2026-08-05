import { BUILTIN_ASPECT_META, parseRuleTitle } from '@orbis/shared';
import { useState } from 'react';
import { fieldLabel } from '../../lib/field-labels';
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

  // Тот же приём, что у BodySection (DetailScreen) и AspectField (D6c п.3): внешнее
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
      {...(warn !== undefined ? { 'aria-describedby': 'title-format-warning' } : {})}
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
        // text-alert — документированная AA-пара (5.18:1); --color-warning объявлен как
        // цвет ЗАЛИВКИ бара Budget и на белом листе даёт 3.18:1 — самый нечитаемый текст
        // на экране у сообщения, ради видимости которого правка и делалась.
        // role=status + aria-describedby: при правке с клавиатуры/скринридером
        // предупреждение иначе не объявляется вовсе.
        <p
          id="title-format-warning"
          role="status"
          data-testid="title-warning"
          className="px-1 text-xs text-alert"
        >
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
  const {
    title: categoryTitle,
    isPending: categoryPending,
    isError: categoryFailed,
  } = useCategoryTitle(categoryRef);

  return (
    <div className="flex items-center gap-2" data-testid="native-financial">
      <Title value={title} onSave={onSaveTitle} />
      <span
        data-testid="native-amount"
        className={`text-lg font-medium tabular-nums ${AMOUNT_TONE_CLASS[money.tone]}`}
      >
        {money.text}
      </span>
      {categoryRef !== '' && !categoryPending && !categoryFailed && <Badge>{categoryTitle}</Badge>}
    </div>
  );
}

/**
 * Формат правила «паттерн → категория» (shared/memory/rule.ts) — тот же разбор, что в резолве.
 *
 * Текст говорит ровно правду: мёртвым нераспознанное правило становится в
 * ДЕТЕРМИНИРОВАННЫХ путях (быстрый ввод, резолв импорта, гейт эскалации), а в системный
 * промпт оно уезжает как есть — в разговоре модель его всё равно учтёт. Подсказка формата
 * даёт НАБИРАЕМЫЙ вариант разделителя: U+2192 с клавиатуры не набрать, ради чего разбор
 * и научили понимать «->».
 */
function ruleFormatWarning(draft: string): string | null {
  return parseRuleTitle(draft) === null
    ? 'Формат правила не распознан — нужно «паттерн -> категория». Быстрый ввод и импорт такое правило не применят (AI учтёт его только в разговоре)'
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

  // generic: первые 2–3 keyFields установленного аспекта из реестра — ЗАПОЛНЕННЫЕ,
  // подписанные ПО-РУССКИ тем же словарём, что карточки аспектов и карточки чата
  // (lib/field-labels). Без него шапка печатала сырой ключ ровно над карточкой, где то же
  // поле подписано словом: у цели «target_value: 300000.00» стояло над «цель: 300000.00»
  // — одно значение, два имени, на одном экране. Ключа нет в словаре (кастомный аспект) —
  // печатается как есть: честная деградация, а не пустая подпись.
  // Отбор по наличию значения повторяет правило сервера, который собирает keyFields
  // чат-карточек из того же реестра и незаполненные поля пропускает
  // (tools/dispatch.ts: `if (value !== undefined) keyFields[field] = value`).
  // Без него у цели (E3) шапка печатала `current_value: —` — поле-кэш, которое сервер
  // не пишет никогда (goals/progress.ts считает прогресс на каждом чтении), — прямо над
  // полосой прогресса, где стоит настоящее число. Прочерк «поле есть, но пусто» остаётся
  // честным только для полей, которые кто-то заполняет.
  const firstAspect = Object.keys(aspects)[0];
  const firstFields = firstAspect ? aspects[firstAspect] : undefined;
  const fields = firstAspect
    ? keyFieldsFor(firstAspect)
        .filter((k) => firstFields?.[k] !== undefined)
        .slice(0, 3)
    : [];
  return (
    <div className="flex items-center gap-2" data-testid="native-generic">
      <Title value={entity.title} onSave={onSaveTitle} />
      <dl className="flex gap-2 text-xs text-text-secondary">
        {fields.map((k) => (
          <div key={k} className="flex gap-1">
            <dt>{fieldLabel(k)}:</dt>
            <dd>{String(firstFields?.[k] ?? '—')}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
