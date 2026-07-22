// Task B5: экран «Транзакции» (03-budget §3.3) — полный список финансовых сущностей
// с финансовыми фильтрами: месяц ◀▶ (как Overview), категория, направление, planned,
// диапазон сумм, поиск. Строка запроса — ЧИСТЫЙ билдер buildTxQuery (txQuery.ts);
// период — абсолютный диапазон occurred_on=<от>..<до> (расширение грамматики B5),
// окно материализации сервер расширяет сам (§5.4 + materializationWindow).
//
// Строка — компактный native-рендер (решение B5 по Minor B3: NativeRow с text-xl —
// типографика страницы Detail, для плотного списка велика; денежный рендер НЕ
// дублируется — общий formatMoney): дата · title · 🔁 (МЕЖДУ title и суммой,
// §3.3 «визуально различимы») · сумма · бейдж категории в крайней правой колонке.
//
// Действия §3.3: влево-свайп — рекатегоризация (Sheet выбора → entity.update
// category_ref; parent перепривязывает серверный хук A4, §5), вправо-свайп —
// «пометить 🔁» (entity.update recurring:true → подсказка + переход на detail,
// где можно добавить orbis/schedule.recurrence; мастер — не в MVP). Тач-свайпы
// в тестах не эмулируются надёжно → кнопки-действия в каждой строке ПЕРВИЧНЫ
// (доступность/десктоп), свайп — прогрессивное улучшение поверх них.
import { ChevronLeft, ChevronRight, Repeat, Tag } from 'lucide-react';
import { useRef, useState } from 'react';
import { ScreenHeader } from '../../app/ScreenHeader';
import { formatMoney, type MoneyTone } from '../../lib/format';
import { useNav } from '../../state/navigation';
import { type RouterOutputs, trpc } from '../../trpc';
import { Button } from '../../ui/Button';
import { Card } from '../../ui/Card';
import { Input } from '../../ui/Input';
import { Sheet } from '../../ui/Sheet';
import { Skeleton } from '../../ui/Skeleton';
import { useToast } from '../../ui/toast-store';
import { currentMonth, monthTitle } from './BudgetScreen';
import { CATEGORIES_QUERY, type CategoryOption, toOption } from './categories';
import { ddmm } from './EnvelopeCard';
import { buildTxQuery } from './txQuery';
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
  const [override, setOverride] = useState<string | null>(null);
  const month = override ?? currentMonth(settings.data?.timezone);

  const [categoryId, setCategoryId] = useState('');
  const [direction, setDirection] = useState<'' | 'expense' | 'income'>('');
  const [planned, setPlanned] = useState<'' | 'true' | 'false'>('');
  const [amountFrom, setAmountFrom] = useState('');
  const [amountTo, setAmountTo] = useState('');
  const [search, setSearch] = useState('');

  const categoriesQ = trpc.entity.query.useQuery({ query: CATEGORIES_QUERY });
  const categories: CategoryOption[] = (
    Array.isArray(categoriesQ.data) ? categoriesQ.data : []
  ).map(toOption);
  const byId = new Map(categories.map((c) => [c.id, c]));

  const query = buildTxQuery({
    month,
    categoryId: categoryId || null,
    direction: direction || null,
    planned: planned === '' ? null : planned === 'true',
    amountFrom: amountBound(amountFrom),
    amountTo: amountBound(amountTo),
    search,
  });
  const txQ = trpc.entity.query.useQuery({ query });

  // Мутации строк (§3.3): entity.update + инвалидация budget И entity — рекатегоризация
  // двигает spent конвертов (серверный хук A4), пометка 🔁 меняет рендер списков.
  const utils = trpc.useUtils();
  const update = trpc.entity.update.useMutation({
    onSuccess: async () => {
      await invalidateBudget(utils);
      void utils.entity.query.invalidate();
    },
  });
  const { show } = useToast();
  // Строка, для которой открыт Sheet рекатегоризации; null — закрыт.
  const [recatFor, setRecatFor] = useState<QueryEntity | null>(null);

  function recategorize(entity: QueryEntity, catId: string) {
    update.mutate(
      { id: entity.id, aspects: { 'orbis/financial': { category_ref: catId } } },
      { onSuccess: () => setRecatFor(null) },
    );
  }

  function markRecurring(entity: QueryEntity) {
    update.mutate(
      { id: entity.id, aspects: { 'orbis/financial': { recurring: true } } },
      {
        onSuccess: () => {
          // Подсказка «завести шаблон» (§3.3): переход на detail, где добавляется
          // orbis/schedule.recurrence; полноценный мастер — вне MVP-объёма (бриф B5).
          show('Помечено 🔁 — завести шаблон можно на экране записи');
          const { activeTab, push } = useNav.getState();
          push(activeTab, { kind: 'entity', id: entity.id });
        },
        onError: () => show('Не удалось пометить', 'danger'),
      },
    );
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
        ) : txQ.data && txQ.data.length > 0 ? (
          <Card className="flex flex-col gap-1 p-2">
            {txQ.data.map((e) => (
              <TxRow
                key={e.id}
                entity={e}
                category={categoryOf(e, byId)}
                onRecategorize={() => setRecatFor(e)}
                onMarkRecurring={() => markRecurring(e)}
              />
            ))}
          </Card>
        ) : (
          <p className="text-sm text-text-muted">Нет транзакций</p>
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
          {categories.map((c) => (
            <button
              key={c.id}
              type="button"
              disabled={update.isPending}
              onClick={() => {
                if (recatFor) recategorize(recatFor, c.id);
              }}
              className="cursor-pointer rounded-control px-2 py-1.5 text-left text-sm transition hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-accent/60"
            >
              {c.icon ? `${c.icon} ` : ''}
              {c.title}
            </button>
          ))}
        </div>
      </Sheet>
    </div>
  );
}

