// Budget Overview — §3.1 (Task B1 каркас + B2): баланс периода, сетка карточек
// конвертов (пороги/фазы/carryover — EnvelopeCard), создание конверта
// (EnvelopeCreateSheet: [+ конверт] и вход из Unbudgeted), Coming up / Planned.
// Все суммы — готовые decimal-строки сервера, клиент только форматирует (format.ts).
import type { BudgetOverview } from '@orbis/shared';
import { ChevronLeft, ChevronRight, Plus, ReceiptText, Repeat } from 'lucide-react';
import { useState } from 'react';
import { ScreenHeader } from '../../app/ScreenHeader';
import { formatAmount, formatMoney, type MoneyTone } from '../../lib/format';
import { useNav } from '../../state/navigation';
import { trpc } from '../../trpc';
import { Button } from '../../ui/Button';
import { Card } from '../../ui/Card';
import { Skeleton } from '../../ui/Skeleton';
import { EnvelopeCard } from './EnvelopeCard';
import { EnvelopeCreateSheet } from './EnvelopeCreateSheet';
import { QuickAddBar } from './QuickAddBar';
import { monthShift, useBudgetOverview } from './useBudget';

const TONE_CLASS: Record<MoneyTone, string> = { danger: 'text-danger', positive: 'text-success' };

const MONTHS_RU = [
  'Январь',
  'Февраль',
  'Март',
  'Апрель',
  'Май',
  'Июнь',
  'Июль',
  'Август',
  'Сентябрь',
  'Октябрь',
  'Ноябрь',
  'Декабрь',
];

/** «Июль 2026» из 'YYYY-MM' — заголовок периода Overview (§3.1) и экрана категории (§3.2). */
export function monthTitle(month: string): string {
  const [y = '', m = '01'] = month.split('-');
  return `${MONTHS_RU[Number(m) - 1] ?? m} ${y}`;
}

