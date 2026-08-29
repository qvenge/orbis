// Task B5: экран «Транзакции» (03-budget §3.3) — полный список финансовых сущностей
// с финансовыми фильтрами: месяц ◀▶ (как Overview), категория, направление, planned,
// диапазон сумм, поиск. Строка запроса — ЧИСТЫЙ билдер buildTxQuery (txQuery.ts);
// период — абсолютный диапазон occurred_on=<от>..<до> (расширение грамматики B5),
// окно материализации сервер расширяет сам (§5.4 + materializationWindow).
//
// Шаблоны повторяющихся операций (orbis/schedule.recurrence) в списке СКРЫТЫ — решение
// D20: шаблон не факт траты, агрегаты его не считают. Инстансы шаблона остаются (см.
// фильтр visible ниже).
//
// Строка — компактный native-рендер (решение B5 по Minor B3: NativeRow с text-xl —
// типографика страницы Detail, для плотного списка велика; денежный рендер НЕ
// дублируется — общий formatMoney): дата · title · 🔁 (МЕЖДУ title и суммой,
// §3.3 «визуально различимы») · сумма · бейдж категории в крайней правой колонке.
//
// Действия §3.3: влево-свайп — рекатегоризация (Sheet выбора → entity.update
// category_ref; parent перепривязывает серверный хук A4, §5), вправо-свайп —
// «Сделать повторяющейся». ОТКЛОНЕНИЕ ОТ БУКВЫ 03-budget §3.3 («ставит
// recurring=true»), решение контролёра B5: entity.update {recurring:true} без
// orbis/schedule.recurrence детерминированно отклоняется инвариантом 01-arch §3.3
// (financial_recurring_requires_recurrence, executor/normalize.ts) — инвариант
// главнее буквы. Поэтому действие НЕ мутирует: переход на detail сущности +
// тост-подсказка добавить аспект Schedule с recurrence (attach recurrence на detail
// корректно отвязывает от конверта — хук фазы A); полноценный мастер шаблона — future.
// Тач-свайпы в тестах не эмулируются надёжно → кнопки-действия в каждой строке
// ПЕРВИЧНЫ (доступность/десктоп), свайп — прогрессивное улучшение поверх них.
import { keepPreviousData } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Repeat, Tag } from 'lucide-react';
import { useRef, useState } from 'react';
import { ScreenHeader } from '../../app/ScreenHeader';
import { RefField } from '../../lib/entity-ref/RefField';
import { formatMoney, type MoneyTone } from '../../lib/format';
import { invalidateGraph } from '../../lib/invalidate';
import { aspectLabel } from '../../lib/registry/labels';
import { useRegistry } from '../../lib/registry/useRegistry';
import { useNav } from '../../state/navigation';
import { type RouterOutputs, trpc } from '../../trpc';
import { Button } from '../../ui/Button';
import { Card } from '../../ui/Card';
import { Input } from '../../ui/Input';
import { Sheet } from '../../ui/Sheet';
import { Skeleton } from '../../ui/Skeleton';
import { useToast } from '../../ui/toast-store';
import { isRecurringTemplate } from '../agenda/useAgenda';
import { currentMonth, monthTitle } from './BudgetScreen';
import { CATEGORIES_QUERY, type CategoryOption, FINANCE_CATEGORY, toOption } from './categories';
import { ddmm } from './EnvelopeCard';
import { buildTxQuery, TX_PAGE_SIZE } from './txQuery';
import { invalidateBudget, monthShift } from './useBudget';

type QueryEntity = RouterOutputs['entity']['query'][number];

const TONE_CLASS: Record<MoneyTone, string> = { danger: 'text-danger', positive: 'text-success' };

// Сумма фильтра: как в QuickAddBar — целые/десятичные до 2 знаков, запятая = точка;
// невалидный ввод в запрос не попадает (мусор не должен ломать строку грамматики).
const AMOUNT_RE = /^\d+([.,]\d{1,2})?$/;
const SWIPE_THRESHOLD_PX = 60;

