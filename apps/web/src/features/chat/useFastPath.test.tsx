import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { useRetryBuffer } from '../../state/retry';
import { mockLink, trpcError } from '../../test/harness';
import { trpc } from '../../trpc';
import { type ChatMessage, chatThreadKey } from './useChatThread';
import { useFastPath } from './useFastPath';

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

test('офлайн + уверенный → в retry-буфер, без entity.create', async () => {
  Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
  const { Wrap, calls } = wrapper(handlerBase);
  const { result } = renderHook(() => useFastPath('t1'), { wrapper: Wrap });
  await act(async () => {
    await result.current.submit('обед 340');
  });
  expect(useRetryBuffer.getState().size).toBe(1);
  expect(calls.some((c) => c.path === 'entity.create')).toBe(false);
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

test('§3: ошибка ai.sendMessage → текст не теряется (error_card + retryText в треде)', async () => {
  const { Wrap, qc } = wrapper((path) => {
    if (path === 'ai.sendMessage') throw trpcError('LLM_UNAVAILABLE');
    return handlerBase(path);
  });
  const { result } = renderHook(() => useFastPath('t1'), { wrapper: Wrap });
  await act(async () => {
    await result.current.submit('квакозябра 500');
  });
  await waitFor(() => {
    const data = qc.getQueryData(chatThreadKey('t1')) as { pages: ChatMessage[][] } | undefined;
    const msgs = (data?.pages ?? []).flat();
    const errMsg = msgs.find((m) => {
      const cards = (m.metadata as { cards?: { kind: string }[] })?.cards ?? [];
      return cards.some((c) => c.kind === 'error_card');
    });
    expect(errMsg).toBeTruthy();
    expect((errMsg?.metadata as { retryText?: string }).retryText).toBe('квакозябра 500');
  });
});
