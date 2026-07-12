// Budget Overview — каркас §3.1 (Task B1): баланс периода, сетка конвертов
// (заглушка-карточка; пороги/фазы/carryover — B2), Coming up / Planned / Unbudgeted.
// Все суммы — готовые decimal-строки сервера, клиент только форматирует (format.ts).
import type { BudgetOverview } from '@orbis/shared';
import { ChevronLeft, ChevronRight, Repeat } from 'lucide-react';
import { useState } from 'react';
import { ScreenHeader } from '../../app/ScreenHeader';
import { formatAmount, formatMoney, type MoneyTone } from '../../lib/format';
import { trpc } from '../../trpc';
import { Button } from '../../ui/Button';
import { Card } from '../../ui/Card';
import { Skeleton } from '../../ui/Skeleton';
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

function monthTitle(month: string): string {
  const [y = '', m = '01'] = month.split('-');
  return `${MONTHS_RU[Number(m) - 1] ?? m} ${y}`;
}

// Текущий месяц 'YYYY-MM' в таймзоне пользователя (§3.1: дефолт заголовка периода).
// До загрузки настроек (или при битой tz) — таймзона браузера: расходится с
// пользовательской только в часы около границы месяца, ключ запроса стабилен.
function currentMonth(tz?: string): string {
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
          <OverviewBody data={overview.data} />
        ) : (
          <OverviewSkeleton />
        )}
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

function OverviewBody({ data }: { data: BudgetOverview }) {
  const balance = formatMoney(
    data.balance.balance,
    data.balance.balance.startsWith('-') ? 'expense' : 'income',
  );
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
            <EnvelopeCardStub key={e.envelope.id} status={e} />
          ))}
        </div>
      )}
      {/* Заглушка B1: создание конверта (Sheet выбора категории/лимита/периода) — B2 */}
      <Button variant="outline" size="sm" className="self-start" disabled>
        + конверт
      </Button>

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
            </div>
          ))}
        </Section>
      )}
    </>
  );
}

// Заглушка-карточка конверта (B1): имя категории + spent/limit. Прогресс-бар,
// пороги подсветки, daily_pace и carryover-бейдж — Task B2.
function EnvelopeCardStub({ status }: { status: BudgetOverview['envelopes'][number] }) {
  return (
    <Card data-testid="envelope-card" className="flex flex-col gap-1 p-3">
      <p className="truncate text-sm font-medium">
        {status.category.icon ? `${status.category.icon} ` : ''}
        {status.category.title}
      </p>
      <p className="text-xs tabular-nums text-text-secondary">
        {formatAmount(status.spent)} / {formatAmount(status.effectiveLimit)}
      </p>
    </Card>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-1">
      <h2 className="text-xs font-medium uppercase tracking-wide text-text-muted">{title}</h2>
      <Card className="flex flex-col gap-2 p-3">{children}</Card>
    </section>
  );
}
