import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { renderWithProviders } from '../../../test/harness';
import { smoothAuditText } from '../format-audit';
import type { ChatMessage } from '../useChatThread';
import { renderCards } from './renderCards';

const msg = (cards: unknown[], extra: Partial<ChatMessage> = {}): ChatMessage =>
  ({
    id: 'm1',
    threadId: 't1',
    role: 'assistant',
    content: '',
    metadata: { cards },
    createdAt: '2026-07-05T12:00:00.000Z',
    ...extra,
  }) as ChatMessage;

// Мок entity.get для строк query_result: EntityRef резолвит id → title (этап 4, без UUID в UI).
const entityGet = (path: string, input: unknown) =>
  path === 'entity.get'
    ? { entity: { id: (input as { id: string }).id, title: `T-${(input as { id: string }).id}` } }
    : {};

test('entity_card: Undo зовёт ai.undo(undoActionId) и гасит карточку', async () => {
  const { calls } = renderWithProviders(
    <div>
      {renderCards(
        msg([
          {
            kind: 'entity_card',
            entityId: 'e1',
            title: 'Обед',
            aspects: ['orbis/financial'],
            keyFields: { amount: '340.00', direction: 'expense' },
            undoActionId: 'act1',
          },
        ]),
      )}
    </div>,
    (path) =>
      path === 'ai.undo'
        ? { ok: true, actionId: 'act1', results: [], idempotentReplay: false }
        : {},
  );
  fireEvent.click(screen.getByRole('button', { name: /отменить|undo/i }));
  await waitFor(() =>
    expect(calls.find((c) => c.path === 'ai.undo')?.input).toEqual({ actionId: 'act1' }),
  );
  await waitFor(() =>
    expect(screen.getByTestId('entity-card')).toHaveAttribute('data-undone', 'true'),
  );
});

test('query_result с aggregate → число + «показать список»', () => {
  renderWithProviders(
    <div>
      {renderCards(
        msg([
          {
            kind: 'query_result',
            title: 'Расходы',
            count: 3,
            entityIds: ['a', 'b', 'c'],
            aggregate: { op: 'sum', value: '1200.00' },
          },
        ]),
      )}
    </div>,
    entityGet,
  );
  expect(screen.getByTestId('qr-aggregate')).toHaveTextContent('1200.00');
  expect(screen.getByRole('button', { name: /показать список/i })).toBeInTheDocument();
});

test('query_result без aggregate → native-список: title через entity.get, не сырой id', async () => {
  renderWithProviders(
    <div>{renderCards(msg([{ kind: 'query_result', count: 2, entityIds: ['a', 'b'] }]))}</div>,
    entityGet,
  );
  expect(screen.getAllByTestId('qr-item')).toHaveLength(2);
  // Строка показывает человеко-читаемый title, а не UUID.
  await waitFor(() => expect(screen.getByText('T-a')).toBeInTheDocument());
  expect(screen.getByText('T-b')).toBeInTheDocument();
});

