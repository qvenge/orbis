import { beforeEach, expect, test, vi } from 'vitest';
import { useNav } from './navigation';

const reset = () =>
  useNav.setState({ activeTab: 'chat', stacks: { chat: [], browser: [], agenda: [], budget: [] } });

beforeEach(() => {
  localStorage.clear();
  reset();
});

test('push кладёт экран в стек активного таба, pop снимает верхний', () => {
  useNav.getState().push('browser', { kind: 'entity', id: 'e1' });
  useNav.getState().push('browser', { kind: 'entity', id: 'e2' });
  expect(useNav.getState().stacks.browser).toHaveLength(2);
  useNav.getState().pop('browser');
  expect(useNav.getState().stacks.browser).toEqual([{ kind: 'entity', id: 'e1' }]);
});

test('switchTab меняет активный таб, но не сбрасывает чужие стеки', () => {
  useNav.getState().push('chat', { kind: 'thread', threadId: 't1' });
  useNav.getState().switchTab('browser');
  expect(useNav.getState().activeTab).toBe('browser');
  expect(useNav.getState().stacks.chat).toEqual([{ kind: 'thread', threadId: 't1' }]);
});

test('повторный switchTab по активному табу сворачивает его стек до корня', () => {
  useNav.getState().push('chat', { kind: 'thread', threadId: 't1' });
  useNav.getState().switchTab('chat');
  expect(useNav.getState().stacks.chat).toEqual([]);
});

test('persist пишет активный таб и стеки в localStorage', () => {
  useNav.getState().push('browser', { kind: 'entity', id: 'e9' });
  // biome-ignore lint/style/noNonNullAssertion: persist только что записал ключ — значение гарантированно присутствует
  const raw = JSON.parse(localStorage.getItem('orbis:nav:v1')!);
  expect(raw.state.stacks.browser).toEqual([{ kind: 'entity', id: 'e9' }]);
});

// §1.4: обратное направление persist — состояние ЧИТАЕТСЯ из localStorage при ремоунте.
test('persist восстанавливает активный таб и стеки из localStorage после ремоунта', async () => {
  localStorage.setItem(
    'orbis:nav:v1',
    JSON.stringify({
      version: 0,
      state: {
        activeTab: 'browser',
        stacks: {
          chat: [{ kind: 'thread', threadId: 't7' }],
          browser: [{ kind: 'entity', id: 'e5' }],
          agenda: [],
          budget: [],
        },
      },
    }),
  );
  vi.resetModules();
  const { useNav: rehydrated } = await import('./navigation');
  expect(rehydrated.getState().activeTab).toBe('browser');
  expect(rehydrated.getState().stacks.browser).toEqual([{ kind: 'entity', id: 'e5' }]);
  expect(rehydrated.getState().stacks.chat).toEqual([{ kind: 'thread', threadId: 't7' }]);
});