const FIELD_CLS =
  'rounded-control border border-line bg-surface px-2 py-1.5 text-sm text-text transition focus-visible:outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/40';

/** Валидная граница суммы → decimal-строка для грамматики; иначе null (не фильтруем). */
function amountBound(raw: string): string | null {
  const t = raw.trim();
  return AMOUNT_RE.test(t) ? t.replace(',', '.') : null;
}

export function TransactionsScreen() {
  const settings = trpc.user.getSettings.useQuery();
  const [override, setOverrideRaw] = useState<string | null>(null);
  const month = override ?? currentMonth(settings.data?.timezone);

  const [categoryId, setCategoryIdRaw] = useState('');
  const [direction, setDirectionRaw] = useState<'' | 'expense' | 'income'>('');
  const [planned, setPlannedRaw] = useState<'' | 'true' | 'false'>('');
  const [amountFrom, setAmountFromRaw] = useState('');
  const [amountTo, setAmountToRaw] = useState('');
  const [search, setSearchRaw] = useState('');

  // Пагинация растущим окном (Task C6): limit = TX_PAGE_SIZE * page, см. txQuery.ts.
  // Смена ЛЮБОГО фильтра сбрасывает окно на первую страницу — иначе пользователь,
  // догрузивший N страниц, продолжил бы тянуть N×TX_PAGE_SIZE записей после смены фильтра.
  const [page, setPage] = useState(1);
  const limit = TX_PAGE_SIZE * page;
  function resetPageAnd<T>(set: (v: T) => void): (v: T) => void {
    return (v) => {
      setPage(1);
      set(v);
    };
  }
  const setOverride = resetPageAnd(setOverrideRaw);
  const setCategoryId = resetPageAnd(setCategoryIdRaw);
  const setDirection = resetPageAnd(setDirectionRaw);
  const setPlanned = resetPageAnd(setPlannedRaw);
  const setAmountFrom = resetPageAnd(setAmountFromRaw);
  const setAmountTo = resetPageAnd(setAmountToRaw);
  const setSearch = resetPageAnd(setSearchRaw);

  const registry = useRegistry();
  const categoryDef = registry.property(FINANCE_CATEGORY);
  const categoriesQ = trpc.entity.query.useQuery({ query: CATEGORIES_QUERY });
  const categories: CategoryOption[] = (
    Array.isArray(categoriesQ.data) ? categoriesQ.data : []
  ).map(toOption);
  const byId = new Map(categories.map((c) => [c.id, c]));

  const query = buildTxQuery({
    month,
    limit,
    categoryId: categoryId || null,
    direction: direction || null,
    planned: planned === '' ? null : planned === 'true',
    amountFrom: amountBound(amountFrom),
    amountTo: amountBound(amountTo),
    search,
  });
  // keepPreviousData: «показать ещё» меняет ключ запроса (limit растёт) — без него
  // уже показанный список на кадр подменялся бы скелетоном вместо роста (Task C6)
  const txQ = trpc.entity.query.useQuery({ query }, { placeholderData: keepPreviousData });

  // Решение D20: сущность-ШАБЛОН повторяющейся операции (задан orbis/schedule.recurrence)
  // с occurred_on — валидное состояние (так заканчивается флоу «Сделать повторяющейся»),
  // но это не факт траты: серверные агрегаты его не считают, и в списке транзакций ему
  // не место. Фильтр клиентский — грамматика §6.3 «поле IS NULL» не выражает (та же
  // причина, что в Agenda), поэтому переиспользуем её isRecurringTemplate.
  // ИНСТАНСЫ шаблона (orbis/financial.recurring БЕЗ recurrence) — настоящие операции:
  // остаются в списке со своей 🔁.
  const visible = (txQ.data ?? []).filter((e) => !isRecurringTemplate(e));

  // Мутации строк (§3.3): entity.update + инвалидация budget И entity — рекатегоризация
  // двигает spent конвертов (серверный хук A4), пометка 🔁 меняет рендер списков.
  const utils = trpc.useUtils();
  const update = trpc.entity.update.useMutation({
    onSuccess: async () => {
      await invalidateBudget(utils);
      invalidateGraph(utils);
    },
  });
  const { show } = useToast();
  // Строка, для которой открыт Sheet рекатегоризации; null — закрыт.
  const [recatFor, setRecatFor] = useState<QueryEntity | null>(null);

  function recategorize(entity: QueryEntity, catId: string) {
    // НОВАЯ форма правки (§А1-1): одно свойство по id. Навешивания аспекта здесь нет и не
    // нужно — в отличие от быстрой записи и формы конверта, где запись рождается с нуля:
    // строки этого списка приходят запросом `aspect=orbis/financial` (`buildTxQuery`), то
    // есть носитель у них уже есть по построению выборки.
    update.mutate(
      { id: entity.id, props: { [FINANCE_CATEGORY]: catId } },
      { onSuccess: () => setRecatFor(null) },
    );
  }

  // «Сделать повторяющейся» — БЕЗ мутации (решение контролёра B5, см. шапку файла):
  // recurring=true без recurrence отклонил бы инвариант 01-arch §3.3. Ведём на detail,
  // где добавление orbis/schedule.recurrence делает операцию шаблоном (и корректно
  // отвязывает от конверта — хук фазы A); подсказка — тостом.
  function makeRecurring(entity: QueryEntity) {
    // Имя аспекта — ПОДПИСЬЮ из реестра (§А9-2), а не словом «Schedule» в коде: подпись
    // владелец вправе переименовать бесплатно (§А10-2), и подсказка, зовущая аспект иначе,
    // чем зовёт его карточка на экране записи, ведёт не туда.
    show(
      `Добавьте аспект «${aspectLabel(registry, 'orbis/schedule')}» с правилом повторения — операция станет шаблоном`,
    );
    const { activeTab, push } = useNav.getState();
    push(activeTab, { kind: 'entity', id: entity.id });
  }

  return (
    <div className="flex h-full flex-col">
      <ScreenHeader
        title={`Транзакции · ${monthTitle(month)}`}
        actions={
          <>
            <Button
              size="icon"
              variant="ghost"
              aria-label="Предыдущий месяц"
              data-testid="month-prev"
              onClick={() => setOverride(monthShift(month, -1))}
            >
              <ChevronLeft size={18} aria-hidden />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              aria-label="Следующий месяц"
              data-testid="month-next"
              onClick={() => setOverride(monthShift(month, 1))}
            >
              <ChevronRight size={18} aria-hidden />
            </Button>
          </>
        }
      />
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 p-4">
        {/* Фильтры §3.3 — состояние UI, выражается строкой грамматики (§6.3) */}
        <div className="flex flex-wrap items-center gap-2">
          <select
            aria-label="Категория"
            value={categoryId}
            onChange={(e) => setCategoryId(e.target.value)}
            className={FIELD_CLS}
          >
            <option value="">Все категории</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.icon ? `${c.icon} ` : ''}
                {c.title}
              </option>
            ))}
          </select>
          <select
            aria-label="Направление"
            value={direction}
            onChange={(e) => setDirection(e.target.value as '' | 'expense' | 'income')}
            className={FIELD_CLS}
          >
            <option value="">Доход и расход</option>
            <option value="expense">Расходы</option>
            <option value="income">Доходы</option>
          </select>
          <select
            aria-label="Тип"
            value={planned}
            onChange={(e) => setPlanned(e.target.value as '' | 'true' | 'false')}
            className={FIELD_CLS}
          >
            <option value="">Факт и план</option>
            <option value="false">Факт</option>
            <option value="true">Planned</option>
          </select>
          <Input
            aria-label="Сумма от"
            inputMode="decimal"
            placeholder="от"
            value={amountFrom}
            onChange={(e) => setAmountFrom(e.target.value)}
            className="w-20 text-sm tabular-nums"
          />
          <Input
            aria-label="Сумма до"
            inputMode="decimal"
            placeholder="до"
            value={amountTo}
            onChange={(e) => setAmountTo(e.target.value)}
            className="w-20 text-sm tabular-nums"
          />
          <Input
            aria-label="Поиск"
            type="search"
            placeholder="Поиск…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full min-w-32 flex-1 text-sm"
          />
        </div>

        {txQ.isError ? (
          <p className="text-sm text-text-muted">Не удалось загрузить транзакции</p>
        ) : txQ.isLoading ? (
          <Skeleton className="h-24" />
        ) : (
          <>
            {visible.length > 0 ? (
              <Card className="flex flex-col gap-1 p-2">
                {visible.map((e) => (
                  <TxRow
                    key={e.id}
                    entity={e}
                    category={categoryOf(e, byId)}
                    onRecategorize={() => setRecatFor(e)}
                    onMakeRecurring={() => makeRecurring(e)}
                  />
                ))}
              </Card>
            ) : (
              <p className="text-sm text-text-muted">Нет транзакций</p>
            )}
            {/* Счётчик — конец молчаливого обрезания (бэклог B). Движок не отдаёт общее
                число: «пришло РОВНО limit» — единственный признак «возможно, есть ещё»;
                при числе записей, кратном странице, последний клик покажет ту же выборку
                и кнопка исчезнет — честнее, чем угадывать.
                Блок живёт СНАРУЖИ ветки «есть строки»: страница, целиком состоящая из
                скрытых шаблонов D20, иначе стала бы тупиком без догрузки. «Показано»
                считает ВИДИМЫЕ строки, признак «есть ещё» — СЕРВЕРНУЮ страницу. */}
            {(txQ.data?.length ?? 0) > 0 && (
              <div className="flex items-center justify-between">
                <span className="text-xs text-text-muted">Показано {visible.length}</span>
                {txQ.data?.length === limit && (
                  <Button variant="outline" size="sm" onClick={() => setPage((p) => p + 1)}>
                    Показать ещё
                  </Button>
                )}
              </div>
            )}
          </>
        )}
      </div>

      {/* Sheet рекатегоризации (§3.3, §5): выбор категории → entity.update category_ref */}
      <Sheet
        open={recatFor !== null}
        onOpenChange={(v) => {
          if (!v) setRecatFor(null);
        }}
        side="right"
        title="Сменить категорию"
      >
        <div className="flex flex-col gap-1 pt-6">
          <p className="truncate text-sm text-text-secondary">{recatFor?.title}</p>
          {/* ОБЩИЙ пикер по цели свойства из реестра (§А6-1): своего списка категорий у
              листа рекатегоризации больше нет. */}
          {categoryDef === undefined ? (
            <span className="text-sm text-text-muted">Загрузка…</span>
          ) : (
            <RefField
              def={categoryDef}
              label="Категория"
              disabled={update.isPending}
              value={recatFor === null ? '' : (recatFor.props[FINANCE_CATEGORY] ?? '')}
              onChange={(v) => {
                if (recatFor !== null && typeof v === 'string') recategorize(recatFor, v);
              }}
            />
          )}
        </div>
      </Sheet>
    </div>
  );
}

