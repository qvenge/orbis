// Экран категории Budget (Task B3, 03-budget §3.2): развёрнутая карточка текущего
// конверта (формулы §2.4, фазы §2.9 — общий envelopeView из EnvelopeCard, пороги
// не дублируются), «Правила» = body категории, [Тред] → персистентный тред сущности
// (threadId из entity.get include=thread), мини-тренд по budget.categoryTrend
// (простые div-бары + штрих лимита, без чарт-библиотеки), транзакции конверта
// (children_of, NativeRow §3.6, 🔁 у recurring-инстансов) и заглушка quick-add (B4).
import type { CategoryTrendPoint, EnvelopeStatus } from '@orbis/shared';
import { Repeat } from 'lucide-react';
import { ScreenHeader } from '../../app/ScreenHeader';
import { formatAmount } from '../../lib/format';
import { useNav } from '../../state/navigation';
import { type RouterOutputs, trpc } from '../../trpc';
import { Button } from '../../ui/Button';
import { Card } from '../../ui/Card';
import { Skeleton } from '../../ui/Skeleton';
import { NativeRow } from '../entity-detail/NativeRow';
import { monthTitle, Section } from './BudgetScreen';
import {
  ddmm,
  decMax,
  type EnvelopeViewModel,
  envelopePercent,
  envelopeView,
} from './EnvelopeCard';

type QueryEntity = RouterOutputs['entity']['query'][number];

const TREND_MONTHS = 6;

const MONTHS_RU_SHORT = [
  'янв',
  'фев',
  'мар',
  'апр',
  'май',
  'июн',
  'июл',
  'авг',
  'сен',
  'окт',
  'ноя',
  'дек',
];

function monthShort(period: string): string {
  return MONTHS_RU_SHORT[Number(period.slice(5, 7)) - 1] ?? period;
}

// «Сегодня» 'YYYY-MM-DD' в таймзоне пользователя (§2.3; паттерн — currentMonth
// в BudgetScreen): до загрузки настроек / при битой tz — таймзона браузера.
function todayISO(tz?: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      ...(tz ? { timeZone: tz } : {}),
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
  } catch {
    return todayISO(); // невалидная tz из настроек — не роняем рендер
  }
}

