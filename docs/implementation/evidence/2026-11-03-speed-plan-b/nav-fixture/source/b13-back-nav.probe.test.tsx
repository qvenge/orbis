import { appendFileSync } from 'node:fs';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { App } from '../App';
import { loadDetailScreen } from './detail-screen-loader';
import { useNav } from '../state/navigation';
import { queryReply, renderWithProviders, wireEntity } from '../test/harness';
import { recordAddress, topAddress } from '../test/nav';
import { registryReply } from '../test/registry';
import { resetFrame, stubLaunchMode, unstubLaunchMode } from './frame/frame-fixtures';

// «‹» присутствия хоста — на ОДИН уровень стопки раздела (не сброс до корня), в обоих режимах запуска
// (срез 1б §7.3): сайт — через историю браузера (асинхронно, popstate следующим тиком), приложение —
// по модели сразу.
const E1 = '11111111-1111-4111-8111-111111111111';
const E2 = '22222222-2222-4222-8222-222222222222';

const handler = (path: string, input: unknown) => {
  const reg = registryReply(path);
  if (reg !== undefined) return reg;
  if (path === 'entity.get') {
    const id = (input as { id: string }).id;
    trace('get:entered', { id });
    const reply = { entity: wireEntity({ id, title: `Запись ${id}` }), relations: [], thread: null };
    trace('get:response', { id });
    return reply;
  }
  if (path === 'entity.query') return queryReply([]);
  if (path === 'chat.openThread') return { threadId: 't1', messages: [] };
  if (path === 'chat.listMessages') return [];
  return {};
};

beforeEach(() => resetFrame('/'));

afterEach(() => {
  unstubLaunchMode();
  resetFrame('/');
});

const pendingLoads: Promise<unknown>[] = [];
const trace = (event: string, detail: object = {}) => {
  appendFileSync(process.env.B13_NAV_TRACE!, JSON.stringify({
    event, at: performance.now(), ...detail,
  }) + '\n');
};

vi.mock('./detail-screen-loader', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./detail-screen-loader')>();
  return {
    ...actual,
    loadDetailScreen: () => {
      trace('loader:start');
      const result = actual.loadDetailScreen().then(
        (module) => {
          trace('loader:resolved');
          return module;
        },
        (error) => {
          trace('loader:rejected', { error: String(error) });
          throw error;
        },
      );
      pendingLoads.push(result);
      return result;
    },
  };
});

let unsubscribe: (() => void) | undefined;
beforeEach(async () => {
  trace('fixture:prepared', { address: topAddress(), pathname: window.location.pathname });
  unsubscribe = useNav.subscribe(() => trace('address', { address: topAddress() }));
  if (process.env.B13_NAV_WARM === '1') await loadDetailScreen();
  trace('fixture:render-ready');
});
afterEach(async () => {
  unsubscribe?.();
  await Promise.allSettled(pendingLoads);
});

const backButton = () =>
  within(screen.getByTestId('host-presence')).queryByRole('button', { name: 'Назад' });

test.each([
  'site',
  'app',
] as const)('«‹» снимает верх стопки (%s) — на уровень, не до корня', async (mode) => {
  stubLaunchMode(mode);
  renderWithProviders(<App />, handler);
  await screen.findByTestId('host-presence');
  useNav.getState().openRecord(E1);
  useNav.getState().openRecord(E2);
  trace('heading:wait', { id: E2 });
  try {
    await screen.findByRole('heading', { level: 1, name: `Запись ${E2}` });
    trace('heading:visible', { id: E2 });
  } catch (error) {
    trace('heading:timeout', { id: E2 });
    throw error;
  }

  fireEvent.click(backButton() as HTMLElement);
  await waitFor(() => expect(topAddress()).toEqual(recordAddress(E1)));
  fireEvent.click(backButton() as HTMLElement);
  await waitFor(() => expect(topAddress()).toEqual({ kind: 'home', app: { kind: 'host' } }));
  // Корень хоста: идти некуда — «‹» нет.
  await waitFor(() => expect(backButton()).toBeNull());
});
