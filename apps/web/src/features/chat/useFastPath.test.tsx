import { retryCreateId } from '@orbis/shared';
import { parseQueryAst } from '@orbis/shared/query';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { getQueryKey } from '@trpc/react-query';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { buildQueryRegistry } from '../../lib/query-blocks/catalog';
import { useRetryBuffer } from '../../state/retry';
import { mockLink, trpcError, wireEntity } from '../../test/harness';
import { BUILTIN_REGISTRY } from '../../test/registry';
import { trpc } from '../../trpc';
import { type ChatMessage, chatThreadKey } from './useChatThread';
import { useFastPath } from './useFastPath';

const CATEGORY_QUERY = { query: 'aspect=orbis/category' };
// Литерал СВОЙ, а не импорт из `memoryRules.ts`: съедь обе стороны вместе — и подмена
// запроса перестала бы наблюдаться тестом вовсе.
const RULES_QUERY = { query: 'aspect=orbis/memory, orbis/memory_kind=rule' };

function threadMsgs(qc: QueryClient): ChatMessage[] {
  const data = qc.getQueryData(chatThreadKey('t1')) as { pages: ChatMessage[][] } | undefined;
  return (data?.pages ?? []).flat();
}
function hasErrorCard(m: ChatMessage): boolean {
  const cards = (m.metadata as { cards?: { kind: string }[] })?.cards ?? [];
  return cards.some((c) => c.kind === 'error_card');
}

function wrapper(handler: (path: string, input: unknown) => unknown) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const calls: { path: string; input: unknown }[] = [];
  const client = trpc.createClient({
    links: [
      mockLink((p, i) => {
        calls.push({ path: p, input: i });
        return handler(p, i);
      }),
    ],
  });
  const Wrap = ({ children }: { children: ReactNode }) => (
    <trpc.Provider client={client} queryClient={qc}>
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    </trpc.Provider>
  );
  return { Wrap, calls, qc };
}

const settings = { defaultCurrency: 'RUB' };
const categories = [
  wireEntity({
    id: 'cat-food',
    title: 'Еда',
    props: { 'orbis/aliases': ['обед', 'еда', 'кофе'], 'orbis/spend_class': 'variable' },
    aspects: ['orbis/category'],
  }),
  wireEntity({
    id: 'cat-fun',
    title: 'Развлечения',
    props: { 'orbis/aliases': ['развлечения'], 'orbis/spend_class': 'variable' },
    aspects: ['orbis/category'],
  }),
];
// Memory-правила владельца (§7.5) в форме СВОЙСТВ (В7): образец и id категории; заголовок
// — генерируемая подпись, и парсера у него больше нет. updatedAt приезжает в wire-форме
// сущности и разрешает конфликт правил (applyMemoryRules).
const rules = [
  wireEntity({
    id: 'rule-1',
    title: 'кофе → Развлечения',
    updatedAt: '2026-07-20T10:00:00.000Z',
    props: {
      'orbis/memory_kind': 'rule',
      'orbis/rule_scope': 'orbis/money-movement',
      'orbis/rule_pattern': 'кофе',
      'orbis/rule_target': 'cat-fun',
    },
    aspects: ['orbis/memory'],
  }),
  // Правило ЧУЖОЙ области приезжает в выдачу (запрос области не фильтрует — грамматика
  // дизъюнкцию не выражает) и обязано быть отсеяно клиентом: иначе быстрый ввод стал бы
  // применять правила, которых сервер в своей области не видит.
  wireEntity({
    id: 'rule-2',
    title: 'кофе → Еда',
    updatedAt: '2026-07-21T10:00:00.000Z',
    props: {
      'orbis/memory_kind': 'rule',
      'orbis/rule_scope': 'orbis/progress',
      'orbis/rule_pattern': 'кофе',
      'orbis/rule_target': 'cat-food',
    },
    aspects: ['orbis/memory'],
  }),
];

