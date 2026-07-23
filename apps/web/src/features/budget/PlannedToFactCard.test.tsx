// Task B6: карточка перевода покупки plan→fact (03-budget §2.7) + usePlanToFactPrompt.
// Точка показа — DetailScreen: чекбокс задачи (единственный мутационный путь toggle,
// useEntityDetail.toggleTask). Карточка «Покупка совершена? <сумма> → <категория>»
// с date-инпутом (default сегодня локально); [Перевести в факт] → budget.confirmPurchase
// {entityId, occurredOn, batchId} (batchId UUIDv7 один на показ карточки, уроки B4:
// повтор после ошибки — тот же id, CONFLICT — честная ошибка + новый id);
// [Оставить план] — без мутации.
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, test } from 'vitest';
import { useNav } from '../../state/navigation';
import { type MockHandler, renderWithProviders, trpcError } from '../../test/harness';
import { DetailScreen } from '../entity-detail/DetailScreen';

// --- фикстуры -------------------------------------------------------------------------

const ent = (id: string, title: string, aspects: Record<string, unknown> = {}) => ({
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

/** Покупка-задача §2.7: orbis/task + orbis/financial planned=true. */
const purchase = ent('e1', 'Купить кроссовки', {
  'orbis/task': { status: 'inbox' },
  'orbis/financial': {
    amount: '8000.00',
    direction: 'expense',
    occurred_on: '2026-08-01',
    planned: true,
    category_ref: 'cat-cl',
  },
});

/** Обычная задача без planned-financial — карточка не показывается. */
const plainTask = ent('e2', 'Обычная задача', { 'orbis/task': { status: 'inbox' } });

const category = ent('cat-cl', 'Одежда', { 'orbis/category': { icon: '👟' } });

const settings = {
  timezone: 'Europe/Moscow',
  defaultCurrency: 'RUB',
  weekStartDay: 1,
  installedViews: ['orbis-budget'],
  pinnedEntities: [],
};

/** «Сегодня» в таймзоне настроек — дефолт date-инпута (§2.7). */
const TODAY = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Moscow',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
}).format(new Date());

type ConfirmBehavior = (input: unknown) => unknown;
const okConfirm: ConfirmBehavior = () => ({ actionId: 'act-cp', idempotentReplay: false });

const handler =
  (over: { confirm?: ConfirmBehavior } = {}): MockHandler =>
  (path, input) => {
    if (path === 'user.getSettings') return settings;
    if (path === 'entity.get') {
      const { id } = input as { id: string };
      const found = [purchase, plainTask, category].find((e) => e.id === id);
      return { entity: found ?? ent(id, 'x'), relations: [], thread: null };
    }
    if (path === 'entity.update') {
      const { id } = input as { id: string };
      return { ...([purchase, plainTask].find((e) => e.id === id) ?? ent(id, 'x')) };
    }
    if (path === 'relation.listFor') return [];
    if (path === 'budget.confirmPurchase') return (over.confirm ?? okConfirm)(input);
    return {};
  };

beforeEach(() => {
  localStorage.clear();
  useNav.setState({
    activeTab: 'browser',
    stacks: { chat: [], browser: [{ kind: 'entity', id: 'e1' }], agenda: [], budget: [] },
  });
});

const confirmCalls = (calls: { path: string; input: unknown }[]) =>
  calls
    .filter((c) => c.path === 'budget.confirmPurchase')
    .map((c) => c.input as { entityId: string; occurredOn: string; batchId: string });

async function renderDone(over: Parameters<typeof handler>[0] = {}) {
  const r = renderWithProviders(<DetailScreen entityId="e1" />, handler(over));
  await waitFor(() =>
    expect(screen.getByRole('checkbox', { name: /готово/i })).toBeInTheDocument(),
  );
  fireEvent.click(screen.getByRole('checkbox', { name: /готово/i }));
  await waitFor(() => expect(screen.getByTestId('plan-to-fact-card')).toBeInTheDocument());
  return r;
}

// --- появление карточки (§2.7) ---------------------------------------------------------

