// Создание конверта (Task B2, 03-budget §3.1 «[+ конверт]», §2.1): выбор категории,
// лимит decimal-строкой, период (дефолт — отображаемый месяц; произвольный диапазон —
// два date-инпута). Сабмит → entity.create с аспектом orbis/budget → invalidateBudget;
// привязка накопленных транзакций категории — серверный хук §2.3, отдельного вызова нет.
// currency уходит ЯВНОЙ (defaultCurrency, если пользователь не сменил) — корректность
// комбинации §2.1 держит серверная нормализация NULL→defaultCurrency (бэклог A7).
import { type FormEvent, useState } from 'react';
import { trpc } from '../../trpc';
import { Button } from '../../ui/Button';
import { Input } from '../../ui/Input';
import { Sheet } from '../../ui/Sheet';
import { Spinner } from '../../ui/Spinner';
import { useToast } from '../../ui/toast-store';
import { invalidateBudget } from './useBudget';

/** Границы календарного месяца 'YYYY-MM' — дефолт периода конверта (§3.1). */
function monthRange(month: string): { start: string; end: string } {
  const [y = 0, m = 1] = month.split('-').map(Number);
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate(); // день 0 следующего месяца
  return { start: `${month}-01`, end: `${month}-${String(lastDay).padStart(2, '0')}` };
}

const DECIMAL_RE = /^\d+(\.\d+)?$/; // лимит — неотрицательная decimal-строка (схема аспекта)
const CURRENCY_RE = /^[A-Za-z]{3}$/;

const FIELD_CLS =
  'rounded-control border border-line bg-surface px-3 py-2 text-sm text-text transition focus-visible:outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/40';

export function EnvelopeCreateSheet({
  open,
  onOpenChange,
  month,
  presetCategoryId,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /** Отображаемый месяц Overview 'YYYY-MM' — дефолт периода нового конверта. */
  month: string;
  /** Предвыбранная категория (вход из Unbudgeted §3.1). */
  presetCategoryId?: string;
}) {
  const defaults = monthRange(month);
  const [categoryId, setCategoryId] = useState(presetCategoryId ?? '');
  const [limit, setLimit] = useState('');
  const [currency, setCurrency] = useState<string | null>(null); // null — не трогал, взять дефолт
  const [start, setStart] = useState(defaults.start);
  const [end, setEnd] = useState(defaults.end);

  const { show } = useToast();
  const utils = trpc.useUtils();
  const settings = trpc.user.getSettings.useQuery();
  // Список категорий-сущностей (§3.1: выбор из стартового набора или своей)
  const categoriesQ = trpc.entity.query.useQuery(
    { query: 'aspect=orbis/category, sortBy=title:asc, limit=200' },
    { enabled: open },
  );
  const create = trpc.entity.create.useMutation();

  const categories = categoriesQ.data ?? [];
  const effectiveCurrency = (currency ?? settings.data?.defaultCurrency ?? 'RUB').toUpperCase();
  const valid =
    categoryId !== '' &&
    DECIMAL_RE.test(limit) &&
    CURRENCY_RE.test(effectiveCurrency) &&
    start !== '' &&
    end !== '' &&
    start <= end;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!valid || create.isPending) return;
    const category = categories.find((c) => c.id === categoryId);
    const periodLabel =
      start === defaults.start && end === defaults.end ? month : `${start}..${end}`;
    try {
      await create.mutateAsync({
        input: {
          title: category ? `Конверт «${category.title}» ${periodLabel}` : `Конверт ${periodLabel}`,
          tags: [],
          aspects: {
            'orbis/budget': {
              category_ref: categoryId,
              limit,
              currency: effectiveCurrency,
              period_start: start,
              period_end: end,
            },
          },
        },
        source: 'ui',
      });
      await invalidateBudget(utils);
      show('Конверт создан');
      onOpenChange(false);
    } catch (err) {
      // Ошибка уникальности §2.1 и прочие отказы executor'а — текст сервера как есть
      show(err instanceof Error ? err.message : 'Не удалось создать конверт', 'danger');
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange} side="right" title="Новый конверт">
      <form onSubmit={submit} className="flex h-full flex-col gap-3 pt-6">
        <h2 className="text-base font-semibold">Новый конверт</h2>

        <label className="flex flex-col gap-1 text-xs text-text-secondary">
          Категория
          <select
            aria-label="Категория"
            value={categoryId}
            onChange={(e) => setCategoryId(e.target.value)}
            className={FIELD_CLS}
          >
            <option value="" disabled>
              {categoriesQ.isLoading ? 'Загрузка…' : 'Выберите категорию'}
            </option>
            {categories.map((c) => {
              const icon = (c.aspects as Record<string, { icon?: unknown } | undefined>)[
                'orbis/category'
              ]?.icon;
              return (
                <option key={c.id} value={c.id}>
                  {typeof icon === 'string' && icon !== '' ? `${icon} ` : ''}
                  {c.title}
                </option>
              );
            })}
          </select>
        </label>

        <div className="flex gap-2">
          <label
            htmlFor="envelope-limit"
            className="flex min-w-0 flex-1 flex-col gap-1 text-xs text-text-secondary"
          >
            Лимит
            <Input
              id="envelope-limit"
              aria-label="Лимит"
              inputMode="decimal"
              placeholder="10000"
              value={limit}
              onChange={(e) => setLimit(e.target.value.trim())}
              className="w-full text-sm"
            />
          </label>
          <label
            htmlFor="envelope-currency"
            className="flex w-20 shrink-0 flex-col gap-1 text-xs text-text-secondary"
          >
            Валюта
            <Input
              id="envelope-currency"
              aria-label="Валюта"
              maxLength={3}
              value={currency ?? settings.data?.defaultCurrency ?? 'RUB'}
              onChange={(e) => setCurrency(e.target.value.toUpperCase())}
              className="w-full text-sm uppercase"
            />
          </label>
        </div>

        <label
          htmlFor="envelope-period-start"
          className="flex flex-col gap-1 text-xs text-text-secondary"
        >
          Начало периода
          <Input
            id="envelope-period-start"
            aria-label="Начало периода"
            type="date"
            value={start}
            onChange={(e) => setStart(e.target.value)}
            className="text-sm"
          />
        </label>
        <label
          htmlFor="envelope-period-end"
          className="flex flex-col gap-1 text-xs text-text-secondary"
        >
          Конец периода
          <Input
            id="envelope-period-end"
            aria-label="Конец периода"
            type="date"
            value={end}
            onChange={(e) => setEnd(e.target.value)}
            className="text-sm"
          />
        </label>

        <Button type="submit" disabled={!valid || create.isPending} className="mt-2 self-start">
          {create.isPending ? <Spinner size={14} aria-label="Создание" /> : 'Создать'}
        </Button>
      </form>
    </Sheet>
  );
}