const assistantReply = {
  assistantMessage: {
    id: 'r',
    threadId: 't1',
    role: 'assistant',
    content: 'ok',
    metadata: {},
    createdAt: 'x',
  },
  actions: [],
  pending: [],
  replayed: false,
};

function handlerBase(path: string, input?: unknown) {
  if (path === 'user.getSettings') return settings;
  // entity.query обслуживает ДВА запроса fast-path (категории и memory-правила) —
  // ветвление по строке запроса, иначе правила приедут списком категорий.
  if (path === 'entity.query') {
    return (input as { query?: string } | undefined)?.query === RULES_QUERY.query
      ? rules
      : categories;
  }
  if (path === 'chat.listMessages') return [];
  return {};
}

beforeEach(() => {
  localStorage.clear();
  // Сброс снапшота retry-буфера (singleton): localStorage.clear() не трогает zustand-стейт.
  useRetryBuffer.setState({ size: 0, pending: [] });
});
afterEach(() => {
  Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
});

test('уверенный паттерн онлайн → entity.create(source:fast_path) и карточка со списком аспектов', async () => {
  const { Wrap, calls, qc } = wrapper((path, input) => {
    if (path === 'entity.create') return { id: 'e1', title: 'обед' };
    return handlerBase(path, input);
  });
  const { result } = renderHook(() => useFastPath('t1'), { wrapper: Wrap });
  await act(async () => {
    await result.current.submit('обед 340');
  });
  await waitFor(() => {
    const c = calls.find((x) => x.path === 'entity.create');
    expect(c?.input).toMatchObject({ source: 'fast_path' });
  });

  /**
   * АСПЕКТ В СИНТЕТИЧЕСКОЙ КАРТОЧКЕ — не украшение метаданных: по `card.aspects` карточка
   * решает, показывать ли строку «осталось N ₽» (`EntityCard`, `isFinancial` → `wantRemaining`).
   * Потеря списка наблюдаема ТИШИНОЙ: карточка рисуется, запись создаётся, остатка нет.
   * Мутационная проба ре-ревью показала, что до этой проверки сьют web был к ней слеп
   * целиком (фикс-раунд 2, F7).
   *
   * САМ payload создания (`create.aspects`) пиннится в `@orbis/shared`
   * (`fast-path/fast-path.test.ts`) — там его и строит `parseFastPath`; здесь проверяется
   * ровно то, что кладёт этот хук.
   */
  const card = (threadMsgs(qc)[0]?.metadata as { cards?: { aspects?: string[] }[] })?.cards?.[0];
  expect(card?.aspects).toEqual(['orbis/financial']);
});

// Запрос правил обязан разбираться НОВОЙ грамматикой §А5-3 (имена свойств — namespaced key
// реестра): опечатка здесь оставила бы быстрый ввод на одних алиасах, а отказ запроса ещё и
// проглатывается — фича приехала бы мёртвой молча. Разбор строгий — другого и нет, мост
// старой формы снят Задачей 21b; пока он был жив, он принял бы и непереведённый `kind=rule`,
// и тест зеленел бы при невыполненной работе.
test('запрос memory-правил разбирается каноном §А5-3', () => {
  const registry = buildQueryRegistry(BUILTIN_REGISTRY).parse;
  expect(parseQueryAst(RULES_QUERY.query, registry).ok).toBe(true);
});

