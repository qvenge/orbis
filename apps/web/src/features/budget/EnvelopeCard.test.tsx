// Task B2: карточка конверта (03-budget §3.1 пороги, §2.4 «—/день», §2.9 фазы,
// §2.6 carryover-бейдж) + EnvelopeCreateSheet (создание конверта → entity.create
// с аспектом orbis/budget, инвалидация budget, тост ошибки уникальности §2.1).
import type { BudgetOverview, EnvelopeStatus } from '@orbis/shared';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import { useNav } from '../../state/navigation';
import { type MockHandler, renderWithProviders } from '../../test/harness';
import { useToastStore } from '../../ui/toast-store';
import { BudgetScreen } from './BudgetScreen';
import { EnvelopeCard, envelopeLevel, envelopePercent } from './EnvelopeCard';
import { EnvelopeCreateSheet } from './EnvelopeCreateSheet';

// --- фикстуры -------------------------------------------------------------------------

const wireEntity = (id: string, title: string, aspects: Record<string, unknown> = {}) => ({
  id,
  ownerId: 'u',
  title,
  emoji: null,
  body: '',
  bodyRefs: [],
  tags: [],
  meta: {},
  aspects,
  createdAt: 'x',
  updatedAt: 'y',
  archived: false,
});

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
    envelope: wireEntity('e1', 'Еда — июль', {
      'orbis/budget': {
        category_ref: 'cat-1',
        limit: over.effectiveLimit,
        currency: over.currency ?? 'RUB',
        period_start: over.periodStart ?? '2026-07-01',
        period_end: over.periodEnd ?? '2026-07-31',
        ...(over.carryover !== undefined ? { carryover: over.carryover } : {}),
      },
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
  useNav.setState({
    activeTab: 'budget',
    stacks: { chat: [], browser: [], agenda: [], budget: [] },
  });
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

// --- тап → push экрана категории (B3) ----------------------------------------------------

test('тап по карточке пушит экран budget-category в стек budget', () => {
  renderWithProviders(<EnvelopeCard status={status({ spent: '0', effectiveLimit: '10000.00' })} />);
  fireEvent.click(screen.getByRole('button', { name: /Еда/ }));
  expect(useNav.getState().stacks.budget).toEqual([{ kind: 'budget-category', id: 'cat-1' }]);
});

// --- EnvelopeCreateSheet ------------------------------------------------------------------

const categories = [
  wireEntity('c1', 'Еда', { 'orbis/category': { icon: '🍔' } }),
  wireEntity('c2', 'Транспорт', { 'orbis/category': {} }),
];

const settings = {
  timezone: 'Europe/Moscow',
  defaultCurrency: 'RUB',
  weekStartDay: 1,
  installedViews: ['orbis-budget'],
  pinnedEntities: [],
};

const sheetHandler =
  (createImpl?: (input: unknown) => unknown): MockHandler =>
  (path, input) => {
    if (path === 'user.getSettings') return settings;
    if (path === 'entity.query') return categories;
    if (path === 'entity.create') {
      if (createImpl) return createImpl(input);
      return wireEntity('env-new', 'Конверт');
    }
    if (path === 'budget.overview') return emptyOverview;
    if (path === 'budget.postDue') return { posted: 0 };
    return {};
  };

test('сабмит шлёт валидный orbis/budget-аспект: явная currency, период = месяц по умолчанию', async () => {
  const onOpenChange = vi.fn();
  const { calls } = renderWithProviders(
    <EnvelopeCreateSheet open onOpenChange={onOpenChange} month="2026-07" />,
    sheetHandler(),
  );
  await waitFor(() => expect(screen.getByRole('option', { name: /Еда/ })).toBeInTheDocument());

  fireEvent.change(screen.getByLabelText('Категория'), { target: { value: 'c1' } });
  fireEvent.change(screen.getByLabelText('Лимит'), { target: { value: '5000' } });
  fireEvent.click(screen.getByRole('button', { name: 'Создать' }));

  await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  const create = calls.find((c) => c.path === 'entity.create');
  expect(create).toBeDefined();
  const payload = create?.input as {
    source: string;
    input: { title: string; aspects: Record<string, Record<string, unknown>> };
  };
  expect(payload.source).toBe('ui');
  expect(payload.input.aspects['orbis/budget']).toEqual({
    category_ref: 'c1',
    limit: '5000',
    currency: 'RUB', // явная defaultCurrency — корректность держит сервер (A7)
    period_start: '2026-07-01',
    period_end: '2026-07-31',
  });
  expect(payload.input.title).toContain('Еда');
});

test('произвольный период: два date-инпута уходят в period_start/period_end', async () => {
  const { calls } = renderWithProviders(
    <EnvelopeCreateSheet open onOpenChange={() => {}} month="2026-08" />,
    sheetHandler(),
  );
  await waitFor(() => expect(screen.getByRole('option', { name: /Еда/ })).toBeInTheDocument());

  fireEvent.change(screen.getByLabelText('Категория'), { target: { value: 'c2' } });
  fireEvent.change(screen.getByLabelText('Лимит'), { target: { value: '15000.50' } });
  fireEvent.change(screen.getByLabelText('Начало периода'), {
    target: { value: '2026-08-10' },
  });
  fireEvent.change(screen.getByLabelText('Конец периода'), { target: { value: '2026-08-24' } });
  fireEvent.click(screen.getByRole('button', { name: 'Создать' }));

  await waitFor(() => expect(calls.some((c) => c.path === 'entity.create')).toBe(true));
  const payload = calls.find((c) => c.path === 'entity.create')?.input as {
    input: { aspects: Record<string, Record<string, unknown>> };
  };
  expect(payload.input.aspects['orbis/budget']).toMatchObject({
    category_ref: 'c2',
    limit: '15000.50',
    period_start: '2026-08-10',
    period_end: '2026-08-24',
  });
});

test('невалидный лимит (не decimal-строка) блокирует сабмит', async () => {
  const { calls } = renderWithProviders(
    <EnvelopeCreateSheet open onOpenChange={() => {}} month="2026-07" />,
    sheetHandler(),
  );
  await waitFor(() => expect(screen.getByRole('option', { name: /Еда/ })).toBeInTheDocument());
  fireEvent.change(screen.getByLabelText('Категория'), { target: { value: 'c1' } });
  fireEvent.change(screen.getByLabelText('Лимит'), { target: { value: '12,5abc' } });
  expect(screen.getByRole('button', { name: 'Создать' })).toBeDisabled();
  expect(calls.some((c) => c.path === 'entity.create')).toBe(false);
});

test('ошибка уникальности §2.1 → тост с текстом сервера, sheet не закрывается', async () => {
  const serverMessage =
    'конверт на эту точную комбинацию (категория, валюта, период) уже существует (03-budget §2.1); правьте существующий или архивируйте его';
  const onOpenChange = vi.fn();
  renderWithProviders(
    <EnvelopeCreateSheet open onOpenChange={onOpenChange} month="2026-07" />,
    sheetHandler(() => {
      throw new Error(serverMessage);
    }),
  );
  await waitFor(() => expect(screen.getByRole('option', { name: /Еда/ })).toBeInTheDocument());
  fireEvent.change(screen.getByLabelText('Категория'), { target: { value: 'c1' } });
  fireEvent.change(screen.getByLabelText('Лимит'), { target: { value: '5000' } });
  fireEvent.click(screen.getByRole('button', { name: 'Создать' }));

  await waitFor(() =>
    expect(useToastStore.getState().toasts.some((t) => t.title.includes('§2.1'))).toBe(true),
  );
  expect(useToastStore.getState().toasts[0]?.tone).toBe('danger');
  expect(onOpenChange).not.toHaveBeenCalledWith(false);
});

// --- интеграция с BudgetScreen ------------------------------------------------------------

const emptyOverview: BudgetOverview = {
  period: { start: '2026-07-01', end: '2026-07-31' },
  balance: { income: '0', expense: '0', balance: '0' },
  envelopes: [],
  comingUp: [],
  planned: [],
  unbudgeted: [{ category: { id: 'c1', title: 'Еда', icon: '🍔' }, total: '3200.00' }],
  alertCount: 0,
};

test('[+ конверт] открывает Sheet; после успешного сабмита budget.overview перезапрашивается', async () => {
  const { calls } = renderWithProviders(<BudgetScreen />, sheetHandler());
  await waitFor(() => expect(screen.getByTestId('balance-card')).toBeInTheDocument());

  fireEvent.click(screen.getByRole('button', { name: '+ конверт' }));
  await waitFor(() => expect(screen.getByRole('option', { name: /Еда/ })).toBeInTheDocument());

  const overviewCallsBefore = calls.filter((c) => c.path === 'budget.overview').length;
  fireEvent.change(screen.getByLabelText('Категория'), { target: { value: 'c1' } });
  fireEvent.change(screen.getByLabelText('Лимит'), { target: { value: '9000' } });
  fireEvent.click(screen.getByRole('button', { name: 'Создать' }));
  await waitFor(() => expect(calls.some((c) => c.path === 'entity.create')).toBe(true));

  // invalidateBudget → повторный запрос overview
  await waitFor(() =>
    expect(calls.filter((c) => c.path === 'budget.overview').length).toBeGreaterThan(
      overviewCallsBefore,
    ),
  );
});

test('Unbudgeted: кнопка создания конверта открывает Sheet с предвыбранной категорией', async () => {
  renderWithProviders(<BudgetScreen />, sheetHandler());
  await waitFor(() => expect(screen.getByTestId('balance-card')).toBeInTheDocument());

  fireEvent.click(screen.getByRole('button', { name: 'Конверт для «Еда»' }));
  await waitFor(() =>
    expect((screen.getByLabelText('Категория') as HTMLSelectElement).value).toBe('c1'),
  );
});