function categoryOf(e: QueryEntity, byId: Map<string, CategoryOption>): CategoryOption | undefined {
  const ref = e.props[FINANCE_CATEGORY];
  return typeof ref === 'string' ? byId.get(ref) : undefined;
}

// Компактная строка транзакции (§3.3): дата · title · 🔁 · сумма · бейдж категории.
// Кнопки-действия видимы всегда (первичный путь), свайп — прогрессивное улучшение.
function TxRow({
  entity,
  category,
  onRecategorize,
  onMakeRecurring,
}: {
  entity: QueryEntity;
  category: CategoryOption | undefined;
  onRecategorize: () => void;
  onMakeRecurring: () => void;
}) {
  // Значения — плоско по id свойства (§А1-1).
  const props = entity.props;
  const occurredOn =
    typeof props['orbis/occurred_on'] === 'string' ? props['orbis/occurred_on'] : null;
  const recurring = props['orbis/recurring'] === true;
  const money = formatMoney(
    String(props['orbis/amount'] ?? '0'),
    props['orbis/direction'] === 'income' ? 'income' : 'expense',
  );
  const touchStart = useRef<{ x: number; y: number } | null>(null);

  return (
    <div
      data-testid="tx-row"
      className="flex items-center gap-2 rounded-control px-1 py-1 transition hover:bg-surface-2/60"
      onTouchStart={(e) => {
        const t = e.changedTouches[0];
        touchStart.current = t ? { x: t.clientX, y: t.clientY } : null;
      }}
      onTouchEnd={(e) => {
        const start = touchStart.current;
        const t = e.changedTouches[0];
        touchStart.current = null;
        if (!start || !t) return;
        const dx = t.clientX - start.x;
        const dy = t.clientY - start.y;
        if (Math.abs(dx) < SWIPE_THRESHOLD_PX || Math.abs(dx) <= Math.abs(dy)) return;
        // ◀ влево — рекатегоризация; вправо ▶ — пометить 🔁 (уже помеченную не трогаем)
        if (dx < 0) onRecategorize();
        else if (!recurring) onMakeRecurring();
      }}
    >
      <button
        type="button"
        data-testid="tx-main"
        onClick={() => {
          const { activeTab, push } = useNav.getState();
          push(activeTab, { kind: 'entity', id: entity.id });
        }}
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left text-sm outline-hidden focus-visible:ring-2 focus-visible:ring-accent/60"
      >
        {occurredOn !== null && (
          <span className="shrink-0 text-xs tabular-nums text-text-muted">{ddmm(occurredOn)}</span>
        )}
        <span className="min-w-0 flex-1 truncate">{entity.title}</span>
        {/* 🔁 recurring-инстанса — МЕЖДУ title и суммой (§3.3: не примыкает к бейджу) */}
        {recurring && (
          <Repeat size={12} aria-label="повторяется" className="shrink-0 text-text-muted" />
        )}
        <span data-testid="tx-amount" className={`shrink-0 tabular-nums ${TONE_CLASS[money.tone]}`}>
          {money.text}
        </span>
      </button>
      {/* Бейдж категории — крайняя правая колонка строки (§3.3, icon/color): фон —
          тонирование цветом категории (hex #RRGGBB + альфа ~15% — читаемо поверх
          surface обеих тем, текст остаётся токенным); без color — нейтральный класс */}
      {category !== undefined && (
        <span
          data-testid="tx-category-badge"
          title={category.title}
          className="inline-flex shrink-0 items-center rounded-full bg-surface-2 px-1.5 py-0.5 text-xs text-text-secondary"
          style={category.color !== null ? { backgroundColor: `${category.color}26` } : undefined}
        >
          {category.icon ?? category.title}
        </span>
      )}
      <button
        type="button"
        aria-label="Сменить категорию"
        onClick={onRecategorize}
        className="shrink-0 cursor-pointer rounded p-1 text-text-muted outline-hidden transition hover:bg-surface-2 hover:text-text focus-visible:ring-2 focus-visible:ring-accent/60"
      >
        <Tag size={14} aria-hidden />
      </button>
      {!recurring && (
        <button
          type="button"
          aria-label="Сделать повторяющейся"
          onClick={onMakeRecurring}
          className="shrink-0 cursor-pointer rounded p-1 text-text-muted outline-hidden transition hover:bg-surface-2 hover:text-text focus-visible:ring-2 focus-visible:ring-accent/60"
        >
          <Repeat size={14} aria-hidden />
        </button>
      )}
    </div>
  );
}
