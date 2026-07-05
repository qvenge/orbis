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
  );
  expect(screen.getByTestId('qr-aggregate')).toHaveTextContent('1200.00');
  expect(screen.getByRole('button', { name: /показать список/i })).toBeInTheDocument();
});

test('query_result без aggregate → native-список из entityIds (D-d)', () => {
  renderWithProviders(
    <div>{renderCards(msg([{ kind: 'query_result', count: 2, entityIds: ['a', 'b'] }]))}</div>,
  );
  expect(screen.getAllByTestId('qr-item')).toHaveLength(2);
});

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

test('smoothAuditText сглаживает «batch: операций — 1»', () => {
  expect(smoothAuditText('batch: операций — 1')).toBe('Операция выполнена');
  expect(smoothAuditText('batch: операций — 3')).toBe('batch: операций — 3');
});