// Пинним Date.now в пределах 24ч-окна фикстуры createdAt, чтобы expired не зависел от
// настенных часов. Мокаем только Date.now (не setTimeout) — async waitFor не виснет;
// ConfirmationCard берёт now по умолчанию из Date.now() → expired детерминирован.
describe('confirmation explicit actions (детерминированное время)', () => {
  beforeEach(() => vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-07-05T12:00:01.000Z')));
  afterEach(() => vi.restoreAllMocks());

  test('confirmation explicit: Подтвердить → ai.approve(pendingId)', async () => {
    const { calls } = renderWithProviders(
      <div>
        {renderCards(
          msg([
            {
              kind: 'confirmation_card',
              mode: 'explicit',
              pendingId: 'p1',
              summary: 'Удалить 3 задачи',
              diff: {},
            },
          ]),
        )}
      </div>,
      (path) =>
        path === 'ai.approve'
          ? { ok: true, actionId: 'a', results: [], idempotentReplay: false }
          : {},
    );
    fireEvent.click(screen.getByRole('button', { name: /подтвердить/i }));
    await waitFor(() =>
      expect(calls.find((c) => c.path === 'ai.approve')?.input).toEqual({ pendingId: 'p1' }),
    );
  });

  test('confirmation explicit: Отменить → ai.reject(pendingId)', async () => {
    const { calls } = renderWithProviders(
      <div>
        {renderCards(
          msg([{ kind: 'confirmation_card', mode: 'explicit', pendingId: 'p2', summary: 's' }]),
        )}
      </div>,
      (path) => (path === 'ai.reject' ? { pendingId: 'p2', alreadyRejected: false } : {}),
    );
    fireEvent.click(screen.getByRole('button', { name: /отменить/i }));
    await waitFor(() =>
      expect(calls.find((c) => c.path === 'ai.reject')?.input).toEqual({ pendingId: 'p2' }),
    );
  });
});

describe('visual-expiry (D-a)', () => {
  beforeEach(() => vi.useFakeTimers().setSystemTime(new Date('2026-07-07T13:00:00.000Z')));
  afterEach(() => vi.useRealTimers());
  test('старше 24ч → кнопки задизейблены, подпись «устарело»', () => {
    renderWithProviders(
      <div>
        {renderCards(
          msg([{ kind: 'confirmation_card', mode: 'explicit', pendingId: 'p3', summary: 's' }], {
            createdAt: '2026-07-05T12:00:00.000Z',
          }),
        )}
      </div>,
    );
    expect(screen.getByRole('button', { name: /подтвердить/i })).toBeDisabled();
    expect(screen.getByText(/устарело/i)).toBeInTheDocument();
  });
});

test('error_card: код + сообщение', () => {
  renderWithProviders(
    <div>
      {renderCards(
        msg([{ kind: 'error_card', code: 'LLM_UNAVAILABLE', message: 'Модель недоступна' }]),
      )}
    </div>,
  );
  expect(screen.getByRole('alert')).toHaveTextContent('Модель недоступна');
});

test('SystemMessage: author_kind=agent → префикс 🤖 агент', () => {
  renderWithProviders(
    <div>
      {renderCards(
        msg([{ kind: 'entity_card', entityId: 'e', title: 'T', aspects: [], keyFields: {} }], {
          metadata: {
            author_kind: 'agent',
            cards: [{ kind: 'entity_card', entityId: 'e', title: 'T', aspects: [], keyFields: {} }],
          },
        }),
      )}
    </div>,
  );
  expect(screen.getByText(/агент/i)).toBeInTheDocument();
});

// --- Остаток конверта в fast-path-карточке (§4.1, B7) --------------------------------

const finCard = {
  kind: 'entity_card',
  entityId: 'e1',
  title: 'Обед 340',
  aspects: ['orbis/financial'],
  keyFields: {
    amount: '340.00',
    direction: 'expense',
    category_ref: 'c1',
    occurred_on: '2026-07-13',
  },
  undoActionId: 'act1',
};

// EnvelopeStatus «после записи»: сервер уже учёл транзакцию (spent включает 340)
const envStatus = {
  envelope: {
    id: 'env1',
    ownerId: 'u',
    title: 'Конверт Еда',
    emoji: null,
    body: '',
    bodyRefs: [],
    tags: [],
    meta: {},
    aspects: {
      'orbis/budget': {
        category_ref: 'c1',
        limit: '10000.00',
        period_start: '2026-07-01',
        period_end: '2026-07-31',
      },
    },
    createdAt: 'x',
    updatedAt: 'y',
    archived: false,
  },
  category: { id: 'c1', title: 'Еда', icon: null, color: null },
  spent: '1940.00',
  effectiveLimit: '10000.00',
  remaining: '8060.00',
  dailyPace: null,
  phase: 'active',
};

const fastMsg = (status: 'confirmed' | 'pending') =>
  msg([finCard], {
    metadata: {
      cards: [finCard],
      fastPath: { entityId: 'e1', text: 'обед 340', status },
    },
  });

test('подтверждённая financial-карточка → «→ Еда · осталось 8 060 ₽» из envelopeForCategory (§4.1)', async () => {
  const { calls } = renderWithProviders(<div>{renderCards(fastMsg('confirmed'))}</div>, (path) =>
    path === 'budget.envelopeForCategory' ? envStatus : {},
  );
  await waitFor(() =>
    expect(screen.getByTestId('envelope-remaining')).toHaveTextContent('→ Еда · осталось 8 060 ₽'),
  );
  // Запрос идёт по category_ref и occurred_on ЗАПИСИ (не «сегодня» клиента)
  expect(calls.find((c) => c.path === 'budget.envelopeForCategory')?.input).toEqual({
    categoryId: 'c1',
    date: '2026-07-13',
  });
});

test('конверта нет (null → Unbudgeted) → строки остатка нет', async () => {
  const { calls } = renderWithProviders(<div>{renderCards(fastMsg('confirmed'))}</div>, (path) =>
    path === 'budget.envelopeForCategory' ? null : {},
  );
  await waitFor(() =>
    expect(calls.some((c) => c.path === 'budget.envelopeForCategory')).toBe(true),
  );
  expect(screen.queryByTestId('envelope-remaining')).toBeNull();
});

test('карточка «⏳» (pending, до подтверждения сервером) остаток НЕ запрашивает (§4.1)', async () => {
  const { calls } = renderWithProviders(<div>{renderCards(fastMsg('pending'))}</div>, (path) =>
    path === 'budget.envelopeForCategory' ? envStatus : {},
  );
  await waitFor(() => expect(screen.getByTestId('entity-card')).toBeInTheDocument());
  expect(screen.queryByTestId('envelope-remaining')).toBeNull();
  expect(calls.some((c) => c.path === 'budget.envelopeForCategory')).toBe(false);
});

test('нефинансовая карточка без category_ref остаток не запрашивает', async () => {
  const { calls } = renderWithProviders(
    <div>
      {renderCards(
        msg([
          { kind: 'entity_card', entityId: 'e2', title: 'Заметка', aspects: [], keyFields: {} },
        ]),
      )}
    </div>,
  );
  await waitFor(() => expect(screen.getByTestId('entity-card')).toBeInTheDocument());
  expect(calls.some((c) => c.path === 'budget.envelopeForCategory')).toBe(false);
});

// Ревью B7 (Minor 3): остаток — про фактический расход; income и planned — без строки.
test('income-карточка остаток НЕ запрашивает (§4.1 — остаток про расход)', async () => {
  const incomeCard = {
    ...finCard,
    keyFields: { ...finCard.keyFields, direction: 'income' },
  };
  const { calls } = renderWithProviders(<div>{renderCards(msg([incomeCard]))}</div>, (path) =>
    path === 'budget.envelopeForCategory' ? envStatus : {},
  );
  await waitFor(() => expect(screen.getByTestId('entity-card')).toBeInTheDocument());
  expect(screen.queryByTestId('envelope-remaining')).toBeNull();
  expect(calls.some((c) => c.path === 'budget.envelopeForCategory')).toBe(false);
});

test('planned-карточка остаток НЕ запрашивает — записи в spent ещё нет (§2.7)', async () => {
  const plannedCard = {
    ...finCard,
    keyFields: { ...finCard.keyFields, planned: true },
  };
  const { calls } = renderWithProviders(<div>{renderCards(msg([plannedCard]))}</div>, (path) =>
    path === 'budget.envelopeForCategory' ? envStatus : {},
  );
  await waitFor(() => expect(screen.getByTestId('entity-card')).toBeInTheDocument());
  expect(screen.queryByTestId('envelope-remaining')).toBeNull();
  expect(calls.some((c) => c.path === 'budget.envelopeForCategory')).toBe(false);
});

test('после Undo строка остатка снимается вместе с карточкой', async () => {
  renderWithProviders(<div>{renderCards(fastMsg('confirmed'))}</div>, (path) => {
    if (path === 'budget.envelopeForCategory') return envStatus;
    if (path === 'ai.undo')
      return { ok: true, actionId: 'act1', results: [], idempotentReplay: false };
    return {};
  });
  await waitFor(() => expect(screen.getByTestId('envelope-remaining')).toBeInTheDocument());
  fireEvent.click(screen.getByRole('button', { name: /отменить/i }));
  await waitFor(() =>
    expect(screen.getByTestId('entity-card')).toHaveAttribute('data-undone', 'true'),
  );
  expect(screen.queryByTestId('envelope-remaining')).toBeNull();
});

test('smoothAuditText сглаживает «batch: операций — 1»', () => {
  expect(smoothAuditText('batch: операций — 1')).toBe('Операция выполнена');
  expect(smoothAuditText('batch: операций — 3')).toBe('batch: операций — 3');
});
