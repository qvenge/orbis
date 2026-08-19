import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { useNav } from '../../../state/navigation';
import { type MockHandler, renderWithProviders, trpcError } from '../../../test/harness';
import { smoothAuditText } from '../format-audit';
import { MEMORY_RULES_QUERY } from '../memoryRules';
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

// Сброс глобального состояния между тестами (идиома BudgetScreen.test): import_review
// переключает вкладку и пушит экран — без сброса соседние тесты зависели бы от чужой
// оставшейся навигации.
beforeEach(() => {
  localStorage.clear();
  useNav.setState({
    activeTab: 'chat',
    stacks: { chat: [], browser: [], agenda: [], budget: [] },
  });
});

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

// C3-устойчивость audit-карточки из истории проверяется через НАСТОЯЩИЙ путь ленты —
// MessageList.test.tsx («audit fast-path из истории…»): renderCards роль сообщения не
// читает вовсе, поэтому здесь такой тест отличался бы от соседнего лишь фикстурой.

// Р11: разворачиваемого списка у агрегата нет вовсе. Единственный производитель
// агрегатной карточки — aggregateCard (server tools/dispatch.ts:417-430) — кладёт
// entityIds:[] всегда, поэтому кнопка «Показать список» и её <ul> были кодом, до
// которого не доехать. Фикстура намеренно НЕсерверная (агрегат + непустой список):
// на серверной (entityIds:[]) тест не отличил бы снятую кнопку от спрятанной за
// пустотой списка. Ассерция — отрицательная, поэтому недостижимый рендер она не
// оживляет, а наоборот держит снятым (политика types.ts:24-28,42-44).
test('query_result с aggregate → число и «Записей: N», разворота списка нет вовсе', () => {
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
  expect(screen.getByTestId('query-result-card')).toHaveTextContent('Расходы');
  expect(screen.getByTestId('qr-aggregate')).toHaveTextContent('1200.00');
  expect(screen.getByTestId('qr-count')).toHaveTextContent('Записей: 3');
  expect(screen.queryByRole('button', { name: /показать список/i })).not.toBeInTheDocument();
  expect(screen.queryByTestId('qr-item')).not.toBeInTheDocument();
  // Агрегат — не «пусто»: число есть, значит пустого состояния быть не должно.
  expect(screen.queryByTestId('qr-empty')).not.toBeInTheDocument();
});

// Тест выше намеренно стоит на НЕвозможной фикстуре, поэтому настоящую серверную форму
// агрегата не проверял никто: aggregateCard шлёт op='sum' ВМЕСТЕ с entityIds:[] (dispatch.ts:
// 411,426), а пустой список до этого встречался только с op='count', где счётчик не рисуется
// вовсе. Здесь пустой список сходится с подписью «Записей: N» — и это единственное место, где
// видно, что карточка не путает «агрегат без ids» с «ничего не найдено».
test('серверная форма агрегата (sum + entityIds:[]) → число и «Записей: N», не пустое состояние', () => {
  renderWithProviders(
    <div>
      {renderCards(
        msg([
          {
            kind: 'query_result',
            title: 'Еда в июне',
            count: 12,
            entityIds: [],
            aggregate: { op: 'sum', value: '12430.00' },
          },
        ]),
      )}
    </div>,
    entityGet,
  );
  expect(screen.getByTestId('qr-aggregate')).toHaveTextContent('12430.00');
  expect(screen.getByTestId('qr-count')).toHaveTextContent('Записей: 12');
  // Пустой entityIds у агрегата — это «id не выбирались», а не «ничего не найдено»:
  // провалиться в пустое состояние карточка не должна, число ведь есть.
  expect(screen.queryByTestId('qr-empty')).not.toBeInTheDocument();
  expect(screen.queryByTestId('qr-list')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /показать список/i })).not.toBeInTheDocument();
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

test('query_result без результатов → «Ничего не найдено», пустого списка нет', () => {
  renderWithProviders(
    <div>{renderCards(msg([{ kind: 'query_result', count: 0, entityIds: [] }]))}</div>,
    entityGet,
  );
  expect(screen.getByTestId('qr-empty')).toHaveTextContent('Ничего не найдено');
  expect(screen.queryByTestId('qr-list')).not.toBeInTheDocument();
  expect(screen.queryByTestId('qr-count')).not.toBeInTheDocument();
});