test('done планируемой покупки → карточка «Покупка совершена?» с суммой, категорией и датой=сегодня', async () => {
  await renderDone();

  const card = screen.getByTestId('plan-to-fact-card');
  expect(card).toHaveTextContent('Покупка совершена?');
  expect(card).toHaveTextContent('−8 000'); // сумма расхода
  await waitFor(() => expect(card).toHaveTextContent('Одежда')); // категория по category_ref
  expect(screen.getByLabelText('Дата покупки')).toHaveValue(TODAY);
});

test('done обычной задачи (без planned-financial) — карточки нет', async () => {
  useNav.setState({
    activeTab: 'browser',
    stacks: { chat: [], browser: [{ kind: 'entity', id: 'e2' }], agenda: [], budget: [] },
  });
  const { calls } = renderWithProviders(<DetailScreen entityId="e2" />, handler());
  await waitFor(() =>
    expect(screen.getByRole('checkbox', { name: /готово/i })).toBeInTheDocument(),
  );
  fireEvent.click(screen.getByRole('checkbox', { name: /готово/i }));

  await waitFor(() => expect(calls.some((c) => c.path === 'entity.update')).toBe(true));
  expect(screen.queryByTestId('plan-to-fact-card')).toBeNull();
});

// --- [Перевести в факт] → confirmPurchase (§2.7) ---------------------------------------

test('[Перевести в факт] зовёт confirmPurchase с ВЫБРАННОЙ датой; карточка закрывается', async () => {
  const { calls } = await renderDone();

  fireEvent.change(screen.getByLabelText('Дата покупки'), { target: { value: '2026-07-15' } });
  fireEvent.click(screen.getByRole('button', { name: 'Перевести в факт' }));

  await waitFor(() => expect(confirmCalls(calls)).toHaveLength(1));
  const call = confirmCalls(calls)[0];
  expect(call?.entityId).toBe('e1');
  expect(call?.occurredOn).toBe('2026-07-15');
  expect(call?.batchId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/i, // UUIDv7
  );
  await waitFor(() => expect(screen.queryByTestId('plan-to-fact-card')).toBeNull());
});

test('[Оставить план] закрывает карточку без мутации', async () => {
  const { calls } = await renderDone();

  fireEvent.click(screen.getByRole('button', { name: 'Оставить план' }));
  await waitFor(() => expect(screen.queryByTestId('plan-to-fact-card')).toBeNull());
  expect(confirmCalls(calls)).toHaveLength(0);
});

// --- batchId-жизненный-цикл (уроки B4) -------------------------------------------------

test('повтор после ошибки — ТОТ ЖЕ batchId; CONFLICT — ошибка (не успех) и НОВЫЙ id', async () => {
  const errors: string[] = ['INTERNAL_SERVER_ERROR', 'CONFLICT'];
  const { calls } = await renderDone({
    confirm: (input) => {
      const code = errors.shift();
      if (code) throw trpcError(code);
      return okConfirm(input);
    },
  });

  // 1-я попытка: транспортная ошибка → карточка на месте, ошибка видна
  fireEvent.click(screen.getByRole('button', { name: 'Перевести в факт' }));
  await waitFor(() => expect(screen.getByTestId('plan-to-fact-error')).toBeInTheDocument());
  expect(screen.getByTestId('plan-to-fact-card')).toBeInTheDocument();

  // 2-я попытка: тот же batchId (идемпотентность §7.8); сервер отвечает CONFLICT
  fireEvent.click(screen.getByRole('button', { name: 'Перевести в факт' }));
  await waitFor(() => expect(confirmCalls(calls)).toHaveLength(2));
  const [first, second] = confirmCalls(calls);
  expect(second?.batchId).toBe(first?.batchId);
  await waitFor(() => expect(screen.getByTestId('plan-to-fact-error')).toBeInTheDocument());
  expect(screen.getByTestId('plan-to-fact-card')).toBeInTheDocument(); // CONFLICT ≠ успех

  // 3-я попытка: batchId непригоден → новый id, успех закрывает карточку
  fireEvent.click(screen.getByRole('button', { name: 'Перевести в факт' }));
  await waitFor(() => expect(confirmCalls(calls)).toHaveLength(3));
  expect(confirmCalls(calls)[2]?.batchId).not.toBe(first?.batchId);
  await waitFor(() => expect(screen.queryByTestId('plan-to-fact-card')).toBeNull());
});