function categoryOf(e: QueryEntity, byId: Map<string, CategoryOption>): CategoryOption | undefined {
  const ref = (e.aspects as Record<string, { category_ref?: unknown } | undefined>)[
    'orbis/financial'
  ]?.category_ref;
  return typeof ref === 'string' ? byId.get(ref) : undefined;
}

// Компактная строка транзакции (§3.3): дата · title · 🔁 · сумма · бейдж категории.
// Кнопки-действия видимы всегда (первичный путь), свайп — прогрессивное улучшение.
function TxRow({
  entity,
  category,
  onRecategorize,
  onMarkRecurring,
}: {
  entity: QueryEntity;
  category: CategoryOption | undefined;
  onRecategorize: () => void;
  onMarkRecurring: () => void;
}) {
  const fin = (entity.aspects as Record<string, Record<string, unknown> | undefined>)[
    'orbis/financial'
  ];
  const occurredOn = typeof fin?.occurred_on === 'string' ? fin.occurred_on : null;
  const recurring = fin?.recurring === true;
  const money = formatMoney(
    String(fin?.amount ?? '0'),
    (fin?.direction as 'expense' | 'income') ?? 'expense',
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
        else if (!recurring) onMarkRecurring();
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
      {/* Бейдж категории — крайняя правая колонка строки (§3.3) */}
      {category !== undefined && (
        <span
          data-testid="tx-category-badge"
          title={category.title}
          className="inline-flex shrink-0 items-center rounded-full bg-surface-2 px-1.5 py-0.5 text-xs text-text-secondary"
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
          aria-label="Пометить повторяющейся"
          onClick={onMarkRecurring}
          className="shrink-0 cursor-pointer rounded p-1 text-text-muted outline-hidden transition hover:bg-surface-2 hover:text-text focus-visible:ring-2 focus-visible:ring-accent/60"
        >
          <Repeat size={14} aria-hidden />
        </button>
      )}
    </div>
  );
}
