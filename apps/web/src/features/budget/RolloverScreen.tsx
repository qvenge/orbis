// Rollover-экран (Task B6, 03-budget §3.5, carryover-логика §2.6): таблица категорий
// прошлого месяца — факт / carryover / редактируемый лимит (предложение AI = сервера),
// обнуление переносов целиком ([Обнулить переносы]) и покатегорийно (тап по значению,
// повторный тап возвращает), [Создать N конв.] → budget.rollover одним batch_execute.
// batchId — client-UUIDv7 ОДИН на открытие экрана (урок B4: повтор после ошибки шлёт
// тот же id — идемпотентность §7.8; CONFLICT — честная ошибка, НЕ успех: id непригоден,
// перегенерируем). needsSetup (§5 «Первый месяц без истории»): вместо предложения —
// форма «ожидаемый доход + оценки по категориям» → те же rows с carryover "0.00"
// (sign-off владельца фазы A). Целевой месяц — текущий в таймзоне пользователя;
// суммы превью — готовые decimal-строки сервера, клиент формулы не считает.
import { newId, type RolloverPreview } from '@orbis/shared';
import { TRPCClientError } from '@trpc/client';
import { CheckCheck } from 'lucide-react';
import { useState } from 'react';
import { ScreenHeader } from '../../app/ScreenHeader';
import { formatAmount } from '../../lib/format';
import { useNav } from '../../state/navigation';
import { trpc } from '../../trpc';
import { Button } from '../../ui/Button';
import { Card } from '../../ui/Card';
import { EmptyState } from '../../ui/EmptyState';
import { Input } from '../../ui/Input';
import { Skeleton } from '../../ui/Skeleton';
import { Spinner } from '../../ui/Spinner';
import { currentMonth, monthGenitive, monthTitle } from './BudgetScreen';
import { CATEGORIES_QUERY, type CategoryOption, toOption } from './categories';
import { AMOUNT_RE, toDecimal2 } from './moneyInput';
import { invalidateBudget, monthShift } from './useBudget';

type RolloverRow = RolloverPreview['rows'][number];
type SubmitRow = { categoryId: string; limit: string; carryover: string };

/** «+1 200» / «−1 100» / «0» — значение переноса со знаком (§2.6, U+2212 как formatMoney). */
function carryoverLabel(dec: string): string {
  const abs = formatAmount(dec);
  if (abs === '0') return '0';
  return dec.startsWith('-') ? `−${abs}` : `+${abs}`;
}

/**
 * Общий сабмит rollover для таблицы и needsSetup-формы: жизненный цикл batchId (один
 * на открытие экрана), CONFLICT → ошибка + свежий id, успех → инвалидация budget и pop.
 */
function useRolloverSubmit(month: string) {
  const utils = trpc.useUtils();
  const rollover = trpc.budget.rollover.useMutation();
  const [batchId, setBatchId] = useState(newId);
  const [error, setError] = useState<string | null>(null);

  async function submit(rows: SubmitRow[]) {
    if (rollover.isPending || rows.length === 0) return;
    setError(null);
    try {
      await rollover.mutateAsync({ month, rows, batchId });
    } catch (err) {
      // Семантика §7.8: честный повтор того же batchId — replay-УСПЕХ сервера; CONFLICT
      // значит id непригоден (занят чужой записью) — успех не фабрикуем (урок B4-фикса):
      // ошибка пользователю + свежий UUID, иначе следующая попытка упрётся в тот же конфликт.
      if (err instanceof TRPCClientError && err.data?.code === 'CONFLICT') {
        setBatchId(newId());
        setError('Не удалось создать конверты — попробуйте ещё раз');
      } else {
        // Транспорт/INVARIANT (например, конверт уже существует): batchId сохранён —
        // повтор после сбоя шлёт тот же id; сообщение сервера содержательно, показываем.
        setError(err instanceof Error ? err.message : 'Не удалось создать конверты');
      }
      return;
    }
    await invalidateBudget(utils);
    // Успех: экран закрывается (§3.5 — один batch, одна запись журнала, Undo из чата)
    const { activeTab, pop } = useNav.getState();
    pop(activeTab);
  }

  return { submit, error, pending: rollover.isPending };
}