// 01-arch §7.5: memory-правила применяются и в детерминированном пути. Правило
// «кофе → Развлечения» обязано перекрыть alias «кофе» категории Еда — иначе исправление,
// которое пользователь подтвердил в чате, при быстром вводе не работает.
test('memory-правила грузятся в ctx парсера и перекрывают alias (§7.5)', async () => {
  const { Wrap, calls } = wrapper((path, input) => {
    if (path === 'entity.create') return { id: 'e1', title: 'кофе' };
    return handlerBase(path, input);
  });
  const { result } = renderHook(() => useFastPath('t1'), { wrapper: Wrap });
  await act(async () => {
    await result.current.submit('кофе 300');
  });
  // Запрос правил ушёл ровно в key-форме реестра (см. RULES_QUERY выше).
  expect(
    calls.some(
      (c) =>
        c.path === 'entity.query' && (c.input as { query: string }).query === RULES_QUERY.query,
    ),
  ).toBe(true);
  await waitFor(() => {
    const created = calls.find((x) => x.path === 'entity.create')?.input as {
      input: { props: Record<string, unknown> };
    };
    // Новая форма создания (§А9-1): категория — свойство по id, а не поле аспекта.
    // 'cat-fun' — цель правила СВОЕЙ области: правило чужой области (rule-2, свежее и с
    // тем же образцом) отсеяно клиентом, иначе победило бы оно и дало бы 'cat-food'.
    expect(created.input.props['orbis/finance_category']).toBe('cat-fun');
  });
});

// §2.5: карточка «⚡ без AI» — мгновенная, на тёплом кэше submit не имеет права ждать сеть.
// Кэш правил инвалидируется КАЖДЫМ успешным fast-path create (utils.entity.query.invalidate),
// а fetchQuery на инвалидированной query перечитывает независимо от staleTime: блокирующая
// загрузка правил ставила бы полный round-trip перед вторым и каждым следующим вводом, а
// зависший запрос съедал бы ввод целиком — Composer текст уже стёр, ни карточки, ни create.
test('тёплый кэш правил: зависший запрос правил не задерживает карточку и create (§2.5)', async () => {
  const { Wrap, calls, qc } = wrapper((path, input) => {
    if (path === 'entity.create') return { id: 'e1', title: 'кофе' };
    if (path === 'entity.query' && (input as { query?: string }).query === RULES_QUERY.query) {
      return new Promise(() => {}); // запрос правил ВИСИТ (флаки-сеть; retry у клиента выключен)
    }
    return handlerBase(path, input);
  });
  qc.setQueryData(getQueryKey(trpc.entity.query, CATEGORY_QUERY, 'query'), categories);
  qc.setQueryData(getQueryKey(trpc.entity.query, RULES_QUERY, 'query'), rules);
  qc.setQueryData(getQueryKey(trpc.user.getSettings, undefined, 'query'), settings);
  // Ровно то состояние кэша, в котором его оставляет предыдущий успешный create.
  await qc.invalidateQueries();

  const { result } = renderHook(() => useFastPath('t1'), { wrapper: Wrap });
  await act(async () => {
    const submitted = result.current.submit('кофе 300').then(() => 'submitted' as const);
    const outcome = await Promise.race([
      submitted,
      new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 300)),
    ]);
    expect(outcome).toBe('submitted');
  });
  // Карточка на экране, и правило из тёплого кэша применено (Развлечения, а не Еда по alias).
  expect(threadMsgs(qc).length).toBe(1);
  const created = calls.find((c) => c.path === 'entity.create')?.input as {
    input: { props: Record<string, unknown> };
  };
  expect(created.input.props['orbis/finance_category']).toBe('cat-fun');
});

// 03-budget §4.1 (B7): остаток конверта на карточке — ПОСЛЕ записи; успешный create
// инвалидирует budget-кэш, и envelopeForCategory перечитывается с учётом транзакции.
test('успешный fast-path create инвалидирует budget-кэш (остаток после записи, §4.1)', async () => {
  const { Wrap, qc } = wrapper((path, input) => {
    if (path === 'entity.create') return { id: 'e1', title: 'обед' };
    return handlerBase(path, input);
  });
  const envInput = { categoryId: 'cat-food', date: '2026-07-13' };
  const envKey = getQueryKey(trpc.budget.envelopeForCategory, envInput, 'query');
  qc.setQueryData(envKey, null); // тёплый кэш «до записи»
  const { result } = renderHook(() => useFastPath('t1'), { wrapper: Wrap });
  await act(async () => {
    await result.current.submit('обед 340');
  });
  await waitFor(() => expect(qc.getQueryState(envKey)?.isInvalidated).toBe(true));
});