// Текущий месяц 'YYYY-MM' в таймзоне пользователя (§3.1: дефолт заголовка периода).
// До загрузки настроек (или при битой tz) — таймзона браузера: расходится с
// пользовательской только в часы около границы месяца, ключ запроса стабилен.
// Экспорт — дефолт фильтра периода экрана «Транзакции» (§3.3, B5).
export function currentMonth(tz?: string): string {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-CA', {
      ...(tz ? { timeZone: tz } : {}),
      year: 'numeric',
      month: '2-digit',
    }).formatToParts(new Date());
  } catch {
    return currentMonth(); // невалидная tz из настроек — не роняем рендер
  }
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}`;
}

export function BudgetScreen() {
  const settings = trpc.user.getSettings.useQuery();
  // Месяц — локальный useState-override; дефолт пересчитывается от таймзоны пользователя.
  const [override, setOverride] = useState<string | null>(null);
  const month = override ?? currentMonth(settings.data?.timezone);
  const overview = useBudgetOverview(month);

  return (
    <div className="flex h-full flex-col">
      <ScreenHeader
        title={`Бюджет · ${monthTitle(month)}`}
        actions={
          <>
            {/* Вход в экран «Транзакции» (§3.3): у мокапа §3.1 явной точки нет — решение B5:
                иконка-кнопка в шапке Overview (по образцу заголовка §3.3 с [🔍/фильтры]). */}
            <Button
              size="icon"
              variant="ghost"
              aria-label="Транзакции"
              data-testid="open-transactions"
              onClick={() => {
                const { activeTab, push } = useNav.getState();
                push(activeTab, { kind: 'budget-transactions' });
              }}
            >
              <ReceiptText size={18} aria-hidden />
            </Button>
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
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-4">
        {overview.isError ? (
          <p className="text-sm text-text-muted">Не удалось загрузить бюджет</p>
        ) : overview.data ? (
          <OverviewBody data={overview.data} month={month} />
        ) : (
          <OverviewSkeleton />
        )}
        {/* Quick-add бар внизу Overview (Task B4, §3.6) */}
        <QuickAddBar />
      </div>
    </div>
  );
}

function OverviewSkeleton() {
  return (
    <>
      <Skeleton className="h-20" />
      <div className="grid grid-cols-2 gap-3">
        <Skeleton className="h-16" />
        <Skeleton className="h-16" />
      </div>
      <Skeleton className="h-24" />
    </>
  );
}

function OverviewBody({ data, month }: { data: BudgetOverview; month: string }) {
  const balance = formatMoney(
    data.balance.balance,
    data.balance.balance.startsWith('-') ? 'expense' : 'income',
  );
  // Sheet создания конверта: null — закрыт; categoryId — предвыбор из Unbudgeted (§3.1).
  // Условный маунт вместо open-флага: каждый вход — чистое состояние формы.
  const [createSheet, setCreateSheet] = useState<{ categoryId?: string } | null>(null);
  return (
    <>
      {/* Баланс периода (§2.5): income − expense, цвет по знаку */}
      <Card data-testid="balance-card" className="flex flex-col gap-1">
        <p className={`text-lg font-semibold tabular-nums ${TONE_CLASS[balance.tone]}`}>
          Баланс: {balance.text}
        </p>
        <p className="text-sm tabular-nums text-text-secondary">
          Доход {formatAmount(data.balance.income)} · Расход {formatAmount(data.balance.expense)}
        </p>
      </Card>

      {data.envelopes.length > 0 && (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
          {data.envelopes.map((e) => (
            <EnvelopeCard key={e.envelope.id} status={e} />
          ))}
        </div>
      )}
      <Button variant="outline" size="sm" className="self-start" onClick={() => setCreateSheet({})}>
        + конверт
      </Button>
      {createSheet !== null && (
        <EnvelopeCreateSheet
          open
          onOpenChange={(v) => {
            if (!v) setCreateSheet(null);
          }}
          month={month}
          presetCategoryId={createSheet.categoryId}
        />
      )}

      {data.comingUp.length > 0 && (
        <Section title="Coming up (14 дней)">
          {data.comingUp.map((row) => {
            const money = formatMoney(
              row.amount,
              row.direction === 'income' ? 'income' : 'expense',
            );
            return (
              <div key={row.entity.id} className="flex items-center gap-2 text-sm">
                <span className="tabular-nums text-text-muted">
                  {row.occurredOn.slice(8, 10)}.{row.occurredOn.slice(5, 7)}
                </span>
                <span className="min-w-0 flex-1 truncate">{row.entity.title}</span>
                <span className={`tabular-nums ${TONE_CLASS[money.tone]}`}>{money.text}</span>
                <Repeat size={12} aria-label="повторяется" className="shrink-0 text-text-muted" />
              </div>
            );
          })}
        </Section>
      )}

      {data.planned.length > 0 && (
        <Section title="Planned (запланировано)">
          {data.planned.map((row) => (
            <div key={row.entity.id} className="flex items-center gap-2 text-sm">
              <span className="min-w-0 flex-1 truncate">
                {row.entity.emoji ? `${row.entity.emoji} ` : ''}
                {row.entity.title}
              </span>
              <span className="tabular-nums text-danger">
                {formatMoney(row.amount, 'expense').text}
              </span>
              <span className="shrink-0 text-text-muted">→ {row.categoryTitle}</span>
            </div>
          ))}
        </Section>
      )}

      {data.unbudgeted.length > 0 && (
        <Section title="Unbudgeted (без конверта)">
          {data.unbudgeted.map((row) => (
            <div key={row.category.id} className="flex items-center gap-2 text-sm">
              <span className="min-w-0 flex-1 truncate">
                {row.category.icon ? `${row.category.icon} ` : ''}
                {row.category.title}
              </span>
              <span className="tabular-nums text-danger">
                {formatMoney(row.total, 'expense').text}
              </span>
              {/* §3.1/§5: траты без конверта → предложение создать конверт с предвыбором */}
              <Button
                size="icon"
                variant="ghost"
                className="h-6 w-6 shrink-0"
                aria-label={`Конверт для «${row.category.title}»`}
                onClick={() => setCreateSheet({ categoryId: row.category.id })}
              >
                <Plus size={14} aria-hidden />
              </Button>
            </div>
          ))}
        </Section>
      )}
    </>
  );
}

/** Секция с заголовком-капсом и Card-контейнером — общая для Overview и CategoryScreen. */
export function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-1">
      <h2 className="text-xs font-medium uppercase tracking-wide text-text-muted">{title}</h2>
      <Card className="flex flex-col gap-2 p-3">{children}</Card>
    </section>
  );
}
