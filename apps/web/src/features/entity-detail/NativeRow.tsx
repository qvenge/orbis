import { useState } from 'react';
import { useRefTitle } from '../../lib/entity-ref/RefField';
import { formatMoney, type MoneyTone } from '../../lib/format';
import { displayText } from '../../lib/registry/format';
import { fieldLabel } from '../../lib/registry/labels';
import { useRegistry } from '../../lib/registry/useRegistry';
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
 * §2.7 — «правка памяти = правка обычной сущности (title, поля аспекта, body)».
 * Отдельного экрана не заводим — тот же inline-паттерн, что у body и полей аспектов.
 *
 * ПРЕДУПРЕЖДЕНИЯ О ФОРМАТЕ ЗДЕСЬ БОЛЬШЕ НЕТ, и это не упрощение: механизм `warn` был
 * заведён ровно под одного вызывающего — подсказку «правило не распознано» у memory-правила
 * (его смысл жил в заголовке и ломался одним символом). После В7 смысл правила живёт в
 * свойствах, заголовок стал генерируемой подписью, и ломать правкой заголовка стало нечего;
 * оставленный механизм был бы веткой без единственного вызывателя.
 */
function Title({
  value,
  onSave,
  className = '',
}: {
  value: string;
  onSave?: (title: string) => void;
  className?: string;
}) {
  if (onSave === undefined) {
    return <span className={`flex-1 ${TITLE_CLASS} ${className}`}>{value}</span>;
  }
  return <TitleEditor value={value} onSave={onSave} className={className} />;
}