// Ревью B7 (Minor 1) + уборочная фаза (решение 7): CONFLICT — НЕ успех, а «id занят
// чужой строкой» (своя дала бы replay-успех сервера), поэтому запись уходит повторно
// со свежим id. Budget-кэш обязан инвалидироваться и в этой ветке — после успешного
// повтора запись на сервере есть, и остаток §4.1 с бейджем §6.1 стухли.
test('CONFLICT → повтор со свежим id, и budget-кэш инвалидирован', async () => {
  let attempt = 0;
  const { Wrap, qc } = wrapper((path, input) => {
    if (path === 'entity.create') {
      attempt += 1;
      if (attempt === 1) throw trpcError('CONFLICT');
      return { id: 'e-new', title: 'обед' };
    }
    return handlerBase(path, input);
  });
  const envKey = getQueryKey(
    trpc.budget.envelopeForCategory,
    { categoryId: 'cat-food', date: '2026-07-13' },
    'query',
  );
  qc.setQueryData(envKey, null); // тёплый кэш «до записи»
  const { result } = renderHook(() => useFastPath('t1'), { wrapper: Wrap });
  await act(async () => {
    await result.current.submit('обед 340');
  });
  await waitFor(() => expect(qc.getQueryState(envKey)?.isInvalidated).toBe(true));
});

test('неуверенный паттерн → LLM-путь (ai.sendMessage), без entity.create', async () => {
  const { Wrap, calls } = wrapper((path, input) => {
    if (path === 'ai.sendMessage') return assistantReply;
    return handlerBase(path, input);
  });
  const { result } = renderHook(() => useFastPath('t1'), { wrapper: Wrap });
  await act(async () => {
    await result.current.submit('квакозябра 500');
  });
  await waitFor(() => expect(calls.some((c) => c.path === 'ai.sendMessage')).toBe(true));
  expect(calls.some((c) => c.path === 'entity.create')).toBe(false);
});

test('офлайн (тёплый кэш) + уверенный → retry-буфер + «⏳», сеть не тронута', async () => {
  Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
  const { Wrap, calls, qc } = wrapper(handlerBase);
  // Прогрев кэша (как будто категории/валюта уже загружались онлайн ранее).
  qc.setQueryData(getQueryKey(trpc.entity.query, CATEGORY_QUERY, 'query'), categories);
  qc.setQueryData(getQueryKey(trpc.user.getSettings, undefined, 'query'), settings);
  const { result } = renderHook(() => useFastPath('t1'), { wrapper: Wrap });
  await act(async () => {
    await result.current.submit('обед 340');
  });
  expect(useRetryBuffer.getState().size).toBe(1);
  // Офлайн-ветка не должна ходить в сеть вообще (ни fetch категорий, ни entity.create).
  expect(calls.length).toBe(0);
});

test('настоящий офлайн (холодный кэш) → submit НЕ виснет и НЕ зовёт сеть (§2.6)', async () => {
  Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
  const { Wrap, calls } = wrapper(handlerBase);
  const { result } = renderHook(() => useFastPath('t1'), { wrapper: Wrap });
  // Промис submit должен зарезолвиться (нет hang'а на замороженном fetch).
  await act(async () => {
    await result.current.submit('обед 340');
  });
  expect(calls.length).toBe(0); // getData() без fetch → сеть не тронута
  expect(calls.some((c) => c.path === 'entity.query')).toBe(false);
  expect(useRetryBuffer.getState().size).toBe(0); // холодный кэш → unknown_category → системная заметка
});

