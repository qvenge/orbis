// Task B2: карточка конверта (03-budget §3.1 пороги, §2.4 «—/день», §2.9 фазы,
// §2.6 carryover-бейдж). Лист создания конверта и его тесты удалены срезом 1в (§8.1: модуль без
// живого импортёра); с ними ушёл пин устаревшего текста отказа «§2.1» (Б-2 №73).

import type { EnvelopeStatus } from '@orbis/shared';
import { currentEntry } from '@orbis/shared/nav';
import { fireEvent, screen } from '@testing-library/react';
import { beforeEach, expect, test } from 'vitest';
import { resetNavForTests, useNav } from '../../state/navigation';
import { renderWithProviders, wireEntity } from '../../test/harness';
import { useToastStore } from '../../ui/toast-store';
import { EnvelopeCard, envelopeLevel, envelopePercent } from './EnvelopeCard';

// --- фикстуры -------------------------------------------------------------------------

function status(over: {
  spent: string;
  effectiveLimit: string;
  remaining?: string;
  dailyPace?: string | null;
  phase?: EnvelopeStatus['phase'];
  carryover?: string;
  currency?: string;
  periodStart?: string;
  periodEnd?: string;
  color?: string | null;
}): EnvelopeStatus {
  return {
    // Форма — РОВНО та, что отдаёт производитель (§А1-1): значения плоско по id свойства,
    // аспекты списком. Ключ `orbis/finance_category` один на конверт и операцию (В1).
    envelope: wireEntity({
      id: 'e1',
      title: 'Еда — июль',
      props: {
        'orbis/finance_category': 'cat-1',
        'orbis/limit': over.effectiveLimit,
        'orbis/currency': over.currency ?? 'RUB',
        'orbis/period_start': over.periodStart ?? '2026-07-01',
        'orbis/period_end': over.periodEnd ?? '2026-07-31',
        ...(over.carryover !== undefined ? { 'orbis/carryover': over.carryover } : {}),
      },
      aspects: ['orbis/budget'],
    }),
    category: { id: 'cat-1', title: 'Еда', icon: '🍔', color: over.color ?? null },
    spent: over.spent,
    effectiveLimit: over.effectiveLimit,
    remaining: over.remaining ?? '0',
    dailyPace: over.dailyPace ?? null,
    phase: over.phase ?? 'active',
  } as EnvelopeStatus;
}

beforeEach(() => {
  localStorage.clear();
  useToastStore.setState({ toasts: [] });
  resetNavForTests();
});

// --- envelopeLevel / envelopePercent: точные пороги §3.1 без IEEE-754 ------------------

test('envelopeLevel: <60% норм, 60–85% жёлтый, 85–100% оранжевый, ≥100% красный (границы включительно)', () => {
  expect(envelopeLevel('4500.00', '10000.00')).toBe('norm');
  expect(envelopeLevel('5999.99', '10000.00')).toBe('norm');
  expect(envelopeLevel('6000.00', '10000.00')).toBe('warn'); // ровно 60% → жёлтый
  expect(envelopeLevel('7200.00', '10000.00')).toBe('warn');
  expect(envelopeLevel('8500.00', '10000.00')).toBe('alert'); // ровно 85% → оранжевый
  expect(envelopeLevel('9100.00', '10000.00')).toBe('alert');
  expect(envelopeLevel('10000.00', '10000.00')).toBe('over'); // ровно 100% → красный
  expect(envelopeLevel('13700.00', '10000.00')).toBe('over');
});

test('envelopeLevel: вырожденные лимиты — нулевой и отрицательный effectiveLimit', () => {
  expect(envelopeLevel('0', '0.00')).toBe('norm'); // пустой конверт без трат
  expect(envelopeLevel('10.00', '0.00')).toBe('over'); // любая трата при нулевом потолке
  expect(envelopeLevel('0', '-500.00')).toBe('over'); // отрицательный carryover съел лимит
});

test('scaledBigInt: юникод-минус U+2212 распознаётся как отрицательный (§3.3)', () => {
  // '−500.00' (U+2212) как effectiveLimit — отрицательный потолок съеден carryover:
  // порог over. ASCII-версия того же кейса покрыта тестом вырожденных лимитов выше;
  // здесь важно, что знак не теряется (иначе '−500' распарсился бы как +500 → norm).
  expect(envelopeLevel('0', '−500.00')).toBe('over');
  expect(envelopeLevel('−800.00', '10000.00')).toBe('norm'); // отрицательный spent < 60%
  expect(envelopePercent('−800.00', '10000.00')).toBe(0); // spent ≤ 0 → 0%
});

test('envelopePercent: целые проценты по decimal-строкам', () => {
  expect(envelopePercent('7200.00', '10000.00')).toBe(72);
  expect(envelopePercent('9100.00', '10000.00')).toBe(91);
  expect(envelopePercent('10000.00', '10000.00')).toBe(100);
  expect(envelopePercent('9999.00', '10000.00')).toBe(99); // не округляем вверх до порога
  expect(envelopePercent('0', '0')).toBe(0);
  expect(envelopePercent('10.00', '0')).toBe(100);
});

// --- карточка: пороги подсветки §3.1 ---------------------------------------------------

