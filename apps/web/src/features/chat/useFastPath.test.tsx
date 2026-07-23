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
    aspects: { 'orbis/category': { aliases: ['обед', 'еда'], spend_class: 'variable' } },
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

function handlerBase(path: string) {
  if (path === 'user.getSettings') return settings;
  if (path === 'entity.query') return categories; // aspect=orbis/category
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
  const { Wrap, calls } = wrapper((path) => {
    if (path === 'entity.create') return { id: 'e1', title: 'обед' };
    return handlerBase(path);
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

// 03-budget §4.1 (B7): остаток конверта на карточке — ПОСЛЕ записи; успешный create
// инвалидирует budget-кэш, и envelopeForCategory перечитывается с учётом транзакции.
test('успешный fast-path create инвалидирует budget-кэш (остаток после записи, §4.1)', async () => {
  const { Wrap, qc } = wrapper((path) => {
    if (path === 'entity.create') return { id: 'e1', title: 'обед' };
    return handlerBase(path);
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

// Ревью B7 (Minor 1): CONFLICT по своему id = запись на сервере УЖЕ есть (идемпотентный
// дубль) — budget-кэш обязан инвалидироваться и в этой ветке, иначе остаток/бейдж
// висят «до записи» до следующей мутации.
test('CONFLICT (идемпотентный успех) тоже инвалидирует budget-кэш', async () => {
  const { Wrap, qc } = wrapper((path) => {
    if (path === 'entity.create') throw trpcError('CONFLICT');
    return handlerBase(path);
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
  const { Wrap, calls } = wrapper((path) => {
    if (path === 'ai.sendMessage') return assistantReply;
    return handlerBase(path);
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
  const { Wrap, qc } = wrapper((path) => {
    if (path === 'entity.create') throw trpcError('BAD_REQUEST');
    return handlerBase(path);
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
  const { Wrap, qc } = wrapper((path) => {
    if (path === 'entity.create') throw new Error('network down');
    return handlerBase(path);
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

test('CONFLICT по своему id → идемпотентный успех: ни error_card, ни записи в буфере', async () => {
  const { Wrap, qc } = wrapper((path) => {
    if (path === 'entity.create') throw trpcError('CONFLICT');
    return handlerBase(path);
  });
  const { result } = renderHook(() => useFastPath('t1'), { wrapper: Wrap });
  await act(async () => {
    await result.current.submit('обед 340');
  });
  expect(threadMsgs(qc).some(hasErrorCard)).toBe(false);
  expect(useRetryBuffer.getState().size).toBe(0);
});

test('«разобрать с AI» → archived:true + ai.sendMessage исходной строки (одна строка ≠ две сущности)', async () => {
  const { Wrap, calls } = wrapper((path) => {
    if (path === 'entity.update') return { id: 'e1', title: 'обед' };
    if (path === 'ai.sendMessage') return assistantReply;
    return handlerBase(path);
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
  const { Wrap, qc } = wrapper((path) => {
    if (path === 'ai.sendMessage') throw trpcError('LLM_UNAVAILABLE');
    return handlerBase(path);
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
  const { Wrap, qc } = wrapper((path) => {
    if (path === 'ai.sendMessage') {
      aiCalls += 1;
      if (aiCalls === 1) throw trpcError('LLM_UNAVAILABLE'); // первая попытка падает
      return assistantReply; // повтор проходит
    }
    return handlerBase(path);
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