// §5.3: бизнес-отказ показывается пользователю и НЕ попадает в буфер (иначе flush
// молча вычистит его как business_rejection — ввод исчезнет без следа).
test('онлайн-create отклонён по бизнес-правилу → error_card, буфер пуст', async () => {
  const { Wrap, qc } = wrapper((path, input) => {
    if (path === 'entity.create') throw trpcError('BAD_REQUEST');
    return handlerBase(path, input);
  });
  const { result } = renderHook(() => useFastPath('t1'), { wrapper: Wrap });
  await act(async () => {
    await result.current.submit('обед 340');
  });
  await waitFor(() => expect(threadMsgs(qc).some(hasErrorCard)).toBe(true));
  expect(useRetryBuffer.getState().size).toBe(0);
});

// 02 §2.5: до подтверждения сервером карточка — «⏳ ждёт отправки», без entityId,
// иначе «Разобрать с AI» архивирует несуществующий id, а буфер создаст вторую сущность.
test('онлайн-create упал транспортно → карточка деградирует в pending, id сохранён в буфере', async () => {
  const { Wrap, qc } = wrapper((path, input) => {
    if (path === 'entity.create') throw new Error('network down');
    return handlerBase(path, input);
  });
  const { result } = renderHook(() => useFastPath('t1'), { wrapper: Wrap });
  await act(async () => {
    await result.current.submit('обед 340');
  });
  await waitFor(() => {
    const msgs = threadMsgs(qc);
    const meta = msgs[0]?.metadata as { fastPath?: { status: string; entityId?: string } };
    expect(meta.fastPath?.status).toBe('pending');
    expect(meta.fastPath?.entityId).toBeUndefined();
    // Ровно одна карточка: pending переписал «⚡ без AI», а не добавился рядом.
    expect(msgs.length).toBe(1);
  });
  const pending = useRetryBuffer.getState().pending;
  expect(pending.length).toBe(1);
  // clientId очереди = id, который уже уходил на сервер (иначе ретрай создаст дубль).
  const input = (pending[0]?.payload as { input: { id: string } }).input;
  expect(pending[0]?.clientId).toBe(input.id);
});

test('CONFLICT → повтор с замещающим id, и КАРТОЧКА указывает на него, а не на чужой', async () => {
  const ids: string[] = [];
  const { Wrap, qc } = wrapper((path, input) => {
    if (path === 'entity.create') {
      const id = (input as { input: { id: string } }).input.id;
      ids.push(id);
      if (ids.length === 1) throw trpcError('CONFLICT');
      return { id, title: 'обед' };
    }
    return handlerBase(path, input);
  });
  const { result } = renderHook(() => useFastPath('t1'), { wrapper: Wrap });
  await act(async () => {
    await result.current.submit('обед 340');
  });
  expect(ids).toHaveLength(2);
  // Замещающий id детерминирован по исходному: повтор сходится, а не плодит третий id
  expect(ids[1]).toBe(retryCreateId(ids[0] as string));
  expect(threadMsgs(qc).some(hasErrorCard)).toBe(false);
  expect(useRetryBuffer.getState().size).toBe(0);
  // Наблюдаемый итог: карточка ведёт на СОЗДАННУЮ сущность. Иначе «Разобрать с AI»
  // архивировал бы чужую строку (NOT_FOUND), а модель создала бы вторую сущность.
  const msgs = threadMsgs(qc);
  const meta = msgs[0]?.metadata as { fastPath?: { status: string; entityId?: string } };
  expect(meta.fastPath?.entityId).toBe(ids[1]);
  expect(meta.fastPath?.status).toBe('confirmed');
  expect(msgs.length).toBe(1); // карточка переписана на месте, а не добавлена рядом
});