test('active 45%: уровень norm, бар цветом категории, без ⚠/🔴', () => {
  renderWithProviders(
    <EnvelopeCard
      status={status({
        spent: '4500.00',
        effectiveLimit: '10000.00',
        remaining: '5500.00',
        dailyPace: '275.00',
        color: '#22aa55',
      })}
    />,
  );
  const card = screen.getByTestId('envelope-card');
  expect(card).toHaveAttribute('data-level', 'norm');
  expect(card).toHaveTextContent('45%');
  expect(card).not.toHaveTextContent('⚠');
  expect(card).not.toHaveTextContent('🔴');
  expect(screen.getByTestId('envelope-bar').style.backgroundColor).toBe('rgb(34, 170, 85)');
});

test('active 72%: жёлтый уровень warn, ост. и ~₽/день из данных сервера', () => {
  renderWithProviders(
    <EnvelopeCard
      status={status({
        spent: '7200.00',
        effectiveLimit: '10000.00',
        remaining: '2800.00',
        dailyPace: '600.00',
      })}
    />,
  );
  const card = screen.getByTestId('envelope-card');
  expect(card).toHaveAttribute('data-level', 'warn');
  expect(card).toHaveTextContent('72%');
  expect(card).toHaveTextContent('ост. 2 800 ₽');
  expect(card).toHaveTextContent('~600 ₽/день');
  expect(card).not.toHaveTextContent('⚠');
});

test('active 91%: оранжевый уровень alert с маркером ⚠', () => {
  renderWithProviders(
    <EnvelopeCard
      status={status({
        spent: '9100.00',
        effectiveLimit: '10000.00',
        remaining: '900.00',
        dailyPace: '64.29',
      })}
    />,
  );
  const card = screen.getByTestId('envelope-card');
  expect(card).toHaveAttribute('data-level', 'alert');
  expect(card).toHaveTextContent('⚠');
  expect(card).not.toHaveTextContent('🔴');
});

test('active ≥100%: красный уровень over с маркером 🔴 и «—/день» при dailyPace=null', () => {
  renderWithProviders(
    <EnvelopeCard
      status={status({
        spent: '10000.00',
        effectiveLimit: '10000.00',
        remaining: '0.00',
        dailyPace: null,
      })}
    />,
  );
  const card = screen.getByTestId('envelope-card');
  expect(card).toHaveAttribute('data-level', 'over');
  expect(card).toHaveTextContent('🔴');
  expect(card).toHaveTextContent('—/день');
});

// --- фазы §2.9 --------------------------------------------------------------------------

test('upcoming: нейтральный пустой бар без порогов, «начнётся DD.MM» вместо темпа', () => {
  renderWithProviders(
    <EnvelopeCard
      status={status({
        spent: '0.00',
        effectiveLimit: '10000.00',
        remaining: '10000.00',
        dailyPace: null,
        phase: 'upcoming',
        periodStart: '2026-08-10',
        periodEnd: '2026-08-24',
      })}
    />,
  );
  const card = screen.getByTestId('envelope-card');
  expect(card).toHaveAttribute('data-phase', 'upcoming');
  expect(card).toHaveTextContent('начнётся 10.08');
  expect(card).not.toHaveTextContent('/день');
  expect(screen.getByTestId('envelope-bar').style.width).toBe('0%');
});

test('closed: приглушённая карточка, «завершён», итоговый порог применяется', () => {
  renderWithProviders(
    <EnvelopeCard
      status={status({
        spent: '10400.00',
        effectiveLimit: '10000.00',
        remaining: '-400.00',
        dailyPace: null,
        phase: 'closed',
      })}
    />,
  );
  const card = screen.getByTestId('envelope-card');
  expect(card).toHaveAttribute('data-phase', 'closed');
  expect(card).toHaveTextContent('завершён');
  expect(card).toHaveAttribute('data-level', 'over');
  expect(card.className).toContain('opacity');
});

// --- carryover-бейдж §2.6 ----------------------------------------------------------------

test('carryover-бейдж: ↩ +1 200 при профиците, ↩ −800 при дефиците, отсутствует при нуле', () => {
  const { unmount } = renderWithProviders(
    <EnvelopeCard
      status={status({ spent: '0', effectiveLimit: '11200.00', carryover: '1200.00' })}
    />,
  );
  expect(screen.getByTestId('envelope-card')).toHaveTextContent('↩ +1 200');
  unmount();

  const { unmount: u2 } = renderWithProviders(
    <EnvelopeCard
      status={status({ spent: '0', effectiveLimit: '9200.00', carryover: '-800.00' })}
    />,
  );
  expect(screen.getByTestId('envelope-card')).toHaveTextContent('↩ −800');
  u2();

  renderWithProviders(
    <EnvelopeCard status={status({ spent: '0', effectiveLimit: '10000.00', carryover: '0' })} />,
  );
  expect(screen.getByTestId('envelope-card')).not.toHaveTextContent('↩');
});

// --- тап → запись категории (экрана категории в 1б нет, §8.6) ---------------------------

test('тап по карточке открывает запись категории в рамке экрана', () => {
  renderWithProviders(<EnvelopeCard status={status({ spent: '0', effectiveLimit: '10000.00' })} />);
  fireEvent.click(screen.getByRole('button', { name: /Еда/ }));
  expect(currentEntry(useNav.getState().model).address).toEqual({
    kind: 'record',
    app: { kind: 'host' },
    id: 'cat-1',
  });
});
