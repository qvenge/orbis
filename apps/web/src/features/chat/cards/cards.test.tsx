import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { useNav } from '../../../state/navigation';
import { renderWithProviders, trpcError } from '../../../test/harness';
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
const noEnvelope = (path: string, categories: unknown[]) => {
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

test('entity_card: категории нет в списке → uuid как запасной вариант (D6c п.2)', async () => {
  renderWithProviders(<div>{renderCards(msg([finCard]))}</div>, (path) =>
    noEnvelope(path, [{ ...categoryEntity, id: 'другая' }]),
  );
  const card = await screen.findByTestId('entity-card');
  await waitFor(() => expect(card).toHaveTextContent('c1'));
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