test('query_result со списком → счётчик «Совпадений: N»', () => {
  renderWithProviders(
    <div>{renderCards(msg([{ kind: 'query_result', count: 2, entityIds: ['a', 'b'] }]))}</div>,
    entityGet,
  );
  expect(screen.getByTestId('qr-count')).toHaveTextContent('Совпадений: 2');
});

test('агрегат count → счётчик не дублирует само число', () => {
  renderWithProviders(
    <div>
      {renderCards(
        msg([
          {
            kind: 'query_result',
            count: 5,
            entityIds: [],
            aggregate: { op: 'count', value: '5' },
          },
        ]),
      )}
    </div>,
    entityGet,
  );
  expect(screen.getByTestId('qr-aggregate')).toHaveTextContent('5');
  expect(screen.queryByTestId('qr-count')).not.toBeInTheDocument();
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

test('SystemMessage: журнальное действие с actor_kind=agent → та же метка «агент» (приёмка 14)', () => {
  // Действия внешнего исполнителя приезжают в ленту audit-сообщением, которое пишет СЕРВЕР
  // от системы: `author_kind` у него не агентский, а кто именно двигал граф — сказано в
  // `metadata.actions[0].actor_kind` (§7.8). Без этой ветки работа агента была бы в журнале
  // неотличима от работы владельца.
  const card = { kind: 'entity_card', entityId: 'e', title: 'T', aspects: [], keyFields: {} };
  renderWithProviders(
    <div>
      {renderCards(
        msg([card], {
          metadata: {
            cards: [card],
            actions: [{ actor_kind: 'agent', actor_grant_id: 'g1' }],
          },
        }),
      )}
    </div>,
  );
  expect(screen.getByTestId('system-message')).toBeInTheDocument();
  expect(screen.getByText(/агент/i)).toBeInTheDocument();
});

test('SystemMessage: действие владельца (actor_kind=owner) метки агента НЕ получает', () => {
  // Премиса предыдущего теста: метку ставит именно агентский actor_kind, а не сам факт
  // журнальной записи — иначе «агент» стоял бы над каждой правкой владельца.
  const card = { kind: 'entity_card', entityId: 'e', title: 'T', aspects: [], keyFields: {} };
  renderWithProviders(
    <div>
      {renderCards(
        msg([card], { metadata: { cards: [card], actions: [{ actor_kind: 'owner' }] } }),
      )}
    </div>,
  );
  expect(screen.queryByTestId('system-message')).toBeNull();
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

// D6c п.2 (живой смоук D6b): в сетке полей карточки печаталось «категория: 7d5e3a94-…».
// Название было только в строке остатка конверта, а её нет у транзакции без конверта.
const categoryEntity = {
  id: 'c1',
  ownerId: 'u',
  title: 'Еда',
  emoji: null,
  body: '',
  bodyRefs: [],
  tags: [],
  meta: {},
  aspects: { 'orbis/category': { icon: '🍔' } },
  createdAt: 'x',
  updatedAt: 'y',
  archived: false,
};

// Конверта у записи нет (null) — ровно случай смоука: строки остатка не будет,
// и название категории обязано прийти из самой карточки.
// categories: unknown — сюда передают и готовый массив, и ещё не разрешённый промис (D6d).
const noEnvelope = (path: string, categories: unknown) => {
  if (path === 'budget.envelopeForCategory') return null;
  if (path === 'entity.query') return categories;
  return {};
};

test('entity_card: категория показана НАЗВАНИЕМ, а не uuid (D6c п.2)', async () => {
  const { calls } = renderWithProviders(<div>{renderCards(msg([finCard]))}</div>, (path) =>
    noEnvelope(path, [categoryEntity]),
  );
  const card = await screen.findByTestId('entity-card');
  await waitFor(() => expect(card).toHaveTextContent('Еда'));
  expect(card).not.toHaveTextContent('c1');
  // Тот же запрос категорий, что у пикера D3b (один кэш, второго источника нет)
  expect(calls.find((c) => c.path === 'entity.query')?.input).toEqual({
    query: 'aspect=orbis/category, sortBy=title:asc, limit=200',
  });
});

// D6d п.2: прежняя версия утверждала uuid в DOM сразу после рендера — а он там и так есть,
// пока список категорий не доехал. Соседняя карточка с ИЗВЕСТНОЙ категорией — маркер того,
// что запрос разрешён: только после её названия отсутствие имени значит «категории нет».
test('entity_card: категории нет в списке → uuid как запасной вариант (D6c п.2)', async () => {
  const ghostCard = {
    ...finCard,
    entityId: 'e2',
    title: 'Кино 500',
    keyFields: { ...finCard.keyFields, category_ref: 'c-неизвестная' },
  };
  renderWithProviders(<div>{renderCards(msg([finCard, ghostCard]))}</div>, (path) =>
    noEnvelope(path, [categoryEntity]),
  );
  const cards = await screen.findAllByTestId('entity-card');
  // Обе карточки делят один запрос и один кэш — «Еда» доказывает, что список уже разрешён.
  await waitFor(() => expect(cards[0]).toHaveTextContent('Еда'));
  expect(cards[1]).toHaveTextContent('c-неизвестная');
});

// D6d п.1: холодный кэш категорий — в сетке полей на ~200 мс печатался uuid.
test('entity_card: пока категории грузятся, строки категории нет (D6d)', async () => {
  let release: (categories: unknown) => void = () => {};
  const categories = new Promise((resolve) => {
    release = resolve;
  });
  renderWithProviders(<div>{renderCards(msg([finCard]))}</div>, (path) =>
    noEnvelope(path, categories),
  );
  const card = await screen.findByTestId('entity-card');
  // Значение ещё неизвестно — строки поля нет вовсе (ни uuid, ни пустого значения).
  expect(card).not.toHaveTextContent('c1');
  expect(card).not.toHaveTextContent('категория');

  release([categoryEntity]);
  await waitFor(() => expect(card).toHaveTextContent('Еда'));
});

test('карточка без category_ref список категорий не запрашивает (D6c п.2)', async () => {
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
  expect(calls.some((c) => c.path === 'entity.query')).toBe(false);
});

test('smoothAuditText сглаживает «batch: операций — 1»', () => {
  expect(smoothAuditText('batch: операций — 1')).toBe('Операция выполнена');
  expect(smoothAuditText('batch: операций — 3')).toBe('batch: операций — 3');
});

// --- карточка import_review (§3.4, C4b) ------------------------------------------------
// Производителя на сервере ещё нет (он приезжает задачей C4c) — карточка проверяется
// от фикстурного сообщения, чтобы не остаться непроверяемым кодом.

const settingsWithViews = (views: string[]) => ({
  timezone: 'Europe/Moscow',
  defaultCurrency: 'RUB',
  weekStartDay: 1,
  installedViews: views,
  pinnedEntities: [],
});

test('import_review: «Открыть импорт» переключает на Budget и пушит экран импорта', async () => {
  renderWithProviders(<div>{renderCards(msg([{ kind: 'import_review' }]))}</div>, (path) =>
    path === 'user.getSettings' ? settingsWithViews(['orbis-budget']) : {},
  );
  expect(screen.getByTestId('import-review-card')).toHaveTextContent(/импорт выписки/i);
  await waitFor(() =>
    expect(screen.getByRole('button', { name: /открыть импорт/i })).toBeInTheDocument(),
  );

  fireEvent.click(screen.getByRole('button', { name: /открыть импорт/i }));
  expect(useNav.getState().activeTab).toBe('budget');
  expect(useNav.getState().stacks.budget.at(-1)).toEqual({ kind: 'budget-import' });
});

test('import_review без вкладки Budget: вместо кнопки — строка-объяснение', async () => {
  renderWithProviders(<div>{renderCards(msg([{ kind: 'import_review' }]))}</div>, (path) =>
    path === 'user.getSettings' ? settingsWithViews([]) : {},
  );
  await waitFor(() => expect(screen.getByTestId('import-review-card')).toBeInTheDocument());
  expect(screen.queryByRole('button', { name: /открыть импорт/i })).toBeNull();
  expect(screen.getByTestId('import-review-card')).toHaveTextContent(/бюджет/i);
});

// --- карточка memory_rule_suggestion (01-arch §7.8, D3b) --------------------------------
// Производитель — ai/escalation.ts (D3a): поля карточки скопированы ДОСЛОВНО из
// серверного union (tools/registry.ts), дискриминант — kind (K3).

const FROM_CAT = '3f0f8dbe-0f2f-4f6a-9a58-2b1b1f9f4a11';
const TO_CAT = '9c2b2f5a-1c3d-4a7e-8b2f-6d4e5a7c9b33';
// pattern намеренно «сырой» (регистр + числовой хвост): клиент обязан отправить его
// в ai.declineMemoryRule БЕЗ повторной нормализации — на сервере это ключ подавления.
const suggestion = {
  kind: 'memory_rule_suggestion',
  ruleText: 'кофе → Развлечения',
  pattern: 'Кофе Хауз 12',
  fromCategoryId: FROM_CAT,
  toCategoryId: TO_CAT,
  categoryTitle: 'Развлечения',
};

const createdEntity = {
  id: 'mem1',
  ownerId: 'u',
  title: 'кофе → Развлечения',
  emoji: null,
  body: '',
  bodyRefs: [],
  tags: [],
  meta: {},
  aspects: { 'orbis/memory': { kind: 'rule', scope: 'orbis/financial' } },
  createdAt: 'x',
  updatedAt: 'y',
  archived: false,
};

// id созданных сущностей из журнала вызовов — клиентский UUID кнопки «Запомнить».
const createIds = (calls: { path: string; input: unknown }[]): string[] =>
  calls
    .filter((c) => c.path === 'entity.create')
    .map((c) => (c.input as { input: { id: string } }).input.id);

// Время пиннится в пределах 24ч-окна фикстуры createdAt (та же идиома, что у
// confirmation): иначе карточка считалась бы устаревшей по настенным часам.
describe('memory_rule_suggestion (детерминированное время)', () => {
  beforeEach(() => vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-07-05T12:00:01.000Z')));
  afterEach(() => vi.restoreAllMocks());

  test('memory_rule_suggestion: текст правила и обе кнопки', () => {
    renderWithProviders(<div>{renderCards(msg([suggestion]))}</div>);
    expect(screen.getByTestId('memory-rule-card')).toHaveTextContent('кофе → Развлечения');
    expect(screen.getByRole('button', { name: 'Запомнить' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Не надо' })).toBeInTheDocument();
  });

  // D5c п.2: вопрос «Запомнить правило „…“?» уже задаёт content самого сообщения
  // (ai/escalation.ts) — карточка под ним печатала его второй раз. Карточка показывает
  // текст правила и кнопки; вопрос остаётся за сообщением.
  test('memory_rule_suggestion: карточка не повторяет вопрос сообщения', () => {
    renderWithProviders(<div>{renderCards(msg([suggestion]))}</div>);
    expect(screen.getByTestId('memory-rule-card')).not.toHaveTextContent(/запомнить правило/i);
  });

  test('[Запомнить] → entity.create с title=ruleText и аспектом orbis/memory (rule, financial)', async () => {
    const { calls } = renderWithProviders(<div>{renderCards(msg([suggestion]))}</div>, (path) =>
      path === 'entity.create' ? createdEntity : {},
    );
    fireEvent.click(screen.getByRole('button', { name: 'Запомнить' }));
    await waitFor(() => expect(calls.some((c) => c.path === 'entity.create')).toBe(true));
    const input = calls.find((c) => c.path === 'entity.create')?.input as {
      input: { id: string; title: string; tags: string[]; body?: string; aspects: unknown };
      source: string;
    };
    expect(input.input.title).toBe('кофе → Развлечения');
    expect(input.input.aspects).toEqual({
      'orbis/memory': { kind: 'rule', scope: 'orbis/financial' },
    });
    expect(input.input.tags).toEqual([]);
    expect(input.input.body).toBeTruthy(); // короткое пояснение, откуда правило взялось
    expect(input.source).toBe('ui');
    // Итог показан, кнопки больше не предлагают тот же запрос
    await waitFor(() =>
      expect(screen.getByTestId('memory-rule-card')).toHaveTextContent(/запомнил/i),
    );
    expect(screen.queryByRole('button', { name: 'Запомнить' })).toBeNull();
  });

  // Быстрый ввод читает правила из ТЁПЛОГО кэша (useFastPath, §2.5) — одной инвалидации
  // мало: у запроса правил нет подписчиков, сам он не перечитается. Без точечного
  // перечитывания следующий «кофе 300» ушёл бы по прежнему алиасу, хотя карточка уже
  // сказала «Запомнил — правило в „Памяти AI“».
  test('[Запомнить] перечитывает запрос memory-правил (правило работает со следующего ввода)', async () => {
    const { calls } = renderWithProviders(<div>{renderCards(msg([suggestion]))}</div>, (path) =>
      path === 'entity.create' ? createdEntity : [],
    );
    fireEvent.click(screen.getByRole('button', { name: 'Запомнить' }));
    await waitFor(() =>
      expect(
        calls.some(
          (c) =>
            c.path === 'entity.query' &&
            (c.input as { query?: string }).query === MEMORY_RULES_QUERY.query,
        ),
      ).toBe(true),
    );
  });

  test('повторный клик по [Запомнить] не создаёт вторую сущность', async () => {
    const { calls } = renderWithProviders(<div>{renderCards(msg([suggestion]))}</div>, (path) =>
      path === 'entity.create' ? createdEntity : {},
    );
    const button = screen.getByRole('button', { name: 'Запомнить' });
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() =>
      expect(screen.getByTestId('memory-rule-card')).toHaveTextContent(/запомнил/i),
    );
    fireEvent.click(button); // третий клик уже по снятой кнопке — DOM-узел отсоединён
    expect(calls.filter((c) => c.path === 'entity.create')).toHaveLength(1);
  });

  test('повтор после ошибки шлёт ТОТ ЖЕ client-UUID (урок B4: id на показ карточки)', async () => {
    let fail = true;
    const { calls } = renderWithProviders(<div>{renderCards(msg([suggestion]))}</div>, (path) => {
      if (path !== 'entity.create') return {};
      if (fail) {
        fail = false;
        throw trpcError('INTERNAL_SERVER_ERROR');
      }
      return createdEntity;
    });
    fireEvent.click(screen.getByRole('button', { name: 'Запомнить' }));
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Запомнить' }));
    await waitFor(() => expect(calls.filter((c) => c.path === 'entity.create')).toHaveLength(2));
    const ids = createIds(calls);
    expect(ids[0]).toBe(ids[1]);
  });

  // Фикс-раунд 1, находка 1: id правила ДЕТЕРМИНИРОВАН сообщением-предложением.
  // Со случайным uuidv7 новое монтирование карточки (перезагрузка вкладки, второе
  // устройство) присылало новый id, и «Запомнить» создавало ВТОРОЕ одноимённое
  // правило: onConflictDoNothing по entities.id конфликта не видел.
  test('после перезагрузки страницы [Запомнить] шлёт ТОТ ЖЕ id (второго правила не будет)', async () => {
    const handler = (path: string) => (path === 'entity.create' ? createdEntity : {});
    const first = renderWithProviders(<div>{renderCards(msg([suggestion]))}</div>, handler);
    fireEvent.click(screen.getByRole('button', { name: 'Запомнить' }));
    await waitFor(() => expect(createIds(first.calls)).toHaveLength(1));
    first.unmount(); // перезагрузка вкладки: карточка приезжает из ленты заново

    const second = renderWithProviders(<div>{renderCards(msg([suggestion]))}</div>, handler);
    fireEvent.click(screen.getByRole('button', { name: 'Запомнить' }));
    await waitFor(() => expect(createIds(second.calls)).toHaveLength(1));
    expect(createIds(second.calls)[0]).toBe(createIds(first.calls)[0]);
    second.unmount();

    // А НОВОЕ предложение (эскалация после архивации правила) — другая сущность,
    // иначе «Запомнить» реплеило бы архивную строку и правило не ожило бы.
    const third = renderWithProviders(
      <div>{renderCards(msg([suggestion], { id: 'm2' }))}</div>,
      handler,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Запомнить' }));
    await waitFor(() => expect(createIds(third.calls)).toHaveLength(1));
    expect(createIds(third.calls)[0]).not.toBe(createIds(first.calls)[0]);
  });

  test('[Не надо] → ai.declineMemoryRule с НЕИЗМЕНЁННЫМ pattern', async () => {
    const { calls } = renderWithProviders(<div>{renderCards(msg([suggestion]))}</div>, (path) =>
      path === 'ai.declineMemoryRule' ? { alreadyDeclined: false } : {},
    );
    fireEvent.click(screen.getByRole('button', { name: 'Не надо' }));
    await waitFor(() =>
      expect(calls.find((c) => c.path === 'ai.declineMemoryRule')?.input).toEqual({
        pattern: 'Кофе Хауз 12',
        fromCategoryId: FROM_CAT,
        toCategoryId: TO_CAT,
      }),
    );
    await waitFor(() =>
      expect(screen.getByTestId('memory-rule-card')).toHaveTextContent(/не буду предлагать/i),
    );
    expect(screen.queryByRole('button', { name: 'Не надо' })).toBeNull();
  });
});

// Фикс-раунд 1, находка 2: «решённость» карточки живёт в локальном state, поэтому
// давно отвеченное предложение после перезагрузки выглядит неотвеченным. Тот же
// 24ч visual-expiry, что у ConfirmationCard, гасит кнопки старой карточки.
describe('memory_rule_suggestion: visual-expiry 24ч', () => {
  beforeEach(() => vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-07-07T13:00:00.000Z')));
  afterEach(() => vi.restoreAllMocks());

  test('старше 24ч → обе кнопки задизейблены, подпись «устарело»', () => {
    renderWithProviders(<div>{renderCards(msg([suggestion]))}</div>);
    expect(screen.getByRole('button', { name: 'Запомнить' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Не надо' })).toBeDisabled();
    expect(screen.getByText(/устарело/i)).toBeInTheDocument();
  });
});

test('неизвестный kind по-прежнему не роняет ленту', () => {
  renderWithProviders(
    <div>
      {renderCards(
        msg([
          { kind: 'card_from_the_future', payload: 42 },
          { kind: 'error_card', code: 'X', message: 'соседняя карточка жива' },
        ]),
      )}
    </div>,
  );
  expect(screen.getByRole('alert')).toHaveTextContent('соседняя карточка жива');
});

// --- карточка предложения рутины (V1.6, V1.9) -------------------------------------------
//
// Карточка живёт в ленте ТРЕДА РУТИНЫ и на экране самого прогона — одна и та же (RunFeed
// рисует её тем же компонентом). Поэтому здесь она проверяется в своём чат-виде: через
// renderCards, ровно как её увидит владелец, открывший рутину утром.

const PROPOSAL_CARD = {
  kind: 'proposal_card',
  pendingId: 'p1',
  runId: 'rr1',
  routineId: 'rt1',
  // Пересказ модели у карточки есть — и экран его НЕ показывает: владелец принимает список
  // правок, а не «2 правки» (V1.14).
  summary: '2 правки',
  explanation: 'Два дела просрочены — предлагаю перенести срок на сегодня.',
};

/**
 * Операции — в форме `ProposalView.operations` (routers/routine.ts). Вторая строка нарочно с
 * `before: 'absent'`: литерал значит «поля не было», и напечатать его сырым словом значило бы
 * показать владельцу выдуманное текущее значение.
 */
const PROPOSAL_OPERATIONS = [
  {
    index: 0,
    tool: 'entity_update',
    entity: { id: 'e1', title: 'Купить билеты' },
    aspect: 'orbis/task',
    field: 'due_date',
    before: '2026-08-10',
    after: '2026-08-19',
    summary: '«Купить билеты»: orbis/task.due_date',
  },
  {
    index: 1,
    tool: 'entity_update',
    entity: { id: 'e2', title: 'Позвонить врачу' },
    aspect: 'orbis/task',
    field: 'status',
    before: 'absent',
    after: 'inbox',
    summary: '«Позвонить врачу»: orbis/task.status',
  },
];

const proposalHandler =
  (over: Record<string, unknown> = {}): MockHandler =>
  (path, input) => {
    if (path === 'routine.proposal')
      return {
        pendingId: 'p1',
        runId: 'rr1',
        routineId: 'rt1',
        status: 'pending',
        explanation: PROPOSAL_CARD.explanation,
        operations: PROPOSAL_OPERATIONS,
        ...over,
      };
    // Заголовок цели дочитывает сам EntityRef (в предложении едет и id, и title — но на
    // экране правды больше у ЖИВОЙ записи: заголовок мог измениться после ночного прогона).
    if (path === 'routine.decideProposal') return { status: 'rejected' };
    if (path === 'entity.get') {
      const { id } = input as { id: string };
      const op = PROPOSAL_OPERATIONS.find((o) => o.entity.id === id);
      return { entity: { id, title: op?.entity.title ?? `T-${id}` } };
    }
    return {};
  };

test('proposal_card: список операций с русскими подписями полей, объяснение прозой и обе кнопки при pending', async () => {
  renderWithProviders(<div>{renderCards(msg([PROPOSAL_CARD]))}</div>, proposalHandler());
  const card = await screen.findByTestId('proposal-card');

  // Цель — ЗАГОЛОВКОМ (EntityRef), а не uuid: по нему владелец решает, принимать ли правку.
  expect(await within(card).findByText('Купить билеты')).toBeInTheDocument();
  expect(await within(card).findByText('Позвонить врачу')).toBeInTheDocument();
  // Объяснение — то, ради чего карточку читают: что рутина увидела и почему предлагает это.
  expect(card).toHaveTextContent('Два дела просрочены');
  // Подписи полей — по-русски (fieldLabel), а не сырыми ключами схемы.
  expect(card).toHaveTextContent('срок');
  expect(card).toHaveTextContent('2026-08-10');
  expect(card).toHaveTextContent('2026-08-19');
  expect(card).toHaveTextContent('статус');
  // `before: 'absent'` — «поля не было», а не значение «absent».
  expect(card).toHaveTextContent('(не было)');
  expect(card).not.toHaveTextContent('absent');
  // Пересказ («2 правки») список НЕ заменяет.
  expect(card).not.toHaveTextContent('2 правки');

  expect(within(card).getByRole('button', { name: 'Принять' })).toBeInTheDocument();
  expect(within(card).getByRole('button', { name: 'Отклонить' })).toBeInTheDocument();
});

test('proposal_card: решённое предложение показывает статус С СЕРВЕРА и кнопок не даёт', async () => {
  // Клиентского срока годности (EXPIRY_MS у ConfirmationCard) здесь нет вовсе: судьбу
  // предложения решает сервер (Р-17), и «устарело» на карточке — его слово, а не часы вкладки.
  const approved = renderWithProviders(
    <div>{renderCards(msg([PROPOSAL_CARD]))}</div>,
    proposalHandler({ status: 'approved', decidedAt: '2026-08-18T05:00:00.000Z' }),
  );
  let card = await screen.findByTestId('proposal-card');
  expect(await within(card).findByText(/Принято/)).toBeInTheDocument();
  expect(within(card).queryByRole('button', { name: 'Принять' })).toBeNull();
  expect(within(card).queryByRole('button', { name: 'Отклонить' })).toBeNull();
  // Операции остаются видны и после решения: карточка — след того, что владелец принял.
  expect(card).toHaveTextContent('срок');
  approved.unmount();

  const superseded = renderWithProviders(
    <div>{renderCards(msg([PROPOSAL_CARD]))}</div>,
    proposalHandler({ status: 'superseded', decidedAt: '2026-08-19T04:00:00.000Z' }),
  );
  card = await screen.findByTestId('proposal-card');
  expect(await within(card).findByText('Заменено новым прогоном')).toBeInTheDocument();
  expect(within(card).queryByRole('button', { name: 'Принять' })).toBeNull();
  superseded.unmount();

  // Принято, а прогон убран в архив — след ОТКАТА (приёмка 11): план уже снят, и карточка
  // говорит это словами, а не «Принято» как о действующем.
  const rolledBack = renderWithProviders(
    <div>{renderCards(msg([PROPOSAL_CARD]))}</div>,
    proposalHandler({
      status: 'approved',
      decidedAt: '2026-08-18T05:00:00.000Z',
      runArchived: true,
    }),
  );
  card = await screen.findByTestId('proposal-card');
  expect(await within(card).findByText(/Принято, затем откачено/)).toBeInTheDocument();
  expect(within(card).queryByRole('button', { name: 'Принять' })).toBeNull();
  rolledBack.unmount();
});

test('маркер ленты: действие с source=routine помечено «рутина», а не «агент» (Р-16)', () => {
  // Правку рутины приносит то же audit-сообщение, что и работу внешнего исполнителя, но
  // actor_kind у неё 'ai' — по нему рутина неотличима от чат-агента. Различает их ИСТОЧНИК:
  // владелец должен видеть, что это сделала его рутина ночью, а не он сам в разговоре.
  const card = { kind: 'entity_card', entityId: 'e', title: 'T', aspects: [], keyFields: {} };
  renderWithProviders(
    <div>
      {renderCards(
        msg([card], {
          metadata: { cards: [card], actions: [{ actor_kind: 'ai', source: 'routine' }] },
        }),
      )}
    </div>,
  );
  expect(screen.getByTestId('system-message')).toHaveTextContent('рутина');
  expect(screen.queryByText('агент')).toBeNull();
});

test('proposal_card: «Отклонить» перечитывает и карточку, и ГРАФ (отказ тоже пишет в аспект прогона)', async () => {
  // Отказ не трогает цели предложения — но пишет судьбу самого предложения в аспект прогона
  // (`proposal.status`, `decided_at`). Это запись графа, и без инвалидации история прогонов на
  // экране рутины держала бы «ждёт решения» ещё 30 секунд (staleTime), то есть показывала бы
  // владельцу отменённое им же ожидание.
  const { calls } = renderWithProviders(
    <div>{renderCards(msg([PROPOSAL_CARD]))}</div>,
    proposalHandler(),
  );
  const card = await screen.findByTestId('proposal-card');
  await within(card).findByText('Купить билеты');
  const readsBefore = calls.filter((c) => c.path === 'entity.get').length;

  fireEvent.click(within(card).getByRole('button', { name: 'Отклонить' }));
  await waitFor(() =>
    expect(calls.find((c) => c.path === 'routine.decideProposal')?.input).toEqual({
      runId: 'rr1',
      decision: 'reject',
    }),
  );
  // Статус карточки — с сервера: локальное «отклонено» соврало бы, реши предложение кто-то
  // другой между чтением и нажатием (`already`).
  await waitFor(() =>
    expect(calls.filter((c) => c.path === 'routine.proposal').length).toBeGreaterThan(1),
  );
  await waitFor(() =>
    expect(calls.filter((c) => c.path === 'entity.get').length).toBeGreaterThan(readsBefore),
  );
});

test('proposal_card: у статуса stale расхождения показаны нотами, а слово «Устарело» — один раз', async () => {
  // Ноту пишет сервер в аспект прогона (`mismatches[].note`) — она переживает и карточку, и
  // сырые значения, и читается на экране прогона спустя дни.
  renderWithProviders(
    <div>{renderCards(msg([PROPOSAL_CARD]))}</div>,
    proposalHandler({
      status: 'stale',
      decidedAt: '2026-08-19T04:00:00.000Z',
      mismatches: [
        { aspect: 'orbis/task', field: 'status', note: 'ожидали «inbox», сейчас «done»' },
      ],
    }),
  );
  const card = await screen.findByTestId('proposal-card');
  const stale = await within(card).findByTestId('proposal-stale');
  expect(stale).toHaveTextContent('состояние изменилось');
  expect(stale).toHaveTextContent('статус');
  expect(stale).toHaveTextContent('ожидали «inbox», сейчас «done»');
  // Два «Устарело» подряд читались бы как два разных сообщения об одном и том же.
  expect(within(card).getAllByText(/Устарело/)).toHaveLength(1);
  expect(within(card).queryByRole('button', { name: 'Принять' })).toBeNull();
});