function TitleEditor({
  value,
  onSave,
  className,
}: {
  value: string;
  onSave: (title: string) => void;
  className: string;
}) {
  const [draft, setDraft] = useState(value);
  const [serverValue, setServerValue] = useState(value);

  // Тот же приём, что у редактора тела (BodyEditor) и AspectField (D6c п.3): внешнее
  // значение подхватываем, но ТОЛЬКО если черновик не трогали — иначе текст, который
  // владелец печатает прямо сейчас, затирался бы рефетчем после чужой мутации.
  if (value !== serverValue) {
    setServerValue(value);
    if (draft === serverValue) setDraft(value);
  }

  return (
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
}

/**
 * Строка памяти AI. У ПРАВИЛА она собирается ИЗ СВОЙСТВ (В7): образец —
 * `orbis/rule_pattern`, назначаемая категория — `orbis/rule_target` (ссылка), и её
 * название разыменовывается при показе. Именно поэтому переименование категории здесь
 * видно сразу: до реформы правая часть правила была сохранённой СТРОКОЙ, и экран
 * показывал прежнее имя, которого в графе уже не было.
 *
 * Заголовок остаётся inline-редактируемым (§2.7 — правка памяти это правка обычной
 * записи), но смысла правила он больше не несёт: это генерируемая подпись. Сам образец
 * правится карточкой свойства, как любое другое значение.
 *
 * Отдельный компонент, а не ветка внутри NativeRow: хук разыменования ссылки обязан быть
 * безусловным (та же причина, что у FinancialRow).
 */
function MemoryRow({
  title,
  props,
  onSaveTitle,
}: {
  title: string;
  props: Record<string, unknown>;
  onSaveTitle?: (title: string) => void;
}) {
  const registry = useRegistry();
  const kind = props['orbis/memory_kind'];
  const pattern = props['orbis/rule_pattern'];
  const targetRef = props['orbis/rule_target'];
  const {
    title: targetTitle,
    isPending: targetPending,
    isError: targetFailed,
  } = useRefTitle(
    registry.property('orbis/rule_target'),
    typeof targetRef === 'string' ? targetRef : '',
  );
  const isRule = kind === 'rule';
  return (
    <div className="flex items-center gap-2" data-testid="native-memory">
      <Title value={title} onSave={onSaveTitle} />
      {isRule && typeof pattern === 'string' && pattern !== '' && (
        <span data-testid="memory-rule-pattern" className="truncate text-sm text-text-secondary">
          {pattern}
        </span>
      )}
      {/* Пока список категорий грузится, названия нет — бейджа нет вовсе (D6d п.1):
          иначе на холодном кэше мелькал бы сырой uuid и подменялся названием. */}
      {isRule &&
        typeof targetRef === 'string' &&
        targetRef !== '' &&
        !targetPending &&
        !targetFailed && <Badge>{targetTitle}</Badge>}
      {typeof kind === 'string' && <Badge>{kind}</Badge>}
    </div>
  );
}

// Отдельный компонент, а не ветка внутри NativeRow (D6c п.2): хук названия категории
// обязан быть безусловным, а запрос категорий не должен уходить с каждой нефинансовой
// строки (прецедент CategoryField в AspectCards).
function FinancialRow({
  title,
  props,
  onSaveTitle,
}: {
  title: string;
  /** Свойства ЗАПИСИ (§А1-1); аспект `orbis/financial` — только признак рода строки. */
  props: Record<string, unknown>;
  onSaveTitle?: (title: string) => void;
}) {
  const money = formatMoney(
    String(props['orbis/amount'] ?? '0'),
    (props['orbis/direction'] as 'expense' | 'income') ?? 'expense',
  );
  const ref = props['orbis/finance_category'];
  const categoryRef = typeof ref === 'string' ? ref : '';
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
  // Значения — плоско в `props` по id свойства, род строки — по СПИСКУ аспектов (§А1-1).
  // Прежде и то, и другое читалось из одной карты, и «аспект навешен» было неотличимо от
  // «в аспекте что-то заполнено»: задача без единого свойства не получала чекбокса.
  const props = entity.props;
  const aspects = new Set(entity.aspects);
  // Подписи и состав keyFields — из реестра (§А9-2). Хук зовётся ДО веток рода строки:
  // ветвление идёт ниже по данным, и вызов хука внутри ветки нарушил бы правило порядка
  // хуков на первой же смене аспекта у открытой записи.
  const registry = useRegistry();

  if (aspects.has('orbis/task')) {
    const status = props['orbis/task_status'];
    const done = status === 'done';
    return (
      <div className="flex items-center gap-2" data-testid="native-task">
        <Checkbox aria-label="Готово" checked={done} onCheckedChange={onToggleTask} />
        <Title
          value={entity.title}
          onSave={onSaveTitle}
          className={done ? 'text-text-muted line-through' : ''}
        />
        {typeof status === 'string' && status !== 'done' && <Badge>{status}</Badge>}
      </div>
    );
  }

  if (aspects.has('orbis/financial')) {
    return <FinancialRow title={entity.title} props={props} onSaveTitle={onSaveTitle} />;
  }

  if (aspects.has('orbis/memory')) {
    return <MemoryRow title={entity.title} props={props} onSaveTitle={onSaveTitle} />;
  }

  if (aspects.has('orbis/schedule')) {
    return (
      <div className="flex items-center gap-2" data-testid="native-schedule">
        <Title value={entity.title} onSave={onSaveTitle} />
        {props['orbis/all_day'] ? (
          <Badge>весь день</Badge>
        ) : (
          <span className="text-xs text-text-secondary">
            {String(props['orbis/start_at'] ?? '')}
          </span>
        )}
      </div>
    );
  }

  // generic: первые 2–3 keyFields установленного аспекта из РЕЕСТРА (§А9-2) — ЗАПОЛНЕННЫЕ и
  // подписанные тем же источником, что карточки свойств и карточки чата. Без подписи шапка
  // печатала сырой ключ ровно над карточкой, где то же поле подписано словом: у цели
  // «target_value: 300000.00» стояло над «Целевое значение: 300000.00» — одно значение, два
  // имени, на одном экране.
  //
  // «Первый аспект» — первый по RANK реестра, а не первый ключ объекта: порядок ключей карты
  // задавался порядком записи в jsonb, то есть тем, в каком порядке аспекты навешивали, — и
  // одна и та же запись показывала разные поля у двух владельцев. Список `entity.aspects`
  // такой же неупорядоченный, поэтому порядок берётся у выдачи реестра (она сортирована по
  // `rank`, §А2-2), а не у записи.
  //
  // Состав keyFields — тоже из снимка (`view_config`), а не из статики shared: владелец
  // вправе поменять его у своего аспекта, и вторая копия состава разъехалась бы с реестром.
  //
  // Отбор по наличию значения повторяет правило сервера, который собирает keyFields
  // чат-карточек из того же реестра и незаполненные поля пропускает
  // (tools/dispatch.ts: `if (value !== undefined) keyFields[propertyId] = value`).
  // Без него у цели (E3) шапка печатала «Текущее значение: —» — кэш, который сервер не
  // пишет никогда (goals/progress.ts считает прогресс на каждом чтении), — прямо над
  // полосой прогресса, где стоит настоящее число.
  const firstAspect = (registry.data?.aspects ?? []).find((a) => aspects.has(a.id));
  const fields = (firstAspect?.viewConfig.keyFields ?? [])
    .filter((id) => props[id] !== undefined)
    .slice(0, 3);
  return (
    <div className="flex items-center gap-2" data-testid="native-generic">
      <Title value={entity.title} onSave={onSaveTitle} />
      <dl className="flex gap-2 text-xs text-text-secondary">
        {fields.map((id) => (
          <div key={id} className="flex gap-1">
            <dt>{fieldLabel(registry, id)}:</dt>
            {/* Показ — по ТИПУ свойства: у `select` печатается подпись варианта, а не его
                ключ, у булева — «да»/«нет». `String(value)` печатал `true` и `text` теми же
                словами, которыми они лежат в базе. */}
            <dd>{displayText(registry.property(id), props[id])}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