export function RolloverScreen() {
  const settings = trpc.user.getSettings.useQuery();
  // Целевой месяц — текущий в таймзоне пользователя (§3.5: rollover на новый месяц)
  const month = currentMonth(settings.data?.timezone);
  const preview = trpc.budget.rolloverPreview.useQuery({ month });

  return (
    <div className="flex h-full flex-col">
      <ScreenHeader title={`Новый месяц: ${monthTitle(month)}`} />
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-4">
        {preview.isError ? (
          <p className="text-sm text-text-muted">Не удалось загрузить предложение</p>
        ) : preview.data === undefined ? (
          <>
            <Skeleton className="h-6 w-64" />
            <Skeleton className="h-40" />
          </>
        ) : preview.data.needsSetup ? (
          <SetupForm month={month} />
        ) : preview.data.rows.length === 0 ? (
          <EmptyState
            icon={<CheckCheck size={32} aria-hidden />}
            title="Переносить нечего"
            hint="Конверты нового месяца уже настроены или прошлый месяц пуст"
          />
        ) : (
          <RolloverTable month={month} rows={preview.data.rows} />
        )}
      </div>
    </div>
  );
}

// --- превью-таблица (§3.5): факт / carryover / лимит -----------------------------------

function RolloverTable({ month, rows }: { month: string; rows: RolloverRow[] }) {
  const { submit, error, pending } = useRolloverSubmit(month);
  // Правки лимитов поверх предложения сервера; carryover — флаг обнуления (тап-toggle)
  const [limits, setLimits] = useState<Record<string, string>>({});
  const [zeroed, setZeroed] = useState<Record<string, boolean>>({});

  const limitOf = (row: RolloverRow) => limits[row.categoryId] ?? row.suggestedLimit;
  const allValid = rows.every((r) => AMOUNT_RE.test(limitOf(r).trim()));
  const prevGen = monthGenitive(monthShift(month, -1));

  const payload = (): SubmitRow[] =>
    rows.map((r) => ({
      categoryId: r.categoryId,
      limit: toDecimal2(limitOf(r).trim()),
      carryover: zeroed[r.categoryId] === true ? '0.00' : r.carryover,
    }));

  return (
    <>
      <p className="text-sm text-text-secondary">AI предложил бюджеты по истории. Проверьте.</p>
      <Card className="flex flex-col gap-2 p-3">
        {/* Шапка таблицы (§3.5): категория · факт прошлого месяца · carryover · лимит */}
        <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-text-muted">
          <span className="min-w-0 flex-1">Категория</span>
          <span className="w-20 shrink-0 text-right">
            Факт{prevGen !== null ? ` ${prevGen}` : ''}
          </span>
          <span className="w-20 shrink-0 text-right">Перенос</span>
          <span className="w-24 shrink-0 text-right">Лимит</span>
        </div>
        {rows.map((row) => (
          <div
            key={row.categoryId}
            data-testid="rollover-row"
            className="flex items-center gap-2 text-sm"
          >
            <span className="min-w-0 flex-1 truncate">
              {row.categoryIcon !== null ? `${row.categoryIcon} ` : ''}
              {row.categoryTitle}
            </span>
            <span className="w-20 shrink-0 text-right tabular-nums text-text-secondary">
              {formatAmount(row.prevSpent)}
            </span>
            {/* Тап по значению — обнулить перенос этой категории (§3.5); повторный — вернуть */}
            <button
              type="button"
              aria-label={`Обнулить перенос «${row.categoryTitle}»`}
              aria-pressed={zeroed[row.categoryId] === true}
              onClick={() =>
                setZeroed((z) => ({ ...z, [row.categoryId]: z[row.categoryId] !== true }))
              }
              className={`w-20 shrink-0 cursor-pointer rounded-control text-right tabular-nums transition hover:bg-surface-2 ${
                zeroed[row.categoryId] === true ? 'text-text-muted line-through' : ''
              }`}
            >
              {zeroed[row.categoryId] === true ? '0' : carryoverLabel(row.carryover)}
            </button>
            <Input
              aria-label={`Лимит «${row.categoryTitle}»`}
              inputMode="decimal"
              value={limitOf(row)}
              onChange={(e) =>
                setLimits((l) => ({ ...l, [row.categoryId]: e.target.value.trim() }))
              }
              className="w-24 shrink-0 px-2 py-1 text-right text-sm tabular-nums"
            />
          </div>
        ))}
      </Card>
      {error !== null && (
        <p data-testid="rollover-error" className="text-xs text-danger">
          {error}
        </p>
      )}
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => setZeroed(Object.fromEntries(rows.map((r) => [r.categoryId, true])))}
        >
          Обнулить переносы
        </Button>
        <span className="flex-1" />
        <Button size="sm" disabled={!allValid || pending} onClick={() => void submit(payload())}>
          {pending ? <Spinner size={14} aria-label="Создание" /> : `Создать ${rows.length} конв.`}
        </Button>
      </div>
    </>
  );
}