/** Последний день месяца 'YYYY-MM' (UTC-хак: день 0 следующего месяца). */
function lastDayOf(month: string): number {
  const [y = 0, m = 1] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** Подпись периода конверта: полный календарный месяц → «Июль 2026», иначе DD.MM – DD.MM (§2.9). */
function periodLabel(start: string, end: string): string {
  const month = start.slice(0, 7);
  const fullMonth =
    end.slice(0, 7) === month &&
    start.endsWith('-01') &&
    end.slice(8) === String(lastDayOf(month)).padStart(2, '0');
  return fullMonth ? monthTitle(month) : `${ddmm(start)} – ${ddmm(end)}`;
}

export function CategoryScreen({ categoryId }: { categoryId: string }) {
  const settings = trpc.user.getSettings.useQuery();
  const date = todayISO(settings.data?.timezone);
  const catQ = trpc.entity.get.useQuery({ id: categoryId, include: ['body', 'thread'] });
  const envQ = trpc.budget.envelopeForCategory.useQuery({ categoryId, date });
  const trendQ = trpc.budget.categoryTrend.useQuery({ categoryId, months: TREND_MONTHS });

  // Транзакции — дети ТЕКУЩЕГО конверта (§3.2); без конверта запрос не имеет смысла
  const envelopeId = envQ.data?.envelope.id;
  const txQ = trpc.entity.query.useQuery(
    { query: `children_of=${envelopeId ?? ''}, aspect=orbis/financial, sortBy=occurred_on:desc` },
    { enabled: envelopeId !== undefined },
  );

  const category = catQ.data?.entity;
  const catAspect = category
    ? (category.aspects as Record<string, Record<string, unknown> | undefined>)['orbis/category']
    : undefined;
  const icon = typeof catAspect?.icon === 'string' ? catAspect.icon : null;
  const threadId = catQ.data?.thread?.threadId;
  const body = category?.body ?? '';

  const status = envQ.data; // EnvelopeStatus | null (нет конверта на дату) | undefined (грузится)
  const view = status ? envelopeView(status) : null;
  const start = typeof view?.budget.period_start === 'string' ? view.budget.period_start : null;
  const end = typeof view?.budget.period_end === 'string' ? view.budget.period_end : null;
  const subtitle = start && end ? periodLabel(start, end) : monthTitle(date.slice(0, 7));

  return (
    <div className="flex h-full flex-col">
      <ScreenHeader
        title={category ? `${icon ? `${icon} ` : ''}${category.title}` : '…'}
        actions={
          <Button
            variant="ghost"
            size="sm"
            disabled={!threadId}
            onClick={() => {
              if (!threadId) return;
              const { activeTab, push } = useNav.getState();
              push(activeTab, { kind: 'thread', threadId });
            }}
          >
            Тред
          </Button>
        }
      />
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-4">
        {catQ.isError || envQ.isError ? (
          <p className="text-sm text-text-muted">Не удалось загрузить категорию</p>
        ) : (
          <>
            <p className="text-sm text-text-secondary">{subtitle}</p>

            {envQ.isLoading ? (
              <Skeleton className="h-24" />
            ) : status && view ? (
              <EnvelopeSummary status={status} view={view} />
            ) : (
              <Card data-testid="no-envelope" className="text-sm text-text-muted">
                Нет конверта на текущий период
              </Card>
            )}

            {/* Правила категоризации — body категории-сущности (§3.2); AI учитывает их
                при импорте и fast-path. Пустой body — секции нет. */}
            {body.trim() !== '' && (
              <Section title="Правила">
                <p
                  data-testid="category-rules"
                  className="whitespace-pre-wrap text-sm leading-relaxed"
                >
                  {body}
                </p>
              </Section>
            )}

            {trendQ.data && trendQ.data.length > 0 && <TrendSection points={trendQ.data} />}

            {status && (
              <Section title="Транзакции">
                {txQ.isLoading ? (
                  <Skeleton className="h-16" />
                ) : txQ.data && txQ.data.length > 0 ? (
                  txQ.data.map((e) => <TransactionRow key={e.id} entity={e} />)
                ) : (
                  <p className="text-sm text-text-muted">Нет транзакций</p>
                )}
              </Section>
            )}

            {/* Quick-add-бар — Task B4: кнопка уже на месте (§3.2), wiring подключит B4. */}
            <Button
              variant="outline"
              size="sm"
              className="self-start"
              disabled
              title="Быстрое добавление — скоро (Task B4)"
            >
              + запись в эту категорию
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

// Развёрнутая карточка текущего конверта (§3.2): бар с порогами §3.1, spent/limit,
// «Лимит N ↩ ±M», «Доступно R ~P/день». Пороги/фазы — общий envelopeView (EnvelopeCard).
function EnvelopeSummary({ status, view }: { status: EnvelopeStatus; view: EnvelopeViewModel }) {
  const { level, percent, mark, barColor, paceText, sym, carryoverText, budget } = view;
  const limit = typeof budget.limit === 'string' ? budget.limit : null;

  return (
    <Card
      data-testid="category-envelope"
      data-level={level}
      data-phase={status.phase}
      className={`flex flex-col gap-2 ${status.phase === 'closed' ? 'opacity-60' : ''}`}
    >
      <div className="flex items-center gap-2">
        <div className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-surface-2">
          <div
            data-testid="category-envelope-bar"
            className="h-full rounded-full transition-[width]"
            style={{ width: `${Math.min(100, percent)}%`, backgroundColor: barColor }}
          />
        </div>
        <span className="shrink-0 text-sm tabular-nums text-text-secondary">
          {percent}%{mark ? ` ${mark}` : ''}
        </span>
      </div>

      <p className="text-lg font-semibold tabular-nums">
        {formatAmount(status.spent)} / {formatAmount(status.effectiveLimit)} {sym}
      </p>

      {(limit !== null || carryoverText) && (
        <p className="text-sm tabular-nums text-text-secondary">
          {limit !== null ? `Лимит ${formatAmount(limit)}` : ''}
          {limit !== null && carryoverText ? ' · ' : ''}
          {carryoverText ? `${carryoverText} carryover` : ''}
        </p>
      )}

      <p className="text-sm tabular-nums text-text-secondary">
        {status.phase === 'active' ? `Доступно ${formatAmount(status.remaining)} ${sym} · ` : ''}
        {paceText}
      </p>
    </Card>
  );
}

// Мини-тренд (§3.2): горизонтальный div-бар на месяц, ширина — spent от максимума
// шкалы (максимум spent/limit всех точек, точная BigInt-арифметика envelopePercent);
// штрих-линия лимита — вертикальная dashed-граница; limit=null → штриха нет.
function TrendSection({ points }: { points: CategoryTrendPoint[] }) {
  const max = points.reduce(
    (m, p) => (p.limit !== null ? decMax(decMax(m, p.spent), p.limit) : decMax(m, p.spent)),
    '0',
  );
  return (
    <Section title={`Тренд ${points.length} мес`}>
      {points.map((p) => (
        <div
          key={p.period}
          data-testid="trend-row"
          data-period={p.period}
          className="flex items-center gap-2 text-xs"
        >
          <span className="w-8 shrink-0 text-text-muted">{monthShort(p.period)}</span>
          <div className="relative h-3 min-w-0 flex-1 overflow-hidden rounded-xs bg-surface-2">
            <div
              data-testid="trend-bar"
              className="h-full rounded-xs bg-accent/70"
              style={{ width: `${envelopePercent(p.spent, max)}%` }}
            />
            {p.limit !== null && (
              <div
                data-testid="trend-limit"
                aria-hidden
                className="absolute inset-y-0 border-l border-dashed border-text-secondary/70"
                style={{ left: `${envelopePercent(p.limit, max)}%` }}
              />
            )}
          </div>
          <span className="w-16 shrink-0 text-right tabular-nums text-text-secondary">
            {formatAmount(p.spent)}
          </span>
        </div>
      ))}
    </Section>
  );
}

// Строка транзакции: дата DD.MM + native-рендер §3.6 (NativeRow) + 🔁 у recurring-инстанса
// (признак: aspects['orbis/financial'].recurring === true). Тап → push detail сущности.
function TransactionRow({ entity }: { entity: QueryEntity }) {
  const fin = (entity.aspects as Record<string, Record<string, unknown> | undefined>)[
    'orbis/financial'
  ];
  const occurredOn = typeof fin?.occurred_on === 'string' ? fin.occurred_on : null;
  const recurring = fin?.recurring === true;

  return (
    <button
      type="button"
      data-testid="tx-row"
      onClick={() => {
        const { activeTab, push } = useNav.getState();
        push(activeTab, { kind: 'entity', id: entity.id });
      }}
      className="flex w-full cursor-pointer items-center gap-2 rounded-control px-1 py-1 text-left outline-hidden transition hover:bg-surface-2/60 focus-visible:ring-2 focus-visible:ring-accent/60"
    >
      {occurredOn && (
        <span className="shrink-0 text-xs tabular-nums text-text-muted">{ddmm(occurredOn)}</span>
      )}
      <div className="min-w-0 flex-1">
        <NativeRow entity={entity} onToggleTask={() => {}} />
      </div>
      {recurring && (
        <Repeat size={12} aria-label="повторяется" className="shrink-0 text-text-muted" />
      )}
    </button>
  );
}
