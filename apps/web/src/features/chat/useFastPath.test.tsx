import {
  aspectJsonSchema,
  BUILTIN_ASPECT_IDS,
  buildFieldCatalog,
  parseQuery,
  retryCreateId,
} from '@orbis/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { getQueryKey } from '@trpc/react-query';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { useRetryBuffer } from '../../state/retry';
import { mockLink, trpcError } from '../../test/harness';
import { trpc } from '../../trpc';
import { type ChatMessage, chatThreadKey } from './useChatThread';
import { useFastPath } from './useFastPath';

const CATEGORY_QUERY = { query: 'aspect=orbis/category' };
const RULES_QUERY = { query: 'aspect=orbis/memory, kind=rule, scope=orbis/financial' };

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
  {
    id: 'cat-food',
    title: 'Еда',
    aspectsMap: { 'orbis/category': { aliases: ['обед', 'еда', 'кофе'], spend_class: 'variable' } },
  },
  {
    id: 'cat-fun',
    title: 'Развлечения',
    aspectsMap: { 'orbis/category': { aliases: ['развлечения'], spend_class: 'variable' } },
  },
];
// Memory-правила владельца (§7.5): заголовок — вся машиночитаемая часть правила (D3a),
// updatedAt приезжает в wire-форме сущности и разрешает конфликт правил (applyMemoryRules).
const rules = [
  {
    id: 'rule-1',
    title: 'кофе → Развлечения',
    updatedAt: '2026-07-20T10:00:00.000Z',
    aspectsMap: { 'orbis/memory': { kind: 'rule', scope: 'orbis/financial' } },
  },
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

test('уверенный паттерн онлайн → entity.create(source:fast_path)', async () => {
  const { Wrap, calls } = wrapper((path, input) => {
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
});

// Запрос правил обязан быть валиден в грамматике §6.1 (kind/scope резолвятся из схемы
// аспекта orbis/memory): опечатка здесь оставила бы быстрый ввод на одних алиасах, а
// отказ запроса ещё и проглатывается — фича приехала бы мёртвой молча.
test('запрос memory-правил разбирается грамматикой §6.1', () => {
  const catalog = buildFieldCatalog(
    BUILTIN_ASPECT_IDS.map((id) => ({ id, schema: aspectJsonSchema(id) })),
  );
  expect(parseQuery(RULES_QUERY.query, catalog).ok).toBe(true);
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
  // Запрос правил ушёл ровно в форме aspect=orbis/memory, kind=rule, scope=orbis/financial.
  expect(
    calls.some(
      (c) =>
        c.path === 'entity.query' && (c.input as { query: string }).query === RULES_QUERY.query,
    ),
  ).toBe(true);
  await waitFor(() => {
    const created = calls.find((x) => x.path === 'entity.create')?.input as {
      input: { aspects: Record<string, { category_ref?: string }> };
    };
    expect(created.input.aspects['orbis/financial']?.category_ref).toBe('cat-fun');
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
    input: { aspects: Record<string, { category_ref?: string }> };
  };
  expect(created.input.aspects['orbis/financial']?.category_ref).toBe('cat-fun');
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