// --- needsSetup: первый месяц без истории (§3.5, §5 edge case) --------------------------

/** BigInt-копейки валидной суммы (после AMOUNT_RE) — точная арифметика без float. */
function toCents(raw: string): bigint {
  const [i = '0', f = '00'] = toDecimal2(raw.trim()).split('.');
  return BigInt(i) * 100n + BigInt(f);
}

function centsLabel(c: bigint): string {
  const neg = c < 0n;
  const abs = neg ? -c : c;
  const dec = `${abs / 100n}.${String(abs % 100n).padStart(2, '0')}`;
  return `${neg ? '−' : ''}${formatAmount(dec)}`;
}

function SetupForm({ month }: { month: string }) {
  const { submit, error, pending } = useRolloverSubmit(month);
  const categoriesQ = trpc.entity.query.useQuery({ query: CATEGORIES_QUERY });
  const categories: CategoryOption[] = (
    Array.isArray(categoriesQ.data) ? categoriesQ.data : []
  ).map(toOption);

  const [income, setIncome] = useState('');
  const [estimates, setEstimates] = useState<Record<string, string>>({});

  // Заполненные оценки → rows; пустая категория пропускается (конверт не создаётся)
  const filled = categories.filter((c) => (estimates[c.id] ?? '').trim() !== '');
  const estimatesValid = filled.every((c) => AMOUNT_RE.test((estimates[c.id] ?? '').trim()));
  const incomeValid = income.trim() === '' || AMOUNT_RE.test(income.trim());
  const canSubmit = filled.length > 0 && estimatesValid && incomeValid;

  // «Не распределено» = доход − сумма оценок: BigInt-копейки, не IEEE-754
  const unallocated =
    income.trim() !== '' && incomeValid && estimatesValid
      ? filled.reduce((acc, c) => acc - toCents((estimates[c.id] ?? '0').trim()), toCents(income))
      : null;

  const rows = (): SubmitRow[] =>
    filled.map((c) => ({
      categoryId: c.id,
      limit: toDecimal2((estimates[c.id] ?? '0').trim()),
      carryover: '0.00', // переносить нечего — истории нет (§2.6)
    }));

  return (
    <>
      <p className="text-sm text-text-secondary">
        Истории трат ещё нет — укажите ожидаемый доход и оценки по категориям, из них создадутся
        стартовые конверты.
      </p>
      <Card className="flex flex-col gap-2 p-3">
        {/* Подпись — визуальная; доступное имя даёт aria-label самого Input */}
        <div className="flex items-center gap-2 text-sm">
          <span className="min-w-0 flex-1">Ожидаемый доход в месяц</span>
          <Input
            aria-label="Ожидаемый доход в месяц"
            inputMode="decimal"
            placeholder="0"
            value={income}
            onChange={(e) => setIncome(e.target.value.trim())}
            className="w-28 shrink-0 px-2 py-1 text-right text-sm tabular-nums"
          />
        </div>
        {unallocated !== null && (
          <p data-testid="setup-unallocated" className="text-right text-xs text-text-muted">
            Не распределено: <span className="tabular-nums">{centsLabel(unallocated)}</span>
          </p>
        )}
      </Card>
      <Card className="flex flex-col gap-2 p-3">
        {categoriesQ.isLoading && <Skeleton className="h-16" />}
        {categories.map((c) => (
          <div key={c.id} className="flex items-center gap-2 text-sm">
            <span className="min-w-0 flex-1 truncate">
              {c.icon !== null ? `${c.icon} ` : ''}
              {c.title}
            </span>
            <Input
              aria-label={`Оценка «${c.title}»`}
              inputMode="decimal"
              placeholder="—"
              value={estimates[c.id] ?? ''}
              onChange={(e) => setEstimates((s) => ({ ...s, [c.id]: e.target.value.trim() }))}
              className="w-28 shrink-0 px-2 py-1 text-right text-sm tabular-nums"
            />
          </div>
        ))}
      </Card>
      {error !== null && (
        <p data-testid="rollover-error" className="text-xs text-danger">
          {error}
        </p>
      )}
      <Button
        size="sm"
        className="self-end"
        disabled={!canSubmit || pending}
        onClick={() => void submit(rows())}
      >
        {pending ? <Spinner size={14} aria-label="Создание" /> : `Создать ${filled.length} конв.`}
      </Button>
    </>
  );
}
