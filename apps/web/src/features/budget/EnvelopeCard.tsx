// Карточка конверта (Task B2, 03-budget §3.1): прогресс-бар spent/effectiveLimit
// с порогами подсветки, ост./~₽-день (§2.4, «—/день» при dailyPace=null в active),
// фазы upcoming/active/closed (§2.9), carryover-бейдж (§2.6). Все суммы — готовые
// decimal-строки сервера; пороги сравниваются ТОЧНО (BigInt), без IEEE-754.
// Тап → push экрана категории (§3.2, сам экран — Task B3).
import type { EnvelopeStatus } from '@orbis/shared';
import { formatAmount } from '../../lib/format';
import { useNav } from '../../state/navigation';

// --- точная арифметика порогов (§3.1) без чисел с плавающей точкой ---------------------

export type EnvelopeLevel = 'norm' | 'warn' | 'alert' | 'over';

/** Decimal-строка → BigInt в масштабе scale знаков после точки (без потерь). */
function scaledBigInt(dec: string, scale: number): bigint {
  // Знак — ASCII '-' И типографский U+2212 (formatMoney/бейджи печатают U+2212, §3.3):
  // strip-regex и neg обязаны распознавать один и тот же набор, иначе '−800' → +800.
  const neg = dec.startsWith('-') || dec.startsWith('−');
  const [int = '0', frac = ''] = dec.replace(/^[-−+]/, '').split('.');
  const digits = `${int}${frac.padEnd(scale, '0').slice(0, scale)}`;
  const v = BigInt(digits === '' ? '0' : digits);
  return neg ? -v : v;
}

/** Пара spent/effectiveLimit в общем целочисленном масштабе — для точных сравнений. */
function scaledPair(spent: string, limit: string): [bigint, bigint] {
  const scale = Math.max((spent.split('.')[1] ?? '').length, (limit.split('.')[1] ?? '').length);
  return [scaledBigInt(spent, scale), scaledBigInt(limit, scale)];
}

/** Максимум двух decimal-строк (шкала мини-тренда §3.2) — то же точное сравнение. */
export function decMax(a: string, b: string): string {
  const [x, y] = scaledPair(a, b);
  return x >= y ? a : b;
}

/**
 * Порог подсветки §3.1: <60% — цвет категории (norm), 60–85% — жёлтый (warn),
 * 85–100% — оранжевый+⚠ (alert), ≥100% — красный+🔴 (over); границы включительно
 * в старший уровень. Вырожденный effectiveLimit ≤ 0: перерасход по построению
 * (отрицательный carryover съел лимит), кроме честного нуля 0/0.
 */
export function envelopeLevel(spent: string, effectiveLimit: string): EnvelopeLevel {
  const [num, den] = scaledPair(spent, effectiveLimit);
  if (den <= 0n) return num > 0n || den < 0n ? 'over' : 'norm';
  if (num >= den) return 'over';
  if (num * 100n >= den * 85n) return 'alert';
  if (num * 10n >= den * 6n) return 'warn';
  return 'norm';
}

/** Целый процент spent/effectiveLimit (floor) — подпись бара; вырожденный лимит → 0/100. */
export function envelopePercent(spent: string, effectiveLimit: string): number {
  const [num, den] = scaledPair(spent, effectiveLimit);
  if (den <= 0n) return num > 0n || den < 0n ? 100 : 0;
  if (num <= 0n) return 0;
  return Number((num * 100n) / den);
}

// --- отображение ------------------------------------------------------------------------

const LEVEL_BAR: Record<Exclude<EnvelopeLevel, 'norm'>, string> = {
  warn: 'var(--color-warning)',
  alert: 'var(--color-alert)',
  over: 'var(--color-danger)',
};

const LEVEL_MARK: Partial<Record<EnvelopeLevel, string>> = { alert: '⚠', over: '🔴' };

const CURRENCY_SYMBOL: Record<string, string> = { RUB: '₽', USD: '$', EUR: '€' };

/** «10.08» из ISO-даты — подпись «начнётся DD.MM» (§2.9а) и даты транзакций (§3.2). */
export function ddmm(iso: string): string {
  return `${iso.slice(8, 10)}.${iso.slice(5, 7)}`;
}

/** Ненулевая decimal-строка (carryover-бейдж показывается только при ненулевом §2.6). */
function isNonZero(dec: string | undefined): dec is string {
  return typeof dec === 'string' && !/^[-−+]?0*(\.0*)?$/.test(dec);
}

/** ±N с типографским минусом — бейдж `↩ +1 200` / `↩ −800` (§2.6). */
function signedAmount(dec: string): string {
  const sign = dec.startsWith('-') ? '−' : '+';
  return `${sign}${formatAmount(dec)}`;
}