// Второй CONFLICT подряд — ввод не теряется: карточка деградирует в «⏳ ждёт отправки»,
// операция уходит в буфер (тем же путём, что транспортный сбой).
test('CONFLICT дважды подряд → карточка ждёт отправки, в буфере ТОТ ЖЕ замещающий id', async () => {
  const ids: string[] = [];
  const { Wrap, qc } = wrapper((path, input) => {
    if (path === 'entity.create') {
      ids.push((input as { input: { id: string } }).input.id);
      throw trpcError('CONFLICT');
    }
    return handlerBase(path, input);
  });
  const { result } = renderHook(() => useFastPath('t1'), { wrapper: Wrap });
  await act(async () => {
    await result.current.submit('обед 340');
  });
  expect(threadMsgs(qc).some(hasErrorCard)).toBe(false);
  expect(useRetryBuffer.getState().size).toBe(1);
  // В буфер ушёл id повтора, а не третий свежий: иначе flush создал бы вторую сущность
  const pending = useRetryBuffer.getState().pending;
  const queuedId = (pending[0]?.payload as { input: { id: string } }).input.id;
  expect(queuedId).toBe(ids[1]);
  expect(queuedId).toBe(retryCreateId(ids[0] as string));
});

test('«разобрать с AI» → archived:true + ai.sendMessage исходной строки (одна строка ≠ две сущности)', async () => {
  const { Wrap, calls } = wrapper((path, input) => {
    if (path === 'entity.update') return { id: 'e1', title: 'обед' };
    if (path === 'ai.sendMessage') return assistantReply;
    return handlerBase(path, input);
  });
  const { result } = renderHook(() => useFastPath('t1'), { wrapper: Wrap });
  await act(async () => {
    await result.current.reparse('e1', 'обед 340');
  });
  await waitFor(() => {
    expect(calls.find((c) => c.path === 'entity.update')?.input).toMatchObject({
      id: 'e1',
      archived: true,
    });
    expect(calls.some((c) => c.path === 'ai.sendMessage')).toBe(true);
  });
});

test('§3: ошибка ai.sendMessage → текст не теряется (error_card + retryId/retryText в треде)', async () => {
  const { Wrap, qc } = wrapper((path, input) => {
    if (path === 'ai.sendMessage') throw trpcError('LLM_UNAVAILABLE');
    return handlerBase(path, input);
  });
  const { result } = renderHook(() => useFastPath('t1'), { wrapper: Wrap });
  await act(async () => {
    await result.current.submit('квакозябра 500');
  });
  await waitFor(() => {
    const errMsg = threadMsgs(qc).find(hasErrorCard);
    expect(errMsg).toBeTruthy();
    const meta = errMsg?.metadata as { retryText?: string; retryId?: string };
    expect(meta.retryText).toBe('квакозябра 500');
    expect(typeof meta.retryId).toBe('string');
  });
});

test('«Повторить» после ошибки → ровно один user-пузырь и нет error_card (dedup по id)', async () => {
  let aiCalls = 0;
  const { Wrap, qc } = wrapper((path, input) => {
    if (path === 'ai.sendMessage') {
      aiCalls += 1;
      if (aiCalls === 1) throw trpcError('LLM_UNAVAILABLE'); // первая попытка падает
      return assistantReply; // повтор проходит
    }
    return handlerBase(path, input);
  });
  const { result } = renderHook(() => useFastPath('t1'), { wrapper: Wrap });
  await act(async () => {
    await result.current.submit('квакозябра 500');
  });

  // Провал: оптимистичный user-пузырь + error_card с retryId/retryText.
  let errMsg: ChatMessage | undefined;
  await waitFor(() => {
    errMsg = threadMsgs(qc).find(hasErrorCard);
    expect(errMsg).toBeTruthy();
  });
  const meta = errMsg?.metadata as { retryId: string; retryText: string };

  // Клик «Повторить»: тот же id → dedup, error_card снимается.
  await act(async () => {
    result.current.retry({
      errorMessageId: errMsg?.id as string,
      id: meta.retryId,
      content: meta.retryText,
    });
  });

  await waitFor(() => {
    const msgs = threadMsgs(qc);
    expect(msgs.filter((m) => m.role === 'user').length).toBe(1); // без второго пузыря
    expect(msgs.some(hasErrorCard)).toBe(false); // устаревший error_card снят
  });
});
