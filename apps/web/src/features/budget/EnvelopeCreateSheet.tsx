// Создание конверта (Task B2, 03-budget §3.1 «[+ конверт]», §2.1): выбор категории,
// лимит decimal-строкой, период (дефолт — отображаемый месяц; произвольный диапазон —
// два date-инпута). Сабмит → entity.create с аспектом orbis/budget → invalidateBudget;
// привязка накопленных транзакций категории — серверный хук §2.3, отдельного вызова нет.
// currency уходит ЯВНОЙ (defaultCurrency, если пользователь не сменил) — корректность
// комбинации §2.1 держит серверная нормализация NULL→defaultCurrency (бэклог A7).
import { type FormEvent, useState } from 'react';
import { RefField, useRefTitle } from '../../lib/entity-ref/RefField';
import { invalidateGraph } from '../../lib/invalidate';
import { useRegistry } from '../../lib/registry/useRegistry';
import { trpc } from '../../trpc';
import { Button } from '../../ui/Button';
import { Input } from '../../ui/Input';
import { Sheet } from '../../ui/Sheet';
import { Spinner } from '../../ui/Spinner';
import { useToast } from '../../ui/toast-store';
import { FINANCE_CATEGORY } from './categories';
import { invalidateBudget } from './useBudget';

/** Границы календарного месяца 'YYYY-MM' — дефолт периода конверта (§3.1). */
function monthRange(month: string): { start: string; end: string } {
  const [y = 0, m = 1] = month.split('-').map(Number);
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate(); // день 0 следующего месяца
  return { start: `${month}-01`, end: `${month}-${String(lastDay).padStart(2, '0')}` };
}

const DECIMAL_RE = /^\d+(\.\d+)?$/; // лимит — неотрицательная decimal-строка (схема аспекта)
const CURRENCY_RE = /^[A-Za-z]{3}$/;

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
  // Выбор категории (§3.1) — ОБЩИЙ пикер по цели свойства из реестра (§А6-1): своего списка
  // у формы конверта больше нет. Свойство здесь то же, что у операции (`orbis/finance_category`,
  // В1 слил их в одно), поэтому конверт получил пикер, которого ему никто не писал.
  const registry = useRegistry();
  const categoryDef = registry.property(FINANCE_CATEGORY);
  // Название выбранной категории — для имени конверта; тот же список, тот же кеш.
  const categoryTitle = useRefTitle(categoryDef, categoryId);
  const create = trpc.entity.create.useMutation();

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
    const periodLabel =
      start === defaults.start && end === defaults.end ? month : `${start}..${end}`;
    // Название категории в имени конверта — только когда оно ИЗВЕСТНО: `useRefTitle` на
    // промахе отдаёт сам uuid, и «Конверт «019d48ea-…»» был бы хуже безымянного.
    const named = categoryTitle.title !== categoryId;
    try {
      await create.mutateAsync({
        input: {
          title: named
            ? `Конверт «${categoryTitle.title}» ${periodLabel}`
            : `Конверт ${periodLabel}`,
          tags: [],
          // НОВАЯ форма отправки (§А1-1): значения плоско по id свойства, аспект — ЯВНЫМ
          // навешиванием. В старой карте ключ `orbis/budget` вешал аспект самим фактом
          // записи поля; здесь такого не бывает, и без `aspects` конверт родился бы
          // записью без единого аспекта — то есть не конвертом.
          props: {
            [FINANCE_CATEGORY]: categoryId,
            'orbis/limit': limit,
            'orbis/currency': effectiveCurrency,
            'orbis/period_start': start,
            'orbis/period_end': end,
          },
          aspects: ['orbis/budget'],
        },
        source: 'ui',
      });
      await invalidateBudget(utils);
      invalidateGraph(utils); // конверт — сущность графа, а не только строка агрегата
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

        <div className="flex flex-col gap-1 text-xs text-text-secondary">
          Категория
          {categoryDef === undefined ? (
            // Реестр ещё едет: показать пустой список значило бы «категорий нет».
            <span className="text-sm text-text-muted">Загрузка…</span>
          ) : (
            <RefField
              def={categoryDef}
              label="Категория"
              value={categoryId}
              onChange={(v) => setCategoryId(typeof v === 'string' ? v : '')}
            />
          )}
        </div>

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