/**
 * Вся фазо- и порого-зависимая логика отображения статуса конверта — ОБЩАЯ для
 * компактной карточки Overview (§3.1) и развёрнутой карточки экрана категории
 * (§3.2, CategoryScreen): пороги/цвет бара, «начнётся/завершён/—/день», carryover.
 */
export interface EnvelopeViewModel {
  level: EnvelopeLevel;
  percent: number;
  mark: string | undefined;
  barColor: string;
  /** «начнётся DD.MM» | «завершён» | «—/день» | «~600 ₽/день» (§2.4/§2.9). */
  paceText: string;
  sym: string;
  /** `↩ +1 200` / `↩ −800`; null при нулевом/отсутствующем carryover (§2.6). */
  carryoverText: string | null;
  /** Аспект orbis/budget конверта (limit, period_start/period_end, …). */
  budget: Record<string, unknown>;
}

export function envelopeView(status: EnvelopeStatus): EnvelopeViewModel {
  const { category, phase } = status;
  const budget =
    (status.envelope.aspects as Record<string, Record<string, unknown> | undefined>)[
      'orbis/budget'
    ] ?? {};
  const currency = typeof budget.currency === 'string' ? budget.currency : 'RUB';
  const sym = CURRENCY_SYMBOL[currency] ?? currency;
  const carryover = typeof budget.carryover === 'string' ? budget.carryover : undefined;
  const periodStart = typeof budget.period_start === 'string' ? budget.period_start : '';

  // §2.9а: до начала периода пороги не применяются — нейтральный пустой бар
  const level = phase === 'upcoming' ? 'norm' : envelopeLevel(status.spent, status.effectiveLimit);
  const percent = phase === 'upcoming' ? 0 : envelopePercent(status.spent, status.effectiveLimit);
  const mark = phase === 'upcoming' ? undefined : LEVEL_MARK[level];
  const barColor =
    phase === 'upcoming'
      ? 'var(--color-line)'
      : level === 'norm'
        ? (category.color ?? 'var(--color-accent)')
        : LEVEL_BAR[level];

  // §2.4/§2.9: dailyPace — только active; null в active (remaining < 0) → «—/день»
  const paceText =
    phase === 'upcoming'
      ? `начнётся ${ddmm(periodStart)}`
      : phase === 'closed'
        ? 'завершён'
        : status.dailyPace === null
          ? '—/день'
          : `~${formatAmount(status.dailyPace)} ${sym}/день`;

  const carryoverText = isNonZero(carryover) ? `↩ ${signedAmount(carryover)}` : null;
  return { level, percent, mark, barColor, paceText, sym, carryoverText, budget };
}

export function EnvelopeCard({ status }: { status: EnvelopeStatus }) {
  const { category, phase } = status;
  const { level, percent, mark, barColor, paceText, sym, carryoverText } = envelopeView(status);

  // Одна интерактивная кнопка с токенами Card (не <Card><button>): вся карточка —
  // цель тапа, и нет конфликта паддингов p-4/p-0 из-за порядка утилит в CSS.
  return (
    <button
      type="button"
      data-testid="envelope-card"
      data-level={level}
      data-phase={phase}
      onClick={() => {
        const { activeTab, push } = useNav.getState();
        push(activeTab, { kind: 'budget-category', id: category.id });
      }}
      className={`flex cursor-pointer flex-col gap-1 rounded-card border border-line bg-surface p-3 text-left shadow-card outline-hidden transition hover:bg-surface-2/60 focus-visible:ring-2 focus-visible:ring-accent/60 ${
        phase === 'closed' ? 'opacity-60' : ''
      }`}
    >
      <p className="w-full truncate text-sm font-medium">
        {category.icon ? `${category.icon} ` : ''}
        {category.title}
      </p>

      <div className="flex w-full items-center gap-2">
        <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-surface-2">
          <div
            data-testid="envelope-bar"
            className="h-full rounded-full transition-[width]"
            style={{ width: `${Math.min(100, percent)}%`, backgroundColor: barColor }}
          />
        </div>
        <span className="shrink-0 text-xs tabular-nums text-text-secondary">
          {percent}%{mark ? ` ${mark}` : ''}
        </span>
      </div>

      <p className="text-xs tabular-nums text-text-secondary">
        {formatAmount(status.spent)} / {formatAmount(status.effectiveLimit)} {sym}
      </p>
      <p className="text-xs tabular-nums text-text-secondary">
        {phase === 'active' ? `ост. ${formatAmount(status.remaining)} ${sym} · ` : ''}
        {paceText}
      </p>

      {carryoverText && (
        <span className="inline-flex items-center rounded-full bg-surface-2 px-2 py-0.5 text-2xs tabular-nums text-text-secondary">
          {carryoverText}
        </span>
      )}
    </button>
  );
}
